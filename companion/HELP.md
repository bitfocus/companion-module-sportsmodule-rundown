# Sports Module Rundown (Companion)

Drive a **live** Sports Module Rundown from Bitfocus Companion, and receive **Companion cue** fires (Cue 1–16).

**Web app:** <https://commentator-dashboard.pages.dev/hub>

## Connection

1. **Member email / password** — org member account from the [Sports Module hub](https://commentator-dashboard.pages.dev/hub) (password is masked)
2. Save / reconnect
3. Pick a **Rundown** (live ones are marked)

Uses the built-in Sports Module production cloud. Optional **Advanced: override cloud endpoint** for staging (custom Supabase URL + anon key).

## Actions

| Action | What it does |
|--------|----------------|
| Previous | Previous main beat |
| Pause | Pause live |
| Resume | Resume from pause |
| Next | Next main beat |
| Refresh rundown list | Reload titles / live flags into the picker |

The rundown must already be **Go live** in the [Sports Module hub](https://commentator-dashboard.pages.dev/hub). This module does not start the show.

## Cue variables

| Variable | Meaning |
|----------|---------|
| `last_cue_number` | 1–16 |
| `last_cue_name` | Environment cue name (or `Cue N`) |
| `last_cue_line_text` | Line summary |
| `last_cue_event_id` | Line id |
| `last_cue_trigger_id` | Trigger id |
| `last_cue_at` | Fire time (ISO) |

**Feedback:** `Last cue is number`  
**Presets:** **Companion cues** → Cue 1–16
