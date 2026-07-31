export type DemoAttachment = {
  title: string;
  kind: string;
};

export type DemoAsk = {
  q: string;
  a: string;
  evidence: string[];
  attachment?: DemoAttachment;
  aliases?: string[];
};

/** Matches Daylens activity color groups (Settings → Activity colors). */
export type DemoCategory =
  | "development"
  | "writing"
  | "email"
  | "productivity"
  | "design"
  | "meetings"
  | "communication"
  | "entertainment"
  | "social"
  | "browsing"
  | "research";

export const CATEGORY_COLORS: Record<DemoCategory, string> = {
  development: "#3b82f6",
  writing: "#ca8a04",
  email: "#ca8a04",
  productivity: "#ca8a04",
  design: "#ca8a04",
  meetings: "#8b5cf6",
  communication: "#8b5cf6",
  entertainment: "#ef4444",
  social: "#ef4444",
  browsing: "#64748b",
  research: "#64748b",
};

export type DemoBlock = {
  id: string;
  title: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  body: string;
  evidence: string[];
  apps: string[];
  category: DemoCategory;
  /** 0 = Mon … 6 = Sun within the demo week */
  dayIndex?: number;
};

export type DemoAppBrand = {
  src: string;
  invertInDark?: boolean;
};

export type DemoApp = {
  id: string;
  name: string;
  category: string;
  brandSrc: string;
  invertInDark?: boolean;
  durationLabel: string;
  sessionsLabel: string;
  narrative: string;
  sessions: Array<{ title: string; when: string }>;
};

export type DemoMonthEntry = {
  time: string;
  title: string;
  category: DemoCategory;
};

export type DemoMonthDay = {
  day: number;
  inMonth: boolean;
  isToday?: boolean;
  tracked?: string;
  more?: number;
  entries: DemoMonthEntry[];
};

export const DEMO_DAY_LABEL = "Wednesday, May 28";
export const DEMO_WEEK_LABEL = "May 26 – Jun 1";
export const DEMO_MONTH_LABEL = "May 2026";

export const DEMO_WEEK_DAYS = [
  { label: "Mon", date: 26 },
  { label: "Tue", date: 27 },
  { label: "Wed", date: 28 },
  { label: "Thu", date: 29 },
  { label: "Fri", date: 30 },
  { label: "Sat", date: 31 },
  { label: "Sun", date: 1 },
] as const;

/** Brand assets for inspector app chips. Missing names fall back to initials. */
export const APP_BRANDS: Record<string, DemoAppBrand> = {
  Cursor: { src: "/brands/vscode.ico" },
  Notion: { src: "/brands/notion.svg", invertInDark: true },
  Dia: { src: "/brands/dia.png" },
  Chrome: { src: "/brands/chrome.svg" },
  Slack: { src: "/brands/slack.png" },
  Figma: { src: "/brands/figma.svg" },
  Linear: { src: "/brands/linear.svg" },
  Claude: { src: "/brands/claude-app.png" },
};

