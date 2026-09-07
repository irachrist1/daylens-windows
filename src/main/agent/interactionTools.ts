// Interaction tools for the chat agent: the clarifying question
// (options + free-text escape, resolved by the renderer over IPC or by the
// bench's scripted answerer) and real downloadable file artifacts (CSV, Excel,
// Markdown). Both take injected handlers so the IPC path and the terminal
// bench share this exact code.
import { createRequire } from 'node:module'
import { tool } from 'ai'
import { z } from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { AIMessageArtifact } from '@shared/types'
import {
  collectWeeklyExportData,
  weeklyExportFilename,
  writeWeeklyWorkbook,
} from '../services/weeklyExport'



const nodeRequire = createRequire(__filename)

// exceljs is the heaviest module in the main process (~170ms of require) and
// it is only ever needed when someone exports a workbook. Load it then.
let excelJsModule: typeof import('exceljs') | null = null
function excelJs(): typeof import('exceljs') {
  if (!excelJsModule) {
    excelJsModule = nodeRequire('exceljs') as typeof import('exceljs')
  }
  return excelJsModule
}

export interface AgentQuestion {
  question: string
  options: string[]
  allowFreeText: boolean
}

export interface InteractionDeps {
  /** Ask the user one clarifying question; resolves with their answer text. */
  askUser: (question: AgentQuestion) => Promise<string>
  /** Directory artifacts are written into. */
  artifactDir: string
  /** Collects artifacts produced this turn so the chat turn can persist them. */
  onArtifact: (artifact: AIMessageArtifact) => void
  signal?: AbortSignal
}

const CELL = z.union([z.string(), z.number(), z.null()])

export interface CreateArtifactInput {
  title: string
  format: 'xlsx' | 'csv' | 'markdown'
  columns?: string[]
  rows?: Array<Array<string | number | null>>
  content?: string
}

function safeFilename(title: string, extension: string): string {
  const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export'
  return `${base}-${randomUUID().slice(0, 8)}.${extension}`
}

async function writeXlsx(filePath: string, sheetName: string, columns: string[], rows: Array<Array<string | number | null>>): Promise<void> {
  const workbook = new (excelJs().Workbook)()
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31) || 'Export')
  sheet.columns = columns.map((header) => ({ header, key: header, width: Math.min(60, Math.max(12, header.length + 2)) }))
  sheet.getRow(1).font = { bold: true }
  for (const row of rows) sheet.addRow(row)
  await workbook.xlsx.writeFile(filePath)
}

