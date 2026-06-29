# 🚀 Math Galaxy — a times-tables adventure

A whimsical, voice-first web app that helps a kid (built for an incoming 3rd grader)
build **multiplication-fact fluency** — answering by **microphone** or by **tapping a
keypad**. It's a single static page: no build step, no server, no accounts. Drop it on
GitHub Pages and play.

> **Feasibility, honestly:** Yes, an excellent voice experience is achievable — *as long
> as the mic is a delight layered on top of a rock-solid tap fallback*, not the only way
> in. A general-purpose recognizer mishears kids constantly ("thirteen" vs "thirty", "four"
> vs "for"). Math Galaxy sidesteps that by recognizing speech **on-device with [Vosk](https://alphacephei.com/vosk/)**,
> constrained to number words only — far more reliable for this task — and still **always**
> shows a keypad, auto-nudging it after a couple of misfires.

---

## Play it

Open `index.html` in a modern browser. On first launch it shows a loading screen while it
downloads the ~40 MB on-device voice model (one time — then it's cached and works offline).
Say or tap your answer. That's it.

Locally, just run the helper script — it serves the app and opens your browser:

```bash
./run.sh            # serve on http://localhost:8765 and open it
./run.sh 9000       # use a different port
./run.sh --no-open  # serve without opening a browser
```

(It uses `python3` if present, falling back to `python` or `npx serve`. Press Ctrl+C to stop.)

> The microphone needs a *secure context*: it works on `https://` (GitHub Pages) and on
> `http://localhost`, but **not** over a plain `http://` LAN address.

## Install it (it's a PWA)

Math Galaxy is a **Progressive Web App** — it installs to a home screen / app launcher
and runs fullscreen like a native app, with its own rocket icon.

- **Phone / tablet:** open the site in the browser → **Add to Home Screen**.
- **Desktop Chrome/Edge:** click the **Install app** button on the home screen (or the
  install icon in the address bar).

Once installed, a **service worker** (`sw.js`) caches the whole app — shell *and* the voice
model — so it **launches and plays fully offline**, voice included, no connection needed. The
model lives in its own persistent cache, so bumping the `CACHE` version in `sw.js` (do this
when you change shell files) never forces a 40 MB re-download.

## Deploy to GitHub Pages

```bash
git init && git add -A && git commit -m "Math Galaxy"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Build and deployment → Source: Deploy from a
branch → `main` / `/ (root)`**. Your app appears at `https://<you>.github.io/<repo>/`.
(The included `.nojekyll` file tells Pages to serve the folder as-is.)

---

## How it works (the design, grounded in research)

Every choice below traces to the research on math-fact fluency. See **Sources** at the end.

### The journey
Ten planets, flown in pedagogical order — **not** 0–12 in sequence. Easy *anchor* facts
first, then *derived/strategy* facts, then the genuinely hard handful, then a mixed "boss":

| # | Planet | Teaches | Why here |
|---|--------|---------|----------|
| 1 | Mercury | ×0, ×1 | trivial rules → instant confidence |
| 2 | Venus | ×2 | doubles connect to addition |
| 3 | Earth | ×10, ×5 | place-value & skip-counting patterns |
| 4 | Mars | ×3 | derived from doubles |
| 5 | Jupiter | ×4 | double-double |
| 6 | Saturn | ×9 | finger / digit-sum trick |
| 7 | Uranus | ×6 | ×5 + one group |
| 8 | Neptune | ×7, ×8 | the stubborn ones (6×7, 7×8, 8×8) |
| 9 | Pluto | ×11, ×12 | extension |
| 10 | The Sun | everything | maintenance / mastery review |

**Commutativity halves the work.** `3×7` and `7×3` are stored as one fact, so learning one
credits the other — the 13×13 grid collapses to ~91 unique facts the child must actually own.

### Two modes
- **🎈 Practice** — untimed, endless, hints available, gentle. The warm-up. Boaler/Beilock's
  research is clear that time pressure *blocks working memory*, so practice has **no clock**.
- **🏅 Test** — a short fixed set that gates the next planet. Clear it to unlock the next world.

### Mastery & progression (the "before moving to the next level" gate)
- A planet's **test is cleared** at **≥ 90% accuracy** *and* a gentle average-speed bar.
  90%+ criteria retain far better than 80% (Pitts et al.).
- Speed is measured **silently** and only ever celebrated as *"beat your own best"* — never
  shown as a ticking timer a child races against.
- **Stars (☆☆☆):** 1 for accuracy, +1 for speed, +1 for near-perfect-and-fast.

### Adaptive practice (spaced repetition)
Per-fact **Leitner boxes (1–5)** drive what shows up next:
- Correct **and fast** (< 3s — the research "automaticity" threshold) → **promote a box.**
- Correct but **slow** → stays (knows it, not yet automatic).
- **Wrong** → back to **box 1** (re-presents soon).
- Selection is a weighted random favoring low boxes, stale facts, and slow facts —
  so it **interleaves**, spends reps on weak facts, and barely revisits mastered ones.
- **Mastered** = box 5. The stats grid colors every fact by its box.

### Anti-anxiety, by design
No countdown clock, no red "X wrong" tally, no leaderboard. Misses get a kind "It's 56 —
you'll get it next time! 💪" and come back sooner. Short sessions, a visible finish line,
and a high success rate (you mostly see facts you're winning at).

### The microphone (on-device Vosk)
The one and only speech engine is a small [Vosk](https://alphacephei.com/vosk/) model that runs
**entirely in the browser** (WebAssembly), with recognition **constrained to number words only**.
That constraint is what fixes the classic "thirteen vs thirty" confusion — the recognizer has
~30 number-words to choose from instead of the whole language.

- **Private:** audio never leaves the device.
- **Offline:** the ~40 MB model is downloaded **eagerly at app start behind a loading screen**,
  then cached persistently — so every launch after the first is instant and works with no
  connection. (Needs a *secure context* for mic access: `https://` or `http://localhost`.)
- **Forgiving matching:** it checks every candidate number it heard and a homophone map
  (`for→four`, `ate→eight`, `to→two`…), grading against the *expected* answer — so a near-miss
  rarely costs a correct kid. It only ever **auto-accepts the right answer**; it never auto-marks
  you wrong from a mishear. Wrong answers are committed deliberately via the keypad.
- After ~2 mic misfires on a question, the keypad gently pulses so a child is never stuck.

**Set up the model (required — commit it so the page can serve it):**
```bash
./scripts/get-vosk-model.sh     # downloads + packages the model into models/ (~40 MB)
```
Then commit `models/` (GitHub Pages serves it same-origin). To host the model elsewhere instead
of committing it, change `VOSK_MODEL_URL` in `js/vosk-engine.js`.

### Whimsy & game feel
Animated starfield, a floating rocket mascot, confetti on fast/mastered answers, a streak
flame 🔥, XP ranks, collectible **buddies** for each planet cleared, synth sound effects, and
optional spoken questions/feedback. Tuned to be fun for ~age 8 without being chaotic.

---

## Files

```
index.html      all screens (home, map, planet, play, results, stats, settings)
styles.css      space theme, animations, responsive (mobile-first)
js/levels.js    the 10 planets + commutative fact generation
js/engine.js    Leitner spaced repetition, mastery gating, XP, localStorage save
js/vosk-engine.js  on-device Vosk speech recognition (the only mic engine) + eager model preload
js/tts.js       text-to-speech for spoken questions/feedback (mutes the mic while it talks)
js/numbers.js   spoken-number → integer normalization (+ homophone map)
js/app.js       UI controller wiring it all together
```

All progress is saved in `localStorage` on the device — no backend, nothing leaves the browser.

## Tuning

The knobs live in `CONFIG` at the top of `js/engine.js` — speed threshold, accuracy gate,
test length, XP. The planet sequence and hints live in `js/levels.js`.

---

## Sources (research the design is built on)

- Boaler, *Fluency Without Fear* (Stanford YouCubed) — timed-test anxiety; Beilock on
  working memory under pressure.
- Van de Walle — the ~3-second retrieval/automaticity threshold.
- Pitts et al. (2021) — 90%/100% mastery criteria retain better than 80%.
- Baroody / NCTM — fluency = accuracy + efficiency + flexibility, not just speed.
- Shelley Gray, The Rigorous Owl, Teacher Thrive — anchor→derived teaching sequence.
- Leitner / spaced-repetition & interleaving literature.
- Vosk (alphacephei.com/vosk) + vosk-browser — on-device, grammar-constrained speech recognition.
