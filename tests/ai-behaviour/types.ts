export type ScenarioRubric = Record<string, boolean | string>

export interface ScenarioRecord {
  id: string
  question: string
  family: string
  // What a colleague who had been watching the user work this week would say
  // when asked the same question, in 2-4 sentences. The judge grades the AI
  // primarily against this shape — does the answer reveal understanding, not
  // just data accuracy. Rubric flags remain as secondary signal.
  gold_answer_shape?: string
  // Optional scripted reply for any askUser card the turn raises (clarifying
  // question, correction/memory confirmation). Without it the agent gets the
  // production no-answer default, which the confirm flows treat as silence —
  // fine for proposal-shaped scenarios, unanswerable for ones that need a
  // confirmed apply.
  ask_user_answer?: string
  rubric: ScenarioRubric
}
