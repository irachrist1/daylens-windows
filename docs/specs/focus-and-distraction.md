# Focus score and distraction alerts

**Status:** Accepted.

Focus score and distraction alerts are Version 2 product, not leftover code. They match the live implementation. Narrative surfaces may name these measured facts; they still do not turn them into a judgment of personal worth.

## Focus score

Focus score is a single deep-work percentage: time spent in continuous focused sessions of 25 minutes or more, divided by total active time.

- A session counts as focused when its category is focused work, or when the person marked the application as real work during onboarding.
- Continuous focused time in the same category may include gaps of up to one minute. A longer gap, a category change, or a non-focused session closes the streak.
- Only closed streaks of 25 minutes or more contribute to the percentage.
- When total active time is under 30 minutes, the score is “not enough data” rather than a number.
- Repeated qualifying streaks can receive a modest continuity adjustment already implemented in `focusScore.ts`. The percentage never becomes a fake number on an idle or barely tracked day.

The score is a measured fact, not a verdict about whether the day was well spent. It is available to:

- day summaries and AI tool evidence
- remote snapshots, labeled as focus score
- work-block and activity-fact queries that already consume it

The Apps overview does not show a focus score or a distraction label on application rows. That belongs to this surface and to the agent or wrap facts that already expose it.

## Distraction alerts

Distraction alerts watch for leisure interrupting inferred work. They do not require the person to declare intent.

- Daylens infers a work state after a sustained stretch in work-type applications (development, design, writing, research, productivity, AI tools, communication, meetings, email). Browsers do not establish a work state by themselves.
- During a work state, consecutive time in entertainment or social applications can fire an alert once the configured threshold is reached. Browsers are not treated as distractions; a browser visit is not known to be research or leisure.
- Leisure at any other time does not alert.
- If the person has started an explicit focus session with planned applications, off-plan detection is used instead.
- Alerts can be turned off. The shipped default is on, with a 10-minute threshold that the person can change in Settings (1–60 minutes).
- The alerter starts with the desktop app. Smoke-test mode does not start it.
- Fired alerts are recorded as `distraction_events` owned by the tracked activity they came from.

## Distraction profile

`getDistractionProfile` reports, for one day:

- high-distraction time: leisure-kind blocks and leisure sites
- low-distraction time: everything else that was tracked
- the leisure surfaces that appeared, with corrected durations

The split uses the same corrected interval readers Timeline and Apps use. Excluded or deleted activity does not appear. This is a time split, not a score.

The profile is available to Wrapped tools and to the local MCP server as `getDistractionProfile`.

## Voice

Labels, briefs, Timeline observations, and wrap prose still must not judge the person as unproductive, distracted, or lacking focus. Naming a real focus session, reporting the deep-work percentage when a surface already has that fact, or naming a leisure surface from the distraction profile is allowed. Scolding is not.

The wrap line validator does not ban the word “distraction.” It still rejects homework, drift, and focus-score grading language.

## Failure behavior

- Missing notification permission is visible in Settings. Tracking continues.
- Linux sessions without a notification service keep tracking; alerts and recaps may not appear as native notifications.
- An unavailable model does not disable the score, the alerter, or the profile.

## Acceptance criteria

- Focus score and distraction alerts remain live: computed, started at boot, configurable in Settings, and exposed to the surfaces that already consume them.
- The wrap validator accepts a factual line that names a distraction surface and still rejects drift and focus-score grading.
- Docs no longer mark these features as removed.
