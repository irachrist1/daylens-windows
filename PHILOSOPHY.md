# The Daylens Principle

Read this before touching anything. This is the most important document in the codebase.

---

## What every other tool gets wrong

Every screen-time and productivity tracker does the same thing: count app time, apply category labels, and present the totals as insight.

- "Chrome: 6 hours."
- "VS Code: 4 hours."
- "YouTube = distracting. VS Code = productive."

This is useless. Worse than useless — it's confidently wrong. A developer debugging a production incident in Chrome for three hours is doing their best work. That same developer scrolling Reddit for an hour during what should be their peak session is drifting. Every existing tool treats these identically. We do not.

**The app is not the story. What the user was doing inside it is.**

---

## The Daylens model

Two things separate us from everything else on the market:

### 1. We infer context. We don't ask for it.

The user should never have to tell Daylens anything for it to be useful. No intent forms. No focus session buttons. No category configuration. The app observes passively and builds a picture of what the user actually does — like adaptive charging on iPhone. Apple never asks when you go to sleep. It learns, and it acts.

If a user has been in VS Code and a terminal for 30 minutes, that's a focus session. Daylens knows that. The user doesn't need to press anything.

Over time, the app learns more: when this person is typically most focused, what their usual break patterns look like, what a normal workday looks like for them. Deviations from those learned patterns become meaningful signals — not because we labeled an app "distracting," but because we know this particular person's rhythm.

**If using Daylens ever feels like work, we have failed.**

### 2. Activity has context. Apps do not.

"Chrome: 6 hours" is a raw fact that tells you almost nothing. "Research for the auth migration: 2h 40m, code review on GitHub: 1h 15m, documentation: 45m, off-track browsing: 20m" — that's something a person can act on.

The AI pipeline exists to get from the first to the second. Window titles, sequences of apps and sites, timing patterns, the rhythm of context switches — all of this is evidence about what the user was actually trying to do. The AI reads the evidence. It does not read the category label.

---

## What distraction actually means

Distraction is not "you were in a non-productive app." That framing is wrong.

Distraction is a sustained pattern break during a work state. Specifically:

- The user had been in work-type apps (code editors, terminals, writing tools, design tools, research) for a meaningful stretch — long enough to reasonably say they were working.
- They then moved to clearly-leisure apps (entertainment, social media) and stayed past a threshold.

A short YouTube break between work blocks is fine and normal. Two hours of social media during what should be a peak work period is worth surfacing. The difference is the established work state and the duration. Not the app name.

Browsers are never inherently distracting. What was in the browser — what site, how long, what the page title was — is evidence. That's what the AI reads.

Social media is a signal, not a verdict. A social media manager on Twitter during work hours is working. Someone who has been in their IDE for two hours and then spends 45 minutes on Instagram is drifting. Same app, different context, different meaning.

**This is implemented in `src/main/services/distractionAlerter.ts`.** The current implementation:
1. Tracks inferred work state from sustained time in `WORK_STATE_CATEGORIES`.
2. Flags leisure time in `LEISURE_ALERT_CATEGORIES` only after work state is established.
3. Uses explicit focus session off-plan detection as an enhanced mode, not a requirement.

Do not regress this to category-based or intent-required detection.

---

## Rules for every line of code

**On distraction detection:**
Alert when: there is an established inferred work state AND the user has spent N consecutive minutes in clearly-leisure categories. No focus session required. No declared intent required. Explicit focus sessions enhance precision — they don't gate the feature.

Never alert because the user opened a browser. Never alert without an established work state.

**On focus scoring (`src/main/lib/focusScore.ts`):**
A focus score is not `focusedCategoryTime / totalTime`. That is the same broken model as every competitor. The score should reflect session depth, continuity, and alignment with learned patterns.

**On AI prompts (`src/main/services/ai.ts`):**
Do not send app categories to the model and ask it to rate productivity. Send window titles, sequences of sites and apps, time anchors, and session durations. Ask: "What was this person working on?" Let the model infer the task from evidence.

**On work context labels (`src/main/services/workBlocks.ts`):**
"Browser session" is a container. "Reviewing the PR for the payments refactor" is a task. Labels should describe what the user was doing, not what app they were in.

**On the Insights view (`src/renderer/views/Insights.tsx`):**
"Chrome was your biggest distraction" is a wrong answer. "You had two significant pattern breaks during your work blocks — 12 minutes on Hacker News mid-morning, and 38 minutes on YouTube during your strongest coding stretch" is a Daylens answer.

---

## The audit question

Before shipping anything, ask: **does this require the user to do something extra, or does it just work?**

If it requires the user to declare intent, configure categories, start a timer, or manage the app in any way — ask whether the app can infer it instead. Usually it can. Default to inference. Make manual input an enhancement for users who want it, not a requirement for the app to function.

That is the standard. Build to it.
