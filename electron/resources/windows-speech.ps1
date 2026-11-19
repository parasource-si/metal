# Built-in Windows speech-to-text for Metal, the Windows twin of speech-helper.swift.
# Windows PowerShell 5.1 and System.Speech ship with Windows: nothing to install.
# Streams NDJSON lines (UTF-8, LF) to stdout:
#   {"partial":true,"text":"..."}                       while recognizing (whole session so far)
#   {"partial":true,"text":"...","utteranceFinal":true}  a phrase was recognized (whole session so far)
#   {"partial":false,"text":"..."}                      final result, then exit 0
#   {"error":"..."}                                     then exit 1
#   {"level":0.42}                                      input loudness 0..1, about 20 times a second
# Error codes: recognizer-unavailable, mic-failed, recognition-error.
# No speechStart is sent: every text is already the whole session, and a timing
# jump would make electron/speech-transcript.mjs prepend the last phrase twice.
#
# -EndpointMs N   finish once N ms pass with no transcript change, after something was said
# -Locale en-US   prefer an installed recognizer for that language, else the default one
# -StopFile p     exit 0 at once when p exists (mute, hang-up, replacement)
# -FinishFile p   when p exists, stop listening, emit the final line and exit 0
# Launched by electron/speech.mjs. This file must stay ASCII: PowerShell 5.1 reads
# a BOM-less script in the ANSI code page.
param(
  [int]$EndpointMs = 0,
  [string]$Locale = "",
  [string]$StopFile = "",
  [string]$FinishFile = ""
)

$ErrorActionPreference = "Stop"
# a writer of its own: UTF-8 whatever the console code page, and no console handle needed
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Write-Line([string]$line) {
  try {
    $script:stdout.Write($line + "`n")
    $script:stdout.Flush()
  } catch {
    # the app closed the pipe: nobody is listening, so let the microphone go
    exit 0
  }
}

function Quote([string]$text) {
  [System.Web.HttpUtility]::JavaScriptStringEncode($text, $true)
}

function Send-Text([bool]$partial, [string]$text, [bool]$utteranceFinal) {
  $flag = if ($partial) { "true" } else { "false" }
  $tail = if ($utteranceFinal) { ',"utteranceFinal":true' } else { "" }
  Write-Line ('{"partial":' + $flag + ',"text":' + (Quote $text) + $tail + '}')
}

function Fail([string]$code) {
  Write-Line ('{"error":"' + $code + '"}')
  exit 1
}

function Requested([string]$file) {
  $file -ne "" -and [System.IO.File]::Exists($file)
}

if ($EndpointMs -gt 0) { $EndpointMs = [Math]::Min(5000, [Math]::Max(250, $EndpointMs)) }
if (Requested $StopFile) { exit 0 }

try {
  Add-Type -AssemblyName System.Web
  Add-Type -AssemblyName System.Speech
} catch {
  Fail "recognizer-unavailable"
}

function Pick-Recognizer([string]$wanted) {
  $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($installed.Count -eq 0) { return $null }
  if ($wanted -ne "") {
    $name = $wanted.Replace("_", "-")
    $exact = $installed | Where-Object { $_.Culture.Name -ieq $name } | Select-Object -First 1
    if ($exact) { return $exact }
    $language = $name.Split("-")[0]
    $near = $installed | Where-Object { $_.Culture.TwoLetterISOLanguageName -ieq $language } | Select-Object -First 1
    if ($near) { return $near }
  }
  # the recognizer chosen in Windows speech settings, else the first installed one
  try {
    $probe = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    $info = $probe.RecognizerInfo
    $probe.Dispose()
    return $info
  } catch {
    return $installed[0]
  }
}

try {
  $info = Pick-Recognizer $Locale
  if ($null -eq $info) { Fail "recognizer-unavailable" }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
} catch {
  Fail "recognizer-unavailable"
}

try {
  $engine.SetInputToDefaultAudioDevice()
} catch {
  Fail "mic-failed"
}