export const DEMO_ASKS: DemoAsk[] = [
  {
    q: "What did I actually get done this week?",
    a: "Three threads carried the week. The Acme proposal took about six hours across Monday through Wednesday. The launch checklist in Notion stretched from Tuesday afternoon into Thursday. And you spent a solid block researching vendor pricing — mostly in Dia and Chrome. Wednesday morning on the proposal was your densest stretch.",
    evidence: ["6h Acme proposal", "Launch checklist", "Vendor research"],
    aliases: ["get done", "what did i do", "this week", "accomplish"],
  },
  {
    q: "What did I work on for Acme?",
    a: "About 4h 20m on Acme this week: the Q3 proposal draft in Notion and Docs, two review passes with Mara in Slack, and a 45-minute walkthrough deck in Figma on Thursday. Most of the deep work landed before lunch on Wednesday.",
    evidence: ["4h 20m total", "Notion · Docs · Figma", "Slack with Mara"],
    aliases: ["acme", "proposal", "q3"],
  },
  {
    q: "Where did Tuesday afternoon go?",
    a: "After lunch you were in a 40-minute sync, then roughly two hours deep on the launch checklist. From about 3:40 you drifted into email and LinkedIn for half an hour, then finished in Dia on competitor pages. The checklist was the real work; the last hour was lighter.",
    evidence: ["40m sync", "2h launch checklist", "Dia · email"],
    aliases: ["tuesday", "afternoon", "where did"],
  },
  {
    q: "What did I read before that meeting?",
    a: "In the hour before the 2pm sync you opened three things: the Acme brief in Notion, Mara's comment thread in Slack, and a pricing comparison tab in Dia you'd started on Monday. The brief held your attention longest.",
    evidence: ["Acme brief", "Slack thread", "Pricing tabs"],
    aliases: ["read before", "meeting", "before that"],
  },
  {
    q: "Draft my weekly update report from what I got done this week.",
    a: "You moved three things this week: the Acme Q3 proposal through two review rounds, the launch checklist nearly to done, and a vendor pricing recommendation into Notion. Wednesday carried most of the deep work. Full write-up is in the spreadsheet.",
    evidence: [],
    attachment: {
      title: "Weekly update — May 26.xlsx",
      kind: "Spreadsheet",
    },
    aliases: ["weekly update", "draft", "report", "excel", "spreadsheet"],
  },
];

/** Wednesday focus day (also dayIndex 2 in the week grid). */
export const DEMO_BLOCKS: DemoBlock[] = [
  {
    id: "standup",
    title: "Team sync",
    startHour: 9,
    startMinute: 0,
    endHour: 9,
    endMinute: 40,
    body: "Forty-minute standup and Acme status check. Mara flagged two open questions on pricing that you picked up later in Dia.",
    evidence: ["Zoom · 40m", "Slack prep notes"],
    apps: ["Slack"],
    category: "meetings",
    dayIndex: 2,
  },
  {
    id: "acme",
    title: "Acme Q3 proposal",
    startHour: 9,
    startMinute: 45,
    endHour: 12,
    endMinute: 30,
    body: "Deep stretch on the Q3 proposal in Notion and Docs — the densest block of the week. Two review passes with Mara's comments in Slack, then a structure pass before lunch.",
    evidence: ["Notion · Docs", "Slack with Mara", "2h 45m deep work"],
    apps: ["Cursor", "Notion", "Slack"],
    category: "development",
    dayIndex: 2,
  },
  {
    id: "lunch-drift",
    title: "Email and LinkedIn",
    startHour: 12,
    startMinute: 30,
    endHour: 13,
    endMinute: 25,
    body: "Lighter pass through inbox and LinkedIn after lunch before returning to the checklist.",
    evidence: ["Spark", "LinkedIn · 55m"],
    apps: ["Dia"],
    category: "social",
    dayIndex: 2,
  },
  {
    id: "launch",
    title: "Launch checklist",
    startHour: 13,
    startMinute: 30,
    endHour: 15,
    endMinute: 45,
    body: "Continued the launch checklist in Notion — moved several vendor-dependent items forward and left three blockers for Thursday.",
    evidence: ["Notion checklist", "2h 15m"],
    apps: ["Notion", "Linear"],
    category: "productivity",
    dayIndex: 2,
  },
  {
    id: "vendor",
    title: "Vendor pricing research",
    startHour: 16,
    startMinute: 0,
    endHour: 17,
    endMinute: 30,
    body: "Compared three pricing options in Dia and Chrome. Recommendation noted in Notion for Monday's review.",
    evidence: ["Dia · Chrome", "Pricing tabs", "1h 30m"],
    apps: ["Dia", "Chrome", "Notion"],
    category: "browsing",
    dayIndex: 2,
  },
];

