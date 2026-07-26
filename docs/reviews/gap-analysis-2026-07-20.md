# North star: journal vs. Daylens, Monday 2026-07-20

This document compares what actually happened on 2026-07-20 (per the owner's
Obsidian journal) against what Daylens produced. Every gap here is a concrete
target for the activity-understanding work. Written 2026-07-25.

Two Daylens outputs were compared:

- **Stored wrapped report** — `wrapped_narratives` row for `day/2026-07-20`,
  the one actually shown in the app.
- **Fresh regeneration** — the same production pipeline re-run on 2026-07-25
  via `tests/wrapped-bench/debug.ts 2026-07-20`, with the full day's data.

## Ground truth (from the journal)

The real day, as a person tells it:

1. **Morning (9:06–12:30): ML study, constantly interleaved with Daylens.**
   Arrived 9:06, planned the day in Apple Notes, then fixed Daylens Slack
   issues *before* starting ML. Study path: roadmap.sh → signed up for
   DataCamp via GitHub Student Pack → realized Coursera (already subscribed)
   has Andrew Ng's Supervised ML → pivoted to that. Interrupted twice by
   humans: Norman (~15 min), and Allen needing an OTP from
   security.microsoft.com (~15 min). The whole time, Daylens development was
   moving in the background: texting Claude Tag in Slack, watching it ship.
   Spotify went on at some point and derailed focus.
2. **Lunch (~12:30–14:00): calls** — sister, then Ritah.
3. **Afternoon: email, Obsidian note cleanup, synced Daylens repos
   (spcsorg → irachrist1), more Daylens work.** Norman came back; talked.
4. **~17:00–21:00 off the computer:** two games of pool with Norman, then the
   Monday run (hill sprints). Home ~21:00.
5. **Night (21:24–23:07): Blacksmith CI migration + journal writing** in
   Obsidian with a Claude Code session in Warp.
6. **Meta-facts a good system should surface:** zero Andersen work (planned
   14:00–17:00 block skipped entirely); the day's plan and its outcomes; the
   one thing that mattered — "Daylens work all day through Slack."

## What the stored report said (what the user actually saw)

> "You spent the morning digging into Cursor Agents. … The whole morning was
> one unbroken 1h 4m run on Cursor Agents from 9:13am onward, nothing
> breaking the thread. … Short day on the screen."

### Failure S1 — the report froze at 10:38am and never regenerated

`generated_at` = 2026-07-20 10:38. The narrative describes 9:13–10:38 only.
The day went on until 23:07 — 495 active minutes — and the cached narrative
was never invalidated. The user's permanent record of this day is a
first-85-minutes snapshot calling it a "short day." Cache invalidation by
`facts_hash` either never re-fires or nothing re-requests generation after
first view.

### Failure S2 — "unbroken, nothing breaking the thread" is fiction

Within that same 9:13–10:38 window the journal records: a Norman
interruption, the Allen OTP errand (security.microsoft.com — visible in the
data, 369s), a DataCamp→Coursera pivot, and continuous Slack/Daylens
switching (30 Slack sessions across the day). The system had the evidence and
narrated the opposite.

### Failure S3 — surface listing instead of activity

"Datacamp took the biggest piece at 17 minutes, then GitHub at 12 … a
security check all got their moment." That is the tab list the product brief
explicitly calls the bad version. The real activity: *signing up for DataCamp
via the GitHub Student Pack, then abandoning it for Coursera.* The story is in
the page-title sequence; the report never assembles it.

## What the fresh full-data regeneration said

12 slides, almost all anchored on "Cursor Agents."

### Failure F1 — a window title is treated as the activity

