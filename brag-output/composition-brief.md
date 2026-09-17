# Hyperframes Composition Brief: PrintOk

## Objective
Create a short launch-style brag video for PrintOk — a real, pre-launch product, not a joke site. The video should feel like watching one real order go through the pipeline, end to end.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 19 seconds (15-25s acceptable range)

## Source Material
- Project root: `/home/ayan/Projects/printok`
- Primary files read: `apps/customer-web/public/index.html`, `apps/customer-web/public/styles.css`, `apps/customer-web/public/poster.js`, `apps/customer-web/public/images/how-it-works/*.webp`, `README.md`, `package.json`
- Product name: PrintOk
- Tagline / strongest claim: "Turn the printer you already own into an instant print station." Hero stats: 5 min setup, ₹0 new hardware, 7 file types.
- Key UI or visual moment to recreate:
  - The bilingual QR poster ("QR से Print" / "Scan to Print") — see `apps/customer-web/public/poster.js` for the real layout, colors (`#6c2cff` brand, `#0d0d0d` ink, `#faf9f5` paper), and bilingual treatment.
  - The real product screenshots at `apps/customer-web/public/images/how-it-works/01-upload.webp` through `06-token.webp` — use these images directly as the phone-screen content, do not redraw them.
  - The purple "Token #002" card and the 4-stage order-status tracker (Job Created → Payment Verified → Sent to Printer → Print Complete), visible in `06-token.webp`.
- Copy that must appear verbatim:
  - "Your printer already works."
  - "Turn the printer you already own into a print station."
  - "5 min setup · ₹0 new hardware · 7 file types"
  - "Not yet tested on an actual printer. So far, extremely confident."
  - Screen labels: "Scan. Upload." / "Sees the pages" / "Picks copies & colour" / "Pays on their own phone"

## Creative Direction
- Tone preset: default
- Creative direction: a confident, real product demo told through the actual app screens, landing on one dry, self-aware disclaimer as the closing wink
- Interpretation: playful and clean, comfortable pacing, crossfades/clean wipes, energy comes from the real flow rather than aggressive cuts; stay sincere throughout and let the one joke land quietly at the very end
- Angle: PrintOk's whole pitch is "the printer you already have, plus a QR code" — so the video should just show one order happening for real, using the actual screenshots, and end on the project's own honest admission that it hasn't touched a physical printer yet.
- Hook: A thick black-bordered card slams onto the cream paper background with the bold line "Your printer already works," a QR glyph pulsing in beside it.
- Outro / punchline: PrintOk wordmark + tagline, then a small, quiet, dry line fades in beneath: "Not yet tested on an actual printer. So far, extremely confident."
- Avoid:
  - Generic SaaS language ("streamline your workflow", etc.)
  - Abstract filler visuals — every scene must show a real screenshot, the real poster design, or real copy
  - Unrelated visual redesign — use the project's own palette and neubrutalist card style (thick black borders, cream paper background), not a new visual system

## Visual Identity
- Background: `#f5f2ec` (paper), cards on `#0d0d0d` (ink black) or `#6c2cff` (primary purple)
- Text: `#1a1a1a` (ink) on paper backgrounds; `#fafaf8` off-white on dark/purple cards; `#f5c400` (secondary yellow) for the Token number display, matching the real screenshot
- Accent: `#6c2cff` primary purple, `#f5c400` secondary yellow, `#2dd4a0` mint (success/status), `#1db87a` success green (for the "Print Complete" badge)
- Display font: Space Grotesk (headlines, token number, stat numbers)
- Body font: Inter (labels, body copy)
- Visual references from the project: thick black borders (`--color-border: #0d0d0d`) on cards, dashed drop-zone styling from the upload screen, the phone-frame presentation used for all six `how-it-works` screenshots, the bilingual QR poster layout from `poster.js`

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. Hook — 2.5s — black card slams in with "Your printer already works."; QR glyph pulses in
2. Reveal — 3s — real bilingual QR poster → phone scan gesture → cuts into real `01-upload.webp` screen; label "Scan. Upload."
3. Flow speedrun — 4.5s — real screenshots `02-preview.webp` → `03-configure.webp` → `05-pay.webp` swap in on a phone frame, each with a one-line label, held long enough to read
4. Payoff — 4s — the purple "Token #002" card (from `06-token.webp`) zooms in; 4-stage status tracker animates left to right, ending on green "Print Complete"
5. Outro — 5s — hero stats count up ("5 min setup · ₹0 new hardware · 7 file types"), crossfade to PrintOk wordmark + tagline, then the dry disclaimer line fades in quietly underneath

