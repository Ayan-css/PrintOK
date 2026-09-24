"""Writes brand/brand-kit.html, a single-file specimen of the kit, from brand/ itself."""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
read = lambda rel: open(os.path.join(HERE, rel)).read()
strip = lambda s: re.sub(r'\s(width|height)="[\d.]+"', '', s, count=2).strip()

COLOURS = json.load(open(os.path.join(HERE, 'colors/tokens.json')))
FONTS = json.load(open(os.path.join(HERE, 'fonts/fonts.json')))
SPRITE = read('icons/icons.svg').replace('<svg xmlns="http://www.w3.org/2000/svg">',
                                         '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">')
ICONS = re.findall(r'<symbol id="([^"]+)"', SPRITE)

logo = strip(read('logo/printok-logo.svg'))
logo_dark = strip(read('logo/printok-logo-on-dark.svg'))
stacked = strip(read('logo/printok-logo-stacked.svg'))
mark = strip(read('logo/printok-mark.svg'))
mark_ink = strip(read('logo/printok-mark-ink.svg'))
mark_white = strip(read('logo/printok-mark-white.svg'))
mono_ink = strip(read('logo/printok-logo-mono-ink.svg'))
og = strip(read('social/printok-og.svg'))

# The hero: the lockup with its speed lines drawn long, so they can slide in.
hero_mark = mark.replace('<g stroke="#d99a1e"', '<g class="speed" stroke="#d99a1e"')

swatches = ''.join(f'''
      <li class="swatch">
        <span class="chip" style="background:{v['hex']}"></span>
        <span class="sw-name">{k.replace('-', ' ')}</span>
        <button class="hex" type="button" data-copy="{v['hex']}" aria-label="Copy {v['hex']}">{v['hex']}</button>
        <span class="sw-use">{v['use']}</span>
      </li>''' for k, v in COLOURS.items())

icon_cells = ''.join(f'<li><svg class="ic" aria-hidden="true"><use href="#{n}"/></svg><span>{n}</span></li>' for n in ICONS)

sizes = ''.join(f'<figure class="app"><div style="width:{s}px;height:{s}px">{mark}</div><figcaption>{s}</figcaption></figure>'
                for s in (16, 32, 48, 64, 128))

