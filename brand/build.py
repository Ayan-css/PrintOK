"""
Builds the PrintOk brand kit from one definition of the mark.

    python3 brand/build.py        (needs rsvg-convert and ImageMagick for PNG/ICO)

Everything under brand/ except this file and README.md is generated; edit the
constants here, not the outputs. The wordmark is outlined from Space Grotesk
Bold into brand/wordmark.json, so no SVG here needs the font to render.
"""
import json
import os
import shutil
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, '..', 'apps', 'customer-web', 'public')

# ------------------------------------------------------------------ colours --
COLOURS = {
    'petrol':      ('#0e5e6f', 'Primary. The mark, buttons, links.'),
    'petrol-deep': ('#073a45', 'Pressed states, dark surfaces.'),
    'ochre':       ('#d99a1e', 'Accent. Motion lines, highlights. Never body text on white.'),
    'mist':        ('#9cc7cf', 'The folded corner; quiet fills.'),
    'paper':       ('#f5f2ec', 'Page background.'),
    'sheet':       ('#fbfaf7', 'The P, cards, anything that is "the page".'),
    'ink':         ('#10262b', 'Text and the wordmark on light backgrounds.'),
    'sage':        ('#7fa37a', 'Success.'),
    'terracotta':  ('#d0674b', 'Errors and destructive actions.'),
    'slate':       ('#4f6d8f', 'Information.'),
}
C = {k: v[0] for k, v in COLOURS.items()}

FONTS = [
    ('Space Grotesk', 'Display: headings, numbers, the wordmark', '700 / 500',
     'https://fonts.google.com/specimen/Space+Grotesk', 'SIL OFL 1.1'),
    ('Inter', 'Body: interface text, forms, tables', '400 / 500 / 600',
     'https://fonts.google.com/specimen/Inter', 'SIL OFL 1.1'),
    ('Noto Sans Devanagari', 'Hindi: posters, customer-facing Hindi', '400 / 700',
     'https://fonts.google.com/noto/specimen/Noto+Sans+Devanagari', 'SIL OFL 1.1'),
]

# --------------------------------------------------------------------- mark --
# 64×64. A slanted P whose bowl is a sheet with a folded corner, and three
# ochre speed lines: the initial, the page, and the pace.
P_BODY = ('M24 13h14l9 9v5a13 13 0 0 1-13 13h-3v8.5a4.5 4.5 0 0 1-9 0V17.5A4.5 4.5 0 0 1 24 13z'
          'M31 21v11h3.5a5.5 5.5 0 0 0 0-11z')
P_FOLD = 'M38 13v6.5a2.5 2.5 0 0 0 2.5 2.5H47z'
SPEED = ['M7 22h11', 'M10 31h8', 'M13 40h5']


def mark_group(p, fold, speed):
    lines = ''.join(f'<path d="{d}"/>' for d in SPEED)
    return (f'<g transform="translate(5 0) skewX(-9)">'
            f'<path fill="{p}" fill-rule="evenodd" d="{P_BODY}"/>'
            f'<path fill="{fold}" d="{P_FOLD}"/></g>'
            f'<g stroke="{speed}" stroke-width="4" stroke-linecap="round">{lines}</g>')


def badge(size=64, x=0, y=0):
    s = size / 64
    return (f'<g transform="translate({x} {y}) scale({s})">'
            f'<rect width="64" height="64" rx="14" fill="{C["petrol"]}"/>'
            f'{mark_group(C["sheet"], C["mist"], C["ochre"])}</g>')


def bare(colour, size=64, x=0, y=0):
    """The mark without its square, in one colour, for stamps and engraving."""
    s = size / 64
    return f'<g transform="translate({x} {y}) scale({s})">{mark_group(colour, colour, colour)}</g>'


# ----------------------------------------------------------------- wordmark --
WM = json.load(open(os.path.join(HERE, 'wordmark.json')))


def wordmark(cap, x, baseline, print_colour, ok_colour):
    """'PrintOk' with cap height `cap`, baseline at `baseline`."""
    s = cap / WM['capHeight']
    y = baseline - WM['ascent'] * s
    first = ''.join(WM['paths'][:5])
    second = ''.join(WM['paths'][5:])
    return (f'<g transform="translate({x} {y:.2f}) scale({s:.5f})">'
            f'<path fill="{print_colour}" d="{first}"/><path fill="{ok_colour}" d="{second}"/></g>')


def wordmark_width(cap):
    return WM['width'] * cap / WM['capHeight']


def svg(w, h, body, bg=None, label='PrintOk'):
    fill = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" '
            f'width="{w:g}" height="{h:g}" role="img" aria-label="{label}">{fill}{body}</svg>\n')


def write(rel, text):
    path = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w').write(text)
    return path


