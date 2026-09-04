import test from 'node:test'
import assert from 'node:assert/strict'

const pipeline = await import('../scripts/promote-linear-frontier.mjs')

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'target-id',
    identifier: 'DEV-999',
    title: 'Target issue',
    description: '**Specification** — `docs/specs/accepted.md`.',
    state: { type: 'backlog' },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    ...overrides,
  }
}

const acceptedSpecification = '# Accepted specification\n\n**Status:** Accepted.\n'

test('promotes a Backlog issue with no open blockers and an accepted specification', async () => {
  const result = await pipeline.promotableIssues([issue()], {
    repositoryRoot: '/repo',
    readFile: async (file: string) => {
      assert.equal(file, '/repo/docs/specs/accepted.md')
      return acceptedSpecification
    },
  })

  assert.deepEqual(
    result.map((candidate: { identifier: string }) => candidate.identifier),
    ['DEV-999'],
  )
})

test('accepts the recorded V2 product gate used by DEV-207', async () => {
  const candidate = issue({
    identifier: 'DEV-207',
    description: '**Specification** — `docs/V2-PLAN.md` (Version 2 release gate).',
  })

  assert.deepEqual(pipeline.specificationPaths(candidate.description), ['docs/V2-PLAN.md'])
  assert.equal(
    await pipeline.hasAcceptedSpecification(candidate, {
      repositoryRoot: process.cwd(),
    }),
    true,
  )
})

test('requires every specification cited by a multi-spec issue to be accepted', async () => {
  const candidate = issue({
    identifier: 'DEV-175',
    description:
      '**Specification** — `docs/specs/privacy-retention-and-sync.md` (deletion); `docs/specs/capture-and-evidence.md` (deletion and retention); the canonical-deletion ticket in `docs/tickets/`.',
  })

  assert.deepEqual(pipeline.specificationPaths(candidate.description), [
    'docs/specs/privacy-retention-and-sync.md',
    'docs/specs/capture-and-evidence.md',
  ])
  assert.equal(
    await pipeline.hasAcceptedSpecification(candidate, {
      repositoryRoot: '/repo',
      readFile: async (file: string) =>
        file.endsWith('privacy-retention-and-sync.md')
          ? '# Privacy\n\n**Status:** Ready for review.\n'
          : acceptedSpecification,
    }),
    false,
  )
})

