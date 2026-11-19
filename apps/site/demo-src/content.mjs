// what the hero demo says: every bot, its chat so far, the question card some of them end on and the scripted answer to
// each choice. the
// capture (capture/capture.mjs) plays all of it into the real app and keeps the rows the app draws, so the demo shows
// the app's own markup; demo.js only decides when each row appears.
//   { u } a person's message, { b } a reply in markdown, { file: { name, mime } } a file the bot shared with the reply
//   before it, { card } a question card, { tool } a step it took (the app keeps those out of the chat)
//   answers: a question card's choices; each is sent as the person's message and answered with `reply`
//   steps: what the working line says while the bot works, before "Typing…"
export const MODELS = {
  sonnet: { instanceId: 'claude', model: 'claude-sonnet-5' },
  opus: { instanceId: 'claude', model: 'claude-opus-5-5' },
  gpt: { instanceId: 'codex', model: 'gpt-6.1-terra' },
  gemini: { instanceId: 'antigravity', model: 'gemini-3.8-flash' },
  grok: { instanceId: 'grok', model: 'grok-4.7' },
};

export const BOTS = [
  {
    key: 'dusk', name: 'Metal', main: true, color: 'chrome', body: 'kit', model: 'sonnet',
    routines: [{ name: 'Morning brief', time: '08:00', weekdays: [1, 2, 3, 4, 5], enabled: true }, { name: 'Friday wrap-up', time: '17:00', weekdays: [5], enabled: false }],
    history: [
      { u: 'Morning. What did everyone do overnight?' },
      { b: "Good morning. Here's what the team did:\n\n| Bot | Did | Needs you |\n| --- | --- | --- |\n| Inbox | Sorted 63 emails, drafted 4 replies | 2 to approve |\n| Researcher | Compared 3 CRMs | No |\n| Bookkeeper | Closed October | 3 subscriptions |\n| Coder | Fixed checkout on Safari | No |" },
      { b: 'Megan moved your 11:30 to 2:00. I updated your calendar and told her that works.' },
      { b: 'Want me to decline the optional 4:30 sync?' },
      { card: { title: 'Decline the 4:30 sync?', subtitle: 'It is optional, and your day would end at 4:00.', options: ['Yes, decline it', 'Keep it'] } },
    ],
    answers: {
      'Yes, decline it': { steps: ['Reading your calendar', 'Working in Google Calendar'], reply: [{ b: 'Declined, with a short note: "Can\'t make this one, I\'ll read the notes." Your day now ends at 4:00.' }] },
      'Keep it': { steps: ['Working on it'], reply: [{ b: "Kept it. I'll send you the agenda at 4:15 so you can decide on the spot." }] },
    },
  },
  {
    key: 'researcher', name: 'Researcher', color: 'purple', body: 'hoot', model: 'gpt',
    routines: [{ name: 'Competitor watch', time: '09:00', weekdays: [1], enabled: true }],
    history: [
      { u: 'Find me a CRM for a team of 5. Under $30 a seat, and it has to work with Gmail.' },
      { b: "Three fit. Here's how they compare:\n\n| Tool | Per seat | Gmail | Reviews |\n| --- | --- | --- | --- |\n| Hatch | $20 | Yes | 4.7 (180) |\n| Plainsight | $24 | Yes | 4.5 (2,310) |\n| Roster | $29 | Yes | 4.6 (240) |\n\nI'd pick **Hatch**. Cheapest, simplest, and reviewers keep saying setup took an afternoon." },
      { file: { name: 'crm-shortlist.csv', mime: 'text/csv' } },
    ],
  },
  {
    key: 'writer', name: 'Content Writer', color: 'pink', body: 'mochi', model: 'opus',
    routines: [{ name: 'Newsletter draft', time: '10:00', weekdays: [4], enabled: true }],
    history: [
      { u: 'Write a LinkedIn post about our new same-day delivery. Short, no hype.' },
      { b: "Here's a draft:\n\n> Starting Monday, orders placed before 2 PM arrive the same day, anywhere in the city. We tested it for six weeks with 300 customers, and 94% of orders landed before 7 PM. It's free over $40." },
      { u: 'Love it. Instagram version too?' },
      { b: 'Order by 2 PM, get it tonight. Same-day delivery is live across the city, free over $40.' },
    ],
  },
  {
    key: 'inbox', name: 'Inbox', color: 'blue', body: 'pip', model: 'gemini', unread: true,
    routines: [{ name: 'Morning sort', time: '07:00', weekdays: [0, 1, 2, 3, 4, 5, 6], enabled: true }, { name: 'Unsubscribe sweep', time: '09:00', weekdays: [1], enabled: false }],
    history: [
      { u: 'What came in overnight?' },
      { b: "63 new emails. 51 were newsletters and receipts, so I filed them. These need you:\n\n| From | About | Status |\n| --- | --- | --- |\n| Megan S. | Moving 11:30 to 2:00 | Accepted |\n| Daniel (landlord) | Lease renewal, due Friday | Draft ready |\n| Sam | Final logo files | Saved to Drive |" },
      { u: 'Send the reply to Daniel' },
      { b: "Sent. I'll tell you when he answers." },
    ],
  },
  {
    key: 'maya', name: 'Maya', color: 'green', body: 'sprout', model: 'sonnet',
    routines: [{ name: 'Sunday meal plan', time: '17:00', weekdays: [0], enabled: true }],
    history: [
      { u: 'Plan dinners for this week. 4 people, Emma is vegetarian, nothing over 40 minutes.' },
      { b: "Here's the week:\n\n| Day | Dinner | Time |\n| --- | --- | --- |\n| Mon | Lemon chickpea pasta | 25 min |\n| Tue | Tacos, bean ones for Emma | 30 min |\n| Wed | Halloumi tray bake | 35 min |\n| Thu | Leftovers night | 0 min |\n| Fri | Homemade pizza | 40 min |\n\nEverything is in your grocery cart: 23 items, about $86. It's not ordered yet." },
      { file: { name: 'meal-plan.pdf', mime: 'application/pdf' } },
    ],
  },
  {
    key: 'books', name: 'Bookkeeper', color: 'orange', body: 'loaf', model: 'gpt',
    routines: [{ name: 'Monthly close', time: '09:00', weekdays: [1], enabled: true }, { name: 'Receipt check', time: '16:00', weekdays: [5], enabled: true }],
    history: [
      { u: 'How did October go?' },
      { b: "Good month. Profit is up 43%, mostly from the new wholesale orders.\n\n| | October | September |\n| --- | --- | --- |\n| Revenue | $18,420 | $15,910 |\n| Costs | $11,230 | $10,870 |\n| Profit | $7,190 | $5,040 |" },
      { file: { name: 'october-close.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } },
      { b: "Three subscriptions you haven't opened in 60 days cost $89 a month together. Cancel them?" },
      { card: { title: 'Cancel them?', subtitle: 'You can turn any of them back on later.', options: ['Yes, cancel all three', 'Not yet'] } },
    ],
    answers: {
      'Yes, cancel all three': { steps: ['Working in Stripe', 'Cancelling subscriptions'], reply: [{ b: "Cancelled all three. That's $89 a month, or $1,068 a year. I saved the confirmation emails in Receipts in case you need them back." }] },
      'Not yet': { steps: ['Working on it'], reply: [{ b: "No problem, they stay. I'll ask again on the 1st if you still haven't opened them." }] },
    },
  },
  {
    key: 'coder', name: 'Coder', color: 'cyan', body: 'boxo', model: 'opus',
    routines: [{ name: 'Nightly tests', time: '02:00', weekdays: [0, 1, 2, 3, 4, 5, 6], enabled: true }],
    history: [
      { u: 'The checkout button does nothing on Safari. Can you fix it?' },
      { b: "Found it. The checkout script reads a date like `2026-11-13 10:00`, which Safari can't parse, so it stopped before the button was switched on.\n\n```js\nconst expires = new Date(cart.expires_at.replace(' ', 'T'))\n```\n\nAll 148 tests pass, plus a new one for this." },
      { u: 'Merge it' },
      { b: 'Merged and live. I clicked through checkout on Safari, Chrome and Firefox, it works on all three.' },
      { b: 'While I was in there: the home page takes 4.1 s to load on a phone, mostly from a 3.8 MB hero photo. I made a 240 KB version that looks the same. Open a pull request for it?' },
      { card: { title: 'Open a pull request for the smaller photo?', subtitle: 'Load time on a phone goes from 4.1 s to 1.6 s.', options: ['Open it', 'Not now'] } },
    ],
    answers: {
      'Open it': { steps: ['Writing some code', 'Running a few commands'], reply: [{ b: 'Opened **Shrink the hero photo**. All 151 tests pass, and the home page now loads in 1.6 s on a phone.' }] },
      'Not now': { steps: ['Working on it'], reply: [{ b: 'Okay. The smaller photo is waiting in a branch called hero-photo whenever you want it.' }] },
    },
  },
  {
    key: 'leo', name: 'Leo', color: 'yellow', body: 'cheep', model: 'grok',
    routines: [{ name: 'Flight price watch', time: '12:00', weekdays: [0, 1, 2, 3, 4, 5, 6], enabled: true }],
    history: [
      { u: 'Flights to Lisbon, Dec 12 to 16. Window seat, no red-eyes.' },
      { b: "Best three:\n\n| Route | Leaves | Arrives | Price |\n| --- | --- | --- | --- |\n| Direct | 9:40 AM | 9:55 PM | $612 |\n| Via Madrid | 7:15 AM | 8:30 PM | $488 |\n| Via London | 8:20 AM | 10:10 PM | $534 |\n\nThe direct one is worth the extra $124 if you hate layovers. I'm checking prices every 6 hours and will tell you if it drops." },
    ],
  },
];