def png(src, rel, size, height=None):
    out = os.path.join(HERE, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    args = ['rsvg-convert', '-w', str(size)] + (['-h', str(height)] if height else []) + [src, '-o', out]
    subprocess.run(args, check=True)
    return out


def main():
    # Logo
    mark = write('logo/printok-mark.svg', svg(64, 64, badge()))
    write('logo/printok-mark-ink.svg', svg(64, 64, bare(C['ink'])))
    write('logo/printok-mark-white.svg', svg(64, 64, bare('#ffffff')))

    cap = 30
    ww = wordmark_width(cap)
    write('logo/printok-wordmark.svg', svg(ww, 44, wordmark(cap, 0, 37, C['ink'], C['petrol'])))
    write('logo/printok-wordmark-white.svg', svg(ww, 44, wordmark(cap, 0, 37, C['sheet'], C['ochre'])))

    W = 64 + 16 + ww + 4
    write('logo/printok-logo.svg', svg(W, 64, badge() + wordmark(cap, 80, 47, C['ink'], C['petrol'])))
    write('logo/printok-logo-on-dark.svg', svg(W, 64, badge() + wordmark(cap, 80, 47, C['sheet'], C['ochre'])))
    write('logo/printok-logo-mono-ink.svg', svg(W, 64, bare(C['ink']) + wordmark(cap, 80, 47, C['ink'], C['ink'])))
    write('logo/printok-logo-mono-white.svg', svg(W, 64, bare('#ffffff') + wordmark(cap, 80, 47, '#ffffff', '#ffffff')))

    sw = wordmark_width(26)
    SW = max(sw, 112)
    write('logo/printok-logo-stacked.svg',
          svg(SW, 150, badge(112, (SW - 112) / 2, 0) + wordmark(26, (SW - sw) / 2, 146, C['ink'], C['petrol'])))

    # App icons
    for size in (16, 32, 48, 64, 128, 180, 192, 256, 512):
        png(mark, f'app-icons/printok-{size}.png', size)
    shutil.copy(os.path.join(HERE, 'app-icons/printok-180.png'), os.path.join(HERE, 'app-icons/apple-touch-icon.png'))
    # Maskable: Android crops to a circle, so the mark sits inside the 80% safe zone.
    maskable = write('app-icons/printok-maskable.svg', svg(512, 512, badge(360, 76, 76), bg=C['petrol']))
    png(maskable, 'app-icons/printok-maskable-512.png', 512)
    subprocess.run(['magick'] + [os.path.join(HERE, f'app-icons/printok-{s}.png') for s in (16, 32, 48)]
                   + [os.path.join(HERE, 'app-icons/favicon.ico')], check=True)

    # Social card
    og = write('social/printok-og.svg', svg(1200, 630,
        badge(180, 120, 150) + wordmark(92, 340, 300, C['sheet'], C['ochre'])
        + f'<text x="120" y="470" font-family="Inter, sans-serif" font-size="44" fill="{C["mist"]}">'
          'Scan. Pay. Collect your print.</text>', bg=C['petrol-deep']))
    png(og, 'social/printok-og.png', 1200, 630)

    # Colours
    write('colors/tokens.css', ':root {\n' + ''.join(
        f'  --printok-{k}: {v}; /* {d} */\n' for k, (v, d) in COLOURS.items()) + '}\n')
    write('colors/tokens.json', json.dumps({k: {'hex': v, 'use': d} for k, (v, d) in COLOURS.items()}, indent=2) + '\n')
    write('fonts/fonts.json', json.dumps([dict(zip(('family', 'role', 'weights', 'url', 'license'), f)) for f in FONTS], indent=2) + '\n')

    # Icons: the site's sprite is the kit's icon set.
    shutil.copy(os.path.join(PUBLIC, 'icons.svg'), os.path.join(HERE, 'icons/icons.svg'))

    # The site uses the kit directly.
    shutil.copy(mark, os.path.join(PUBLIC, 'favicon.svg'))
    shutil.copy(os.path.join(HERE, 'app-icons/apple-touch-icon.png'), os.path.join(PUBLIC, 'apple-touch-icon.png'))
    shutil.copy(os.path.join(HERE, 'app-icons/favicon.ico'), os.path.join(PUBLIC, 'favicon.ico'))
    shutil.copy(os.path.join(HERE, 'social/printok-og.png'), os.path.join(PUBLIC, 'og-image.png'))
    shutil.copy(os.path.join(HERE, 'app-icons/favicon.ico'),
                os.path.join(HERE, '..', 'agent', 'PrintOk.Agent.Tray', 'printok.ico'))
    print('brand kit built')


if __name__ == '__main__':
    os.makedirs(os.path.join(HERE, 'icons'), exist_ok=True)
    main()
