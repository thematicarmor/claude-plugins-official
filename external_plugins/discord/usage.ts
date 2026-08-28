/**
 * Reads a session's own token usage out of its Claude Code transcript.
 *
 * Claude Code doesn't expose usage to MCP servers, but every assistant record
 * in the transcript carries a `usage` block. Tailing is handled by
 * `transcript.ts`; this module is only the accounting on top of it.
 */

import type { UsageSnapshot } from './protocol.ts'
import { TranscriptTailer, type Rec } from './transcript.ts'

export { findTranscript } from './transcript.ts'

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

/**
 * Cumulative counters advance only over records that haven't been folded in
 * yet, so cost is proportional to new output rather than file size.
 */
export class UsageTracker {
  private tailer: TranscriptTailer

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
    cwd: string,
    sessionId: string,
    private limitOverride?: number,
    pathOverride?: string,
  ) {
    this.tailer = new TranscriptTailer(cwd, sessionId, pathOverride)
  }

  /** Returns a snapshot if anything changed since the last poll, else null. */
  poll(): UsageSnapshot | null {
    const recs = this.tailer.poll()
    // An unchanged file reports nothing, rather than re-reporting the last
    // snapshot on every tick — callers treat a snapshot as news.
    if (recs.length === 0) return null
    return this.consume(recs)
  }

  /**
   * Fold in records already read elsewhere. Lets a caller tail the file once
   * and fan the records out to both this and the trace extractor.
   */
  consume(recs: Rec[]): UsageSnapshot | null {
    let sawAny = false
    for (const rec of recs) {
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
