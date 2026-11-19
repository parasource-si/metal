---
title: routines
description: ask once and a bot does it on a schedule, or the moment something happens.
section: using
order: 3
art: s-clock
---

a routine is a job a bot does without being asked again. you make one by saying it.

{{include ui-routine}}

## make one by asking

- "summarise my inbox every weekday at 8."
- "check competitor prices every monday at 9 and tell me what changed."
- "remind me to send invoices on the last friday of the month."

the bot sets it up in its reply, with a card showing the schedule and the next few runs, plus **Edit**, **pause** and **Undo**. **automations** in the sidebar lists every routine with a calendar and the history of each run.

## when something happens

a routine can start from an event instead of a clock:

- "whenever i get an email from acme, draft a reply."
- "when a github issue opens, triage it."

this needs the app to be [connected](/docs/files-and-apps#connected-apps). gmail is checked every 15 minutes; slack, github and most others arrive at once.

## good routines

- **small and specific beats big and vague.** "flag invoices over €500" works better than "handle my finances".
- **say where the result goes.** "post it in the website group chat", "email it to me", "just tell me here".
- **say when to stay quiet.** "only tell me if something changed."
- **watch the first few runs** and correct it in the chat.

for whole jobs set up this way, with the message to send and the guard rails, see [use cases](/use-cases).

## your computer has to be on

routines run inside Metal. on your own computer, nothing runs while it's asleep or the app is closed. a run missed by less than 12 hours runs once when you're back; older ones are skipped.

for routines that must run on time, put your bots on [dusk cloud](/docs/dusk-cloud).

## when a run needs you

a routine asks before the scary stuff like any other chat. you get a notification naming the routine, and it waits for your answer.
