# AI Prompt Contract

This document captures the prompt and payload contract the Windows app must match if it wants Anthropic responses to behave like the current Swift app.

## Anthropic request envelope

Current Swift client behavior in `AIService.swift`:

- Endpoint: `POST https://api.anthropic.com/v1/messages`
- Headers:
  - `Content-Type: application/json`
  - `x-api-key: <key>`
  - `anthropic-version: 2023-06-01`
- Body shape:

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "system": "<system prompt>",
  "messages": [
    {
      "role": "user",
      "content": "<user prompt>"
    }
  ]
}
```

The Windows app should keep the same request shape unless both clients are updated together.

## `AIDayContextPayload` JSON shape

`AIDayContextPayload` is an in-memory Swift struct today, but this is the contract it represents when serialized:

```json
{
  "date": "2026-03-26T00:00:00+02:00",
  "appSummaries": [
    {
      "bundleID": "com.apple.dt.Xcode",
      "appName": "Xcode",
      "totalDuration": 14400,
      "sessionCount": 7,
      "category": "Development",
      "isBrowser": false
    }
  ],
  "websiteSummaries": [
    {
      "domain": "github.com",
      "totalDuration": 4200,
      "visitCount": 12,
      "topPageTitle": "Pull requests · irachrist1/daylens",
      "confidence": "high",
      "browserName": "Chrome"
    }
  ],
  "browserSummaries": [
    {
      "browserBundleID": "com.google.Chrome",
      "browserName": "Chrome",
      "totalDuration": 5400,
      "sessionCount": 9,
      "topDomains": ["github.com", "chatgpt.com", "linear.app"]
    }
  ],
  "dailySummary": {
    "id": 29,
    "date": "2026-03-26T00:00:00+02:00",
    "totalActiveTime": 28800,
    "totalIdleTime": 0,
    "appCount": 11,
    "browserCount": 2,
    "domainCount": 17,
    "sessionCount": 32,
    "contextSwitches": 31,
    "focusScore": 0.67,
    "longestFocusStreak": 5400,
    "topAppBundleID": "com.apple.dt.Xcode",
    "topDomain": "github.com",
    "aiSummary": null,
    "aiSummaryGeneratedAt": null
  }
}
```

Nested model contracts:

- `appSummaries` uses the `AppUsageSummary` contract from `DATA_SCHEMAS.md`
- `websiteSummaries` uses the `WebsiteUsageSummary` contract from `DATA_SCHEMAS.md`
- `dailySummary` uses the `DailySummary` contract from `DATA_SCHEMAS.md`
- `browserSummaries` uses this shape:

| Field | Type | Notes |
|------|------|-------|
| `browserBundleID` | string | Stable browser identifier |
| `browserName` | string | Friendly browser name |
| `totalDuration` | number | Seconds |
| `sessionCount` | integer | Number of browser sessions |
| `topDomains` | array of string | Top associated domains |

## Default system prompt

This prompt is used by default for:

- `askQuestion(_:context:)`
- `generateBlockLabel(prompt:)`
- report enhancement in `ReportsViewModel` because it calls `askQuestion(prompt, context: "")`

Exact text:

```text
You are Daylens, a personal activity analyst for macOS. You analyze the user's computer usage data and provide helpful, grounded insights.