function toCsv(columns: string[], rows: Array<Array<string | number | null>>): string {
  const cell = (value: string | number | null): string => {
    const text = value == null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [columns.map(cell).join(','), ...rows.map((row) => row.map(cell).join(','))].join('\n')
}

export async function createArtifact(deps: InteractionDeps, input: CreateArtifactInput) {
  const { title, format, columns, rows, content } = input
  if (format === 'markdown') {
    if (!content?.trim()) return { found: false, reason: 'Markdown artifacts need content.' }
  } else if (!columns?.length || !rows?.length) {
    return { found: false, reason: `${format} artifacts need columns and rows.` }
  }
  await fs.mkdir(deps.artifactDir, { recursive: true })
  const extension = format === 'markdown' ? 'md' : format
  const filePath = path.join(deps.artifactDir, safeFilename(title, extension))
  if (format === 'xlsx') {
    await writeXlsx(filePath, title, columns!, rows!)
  } else if (format === 'csv') {
    await fs.writeFile(filePath, toCsv(columns!, rows!), 'utf8')
  } else {
    await fs.writeFile(filePath, `# ${title}\n\n${content}`, 'utf8')
  }
  const artifact: AIMessageArtifact = {
    id: randomUUID(),
    kind: format === 'markdown' ? 'report' : 'export',
    format: format === 'xlsx' ? 'xlsx' : format === 'csv' ? 'csv' : 'markdown',
    title,
    path: filePath,
    openTarget: { kind: 'local_path', value: filePath },
    createdAt: Date.now(),
  }
  deps.onArtifact(artifact)
  return { found: true, savedTo: filePath, filename: path.basename(filePath), title, columns: columns ?? null, rowCount: rows?.length ?? null }
}

export function buildInteractionTools(deps: InteractionDeps) {
  return {
    ask_user: tool({
      description: 'Ask the user ONE short clarifying question with 2-4 tappable options, only when the evidence genuinely underdetermines the answer (e.g. two plausible readings of a time or an ambiguous name). Never use it to make the user do your work. The answer comes back as text.',
      inputSchema: z.object({
        question: z.string().min(1).max(200),
        options: z.array(z.string().min(1).max(80)).min(2).max(4),
      }),
      execute: async ({ question, options }) => {
        if (deps.signal?.aborted) throw new Error('aborted')
        const answer = await deps.askUser({ question, options, allowFreeText: true })
        return { answer }
      },
    }),

    create_artifact: tool({
      description: 'Create a real downloadable file for the user. Use "xlsx" when they say Excel, "csv" for CSV, "markdown" for a document/report. For xlsx/csv pass columns + rows (every claim in them must come from tool results this conversation). For markdown pass content. Returns the saved file; mention it naturally in your answer, the UI renders the download. For a WEEKLY export/timesheet workbook, do NOT compose rows here, call export_week_excel, which computes the numbers itself from the same facts as the Timeline.',
      inputSchema: z.object({
        title: z.string().min(1).max(80).describe('Human title, e.g. "YouTube July 2026"'),
        format: z.enum(['xlsx', 'csv', 'markdown']),
        columns: z.array(z.string()).max(20).optional().describe('Column headers (xlsx/csv)'),
        rows: z.array(z.array(CELL).max(20)).max(2000).optional().describe('Data rows (xlsx/csv)'),
        content: z.string().max(200_000).optional().describe('Markdown body (markdown format only)'),
      }),
      execute: async (input) => createArtifact(deps, input),
    }),
  }
}

/** The deterministic week-export tool. Unlike create_artifact, the model never
 *  supplies numbers: the workbook is computed from the same corrected day
 *  payloads the Timeline renders, so the file, the chat answer, and the
 *  Timeline can only agree. */
export function buildExportTools(db: Database.Database, deps: InteractionDeps) {
  return {
    export_week_excel: tool({
      description: 'Build the real weekly Excel export: a styled workbook with a per-day week summary (active time, top apps, top sites, project/client, notes, honest gaps), a totals row, and a by-app sheet whose numbers are computed from the same corrected facts as the Timeline, never from values you type. Filename is Daylens-week-YYYY-MM-DD-to-DD.xlsx. Use this for every "export my week / timesheet Excel" request. Returns the saved file plus the computed totals so your answer can quote the same numbers.',
      inputSchema: z.object({
        weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
          .describe('Any date inside the target week (local, YYYY-MM-DD); it is snapped to that week\'s Monday'),
      }),
      execute: async ({ weekStartDate }) => {
        if (deps.signal?.aborted) throw new Error('aborted')
        const data = collectWeeklyExportData(db, weekStartDate)
        await fs.mkdir(deps.artifactDir, { recursive: true })
        const filename = weeklyExportFilename(data.weekStart, data.weekEnd)
        const filePath = path.join(deps.artifactDir, filename)
        await writeWeeklyWorkbook(data, filePath)
        const artifact: AIMessageArtifact = {
          id: randomUUID(),
          kind: 'export',
          format: 'xlsx',
          title: `Daylens week ${data.weekStart} to ${data.weekEnd}`,
          path: filePath,
          openTarget: { kind: 'local_path', value: filePath },
          createdAt: Date.now(),
        }
        deps.onArtifact(artifact)
        return {
          found: true,
          savedTo: filePath,
          filename,
          weekStart: data.weekStart,
          weekEnd: data.weekEnd,
          totalSeconds: data.totalSeconds,
          days: data.days.map((day) => ({
            date: day.date,
            weekday: day.weekday,
            activeSeconds: day.activeSeconds,
            topApps: day.topApps.map((app) => app.appName),
          })),
          topApps: data.apps.slice(0, 8),
          note: 'Workbook computed from the same corrected facts as Timeline/Apps — quote these totals verbatim.',
        }
      },
    }),
  }
}
