/**
 * Session bookkeeping and message routing — deliberately free of Discord and
 * socket types so the routing rules can be exercised directly by tests.
 *
 * Routing rules, in order:
 *   1. A message in a channel bound to a session goes to that session.
 *   2. A message in a thread goes wherever its parent channel goes, so
 *      replying inside a trace thread reaches the session it belongs to.
 *   3. Anywhere else it goes to the channel's focused session.
 *   4. Focus defaults to the most recently active session.
 *
 * Sessions spawned by `/new` get a channel of their own, which is what rule 1
 * keys on. The control channel keeps rules 3 and 4, so its behaviour is
 * unchanged from before spawning existed.
 */

import type { SessionMeta, UsageSnapshot } from './protocol.ts'

export type Session = {
  meta: SessionMeta
  usage: UsageSnapshot | null
  /** Channel this session owns outright, if it was spawned into one. */
  channelId: string | null
  lastActive: number
  /**
   * Last sign the session was *working*, as opposed to being spoken to.
   * `lastActive` only moves when a human sends something, so a long
   * autonomous run is indistinguishable from an abandoned session by that
   * clock alone. The shim pushes `usage` whenever the transcript grows, which
   * is what moves this one.
   */
  lastProgress: number
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
  private channelOwner = new Map<string, string>()
  private focus = new Map<string, string>()

  get size(): number {
    return this.sessions.size
  }

  /**
   * Register a session, or refresh one that reconnected. A reconnect carries
   * over the channel binding and last usage — otherwise a broker restart would
   * strand the session's channel and it would stop being routable.
   *
   * `meta.bindChannel` is honoured on registration: it is how a session
   * spawned by `/new` claims the channel that was created for it.
   */
  add(meta: SessionMeta): Session {
    const existing = this.sessions.get(meta.sessionId)
    const s: Session = {
      meta,
      usage: existing?.usage ?? null,
      channelId: meta.bindChannel ?? existing?.channelId ?? null,
      lastActive: Date.now(),
      lastProgress: existing?.lastProgress ?? Date.now(),
    }
    this.sessions.set(meta.sessionId, s)
    if (s.channelId) this.channelOwner.set(s.channelId, meta.sessionId)
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
    if (s.channelId) this.channelOwner.delete(s.channelId)
    for (const [channel, id] of [...this.focus]) {
      if (id === sessionId) this.focus.delete(channel)
    }
    return s
  }

  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.lastActive = Date.now()
  }

  /** The session produced output — see `lastProgress`. */
  progress(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.lastProgress = Date.now()
  }

  /**
   * Sessions quiet on *both* clocks for longer than `idleMs`. Requiring both
   * is the point: a session mid-run keeps `lastProgress` fresh even though
   * nobody has typed at it for hours.
   */
  idleFor(idleMs: number, now = Date.now()): Session[] {
    return [...this.sessions.values()].filter(
      s => now - s.lastActive > idleMs && now - s.lastProgress > idleMs,
    )
  }

  setUsage(sessionId: string, usage: UsageSnapshot): void {
    const s = this.sessions.get(sessionId)
    if (s) s.usage = usage
  }

  /** Give a session a channel of its own. */
  bindChannel(sessionId: string, channelId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (s.channelId) this.channelOwner.delete(s.channelId)
    s.channelId = channelId
    this.channelOwner.set(channelId, sessionId)
  }

  ownerOfChannel(channelId: string): Session | null {
    const id = this.channelOwner.get(channelId)
    return id ? (this.sessions.get(id) ?? null) : null
  }

  isBoundChannel(channelId: string): boolean {
    return this.channelOwner.has(channelId)
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

  /**
   * Bound channel first, then the parent of a thread, then channel focus.
   * `parentId` is the thread's parent when the message arrived in a thread.
   */
  routeForMessage(channelId: string, parentId?: string | null): Session | null {
    const direct = this.ownerOfChannel(channelId)
    if (direct) return direct
    if (parentId) {
      const viaParent = this.ownerOfChannel(parentId)
      if (viaParent) return viaParent
    }
    return this.routeFor(channelId)
  }
}