test('does not promote while any blocker remains open', async () => {
  const blocked = issue({
    inverseRelations: {
      nodes: [
        {
          type: 'blocks',
          issue: { identifier: 'DEV-998', state: { type: 'started' } },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  })

  assert.equal(pipeline.hasOpenBlockers(blocked), true)
  assert.deepEqual(
    await pipeline.promotableIssues([blocked], {
      repositoryRoot: '/repo',
      readFile: async () => acceptedSpecification,
    }),
    [],
  )
})

test('treats completed and canceled blockers as closed', () => {
  for (const stateType of ['completed', 'canceled']) {
    const unblocked = issue({
      inverseRelations: {
        nodes: [
          {
            type: 'blocks',
            issue: { identifier: 'DEV-998', state: { type: stateType } },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    })
    assert.equal(pipeline.hasOpenBlockers(unblocked), false)
  }
})

test('fails closed when incoming relations are truncated', () => {
  const truncated = issue({
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: true } },
  })

  assert.equal(pipeline.hasOpenBlockers(truncated), true)
})

test('fails closed when a specification is missing or not accepted', async () => {
  const readFile = async () => '# Draft\n\n**Status:** Ready for review.\n'
  assert.equal(
    await pipeline.hasAcceptedSpecification(issue(), { repositoryRoot: '/repo', readFile }),
    false,
  )
  assert.equal(
    await pipeline.hasAcceptedSpecification(issue({ description: 'No specification' }), {
      repositoryRoot: '/repo',
      readFile,
    }),
    false,
  )
  assert.equal(
    await pipeline.hasAcceptedSpecification(issue({ description: null }), {
      repositoryRoot: '/repo',
      readFile,
    }),
    false,
  )
})

test('dry-run performs no mutation and an issue filter cannot promote another issue', async () => {
  const requests: string[] = []
  const request = async (query: string) => {
    requests.push(query)
    return {
      project: {
        issues: {
          nodes: [issue(), issue({ id: 'other-id', identifier: 'DEV-1000' })],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }
  }

  const result = await pipeline.promoteLinearFrontier({
    request,
    projectId: 'project-id',
    teamId: 'team-id',
    repositoryRoot: '/repo',
    readFile: async () => acceptedSpecification,
    dryRun: true,
    issueIdentifier: 'DEV-999',
  })

  assert.deepEqual(
    result.map((candidate: { identifier: string }) => candidate.identifier),
    ['DEV-999'],
  )
  assert.equal(requests.length, 1)
})

test('moves every eligible issue to the team Todo state', async () => {
  const updates: Array<{ issueId: string; stateId: string }> = []
  const request = async (query: string, variables: Record<string, string>) => {
    if (query.includes('ProjectIssues')) {
      return {
        project: {
          issues: {
            nodes: [issue()],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }
    }
    if (query.includes('TeamStates')) {
      return {
        team: {
          states: {
            nodes: [
              { id: 'backlog-id', name: 'Backlog', type: 'backlog' },
              { id: 'todo-id', name: 'Todo', type: 'unstarted' },
            ],
          },
        },
      }
    }
    if (query.includes('PromoteIssue')) {
      updates.push({ issueId: variables.issueId, stateId: variables.stateId })
      return {
        issueUpdate: {
          success: true,
          issue: { identifier: 'DEV-999', state: { name: 'Todo' } },
        },
      }
    }
    throw new Error('Unexpected query')
  }

  const result = await pipeline.promoteLinearFrontier({
    request,
    projectId: 'project-id',
    teamId: 'team-id',
    repositoryRoot: '/repo',
    readFile: async () => acceptedSpecification,
  })

  assert.equal(result.length, 1)
  assert.deepEqual(updates, [{ issueId: 'target-id', stateId: 'todo-id' }])
})

test('surfaces Linear GraphQL errors from successful HTTP responses', async () => {
  const request = pipeline.createLinearClient('secret', async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'invalid query' }] }),
  }))

  await assert.rejects(request('query', {}), /Linear API error: invalid query/)
})

test('includes the response body when Linear rejects a request', async () => {
  const request = pipeline.createLinearClient('secret', async () => ({
    ok: false,
    status: 400,
    text: async () => '{"errors":[{"message":"Query too complex to execute"}]}',
  }))

  await assert.rejects(request('query', {}), /HTTP 400: .*Query too complex to execute/)
})

test('auth check distinguishes a rejected key from other failures', async () => {
  const unauthorized = pipeline.createLinearClient('secret', async () => ({
    ok: false,
    status: 401,
    text: async () => 'Authentication required',
  }))
  await assert.rejects(
    pipeline.verifyLinearAuth(unauthorized),
    /rejected LINEAR_API_KEY \(HTTP 401\)/,
  )

  const broken = pipeline.createLinearClient('secret', async () => ({
    ok: false,
    status: 500,
    text: async () => 'upstream exploded',
  }))
  await assert.rejects(
    pipeline.verifyLinearAuth(broken),
    /auth check failed.*HTTP 500.*upstream exploded/,
  )

  const healthy = async () => ({ viewer: { id: 'user-1' } })
  await assert.doesNotReject(pipeline.verifyLinearAuth(healthy))
})

test('follows relation cursors so truncated blocker lists become complete', async () => {
  const relationRequests: Array<{ issueId: string; after: string | null }> = []
  const request = async (query: string, variables: Record<string, string | null>) => {
    if (query.includes('ProjectIssues')) {
      return {
        project: {
          issues: {
            nodes: [
              issue({
                inverseRelations: {
                  nodes: [
                    {
                      type: 'blocks',
                      issue: { identifier: 'DEV-1', state: { type: 'completed' } },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                },
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }
    }
    if (query.includes('IssueInverseRelations')) {
      relationRequests.push({ issueId: variables.issueId as string, after: variables.after })
      return {
        issue: {
          inverseRelations: {
            nodes: [{ type: 'blocks', issue: { identifier: 'DEV-2', state: { type: 'started' } } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }
    }
    throw new Error('Unexpected query')
  }

  const issues = await pipeline.fetchProjectIssues(request, 'project-id')

  assert.deepEqual(relationRequests, [{ issueId: 'target-id', after: 'cursor-1' }])
  assert.equal(issues[0].inverseRelations.nodes.length, 2)
  assert.deepEqual(issues[0].inverseRelations.pageInfo, { hasNextPage: false })
  assert.equal(pipeline.hasOpenBlockers(issues[0]), true)
})