"Cursor Agents" is a *window title* (Cursor's agent panel). The narrative
says it in 8 of 12 slides and never once says **Daylens** — the actual
project, which is plainly visible in the evidence (`daylens (Channel)` Slack
artifact in 7 of 12 blocks, repo sync artifact "Sync Repositories Irachrist1
and SPCSORG"). The system has no concept of *project/task*, only strings.

### Failure F2 — "The afternoon was clean … five hours of the same thing, no detours"

The afternoon contained: lunch calls (12:30–14:00, appearing as a tracked
block because the machine stayed on), a human visit, Spotify, email, Obsidian
cleanup, a repo sync, and a hard stop at 17:14. "No detours" is invented
smoothness. The block segmentation also bridges the lunch gap (11:37–14:46 is
one "block"), so downstream prose inherits the error.

### Failure F3 — the off-computer evening is invisible

17:30–21:24 has no data (pool + hill sprints). The narrative instead
implies one continuous grind: "You were still in it well into the night on
what started as a Monday morning." A person would say: *you left at 5, played
pool, ran hills, came back at 9.* Calendar integration exists in the product;
absence-of-data is itself signal and is never used.

### Failure F4 — background noise labeled as the activity

The 21:24–22:03 block is labeled **"Watching Netflix & YouTube"**, but its
own evidence shows Blacksmith CI migration pages, Slack, and Warp. Netflix
was an idle tab (1249s of "visit" time). This is the exact YouTube/Spotify/
Excel failure mode from the product brief: passive media outweighing the
real foreground activity in the labeler.

### Failure F5 — narrating chart plumbing instead of the day

"…most of that work was happening somewhere the chart calls Other." /
"the biggest slice belongs to Other." The model was fed bucketed chart
facts, got confused by its own aggregation, and wrote about the bucketing.

### Failure F6 — exclusion redaction over-fires on common words

The 17:14–17:30 block renders as `[excluded]`. Code-level check: this is not
a real exclusion — the only excluded app is Apple "Messages", and
`filterTrackingExcludedEvidence` (src/shared/evidencePrivacy.ts) redacts any
prose containing the bounded token "messages", so an ordinary block label
mentioning messages gets nuked while the block's actual evidence (apps,
page titles) passes through untouched. Two bugs: common-word app names
("Messages", "Notes", "Music", "Mail"…) must not redact ordinary prose, and
a redaction that fires on the label while leaving the evidence visible
protects nothing.

### Failure F7 — ML study, the day's planned core, is a footnote

Coursera was the #1 website domain of the day (2075s) plus Notion notes
("overview of ML") plus the roadmap/DataCamp arc. The regenerated deck gives
it one "forgotten" slide: "Coursera got 38 minutes, quietly tucked in."
The stored report and regen both miss the *pivot* story entirely.

## What "good" looks like for this day

A competent human summary from the same data:

> Morning was supposed to be ML study. You got there — Andrew Ng's course on
> Coursera, after a quick DataCamp detour you abandoned — but it was
> constantly interleaved with Daylens: you were driving Claude in the
> #daylens Slack channel all day and touching down in Cursor to check the
> work. One real interruption shows in the data (an OTP errand on
> security.microsoft.com ~10:30). Lunch break ~12:30–14:00. Afternoon was
> Daylens proper: repo sync spcsorg→irachrist1, issue triage in Linear,
> email and Obsidian cleanup. You left the computer 17:15–21:20 (pool + your
> Monday run, per calendar/journal). At night you migrated CI workflows to
> Blacksmith — Netflix was just an open tab — and closed the day writing
> your journal in Obsidian with Claude Code alongside. No Andersen work
> today.

Delta between that and what shipped = the roadmap:

1. **Project/task inference above app/title strings** (Daylens ≠ "Cursor
   Agents"; entities: repos, Slack channels, courses).
2. **Foreground-activity vs background-noise separation** (Netflix tab vs
   Blacksmith work; Spotify as ambience with attention cost, not activity).
3. **Interleaving as a first-class shape** — "studying while driving an agent
   in Slack" is one story, not twelve app fragments.
4. **Gaps are signal** — off-computer time named and bounded, never papered
   over with "unbroken."
5. **Narrative arcs across blocks** (DataCamp→Coursera pivot; plan vs
   reality when calendar data exists).
6. **Freshness** — a day's report must regenerate when the day's facts
   change (S1).
7. **Privacy propagation** — excluded means excluded everywhere (F6).
8. **Never narrate the plumbing** (F5) — facts fed to the writer must be
   day-facts, not chart buckets.
