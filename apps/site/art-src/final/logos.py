# the logos shown on the home page, written to public/landing/art/logos
# connectors: the files the app itself ships (src/assets/app-logos in the Metal checkout); every mark belongs to its owner
# models: @lobehub/icons-static-svg (MIT) from jsdelivr
import os, shutil, subprocess, sys
from PIL import Image
OUT = '../../public/landing/art/logos/'
APP = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/Desktop/code/OpenMausBot') + '/src/assets/app-logos/'
os.makedirs(OUT, exist_ok=True)
CONNECTORS = {'gmail': 'gmail.png', 'calendar': 'google-calendar.png', 'drive': 'google-drive.png', 'docs': 'google-docs.png', 'sheets': 'googlesheets.svg', 'slack': 'slack.png', 'notion': 'notion.png', 'github': 'github.svg', 'linear': 'linear.png', 'figma': 'figma.png', 'stripe': 'stripe.png', 'discord': 'discord.svg', 'hubspot': 'hubspot.png', 'airtable': 'airtable.svg', 'asana': 'asana.svg', 'trello': 'trello.svg', 'dropbox': 'dropbox.svg', 'outlook': 'outlook.png', 'shopify': 'shopify-merchant.png', 'sentry': 'sentry.png', 'vercel': 'vercel.png', 'supabase': 'supabase.png', 'posthog': 'posthog.png', 'zapier': 'zapier.svg'}
for name, file in CONNECTORS.items():
    if file.endswith('.svg'): shutil.copy(APP + file, OUT + name + '.svg')
    else:
        im = Image.open(APP + file).convert('RGBA'); im.thumbnail((72, 72), Image.LANCZOS); im.save(OUT + name + '.png', optimize=True)
MODELS = {'claude': 'claude-color', 'chatgpt': 'openai', 'gemini': 'gemini-color', 'grok': 'grok', 'deepseek': 'deepseek-color', 'cursor': 'cursor', 'copilot': 'githubcopilot', 'kimi': 'kimi-color', 'qwen': 'qwen-color', 'opencode': 'opencode', 'cline': 'cline'}
for name, icon in MODELS.items():
    subprocess.run(['curl', '-fsS', '-m', '20', '-o', OUT + name + '.svg', f'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/{icon}.svg'], check=True)
# the app's own sentry and zapier files are white-on-clear; simple-icons (CC0) in each brand's colour reads on a white chip
for name, colour in {'sentry': '#362d59', 'zapier': '#ff4f00'}.items():
    for ext in ('png', 'svg'):
        if os.path.exists(OUT + name + '.' + ext): os.remove(OUT + name + '.' + ext)
    svg = subprocess.run(['curl', '-fsS', '-m', '20', f'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/{name}.svg'], check=True, capture_output=True, text=True).stdout
    open(OUT + name + '.svg', 'w').write(svg.replace('<svg ', f'<svg fill="{colour}" ', 1))
print(len(os.listdir(OUT)), 'logos')
