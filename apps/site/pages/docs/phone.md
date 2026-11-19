---
title: the phone app
description: text your bots, answer their questions and get told when they're done, from anywhere.
section: start
order: 3
art: s-mobile
---

your bots keep running where they live. your phone is a window onto them: send messages, watch replies arrive, stop a bot, and tap **allow** on an approval without walking back to your desk.

## get the app

on an iphone, build Metal from source using the [mobile build instructions](https://github.com/parasource-si/metal/tree/main/apps/mobile). the [Dusk Bot App Store listing](https://apps.apple.com/app/id6834725640) belongs to the upstream project.

## dusk cloud: just sign in

open the app and sign in with the same email you use for [dusk cloud](/docs/dusk-cloud). your cloud links on its own, no code needed.

## your own computer: scan a code

1. on your computer, open the menu under your name and choose **connect your phone**.
2. choose **to this computer**, or **to the cloud** if you have [dusk cloud](/docs/dusk-cloud).
3. scan the code with your iphone's camera. it opens in the Metal app; confirm the computer's name.

{{include ui-pair}}

can't scan? the same screen offers a code to type into the app, a nearby list on your wi-fi, or tailscale.

> note: the code only opens in the app. scanned without it, nothing happens. on android, until google play has the app, open your cloud's address in chrome, pair it with a code from **settings**, **phone**, **pair another computer**, then choose **install app**. the browser version doesn't send notifications.

## your computer has to be awake

paired with your computer, the phone only works while that computer is on and running Metal. **settings**, **remote access**, **keep this computer awake** helps. pair with [dusk cloud](/docs/dusk-cloud) and it works with your computer off.

## notifications

the app tells you when a reply, a question or an approval arrives. a notification shows the bot's name and "new message", never the text.

## paired devices

**settings**, **remote access** lists every paired device. remove one and it loses access at once.