/** Extra blocks for other days in the week view (Acme sample week). */
export const DEMO_WEEK_BLOCKS: DemoBlock[] = [
  ...DEMO_BLOCKS,
  {
    id: "mon-brief",
    title: "Acme brief outline",
    startHour: 10,
    startMinute: 0,
    endHour: 12,
    endMinute: 0,
    body: "Started the Q3 brief in Notion.",
    evidence: ["Notion"],
    apps: ["Notion"],
    category: "writing",
    dayIndex: 0,
  },
  {
    id: "mon-pricing",
    title: "Pricing tabs",
    startHour: 14,
    startMinute: 0,
    endHour: 15,
    endMinute: 30,
    body: "Opened vendor comparison tabs in Dia.",
    evidence: ["Dia"],
    apps: ["Dia"],
    category: "research",
    dayIndex: 0,
  },
  {
    id: "tue-sync",
    title: "Afternoon sync",
    startHour: 13,
    startMinute: 0,
    endHour: 13,
    endMinute: 40,
    body: "40-minute sync before the checklist.",
    evidence: ["Slack"],
    apps: ["Slack"],
    category: "meetings",
    dayIndex: 1,
  },
  {
    id: "tue-launch",
    title: "Launch checklist",
    startHour: 13,
    startMinute: 45,
    endHour: 15,
    endMinute: 45,
    body: "Deep stretch on the launch checklist.",
    evidence: ["Notion"],
    apps: ["Notion", "Linear"],
    category: "productivity",
    dayIndex: 1,
  },
  {
    id: "tue-drift",
    title: "Email and LinkedIn",
    startHour: 15,
    startMinute: 45,
    endHour: 16,
    endMinute: 15,
    body: "Lighter afternoon drift.",
    evidence: ["Dia"],
    apps: ["Dia"],
    category: "social",
    dayIndex: 1,
  },
  {
    id: "thu-deck",
    title: "Acme walkthrough deck",
    startHour: 14,
    startMinute: 0,
    endHour: 14,
    endMinute: 45,
    body: "Figma walkthrough for Thursday's sync.",
    evidence: ["Figma"],
    apps: ["Figma"],
    category: "design",
    dayIndex: 3,
  },
  {
    id: "thu-launch",
    title: "Launch checklist wrap",
    startHour: 10,
    startMinute: 0,
    endHour: 12,
    endMinute: 0,
    body: "Cleared remaining launch items.",
    evidence: ["Notion"],
    apps: ["Notion"],
    category: "productivity",
    dayIndex: 3,
  },
  {
    id: "fri-light",
    title: "Weekly notes",
    startHour: 9,
    startMinute: 30,
    endHour: 11,
    endMinute: 0,
    body: "Light Friday pass on notes and inbox.",
    evidence: ["Notion"],
    apps: ["Notion"],
    category: "writing",
    dayIndex: 4,
  },
  {
    id: "mon-standup",
    title: "Monday standup",
    startHour: 9,
    startMinute: 0,
    endHour: 9,
    endMinute: 35,
    body: "Week kickoff sync.",
    evidence: ["Slack"],
    apps: ["Slack"],
    category: "meetings",
    dayIndex: 0,
  },
  {
    id: "mon-cursor",
    title: "Proposal draft in Cursor",
    startHour: 12,
    startMinute: 15,
    endHour: 13,
    endMinute: 30,
    body: "Short Cursor pass on Acme sections.",
    evidence: ["Cursor"],
    apps: ["Cursor"],
    category: "development",
    dayIndex: 0,
  },
  {
    id: "mon-wrap",
    title: "Slack with Mara",
    startHour: 16,
    startMinute: 0,
    endHour: 16,
    endMinute: 45,
    body: "Async review thread on the brief.",
    evidence: ["Slack"],
    apps: ["Slack"],
    category: "communication",
    dayIndex: 0,
  },
  {
    id: "tue-morning",
    title: "Acme proposal pass",
    startHour: 9,
    startMinute: 15,
    endHour: 11,
    endMinute: 45,
    body: "Morning deep work on the Q3 draft.",
    evidence: ["Notion", "Cursor"],
    apps: ["Notion", "Cursor"],
    category: "development",
    dayIndex: 1,
  },
  {
    id: "tue-lunch",
    title: "Browsing competitor pages",
    startHour: 12,
    startMinute: 0,
    endHour: 12,
    endMinute: 40,
    body: "Quick Dia pass before the sync.",
    evidence: ["Dia"],
    apps: ["Dia"],
    category: "browsing",
    dayIndex: 1,
  },
  {
    id: "tue-evening",
    title: "Competitor pages",
    startHour: 16,
    startMinute: 20,
    endHour: 17,
    endMinute: 30,
    body: "Finished Tuesday in Dia on competitor tabs.",
    evidence: ["Dia"],
    apps: ["Dia"],
    category: "research",
    dayIndex: 1,
  },
  {
    id: "thu-morning",
    title: "Vendor follow-ups",
    startHour: 9,
    startMinute: 0,
    endHour: 9,
    endMinute: 50,
    body: "Email follow-ups on open vendor questions.",
    evidence: ["Dia"],
    apps: ["Dia"],
    category: "email",
    dayIndex: 3,
  },
  {
    id: "thu-sync",
    title: "Acme walkthrough sync",
    startHour: 15,
    startMinute: 0,
    endHour: 15,
    endMinute: 45,
    body: "Presented the Figma deck.",
    evidence: ["Slack", "Figma"],
    apps: ["Slack", "Figma"],
    category: "meetings",
    dayIndex: 3,
  },
  {
    id: "thu-evening",
    title: "Linear triage",
    startHour: 16,
    startMinute: 0,
    endHour: 17,
    endMinute: 15,
    body: "Cleared launch tickets after the sync.",
    evidence: ["Linear"],
    apps: ["Linear"],
    category: "productivity",
    dayIndex: 3,
  },
  {
    id: "fri-sync",
    title: "Friday check-in",
    startHour: 11,
    startMinute: 15,
    endHour: 11,
    endMinute: 50,
    body: "Short team check-in.",
    evidence: ["Slack"],
    apps: ["Slack"],
    category: "meetings",
    dayIndex: 4,
  },
  {
    id: "fri-ship",
    title: "Ship checklist leftovers",
    startHour: 13,
    startMinute: 0,
    endHour: 15,
    endMinute: 0,
    body: "Closed remaining launch items before the weekend.",
    evidence: ["Notion", "Linear"],
    apps: ["Notion", "Linear"],
    category: "productivity",
    dayIndex: 4,
  },
  {
    id: "fri-slack",
    title: "Wrap-up messages",
    startHour: 15,
    startMinute: 15,
    endHour: 16,
    endMinute: 0,
    body: "Sent status notes for Monday.",
    evidence: ["Slack"],
    apps: ["Slack"],
    category: "communication",
    dayIndex: 4,
  },
  {
    id: "sat-browse",
    title: "Light browsing",
    startHour: 10,
    startMinute: 0,
    endHour: 11,
    endMinute: 30,
    body: "Weekend skim — nothing deep.",
    evidence: ["Dia"],
    apps: ["Dia"],
    category: "browsing",
    dayIndex: 5,
  },
  {
    id: "sat-leisure",
    title: "YouTube and reading",
    startHour: 14,
    startMinute: 0,
    endHour: 16,
    endMinute: 0,
    body: "Leisure afternoon.",
    evidence: ["Dia"],
    apps: ["Dia"],
    category: "entertainment",
    dayIndex: 5,
  },
  {
    id: "sun-light",
    title: "Inbox skim",
    startHour: 11,
    startMinute: 0,
    endHour: 11,
    endMinute: 45,
    body: "Quick Sunday inbox pass.",
    evidence: ["Dia"],
    apps: ["Dia"],
    category: "email",
    dayIndex: 6,
  },
  {
    id: "sun-plan",
    title: "Next-week outline",
    startHour: 16,
    startMinute: 0,
    endHour: 17,
    endMinute: 0,
    body: "Sketched Monday priorities in Notion.",
    evidence: ["Notion"],
    apps: ["Notion"],
    category: "writing",
    dayIndex: 6,
  },
];

