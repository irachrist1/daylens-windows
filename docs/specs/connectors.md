# Connectors

Status: removed from the product 2026-07-26 — the OAuth connector framework was dropped (too much setup for target users); calendar/git enrichment remains via externalSignals.

**Status:** Ready for review.

This specification defines how Daylens connects external sources to personal memory. Connectors add facts that desktop observation cannot reliably infer while preserving explicit consent, narrow read-only permissions, provenance, and deletion.

## Product behavior

Connections are managed in Settings. The AI agent may also suggest a specific connection when it can explain why that source would materially improve the current answer.

The first connector order is:

1. Google Calendar and Outlook Calendar
2. GitHub, Linear, and Granola
3. Slack, Microsoft Teams, Gmail, and Outlook email
4. Documents, customer systems, and other long-tail tools based on demonstrated demand

Every V2 connector is read-only.

## Direct and long-tail integrations

Daylens builds direct adapters for sources that form canonical memory:

- Google Calendar
- Microsoft Outlook Calendar through Graph
- GitHub
- Linear
- Granola where its MCP or API access supports the person’s account

Slack, Teams, Gmail, Outlook email, and later optional sources may begin through direct APIs or a wrapped integration platform after the connector contract is proven.

Composio may accelerate long-tail coverage, but it remains behind a Daylens-owned adapter. Daylens pins toolkit versions, maps vendor records into its own contract, and prevents vendor-specific authentication or tool shapes from becoming product facts.

## Connector contract

Each adapter implements:

```ts
interface ConnectorAdapter<TCursor, TRecord> {
  manifest: ConnectorManifest
  beginAuthorization(input: AuthorizationRequest): Promise<AuthorizationSession>
  completeAuthorization(input: AuthorizationCallback): Promise<Connection>
  inspectConnection(connection: Connection): Promise<ConnectionHealth>
  sync(input: SyncRequest<TCursor>): Promise<SyncPage<TCursor, TRecord>>
  normalize(record: TRecord, connection: Connection): EvidenceEnvelope
  disconnect(connection: Connection): Promise<void>
}
```

The manifest defines provider identity, display name, source kinds, exact scopes, sensitivity, supported account types, cursor behavior, rate-limit policy, and whether the adapter is direct or brokered.

The adapter cannot expose write operations in V2.

## Authorization

- Authorization begins from a named connector and lists the exact requested scopes.
- Daylens explains what information the connection adds before opening OAuth or another provider flow.
- Credentials and refresh tokens are stored in the operating-system secure store or an approved encrypted server store when server-side refresh is unavoidable.
- Tokens never enter SQLite, logs, analytics, model context, export, MCP, or sync payloads.
- A brokered connector clearly identifies the intermediary before authorization.
- Reauthorization never broadens scopes silently.
- A person can disconnect without contacting support.

The agent may request a connection only after identifying a concrete gap, such as “Connecting Google Calendar would let me identify the meetings in this period.” It cannot request every available source at once.

## Synchronization

- Initial sync uses a bounded lookback appropriate to the source and shows progress.
- Incremental sync uses provider cursor, change token, or source record identity.
- A database transaction stores normalized evidence and advances the cursor together.
- A failed page does not advance the cursor.
- Duplicate source records are idempotent.
- Provider deletions create local source tombstones and remove unsupported derivatives.
- Rate limits use bounded backoff and respect provider reset information.
- Sync can be paused, retried, or disabled per connector.
- Connector failure never stops local capture.

Every normalized record retains provider, account, workspace, source record identifier, retrieved time, effective time, sensitivity, and permission scope.

## Source behavior

### Google Calendar and Outlook Calendar

Calendar evidence includes event identity, title, scheduled range, attendees, organizer, recurrence, response state, meeting link, and permitted description fields.

A calendar event is scheduled context. It becomes evidence that a meeting occurred only when device activity, call presence, Granola, transcript, or explicit confirmation supports that interpretation.

### GitHub

GitHub evidence includes repositories, commits, pull requests, reviews, issues, and permitted timestamps and relationships. A commit supports work and completion claims only for what the commit actually records.

### Linear

Linear evidence includes workspaces, teams, projects, cycles, issues, status changes, comments or descriptions only when the accepted scope permits them, and source relationships.

### Granola

Granola evidence includes meeting identity, participants, notes, summaries, and transcripts when the account and permission permit them. Daylens stores references and minimized permitted content; it does not record meeting audio.

### Communication sources

Slack, Teams, Gmail, and Outlook email begin with metadata and retrieval needed for explicitly requested memory. Message bodies are high-sensitivity evidence and require a clearly accepted scope before ingestion or model use.

## Entity resolution

Connector records propose relationships to Daylens people, meetings, projects, clients, repositories, pages, and documents.

- Source-native identity outranks display-name similarity.
- Cross-source matches use corroborating addresses, event links, repository URLs, workspace identity, and timing.
- Low-confidence matches remain suggestions.
- Explicit merge, split, rename, and relationship corrections are durable and reversible.
- Disconnecting a source removes unsupported aliases and relationships without deleting independent local evidence.

## Settings experience

Each connector shows:

- connected account and workspace
- direct or brokered integration
- granted scopes
- last successful sync
- current health and next retry
- records or date range available at a useful aggregate level
- pause, resync, reauthorize, and disconnect actions

The interface does not display raw tokens, internal cursors, or provider errors that reveal secrets.

## Privacy and model access

- Connectors start with the narrowest read-only scopes.
- Source exclusions and deletion apply before search, embeddings, AI, MCP, sync, and exports.
- The AI agent retrieves connector content only for the current question.
- Model-context inspection names the connector and exact permitted excerpts used.
- Connected content does not become raw desktop sync data.
- Broker analytics receive connection health, not provider record content.
- High-sensitivity message, transcript, and document content follows the privacy specification.

## Disconnection and deletion

Disconnecting:

1. Stops new sync.
2. Revokes or deletes stored credentials where supported.
3. Offers a clear choice to retain or delete already imported local evidence.
4. Removes cloud-side broker connections when applicable.

Choosing deletion removes source evidence, full-text and semantic indexes, unsupported entities and relationships, generated summaries, model traces, synced copies, and cached attachments. Independent corrections or supplied memories remain only when their own provenance still supports them.

## Failure behavior

- Expired authorization marks the connector as needing attention without deleting valid memory.
- Scope loss stops affected fields and explains the narrower result.
- Provider outage retains the last successful data with its retrieval time.
- Rate limiting schedules a retry without blocking the interface.
- Malformed source records are quarantined by opaque source identity and never partially normalized.
- A provider schema change fails validation instead of silently changing meaning.
- A broker outage affects only brokered connectors.
- Connector deletion or account loss cannot erase unrelated local evidence.

## Acceptance criteria

- Each priority connector has a documented manifest and exact read-only scopes.
- Authorization, refresh, revoke, cursor, rate-limit, deletion, and schema-change paths have tests.
- Normalized records satisfy the shared evidence contract and remain idempotent.
- Calendar events do not become attended meetings without supporting evidence.
- Connector-derived totals and relationships reconcile with local facts.
- The agent requests a connection only for a specific answer gap.
- Tokens and source content never appear in logs, analytics, exports, or unrelated model context.
- Disconnect and delete remove every owned derivative and synced copy.
- Direct and brokered adapters pass the same contract suite.
- Real sandbox or test accounts verify behavior before release.

## Implementation starting point

The first ticket should implement the connector manifest, connection, cursor, and normalization interfaces with a fake provider. Google Calendar should be the first real adapter after the contract suite passes.
