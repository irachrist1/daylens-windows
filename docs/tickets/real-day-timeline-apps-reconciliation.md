# Reconcile real-day Timeline, Apps, and AI facts

## Why

The private real-day replay for 2026-07-13 reaches four production consumers of the same captured activity and they disagree materially. Worse, when asked about the day, the agent claimed the surfaces agreed. A product whose one promise is a trustworthy memory cannot show four different day lengths and then deny the difference.

This result must remain a failing real-day comparison. It must not be accepted as the expected day merely because each surface is internally deterministic, and the private day is reviewed for acceptance only after the surfaces genuinely agree.

## Current behavior

For 2026-07-13, the same captured activity produces:

- Timeline renderer projection: 10,731 tracked seconds (2h 59m)
- Direct Timeline payload used by AI and wrap paths: 23,454 tracked seconds (6h 31m), reporting 33,874 focused seconds — more focus than tracked time
- AI day-overview tool: about 24,800 seconds (6h 53m)
- Apps: 36,667 seconds (10h 11m)

Asked about the day, the agent asserted there was no disagreement between surfaces instead of naming the conflict.

The packaged desktop replay adds a fourth divergence class: the rendered Apps view does not visibly present one of the five largest applications reported by its own IPC summary for the same date, so `verify:real-day:desktop` currently fails on its DOM-versus-IPC comparison.

The reviewed 2026-07-16 and 2026-07-17 replays add two interpretation failures beyond duration disagreement:

- **Meetings are invisible even when the evidence is overwhelming.** A chaired multi-hour morning meeting was reconstructed as ordinary browsing, and the day was reported as having no meeting signal, despite dedicated meeting applications ranking among the day's largest application totals. No calendar was connected, and reconstruction currently has no other way to recognize a meeting. Meeting recognition must combine calendar signal with captured meeting-application evidence; either alone must be enough to stop the day from denying a meeting happened.
- **Block labels have the wrong voice.** Labels read as raw window and video titles or generic activity phrases rather than describing what I was actually doing in my own terms. The label voice needs an explicit recorded definition that the labeling path is evaluated against; until then, real-day reviews keep failing on label quality even when block boundaries are right.

## Desired behavior

- Timeline, Apps, search, memory, MCP, wrap, and AI read one corrected canonical interpretation of the same intervals.
- Browser time is attributed without being double-counted or discarded.
- Focused duration never exceeds eligible tracked duration for the same scope.
- Persisted and rebuilt projections produce the same result unless an explicit versioned migration changes the interpretation.
- Calendar events are distinguished from captured meetings, and supported matches appear consistently across Timeline and AI.
- When surfaces or evidence genuinely conflict, the agent names the conflict; it never asserts agreement it has not verified.

## Dependencies

This is Wave 1 work and follows its order: capture and evidence migration, then the shared corrected activity-fact query, then Timeline and Apps on that shared seam, then agent context and answers. It requires:

- Acceptance of the capture/evidence, Timeline, and Apps specifications.
- The shared corrected activity-fact query ticket.

The failing 2026-07-13, 2026-07-16, and 2026-07-17 comparisons guide this work. A reviewed private baseline is the exit of this ticket, not an entry condition: a day is reviewed and accepted only when Timeline, Apps, meetings, and AI agree and the reconstruction is genuinely useful — meetings recognized, labels in my voice.

## Acceptance checks

- The real-day comparison has no unexplained Timeline/Apps duration disagreement beyond its recorded tolerance.
- Direct payload, renderer IPC projection, AI tools, and wrap facts agree on totals and block ownership.
- Focus time is clamped to canonical active intervals.
- Calendar-only, captured-only, and matched meetings are reported separately; no calendar event becomes claimed work without supporting evidence.
- Correction, exclusion, and deletion update every consumer without resurrecting removed evidence.
- Asked about a day whose surfaces or evidence conflict, the agent states the specific conflict.
- A day with a chaired meeting is recognized as containing that meeting from captured meeting-application evidence alone, from calendar signal alone, and from both together; the reconstruction never reports "no meeting signal" when either source supports one.
- The label voice has a recorded definition, and the labeling path is evaluated against it in the real-day review.
- The 2026-07-13, 2026-07-16, and 2026-07-17 reconstructions pass review and are accepted as private baselines.

## Verification

- Run `npm run verify:real-day` against the private fixture until the disagreement is resolved, then accept the reviewed day.
- Run `npm run verify:real-day:desktop` on a disposable clone to compare renderer DOM with production IPC and exercise correction, deletion, and one approved AI turn.
- Run the deterministic synthetic and strict Timeline gates for controlled edge cases.