Register-ObjectEvent -InputObject $engine -EventName SpeechHypothesized -SourceIdentifier dusk.hypothesis | Out-Null
Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier dusk.recognized | Out-Null
Register-ObjectEvent -InputObject $engine -EventName SpeechRecognitionRejected -SourceIdentifier dusk.rejected | Out-Null
Register-ObjectEvent -InputObject $engine -EventName AudioLevelUpdated -SourceIdentifier dusk.level | Out-Null
Register-ObjectEvent -InputObject $engine -EventName RecognizeCompleted -SourceIdentifier dusk.completed | Out-Null

try {
  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
} catch {
  Fail "mic-failed"
}

$committed = ""   # recognized phrases, joined
$pending = ""     # the current phrase's latest hypothesis
$lastText = ""
$sinceChange = [System.Diagnostics.Stopwatch]::StartNew()
$sinceLevel = [System.Diagnostics.Stopwatch]::StartNew()
$finishing = $false
$finishClock = $null
$done = $false

function Join-Text([string]$left, [string]$right) {
  if ($left -ne "" -and $right -ne "") { return "$left $right" }
  if ($left -ne "") { return $left }
  return $right
}

function Saw([string]$text) {
  if ($text -ne "" -and $text -ne $script:lastText) {
    $script:lastText = $text
    $script:sinceChange.Restart()
  }
}

function Begin-Finish {
  if ($script:finishing) { return }
  $script:finishing = $true
  $script:finishClock = [System.Diagnostics.Stopwatch]::StartNew()
  # stops capture but still recognizes the audio already heard, then raises RecognizeCompleted
  try { $script:engine.RecognizeAsyncStop() } catch { $script:done = $true }
}

while (-not $done) {
  if (Requested $StopFile) { exit 0 }
  if (Requested $FinishFile) { Begin-Finish }
  $loudest = -1
  foreach ($queued in @(Get-Event)) {
    $id = $queued.SourceIdentifier
    $e = $queued.SourceEventArgs
    Remove-Event -EventIdentifier $queued.EventIdentifier
    switch ($id) {
      "dusk.hypothesis" {
        $pending = $e.Result.Text.Trim()
        $text = Join-Text $committed $pending
        Saw $text
        Send-Text $true $text $false
      }
      "dusk.recognized" {
        $phrase = $e.Result.Text.Trim()
        $pending = ""
        if ($phrase -ne "") {
          $committed = Join-Text $committed $phrase
          Saw $committed
          Send-Text $true $committed $true
        }
      }
      "dusk.rejected" {
        $pending = ""
      }
      "dusk.level" {
        if ($e.AudioLevel -gt $loudest) { $loudest = $e.AudioLevel }
      }
      "dusk.completed" {
        if ($null -ne $e.Error) { Fail "recognition-error" }
        $done = $true
      }
    }
  }
  if ($loudest -ge 0 -and -not $finishing -and $sinceLevel.ElapsedMilliseconds -ge 45) {
    $sinceLevel.Restart()
    # SAPI reports 0..100; the square root lets a soft voice still move the waveform
    $level = [Math]::Min(1.0, [Math]::Sqrt([Math]::Max(0, $loudest) / 100.0))
    Write-Line ('{"level":' + $level.ToString("0.###", $invariant) + '}')
  }
  # never end an empty turn: a call may stay quiet as long as the person needs
  if ($EndpointMs -gt 0 -and $lastText -ne "" -and $sinceChange.ElapsedMilliseconds -ge $EndpointMs) { Begin-Finish }
  # a recognizer that never confirms the stop must not hold the microphone
  if ($finishing -and $finishClock.ElapsedMilliseconds -ge 2000) { $done = $true }
  if (-not $done) { Start-Sleep -Milliseconds 20 }
}

try { $engine.RecognizeAsyncCancel() } catch {}
Send-Text $false (Join-Text $committed $pending) $false
exit 0
