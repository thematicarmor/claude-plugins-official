/**
 * Incremental reader for a session's own Claude Code transcript.
 *
 * Claude Code writes a JSONL transcript per session under
 * ~/.claude/projects/<slug>/<session-id>.jsonl. Tailing our own file is
 * read-only, needs no internal APIs, and costs nothing when idle (mtime check).
 *
 * This module owns the tailing and record shapes; `usage.ts` and the trace
 * writer are both consumers, so the file is parsed once per poll and fanned
 * out rather than tailed twice.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { TraceEvent } from './protocol.ts'

/** Overridable so tests can point at a fixture instead of the real history. */
const PROJECTS_DIR = process.env.DISCORD_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')

/** Claude Code slugifies the cwd by replacing path separators with dashes. */
function slugify(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-')
}

/**
 * Locate our transcript. The slug rule is stable but undocumented, so fall
 * back to scanning the projects dir for <sessionId>.jsonl rather than going
 * blind if it ever changes.
 */
export function findTranscript(cwd: string, sessionId: string): string | null {
  const direct = join(PROJECTS_DIR, slugify(cwd), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  let dirs: string[]
  try {
    dirs = readdirSync(PROJECTS_DIR)
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

function readRange(path: string, start: number, end: number): string {
  const len = end - start
  if (len <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const got = readSync(fd, buf, 0, len, start)
    return buf.subarray(0, got).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export type ContentBlock = {
  type?: string
  text?: string
  /** Always empty in practice — Claude Code strips reasoning text. */
  thinking?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export type Rec = {
  type?: string
  isMeta?: boolean
  promptSource?: string
  timestamp?: string
  message?: {
    id?: string
    model?: string
    role?: string
    content?: ContentBlock[] | string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

/**
 * Returns records appended since the last poll. Cost is proportional to new
 * output rather than file size.
 */
export class TranscriptTailer {
  private path: string | null = null
  private offset = 0
  private partial = ''
  private lastSize = 0
  private lastMtime = 0

  /**
   * `pathOverride` skips discovery for a caller that already knows the file —
   * used by tests, which write a fixture outside the projects directory.
   */
  constructor(
    private cwd: string,
    private sessionId: string,
    pathOverride?: string,
  ) {
    this.path = pathOverride ?? null
  }

  /** True once the transcript has been located on disk. */
  get found(): boolean {
    return this.path !== null
  }

  poll(): Rec[] {
    if (!this.path) {
      this.path = findTranscript(this.cwd, this.sessionId)
      if (!this.path) return []
    }
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(this.path)
    } catch {
      this.path = null
      return []
    }
    if (st.size === this.lastSize && st.mtimeMs === this.lastMtime) return []
    // Truncation or rotation — start over rather than parse garbage.
    if (st.size < this.offset) {
      this.offset = 0
      this.partial = ''
    }
    this.lastSize = st.size
    this.lastMtime = st.mtimeMs

    const text = this.partial + readRange(this.path, this.offset, st.size)
    this.offset = st.size

    const lines = text.split('\n')
    // A trailing fragment means the writer is mid-line; carry it forward.
    this.partial = lines.pop() ?? ''

    const out: Rec[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as Rec)
      } catch {
        continue
      }
    }
    return out
  }
}

// ── turn detection ───────────────────────────────────────────────────────────

/**
 * Distinguishes a genuine new prompt from the tool-result records that also
 * carry `type: "user"`. In a live transcript the two are cleanly separable:
 * a real prompt has string content, while a tool result is an array of
 * `tool_result` blocks. Channel-delivered prompts additionally carry
 * `isMeta: true` with `promptSource: "system"`, so neither field can be used
 * on its own to mean "not a real turn".
 */
export function isTurnStart(rec: Rec): boolean {
  if (rec.type !== 'user') return false
  const content = rec.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) return !content.some(b => b?.type === 'tool_result')
  return false
}

/** Strips our own channel envelope so the thread title reads as the request. */
export function promptText(rec: Rec): string {
  const content = rec.message?.content
  let text = typeof content === 'string' ? content : ''
  if (Array.isArray(content)) {
    text = content
      .filter(b => b?.type === 'text')
      .map(b => b.text ?? '')
      .join(' ')
  }
  // Inbound Discord messages arrive wrapped in a <channel ...> element.
  const inner = /<channel\b[^>]*>([\s\S]*?)<\/channel>/.exec(text)
  if (inner) text = inner[1] ?? text
  return text.replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim()
}

// ── tool call rendering ──────────────────────────────────────────────────────

/**
 * `mcp__<server>__<tool>` → `<tool>`. The match is greedy because server names
 * contain underscores of their own (`mcp__plugin_discord_discord__reply`), so
 * anchoring on the first pair would leave most of the prefix behind.
 */
export function shortToolName(name: string): string {
  return name.replace(/^mcp__.*__/, '')
}

/**
 * The argument worth showing for a given tool. Falls back to the first
 * short string argument, which covers MCP tools we know nothing about.
 */
function toolDetail(name: string, input: Record<string, unknown>): string {
  const pick = (k: string): string | null => {
    const v = input[k]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const short = shortToolName(name)
  switch (short) {
    case 'Bash':
      return pick('command') ?? ''
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return pick('file_path') ?? ''
    case 'Grep':
      return [pick('pattern'), pick('path')].filter(Boolean).join('  in  ')
    case 'Glob':
      return pick('pattern') ?? ''
    case 'Task':
    case 'Agent':
      return pick('description') ?? ''
    case 'WebFetch':
      return pick('url') ?? ''
    case 'WebSearch':
      return pick('query') ?? ''
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v.trim() && v.length <= 200) return v.trim()
      }
      return ''
    }
  }
}

/** `Bash · pgrep -af broker` — one line, newlines flattened. */
export function summariseTool(name: string, input: Record<string, unknown>): string {
  const short = shortToolName(name)
  const detail = toolDetail(name, input).replace(/\s*\n\s*/g, ' ⏎ ')
  return detail ? `${short} · ${detail}` : short
}

/** Tool results arrive as a string, or as an array of content blocks. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: string }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// ── trace extraction ─────────────────────────────────────────────────────────

const MAX_TEXT = 600
const MAX_RESULT = 400

function clip(s: string, n: number): string {
  const t = s.trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/**
 * Turns raw records into trace events.
 *
 * Deduplication mirrors `UsageTracker`: one assistant turn is written as
 * several records when it has multiple content blocks, each repeating the
 * whole message. Keying on tool_use id and message id keeps each step from
 * being emitted once per block.
 */
export class TraceExtractor {
  private turn = 0
  private seenTools = new Set<string>()
  private seenText = new Set<string>()

  /** Bounded so a long session can't grow these without limit. */
  private forget(set: Set<string>): void {
    if (set.size > 500) set.clear()
  }

  consume(recs: Rec[]): TraceEvent[] {
    const out: TraceEvent[] = []
    for (const rec of recs) {
      const at = Date.parse(rec.timestamp ?? '') || Date.now()

      if (isTurnStart(rec)) {
        this.turn++
        out.push({ k: 'turn', n: this.turn, prompt: clip(promptText(rec), 200), at })
        continue
      }

      const content = rec.message?.content
      if (!Array.isArray(content)) continue

      if (rec.type === 'user') {
        for (const b of content) {
          if (b?.type !== 'tool_result') continue
          const key = b.tool_use_id ?? ''
          if (key && this.seenTools.has(`r:${key}`)) continue
          if (key) this.seenTools.add(`r:${key}`)
          const text = resultText(b.content)
          if (!text.trim()) continue
          out.push({
            k: 'result',
            name: b.is_error ? 'error' : 'ok',
            preview: clip(text, MAX_RESULT),
            lines: text.split('\n').length,
            at,
          })
        }
        continue
      }

      if (rec.type !== 'assistant') continue
      for (const b of content) {
        if (b?.type === 'tool_use') {
          const key = b.id ?? `${rec.message?.id}:${b.name}`
          if (this.seenTools.has(key)) continue
          this.seenTools.add(key)
          out.push({
            k: 'tool',
            name: shortToolName(b.name ?? 'tool'),
            summary: summariseTool(b.name ?? 'tool', b.input ?? {}),
            at,
          })
        } else if (b?.type === 'text') {
          const text = (b.text ?? '').trim()
          if (!text) continue
          const key = `${rec.message?.id}:${text.slice(0, 60)}`
          if (this.seenText.has(key)) continue
          this.seenText.add(key)
          out.push({ k: 'text', text: clip(text, MAX_TEXT), at })
        }
        // `thinking` blocks are deliberately skipped: Claude Code persists them
        // with the text stripped, so there is nothing in them to show.
      }
    }
    this.forget(this.seenTools)
    this.forget(this.seenText)
    return out
  }
}