## Audio
- Audio role: warm upbeat bed carrying the whole edit, light UI accents on screen swaps, one clear success cue on the token payoff
- Audio arc: steady bed under the hook and flow, brief lift on the token payoff, pulls back to near-whisper under the closing disclaimer line, soft fade-out on the final hold
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`
- Music treatment: fade in under the hook slam, hold ~0.30-0.35 through scenes 2-4, duck to ~0.15-0.2 under the disclaimer line in scene 5, soft fade-out on final logo hold
- Music cue guidance: bundled preset at `assets/music/cues/happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.json` (120.19 BPM). No `strongCues` fall inside 0-19s (they start at 16.02s+ in the source track's own timeline) — treat the beat grid (~0.5s spacing, e.g. 3.02, 3.52, 4.02, 4.53, 5.03, 9.02, 9.52, 10.02, 13.51, 14.02...) as a loose bias for the three screen swaps in Scene 3 and the status-badge ticks in Scene 4. Do not force it — readability first.
- Audio-reactive treatment: subtle; let the purple token card's glow and the black card borders' presence breathe slightly with music RMS. No waveform/equalizer visuals, no strobing.
- Audio-coupled moments:
  - Scene 1 hook slam — impact cue at the moment the card lands
  - Scene 2 poster→screen cut — a click/card-slide cue at the cut
  - Scene 3 — a soft card-slide cue on each of the 3 screen swaps
  - Scene 4 — soft drop cues as each status badge lights up, one clear bell/success cue when "Print Complete" turns green
  - Scene 5 — soft drop under the stat count-up; near-silence (no SFX) under the disclaimer line so the joke reads dry
- SFX selection guidance: match the real gesture — card-slide/drop sounds for the phone-screen swaps, a click for the poster-to-screen cut, an announcement-style bell only for the Print Complete payoff. Keep total SFX count moderate (4-6), matching the `default` tone.
- SFX analysis guidance: read `skills/brag/assets/sfx/sfx-analysis.md` (or the installed-skill equivalent) before final selection; prefer low/medium high-frequency-risk files since several cues repeat in nature (screen swaps).
- Exact SFX choice: Hyperframes should choose filenames, timestamps, density, and volume based on the implemented animation.
- Audio files: copy the chosen music and any Hyperframes-selected SFX into `brag-output/composition/assets/`

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core` (composition contract + `data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design spec, beats, audio-reactive), `hyperframes-keyframes` (seek-safe keyframes), and `hyperframes-cli` (lint/check/render). `/brag` is its own workflow: do not enter the `hyperframes` entry-point intent interview and do not route into its generic promo / launch-video workflow. Prefer native Hyperframes conventions over anything in `/brag`.

Requirements:
- Show at least one real UI, copy, or visual element from the source project (the six `how-it-works` screenshots and the QR poster design are the primary real material — use the actual `.webp` files as image sources where the storyboard calls for a phone screen).
- Keep all text readable in the final render (respect the reading-time floors from `brag-plan.md`: short labels ~0.8s settled, the hook line gets the most).
- Keep the video within 15-25 seconds (target 19s).
- Include the planned music/SFX layer — not disabled, not intentionally silent.
- Treat `/brag` audio notes as guidance, not a fixed cue sheet. Choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints. Ignore cues that hurt readability, scene pacing, or the product story.
- Use SFX to support motion and interaction: card sounds for the phone-screen swaps, a short announcement cue for the Print Complete payoff, restraint everywhere else — especially under the closing disclaimer line.
- Honor the planned music ducking under the disclaimer line and the fade-out on the final hold.
- Use the Hyperframes audio-reactive workflow for the subtle glow/presence treatment described above. If extraction is unavailable, document it and skip — do not block the render.
- Use local assets for audio and any required runtime/media dependencies (copy the six `.webp` screenshots and the music file into `composition/assets/`).
- Run `hyperframes check` before render — it is brag's single gate.
