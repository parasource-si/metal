---
title: your own server
nav: your own server (advanced)
description: for people who already rent a server. paste one line and your bots live there, on around the clock.
section: start
order: 4
art: s-server
---

if you would rather not use [dusk cloud](/docs/dusk-cloud) and you're comfortable with a server, your bots can live on one you rent. it's free; you pay only for the server, and the updates, backups and bill are yours.

## what you need

- **ubuntu 22.04 or 24.04**, with **2 gb of memory or more**. more memory means more bot computers awake at once.
- root, or a user who can use `sudo`.
- a fresh server is best. don't give bots a server that holds things you wouldn't hand them.

no ports to open, no domain, nothing to install first.

## set it up

1. in the app, open the menu at the top of the sidebar, choose **add a cloud or your own server**, then your own server.
2. the app shows one line. it works once and for a limited time.
3. paste it on the server. the app shows each step; it takes about ten minutes.
4. sign in to your ai from the app (never on the server), and let the app move your bots over.

{{include ui-server}}

stopped half way? paste the same line again; it picks up where it left off. line expired? ask the app for a new one.

## another computer

on the server, run `metal pair --label desktop`. in the app on the other computer, choose **add a cloud or your own server**, then **already running Metal?**, and paste everything it printed. a server set up before this command existed gets it with its next update; until then use `sudo -u dusk /home/dusk/.local/bin/duskbot pair --label desktop`.

if it prints only a code and no link, the server has no address of its own (it's linked through the private relay). then make a line in the other computer's app and paste it on the server instead: the server moves its link to that computer, and the first one stops reaching it.

## read it before you run it

```sh
curl -fsSLo install.sh https://dusk.bot/install.sh
curl -fsSL https://dusk.bot/install.sh.sha256
shasum -a 256 install.sh
less install.sh
```

the two fingerprints should match. your app and server talk through a relay at `link.dusk.bot`, sealed with a key only they hold, and directly where they can.

## removing it

move your bots back or export a [backup](/docs/privacy-and-data#backups) first, then:

```sh
curl -fsSL https://link.dusk.bot/uninstall | sh
```
