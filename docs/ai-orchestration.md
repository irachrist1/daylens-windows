# AI Orchestration

Status: code-audited refresh on 2026-04-23

This document describes the current desktop AI stack as implemented. It should be used to explain the architecture, not to claim provider/runtime validation that has not happened.

## Main-Process Ownership

AI provider calls are owned by the main process.

Code references:

- job definitions and routing: `src/main/services/aiOrchestration.ts:54-185`
- provider fallback, redaction, usage logging: `src/main/services/aiOrchestration.ts:245-474`
- chat orchestration and deterministic-first flow: `src/main/services/ai.ts:3715-3993`

The renderer does not call providers directly. It talks over IPC and receives streamed deltas back from the main process.

Code reference:

- renderer stream subscription: `src/renderer/views/Insights.tsx:957-965`

## Current Job Types

Defined AI jobs:

- `block_label_preview`
- `block_label_finalize`
- `block_cleanup_relabel`
- `day_summary`
- `week_review`
- `app_narrative`
- `chat_answer`
- `chat_followup_suggestions`
- `report_generation`
- `attribution_assist`

Code reference:

- `src/main/services/aiOrchestration.ts:54-152`

## Model Routing

Current routing is tiered per provider:

- economy: cheap/background jobs
- balanced: summaries and mid-cost foreground work
- quality: chat and harder reasoning

Important special case:

- `report_generation` is the only job currently hard-pinned to a stronger Anthropic override in code.

Code references:

- tier tables: `src/main/services/aiOrchestration.ts:162-185`
- report override: `src/main/services/aiOrchestration.ts:127-141`

## Deterministic-First Chat Flow

Chat does not immediately fall through to an LLM.

Current order:

1. create or adopt a durable thread
2. restore context and resolve follow-up reuse/reset
3. handle focus-session intent locally when applicable
4. handle direct requested-output/report cases
5. route deterministic questions first
6. fall back to a provider-backed freeform answer only when needed
7. persist the turn, follow-up suggestions, and thread state

Code reference:

- `src/main/services/ai.ts:3715-3993`

## Persistence

Desktop persistence in code today:

- threads in `ai_threads`
- messages in `ai_messages`
- artifacts in `ai_artifacts`
- conversation/routing state in `ai_conversation_state`
- usage events in `ai_usage_events`

Artifacts larger than 32 KB are written to `userData/artifacts/`; smaller ones can stay inline.

Code references:

- `src/main/services/artifacts.ts:24-170`
- `src/main/services/artifacts.ts:261-408`

## Privacy And Telemetry

Current protections in code:

- optional prompt redaction for file paths and emails before provider calls (`src/main/services/aiOrchestration.ts:308-319`)
- analytics property allowlists and sanitization prevent raw titles, paths, URLs, and prompt text from being sent in product telemetry (`src/shared/analytics.ts:88-269`)

## What Is Implemented Pending Verification

- provider-backed chat quality across all configured providers
- prompt-caching effectiveness at the provider layer
- report/export usefulness in real user workflows
- focus-session AI action usefulness in normal usage

The architecture is code-proven. The provider/runtime outcomes still need real validation.
