# Sports Module Rundown (Companion)

Drive a **live** Sports Module Rundown from Bitfocus Companion, and receive **Companion cue** fires (Cue 1–16).

**Web app:** <https://commentator-dashboard.pages.dev/hub>

## Connection

1. **Member email / password** — org member account from the [Sports Module hub](https://commentator-dashboard.pages.dev/hub) (password is masked)
2. Save / reconnect
3. Pick a **Rundown** (live ones are marked)

Uses the built-in Sports Module production cloud. Optional **Advanced: override cloud endpoint** for staging (custom Supabase URL + anon key).

## Actions

| Action               | What it does                               |
| -------------------- | ------------------------------------------ |
| Previous             | Previous main beat                         |
| Pause                | Pause live                                 |
| Resume               | Resume from pause                          |
| Next                 | Next main beat                             |
| Refresh rundown list | Reload titles / live flags into the picker |

The rundown must already be **Go live** in the [Sports Module hub](https://commentator-dashboard.pages.dev/hub). This module does not start the show.

## Live state variables

Refreshed from the server about twice a second, so pause / resume / beat changes performed in the hub — or from another Companion — are reflected here too.

| Variable            | Meaning                                     |
| ------------------- | ------------------------------------------- |
| `doc_id`            | Selected rundown id                         |
| `rundown_title`     | Selected rundown title                      |
| `live_active`       | `true` / `false` — rundown is live          |
| `live_paused`       | `true` / `false` — live rundown is paused   |
| `live_current_idx`  | Current live beat index (empty if not live) |
| `live_current_name` | Current beat label, e.g. `VTR — Cam 1`      |
| `last_action`       | Last **successful** transport action        |
| `last_error`        | Last error message (empty after a success)  |

**Feedbacks:** `Selected rundown is live`, `Selected rundown is paused`
**Presets:** **Transport** → Previous / Pause / Resume / Next (Pause lights amber while paused)

## Cue variables

| Variable              | Meaning                           |
| --------------------- | --------------------------------- |
| `last_cue_number`     | 1–16                              |
| `last_cue_name`       | Environment cue name (or `Cue N`) |
| `last_cue_line_text`  | Line summary                      |
| `last_cue_event_id`   | Line id                           |
| `last_cue_trigger_id` | Trigger id                        |
| `last_cue_at`         | Fire time (ISO)                   |

**Feedback:** `Last cue is number`  
**Presets:** **Companion cues** → Cue 1–16

Cue variables are cleared when you switch rundown, and when a show ends and goes live again — so a Cue button never stays lit on a cue from a previous show.
