/**
 * Reads a session's own token usage out of its Claude Code transcript.
 *
 * Claude Code doesn't expose usage to MCP servers, but it writes a JSONL
 * transcript per session under ~/.claude/projects/<slug>/<session-id>.jsonl,
 * and every assistant record carries a `usage` block. Tailing our own file is
 * read-only, needs no internal APIs, and costs nothing when idle (mtime check).
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UsageSnapshot } from './protocol.ts'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

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

/**
 * Context limits are not recorded in the transcript, and the model id there is
 * plain (`claude-opus-5`) even when the session is running a 1M-context
 * variant — so a guess from the id alone is only ever a starting point.
 *
 * Resolution order:
 *   1. `contextLimit` in access.json, if the user set one. Always wins.
 *   2. The `[1m]` tag, on the occasions the id carries it.
 *   3. Otherwise assume the standard window, but widen to the next tier if we
 *      ever observe a prompt bigger than the assumption. Better to correct
 *      ourselves than to report 340% of a window that was never the real one.
 */
const TIERS = [200_000, 500_000, 1_000_000]

export function contextLimitFor(model: string | null, override?: number, observedMax = 0): number {
  if (override && override > 0) return override
  const base = model && (/\[1m\]/i.test(model) || /-1m\b/i.test(model)) ? 1_000_000 : 200_000
  if (observedMax <= base) return base
  return TIERS.find(t => t >= observedMax) ?? observedMax
}

type Rec = {
  type?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

/**
 * Incremental tailer. Cumulative counters advance only over bytes we haven't
 * parsed yet, so cost is proportional to new output rather than file size.
 */
export class UsageTracker {
  private path: string | null = null
  private offset = 0
  private partial = ''
  private lastSize = 0
  private lastMtime = 0

  private model: string | null = null
  private contextTokens = 0
  private inputTokens = 0
  private outputTokens = 0
  private cacheReadTokens = 0
  private turns = 0
  /** High-water mark of prompt size, used to correct a too-small assumption. */
  private observedMax = 0
  /**
   * One assistant turn is written as several records when the turn has
   * multiple content blocks, each repeating the same `usage` under the same
   * message id. Summing every record would multiply-count the turn, so we
   * only fold in the first record we see for a given id. Records for a turn
   * are contiguous, so remembering the previous id is enough.
   */
  private lastMessageId: string | null = null

  constructor(
    private cwd: string,
    private sessionId: string,
    private limitOverride?: number,
  ) {}

  /** Returns a snapshot if anything changed since the last poll, else null. */
  poll(): UsageSnapshot | null {
    if (!this.path) {
      this.path = findTranscript(this.cwd, this.sessionId)
      if (!this.path) return null
    }
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(this.path)
    } catch {
      this.path = null
      return null
    }
    if (st.size === this.lastSize && st.mtimeMs === this.lastMtime) return null
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

    let sawAny = false
    for (const line of lines) {
      if (!line.trim()) continue
      let rec: Rec
      try {
        rec = JSON.parse(line) as Rec
      } catch {
        continue
      }
      const u = rec.message?.usage
      if (rec.type !== 'assistant' || !u) continue
      const msgId = rec.message?.id ?? null
      if (msgId !== null && msgId === this.lastMessageId) continue
      this.lastMessageId = msgId
      sawAny = true
      const input = u.input_tokens ?? 0
      const cacheRead = u.cache_read_input_tokens ?? 0
      const cacheCreate = u.cache_creation_input_tokens ?? 0
      // Context resident at this turn — the whole prompt, however it was billed.
      this.contextTokens = input + cacheRead + cacheCreate
      if (this.contextTokens > this.observedMax) this.observedMax = this.contextTokens
      this.inputTokens += input + cacheCreate
      this.cacheReadTokens += cacheRead
      this.outputTokens += u.output_tokens ?? 0
      this.turns++
      if (rec.message?.model) this.model = rec.message.model
    }
    if (!sawAny && this.turns === 0) return null

    return {
      model: this.model,
      contextTokens: this.contextTokens,
      contextLimit: contextLimitFor(this.model, this.limitOverride, this.observedMax),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      turns: this.turns,
      updatedAt: Date.now(),
    }
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}
