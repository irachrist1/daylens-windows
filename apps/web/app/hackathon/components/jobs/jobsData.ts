export type MemorySuggestion = {
  kind: string;
  body: string;
  action: string;
};

export type MemoryEntry = {
  time: string;
  title: string;
  sentence: string;
  /** Keys of APP_BRANDS in hero-demo/demoData. */
  apps: string[];
  suggestion?: MemorySuggestion;
};

export const MEMORY_ENTRIES: MemoryEntry[] = [
  {
    time: "9:20 AM",
    title: "Prepared the launch update",
    sentence:
      "You reviewed the launch plan in Notion, checked the implementation in Cursor, and pulled in Mara's feedback before updating the document.",
    apps: ["Notion", "Cursor", "Slack"],
    suggestion: {
      kind: "Suggested recap",
      body: "Turn this morning's launch work into a short status update for standup.",
      action: "Draft standup recap",
    },
  },
  {
    time: "9:10 AM",
    title: "Reviewed project feedback",
    sentence:
      "You compared comments on the project brief and followed up with the team.",
    apps: ["Dia", "Slack"],
  },
  {
    time: "9:00 AM",
    title: "Organized your work for the day",
    sentence:
      "You checked your task list, reviewed recent changes, and planned what to tackle next.",
    apps: ["Linear", "Notion"],
    suggestion: {
      kind: "Suggested automation",
      body: "Summarize what you worked on and prepare a short recap each weekday.",
      action: "Create daily recap automation",
    },
  },
];

export type JobScenario = {
  id: "resume" | "find" | "time";
  question: string;
  lead: string;
  steps: string[];
  answer: string;
  /** Present when the scenario offers the with/without comparison. */
  withoutAnswer: string | null;
};

export const JOB_SCENARIOS: Record<JobScenario["id"], JobScenario> = {
  resume: {
    id: "resume",
    question: "What was I working on before my last break?",
    lead: "I'll check your Daylens memory so I can pick up from where you stopped.",
    steps: [
      "Read today's timeline",
      "Found your last active block before 12:30 PM",
    ],
    answer:
      "You were revising the launch update in Notion, checking the implementation in Cursor, and reviewing Mara's feedback in Slack. You left off while updating the rollout timeline.",
    withoutAnswer:
      "I don't have context about what you were doing before the break. Tell me which project or app you were using and I can help you resume.",
  },
  find: {
    id: "find",
    question: "What was that planning document I was looking at today?",
    lead: "I'll use your timeline to identify the document from your recent activity.",
    steps: ["Searched today's documents and pages"],
    answer:
      "You were reviewing the Q4 launch plan in Docs this morning, from 10:12 to 10:48. I found the document and can help with the next step.",
    withoutAnswer: null,
  },
  time: {
    id: "time",
    question: "How much time did I spend on Acme last month?",
    lead: "I'll total your Acme sessions from the timeline.",
    steps: [
      "Counted Acme blocks across July",
      "Checked 14 days with Acme activity",
    ],
    answer:
      "31h 20m across 14 days — most of it in Notion and Cursor, with two review threads in Slack. Your heaviest day was July 16 at 4h 05m.",
    withoutAnswer:
      "I don't have access to your activity, so I can't total your time. If you track hours somewhere, tell me where and I can help you add them up.",
  },
};
