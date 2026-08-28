/**
 * Session bookkeeping and message routing — deliberately free of Discord and
 * socket types so the routing rules can be exercised directly by tests.
 *
 * Routing rules, in order:
 *   1. A message in a session-owned thread goes to that session.
 *   2. Anywhere else it goes to the channel's focused session.
 *   3. Focus defaults to the most recently active session.
 */

import type { SessionMeta, UsageSnapshot } from './protocol.ts'

export type Session = {
  meta: SessionMeta
  usage: UsageSnapshot | null
  threadId: string | null
  lastActive: number
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

export function label(s: Session): string {
  return `${s.meta.project}${s.meta.gitBranch ? `@${s.meta.gitBranch}` : ''}`
}

/** Percentage of the context window in use, or null before the first turn. */
export function pct(u: UsageSnapshot | null): number | null {
  if (!u || !u.contextLimit) return null
  return Math.round((u.contextTokens / u.contextLimit) * 100)
}

export class SessionRegistry {
  private sessions = new Map<string, Session>()
  private threadOwner = new Map<string, string>()
  private focus = new Map<string, string>()

  get size(): number {
    return this.sessions.size
  }

  /**
   * Register a session, or refresh one that reconnected. A reconnect carries
   * over the thread and last usage — otherwise a broker restart would strand
   * the session's existing thread and open a duplicate alongside it.
   */
  add(meta: SessionMeta): Session {
    const existing = this.sessions.get(meta.sessionId)
    const s: Session = {
      meta,
      usage: existing?.usage ?? null,
      threadId: existing?.threadId ?? null,
      lastActive: Date.now(),
    }
    this.sessions.set(meta.sessionId, s)
    if (s.threadId) this.threadOwner.set(s.threadId, meta.sessionId)
    return s
  }

  get(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null
  }

  /** Most recently active first — this ordering is what focus falls back to. */
  all(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActive - a.lastActive)
  }

  remove(sessionId: string): Session | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    this.sessions.delete(sessionId)
    if (s.threadId) this.threadOwner.delete(s.threadId)
    for (const [channel, id] of [...this.focus]) {
      if (id === sessionId) this.focus.delete(channel)
    }
    return s
  }

  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.lastActive = Date.now()
  }

  setUsage(sessionId: string, usage: UsageSnapshot): void {
    const s = this.sessions.get(sessionId)
    if (s) s.usage = usage
  }

  setThread(sessionId: string, threadId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (s.threadId) this.threadOwner.delete(s.threadId)
    s.threadId = threadId
    this.threadOwner.set(threadId, sessionId)
  }

  ownerOfThread(threadId: string): Session | null {
    const id = this.threadOwner.get(threadId)
    return id ? (this.sessions.get(id) ?? null) : null
  }

  isSessionThread(threadId: string): boolean {
    return this.threadOwner.has(threadId)
  }

  /** Returns false if the session is unknown, so callers can report it. */
  setFocus(channelId: string, sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false
    this.focus.set(channelId, sessionId)
    return true
  }

  focusedId(channelId: string): string | null {
    const s = this.routeFor(channelId)
    return s ? s.meta.sessionId : null
  }

  /**
   * Where a message in `channelId` should go. A pinned focus that points at a
   * departed session is cleared rather than honoured, so the channel silently
   * falls back to whoever is live instead of going dead.
   */
  routeFor(channelId: string): Session | null {
    const pinned = this.focus.get(channelId)
    if (pinned) {
      const s = this.sessions.get(pinned)
      if (s) return s
      this.focus.delete(channelId)
    }
    return this.all()[0] ?? null
  }

  /** Thread first, then channel focus. */
  routeForMessage(channelId: string): Session | null {
    return this.ownerOfThread(channelId) ?? this.routeFor(channelId)
  }
}
