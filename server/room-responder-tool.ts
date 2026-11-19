import type { GroupDefaultResponder } from "../shared/wire.ts";

/** manage_room set_responder's word for who answers the person's messages in a room. */
export const ROOM_RESPONDER_WORDS = ["everyone", "mentions", "auto"] as const;

export function roomResponderFromTool(value: string | undefined, memberIds: readonly string[], autoReady: boolean):
  { responder: GroupDefaultResponder } | { error: string } {
  const word = value?.trim();
  if (!word) return { error: "set_responder requires responder: everyone, mentions, auto, or one member's bot id from list_rooms" };
  if (word === "everyone") return { responder: { kind: "everyone" } };
  if (word === "mentions") return { responder: { kind: "mentions" } };
  if (word === "auto") {
    return autoReady ? { responder: { kind: "auto" } }
      : { error: "auto needs room routing, which is not set up in this app; pick everyone, mentions or one member, or ask the person to set up room routing in Settings" };
  }
  if (memberIds.includes(word)) return { responder: { kind: "member", botId: word } };
  return { error: "responder must be everyone, mentions, auto, or the bot id of one of this room's members" };
}

export function roomResponderLine(responder: GroupDefaultResponder, name: (botId: string) => string): string {
  switch (responder.kind) {
    case "everyone": return "every member answers the person's messages";
    case "mentions": return "only the members a message @mentions answer";
    case "auto": return "Metal picks who answers each message";
    case "member": return `${name(responder.botId)} answers the person's messages`;
  }
}
