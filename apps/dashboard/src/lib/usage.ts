import { SITE_URL, siteUrl } from "./site";

export const APP_LINK = "duskbot://";
export const DOWNLOAD_URL = SITE_URL ? siteUrl("/download") : "https://github.com/parasource-si/metal/releases";
/** the upstream Dusk Bot iPhone listing */
export const IOS_APP_URL = "https://apps.apple.com/app/id6834725640";
/** the phone path that works today: the iphone app signs in with this account and links a dusk cloud by itself */
export const PHONE_APP = "on your iphone, open Metal and sign in with this email. your dusk cloud links on its own. bots on your own computer: open settings, phone in Metal there and scan the code with the iphone's camera. see the Metal repository for mobile build instructions.";
export const API_DOCS = "https://github.com/parasource-si/metal/blob/main/docs/bot-api.md";
