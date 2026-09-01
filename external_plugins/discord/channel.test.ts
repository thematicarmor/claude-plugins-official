/**
 * Unit tests for the pieces that don't need a gateway: wire framing, routing,
 * and the transcript usage tailer. Run with `bun test`.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeLineReader, encode, type SessionMeta } from './protocol.ts'
import { SessionRegistry, label, pct, shortId } from './registry.ts'
import { UsageTracker, contextLimitFor, fmtTokens } from './usage.ts'

// ── framing ──────────────────────────────────────────────────────────────────

test('line reader reassembles messages split across chunks', () => {
  const got: string[] = []
  const read = makeLineReader(l => got.push(l))
  read('{"t":"he')
  read('llo"}\n{"t":"bye"}\n')
  expect(got).toEqual(['{"t":"hello"}', '{"t":"bye"}'])
})

test('line reader holds an incomplete trailing line until it terminates', () => {
  const got: string[] = []
  const read = makeLineReader(l => got.push(l))
  read('{"a":1}\n{"b":2')
  expect(got).toEqual(['{"a":1}'])
  read('}\n')
  expect(got).toEqual(['{"a":1}', '{"b":2}'])
})

test('encode round-trips through the reader', () => {
  const got: string[] = []
  const read = makeLineReader(l => got.push(l))
  read(encode({ t: 'permission', request_id: 'abcde', behavior: 'allow' }))
  expect(JSON.parse(got[0]!)).toEqual({ t: 'permission', request_id: 'abcde', behavior: 'allow' })
})

// ── routing ──────────────────────────────────────────────────────────────────

function meta(id: string, project: string, branch: string | null = null): SessionMeta {
  return { sessionId: id, cwd: `/w/${project}`, project, gitBranch: branch, pid: 1, startedAt: 0 }
}

test('a single session receives everything in the channel', () => {
  const r = new SessionRegistry()
  const s = r.add(meta('aaaaaaaa1', 'thematic'))
  expect(r.routeForMessage('chan')?.meta.sessionId).toBe(s.meta.sessionId)
})

test('channel messages default to the most recently active session', () => {
  const r = new SessionRegistry()
  r.add(meta('aaaaaaaa1', 'thematic'))
  const b = r.add(meta('bbbbbbbb2', 'serv'))
  b.lastActive = Date.now() + 1000
  expect(r.routeForMessage('chan')?.meta.project).toBe('serv')
})

test('explicit focus overrides recency', () => {
  const r = new SessionRegistry()
  r.add(meta('aaaaaaaa1', 'thematic'))
  const b = r.add(meta('bbbbbbbb2', 'serv'))
  b.lastActive = Date.now() + 1000
  expect(r.setFocus('chan', 'aaaaaaaa1')).toBe(true)
  expect(r.routeForMessage('chan')?.meta.project).toBe('thematic')
})

test('focus on an unknown session is rejected', () => {
  const r = new SessionRegistry()
  r.add(meta('aaaaaaaa1', 'thematic'))
  expect(r.setFocus('chan', 'nope')).toBe(false)
})

test('a bound channel routes to its owner regardless of focus', () => {
  const r = new SessionRegistry()
  r.add(meta('aaaaaaaa1', 'thematic'))
  r.add(meta('bbbbbbbb2', 'serv'))
  r.bindChannel('bbbbbbbb2', 'chan-serv')
  r.setFocus('chan', 'aaaaaaaa1')
  expect(r.routeForMessage('chan-serv')?.meta.project).toBe('serv')
  expect(r.routeForMessage('chan')?.meta.project).toBe('thematic')
})

test('a thread inside a bound channel reaches that channel\'s session', () => {
  // Trace threads live inside a session's channel; replying in one should
  // reach that session rather than falling through to whoever has focus.
  const r = new SessionRegistry()
  r.add(meta('aaaaaaaa1', 'thematic'))
  r.add(meta('bbbbbbbb2', 'serv'))
  r.bindChannel('bbbbbbbb2', 'chan-serv')
  r.setFocus('thread-x', 'aaaaaaaa1')
  expect(r.routeForMessage('thread-x', 'chan-serv')?.meta.project).toBe('serv')
})

test('bindChannel from meta claims the channel at registration', () => {
  // How a session spawned by /new claims the channel created for it.
  const r = new SessionRegistry()
  r.add({ ...meta('cccccccc3', 'workspace'), bindChannel: 'chan-new' })
  expect(r.routeForMessage('chan-new')?.meta.sessionId).toBe('cccccccc3')
  expect(r.isBoundChannel('chan-new')).toBe(true)
})

test('losing the focused session falls back instead of going dead', () => {
  const r = new SessionRegistry()
  r.add(meta('aaaaaaaa1', 'thematic'))
  r.add(meta('bbbbbbbb2', 'serv'))
  r.setFocus('chan', 'bbbbbbbb2')
  r.remove('bbbbbbbb2')
  expect(r.routeForMessage('chan')?.meta.project).toBe('thematic')
})

test('removing a session releases its channel', () => {
  const r = new SessionRegistry()
  r.add(meta('aaaaaaaa1', 'thematic'))
  r.bindChannel('aaaaaaaa1', 'chan-1')
  expect(r.isBoundChannel('chan-1')).toBe(true)
  r.remove('aaaaaaaa1')
  expect(r.isBoundChannel('chan-1')).toBe(false)
  expect(r.routeForMessage('chan-1')).toBeNull()
})

test('an empty registry routes nowhere', () => {
  expect(new SessionRegistry().routeForMessage('chan')).toBeNull()
})

test('labels carry project and branch', () => {
  const r = new SessionRegistry()
  const s = r.add(meta('aaaaaaaa1', 'thematic', 'feat/x'))
  expect(label(s)).toBe('thematic@feat/x')
  expect(shortId('f74e72f2-84e4-4399')).toBe('f74e72f2')
})

// ── usage ────────────────────────────────────────────────────────────────────

test('context limit is inferred from the model tag', () => {
  expect(contextLimitFor('claude-opus-5[1m]')).toBe(1_000_000)
  expect(contextLimitFor('claude-opus-5')).toBe(200_000)
  expect(contextLimitFor(null)).toBe(200_000)
  expect(contextLimitFor('claude-opus-5', 500_000)).toBe(500_000)
})

test('pct reports null before the first turn', () => {
  expect(pct(null)).toBeNull()
  expect(
    pct({
      model: 'm', contextTokens: 50_000, contextLimit: 200_000,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 0, updatedAt: 0,
    }),
  ).toBe(25)
})

test('fmtTokens is compact', () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(52_209)).toBe('52k')
  expect(fmtTokens(1_400_000)).toBe('1.4M')
})

/** One assistant turn, written as `blocks` separate records as CC does. */
function turn(id: string, u: Record<string, number>, blocks = 1): string {
  return Array.from({ length: blocks }, () =>
    JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5[1m]', usage: u } }),
  ).join('\n') + '\n'
}

