# Brag Plan: PrintOk

## What is this app?
PrintOk turns a stationery shop's existing printer into a QR-code print station — a customer scans the counter poster, uploads a file, pays on their own phone, and the shop's printer prints it. No new hardware, no counter queue.

## The angle
Everything about this product is "the printer you already have, plus a QR code." The video should feel like watching a real order go through, start to finish, on the shop's actual counter poster and the customer's actual phone screens — because that IS the demo. The one earned joke is the project's own honesty: the README admits nothing has printed on a real physical printer yet. That's the punchline, delivered completely deadpan at the very end, after the video has just convincingly shown the whole pipeline working.

## Hook (first 2-3 seconds)
A thick-bordered black card SLAMS onto the cream paper background with bold Space Grotesk type: "Your printer already works." Beat later, a QR code icon pulses into frame.

## Key moments (the middle)
- The real customer flow, screen by screen, using the actual product screenshots: upload → preview → configure → pay — each swapping in like a phone screen change, one short label per screen.
- The payoff shot: the purple "Token #002" card zooming in with its bold yellow display type, then the order-status tracker ticking across to a green "Print Complete" badge.
- A quick stat beat pulled straight from the hero: "5 min setup · ₹0 new hardware · 7 file types."

## Outro / punchline
Wordmark card: "🖨️ PrintOk" with the tagline "Turn the printer you already own into a print station." Beat of held silence-ish restraint, then a small dry line fades in underneath, smaller and quieter in tone: "Not yet tested on an actual printer. So far, extremely confident." Hold on logo.

## User flow worth showing
1. **Entry:** Customer scans the shop's bilingual QR poster ("QR से Print / Scan to Print") on their phone.
2. **Key action:** Uploads a document, previews the rendered pages, picks copies/colour/sides, and pays via UPI/card on their own phone — using the real `01-upload.webp` → `05-pay.webp` screens.
3. **Result:** They get a Token number and watch the order status tick from Job Created → Payment Verified → Sent to Printer → Print Complete.

## Tone
- Preset: default
- Creative direction: a confident, real product demo told through the actual app screens, landing on one dry, self-aware disclaimer as the closing wink
- Interpretation: playful and clean, comfortable pacing with room for each screen to register, crossfades/clean wipes between beats, energy from the flow itself rather than aggressive cuts — the joke is quiet and only lands at the very end, so the rest stays sincere and postable

## Format: landscape — 1920x1080
## Duration: 19s target

## Visual identity (from the project)
- Background: `#f5f2ec` (paper) / `#0d0d0d` (ink black for bordered cards)
- Accent: `#6c2cff` (primary purple), `#f5c400` (secondary yellow), `#2dd4a0` (mint), used as-is from the site
- Text: `#1a1a1a` (ink) on paper; `#fafaf8` off-white on purple/black cards
- Display font: Space Grotesk
- Body font: Inter
- Strongest visual element: the purple "Token #002" card in bold yellow display type against the thick black-bordered, cream-paper neubrutalist UI — this is the site's most distinctive visual signature and the natural climax shot

## Share copy (draft)
Turned any shop's printer into a QR code. Scan, upload, pay, print — no new hardware. (Still waiting to test it on an actual printer.)

