# Product direction

## The promise

> **Remember everything you did.**

Daylens turns everything you do on your computer into a private, organized memory of your work—and gives you an agent that understands that memory.

## Why I am building it

Daily work is scattered across apps, websites, meetings, clients, and projects. You cannot reliably retrieve information such as how much time you spent on a project, remember what you did at the end of a month, recall which meetings you had during a week, find information you know you saw, or simply explain where your time went.

Right now, your own memory is the only thing connecting all of this. You have to reconstruct your days from browser histories, calendars, messages, documents, and disconnected applications.

AI does not automatically fix this. You either explain the same context yourself, paste information from several applications, or install another narrow tool that remembers only one part of your work. Daylens creates the missing memory automatically.

## What Daylens makes possible

Daylens gives someone one place to understand their time, retrieve information, and ask questions about work that would otherwise be scattered across several applications.

- “How much time did I spend on Project X last month?”
- “What did I work on last week besides meetings?”
- “Which meetings did I have with Client X in June?”
- “Remind me which page had the best discount when I was researching that TV upgrade last week.”
- “Where did my time go this month?”
- “How much time did I spend on social media this week, and how much of that time was spent listening to podcasts or watching movie clips?”

The answer should not depend on someone remembering which application contained the evidence or explaining the same background to an AI again.

## The product surfaces

### Timeline

Timeline turns everything Daylens knows about a day into a calendar-like account of what actually happened. It brings applications, websites, meetings, files, projects, and clients into one chronology instead of leaving them scattered across separate histories.

It shows what you did, when you did it, how long it took, and what that activity was connected to. Each block can still be opened, understood, and corrected.

### Apps

Apps explains what you did inside each application, not merely how long the application was open. It connects application time with pages, files, meetings, projects, clients, and repeated activity.

Apps and Timeline are different views of the same facts. Their totals and explanations must reconcile.

### AI agent

The AI agent is the conversational interface to Daylens memory. It retrieves information and answers questions about days, periods, applications, meetings, projects, and clients using evidence Daylens can show.

The agent should feel as if it already understands the work you are asking about. You should not have to explain the project, list every application involved, or paste the same background into a new conversation.

It starts with the memory Daylens has already organized and can connect to tools such as GitHub, Linear, Granola, calendars, and other sources when they provide useful evidence. This allows it to answer with more than raw app totals. “You spent two hours in Chrome” is not enough when Daylens can explain which project, meeting, page, or client that time belonged to.

The agent is part of the entire product, not a chatbot added beside the tracker. Its answers must agree with Timeline and Apps because all three surfaces use the same memory.

## How Daylens should sound

Daylens should sound like a person who understands what happened, not like a system reading telemetry back to you.

It should interpret applications, pages, meetings, files, and connected sources into direct, useful language. When the evidence supports it, Daylens names the subject, project, client, people, and outcome. The evidence remains underneath the answer, but it should not make the product sound like Apple Screen Time.

| What Daylens understands                                                              | How Daylens should say it                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An editor, repository, files, and related development activity were active for 2h 14m | “You were actively developing the Daylens Wrapped feature for 2h 14m.”                                                                                                   |
| An article by Sean Goedecke was active in the browser for 12 minutes                  | “You read Sean Goedecke’s article for 12 minutes. It was about how prompts are technical debt, too.”                                                                     |
| Calendar, meeting, and surrounding activity support a 30-minute review                | “You spent 30 minutes reviewing ACME’s FY2026–2027 financial report with Norman and the team.”                                                                           |
| GitHub, Linear, the browser, and the editor all relate to the same project            | “You spent 3h 20m on Project X across planning, implementation, and review. Solid session there. It may be worth picking up again this week while the context is fresh.” |

Daylens may add a short observation when it is genuinely useful. It should feel observant, not chatty for its own sake, and it should never turn incomplete evidence into a judgment about focus or productivity.

Daylens should be confident when the evidence supports a useful interpretation. If the evidence is genuinely incomplete or conflicting, it should explain the uncertainty in one natural sentence instead of falling back to raw telemetry.

## What keeps the answers reliable

### Evidence underneath the interpretation

Observed and connected evidence is the factual foundation. Models interpret and summarize it into human language, but recorded time, identities, URLs, files, meetings, and events still come from evidence Daylens can retrieve.

### Corrections are authoritative

Renames, merges, exclusions, attribution changes, and memory corrections are durable product data. They survive rebuilds and outrank automated interpretation.

### Private by default

Capture is local-first and metadata-first. A person controls what is captured, retained, sent to a model, synced, and shared.

### Useful without AI

Timeline, Apps, search, corrections, and privacy controls must remain useful without a model provider.

### One memory across every surface

Timeline, Apps, AI, search, MCP, sync, and the web companion must use the same facts. A correction made in one place must change every relevant surface.

## Who Daylens starts with

Daylens starts with individuals who want to track their time automatically and understand what they did without reconstructing it from memory. The individual product is the foundation for later organizational and enterprise products.

Managed AI access is paid because its answers use paid model APIs. Core capture, Timeline, Apps, corrections, and non-AI memory remain useful without a managed subscription. Bring-your-own-key remains available so provider cost never determines whether someone can use the agent with their own stored memory.

## Product boundaries

Daylens reports an honest deep-work percentage (focus score) from measured session length, and can send a distraction alert when configured leisure interrupts inferred work. Those are measured facts, not a verdict about personal worth. Narrative surfaces still must not turn incomplete observation into a scolding about focus or productivity. See [Focus score and distraction alerts](../specs/focus-and-distraction.md).

Daylens is not organizational surveillance. Any organizational value must be built from information a person has reviewed and deliberately chosen to share.

Daylens does not claim to capture an entire human day. Off-device activity, disconnected services, private stores, and capture gaps remain unknown unless a person supplies or connects evidence.

The agent is not a decorative chat surface over app totals. It is the interface through which Daylens memory becomes useful for retrieval, explanation, and reasoning.