function transcriptFixture(): { dir: string; path: string; sessionId: string } {
  const sessionId = 'test-session'
  const dir = mkdtempSync(join(tmpdir(), 'disc-usage-'))
  // UsageTracker's fallback scan looks for <sessionId>.jsonl under a project
  // dir, so nest it the way Claude Code does.
  const path = join(dir, `${sessionId}.jsonl`)
  writeFileSync(path, '')
  return { dir, path, sessionId }
}

test('multi-block turns are counted once, not once per record', () => {
  const { path } = transcriptFixture()
  // 3 records, one logical turn — the shape that inflated totals before.
  appendFileSync(path, turn('msg_1', { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 10 }, 3))
  const t = new UsageTracker('/irrelevant', 'test-session', undefined, path)
  const snap = t.poll()!
  expect(snap.turns).toBe(1)
  expect(snap.outputTokens).toBe(10)
  expect(snap.contextTokens).toBe(152)
})

test('usage accumulates across turns and tracks the latest context size', () => {
  const { path } = transcriptFixture()
  appendFileSync(path, turn('msg_1', { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, output_tokens: 10 }, 2))
  const t = new UsageTracker('/irrelevant', 'test-session', undefined, path)
  expect(t.poll()!.turns).toBe(1)

  appendFileSync(path, turn('msg_2', { input_tokens: 2, cache_read_input_tokens: 102, cache_creation_input_tokens: 40, output_tokens: 7 }, 1))
  const snap = t.poll()!
  expect(snap.turns).toBe(2)
  expect(snap.outputTokens).toBe(17)
  // Context is the latest turn's whole prompt, not a running sum.
  expect(snap.contextTokens).toBe(144)
  expect(snap.cacheReadTokens).toBe(102)
  expect(snap.contextLimit).toBe(1_000_000)
})

test('a record split across two polls is not lost or double-counted', () => {
  const { path } = transcriptFixture()
  const line = turn('msg_1', { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, output_tokens: 10 })
  const t = new UsageTracker('/irrelevant', 'test-session', undefined, path)
  // Writer is mid-line: no complete record yet.
  appendFileSync(path, line.slice(0, 30))
  expect(t.poll()).toBeNull()
  appendFileSync(path, line.slice(30))
  const snap = t.poll()!
  expect(snap.turns).toBe(1)
  expect(snap.outputTokens).toBe(10)
})