Rules:
- Only reference data that is explicitly provided in the context
- Never invent or hallucinate usage data
- If you don't have enough data to answer a question, say so clearly
- Be concise and helpful — write like a thoughtful personal analyst, not a chatbot
- Use specific numbers (durations, counts) when available
- When describing patterns, cite the evidence
- Format durations as "Xh Ym" (e.g., "2h 15m")
- Be honest about data confidence levels when mentioned
- Prefer supported category-level patterns (Development, AI Tools, Writing, Productivity) over repeating raw app names
- Treat semantic labels as deterministic app-purpose hints, not proof of the exact task the user performed
- Never turn estimated browser timing into exact unsupported claims
- When website timing is estimated, use wording like "about", "roughly", or "estimated"
- You may compare across days only when those comparison days are explicitly present in the context
- Browser time on focused domains (AI tools, development sites, research, writing tools) counts as productive focused work — treat it accordingly
- Apps or sites marked "user override" have been explicitly categorized by the user and should be treated as authoritative
- When the user asks what information would help you, tell them: app category overrides for uncategorized apps, their goals for the day, and what specific apps like terminals or custom tools mean in their workflow
```

## `systemPrompt(profile:memories:)`

### Fallback when no profile exists

```text
You are a productivity analyst. Analyze the user's activity data below.
```

### Dynamic template when a profile exists

Template:

```text
You are a personal productivity analyst for {name}.
They are a {role} whose primary goal is {goals}.
Their typical workday is {workHoursStart}:00-{workHoursEnd}:00.
Their ideal workday: {idealDayDescription}
{optional biggest distraction line}

Things you remember about them:
{memoriesSection}

You have access to their precise activity data below. Be specific, reference actual
apps and durations. Never be generic. If you don't have enough data, say so.
```

Rules used by the Swift implementation:

- `{optional biggest distraction line}` is included only when `biggestDistraction` is non-empty:

```text
Their biggest distraction is {biggestDistraction}.
```

- `{memoriesSection}` is either:

```text
Nothing remembered yet.
```

or one `- {fact}` bullet per `UserMemory.fact`, joined with newlines.

## `blockLabelPrompt(...)`

Exact template:

```text
Write a 3-7 word title-case label for this work block.
Return only the label. No quotes. No explanation.
Category: {dominantCategory}
Duration: {durationMinutes} minutes
Apps: {comma-separated app names or None}
Domains: {comma-separated domains or None}
Window titles: {comma-separated titles or None}
```

Details:

- `{dominantCategory}` uses the `AppCategory` raw string, for example `Development` or `AI Tools`.
- The app/domain/title lists are trimmed, empty entries are removed, and each list is capped at 5 items.
- If a list is empty, the Swift code sends `None`.
- This prompt is sent with the default system prompt above.

## Memory extraction prompt

Called by `AIService.extractMemory(from:answer:)`.

### System prompt

```text
You extract durable, factual user memory from productivity conversations.
```

### User prompt

```text
Based on this exchange, extract ONE factual sentence about the user's work context,
goals, or habits that would be useful to remember. If nothing is worth remembering,
reply exactly: NONE.
Question: {question}
Answer: {answer}
```

The Windows app should preserve the exact `NONE` sentinel.

## Daily report enhancement prompt

There are two layers here.

### Raw report-improvement question created in `ReportsViewModel`

```text
Improve this daily activity report. Add 2–3 specific observations and one actionable suggestion. Keep it under 300 words. Return only Markdown.

{report.markdownContent}
```

### Effective Anthropic user prompt actually sent today

Because Swift currently calls `aiService.askQuestion(prompt, context: "")`, the raw question is wrapped by `AIPromptBuilder.questionPrompt(question:activityContext:)` with an empty context:

```text
The user is asking about their activity. Answer based on the data below. If the data doesn't contain enough information to answer, say so. When supported by the evidence, synthesize across categories before listing apps.



User question: Improve this daily activity report. Add 2–3 specific observations and one actionable suggestion. Keep it under 300 words. Return only Markdown.

{report.markdownContent}
```

System prompt used for this call:

- `AIPromptBuilder.defaultSystemPrompt`

## Context-builder contract

When the Windows app builds the main activity context string, it should preserve the same section order and style currently produced by `AIPromptBuilder.buildContext(...)`:

1. `## Activity Data for {full date}`
2. `### Data Notes`
3. `### Overview` when `dailySummary` exists
4. `### Category Breakdown`
5. `### Top Apps`
6. `### Focused Browser Time` when applicable
7. `### Top Sites (grouped)` when applicable
8. `### Top Websites (detail)`
9. `### Browsers Used`
10. `### Recent Day Comparisons` when previous payloads are supplied

That string is the grounding context used for daily summaries and Q&A, so keeping it aligned matters almost as much as keeping the system prompts aligned.
