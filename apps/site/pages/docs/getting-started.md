---
title: getting started
description: from nothing to a bot doing real work in about two minutes.
section: start
order: 1
art: s-map
---

Metal is an app where you keep a small team of ai bots and text them like teammates. you need the app and an ai you already use. no account, no card.

## get the app

download it from [the download page](/download) and open it.

| system | what to do |
| --- | --- |
| **mac** (macos 12 or later) | open the `.dmg` and drag Metal into applications. |
| **windows** (10 or 11, 64-bit) | run the installer. it needs no admin rights. if windows says it "protected your pc", choose **More info**, then **Run anyway**. |
| **linux** (ubuntu 24.04, beta) | install the `.deb`, or run the appimage. |

the app tells you when there is a new version. your bots, chats and settings stay put when you update.

## sign in to your ai

Metal has no model of its own. your bots think with an ai you already pay for: claude, chatgpt, gemini, grok and others. the first screen lists them. pick one and sign in the usual way.

{{include ui-signin}}

- **no subscription?** add an api key under **settings**, **API keys** (anthropic, xai, openrouter, groq and anything that speaks the openai api).
- **want it all local?** start ollama or lm studio and choose **use a local model** in a bot's model picker.

what you say to a bot goes straight from your machine to that ai, on your plan. it does not pass through us.

## make a bot

choose **new bot**. give it a name, a shape, a colour, and one job in plain words.

{{include ui-newbot}}

you can change all of it later, and the bot keeps its chats and memory.

## hand it something real

text it the thing you have been putting off:

- "summarise what came in overnight and tell me what needs me."
- "find three flights to lisbon in march under €150."
- "read this pdf and give me the five points that matter."

it shows what it is doing while it works, and asks before the scary stuff: sending, buying, deleting.

## next

- read [tips for using bots](/docs/tips). ten minutes there saves hours later.
- want bots that keep working with your laptop shut? that is [dusk cloud](/docs/dusk-cloud).
- text them from anywhere with [the phone app](/docs/phone).
