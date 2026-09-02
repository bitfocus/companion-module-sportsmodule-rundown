# Sports Module Rundown — Companion module

Bitfocus Companion connection for Sports Module Rundown.

**Service:** <https://commentator-dashboard.pages.dev/hub> — sign in there to create rundowns and **Go live**; this module only drives a show that is already live.

## What it does

- Login with **org member** email + **masked** password
- Built-in production Supabase URL + anon key (optional Advanced override)
- Pick a **rundown**
- Actions: **Previous / Pause / Resume / Next** (+ refresh list)
- **Cue poll:** variables + feedbacks + Cue 1–16 presets
- **Live state poll:** live / paused / title / beat index + name track the server (~0.5 s), so pause, resume and beat moves from the hub or another Companion are reflected here

## Build

Requires **Node 22** and **Yarn 4** (via Corepack).

```bash
cd companion-module-sportsmodule-rundown
yarn install
yarn package
```

Install `sportsmodule-rundown-x.x.x.tgz` via Companion → Import module package.
