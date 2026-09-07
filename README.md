# Daylens

> **Remember everything you did.**

Daylens turns everything you do on your computer into a private, organized memory of your work—and gives you an agent that understands that memory.

Daily work is scattered across apps, websites, meetings, clients, and projects. You cannot reliably retrieve information such as how much time you spent on a project, remember what you did at the end of a month, recall which meetings you had during a week, find information you know you saw, or simply explain where your time went.

Right now, your own memory is the only thing connecting all of this. You either reconstruct the day yourself, install another narrow app that remembers only your meetings, or explain the same context to an AI before it can be useful. Daylens creates that missing memory automatically.

## What Daylens is

- **Timeline** turns everything Daylens understands about a day into a calendar-like account of what actually happened.
- **Apps** explains what you did inside each application and how that activity connected to pages, files, meetings, projects, and clients.
- **AI agent** answers questions using the same evidence and memory as the rest of Daylens. It can also connect to tools such as GitHub, Linear, and Granola, giving it enough context to go beyond answers like “you spent two hours in Chrome” or “you spent two hours in Cursor.”

With Daylens, you can finally get answers to questions such as:

- “How much time did I spend on Project X last month?”
- “What did I work on last week besides meetings?”
- “Which meetings did I have with Client X in June?”
- “Remind me which page had the best discount when I was researching that TV upgrade last week.”
- “Where did my time go this month?”
- “How much time did I spend on social media this week, and how much of that time was spent listening to podcasts or watching movie clips?”

Daylens is more than a time tracker. Time is one part of the memory it builds. The larger goal is to make your work understandable and retrievable to both you and the agents working with you.

Daylens should speak as if it understands what happened. It should say that you developed a feature, read a specific article, or reviewed a report with a client—not lead with the applications and telemetry used to reach that conclusion. Supporting evidence remains available, and uncertainty is stated naturally when the record is incomplete.

## Project status

Daylens is a working cross-platform desktop application undergoing an incremental V2 transition. V2 is the biggest update yet. Existing data remains intact while the core product becomes more accurate, useful, and coherent.

## Documentation

| Document                                            | Purpose                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| [V2 plan](docs/V2-PLAN.md)                          | **Read first.** What V2 is, measured by the journal eval, the five blockers, and what is out of scope |
| [Activity understanding](docs/north-star/activity-understanding.md) | The model: attention is the budget, browser history explains and never adds, entities above strings |
| [The context agent](docs/north-star/context-agent.md) | How day analysis becomes an agent turn over tiered tools, with deterministic heuristics as the floor |
| [Product direction](docs/product/product.md)        | The product promise, problem, principles, and boundaries                    |
| [Positioning](docs/product/positioning.md)          | What we claim, the public-site promise and voice, and what to build next    |
| [Vocabulary](docs/product/vocabulary.md)            | Shared meanings for product and architecture terms                          |
| [Architecture](docs/codebase/architecture.md)       | Codebase map, invariants, and recorded decisions — start here               |
| [Repository structure](docs/codebase/structure.md)  | Where the major parts of the codebase live                                  |
| [Web companion](docs/codebase/web.md)               | What the web application implements and what remains                        |
| [Development](docs/development.md)                  | How specifications, implementation, and acceptance work                     |
| [Testing](docs/hygiene/testing.md)                  | Normal verification and release confidence                                  |
| [Install](docs/operations/install.md)               | How the app is installed and updated                                        |
| [macOS signing](docs/operations/macos-signing.md)   | Developer ID signing and notarization                                       |
| [Windows signing](docs/operations/windows-signing.md) | Authenticode signing                                                      |
| [Billing operations](docs/operations/billing.md)    | Managed AI billing architecture and deployment runbook                      |

Behaviour specifications live in [docs/specs/](docs/specs/) — one per surface. They define
what the product does; the V2 plan decides what ships.

Contributors should also read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md).

### V2 specifications

| Specification                                                            | Purpose                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [Capture and evidence](docs/specs/capture-and-evidence.md)               | Canonical capture, browser privacy, evidence, corrections, and migration        |
| [Onboarding and consent](docs/specs/onboarding-and-consent.md)           | First run, capture consent, platform permissions, and the proof step            |
| [Screen context](docs/specs/screen-context.md)                           | Opt-in sampled-frame experiment, extraction, deletion, and evaluation           |
| [Memory and entities](docs/specs/memory-and-entities.md)                 | Search, memory types, entity identity, relationships, and conversational memory |
| [Timeline](docs/specs/timeline.md)                                       | Calendar-like day reconstruction, attention accounting, labels, and corrections |
| [Calendar events and tracked blocks](docs/specs/calendar-and-blocks.md)  | How scheduled events and observed blocks relate: attendance, overlap, and recap wording |
| [Day recap and analysis](docs/specs/day-recap-and-analysis.md)           | The grounded day account: gaps, threads, freshness, and clarification           |
| [Label voice](docs/specs/label-voice.md)                                 | The recorded, evaluatable rubric block labels are scored against                |
| [Apps](docs/specs/apps.md)                                               | Day, week, and month application explanations and canonical totals              |
| [AI agent](docs/specs/ai-agent.md)                                       | Voice, retrieval tools, sources, model choice, and Daylens actions              |
| [Agent benchmark](docs/specs/agent-benchmark.md)                         | How every AI surface behaves, sounds, and is graded: queries, judges, hard caps |
| [Wrapped](docs/specs/wrapped.md)                                         | Day, week, month, and year recaps on shared facts, voice, and evidence          |
| [Briefs](docs/specs/briefs.md)                                           | Morning, evening, and weekly notifications from the same facts and voice        |
| [Focus score and distraction alerts](docs/specs/focus-and-distraction.md)| Honest deep-work percentage, distraction alerts, and the wrap/MCP profile       |
| [Agent runtime and context](docs/specs/agent-runtime-and-context.md)     | Context assembly, file disclosure, scoped tools, and provider runtimes          |
| Connectors _(removed 2026-07-26)_             | History only — the OAuth connector framework was dropped from the product        |
| [Privacy, retention, and sync](docs/specs/privacy-retention-and-sync.md) | Local retention, export, model context, encryption, sync, and deletion          |
| [Billing and entitlements](docs/specs/billing-and-entitlements.md)       | Free local access, trials, managed usage, subscriptions, and billing failures   |
| Web companion                             | Post-desktop remote recall, encrypted search, and cross-device AI threads       |
| Organizational sharing             | Deferred: reviewed project and client summaries without personal monitoring     |

## Run from source

Install Node.js 20 or newer and the native build tools for your platform, then run:

```bash
npm install
npm start
```

Normal verification:

```bash
npm run typecheck
npm test
npm run contract:check
```

Some AI evaluations call paid providers. Read Benchmarks before running them.

Run the web companion with:

```bash
npm run web:dev
```

Platform prerequisites and packaging notes are in [Installation and releases](docs/operations/install.md).

## Install a release

On Apple Silicon macOS:

```bash
brew tap irachrist1/daylens
brew install --cask daylens
```

Installers for macOS, Windows, and Linux are available from [GitHub Releases](https://github.com/irachrist1/daylens/releases/latest).

## Privacy

Daylens is local-first and metadata-first. Activity remains in the local SQLite database unless you explicitly use a feature that sends selected context to a configured model, enable sync, or choose to share information. Incognito activity, exclusions, pauses, retention, model access, and sharing are product boundaries that must remain visible and testable.

Daylens is released under the MIT License.
