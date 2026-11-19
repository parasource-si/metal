---
name: windows-release
description: Build and verify the Windows desktop NSIS installer and portable archive.
---

# Windows release

Run on Windows with Node 24+ and pnpm. The macOS build is a separate flow.
Use the same package version and release tag for every platform.

```powershell
pnpm install
pnpm typecheck
pnpm package:win
Test-Path release\win-unpacked\resources\server\index.js
Test-Path release\win-unpacked\resources\ui\index.html
```

The output contains `Metal-<version>-setup.exe` and
`Metal-<version>-x64.zip`. Confirm the installed app launches, renders the
chat window, and lists a provider in the model picker. Logs live in
`%APPDATA%\Metal\logs\server.log`.

Upload the installers to the version's release together with the other
platforms. Keep a stable `Metal-setup.exe` copy for download links.

The Windows build is unsigned. SmartScreen shows "unknown publisher" and users
choose **More info → Run anyway**. Signing configuration belongs under
`win.signtoolOptions` or `win.azureSignOptions` in `build/electron-builder.yml`.
