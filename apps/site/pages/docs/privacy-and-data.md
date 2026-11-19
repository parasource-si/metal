---
title: privacy and your data
nav: privacy
description: where your bots, chats and files live, what leaves your machine, and how to back up or delete everything.
section: help
order: 2
art: s-key
---

the short version: your things live where your bots live. this page is the plain-words map; the [privacy policy](/privacy) is the formal one.

## where things are stored

| your bots live | bots, chats, files and memory are |
| --- | --- |
| on your computer | on your disk, in `.duskbot` in your home folder |
| on dusk cloud | on your own cloud computer, which we host and back up daily |
| on your own server | on that server |

## what leaves your machine

| what | goes to |
| --- | --- |
| what you say to a bot, and its replies | your ai provider, straight from your machine. not through us. |
| what a bot does in a connected app | that app, through our relay and composio. |
| a phone notification | apple or google. it carries the bot's name, never the message. |
| counts and states, if you have an account | your account. never messages, files or keys. |

api keys and sign-ins stay on the machine your bots run on, and the app never shows a key again after you save it. the website uses only the cookies it needs to keep you signed in.

## backups

1. open **settings**, **backups**.
2. choose **export full backup** and set a password of at least 12 characters.
3. keep the file and the password safe. without the password nobody can open it, us included.

to restore, choose **import backup** on the new machine. it replaces everything there rather than merging, and routines arrive paused. sign-ins and keys aren't in the backup, so you connect your ai again.

## deleting things

- **a bot:** delete it from the sidebar.
- **everything on your computer:** remove the app, the `.duskbot` folder in your home folder, and the app's own folder, which holds your sign-ins: `~/Library/Application Support/Dusk Bot` on a mac (and the **Metal Safe Storage** item in Keychain Access), `%APPDATA%\Dusk Bot` on windows, `~/.config/Dusk Bot` on linux.
- **your account:** **delete account** on the account page.

to see, correct or delete what we hold about you, write to privacy@dusk.bot. security problems go to security@dusk.bot (see the [security page](/security)).
