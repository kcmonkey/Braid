# Braid — Demo Storyboard

A tight ~30–40s loop for the README hero GIF. Each beat maps to one of the
three moats (canvas/DAG · dedupe-merge · collapsed summaries). Record it once,
deliberately; the goal is "I get it in 5 seconds", not a full tour.

## Before you record

- **Window size**: resize the EDH window to ~**1280×800** (crisp at GIF widths).
  Bigger windows make text mushy after downscaling.
- **Hide secrets**: close other tabs, clear the terminal, no real paths/emails on screen.
- **Pre-stage prompts**: have the exact text ready to paste (see beats) so there's
  no typing-hesitation in the capture. Short prompts = short streams = small GIF.
- **Auth**: confirm subscription auth works first (`Braid: Check Environment`).
  `ANTHROPIC_API_KEY` must NOT be set.
- **Cursor**: move slowly and pause ~1s on every key UI element. Fast cursors read
  as jitter in a low-fps GIF.
- **Theme**: a dark theme generally compresses cleaner and looks sharper as a GIF.

## Beats (target ~35s total)

| # | t | Action on screen | Why it's in the cut |
|---|------|------------------|---------------------|
| 1 | 0–5s | Open a canvas. Type a small real prompt into the root Board and watch the **Markdown answer stream in**. | Establishes "it's a real Claude Code conversation." |
| 2 | 5–11s | Click **⑂ branch** on that board → child Board. Ask a divergent follow-up ("what about approach B?"). Branch the root **again** for a second divergent line. | Shows forking → the DAG taking shape. The whole point. |
| 3 | 11–17s | **Zoom out** with Ctrl+scroll: boards collapse to one-line summaries (LOD). **Zoom into** one board: full transcript returns. | The collapsed-summary moat — nobody else does this. |
| 4 | 17–30s | **Box-select** the two divergent branches → the **merge preview drawer** opens (shared background · per-branch context · dedup stats). Confirm → a new **merged Board** streams an answer that uses the combined context. | Dedupe-merge — the killer feature. Let the drawer's dedup stats sit on screen ~2s. |
| 5 | 30–35s | Pan/zoom-to-fit across the whole graph. **Hold the final frame** on the full DAG. | Beauty shot + clean loop point. |

## After you record

Export/record to a video file (MP4/MKV), then convert:

```powershell
# from the repo root
./scripts/make-gif.ps1 -Source .\raw-demo.mp4 -Out .\media\demo\demo.gif
```

The README already points at `media/demo/demo.gif`, so it lights up the moment
that file exists. Aim for **< 8 MB** (GitHub renders inline GIFs up to ~10 MB).
If it's too big: lower `-Fps` (12 is fine), `-Width` (760), or trim with
`-Start`/`-Duration`.

## Recording tools (pick one)

- **ScreenToGif** (Windows, free, recommended) — records *and* edits *and* exports
  GIF directly; you can cut dead frames and even skip `make-gif.ps1`. If you export
  a GIF straight from it, just save it as `media/demo/demo.gif`.
- **OBS Studio** or **Xbox Game Bar** (`Win`+`G`) — record MP4, then run
  `make-gif.ps1` to get an optimized GIF.
