// Per-slide judge anchors. The benchmark's LLM judge was originally scoring
// against an ABSTRACT rubric with no exemplars, so it graded weak lines high
// and swung run to run. These anchors give the judge concrete calibration:
// for the slide it is scoring, what an excellent (9-10) line reads like and
// what a failing (<7) line reads like. Anchors here must stay in sync with
// the approved slide examples.
//
// Anchors are ILLUSTRATIVE, never templates: they show the BAR (specific, real,
// voice-true) and the failure modes (vague, hype, restating the card,
// inventing). They deliberately span roles — developer days, finance close
// days, consulting deck days, student and creator days — so the judge never
// learns "good = coding-flavored". Every slide id the day or week planner can
// emit with an AI ask has its OWN set (day and week separately); the
// wrapAnchors test enforces that coverage.

export interface SlideAnchors {
  /** What a 9-10 line for THIS slide reads like. */
  perfect: string[]
  /** What a <7 line reads like, and why it fails. */
  bad: string[]
}

/** Every cadence the benchmark can judge. Month and year share the week
 *  (period) anchor table: the period planner emits the same slide ids for all
 *  three, so one calibration set covers them by design. */
export type WrapBenchCadence = 'day' | 'week' | 'month' | 'year'

/** Dynamic-id families share one anchor set: story beats (story-morning, …)
 *  and the period thread deep-dives (thread-0 … thread-3). */
export function normalizeSlideId(slideId: string): string {
  if (slideId.startsWith('story')) return 'story'
  if (/^thread-\d+$/.test(slideId)) return 'thread'
  return slideId
}

