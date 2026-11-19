export type ToolFailureKind = "rate-limited" | "auth-expired" | "permission-denied" | "timeout" | "not-found";

export const NEXT_STEP_LEAD = "Next step: ";

const FAILURES: ReadonlyArray<{ kind: ToolFailureKind; test: RegExp; next: string }> = [
  {
    kind: "rate-limited",
    test: /\b429\b|rate[ -]?limit|too many requests|quota (?:exceeded|exhausted)|resource[_ ]exhausted/i,
    next: "the service is limiting requests. Wait about 30 seconds and retry once, or take another source; never a third try.",
  },
  {
    kind: "auth-expired",
    test: /\b401\b|unauthori[sz]ed|unauthenticated|invalid[_ ]grant|(?:token|session|credentials?|sign-?in|login) (?:has |have |is )?(?:expired|revoked|invalid)|expired (?:token|session|credentials?)|not (?:signed|logged) in|re-?authenticate|(?:sign-?in|login|authentication) required/i,
    next: "the sign-in behind this has expired or is missing, so retrying will not help. Tell the person in one line which app needs reconnecting, and finish the parts that do not need it.",
  },
  {
    kind: "permission-denied",
    test: /\b403\b|forbidden|permission denied|access denied|not permitted|\bEACCES\b|\bEPERM\b|insufficient (?:permissions?|scopes?)|not authori[sz]ed to/i,
    next: "access was refused, so the same call will fail again. Take a route you can reach (another source, a read-only view, your own copy), or tell the person in one line which access is missing.",
  },
  {
    kind: "timeout",
    test: /timed? ?out|\btimeout\b|\bETIMEDOUT\b|deadline exceeded|\b504\b|gateway time-?out/i,
    next: "it took too long. Retry once with a smaller ask (fewer items, a narrower query, one page), or take another route; never a third try.",
  },
  {
    kind: "not-found",
    test: /\b404\b|not found|no such (?:file|directory|item|record|user|channel)|does not exist|doesn't exist|\bENOENT\b|unknown (?:id|file|item|record)/i,
    next: "nothing is at that name, id or address. Search or list to find the right one, then call again with it; do not repeat the same call.",
  },
];

/** Error text past this is a dump, not a reason; only its start is read. */
const READ_CHARS = 2_000;

export function toolFailureKind(text: string): ToolFailureKind | null {
  const head = text.slice(0, READ_CHARS);
  return FAILURES.find((failure) => failure.test.test(head))?.kind ?? null;
}

/** The hint a failed tool's text ends with; empty when the failure is not a common one or already says what to do. */
export function nextStepHint(text: string): string {
  if (text.includes(NEXT_STEP_LEAD) || text.includes("Metal note:") || text.includes("dusk bot note:")) return "";
  const kind = toolFailureKind(text);
  const failure = kind ? FAILURES.find((entry) => entry.kind === kind) : undefined;
  return failure ? `${NEXT_STEP_LEAD}${failure.next}` : "";
}

export function withNextStep(text: string): string {
  const hint = nextStepHint(text);
  return hint ? `${text}\n\n${hint}` : text;
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** An MCP tool result marked isError gains one text block with the hint; anything else comes back as it was. */
export function withNextStepResult<T>(result: T): T {
  if (!isObject(result) || result.isError !== true || !Array.isArray(result.content)) return result;
  const text = result.content.filter((item): item is { type: "text"; text: string } => isObject(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n");
  const hint = nextStepHint(text);
  return hint ? { ...result, content: [...result.content, { type: "text", text: hint }] } as T : result;
}

/** A JSON-RPC response frame whose result is a failed tool call gains the hint. */
export function withNextStepFrame<T>(frame: T): T {
  if (!isObject(frame) || !("result" in frame)) return frame;
  const result = withNextStepResult(frame.result);
  return result === frame.result ? frame : { ...frame, result } as T;
}

const ERROR_FLAG = /"isError"\s*:\s*true/u;

/** One MCP stdio frame; only a line that says isError is parsed. */
export function withNextStepLine(line: string): string {
  if (!ERROR_FLAG.test(line)) return line;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  const hinted = withNextStepFrame(frame);
  return hinted === frame ? line : JSON.stringify(hinted);
}
