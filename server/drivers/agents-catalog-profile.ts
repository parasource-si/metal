// The DUSK_* switches the harness gives the agents proxy, read into the profile agents-catalog.ts lists tools for.

/** Which tools a conversation is shown, the same on every one of its turns. Presentation only: the server still
 * authenticates and scopes every call. */
export interface CatalogProfile {
  skillAuthoring: boolean;
  voiceNotes: boolean;
  /** A treg key or a Cloud plan's research credential is held and this bot's research switch is on: x_search is mounted.
   * Absent means off. */
  xResearch?: boolean;
  /** As xResearch, and research works for that credential (the person's treg key, or a plan whose relay has research
   * on): research_search, research_endpoint and research_call are mounted too. Absent means off. */
  research?: boolean;
  /** This bot holds its own Slack app with a bot token: the slack_* tools are mounted. Absent means off. */
  slack?: boolean;
  cloudHome: boolean;
  memoryEnabled?: boolean;
  /** The section's Chief of Staff; the server refuses Chief-only tools to every other bot. */
  chief: boolean;
  /** Only for Watcher's own tool. Never written into a schema: a list that names its bot can't share a prompt cache with other bots. */
  botId: string;
  /** A Team Cloud: message_person is mounted. */
  team?: boolean;
  /** The person's Dusk with a Chief's powers: its notification tools are mounted. */
  dusk?: boolean;
  /** A direct chat whose bot may pick where it works (Works on is not Off and no team computer is its own): select_computer
   * is mounted, and the harness refuses a pick on any turn but a person's own message. */
  computerSelection?: boolean;
  /** The bot works on this Mac while macOS keeps Metal off its screen: request_screen_access is mounted. */
  screenAccess?: boolean;
  /** A room's thread: the widget and page tools, which rooms refuse, and the wait tools, since a room holds no wait,
   * are not mounted. */
  room?: boolean;
  /** The engine searches the web on its own at no cost to the person (Claude Code, Codex): the paid web_search_many is
   * not mounted. Absent means off. */
  nativeWeb?: boolean;
  /** The engine has no fetch of its own: read_pages is mounted. Absent means off. */
  pageReader?: boolean;
}

/** Everything is off unless the harness says "1". */
export function catalogProfileFromEnv(env: NodeJS.ProcessEnv): CatalogProfile {
  return {
    skillAuthoring: env.DUSK_SKILL_AUTHORING_ENABLED === "1",
    voiceNotes: env.DUSK_VOICE_NOTES === "1",
    xResearch: env.DUSK_X_RESEARCH === "1",
    research: env.DUSK_RESEARCH === "1",
    slack: env.DUSK_SLACK === "1",
    cloudHome: env.DUSK_CLOUD_HOME === "1",
    memoryEnabled: env.DUSK_MEMORY_ENABLED !== "0",
    chief: env.DUSK_CHIEF_OF_STAFF === "1",
    botId: env.DUSK_BOT_ID ?? "",
    team: env.DUSK_TEAM_PEOPLE === "1",
    dusk: env.DUSK_DEFAULT_BOT === "1",
    computerSelection: env.DUSK_COMPUTER_SELECTION === "1",
    screenAccess: env.DUSK_SCREEN_ACCESS === "1",
    room: env.DUSK_ROOM === "1",
    nativeWeb: env.DUSK_NATIVE_WEB === "1",
    pageReader: env.DUSK_PAGE_READER === "1",
  };
}
