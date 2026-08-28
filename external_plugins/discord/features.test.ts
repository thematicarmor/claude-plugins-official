/**
 * Tests for session spawning, trace extraction, and redaction — the parts
 * added alongside per-session channels.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { channelNameFor, detectRepo, slugify, tmuxNameFor } from './naming.ts'
import { Redactor, MASK } from './redact.ts'
import {
  TraceExtractor,
  isTurnStart,
  promptText,
  resultText,
  summariseTool,
  type Rec,
} from './transcript.ts'

const REPOS = ['thematic', 'serv', 'starwars', 'claude-plugins-official']

// ── channel naming ───────────────────────────────────────────────────────────

test('a task naming a repo is prefixed with it', () => {
  expect(channelNameFor('fix the saber glow in starwars', REPOS)).toBe('starwars-fix-saber-glow')
})

test('the repo is not repeated in the tail of the name', () => {
  const name = channelNameFor('starwars saber glow', REPOS)
  expect(name.startsWith('starwars-')).toBe(true)
  expect(name.split('-').filter(w => w === 'starwars').length).toBe(1)
})

test('the longest matching repo wins over a substring match', () => {
  // 'claude-plugins-official' must not lose to a shorter repo inside it.
  expect(detectRepo('update claude-plugins-official readme', [...REPOS, 'claude'])).toBe(
    'claude-plugins-official',
  )
})

test('a task naming no repo still yields a usable name', () => {
  expect(channelNameFor('look into the flaky deploy', REPOS)).toBe('look-flaky-deploy')
})

test('an empty task falls back rather than producing an empty name', () => {
  expect(channelNameFor('', REPOS)).toBe('session')
  expect(channelNameFor('the a of to', REPOS)).toBe('session')
})

test('a colliding name gets a numeric suffix', () => {
  const taken = ['serv-fix-crash']
  expect(channelNameFor('fix crash in serv', REPOS, taken)).toBe('serv-fix-crash-2')
  expect(channelNameFor('fix crash in serv', REPOS, [...taken, 'serv-fix-crash-2'])).toBe(
    'serv-fix-crash-3',
  )
})

test('collision matching ignores case', () => {
  expect(channelNameFor('fix crash in serv', REPOS, ['SERV-FIX-CRASH'])).toBe('serv-fix-crash-2')
})

test('names stay inside Discord limits', () => {
  const name = channelNameFor('x'.repeat(300), REPOS)
  expect(name.length).toBeLessThanOrEqual(90)
})

test('slugify strips markdown that would break a channel name', () => {
  expect(slugify('**Fix** the `parser`!')).toBe('fix-the-parser')
})

test('tmux names avoid characters tmux treats as addressing', () => {
  expect(tmuxNameFor('thematic-api.v2')).toBe('cc-thematic-api-v2')
})

// ── redaction ────────────────────────────────────────────────────────────────

function secretsFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'disc-secret-'))
  const path = join(dir, '.env')
  writeFileSync(path, body)
  return path
}

test('a value from the secrets file is masked wherever it appears', () => {
  const f = secretsFile('DISCORD_BOT_TOKEN=super-secret-value-123\n')
  const r = new Redactor([f])
  const out = r.redact('running with token super-secret-value-123 now')
  expect(out).toBe(`running with token ${MASK} now`)
  expect(out.includes('super-secret-value-123')).toBe(false)
})

test('quoted and short values are handled sensibly', () => {
  const f = secretsFile('QUOTED="quoted-secret-value"\nSHORT=abc\n')
  const r = new Redactor([f])
  expect(r.redact('x quoted-secret-value y')).toBe(`x ${MASK} y`)
  // A 3-character value would match constantly; it is deliberately ignored.
  expect(r.redact('abc def')).toBe('abc def')
})

test('credential shapes are masked even when never loaded', () => {
  const r = new Redactor([])
  expect(r.redact('key sk-abcdefghijklmnopqrstuvwx end')).toContain(MASK)
  expect(r.redact('ghp_abcdefghijklmnopqrstuvwxyz1234')).toContain(MASK)
  expect(r.redact('AKIAIOSFODNN7EXAMPLE')).toContain(MASK)
})

test('a key=value secret keeps its key so the line stays readable', () => {
  const r = new Redactor([])
  expect(r.redact('PASSWORD=hunter2000')).toBe(`PASSWORD=${MASK}`)
})

test('containsSecret reports a known value without revealing it', () => {
  const f = secretsFile('TOKEN=another-secret-value\n')
  const r = new Redactor([f])
  expect(r.containsSecret('has another-secret-value inside')).toBe(true)
  expect(r.containsSecret('nothing here')).toBe(false)
})

test('a missing secrets file is not fatal', () => {
  const r = new Redactor(['/nonexistent/path/.env'])
  expect(r.redact('ordinary text')).toBe('ordinary text')
})

// ── transcript parsing ───────────────────────────────────────────────────────

const assistant = (id: string, content: unknown[]): Rec =>
  ({ type: 'assistant', message: { id, content } }) as Rec

test('a real prompt is a turn start but a tool result is not', () => {
  expect(isTurnStart({ type: 'user', message: { content: 'do the thing' } } as Rec)).toBe(true)
  expect(
    isTurnStart({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] },
    } as Rec),
  ).toBe(false)
  expect(isTurnStart(assistant('m1', [{ type: 'text', text: 'hi' }]))).toBe(false)
})

test('isMeta does not by itself disqualify a turn', () => {
  // Channel-delivered prompts are written with isMeta true; treating that as
  // "not a real turn" would mean no thread ever opened for a Discord message.
  const rec = {
    type: 'user',
    isMeta: true,
    promptSource: 'system',
    message: { content: '<channel source="discord"><@123> fix the parser</channel>' },
  } as Rec
  expect(isTurnStart(rec)).toBe(true)
  expect(promptText(rec)).toBe('fix the parser')
})

test('tool calls render as one line with the argument that matters', () => {
  expect(summariseTool('Bash', { command: 'pgrep -af broker' })).toBe('Bash · pgrep -af broker')
  expect(summariseTool('Read', { file_path: '/tmp/x.ts' })).toBe('Read · /tmp/x.ts')
  expect(summariseTool('mcp__plugin_discord_discord__reply', { text: 'hello' })).toBe('reply · hello')
  expect(summariseTool('Grep', { pattern: 'foo', path: 'src' })).toBe('Grep · foo  in  src')
  // A tool we know nothing about still says something useful.
  expect(summariseTool('Mystery', { whatever: 'value here' })).toBe('Mystery · value here')
  // No usable argument degrades to the bare name rather than a dangling dot.
  expect(summariseTool('Mystery', {})).toBe('Mystery')
})

test('a multi-line command is flattened rather than breaking the line', () => {
  expect(summariseTool('Bash', { command: 'a\nb' })).toBe('Bash · a ⏎ b')
})

test('tool results are read from string or block form', () => {
  expect(resultText('plain')).toBe('plain')
  expect(resultText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])).toBe('one\ntwo')
})

// ── trace extraction ─────────────────────────────────────────────────────────

test('a tool call repeated across blocks is emitted once', () => {
  // Claude Code rewrites the whole message per content block, so the same
  // tool_use appears several times — the inflation bug that hit usage counts.
  const x = new TraceExtractor()
  const blocks = [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]
  const events = x.consume([assistant('m1', blocks), assistant('m1', blocks)])
  expect(events.filter(e => e.k === 'tool')).toHaveLength(1)
})

test('thinking blocks produce nothing, because their text is stripped', () => {
  const x = new TraceExtractor()
  const events = x.consume([
    assistant('m1', [{ type: 'thinking', thinking: '', signature: 'CAIS...' }]),
  ])
  expect(events).toHaveLength(0)
})

test('a turn, its steps and its results come out in order', () => {
  const x = new TraceExtractor()
  const events = x.consume([
    { type: 'user', message: { content: 'check the broker' } } as Rec,
    assistant('m1', [{ type: 'text', text: 'Looking now.' }]),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pgrep broker' } }]),
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '45439' }] },
    } as Rec,
  ])
  expect(events.map(e => e.k)).toEqual(['turn', 'text', 'tool', 'result'])
  expect(events[0]).toMatchObject({ k: 'turn', n: 1, prompt: 'check the broker' })
  expect(events[2]).toMatchObject({ k: 'tool', name: 'Bash' })
  expect(events[3]).toMatchObject({ k: 'result', name: 'ok', lines: 1 })
})

test('turn numbers advance across separate polls', () => {
  const x = new TraceExtractor()
  x.consume([{ type: 'user', message: { content: 'first' } } as Rec])
  const second = x.consume([{ type: 'user', message: { content: 'second' } } as Rec])
  expect(second[0]).toMatchObject({ k: 'turn', n: 2 })
})

test('an errored tool result is marked as such', () => {
  const x = new TraceExtractor()
  const events = x.consume([
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't9', content: 'boom', is_error: true }] },
    } as Rec,
  ])
  expect(events[0]).toMatchObject({ k: 'result', name: 'error' })
})

test('an empty tool result is skipped rather than posted blank', () => {
  const x = new TraceExtractor()
  const events = x.consume([
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't8', content: '   ' }] },
    } as Rec,
  ])
  expect(events).toHaveLength(0)
})

test('long output is clipped so one step cannot fill a message', () => {
  const x = new TraceExtractor()
  const events = x.consume([assistant('m1', [{ type: 'text', text: 'y'.repeat(5000) }])])
  expect(events[0]!.k).toBe('text')
  expect((events[0] as { text: string }).text.length).toBeLessThan(700)
})
