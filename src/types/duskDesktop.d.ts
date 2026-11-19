// The narrow bridge the Electron preload exposes. Absent in the browser.

declare global {
  type CompanyBackupEntry = Omit<import("../../electron/company-backups.mjs").CompanyBackupMetadata, "status"> & { status: "creating" | "uploading" | "completing" | "ready" | "cleanup" };
  interface CompanyBackupScheduleState {
    enabled: boolean;
    status: "off" | "waiting" | "running" | "paused" | "error";
    nextBackupAt?: number;
    lastAttemptAt?: number;
    lastBackupAt?: number;
    message?: string;
  }
  interface CompanyBackupState {
    busy: boolean;
    pendingRestore?: boolean;
    kind?: "backup" | "restore";
    progress?: import("../../electron/company-backups.mjs").CompanyBackupProgress;
    message?: string;
    lastBackupAt?: number;
    schedule?: CompanyBackupScheduleState;
  }
/** The package.json version, inlined by Vite's define at build time. */
const __APP_VERSION__: string;

  type VoiceInputProvider = import("../../electron/voice-catalog.mjs").VoiceProvider;
  interface VoiceInputSessionOptions {
    provider: VoiceInputProvider;
    /** A BCP 47 tag; unset lets the service detect the language. */
    language?: string;
    model?: string;
    /** ElevenLabs: stream words while talking. */
    realtime?: boolean;
    /** OpenAI-compatible: the service's address, such as https://example.com/v1. */
    baseUrl?: string;
    whisperCpp?: { binary: string; model: string };
  }
  interface VoiceInputBridge {
    keys: {
      /** Which services have a key saved on this computer. Never the keys. */
      status(): Promise<Partial<Record<VoiceInputProvider, boolean>>>;
      set(provider: VoiceInputProvider, key: string): Promise<void>;
      clear(provider: VoiceInputProvider): Promise<void>;
    };
    /** Rejects with a plain message when the service is not set up. */
    start(options: VoiceInputSessionOptions): Promise<{ id: string }>;
    /** 16 kHz mono 16-bit little-endian PCM. */
    audio(id: string, pcm: ArrayBuffer): void;
    /** Stop listening and deliver the last words, then end. */
    finish(id: string): Promise<void>;
    /** Drop the session without words. */
    stop(id: string): Promise<void>;
    /** `text` is everything heard in the session so far. */
    onTranscript(cb: (event: { id: string; text: string; partial: boolean }) => void): () => void;
    onEnd(cb: (event: { id: string; code: number; reason?: string; message?: string }) => void): () => void;
    /** whisper.cpp programs and models found in the usual places. */
    findWhisperCpp(): Promise<{ binaries: string[]; models: string[] }>;
  }

  /** the direct ssh path of a relay-linked server: whether it is allowed, and the path a request takes now */
  interface LinkDirectState { on: boolean; path: "direct" | "cloudflare" | "relay"; via?: string }
  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      /** The user's home folder, for showing paths as ~/… */
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "win-caption" | "native";
    /** This page is another computer's server, shown in this app. */
    remote?: boolean;
    /** The page draws the window's frame: false once the person turned it off. Absent on an older app, whose window
     * draws it. */
    windowFrame?: boolean;
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "windows-speech" | "fish-audio" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
    localComputer: {
      available: boolean;
      support: "supported" | "limited" | "unsupported";
      enabled: boolean;
      status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
      reasonCode?: string;
      message?: string;
      driverPath?: string;
      driverVersion?: string;
      driverSource?: "bundled" | "environment" | "user-local" | "path";
      session?: "x11" | "wayland" | "headless" | "unknown";
      compositor?: "gnome-mutter";
    };
  };

  interface DesktopWorkspaceBounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface BrowserSurfaceState {
    botId: string;
    open: boolean;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward?: boolean;
    visible: boolean;
    partition?: string | null;
    profile?: string | null;
    mode?: "compact" | "expanded" | null;
    code?: "renderer-gone" | "profile-deleted" | "evicted";
  }

  interface DesktopWorkspaceState {
    contextId: string;
    open: boolean;
    status: "opening" | "ready" | "error" | "closed";
    interactive: boolean;
    code?: "load-failed" | "renderer-gone";
  }

  /** Whether the desktop is holding this computer awake for routines. */
  interface DesktopRoutineWake {
    /** the toggle */
    keepAwake: boolean;
    /** a power assertion is held right now */
    hold: boolean;
    /** "due" | "running" while held; "off" | "battery" | "idle" | "stopped" otherwise */
    reason: string;
    /** the due routine's time, when the hold is for a due routine */
    at: number | null;
    onBattery: boolean;
  }
  interface CloudMacBridge {
    state(): Promise<import("../../shared/cloud-mac").CloudMacState>;
    /** Turning on asks on the Mac first; declined, it stays off. */
    setEnabled(on: boolean): Promise<import("../../shared/cloud-mac").CloudMacState>;
    /** The Mac's own folder picker. */
    addFolder(): Promise<import("../../shared/cloud-mac").CloudMacState>;
    removeFolder(path: string): Promise<import("../../shared/cloud-mac").CloudMacState>;
    /** auto: only risky actions wait for Allow; ask: every action but an ordinary read does; never: nothing asks. */
    setMode(mode: import("../../shared/cloud-mac").CloudMacMode): Promise<import("../../shared/cloud-mac").CloudMacState>;
    /** On: reading, saving and downloads stay inside the listed folders. */
    setLimitFolders(on: boolean): Promise<import("../../shared/cloud-mac").CloudMacState>;
    openLog(): Promise<void>;
    onChange(listener: (state: import("../../shared/cloud-mac").CloudMacState) => void): () => void;
  }
  interface DesktopRemoteClientState {
    active: boolean;
    endpoint?: string;
    serverName?: string;
    deviceId?: string;
  }

  interface Window {
    duskDesktop?: {
      platform: NodeJS.Platform;
      /** process.arch of the desktop app, for usage signals */
      arch?: string;
      /** This app's own version, and whether this page is this app's own: false on a server added in the Server menu,
       * whose page carries that server's version. Absent in desktop builds before it. */
      app?: { version: string; ownPage: boolean };
      organization?: import("../../electron/managed-desktop.mjs").ManagedDesktopBridge;
      accountGate?: import("../components/account-gate/bridge").AccountGateBridge;
      cloudAccount?: import("../../electron/cloud-account.mjs").CloudAccountBridge;
      accounts?: import("../../electron/cloud-account.mjs").AccountsBridge;
      accountSheet?: import("../../electron/cloud-account.mjs").AccountSheetBridge;
      /** Either page in this app: the one-time move's line (on its way, what arrived, coming home). */
      cloudSendPage?: import("../../electron/cloud-send.mjs").CloudSendPageBridge;
      /** This computer's page only: bots in two places, and the one tap that brings them together on one (electron/two-places.mjs). */
      twoPlaces?: {
        state(): Promise<{ suggest: import("../lib/two-places").TwoPlacesSuggestion | null }>;
        accept(key: string): Promise<{ suggest: import("../lib/two-places").TwoPlacesSuggestion | null }>;
        dismiss(key: string): Promise<{ suggest: import("../lib/two-places").TwoPlacesSuggestion | null }>;
        onChanged(callback: () => void): () => void;
      };
      /** Every page this window shows: whether a server's identity key (`x.y`) is the one this app pinned for the server
       * the page belongs to, pinned at linking or on first use. `pinned: false` when there is nothing to pin against (this
       * computer's own server, or a server this app did not link). Main decides the server from the page, never from it. */
      sealTrust?: { check(identity: string): Promise<{ ok: boolean; pinned: boolean }> };
      /** A linked server's page only: the direct ssh path for that link (null where it does not apply). */
      linkDirect?: { state(): Promise<LinkDirectState | null>; set(on: boolean): Promise<LinkDirectState | null> };
      /** This computer's page and the person's own dusk cloud page: whether that cloud's bots may use this Mac, its
       * folders, the work running now and the kill switch. Absent in a browser, on the phone and on an older app. */
      cloudMac?: CloudMacBridge;
      /** A VPS's own page: its bots straight to dusk cloud. Absent on an older app. */
      vpsCloudMove?: import("../lib/vps-cloud-move").VpsCloudMoveBridge;
      /** This computer's page only: Add your VPS, its install, sign-in, move, and the Transfer pane (electron/vps-link.mjs). */
      vpsLink?: import("../lib/vps-link").VpsLinkBridge;
      /** The bot panel's Start fresh: deletes everything this person has with Metal (electron/start-fresh.mjs). Absent on an older app. */
      startFresh?: {
        available(): Promise<boolean>;
        preview(): Promise<import("../../electron/start-fresh.mjs").StartFreshView>;
        run(typed: string): Promise<import("../../electron/start-fresh.mjs").StartFreshView>;
        retry(): Promise<import("../../electron/start-fresh.mjs").StartFreshView>;
        finish(): Promise<import("../../electron/start-fresh.mjs").StartFreshView>;
        onChanged(cb: (view: import("../../electron/start-fresh.mjs").StartFreshView) => void): () => void;
      };
      /** Settings on the person's own Cloud: the plan, read only. */
      cloudPlan?: import("../../electron/cloud-account.mjs").CloudPlanBridge;
      /** This computer's page, and My Cloud's own page once it is the person's home: the window onto My Cloud. */
      home?: import("../../electron/home-window.mjs").HomeBridge;
      /** This computer's page while the chosen server isn't answering: its last-seen chats and the next look. */
      reconnect?: import("../../electron/workspace-reconnect.mjs").ReconnectBridge;
      /** This computer's page only: a downloaded update of this app waiting for a restart. */
      appUpdate?: import("../../electron/app-update.mjs").AppUpdateBridge;
      desktopNotices?: import("../../electron/desktop-prefs.mjs").DesktopNoticesBridge;
      desktopNotifications?: import("../../electron/desktop-notifications.mjs").DesktopNotificationsBridge;
      /** This computer's own page only: the account's full name, for a first run's profile (system-name.mjs), and its login. */
      desktopProfile?: { systemName(): Promise<string | null>; loginName?(): Promise<string | null> };
      desktopAnalytics?: import("../../electron/desktop-prefs.mjs").DesktopAnalyticsBridge;
      productEvents?: import("../../electron/product-events.mjs").ProductEventsBridge;
      errorReports?: import("../../electron/account-errors.mjs").ErrorReportsBridge;
      desktopLanguage?: import("../../electron/desktop-prefs.mjs").DesktopLanguageBridge;
      companyBackups?: {
        state(): Promise<CompanyBackupState>;
        list(): Promise<{ backups: CompanyBackupEntry[]; usedBytes: number; limits: { ownerQuotaBytes: number; retainedSnapshots: number } }>;
        create(input: { clientState: import("../../shared/workspace-backup").WorkspaceBackupClientState }): Promise<CompanyBackupEntry>;
        configureSchedule?(input: { enabled: false } | { enabled: true; confirmation: "BACK UP THIS WORKSPACE DAILY" }): Promise<CompanyBackupState>;
        prepareRestore(input: { id: string; password?: string }): Promise<{ id: string; summary: import("../../shared/workspace-backup").WorkspaceBackupSummary }>;
        restore(input: { id: string; confirmation: "REPLACE" }): Promise<{ restoreId: string }>;
        delete(input: { id: string; confirmation: "DELETE" }): Promise<unknown>;
        cancel(): Promise<void>;
        onState(callback: (state: CompanyBackupState) => void): () => void;
      };
      /** The window's own rail of places: its page at /rail (a sheet of its own covers the window while open; the skin of
       * the page beside it comes from main), and the button on the page beside it that hides and shows it. */
      rail?: import("../../electron/chrome-rail.mjs").ChromeRailBridge;
      workspaces?: {
        /** `color`: a saved server's colour name (its owner chose it while setting the Cloud up); `home`: this window's
         * home is this Cloud, so there is nothing to switch to; `localPath`: a local workspace's folder, absent for This
         * computer's own. */
        state: () => Promise<{ local: boolean; name: string; origin?: string; color?: string; home?: boolean; role?: string; localPath?: string }>;
        /** The native server menu; resolves when it closes. `from: "howto"`: the Show me how tip opened it. */
        menu: (options?: { from?: "howto" }) => Promise<void>;
        /** One plain line for the next page, served once: a team this person is no longer in. */
        line?: () => Promise<{ kind: "left"; name: string } | null>;
        /** The rail's circles, for this app's page and a hosted Cloud's only (empty elsewhere, and with fewer than two
         * places). Absent on an older app. */
        places?: () => Promise<import("../../electron/cloud-rail.mjs").RailState>;
        /** Opens a circle main listed, by its id, through main's own switch: only from the person's click. */
        /** Nothing for a place of the account in use; for another account's, how its switch went. */
        open?: (id: string) => Promise<import("../../electron/cloud-account.mjs").RailOpenResult | undefined>;
        /** ＋'s fixed choices: buy a Cloud (this computer's own sheet), a server's pairing link (`link`: the one pasted on the
         * sheet; without it, the clipboard's), or type its address. Resolves false when the person cancels Connect. */
        add?: (choice: "cloud" | "link" | "address", link?: string) => Promise<unknown>;
        /** The colour of the place this page is (This computer's too), and whether it can be changed here. Absent on an
         * older app. */
        look?: () => Promise<import("../../electron/place-look.mjs").PlaceLook | null>;
        /** That place's colour, from the person's click: one of the six swatches, or null for none. */
        color?: (swatch: import("../../electron/cloud-list.mjs").CloudSwatch | null) => Promise<{ outcome: import("../../electron/place-look.mjs").PlaceColorOutcome; look: import("../../electron/place-look.mjs").PlaceLook | null }>;
        /** The colour of a place the window's rail lists, by its circle's id, from the person's click on the rail's own
         * page (refused on any other page). */
        recolor?: (id: string, swatch: import("../../electron/cloud-list.mjs").CloudSwatch | null) => Promise<{ outcome: import("../../electron/place-look.mjs").PlaceColorOutcome; look: import("../../electron/place-look.mjs").PlaceLook | null }>;
        /** Remove from list: a Cloud the window's rail lists as `removable`, by its circle's id, once the person said yes on
         * the rail's own page (refused on any other page). Absent on an older app. */
        remove?: (id: string) => Promise<{ outcome: import("../../electron/cloud-account.mjs").CloudRemoveOutcome }>;
        /** Make a server of the person's own, which the rail lists with `makeHome`, their bots' home: the move starts. */
        makeHome?: (id: string) => Promise<{ started: true }>;
        /** Opens a server the rail lists with `cloudMove`, with its move to dusk cloud sheet. */
        cloudMove?: (id: string) => Promise<boolean>;
        /** Main's word that the places or the sign-in changed: read them again. */
        onChanged?: (callback: () => void) => () => void;
        /** Main's word that a switch to another place began (true) or ended without a new page (false). */
        onSwitching?: (callback: (on: boolean) => void) => () => void;
        /** The loading mascot this page shows, handed on to the page the switch opens. */
        handLook?: (look: import("../lib/mascot-loading").HandedLook) => void;
        /** The mascot the page before handed on, once, while it is fresh. */
        takeLook?: () => import("../lib/mascot-loading").HandedLook | null;
        /** Whether a switch of place opened this page just now; absent on an older app. */
        arrived?: () => boolean;
      };
      /** Buying another Cloud from the rail's ＋, on this app's page or a hosted Cloud's; absent on an older app. */
      cloudAdd?: {
        state(): Promise<import("../../electron/cloud-rail.mjs").AddCloudView>;
        /** Opens that plan's checkout in the browser, for a Cloud of this name and swatch; only from the person's click. */
        /** `source`: where the checkout started, one of the app's checkout sources (main ignores any other). */
        start(tier: string, name: string, color: import("../../electron/cloud-list.mjs").CloudSwatch | null, source?: string): Promise<{ outcome: "opened" | "unsupported" | "failed" } | { outcome: "blocked"; blocked: import("../../electron/cloud-account.mjs").CloudAddBlock }>;
        reopen(): Promise<boolean>;
        copyLink(): Promise<boolean>;
        /** Opens the Cloud just bought, once it is ready. */
        open(): Promise<void>;
        interest(): Promise<void>;
        /** The sheet is open on this page (main then says "ready" here, not with a notification). */
        sheet(open: boolean): Promise<void>;
        /** A new organization on the Team plan this account pays for, of this name and swatch: no checkout; only from the person's click. */
        organization?(name: string, color: import("../../electron/cloud-list.mjs").CloudSwatch | null): Promise<{ outcome: "added" | "taken" | "unsupported" | "failed" }
          | { outcome: "blocked"; blocked: import("../../electron/cloud-list.mjs").OrganizationBlock }>;
      };
      /** Saved servers and the active one (desktop Server menu). Present on
       * the local server's UI; a remote server's page sees a reduced bridge. */
      environments?: {
        state: () => Promise<{
          localOrigin: string;
          remote: boolean;
          /** Named local environments exist only in a packaged build. */
          packaged: boolean;
          activeId: string;
          environments: Array<{
            id: string;
            kind?: "local" | "remote";
            name: string;
            origin?: string;
            dataDir?: string;
            missing?: boolean;
            /** One of the six Cloud colours (environments.cjs ENTRY_COLORS). */
            color?: string;
            /** The person's own My Cloud. */
            home?: boolean;
            /** Another Cloud of the person's own, as the verified session lists it. */
            cloud?: { id: string; role: string };
          }>;
        }>;
        /** Local targets answer {ok, error?} (error strings are an open set); remote ones answer nothing. */
        switch: (id: string) => Promise<{ ok: boolean; error?: string } | void>;
        addFromLink: (link: string, name?: string) => Promise<boolean | void>;
        /** Register a named local environment; an omitted dataDir lands beside the app's own. */
        create: (name: string, dataDir?: string) => Promise<{ ok: boolean; error?: string; state: unknown }>;
        /** Native folder chooser for the create form; { ok: false } on cancel. */
        pickDir: () => Promise<{ ok: boolean; path?: string }>;
        /** {ok:false} when main refused (active local, failed folder delete); a
         * cancelled remote confirm and remote success answer nothing. */
        forget: (id: string, purge?: boolean) => Promise<{ ok: boolean; error?: string } | void>;
        onOpenSettings?: (callback: (computerId?: string | null) => void) => () => void;
      };
      confirm(message: string): Promise<boolean>;
      /** Touch ID, Windows Hello or polkit, else an in-app confirm; true only when the person passed. Absent in older
       * desktop builds. `reason` completes "Metal wants to …". */
      requireUserPresence?(reason: string): Promise<boolean>;
      getCapabilities(): Promise<DesktopCapabilities>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      remoteClient?: {
        active: boolean;
        state(): Promise<DesktopRemoteClientState>;
        pair(endpoint: string, code: string): Promise<DesktopRemoteClientState>;
        disconnect(): Promise<DesktopRemoteClientState>;
      };
      /** Keep this computer awake for scheduled routines; absent on remote
       * server pages and in older desktop builds. */
      routines?: {
        wakeState(): Promise<DesktopRoutineWake>;
        keepAwake(enabled: boolean): Promise<DesktopRoutineWake>;
      };
      companionAccount?: {
        state(): Promise<CompanionAccountState>;
        requestCode(email: string): Promise<CompanionAccountState>;
        verifyCode(email: string, code: string): Promise<CompanionAccountState>;
        retry(): Promise<CompanionAccountState>;
        /** Create or repair this computer's HTTPS address because a person
         * is pairing now. Absent in older desktop builds. */
        prepare?(): Promise<CompanionAccountState>;
        signOut(): Promise<CompanionAccountState>;
      };
      /** This computer's relay to its phones (electron/phone-relay.mjs); absent on remote pages and older builds.
       * `ready` starts it when remote access is on and waits a few seconds for it. */
      phoneRelay?: {
        state(): Promise<PhoneRelayState>;
        ready(): Promise<PhoneRelayState>;
      };
      /** Local-shell-only bridge for trusted approval-mode transitions. It is
       * absent on remote server pages and in older desktop builds. */
      approvals?: {
        setMode(
          botId: string,
          mode: import("../../shared/approval-mode").ApprovalMode,
          options?: { acknowledgeLocalAuto?: boolean; threadId?: string; threadOnly?: boolean; allThreads?: boolean;
            refreshPermissions?: boolean;
            modelSelection?: import("../state/store").ModelSelection; updateBotDefault?: boolean },
        ): Promise<import("../state/store").Bot>;
      };
      localControl: {
        status(): Promise<LinuxLocalControlStatus>;
        enable(): Promise<LinuxLocalControlStatus>;
        disable(): Promise<LinuxLocalControlStatus>;
        retry(): Promise<LinuxLocalControlStatus>;
      };
      /** Arms one user-initiated display capture request from this frame. */
      beginScreenPreviewIntent(): boolean;
      /** Absent before the desktop app that ships it; rejects when the running main process predates it. */
      screenLive?: { begin(): Promise<boolean> };
      screenFrame(): Promise<string | null>;
      /** Start native dictation. Call mode supplies endpointMs so silence
       * finalizes a turn; composer dictation omits it and remains manual. */
      speechStart(options?: { endpointMs?: number; locale?: string }): Promise<void>;
      speechStop(): Promise<void>;
      /** Finish capture and emit the recognizer's final transcript. */
      speechFinish?(): Promise<void>;
      /** The notch island and the bot dock: their choices, and this page's summary of its bots for them. */
      ambient?: import("../ambient/types").AmbientAppBridge;
      /** The working bots for ⌘Q, and the menu's Stop commands (electron/desktop-bots.mjs). */
      desktopBots?: import("../ambient/types").DesktopBotsBridge;
      /** This computer's page only: where the person's bots live while it has none. */
      elsewhere?: import("../lib/bots-elsewhere").ElsewhereBridge;
      /** This computer's page only: Settings → General's talk shortcut. */
      talkShortcut?: import("../../electron/talk-shortcut.mjs").TalkShortcutBridge;
      /** A call holds the microphone, so the talk shortcut waits. */
      callActive?(active: boolean): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string; message?: string }) => void): () => void;
      /** Input loudness from 0 to 1 while the native helper listens. Absent in older builds of the shell. */
      onSpeechLevel?(cb: (level: number) => void): () => void;
      /** Voice input through a speech-to-text service the person set up in Settings > Voice (electron/voice-input-main.mjs).
       * Keys stay in this computer's credential store; the page sends audio and hears words. Absent in older builds. */
      voiceInput?: VoiceInputBridge;
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent, macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. `pageMic`: whether
       * this app lets the asking page use the microphone (this computer's
       * page always; a server's page only on the person's own Cloud).
       * Absent in older builds of the shell. */
      permStatus(): Promise<{ mic: string; pageMic?: "allowed" | "refused" }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech|accessibility. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** macOS permissions a bot needs to use this Mac, asked for from the first run. Absent in older builds and off
       * this computer's own page. */
      macPermissions?: import("../lib/mac-permissions").MacPermissionsBridge;
      /** Relaunch the local desktop app through its normal shutdown cleanup. */
      relaunch?(): Promise<boolean>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      /** Writes plain text to the system clipboard; false on failure. Absent on older builds. */
      copyText?(text: string): Promise<boolean>;
      /** Opens an http(s) link in the user's default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** A provider's browser sign-in that returns to localhost on a remote workspace: this computer listens on that
       * port, hands back the callback, then answers the browser. Absent on older builds. */
      authRelay?: {
        open(port: number, path: string): Promise<boolean>;
        next(port: number): Promise<string | null>;
        done(port: number, result: { ok: boolean; location?: string | null }): Promise<unknown>;
        close(port: number): Promise<unknown>;
      };
      /** Brings this window back to the front, after a sign-in finished in the browser. */
      focusWindow?(): Promise<boolean>;
      /** Recolor the native window chrome for a skin; absent on older builds. */
      applySkin?(skin: string): Promise<boolean>;
      /** The window's own frame, this desktop's choice (Settings → Appearance). Absent on an older app. */
      windowFrame?: {
        state(): Promise<import("../../electron/desktop-prefs.mjs").WindowFrameState>;
        /** From the person's click on another server's page. */
        set(on: boolean): Promise<import("../../electron/desktop-prefs.mjs").WindowFrameState>;
      };
      /** The renderer-drawn Windows caption buttons; absent outside the
       * frameless Windows shell (macOS/Linux/browser keep native chrome). */
      windowControls?: {
        minimize(): Promise<boolean>;
        toggleMaximize(): Promise<boolean>;
        close(): Promise<boolean>;
        state(): Promise<{ maximized: boolean }>;
        onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
        /** Widens the window by up to `deltaWidth` CSS px within its screen; resolves to the px it grew by. */
        resizeWidthBy?(deltaWidth: number): Promise<number>;
      };
      /** Receives a GitHub package URL opened through duskbot://install. */
      onPackageInstall?(cb: (url: string) => void): () => void;
      /** Receives a chat link (duskbot://thread/… or duskbot://bot/…)
       * opened from outside the app. */
      onChatLink?(cb: (link: string) => void): () => void;
      onSlackOAuth?(cb: (link: string) => void): () => void;
      /** The desktop shell's app-menu Preferences… item was activated; open
       * app Settings. Every server's page in the window receives it, and the
       * bridge is absent in the browser. "cloud" is the
       * duskbot://cloud link (Settings → dusk cloud, opened by the link). */
      onOpenAppSettings?(cb: (section?: "organization" | "cloud" | "cloud-settings" | "cloud-add" | "cloud-add-howto") => void): () => void;
      /** Updates the native Dock/taskbar unread indicator. */
      setUnreadCount?(count: number): void;
      /** Opens a live desktop as a sandboxed window owned by dusk bot. */
      desktopViewer?: {
        open(url: string, title: string, contextId: string): Promise<boolean>;
        /** Closes the live-desktop window, but only when it belongs to this bot. */
        close(contextId: string): Promise<boolean>;
        /** The current viewer state, for a panel to initialize from on mount. */
        currentState(): Promise<{ open: boolean; contextId: string | null }>;
        onState(cb: (state: { open: boolean; contextId: string | null }) => void): () => void;
      };
      /** Two Local VM viewers embedded in one app window. URLs are accepted
       * only by main-process validation and never return over this bridge. */
      desktopWorkspace?: {
        open(input: {
          contextId: string;
          url: string;
          title: string;
          bounds: DesktopWorkspaceBounds;
        }): Promise<DesktopWorkspaceState>;
        layout(items: Array<{
          contextId: string;
          bounds: DesktopWorkspaceBounds;
          visible: boolean;
        }>): Promise<boolean>;
        setInteractive(contextId: string | null): Promise<boolean>;
        close(contextId?: string): Promise<boolean>;
        onState(cb: (state: DesktopWorkspaceState) => void): () => void;
      };
      /** Native folder picker; resolves null when the user cancels. */
      pickFolder?(current?: string): Promise<string | null>;
      /** Writes the redacted diagnostics report to a user-chosen file;
       * resolves the path, or null when cancelled. */
      exportDiagnostics?(): Promise<string | null>;
      /** The debug trail (electron/trail.mjs): events go to main's trail file, redacted again there; the export saves a
       * scrubbed usage log where the person picks and offers to email it to support. */
      trail?: {
        write(events: Array<{ ev: string; ts?: string } & Record<string, unknown>>): void;
        exportUsageLog(): Promise<{ saved: boolean; sent: boolean }>;
      };
      /** Asks where to save a bot-created file (inside ~/.duskbot), copies
       * it there and reveals it. Resolves the chosen path, or null if the
       * user cancelled the dialog. */
      saveFile?(filePath: string): Promise<string | null>;
      /** Desktop only: opens HTML this page already showed in the default browser, from a temp copy main writes. */
      openHtmlInBrowser?(source: string, name: string): Promise<unknown>;
      /** Points this computer's file manager at a file a bot linked outside
       * its workspace, without opening or reading it. Local app only. */
      revealInFolder?(filePath: string): Promise<"shown" | "missing" | "invalid">;
      /** Opens this app's logs folder in Explorer or Finder and says where it is. */
      openLogsFolder?(): Promise<{ folder: string; opened: boolean; error?: string }>;
      /** This app's own login item, which opens the window. `available`: false in a build that cannot add one. */
      openAtLogin?: { state(): Promise<{ available: boolean; on: boolean }>; set(on: boolean): Promise<{ available: boolean; on: boolean }> };
      /** An AppImage's entry in this computer's app menu. `available`: false anywhere else (and with the .deb installed). */
      appMenuEntry?: { state(): Promise<{ available: boolean; on: boolean }>; set(on: boolean): Promise<{ available: boolean; on: boolean }> };
      /** Save a provider credential through Electron's OS-backed store. */
      setCredential?(
        name: "composioApiKey" | "xaiApiKey" | "opencodeGoApiKey" | "ttsKey" | "fishAudioKey" | "geminiTtsKey" | "deepgramKey" | "cartesiaKey" | "assemblyAiKey" | "jevApiKey" | "openrouterDeciderKey" | "gatewayDeciderKey" | "workersAiToken" | "openaiImageApiKey" | "customImageApiKey" | "openaiLiveKey" | "tregApiKey",
        value: string,
      ): Promise<ConfigStatus>;
    };
  }
}

export interface LinuxLocalControlStatus {
  enabled: boolean;
  status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
  reasonCode?: string;
  message?: string;
  driverPath?: string;
  driverVersion?: string;
  driverSource?: "bundled" | "environment" | "user-local" | "path";
  session?: "x11" | "wayland" | "headless" | "unknown";
  compositor?: "gnome-mutter";
  warnings?: Array<{ label: string; status: string; message: string; detail?: string }>;
}

/** `off`: remote access is off (it can start); `signed-out`: no dusk account to make the relay with; `error`: the link
 * service refused, `message` says why. */
export interface PhoneRelayState {
  status: "off" | "signed-out" | "starting" | "ready" | "error";
  code?: string;
  message?: string;
}

export interface CompanionAccountState {
  available: boolean;
  status: "signed-out" | "connecting" | "ready" | "error";
  email?: string;
  endpoint?: string;
  message?: string;
  /** set only when `available` is false: `offline` when the service could not be reached, `unsupported` when it was reached but offers no secure access */
  reason?: "offline" | "unsupported";
}

