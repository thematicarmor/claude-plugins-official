/**
 * Wire protocol shared by the per-session MCP shim (server.ts) and the
 * single shared gateway daemon (broker.ts).
 *
 * Why a broker at all: Claude Code spawns a plugin's MCP server once per
 * session over stdio. A Discord bot token can only hold one gateway
 * connection — N sessions each opening their own means duplicated IDENTIFY,
 * dropped events, and session-limit rate limiting. So exactly one process
 * owns the gateway and every session talks to it over a unix socket.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const PROTOCOL_VERSION = 1

/**
 * Package version, used to spot a broker still running yesterday's code. The
 * broker is detached and outlives sessions, so without this a code update
 * would keep talking to the old process indefinitely.
 */
export const PLUGIN_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dir, 'package.json'), 'utf8')) as { version?: string })
      .version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

export const STATE_DIR =
  process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const SOCKET_PATH = process.env.DISCORD_BROKER_SOCK ?? join(STATE_DIR, 'broker.sock')
export const BROKER_LOG = join(STATE_DIR, 'broker.log')

/** Identity a session reports at registration. All derived from env + git. */
export type SessionMeta = {
  sessionId: string
  /** Working directory of the session. */
  cwd: string
  /** Basename of cwd — the label users actually recognise. */
  project: string
  gitBranch: string | null
  pid: number
  startedAt: number
  /**
   * Channel this session was spawned to serve, from `DISCORD_BIND_CHANNEL`.
   *
   * Sessions spawned by `/new` all share one cwd (the workspace root), so cwd
   * can no longer tell them apart. The broker sets this variable when it
   * launches the process, which makes the link between "channel I just
   * created" and "shim that just registered" exact rather than inferred.
   */
  bindChannel?: string
}

export type UsageSnapshot = {
  model: string | null
  /** Tokens resident in the context window as of the last assistant turn. */
  contextTokens: number
  contextLimit: number
  /** Cumulative across the session. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  turns: number
  updatedAt: number
}

/**
 * A step worth showing in a session's trace thread.
 *
 * Note what is absent: the model's reasoning. Claude Code writes `thinking`
 * blocks to the transcript with the text stripped — only an opaque signature
 * survives — so a trace is a log of *actions taken*, not of reasoning. Tool
 * calls and the assistant's own interstitial prose are the whole of what can
 * be recovered.
 */
export type TraceEvent =
  /** A new user turn began; opens a fresh thread. */
  | { k: 'turn'; n: number; prompt: string; at: number }
  /** A tool call, already summarised down to one line by the shim. */
  | { k: 'tool'; name: string; summary: string; at: number }
  /** What the tool returned, truncated — the useful half of reading a trace. */
  | { k: 'result'; name: string; preview: string; lines: number; at: number }
  /** Assistant prose between tool calls. */
  | { k: 'text'; text: string; at: number }

/** shim -> broker */
export type ShimMsg =
  | { t: 'hello'; v: number; version: string; meta: SessionMeta }
  | { t: 'bye'; sessionId: string }
  | { t: 'usage'; sessionId: string; usage: UsageSnapshot }
  | { t: 'trace'; sessionId: string; events: TraceEvent[] }
  | { t: 'call'; id: string; tool: string; args: Record<string, unknown> }
  | {
      t: 'permission_request'
      request_id: string
      tool_name: string
      description: string
      input_preview: string
    }

/** broker -> shim */
export type BrokerMsg =
  | { t: 'welcome'; v: number; version: string; pid: number }
  | { t: 'inbound'; content: string; meta: Record<string, string> }
  | { t: 'result'; id: string; ok: boolean; text: string }
  | { t: 'permission'; request_id: string; behavior: 'allow' | 'deny' }

/**
 * Newline-delimited JSON framing. A single oversized line (never produced by
 * us — only by a corrupt peer) is dropped rather than buffered forever.
 */
const MAX_LINE = 8 * 1024 * 1024

export function makeLineReader(onLine: (line: string) => void): (chunk: unknown) => void {
  let buf = ''
  return (chunk: unknown) => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) onLine(line)
    }
    if (buf.length > MAX_LINE) buf = ''
  }
}

export function encode(msg: ShimMsg | BrokerMsg): string {
  return JSON.stringify(msg) + '\n'
}
