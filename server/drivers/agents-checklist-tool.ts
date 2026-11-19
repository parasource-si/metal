// The agents catalog's checklist tool: the bot's progress list for one job over many items. The internal route
// (server/routes/checklist.ts) keeps it in the conversation's task workspace; the harness reads it to carry the rest on.
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";

export const CHECKLIST_TOOL = "checklist";

export async function callChecklistTool(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
  const { ok, body } = await context.client.apiResponse("/api/internal/checklist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return ok ? { text: String(body.text ?? "") } : { text: String(body.error ?? "The checklist could not be updated. Try again shortly."), isError: true };
}

export const CHECKLIST_TOOL_DEFINITION = {
  name: CHECKLIST_TOOL,
  description:
    "Progress list for doing the same thing for 5+ items (DM a list of people, post to many groups). start with every item before the first; done right after each item, one call each; skip with a note if one cannot be done. Ticked items are final: never redo one. If your turn ends with items open, Metal carries on with the rest by itself, so never stop to ask whether to continue. done pauses a few seconds to pace sends. Site says too fast or try later: pause, then end your turn.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["start", "done", "skip", "status", "pause"] },
      title: { type: "string", maxLength: 120 },
      verb: { type: "string", maxLength: 24, description: "start: past tense for a finished item (\"sent\")." },
      items: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 300 }, description: "Names or handles, exactly as listed; never the message." },
      item: { type: "string", maxLength: 300 },
      note: { type: "string", maxLength: 160 },
      minutes: { type: "integer", minimum: 1, maximum: 60, description: "pause: minutes the site asked (15 if unsaid)." },
    },
    required: ["action"],
  },
};
