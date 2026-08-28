/**
 * End-to-end test of the per-session shim: real server.ts, spoken to over MCP
 * stdio on one side and a stub broker on the other. No gateway involved.
 *
 * The state dir is pointed at a scratch path with no .env, so even if the shim
 * decided to start a real broker it would find no token and exit immediately.
 */

import { expect, test, afterAll } from 'bun:test'
import { createServer, type Server as NetServer, type Socket } from 'net'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeLineReader, encode, type ShimMsg } from './protocol.ts'

const dir = mkdtempSync(join(tmpdir(), 'disc-relay-'))
const sock = join(dir, 'broker.sock')

let brokerConn: Socket | null = null
const fromShim: ShimMsg[] = []
const waiters: Array<(m: ShimMsg) => boolean> = []

function onShimMsg(m: ShimMsg): void {
  fromShim.push(m)
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!(m)) waiters.splice(i, 1)
}

/** Resolve once a message matching `pred` arrives (or has already arrived). */
function waitFor<T extends ShimMsg>(pred: (m: ShimMsg) => boolean, ms = 10_000): Promise<T> {
  const seen = fromShim.find(pred)
  if (seen) return Promise.resolve(seen as T)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for shim message')), ms)
    waiters.push(m => {
      if (!pred(m)) return false
      clearTimeout(timer)
      resolve(m as T)
      return true
    })
  })
}

const server: NetServer = createServer(c => {
  brokerConn = c
  const read = makeLineReader(line => onShimMsg(JSON.parse(line) as ShimMsg))
  c.on('data', read)
  c.on('error', () => {})
})
await new Promise<void>(r => server.listen(sock, r))

const shim = Bun.spawn([process.execPath, join(import.meta.dir, 'server.ts')], {
  env: {
    ...process.env,
    DISCORD_STATE_DIR: dir,
    DISCORD_BROKER_SOCK: sock,
    CLAUDE_CODE_SESSION_ID: 'relay-test-session',
    CLAUDE_PROJECT_DIR: '/tmp/relay-project',
    DISCORD_BOT_TOKEN: undefined,
  },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})

// ── MCP client plumbing ──────────────────────────────────────────────────────

type Rpc = Record<string, unknown>
const rpcWaiters = new Map<number, (v: Rpc) => void>()
const notifications: Rpc[] = []
let rpcId = 0

const readStdout = makeLineReader(line => {
  let msg: Rpc
  try {
    msg = JSON.parse(line) as Rpc
  } catch {
    return
  }
  if (typeof msg.id === 'number' && rpcWaiters.has(msg.id)) {
    rpcWaiters.get(msg.id)!(msg)
    rpcWaiters.delete(msg.id)
  } else if (msg.method) {
    notifications.push(msg)
  }
})

void (async () => {
  for await (const chunk of shim.stdout as ReadableStream) readStdout(chunk)
})()

function notify(method: string, params?: unknown): void {
  shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  shim.stdin.flush()
}

function request(method: string, params?: unknown): Promise<Rpc> {
  const id = ++rpcId
  shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  shim.stdin.flush()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000)
    rpcWaiters.set(id, v => {
      clearTimeout(timer)
      resolve(v)
    })
  })
}

afterAll(() => {
  shim.kill()
  server.close()
})

// ── tests ────────────────────────────────────────────────────────────────────

test('shim completes the MCP handshake', async () => {
  const res = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'relay-test', version: '1' },
  })
  const result = res.result as Rpc
  expect((result.serverInfo as Rpc).name).toBe('discord')
  // The channel capabilities are what make Claude Code treat this as a channel.
  const exp = (result.capabilities as Rpc).experimental as Rpc
  expect(exp).toHaveProperty('claude/channel')
  expect(exp).toHaveProperty('claude/channel/permission')
  notify('notifications/initialized')
})

test('shim registers itself with the broker, reporting its identity', async () => {
  const hello = await waitFor(m => m.t === 'hello')
  expect(hello).toMatchObject({
    t: 'hello',
    meta: { sessionId: 'relay-test-session', cwd: '/tmp/relay-project', project: 'relay-project' },
  })
})

test('the tool surface is unchanged from the single-session server', async () => {
  const res = await request('tools/list')
  const names = ((res.result as Rpc).tools as Array<{ name: string }>).map(t => t.name).sort()
  expect(names).toEqual([
    'download_attachment',
    'edit_message',
    'fetch_messages',
    'react',
    'reply',
  ])
})

test('a tool call is forwarded to the broker and its result returned', async () => {
  const pending = request('tools/call', {
    name: 'reply',
    arguments: { chat_id: '123', text: 'hello there' },
  })
  const call = await waitFor<Extract<ShimMsg, { t: 'call' }>>(m => m.t === 'call')
  expect(call.tool).toBe('reply')
  expect(call.args).toMatchObject({ chat_id: '123', text: 'hello there' })

  brokerConn!.write(encode({ t: 'result', id: call.id, ok: true, text: 'sent (id: 999)' }))
  const res = await pending
  const content = (res.result as Rpc).content as Array<{ text: string }>
  expect(content[0]!.text).toBe('sent (id: 999)')
})

test('a broker-side failure surfaces as an MCP tool error, not a hang', async () => {
  const pending = request('tools/call', {
    name: 'react',
    arguments: { chat_id: '123', message_id: '456', emoji: '👍' },
  })
  const call = await waitFor<Extract<ShimMsg, { t: 'call' }>>(
    m => m.t === 'call' && m.tool === 'react',
  )
  brokerConn!.write(
    encode({ t: 'result', id: call.id, ok: false, text: 'channel 123 is not allowlisted' }),
  )
  const res = await pending
  const result = res.result as Rpc
  expect(result.isError).toBe(true)
  expect((result.content as Array<{ text: string }>)[0]!.text).toContain('not allowlisted')
})

test('an inbound Discord message becomes a channel notification', async () => {
  notifications.length = 0
  brokerConn!.write(
    encode({
      t: 'inbound',
      content: 'ship it',
      meta: { chat_id: '123', message_id: '77', user: 'funalex', user_id: '9', ts: 'now' },
    }),
  )
  await Bun.sleep(300)
  const note = notifications.find(n => n.method === 'notifications/claude/channel')
  expect(note).toBeDefined()
  expect((note!.params as Rpc).content).toBe('ship it')
  expect((note!.params as Rpc).meta).toMatchObject({ chat_id: '123', user: 'funalex' })
})

test('a permission decision from Discord reaches Claude Code', async () => {
  notifications.length = 0
  brokerConn!.write(encode({ t: 'permission', request_id: 'abcde', behavior: 'allow' }))
  await Bun.sleep(300)
  const note = notifications.find(n => n.method === 'notifications/claude/channel/permission')
  expect(note).toBeDefined()
  expect(note!.params).toMatchObject({ request_id: 'abcde', behavior: 'allow' })
})

test('a permission request from Claude Code is relayed to the broker', async () => {
  notify('notifications/claude/channel/permission_request', {
    request_id: 'zyxwv',
    tool_name: 'Bash',
    description: 'run tests',
    input_preview: '{"command":"bun test"}',
  })
  const relayed = await waitFor(m => m.t === 'permission_request')
  expect(relayed).toMatchObject({ request_id: 'zyxwv', tool_name: 'Bash' })
})
