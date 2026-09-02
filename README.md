# Sports Module Rundown — Companion module (v0.3)

Bitfocus Companion connection for Sports Module Rundown.

## What it does

- Login with **org member** email + **masked** password  
- Built-in production Supabase URL + anon key (optional Advanced override)  
- Pick a **rundown**  
- Actions: **Previous / Pause / Resume / Next** (+ refresh list)  
- **Cue poll:** variables + feedbacks + Cue 1–16 presets  

## Build

```bash
cd companion-module-sportsmodule-rundown
npm install --legacy-peer-deps
npm run package
```

Install `sportsmodule-rundown-0.3.0.tgz` via Companion → Import module package.
