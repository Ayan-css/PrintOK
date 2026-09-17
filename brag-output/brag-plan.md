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

## Audio direction (revised — voiceover pass)
- Role: Kokoro voiceover (`am_adam`) carries the whole edit; music removed entirely per explicit request. SFX cues kept, retimed to the voice-driven schedule.
- Music: none — removed on request. The original `default`-tone music bed (`happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`, 120.19 BPM) and its volume-automation/beat-grid notes are superseded by this revision.
- Voiceover: single narration track, 16.32s, drives scene pacing — durations below are word-count-proportional splits of that measured length, not fixed guesses. The closing disclaimer line stays deliberately unvoiced: it types out silently after the narration ends, so the dry joke lands after the confident voiceover has already finished rather than being spoken over.
- Audio-reactive treatment: dropped along with the music (there is no bed left to react to).
- SFX posture: unchanged — the same 5 cues (hook slam, poster-cut click, two flow card-slides, payoff bell, stat drop), retimed to the new scene boundaries.
- Restraint rule: no SFX under the disclaimer line, same as before — it now plays against near-total silence rather than a pulled-back bed, which reads even drier.

### Voiceover script
> Every shop already owns a printer. Put a QR code on the counter, and it's a print station. Customers scan, upload, check the pages, and pay right on their own phone. A token number. Status, live, straight through to print complete. Five minute setup. Zero new hardware. That's PrintOk.

Generated via `npx hyperframes tts --voice am_adam`, measured at 16.32s. Deliberately does not read the on-screen labels verbatim (narration guidance: complement the visuals, don't caption them). Scene timings retimed proportionally to word count against the 16.32s measured duration:
- Hook (6 words): 0.00–2.00s
- Reveal (12 words): 2.00–6.00s
- Flow speedrun (13 words): 6.00–10.33s
- Payoff (10 words): 10.33–13.66s
- Outro, voiced part (8 words): 13.66–16.32s
- Outro, silent tail (wordmark + tagline + disclaimer typewriter): 16.32–20.0s — total runtime extended from 19s to 20s to give this silent button room without rushing it.

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