const DAY_ANCHORS: Record<string, SlideAnchors> = {
  opening: {
    perfect: [
      'A maker\'s morning that set the whole tone, then the day opened up after the design review. The tracking engine quietly won the day.',
      'The close swallowed the morning, and once the reconciliations balanced the afternoon finally had room to breathe.',
      'Two discovery calls before lunch, then the whole afternoon disappeared into the client deck.',
      'Mostly off the clock today, and it reads like a choice, not a gap.',
    ],
    bad: [
      'Today was a productive and focused day with lots of great work in Cursor.',
      'You had a good day with some work and some breaks.',
    ],
  },
  headline: {
    perfect: [
      'Most of it stacked up before lunch, when the tracking engine took your two best hours in one sitting.',
      'The front half of the day was almost all the month-end close, before a single client call broke it up.',
      'Most of that was the problem set, and nearly all of it came after 3pm once the lectures were done.',
    ],
    bad: [
      'You tracked 6h 40m across the day.',
      'That is a lot of hours for one day of work.',
    ],
  },
  story: {
    perfect: [
      'You were on the tracking engine from the first coffee, fixing the midnight day-split that had been quietly wrong for weeks. By the standup at 9 you\'d already closed it.',
      'The morning was all the month-end close, one account at a time, until the trial balance finally tied out just before the 10am partner call.',
      'You spent the morning wrestling the thumbnail, three versions before one held, then finally opened the edit just before lunch.',
      'After the design review you gave the settings screen the rest of your attention, with a short YouTube break in the middle that read like a breath, not a detour.',
    ],
    bad: [
      'In the morning you worked in Cursor and Claude Code, then had a meeting, then worked more.',
      'You spent the morning being productive on various tasks.',
    ],
  },
  focus: {
    perfect: [
      'From 7:12am you stayed with the tracking engine for two and a half hours, your longest run of the day. 🔥',
      'The reconciliations held you for two and a half hours from 7:12am, before a single email got a reply.',
      'Two and a half hours on the problem set from 7:12am, not a single switch away. The cleanest stretch of the day.',
    ],
    bad: [
      'Your longest stretch was 2h 28m.',
      'You focused really hard for a long time today.',
    ],
  },
  timesink: {
    perfect: [
      'Claude Code held more of the day than anything else, and on a build day that reads as the work, not the leak.',
      'Excel pooled the most time by a wide margin, which for a close day is exactly where it should be.',
      'YouTube pooled the most minutes today, and some days the break is the headline. No spin on it.',
    ],
    bad: [
      'You spent the most time in Chrome today.',
      'Chrome was your top app at 1h 12m.',
    ],
  },
  apps: {
    perfect: [
      'Two tools carried the day and everything else was a rounding error. Cursor and Claude Code, back to back.',
      'The day lived in a handful of tools: Excel for the reconciliations, Outlook for the back-and-forth, and the GL system underneath it all.',
      'A short, deep list. You lived in Figma and barely touched anything else.',
    ],
    bad: [
      'Your top apps were Cursor, Figma, and Chrome.',
      'You used a lot of different apps today.',
    ],
  },
  split: {
    perfect: [
      'Nearly all of it was the build, with just enough off the clock to not fry. 88% to 12%.',
      'A heads-down ratio: 88 to 12. The kind of day where the work crowded almost everything else out.',
      'A fuller split than usual, 70% work to 30% off, and the day was better for it.',
    ],
    bad: [
      'You spent 88% of your day being productive.',
      'Work took up most of your time, which is good.',
    ],
  },
  earlystart: {
    perfect: [
      'The day started at 6:12am. The house was still quiet and the work had the cleanest hours to itself. ☕',
      '5:40am. Whatever pulled you up early, the reading got the best of it.',
    ],
    bad: [
      'You woke up early today.',
      'You started early, which shows great discipline.',
    ],
  },
  latenight: {
    perfect: [
      'The last thing you touched landed at 10:26pm. A long one, still in it well after dark. 🌙',
      'The screen was still on at 12:40am, winding down, not ramping up.',
    ],
    bad: [
      'You stayed up too late working.',
      'The day ended late at night.',
    ],
  },
  forgotten: {
    perfect: [
      'Notion quietly ate 22 minutes, notes you opened once and never closed.',
      'A forgotten half hour in DocuSign today, buried between the bigger blocks, signatures you chased without really noticing.',
      'Eighteen minutes in the citation manager you\'ll swear you never opened. It adds up between the reading.',
    ],
    bad: [
      'You also used Notion for 22 minutes.',
      'There were some other apps you used a little bit.',
    ],
  },
  wildcard: {
    perfect: [
      'Your day started earlier than any day in two weeks, and those first two hours were the cleanest work you did.',
      'You came back to the proposal 14 separate times today, and the day kept circling back to it.',
      'The evening did the heavy lifting on the edit. You found a second gear after the early scattering.',
    ],
    bad: [
      'You had an interesting day with some surprising moments.',
      'Your longest stretch was in the morning.',
    ],
  },
  meetings: {
    perfect: [
      'The standup ran 30 minutes and you built through the rest of the morning around it.',
      'Two reviews back to back after lunch, and both the AP and revenue schedules came out approved.',
      'Both discovery calls ran back to back before lunch, which is why the afternoon had room for the deck.',
    ],
    bad: [
      'You spent 1h 13m in meetings today.',
      'You had several meetings that took up your time.',
    ],
  },
  question: {
    perfect: [
      'The tracking engine has clearly been the main character lately. Are you near the end of it, or does it keep opening new doors?',
      'The deck came back to life today after two quiet days. What unblocked it?',
      'That thumbnail took three tries before it held. Was the third one obvious in hindsight, or a lucky swing?',
    ],
    bad: [
      'What did you work on today?',
      'Should you try to be more focused tomorrow?',
    ],
  },
  reflection: {
    perfect: [
      'Tuesday was a maker\'s day. You gave the tracking engine your first and best hours, closed the midnight bug that had been wrong for weeks, and still made room for the design review and the settings work after lunch. The eleven commits tell the same story the timeline does: early, heads-down, mostly on one thing. A good one to have behind you.',
      'About seven hours, and the month-end close was the whole spine of it. The reconciliations tied out by early afternoon and the pack went to the partners after. A couple of calls broke it up but never derailed it. The kind of day that leaves the close further along than it found it.',
    ],
    bad: [
      'Today you were productive and got a lot done. You worked on several things and had some meetings. Great job, keep it up tomorrow.',
    ],
  },
}

