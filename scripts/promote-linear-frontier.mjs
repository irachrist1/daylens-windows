#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
const LINEAR_REQUEST_TIMEOUT_MS = 15_000
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled'])
const SPECIFICATION_LINE_PATTERN = /^\*\*Specification\*\*[^\n]*$/gm
const SPECIFICATION_PATH_PATTERN = /`(docs\/specs\/[^`\n]+\.md|docs\/product\/v2\.md)`/g
const ACCEPTED_STATUS_PATTERNS = new Map([
  ['docs/specs', /^\*\*Status:\*\*\s*Accepted\.\s*$/m],
  ['docs/product/v2.md', /^\*\*Status:\*\*\s*Accepted product direction\./m],
])

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function specificationPaths(description = '') {
  const lines = String(description ?? '').match(SPECIFICATION_LINE_PATTERN) ?? []
  return lines.flatMap((line) =>
    [...line.matchAll(SPECIFICATION_PATH_PATTERN)].map((match) => match[1]),
  )
}

export function hasOpenBlockers(issue) {
  if (issue.inverseRelations.pageInfo?.hasNextPage !== false) return true

  return issue.inverseRelations.nodes.some(
    (relation) =>
      relation.type === 'blocks' &&
      (!relation.issue?.state?.type || !CLOSED_STATE_TYPES.has(relation.issue.state.type)),
  )
}

export async function hasAcceptedSpecification(issue, options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot
  const readFile = options.readFile ?? fs.readFile
  const paths = specificationPaths(issue.description)

  if (paths.length === 0) return false

  for (const relativePath of paths) {
    const absolutePath = path.resolve(root, relativePath)
    const specificationsRoot = path.resolve(root, 'docs/specs') + path.sep
    const productGate = path.resolve(root, 'docs/product/v2.md')
    const acceptedStatusPattern = absolutePath.startsWith(specificationsRoot)
      ? ACCEPTED_STATUS_PATTERNS.get('docs/specs')
      : absolutePath === productGate
        ? ACCEPTED_STATUS_PATTERNS.get('docs/product/v2.md')
        : null
    if (!acceptedStatusPattern) return false

    let content
    try {
      content = await readFile(absolutePath, 'utf8')
    } catch {
      return false
    }
    if (!acceptedStatusPattern.test(content)) return false
  }

  return true
}

export async function promotableIssues(issues, options = {}) {
  const promotable = []

  for (const issue of issues) {
    if (issue.state.type !== 'backlog' || hasOpenBlockers(issue)) continue
    if (await hasAcceptedSpecification(issue, options)) promotable.push(issue)
  }

  return promotable
}

export function createLinearClient(apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error('LINEAR_API_KEY is required')

  return async function request(query, variables) {
    const response = await fetchImpl(LINEAR_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(LINEAR_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`Linear API request failed with HTTP ${response.status}`)
    }

    const payload = await response.json()
    if (payload.errors?.length) {
      throw new Error(
        `Linear API error: ${payload.errors.map((error) => error.message).join('; ')}`,
      )
    }
    if (!payload.data) throw new Error('Linear API returned no data')

    return payload.data
  }
}

export async function fetchProjectIssues(request, projectId) {
  const query = `
    query ProjectIssues($projectId: String!, $after: String) {
      project(id: $projectId) {
        issues(first: 50, after: $after) {
          nodes {
            id
            identifier
            title
            description
            state { type }
            inverseRelations(first: 250) {
              nodes {
                type
                issue {
                  id
                  identifier
                  state { type }
                }
              }
              pageInfo { hasNextPage }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `

  const issues = []
  let after = null

  do {
    const data = await request(query, { projectId, after })
    if (!data.project) throw new Error(`Linear project ${projectId} was not found`)
    issues.push(...data.project.issues.nodes)
    after = data.project.issues.pageInfo.hasNextPage ? data.project.issues.pageInfo.endCursor : null
  } while (after)

  return issues
}

export async function fetchTodoStateId(request, teamId) {
  const data = await request(
    `
      query TeamStates($teamId: String!) {
        team(id: $teamId) {
          states(first: 50) {
            nodes { id name type }
          }
        }
      }
    `,
    { teamId },
  )

  if (!data.team) throw new Error(`Linear team ${teamId} was not found`)
  const todo = data.team.states.nodes.find(
    (state) => state.name === 'Todo' && state.type === 'unstarted',
  )
  if (!todo) throw new Error(`Linear team ${teamId} has no Todo state`)
  return todo.id
}

export async function moveIssueToState(request, issueId, stateId) {
  const data = await request(
    `
      mutation PromoteIssue($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
          issue { identifier state { name } }
        }
      }
    `,
    { issueId, stateId },
  )

  if (!data.issueUpdate?.success) throw new Error(`Linear did not update issue ${issueId}`)
  return data.issueUpdate.issue
}

export async function promoteLinearFrontier(options) {
  const request = options.request
  const issues = await fetchProjectIssues(request, options.projectId)
  const candidates = await promotableIssues(issues, {
    repositoryRoot: options.repositoryRoot,
    readFile: options.readFile,
  })

  if (options.issueIdentifier) {
    const target = issues.find((issue) => issue.identifier === options.issueIdentifier)
    if (!target) throw new Error(`${options.issueIdentifier} is not in the configured project`)
    if (!candidates.some((issue) => issue.id === target.id)) return []
  }

  const selected = options.issueIdentifier
    ? candidates.filter((issue) => issue.identifier === options.issueIdentifier)
    : candidates

  if (options.dryRun || selected.length === 0) return selected

  const todoStateId = await fetchTodoStateId(request, options.teamId)
  for (const issue of selected) await moveIssueToState(request, issue.id, todoStateId)
  return selected
}

function readArgument(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function main() {
  const request = createLinearClient(process.env.LINEAR_API_KEY)
  const projectId = process.env.LINEAR_PROJECT_ID
  const teamId = process.env.LINEAR_TEAM_ID
  if (!projectId) throw new Error('LINEAR_PROJECT_ID is required')
  if (!teamId) throw new Error('LINEAR_TEAM_ID is required')

  const dryRun = process.argv.includes('--dry-run')
  const issueIdentifier = readArgument('--issue')
  const promoted = await promoteLinearFrontier({
    request,
    projectId,
    teamId,
    dryRun,
    issueIdentifier,
  })

  const verb = dryRun ? 'Would promote' : 'Promoted'
  console.log(`${verb} ${promoted.length} issue${promoted.length === 1 ? '' : 's'}.`)
  for (const issue of promoted) console.log(`${issue.identifier}: ${issue.title}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