export const DEMO_APPS: DemoApp[] = [
  {
    id: "cursor",
    name: "Cursor",
    category: "Development",
    brandSrc: "/brands/vscode.ico",
    durationLabel: "2h 10m",
    sessionsLabel: "3 sessions",
    narrative:
      "Cursor carried the engineering side of the Acme stretch — drafting sections of the proposal with Agents open alongside Notion for the brief.",
    sessions: [
      { title: "Acme proposal draft", when: "9:50 AM – 11:40 AM" },
      { title: "Pricing notes pass", when: "4:40 PM – 5:00 PM" },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    category: "Productivity",
    brandSrc: "/brands/notion.svg",
    invertInDark: true,
    durationLabel: "3h 40m",
    sessionsLabel: "5 sessions",
    narrative:
      "Most of your Notion time sat on the Acme proposal and the launch checklist — planning under Ideas, then execution on the checklist through the afternoon.",
    sessions: [
      { title: "Acme Q3 proposal", when: "9:45 AM – 12:30 PM" },
      { title: "Launch checklist", when: "1:30 PM – 3:45 PM" },
      { title: "Vendor recommendation note", when: "5:10 PM – 5:25 PM" },
    ],
  },
  {
    id: "dia",
    name: "Dia",
    category: "Browsing",
    brandSrc: "/brands/dia.png",
    durationLabel: "1h 55m",
    sessionsLabel: "4 sessions",
    narrative:
      "Dia carried the vendor pricing comparison and a few competitor tabs after the checklist. Pricing held attention longest.",
    sessions: [
      { title: "Vendor pricing comparison", when: "4:00 PM – 5:20 PM" },
      { title: "Competitor pages", when: "3:50 PM – 4:00 PM" },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    category: "Communication",
    brandSrc: "/brands/slack.png",
    durationLabel: "1h 05m",
    sessionsLabel: "6 sessions",
    narrative:
      "Two review passes with Mara on the Acme proposal, plus standup prep. Comment threads were short but shaped the morning draft.",
    sessions: [
      { title: "Acme review with Mara", when: "10:40 AM – 11:05 AM" },
      { title: "Standup prep", when: "8:50 AM – 9:00 AM" },
    ],
  },
  {
    id: "figma",
    name: "Figma",
    category: "Design",
    brandSrc: "/brands/figma.svg",
    durationLabel: "45m",
    sessionsLabel: "1 session",
    narrative:
      "Thursday's walkthrough deck — stubbed in the demo memory so Acme asks still land even though today is Wednesday.",
    sessions: [{ title: "Acme walkthrough deck", when: "Thu 2:00 PM – 2:45 PM" }],
  },
];

/** May 2026 month grid: Mon-start, includes trailing Apr / leading Jun cells. */
export const DEMO_MONTH_DAYS: DemoMonthDay[] = [
  { day: 27, inMonth: false, entries: [] },
  { day: 28, inMonth: false, entries: [] },
  { day: 29, inMonth: false, entries: [] },
  { day: 30, inMonth: false, entries: [] },
  {
    day: 1,
    inMonth: true,
    tracked: "5h 20m",
    entries: [
      { time: "9:10 AM", title: "Planning week", category: "productivity" },
      { time: "2:00 PM", title: "Research pass", category: "research" },
    ],
  },
  {
    day: 2,
    inMonth: true,
    tracked: "6h 40m",
    entries: [
      { time: "9:00 AM", title: "Development", category: "development" },
      { time: "1:30 PM", title: "Docs review", category: "writing" },
    ],
  },
  {
    day: 3,
    inMonth: true,
    tracked: "4h 10m",
    entries: [{ time: "10:00 AM", title: "Team sync", category: "meetings" }],
  },
  // Remaining May days (4–31)
  ...Array.from({ length: 28 }, (_, i) => {
    const day = i + 4;
    const isFocusWeek = day >= 26 && day <= 31;
    if (!isFocusWeek) {
      const light: DemoMonthDay = {
        day,
        inMonth: true,
        tracked: day % 3 === 0 ? "3h 20m" : day % 2 === 0 ? "5h 10m" : "6h 45m",
        entries: [
          {
            time: "9:15 AM",
            title: day % 2 === 0 ? "Development" : "Writing",
            category: day % 2 === 0 ? "development" : "writing",
          },
          {
            time: "2:00 PM",
            title: day % 3 === 0 ? "Browsing" : "Meetings",
            category: day % 3 === 0 ? "browsing" : "meetings",
          },
        ],
        more: day % 4 === 0 ? 2 : undefined,
      };
      return light;
    }
    if (day === 26) {
      return {
        day,
        inMonth: true,
        tracked: "5h 30m",
        entries: [
          { time: "10:00 AM", title: "Acme brief", category: "writing" as const },
          { time: "2:00 PM", title: "Pricing tabs", category: "research" as const },
        ],
      };
    }
    if (day === 27) {
      return {
        day,
        inMonth: true,
        tracked: "4h 55m",
        entries: [
          { time: "1:00 PM", title: "Afternoon sync", category: "meetings" as const },
          { time: "1:45 PM", title: "Launch checklist", category: "productivity" as const },
        ],
      };
    }
    if (day === 28) {
      return {
        day,
        inMonth: true,
        isToday: true,
        tracked: "7h 50m",
        entries: [
          { time: "9:00 AM", title: "Team sync", category: "meetings" as const },
          { time: "9:45 AM", title: "Acme Q3 proposal", category: "development" as const },
          { time: "1:30 PM", title: "Launch checklist", category: "productivity" as const },
        ],
        more: 2,
      };
    }
    if (day === 29) {
      return {
        day,
        inMonth: true,
        tracked: "4h 45m",
        entries: [
          { time: "10:00 AM", title: "Launch wrap", category: "productivity" as const },
          { time: "2:00 PM", title: "Walkthrough deck", category: "design" as const },
        ],
      };
    }
    if (day === 30) {
      return {
        day,
        inMonth: true,
        tracked: "2h 10m",
        entries: [
          { time: "9:30 AM", title: "Weekly notes", category: "writing" as const },
        ],
      };
    }
    return {
      day,
      inMonth: true,
      tracked: "1h 40m",
      entries: [
        { time: "11:00 AM", title: "Inbox catch-up", category: "email" as const },
      ],
    };
  }),
];

export function blockDurationMinutes(block: DemoBlock): number {
  return (
    block.endHour * 60 +
    block.endMinute -
    (block.startHour * 60 + block.startMinute)
  );
}

export function formatClock(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute.toString().padStart(2, "0")} ${period}`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

export function matchDemoAsk(input: string): DemoAsk | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;

  const exact = DEMO_ASKS.find((ask) => ask.q.toLowerCase() === normalized);
  if (exact) return exact;

  let best: { ask: DemoAsk; score: number } | null = null;
  for (const ask of DEMO_ASKS) {
    let score = 0;
    if (normalized.includes(ask.q.toLowerCase().slice(0, 24))) score += 5;
    for (const alias of ask.aliases ?? []) {
      if (normalized.includes(alias.toLowerCase())) score += 2;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { ask, score };
    }
  }
  return best && best.score >= 2 ? best.ask : null;
}

export function blockAccentStyle(category: DemoCategory, selected = false): {
  backgroundColor: string;
  borderColor: string;
} {
  const hex = CATEGORY_COLORS[category];
  return {
    backgroundColor: selected ? `${hex}2e` : `${hex}18`,
    borderColor: selected ? `${hex}88` : `${hex}40`,
  };
}

export function replyToFreeform(input: string): string {
  const text = input.trim();
  const lower = text.toLowerCase();

  if (/^(hi|hello|hey|yo|sup|good (morning|afternoon|evening))\b/.test(lower)) {
    const greeting = lower.startsWith("good")
      ? text.split(/\s+/).slice(0, 2).join(" ")
      : text.split(/\s+/)[0] ?? "Hey";
    return `${greeting.charAt(0).toUpperCase()}${greeting.slice(1)}! You've got me — this is a demo, not the real Daylens brain. Try one of the sample questions and I'll show you how answers look.`;
  }

  if (/^(thanks|thank you|thx|ty)\b/.test(lower)) {
    return "You're welcome! Still just a demo though — pick a starter if you want a real-looking answer.";
  }

  if (/^(how are you|how's it going|whats up|what's up)\b/.test(lower)) {
    return "Doing great for a scripted landing-page fake. You've got me — I'm not wired to your laptop. Hit a starter ask and I'll play along.";
  }

  return "You've got me! This is a demo, not real Daylens — I only know the sample week on this page. Try one of the starter questions (or a thread on the left) and I'll answer from that memory.";
}
