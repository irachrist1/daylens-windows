// `daylens chat "<question>" [--thread <id>] [--json] [--no-stream]`
//
// A REAL chat turn through the exact sendMessage() the AI tab's IPC handler
// calls: context packet, tool loop, grounding verification, persistence,
// citations. Streams text to stdout and prints every tool call as it happens
// (name + input summary), then a footer with usage. Agent questions resolve
// immediately with the defensible-reading default (the app shows a card and
// waits up to 5 minutes — clarification turns can genuinely differ here).

import type { HarnessContext } from './context'
import { c } from './render'

interface ChatOptions {
  json: boolean
  stream: boolean
  threadId: number | null
}

export async function chat(_ctx: HarnessContext, question: string, opts: ChatOptions): Promise<void> {
  const { sendMessage } = await import('../src/main/jobs/aiService')

  const toolLines: Array<{ tool: string; summary: string; status: string }> = []
  let streamedAnything = false

  const result = await sendMessage(
    {
      message: question,
      threadId: opts.threadId,
      clientRequestId: `cli-${Date.now()}`,
    },
    {
      onStreamEvent: (event) => {
        if (!opts.stream || opts.json) return
        if (event.delta) {
          process.stdout.write(event.delta)
          streamedAnything = true
        }
        const step = (event as { step?: { tool?: string; status?: string; summary?: string } }).step
        if (step?.tool && step.status !== 'done') {
          process.stderr.write(c('dim', `\n[tool] ${step.tool}${step.summary ? ` — ${step.summary}` : ''}\n`))
        }
      },
    },
  )

  const message = result.assistantMessage
  const agent = (message as { agent?: { toolTrace?: Array<{ tool: string; input?: unknown; ok?: boolean }> } }).agent
  const trace = agent?.toolTrace ?? []
  for (const step of trace) {
    toolLines.push({
      tool: step.tool,
      summary: step.input ? JSON.stringify(step.input).slice(0, 120) : '',
      status: step.ok === false ? 'failed' : 'ok',
    })
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      answer: message.content,
      threadId: result.threadId,
      providerCallCount: result.providerCallCount ?? null,
      toolTrace: trace,
    }, null, 2)}\n`)
    return
  }

  if (!streamedAnything) {
    console.log(message.content)
  } else {
    process.stdout.write('\n')
  }

  console.log('')
  console.log(c('dim', '─'.repeat(60)))
  if (toolLines.length > 0) {
    console.log(c('bold', `Tools used (${toolLines.length}):`))
    for (const line of toolLines) {
      const mark = line.status === 'failed' ? c('red', '✗') : c('green', '✓')
      console.log(`  ${mark} ${line.tool} ${c('gray', line.summary)}`)
    }
  } else {
    console.log(c('dim', 'No tools used.'))
  }
  console.log(c('dim', `thread ${result.threadId ?? '—'} · provider calls ${result.providerCallCount ?? '—'}`))
}