test('no transcript yields no snapshot rather than throwing', () => {
  expect(new UsageTracker('/nonexistent', 'no-such-session').poll()).toBeNull()
})

test('an unset limit widens rather than reporting over 100%', () => {
  // `claude-opus-5` gives no hint that the session is a 1M-context one.
  expect(contextLimitFor('claude-opus-5', undefined, 0)).toBe(200_000)
  expect(contextLimitFor('claude-opus-5', undefined, 340_000)).toBe(500_000)
  expect(contextLimitFor('claude-opus-5', undefined, 780_000)).toBe(1_000_000)
  // A configured limit is authoritative even so.
  expect(contextLimitFor('claude-opus-5', 200_000, 780_000)).toBe(200_000)
})

test('the tracker widens its own limit once a big prompt lands', () => {
  const { path } = transcriptFixture()
  const t = new UsageTracker('/irrelevant', 'test-session', undefined, path)
  appendFileSync(path, turn('m1', { input_tokens: 2, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0, output_tokens: 5 }))
  expect(t.poll()!.contextLimit).toBe(1_000_000) // fixture model carries [1m]
})

test('re-registering a session keeps it routable', () => {
  // Mirrors a shim reconnecting after a broker restart: the same session id
  // registers again and must still receive messages.
  const r = new SessionRegistry()
  r.add(meta('aaaaaaaa1', 'thematic'))
  r.bindChannel('aaaaaaaa1', 'chan-1')
  r.add(meta('aaaaaaaa1', 'thematic'))
  expect(r.size).toBe(1)
  expect(r.routeForMessage('chan')?.meta.sessionId).toBe('aaaaaaaa1')
  // The channel survives the reconnect instead of being orphaned.
  expect(r.get('aaaaaaaa1')?.channelId).toBe('chan-1')
  expect(r.routeForMessage('thread1')?.meta.sessionId).toBe('aaaaaaaa1')
})

test('usage from an unknown session is ignored rather than throwing', () => {
  const r = new SessionRegistry()
  expect(() =>
    r.setUsage('ghost', {
      model: 'm', contextTokens: 1, contextLimit: 2,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turns: 1, updatedAt: 0,
    }),
  ).not.toThrow()
  expect(() => r.touch('ghost')).not.toThrow()
  expect(r.remove('ghost')).toBeNull()
})

// ── idle suspension ──────────────────────────────────────────────────────────

test('a session quiet on both clocks is idle', () => {
  const r = new SessionRegistry()
  const s = r.add(meta('aaaaaaaa1', 'thematic'))
  s.lastActive = Date.now() - 3 * 60 * 60 * 1000
  s.lastProgress = Date.now() - 3 * 60 * 60 * 1000
  expect(r.idleFor(2 * 60 * 60 * 1000).map(x => x.meta.sessionId)).toEqual([s.meta.sessionId])
})

test('a session working alone is not idle, however long since anyone spoke to it', () => {
  const r = new SessionRegistry()
  const s = r.add(meta('aaaaaaaa1', 'thematic'))
  // Nobody has typed at it for three hours, but it is still producing output.
  s.lastActive = Date.now() - 3 * 60 * 60 * 1000
  s.lastProgress = Date.now()
  expect(r.idleFor(2 * 60 * 60 * 1000)).toEqual([])
})

test('a session spoken to recently is not idle even if it has produced nothing', () => {
  const r = new SessionRegistry()
  const s = r.add(meta('aaaaaaaa1', 'thematic'))
  s.lastActive = Date.now()
  s.lastProgress = Date.now() - 3 * 60 * 60 * 1000
  expect(r.idleFor(2 * 60 * 60 * 1000)).toEqual([])
})

test('progress() refreshes the working clock without touching the spoken-to one', () => {
  const r = new SessionRegistry()
  const s = r.add(meta('aaaaaaaa1', 'thematic'))
  s.lastActive = 1000
  s.lastProgress = 1000
  r.progress('aaaaaaaa1')
  expect(s.lastProgress).toBeGreaterThan(1000)
  expect(s.lastActive).toBe(1000)
})

test('a reconnecting session keeps its working clock', () => {
  const r = new SessionRegistry()
  const s = r.add(meta('aaaaaaaa1', 'thematic'))
  s.lastProgress = 4242
  const again = r.add(meta('aaaaaaaa1', 'thematic'))
  expect(again.lastProgress).toBe(4242)
})