HTML = f'''<title>PrintOk Brand Kit</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Noto+Sans+Devanagari:wght@400;700&display=swap">
<style>
:root {{
  --paper: #f5f2ec; --sheet: #fbfaf7; --ink: #10262b; --muted: #4c6166; --line: #d9d4ca;
  --petrol: #0e5e6f; --petrol-deep: #073a45; --ochre: #d99a1e; --mist: #9cc7cf;
  --surface: var(--sheet); --accent-text: var(--petrol);
  --display: 'Space Grotesk', 'Segoe UI', system-ui, sans-serif;
  --body: 'Inter', 'Segoe UI', system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    color-scheme: dark;
    --paper: #0a2329; --sheet: #0f2f36; --ink: #e8eeed; --muted: #9db3b6; --line: #1f4a53;
    --surface: #0f2f36; --accent-text: var(--mist);
  }}
}}
:root[data-theme="dark"] {{
  color-scheme: dark;
  --paper: #0a2329; --sheet: #0f2f36; --ink: #e8eeed; --muted: #9db3b6; --line: #1f4a53;
  --surface: #0f2f36; --accent-text: var(--mist);
}}
* {{ box-sizing: border-box; }}
body {{ background: var(--paper); color: var(--ink); font: 16px/1.6 var(--body); padding-inline: 20px; }}
main {{ max-width: 1080px; margin-inline: auto; padding-block: 28px 80px; display: grid; gap: 72px; }}
h1, h2, h3 {{ font-family: var(--display); font-weight: 700; line-height: 1.1; text-wrap: balance; margin: 0; }}
h2 {{ font-size: clamp(1.6rem, 3vw, 2.1rem); letter-spacing: -0.01em; }}
h3 {{ font-size: 1.05rem; }}
p {{ margin: 0; max-width: 62ch; }}
.eyebrow {{ font: 500 0.75rem/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent-text); }}
section {{ display: grid; gap: 24px; }}
.head {{ display: grid; gap: 10px; }}
.muted {{ color: var(--muted); }}
code, .mono {{ font-family: var(--mono); font-size: 0.85em; }}

/* Hero: the lockup on a petrol slab, speed lines sliding in once. */
.hero {{ background: var(--petrol-deep); color: #fbfaf7; border-radius: 20px; padding: clamp(24px, 5vw, 56px);
  display: grid; gap: 28px; overflow: hidden; }}
.hero .lockup {{ width: min(520px, 100%); }}
.hero .lockup svg {{ width: 100%; height: auto; display: block; }}
.hero p {{ color: #cfe1e4; font-size: 1.1rem; }}
.hero .eyebrow {{ color: var(--ochre); }}
.speed path {{ animation: slide 900ms cubic-bezier(.2,.8,.2,1) both; }}
.speed path:nth-child(2) {{ animation-delay: 90ms; }}
.speed path:nth-child(3) {{ animation-delay: 180ms; }}
@keyframes slide {{ from {{ transform: translateX(-14px); opacity: .2; }} to {{ transform: none; opacity: 1; }} }}
@media (prefers-reduced-motion: reduce) {{ .speed path {{ animation: none; }} }}

/* Anatomy */
.anatomy {{ display: grid; grid-template-columns: minmax(0, 260px) 1fr; gap: 32px; align-items: center; }}
.anatomy .big svg {{ width: 100%; height: auto; display: block; }}
.parts {{ display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }}
.parts li {{ display: grid; grid-template-columns: 28px 1fr; gap: 12px; align-items: start; }}
.dot {{ width: 20px; height: 20px; border-radius: 6px; margin-top: 3px; border: 1px solid var(--line); }}

/* Lockups */
.grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }}
.tile {{ border: 1px solid var(--line); border-radius: 14px; overflow: hidden; display: grid; grid-template-rows: 1fr auto; background: var(--surface); }}
.stage {{ min-height: 170px; display: grid; place-items: center; padding: 28px; }}
.stage svg {{ max-width: 100%; height: auto; max-height: 120px; }}
.stage.light {{ background: #f5f2ec; }} .stage.dark {{ background: #073a45; }} .stage.white {{ background: #ffffff; }}
.cap {{ padding: 12px 16px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 0.9rem; }}
.cap .mono {{ color: var(--muted); }}

/* Rules */
.rules {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }}
.rule {{ display: grid; gap: 12px; }}
.rule .stage {{ border: 1px solid var(--line); border-radius: 14px; background: #f5f2ec; min-height: 150px; }}
.clear {{ position: relative; padding: 16px; outline: 1.5px dashed var(--ochre); outline-offset: 0; }}
.dont .stage {{ position: relative; }}
.dont .stage::after {{ content: ''; position: absolute; inset: 14px; background:
  linear-gradient(to top right, transparent calc(50% - 1.5px), #d0674b calc(50% - 1.5px), #d0674b calc(50% + 1.5px), transparent calc(50% + 1.5px)); opacity: .8; }}

/* Colour */
.swatches {{ list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 16px; }}
.swatch {{ display: grid; gap: 6px; }}
.chip {{ height: 92px; border-radius: 12px; border: 1px solid var(--line); }}
.sw-name {{ font-family: var(--display); font-weight: 700; text-transform: capitalize; }}
.sw-use {{ font-size: 0.85rem; color: var(--muted); }}
.hex {{ justify-self: start; font: 500 0.85rem var(--mono); color: var(--ink); background: none; border: 1px solid var(--line);
  border-radius: 6px; padding: 2px 8px; cursor: pointer; }}
.hex:hover, .hex:focus-visible {{ border-color: var(--petrol); outline: none; }}
.hex.done {{ color: var(--accent-text); }}

/* Type */
.faces {{ display: grid; gap: 16px; }}
.face {{ border-top: 1px solid var(--line); padding-top: 18px; display: grid; grid-template-columns: minmax(0, 220px) 1fr; gap: 24px; }}
.face .meta {{ display: grid; gap: 4px; align-content: start; font-size: 0.9rem; }}
.face .meta a {{ color: var(--accent-text); }}
.sample {{ font-size: clamp(1.4rem, 3.4vw, 2.4rem); line-height: 1.2; overflow-wrap: anywhere; }}
.scale {{ display: grid; gap: 6px; }}
.scale div {{ display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }}
.scale .mono {{ color: var(--muted); width: 64px; flex: none; }}

/* Icons */
.icons {{ list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }}
.icons li {{ display: grid; justify-items: center; gap: 8px; padding: 14px 6px; border-radius: 10px; font: 0.72rem var(--mono); color: var(--muted); text-align: center; overflow-wrap: anywhere; }}
.icons li:hover {{ background: var(--surface); }}
.ic {{ width: 26px; height: 26px; fill: none; stroke: var(--ink); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }}

/* App icons + in use */
.apps {{ display: flex; flex-wrap: wrap; gap: 28px; align-items: end; }}
.app {{ margin: 0; display: grid; justify-items: center; gap: 8px; }}
.app div svg {{ width: 100%; height: 100%; display: block; }}
.app figcaption {{ font: 0.75rem var(--mono); color: var(--muted); }}
.poster {{ border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: #fbfaf7; color: #10262b; max-width: 420px; }}
.band {{ background: #0e5e6f; color: #fbfaf7; display: flex; align-items: center; gap: 12px; padding: 14px 18px; font: 700 1.4rem var(--display); }}
.band svg {{ width: 44px; height: 44px; }}
.poster .body {{ padding: 18px; display: grid; gap: 4px; text-align: center; }}
.hindi {{ font: 700 1.8rem 'Noto Sans Devanagari', 'Nirmala UI', sans-serif; }}
.og svg {{ width: 100%; height: auto; display: block; border-radius: 14px; border: 1px solid var(--line); }}
.use {{ display: grid; grid-template-columns: minmax(0, 420px) 1fr; gap: 16px; align-items: start; }}

/* Files */
.files {{ overflow-x: auto; }}
table {{ border-collapse: collapse; width: 100%; font-size: 0.92rem; }}
th, td {{ text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }}
th {{ font: 500 0.72rem var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }}
td:first-child {{ font-family: var(--mono); font-size: 0.82rem; white-space: nowrap; }}
.repo {{ color: var(--accent-text); font-weight: 600; }}

@media (max-width: 720px) {{
  .anatomy, .face, .use {{ grid-template-columns: 1fr; }}
  .anatomy .big {{ max-width: 200px; }}
}}
</style>

{SPRITE}

<main>
  <header class="hero">
    <span class="eyebrow">Brand kit · v1 · September 2026</span>
    <div class="lockup">{logo_dark.replace('<g stroke="#d99a1e"', '<g class="speed" stroke="#d99a1e"')}</div>
    <p>PrintOk turns any counter printer into a self-service one: a customer scans a QR code, uploads, pays, and collects.
       The mark says the same thing in one shape: a P that is a page, already moving.</p>
  </header>

  <section aria-labelledby="mark">
    <div class="head"><span class="eyebrow">The mark</span><h2 id="mark">A page, in motion</h2></div>
    <div class="anatomy">
      <div class="big">{mark}</div>
      <ul class="parts">
        <li><span class="dot" style="background:#fbfaf7"></span><div><h3>The P</h3><p class="muted">The initial, set at a 9° slant so it leans into the direction of travel. Its bowl is cut as a sheet of paper.</p></div></li>
        <li><span class="dot" style="background:#9cc7cf"></span><div><h3>The folded corner</h3><p class="muted">The one detail that makes the letter a page. It sits where a real sheet's corner turns.</p></div></li>
        <li><span class="dot" style="background:#d99a1e"></span><div><h3>Three speed lines</h3><p class="muted">Long, medium, short: the pace of a job that prints before the customer reaches the counter.</p></div></li>
        <li><span class="dot" style="background:#0e5e6f"></span><div><h3>The petrol square</h3><p class="muted">14-unit corner radius on a 64-unit grid. It is the app icon, the favicon and the badge.</p></div></li>
      </ul>
    </div>
  </section>

  <section aria-labelledby="lockups">
    <div class="head"><span class="eyebrow">Lockups</span><h2 id="lockups">Which logo, where</h2>
      <p class="muted">Every file is outlined SVG, so it looks the same whether or not the fonts are installed.</p></div>
    <div class="grid">
      <div class="tile"><div class="stage light">{logo}</div><div class="cap"><span>Default, on light</span><span class="mono">printok-logo.svg</span></div></div>
      <div class="tile"><div class="stage dark">{logo_dark}</div><div class="cap"><span>On petrol and dark</span><span class="mono">printok-logo-on-dark.svg</span></div></div>
      <div class="tile"><div class="stage white">{stacked}</div><div class="cap"><span>Stacked, for square spaces</span><span class="mono">printok-logo-stacked.svg</span></div></div>
      <div class="tile"><div class="stage white">{mono_ink}</div><div class="cap"><span>One colour: stamps, receipts</span><span class="mono">printok-logo-mono-ink.svg</span></div></div>
      <div class="tile"><div class="stage light"><div style="width:88px">{mark_ink}</div></div><div class="cap"><span>Mark, one colour</span><span class="mono">printok-mark-ink.svg</span></div></div>
      <div class="tile"><div class="stage dark"><div style="width:88px">{mark_white}</div></div><div class="cap"><span>Mark, reversed</span><span class="mono">printok-mark-white.svg</span></div></div>
    </div>
  </section>

  <section aria-labelledby="rules">
    <div class="head"><span class="eyebrow">Rules</span><h2 id="rules">Space, size, and what not to do</h2></div>
    <div class="rules">
      <div class="rule"><div class="stage"><div class="clear" style="width:230px">{logo}</div></div>
        <p><strong>Clear space.</strong> <span class="muted">Keep a quarter of the mark's height free on every side.</span></p></div>
      <div class="rule"><div class="stage"><div style="display:flex;gap:18px;align-items:end"><div style="width:16px;height:16px">{mark}</div><div style="width:96px">{logo}</div></div></div>
        <p><strong>Minimum size.</strong> <span class="muted">The mark at 16 px. The lockup at 96 px wide; below that, the mark alone.</span></p></div>
      <div class="rule dont"><div class="stage"><div style="width:200px;transform:scaleX(1.4)">{logo}</div></div>
        <p><strong>Don't stretch it.</strong> <span class="muted">Scale both directions together, always.</span></p></div>
      <div class="rule dont"><div class="stage"><div style="width:88px;filter:hue-rotate(150deg)">{mark}</div></div>
        <p><strong>Don't recolour it.</strong> <span class="muted">Petrol, sheet, mist and ochre, or one colour. Nothing else.</span></p></div>
    </div>
  </section>

  <section aria-labelledby="colour">
    <div class="head"><span class="eyebrow">Colour</span><h2 id="colour">Petrol, ochre, and the page</h2>
      <p class="muted">Petrol carries the brand, ochre is the one warm accent, and the neutrals are paper tones rather than grey. Click a code to copy it. Also in <code>colors/tokens.css</code> and <code>tokens.json</code>.</p></div>
    <ul class="swatches">{swatches}
    </ul>
  </section>

  <section aria-labelledby="type">
    <div class="head"><span class="eyebrow">Type</span><h2 id="type">Three families, one voice</h2></div>
    <div class="faces">
      <div class="face"><div class="meta"><strong>Space Grotesk</strong><span class="muted">Display · 700, 500</span><span class="muted">Headings, prices, the wordmark</span><a href="{FONTS[0]['url']}">Google Fonts ↗</a></div>
        <div class="sample" style="font-family:var(--display);font-weight:700">Scan. Pay. Collect. ₹2 a page.</div></div>
      <div class="face"><div class="meta"><strong>Inter</strong><span class="muted">Body · 400, 500, 600</span><span class="muted">Interface text, forms, tables</span><a href="{FONTS[1]['url']}">Google Fonts ↗</a></div>
        <div class="sample" style="font-family:var(--body);font-size:1.25rem;line-height:1.5">Your document is ready at the counter. Show token <strong>A-24</strong> to collect it.</div></div>
      <div class="face"><div class="meta"><strong>Noto Sans Devanagari</strong><span class="muted">Hindi · 400, 700</span><span class="muted">Posters and customer-facing Hindi</span><a href="{FONTS[2]['url']}">Google Fonts ↗</a></div>
        <div class="sample hindi" style="font-size:clamp(1.4rem,3.4vw,2.4rem)">QR से प्रिंट करें</div></div>
      <div class="face"><div class="meta"><strong>Scale</strong><span class="muted">rem, on a 16 px base</span></div>
        <div class="scale">
          <div><span class="mono">2.25</span><span style="font:700 2.25rem var(--display)">Heading one</span></div>
          <div><span class="mono">1.5</span><span style="font:700 1.5rem var(--display)">Heading two</span></div>
          <div><span class="mono">1.0</span><span>Body text, 1.6 line height</span></div>
          <div><span class="mono">0.75</span><span class="eyebrow">Label · tracked capitals</span></div>
        </div></div>
    </div>
  </section>

  <section aria-labelledby="icons">
    <div class="head"><span class="eyebrow">Icons</span><h2 id="icons">Line icons, never emoji</h2>
      <p class="muted">{len(ICONS)} icons from Lucide (ISC license), 24-unit grid, 2-unit stroke. They take the colour and size of the text beside them.
        Use <code>&lt;svg class="icon"&gt;&lt;use href="/icons.svg#printer"/&gt;&lt;/svg&gt;</code>.</p></div>
    <ul class="icons">{icon_cells}</ul>
  </section>

  <section aria-labelledby="apps">
    <div class="head"><span class="eyebrow">App icons</span><h2 id="apps">From tab to home screen</h2>
      <p class="muted">PNG at 16–512 px, <code>favicon.ico</code> with 16, 32 and 48, a 180 px Apple touch icon, and a maskable 512 px icon that keeps the mark inside Android's safe zone.</p></div>
    <div class="apps">{sizes}</div>
  </section>

  <section aria-labelledby="use">
    <div class="head"><span class="eyebrow">In use</span><h2 id="use">The counter poster and the share card</h2></div>
    <div class="use">
      <div class="poster"><div class="band">{mark.replace('<rect width="64" height="64" rx="14" fill="#0e5e6f"/>', '')} PrintOk</div>
        <div class="body"><span class="hindi">QR से Print करें</span><span class="muted" style="color:#4c6166">Scan this code to print from your phone</span></div></div>
      <div class="og">{og}</div>
    </div>
  </section>

  <section aria-labelledby="files">
    <div class="head"><span class="eyebrow">Files</span><h2 id="files">What's in the kit</h2>
      <p class="muted">Everything lives in <a class="repo" href="https://github.com/Ayan-css/PrintOK/tree/main/brand">brand/ on GitHub ↗</a>,
        generated by <code>python3 brand/build.py</code> from one definition of the mark.</p></div>
    <div class="files"><table>
      <thead><tr><th>Path</th><th>Contents</th></tr></thead>
      <tbody>
        <tr><td>logo/</td><td>Lockup, stacked, mark and wordmark, each for light and dark, plus one-colour versions</td></tr>
        <tr><td>app-icons/</td><td>PNG 16–512, favicon.ico, apple-touch-icon.png, maskable 512</td></tr>
        <tr><td>social/</td><td>1200 × 630 share card, SVG and PNG</td></tr>
        <tr><td>colors/</td><td>tokens.css and tokens.json</td></tr>
        <tr><td>fonts/</td><td>fonts.json: families, roles, weights, licences</td></tr>
        <tr><td>icons/</td><td>icons.svg sprite</td></tr>
        <tr><td>README.md</td><td>Usage rules</td></tr>
      </tbody>
    </table></div>
  </section>
</main>

<script>
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {{
  const value = b.dataset.copy;
  try {{ await navigator.clipboard.writeText(value); b.textContent = 'Copied'; b.classList.add('done'); }}
  catch {{ const r = document.createRange(); r.selectNodeContents(b); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }}
  setTimeout(() => {{ b.textContent = value; b.classList.remove('done'); }}, 1400);
}}));
</script>
'''

open(os.path.join(HERE, 'brand-kit.html'), 'w').write(HTML)
print('brand-kit.html', len(HTML))
