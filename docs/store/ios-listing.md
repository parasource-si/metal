# App Store listing draft: Metal for iPhone

**Superseded by `docs/store-launch.md`** for the listing copy, privacy label, age rating and review notes; this first
draft names other platforms and Dusk Cloud, which the iOS listing must not.

Draft text for App Store Connect. Nothing here names a price, a plan or a place to buy one (guideline 3.1.1). Limits are
Apple's; the count beside each field is the draft's length.

## Identity

| Field | Value |
|---|---|
| App name (30) | Metal (8) |
| Subtitle (30) | Text your team of AI bots (25) |
| Bundle ID | `bot.dusk.mobile` |
| SKU | `dusk-mobile-ios` |
| Primary category | Productivity |
| Secondary category | Developer Tools |
| Version | 1.0 (build 1; raise the build for every upload) |
| Copyright | 2026 [legal entity name] |
| Support URL | https://dusk.bot/docs |
| Marketing URL | https://dusk.bot |
| Privacy Policy URL | https://dusk.bot/privacy |
| Devices | iPhone only (runs on iPad as an iPhone app) |
| Minimum iOS | 17.0 |

## Promotional text (170)

Your AI bots keep working on your computer while you are out. Text them from your phone, answer when they ask, and get a
ping when the work is done. (148)

## Description (4000)

Metal runs a team of AI bots on your own computer. This is the phone app: pair it with your computer once, and text
your bots from anywhere.

WHAT YOU CAN DO

- Text any bot like a teammate, and read its reply the moment it lands
- Talk to several bots at once in a room
- Say yes or no when a bot asks before it does something
- Get a notification when a bot finishes or needs you
- Keep writing with no signal: messages wait on your phone and send once when you are back
- See your routines and what your bots are working on
- Start a new bot from your phone

HOW IT WORKS

Your bots, their chats and their files live in your workspace: the Metal app on your Mac, Windows PC or Linux
machine, or on a server of your own. Open Settings there, show the phone code, and scan it with this app. From then on
the phone talks to your workspace directly, or through an encrypted link when you are away. Nothing is stored on the
phone but the pairing.

You can pair more than one workspace and switch between them, and remove a phone from the computer at any time.

PRIVATE BY DESIGN

- No ads, no tracking, no analytics SDKs
- Your chats stay in your own workspace
- The pairing is kept in the iPhone Keychain

Metal for your computer is at dusk.bot.

## Keywords (100)

ai,bots,agents,assistant,chat,automation,productivity,team,remote,tasks,routines,companion (90)

## What's New (4000)

The first release of Metal for iPhone.

## Age rating answers

Answer in App Store Connect; the questionnaire's wording changes, so read each question against these facts.

| Topic | Answer | Why |
|---|---|---|
| Violence, sexual content, profanity, drugs, gambling, horror, medical | None | The app has no content of its own |
| Advertising | No | None |
| User-generated content shared between users | No | A person's chats are with their own bots, in their own workspace |
| Messaging or chat | Yes, with AI | The app is a chat with AI bots the person runs themselves |
| AI-generated content | Yes | Replies come from the AI model the person connected on their computer; the app does not filter them |
| Unrestricted web access | Yes | A link in a bot's reply opens in the in-app Safari view, and it can lead anywhere |
| Parental controls, age assurance | No | None |
| Contests, in-app purchases | No | None |

Expect a 13+ or 17+ result from the AI and web access answers. If a lower rating matters, open links in Safari itself
instead of the in-app view (owner decision; `openExternal` in `apps/mobile/src/native-platform.ts`).

## App Privacy ("nutrition label") answers

Tracking: **No**, the app does not track.

Data collected by us (the developer), all **linked to the person**, all for **App Functionality** only, none used for
tracking, advertising or analytics:

| Data type | Collected | What it is |
|---|---|---|
| Contact Info: Email Address | Yes, if the person signs in | The account email (sign-in on the first screen) |
| Identifiers: User ID | Yes, if the person signs in | The account's id |
| Identifiers: Device ID | Yes, if notifications are allowed | The APNs device token, kept so a notification can be sent |
| User Content: Other User Content | Yes, only with a Dusk Cloud computer | Messages and files, when the workspace the phone is paired with is a computer we host |
| Diagnostics: Crash Data | No (today) | Off unless a build sets `DUSK_ERROR_DSN`; if you turn it on, add Crash Data, not linked |

Not collected: location, contacts, photos (a photo the person attaches goes to their own workspace), audio, browsing or
search history, purchases, financial or health data, advertising data.

Why the rest is not "collected": a phone paired with the person's own computer or server sends chats to that machine,
which the person runs. Through the link relay (`link.dusk.bot`) the chats are sealed on the phone and opened on the
person's server, so the relay holds ciphertext it cannot read and keeps nothing. The same answers are in the app's
privacy manifest (`apps/mobile/ios/App/App/PrivacyInfo.xcprivacy`); keep the two in step.

If the phone app ships without the sign-in screen (see docs/mobile-readiness.md, "Owner decisions"), drop Email Address
and User ID from both.

## Export compliance

`ITSAppUsesNonExemptEncryption` is `false` in Info.plist, so App Store Connect does not ask on each upload. Reasoning:
the app uses HTTPS through the system, and seals relay traffic with AES-GCM and X25519 through WebKit's WebCrypto, which
is the operating system's own cryptography. It ships no encryption code of its own. That is the "only uses encryption
that is exempt" case (encryption limited to that within the Apple operating system). The owner confirms this
self-classification; it is a legal statement made in the owner's name.

## App Review notes (paste into "Notes")

Metal for iPhone is the companion to Metal for Mac, Windows and Linux (https://dusk.bot), where a person runs
their own team of AI bots. The iPhone app pairs with that workspace and lets them text their bots.

The app has no built-in demo: a reviewer needs a live workspace to pair with, or a review account (see below).

1. Launch the app. On the first screen choose "enter a code" and type the review code, or "log in" with the review
   account and pick its dusk cloud.
2. The home screen shows the review workspace's team. Tap a bot (for example "Quill") to open its chat and send a message.
3. Tap the back button, then open "Launch room" to see a group chat with three bots.
4. Tap the "+" button (top right) to create a bot, and the magnifier to search.
5. Tap the profile button (top left) for Settings: appearance, language, haptics, the privacy policy and terms.
6. Long-press any chat row for its menu (pin, mark unread, share to the computer).

With a real workspace the same screens show the person's own bots; pairing is by scanning a QR code that the desktop app
shows (camera permission), or by typing the 12 character code shown beside it. [If you set up a review workspace, add:
"To pair with a live workspace, choose 'Enter the code instead' and type: XXXX-XXXX-XXXX" and keep that workspace
running for the whole review.]

Notes on specific guidelines:

- Sign-in: [if the sign-in screen ships] the account is the same one the desktop app uses. A review account:
  [email], sign in with the code [how the reviewer gets the code, or a fixed review code]. The account can be deleted in
  Settings, Account, Delete account.
- Purchases: the app sells nothing and links to no purchase page.
- Camera: only to scan the pairing code and to take a photo the person attaches to a message.
- Microphone: only while the person dictates a message to a bot.
- Local network: the app connects to the person's own computer on their Wi-Fi when they pair on the same network.
- Notifications: sent by the person's own workspace when a bot replies or asks something while the app is closed.
- AI: replies come from the AI model the person connected on their own computer, with their own account there. The
  phone sends messages only to the person's own workspace.

Contact: [name], [email], [phone].