## Audio direction
- Role: warm, upbeat bed carrying the whole edit; light UI accents on screen swaps, one clear success cue on the token payoff
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3` (120.19 BPM, most energetic — matches `default`)
- Music treatment: starts at 0, low-in under the hook slam, steady at 0.30-0.35 through the flow, brief pull-back under the outro disclaimer line, soft fade-out on the final logo hold
- Music cue guidance: bundled preset read (`happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.json/.md`). Beat grid available at ~0.5s spacing (e.g. 3.02, 3.52, 4.02, 4.53, 5.03...16.02...). No strong cues land inside our 0-19s window (listed strong cues start at 16.02s+), so treat the local beat grid as a light bias for screen-swap timing (align swaps near 4.02s, 9.02s, 10.02s, 13.51s) rather than locking to a "strong cue." Restraint note: keep alignment loose — copy readability and the flow's own rhythm take priority over hitting a beat exactly.
- Audio-reactive treatment: subtle; let the purple token card's glow / the black card borders' presence breathe slightly with music RMS. No waveform or equalizer visuals.
- SFX posture: moderate — 4-5 cues total, matching `default` tone energy
- Audio-coupled moments: hook card slam (impact), each phone-screen swap in the flow speedrun (card-slide/drop), the Token card reveal (success bell), the outro logo settle (soft drop)
- Restraint rule: no SFX under the dry disclaimer line — let that beat land in near-silence against the pulled-back music, so the joke reads as dry rather than hyped

## Storyboard

### Scene 1 — Hook — 2.5s
Cream paper background. A thick black-bordered card slams in from slightly above, bold white Space Grotesk text: "Your printer already works." A small QR-code glyph pulses on in the corner as the card settles.
Sequential/interaction: none
Audio intent: a confident, punchy opener — the slam should feel decisive, not aggressive
Audio-coupled idea: card slam synced to `impact/impactSoft_medium_*` at the moment the card lands
Music: upbeat bed fading in under the slam
Transition mood: hard cut → Scene 2

### Scene 2 — Reveal — 3s
The real bilingual QR poster ("QR से Print / Scan to Print", purple/black on paper) fills the frame, then a phone silhouette scans it and the frame cuts straight into the real `01-upload.webp` screen ("Tap or Drop Document Here"). Small label: "Scan. Upload."
Sequential/interaction: yes — poster → scan gesture → upload screen, one motion after another
Audio intent: a light "here we go" lift as the real product appears
Audio-coupled idea: `interface/click_*` or `casino/card-slide-*` at the poster→screen cut
Music: steady, energy building
Transition mood: clean wipe → Scene 3

### Scene 3 — Flow speedrun — 4.5s
Three real screenshots swap in on a phone frame like sequential screen changes, each held long enough to read its one-line label: `02-preview.webp` ("Sees the pages" — 1.3s), `03-configure.webp` ("Picks copies & colour" — 1.3s), `05-pay.webp` ("Pays on their own phone" — 1.5s, holding slightly longer since it's the busiest screen).
Sequential/interaction: yes — 3 real screens swap in order, each a phone-screen change with its label
Audio intent: quick, rhythmic momentum — the flow feels alive and fast without losing readability
Audio-coupled idea: `casino/card-slide-*` on each screen swap, softly, matching the gesture
Music: energy holding, aiming loosely near the ~4.02s/9.02s/10.02s beat-grid points for swap timing (bias only)
Transition mood: clean wipe → Scene 4

### Scene 4 — Payoff — 4s
The purple "Token #002" card (real product visual, bold yellow display type) zooms in large and centered. Beneath it, the order-status tracker animates left to right through Job Created → Payment Verified → Sent to Printer → Print Complete, the final badge landing green.
Sequential/interaction: yes — 4 status badges light up in sequence, left to right, ending on the green "Print Complete" badge
Audio intent: the emotional high point — this is the moment the whole pipeline "works"
Audio-coupled idea: `impact/impactBell_heavy_000` at the moment "Print Complete" turns green; soft `interface/drop_001` on each earlier badge lighting up
Music: brief lift, matching the reveal
Transition mood: soft crossfade → Scene 5

### Scene 5 — Outro / punchline — 5s
Cut to the hero stat row counting up fast: "5 min setup · ₹0 new hardware · 7 file types" (1.5s), then crossfade to the closing card: "🖨️ PrintOk" wordmark with tagline "Turn the printer you already own into a print station." (2s hold, full read time). Music pulls back; a small, quieter, dry subtext line fades in underneath: "Not yet tested on an actual printer. So far, extremely confident." (1.5s hold on the full logo card).
Sequential/interaction: yes — 3 stats arrive quickly as one beat, then the wordmark card, then the disclaimer line fades in last, under everything else
Audio intent: land the flow's confidence, then let the joke land dry and quiet against a pulled-back bed
Audio-coupled idea: soft `interface/drop_001` under each stat; near-silence (no SFX) under the disclaimer line per the restraint rule
Music: pulls back to ~0.15-0.2 under the disclaimer, soft fade-out on final hold
Transition mood: soft crossfade → end

**Music mood for this video:** upbeat
**Audio summary:** One upbeat bed (vol-1, 120 BPM) runs the whole video at a steady 0.30-0.35, lifting slightly for the token payoff and pulling back to a near-whisper under the closing disclaimer line, with 5 restrained SFX cues (card slam, poster-to-screen cut, three screen swaps, status badges, and the Print Complete bell) reinforcing the real product motion rather than decorating it.
