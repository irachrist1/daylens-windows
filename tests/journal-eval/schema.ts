// The journal-anchored day eval: ground truth is what the owner said the day
// was (Obsidian journal), supplemented by machine-verifiable sources (git,
// calendar, meetings) for days without a journal entry. A day file records
// the real day; the runner scores what Daylens produced against it.
//
// Local-only, like scripts/real-day: it reads a copy of the real database and
// real journal-derived expectations, so it never runs in CI. CI guards the
// eval program itself (see journalEvalProgram.test.ts).

export interface EvalDayShapeSegment {
  /** Rough local clock bounds, "HH:MM" 24h. Loose by design — the scorer
   *  allows ±45 min; journals are human recollection, not telemetry. */
  from?: string
  until?: string
  /** What was actually happening, as the person would say it. */
  desc: string
}

export interface EvalDayGap {
  from: string
  to: string
  reason?: string
}

export interface EvalPrimaryWork {
  /** Human name for the work ("Daylens", "ML study"). */
  name: string
  /** Case-insensitive substrings, any of which counts as naming this work
   *  when it appears in a user-visible label or narrative line. */
  aliases: string[]
}

export interface EvalDay {
  date: string
  /** journal — the owner wrote this day up; machine — reconstructed from
   *  verifiable sources only (git, calendar, meeting notes). */
  confidence: 'journal' | 'machine'
  sources: string[]
  /** 2–6 sentences: the day as the person who lived it tells it. Fed to the
   *  LLM judge as the reference story. */
  summary: string
  /** The work the day was actually about, most important first. A passing
   *  day names every entry somewhere the user can see. */
  primaryWork: EvalPrimaryWork[]
  /** Real but secondary threads; naming them is good, missing them is not
   *  an error. */
  secondary?: EvalPrimaryWork[]
  /** Day-specific labels that must never be presented as the work (beyond
   *  the global tool-surface guards). */
  bannedAsWork?: string[]
  /** The arc of the day. Scored by the judge against timeline + wrapped. */
  shape?: EvalDayShapeSegment[]
  /** Known off-computer stretches. Blocks must not span them; narratives
   *  must not claim continuity across them. */
  gaps?: EvalDayGap[]
  /** Caveats about the data itself (capture outages etc.) — shown to the
   *  judge so it doesn't punish Daylens for evidence that never existed. */
  notes?: string
}

export interface DimensionScore {
  score: number
  max: number
  violations: string[]
}

export interface DayScore {
  date: string
  confidence: EvalDay['confidence']
  /** Did user-visible output name each primary work? */
  primaryWork: DimensionScore
  /** Zero tool-surface titles presented as work. */
  toolSurfaces: DimensionScore
  /** No block spans a declared gap; no narrative papers over one. */
  gapHonesty: DimensionScore
  /** The recap's prose against the voice contract (DEV-292). Scores 1/1 when
   *  no recap was generated — an ungenerated recap is not a voice failure. */
  recapVoice: DimensionScore
  /** LLM judge: does the story match the day's real shape? 0–10. Absent in
   *  --fast runs. `score: null` means the judge call itself failed (transport
   *  or parse) — such a day is excluded from the mean, never scored 0. */
  shapeJudge?: Omit<DimensionScore, 'score'> & { score: number | null; reasoning: string }
  /** What the scorer actually looked at, for debugging. */
  observed: {
    blockLabels: string[]
    wrappedLead: string | null
    wrappedLines: string[]
    recap: string | null
    blockCount: number
    trackedSeconds: number
  }
}
