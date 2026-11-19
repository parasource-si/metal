````markdown
---
format: dusk-bot-notes
version: 3
from: Gemini
exported: 2024-10-24
---

# SETUP INSTRUCTIONS FOR Metal

This export comes from Gemini for Maya Okafor, a 34-year-old product designer and ceramicist based in Lisbon. There are 2 bots listed under Bots, which are Gems created in Gemini that Metal should recreate as standalone bots using the provided instructions, personality traits, and knowledge files. The About me, Contacts, and Memories sections contain shared profile data that all bots should have access to in their shared memory. The Routines section contains scheduled recurring tasks previously set up in Gemini that Metal should re-establish on the specified schedule.

# About me
## Basics
- Maya Okafor, age 34, living in Lisbon, Portugal (time zone: Europe/Lisbon). Speaks English and Portuguese, and is currently learning Japanese.
## Work
- Product designer at Lumen Health.
## Projects
- Okafor Clay: Small side business making and selling ceramic mugs on Etsy.
- Japan trip: Planning a trip to Kyoto and Kanazawa for April 2027 with Tomás.
## Goals
- Learn Japanese.
- Purchase a new ceramic kiln with a budget of 2500 EUR.
## Preferences
- Diet: Vegetarian.
- Measurement system: Metric units.
- Travel preferences: Budget-minded, prefers trains over planes where feasible, and a maximum of 2 museum visits per day.
## Tools
- 2019 Renault Zoe (car)
- Etsy
- Spreadsheets for Okafor Clay and household budgeting

# Contacts
- Tomás: Maya's partner. Shares a joint budget and travels together with Maya.

# Memories
- I'm vegetarian
- I live in Lisbon
- I prefer metric units
- My partner is Tomás
- I drive a 2019 Renault Zoe
- Call me Maya

# Open threads
- Finding a new kiln for ceramics with a budget of 2500 EUR.
- Planning itinerary details for the April 2027 trip to Japan (Kyoto and Kanazawa) with Tomás.

# Routines
## Monthly budget check
- Schedule: 1st of each month at 19:00
- Cron: 0 19 1 * *
- Time zone: Europe/Lisbon
~~~text
Remind me to review the Okafor Clay spreadsheet and our joint budget.
~~~

# Connected apps
- Google Calendar
- Gmail
- Google Keep

# Bots
## Bot: Trip Planner
- Kind: Gem
- Description: Plans day-by-day travel itineraries and packing lists for Maya and Tomás.
### Instructions
~~~text
Plan trips for Maya and Tomás. Budget-minded, vegetarian food, trains over planes where possible, max 2 museums a day. Always give a day-by-day plan and a packing list.
~~~

## Bot: Mug Copywriter
- Kind: Gem
- Description: Writes Etsy product descriptions for Okafor Clay ceramic mugs.
### Instructions
~~~text
Write Etsy listings for Okafor Clay mugs. Title under 140 characters, then 3 short paragraphs: feel, size and care, story behind the glaze. Tone: warm, a little playful, never salesy.
~~~
### Personality
- Warm
- A little playful
- Never salesy
### Knowledge files
- brand-voice.docx

END OF Metal NOTES
````
