# every size of the logo the site uses, from the final logo files beside this script (logo-2048.png, and logo-32.png and
# logo-16.png drawn for the favicon; copies of omb-ref/brand/final/dusk-logo-*.png). to change the logo: replace them,
# run `python3 art-src/brand/icons.py`, then the build.
import os
from PIL import Image, ImageDraw
here = os.path.dirname(os.path.abspath(__file__))
site = os.path.join(here, '..', '..', 'public', 'landing')
big = Image.open(os.path.join(here, 'logo-2048.png')).convert('RGBA')
native = {s: Image.open(os.path.join(here, f'logo-{s}.png')).convert('RGBA') for s in (16, 32)}

def sized(size):
    return native[size].copy() if size in native else big.resize((size, size), Image.BOX)

# app icon corners: a rounded square cut with a smooth (4x supersampled) mask
def rounded(im, radius):
    s = im.width
    m = Image.new('L', (s * 4, s * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, s * 4 - 1, s * 4 - 1), radius=radius * s * 4, fill=255)
    out = im.copy(); out.putalpha(m.resize((s, s), Image.LANCZOS))
    return out

# maskable: the scene is shrunk to 80% and its edge rows and columns carried out to the border, so the bands and the
# grass run on and kit sits well inside the safe circle
def maskable(size):
    inner = round(size * 0.8); pad = (size - inner) // 2
    small = big.resize((inner, inner), Image.BOX)
    out = Image.new('RGBA', (size, size))
    out.paste(small, (pad, pad))
    for x in range(pad): out.paste(small.crop((0, 0, 1, inner)), (x, pad)); out.paste(small.crop((inner - 1, 0, inner, inner)), (size - 1 - x, pad))
    for y in range(pad): out.paste(out.crop((0, pad, size, pad + 1)), (0, y)); out.paste(out.crop((0, pad + inner - 1, size, pad + inner)), (0, size - 1 - y))
    return out

art = lambda name: os.path.join(site, 'art', name)
os.makedirs(os.path.join(site, 'brand'), exist_ok=True)
rounded(sized(96), 0.22).save(art('logo-96.webp'), lossless=True, method=6)                       # the header and the footer
ico = [rounded(sized(s), 0.14) for s in (16, 32, 48)]
ico[2].save(os.path.join(site, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico[:2])
sized(180).convert('RGB').save(art('apple-touch-icon.png'), optimize=True)                         # ios rounds it itself
rounded(sized(192), 0.22).save(art('icon-192.png'), optimize=True)
rounded(sized(512), 0.22).save(art('icon-512.png'), optimize=True)
maskable(512).convert('RGB').save(art('icon-maskable-512.png'), optimize=True)
rounded(sized(320), 0.22).save(art('mark-320.webp'), lossless=True, method=6)                      # the brand page's tiles
rounded(sized(1024), 0.22).save(os.path.join(site, 'brand', 'metal-logo.png'), optimize=True)  # the brand page's downloads
sized(1024).convert('RGB').save(os.path.join(site, 'brand', 'metal-logo-square.png'), optimize=True)
print('wrote the logo at every size')