const WEEK_ANCHORS: Record<string, SlideAnchors> = {
  opening: {
    perfect: [
      'A week with one clear spine: the timeline rework, four days of it, everything else orbiting around.',
      'Two halves. The first three days were all the client deck, then it eased into follow-up and catch-up.',
    ],
    bad: ['A productive week with lots of good work across several projects.'],
  },
  headline: {
    perfect: [
      'About 31 hours in, and Tuesday carried more of it than any other day by a stretch.',
      'A lighter week than most, close to 18 hours, and most of it landed in two heads-down days on the audit workpapers.',
    ],
    bad: ['You tracked 31 hours this week.'],
  },
  consistency: {
    perfect: [
      'Seven of seven. You didn\'t take a day fully off this week.',
      'Five of the seven days had real time in them, and the two that didn\'t were the weekend, plainly taken.',
    ],
    bad: [
      'You showed up 100% of days!',
      'You were active 5 of 7 days this week.',
    ],
  },
  shape: {
    perfect: [
      'It built to a Wednesday peak and coasted down from there, with Friday the quietest by far.',
      'Front-loaded and honest about it: Monday and Tuesday did the heavy lifting, the rest was follow-through.',
      'Sunday was the mountain and Wednesday the valley. The rest held a steady line.',
    ],
    bad: ['Some days were busier than others this week.'],
  },
  bestday: {
    perfect: [
      'Sunday carried the week, and it was the day the proposal finally moved from notes to a draft.',
      'Tuesday was the engine: the close work got its longest run there and everything after was lighter for it.',
    ],
    bad: [
      'Your busiest day was Sunday with 10h 27m.',
      'Sunday was a great and productive day.',
    ],
  },
  worstday: {
    perfect: [
      'Wednesday was the exhale, and the week was better for it.',
      'Thursday barely registered, a few minutes of email and out. A quiet day is allowed to be a quiet day.',
    ],
    bad: [
      'Wednesday was your worst day.',
      'You did almost nothing on Wednesday.',
    ],
  },
  focus: {
    perfect: [
      '4h 14m on Thursday, all of it the pipeline work. Your deepest run of the week. 🏆',
      'The longest run landed Tuesday morning: nearly three hours on the grant application.',
    ],
    bad: [
      'Your longest stretch was 4h 14m.',
      'You had a really long focus session this week.',
    ],
  },
  bestbucket: {
    perfect: [
      'The second week did the heavy lifting, nearly a third of the whole month in seven days.',
      'The month peaked in its third week, when the audit and the board pack landed on top of each other.',
    ],
    bad: ['Week 2 had the most hours.'],
  },
  thread: {
    perfect: [
      'The tracking engine was the week: about twelve hours across four days, and every other thread bent around it.',
      'The client deck was the spine of the week, close to fourteen hours, rebuilt twice before the Thursday readout.',
      'The other constant was the audit workpapers, about three hours that kept resurfacing between the bigger blocks.',
    ],
    bad: [
      'Thread 1 was Malaria Notebook, 12h.',
      'You worked on the deck a lot this week.',
    ],
  },
  threads: {
    perfect: [
      'One thread towered and the rest were the supporting cast.',
      'Two threads split it evenly: the proposal early, the network build late, about nine hours each.',
    ],
    bad: ['You worked on several different projects this week.'],
  },
  timesink: {
    perfect: [
      'Excel held the most raw time this week, which for a close week is the work itself, not the leak.',
      'The browser took the biggest share, and most of that was the research living in tabs, not wandering.',
    ],
    bad: [
      'You used Dia the most.',
      'Dia was your top app at 32 hours.',
    ],
  },
  apps: {
    perfect: [
      'The whole week ran through three tools, and the rest is noise.',
      'Spread wide this week: the slides, the spreadsheet, and the inbox all took a real share, the mark of a week pulled in several directions.',
    ],
    bad: ['Dia, Safari, Notion, Slack, Cursor, Warp.'],
  },
  categories: {
    perfect: [
      'This was a building week, not a writing one. The design and admin were just what kept it moving.',
      'Mostly slide work and calls this week. The analysis was the thin layer underneath both.',
    ],
    bad: [
      'Coding 60%, design 25%, admin 15%.',
      'Your work was split across coding, design, and admin.',
    ],
  },
  split: {
    perfect: [
      '40% work, 60% off the clock. Not every week is a sprint, and this one wasn\'t.',
      'A heads-down ratio: 82 to 18. The kind of week where the work crowded almost everything else out.',
    ],
    bad: [
      'You were only 40% productive this week.',
      '88% work, 12% wasted on breaks.',
    ],
  },
  leisure: {
    perfect: [
      'The downtime was mostly YouTube and Netflix, clustered in the evenings after the work was done.',
      'A real weekend in there. The off-clock hours went to reading and long stretches away from the desk.',
    ],
    bad: [
      'You wasted time on YouTube and Netflix.',
      'You spent 4h 12m on leisure activities.',
    ],
  },
  meetings: {
    perfect: [
      'A little over an hour in calls all week, which is a light talking load for the amount that got built.',
      'Close to two hours in meetings, and they clustered early in the week, leaving the back half clear for the report.',
    ],
    bad: [
      'You had 1h 7m of meetings across several calls.',
      'You had a lot of meetings this week.',
    ],
  },
  forgotten: {
    perfect: [
      'Warp quietly took 26 minutes this week, never once the main event.',
      'The expense tool ate a forgotten half hour across the week, chased in the margins between the real work.',
    ],
    bad: [
      'You also used Warp.',
      'Warp took 26 minutes this week.',
    ],
  },
  latenights: {
    perfect: [
      'Five nights ran past 11, the latest ending at 12:40am on Thursday. A week that didn\'t clock out easily. 🌙',
      'Two nights stretched past 11pm, and the rest of the week closed at a human hour.',
    ],
    bad: [
      'You stayed up too late 5 nights.',
      'You worked late on several nights this week.',
    ],
  },
  earlystarts: {
    perfect: [
      'Two days started before 7, the earliest a 5:40am Tuesday that got the whole morning to itself.',
      'Two days started before 7, the earliest a 2:27am Thursday that was really Wednesday refusing to end.',
    ],
    bad: [
      'You woke up early twice.',
      'You had 2 early starts this week.',
    ],
  },
  compare: {
    perfect: [
      'About six hours more than last week, most of that landing on Sunday alone.',
      'Almost exactly last week again, within an hour. A steady stretch, not a spike.',
      'A lighter week than the one before it by a few hours, and it reads as a breather, not a slump.',
    ],
    bad: [
      'You improved 12% over last week!',
      'This week was more productive than last week.',
    ],
  },
  average: {
    perfect: [
      'About 7h 35m on a working day, which is a full day without being a punishing one.',
      'Close to six hours on a working day, the pace of a delivery week rather than a pitch week.',
    ],
    bad: [
      'Your average was 7h 35m per day.',
      'You averaged a good amount of time each day.',
    ],
  },
  question: {
    perfect: [
      'The pipeline ate the whole week. Was that the plan, or did it quietly take over?',
      'The deck got rebuilt twice before Thursday. Did the second version feel better, or just different?',
    ],
    bad: [
      'What are your goals for next week?',
      'Do you think this was a good week?',
    ],
  },
  reflection: {
    perfect: [
      'Good week. The timeline rework you\'ve been circling finally got four real days in a row, and Tuesday was the engine of it. The client deck kept its place in the mornings without ever taking over. Friday you eased off, and the shape says the week could afford it. A week that knew what it was about.',
      'A steady close week. The reconciliations took the front half, the partner pack went out Thursday, and the calls never managed to derail the desk time. Wednesday was almost nothing and the week was better for the exhale. Solid, honest hours.',
    ],
    bad: ['A solid and productive week where you accomplished a lot. Nice work, and keep the momentum going next week.'],
  },
}

/** Anchors for a slide, or null when we don't have a calibrated set yet (the
 *  judge then falls back to the rubric alone for that slide). Month and year
 *  score against the period (week) table — identical slide ids. */
export function anchorsFor(cadence: WrapBenchCadence, slideId: string): SlideAnchors | null {
  const table = cadence === 'day' ? DAY_ANCHORS : WEEK_ANCHORS
  return table[normalizeSlideId(slideId)] ?? null
}
