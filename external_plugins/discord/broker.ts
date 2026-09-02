#!/usr/bin/env bun
/**
 * Discord channel broker — the single process that owns the gateway.
 *
 * Claude Code spawns a plugin MCP server per session. A bot token can only
 * hold one gateway connection, so instead of each session connecting, exactly
 * one broker connects and every session's shim (server.ts) talks to it over a
 * unix socket. The broker owns: the gateway, access.json, gating, pairing,
 * routing, slash commands, session spawning, trace threads, and channel
 * topics.
 *
 * Lifetime is independent of any one session — the first shim to find no
 * broker spawns one, and it keeps running while at least one session (or the
 * idle grace period) holds it.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  StringSelectMenuBuilder,
  ApplicationCommandOptionType,
  type ApplicationCommandDataResolvable,
  type Attachment,
  type Interaction,
  type Message,
  type TextChannel,
} from 'discord.js'
import { createServer, Socket } from 'net'
import { randomBytes } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { sep, join } from 'path'
import { homedir } from 'os'
import { execFileSync, type ExecFileSyncOptions } from 'child_process'
import {
  ACCESS_FILE,
  APPROVED_DIR,
  ENV_FILE,
  INBOX_DIR,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  STATE_DIR,
  encode,
  makeLineReader,
  type BrokerMsg,
  type SessionMeta,
  type ShimMsg,
  type TraceEvent,
  type UsageSnapshot,
} from './protocol.ts'
import { fmtTokens } from './usage.ts'
import { channelNameFor, tmuxNameFor } from './naming.ts'
import { Redactor } from './redact.ts'
import { SessionRegistry, label, pct, shortId, type Session } from './registry.ts'

// ── env ──────────────────────────────────────────────────────────────────────

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.DISCORD_BOT_TOKEN
const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'
/** Shut down this long after the last session disconnects. */
const IDLE_EXIT_MS = Number(process.env.DISCORD_BROKER_IDLE_MS ?? 10 * 60 * 1000)

function log(s: string): void {
  // Timestamped because the log's job is to be read after the fact: without
  // these there was no way to line a spawn up against the restart that killed it.
  process.stderr.write(`[broker] ${new Date().toISOString()} ${s}\n`)
}

if (!TOKEN) {
  log(`DISCORD_BOT_TOKEN required — set it in ${ENV_FILE}`)
  process.exit(1)
}

process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', err => log(`uncaught exception: ${err}`))

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// ── access state (unchanged semantics, moved off the per-session server) ─────

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = { requireMention: boolean; allowFrom: string[] }

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  /** Override the inferred context window used for usage percentages. */
  contextLimit?: number
  /** Mirror each turn's steps into a thread. Off unless switched on. */
  trace?: boolean
  /** Working directory for sessions spawned by /new. */
  spawnRoot?: string
  /** Category names for live and finished session channels. */
  sessionCategory?: string
  archiveCategory?: string
  /** Channels created by /new, so they can be cleaned up and recognised. */
  spawned?: Record<
    string,
    {
      name: string
      createdAt: number
      createdBy: string
      /**
       * Set when the session was suspended for idleness. Holds the Claude
       * session id so the next message in the channel can resume it with
       * `--resume` rather than starting a blank one.
       */
      suspendedSession?: string
      suspendedAt?: number
    }
  >
  /**
   * Idle time before a spawned session is suspended. Both the "spoken to" and
   * "producing output" clocks must be quiet this long. 0 disables suspension.
   */
  sessionIdleMs?: number
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      contextLimit: parsed.contextLimit,
      trace: parsed.trace,
      spawnRoot: parsed.spawnRoot,
      sessionCategory: parsed.sessionCategory,
      archiveCategory: parsed.archiveCategory,
      spawned: parsed.spawned ?? {},
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    log('access.json is corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        log('static mode — dmPolicy "pairing" downgraded to "allowlist"')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/** Anyone paired for DMs, or explicitly listed on the channel, may drive. */
function isOperator(access: Access, userId: string, channelId?: string): boolean {
  if (access.allowFrom.includes(userId)) return true
  if (channelId) {
    const g = access.groups[channelId]
    if (g && (g.allowFrom ?? []).includes(userId)) return true
  }
  return false
}

// ── session registry ─────────────────────────────────────────────────────────

/** Sockets live here rather than on Session so the registry stays net-free. */
const socks = new Map<string, Socket>()
const registry = new SessionRegistry()

function liveSessions(): Session[] {
  return registry.all()
}

function send(s: Session, msg: BrokerMsg): void {
  const sock = socks.get(s.meta.sessionId)
  if (!sock) return
  try {
    sock.write(encode(msg))
  } catch (e) {
    log(`write to session ${shortId(s.meta.sessionId)} failed: ${e}`)
  }
}

// ── discord ──────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

const recentSentIds = new Set<string>()
const RECENT_SENT_CAP = 200
const dmChannelUsers = new Map<string, string>()

function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

async function fetchTextChannel(id: string) {
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased()) throw new Error(`channel ${id} not found or not text-based`)
  return ch
}

/** Text-based is not the same as sendable — group DMs are one but not the other. */
async function fetchSendableChannel(id: string) {
  const ch = await fetchTextChannel(id)
  if (!('send' in ch)) throw new Error(`channel ${id} cannot be sent to`)
  return ch
}

/** A guild text channel, the only kind threads can be created under. */
async function fetchThreadParent(id: string): Promise<TextChannel> {
  const ch = await client.channels.fetch(id)
  if (!ch || ch.type !== ChannelType.GuildText) {
    throw new Error(`channel ${id} cannot hold threads`)
  }
  return ch as TextChannel
}

async function fetchAllowedChannel(id: string) {
  const ch = await fetchTextChannel(id)
  const access = loadAccess()
  if (ch.type === ChannelType.DM) {
    const userId = ch.recipientId ?? dmChannelUsers.get(id)
    if (userId && access.allowFrom.includes(userId)) return ch
  } else {
    const key = ch.isThread() ? (ch.parentId ?? ch.id) : ch.id
    if (key in access.groups) return ch
  }
  throw new Error(`channel ${id} is not allowlisted — add via /discord:access`)
}

function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
    )
  }
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? `${att.id}`
  const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

// ── gate ─────────────────────────────────────────────────────────────────────

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

async function isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true
  const refId = msg.reference?.messageId
  if (refId) {
    if (recentSentIds.has(refId)) return true
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === client.user?.id) return true
    } catch {}
  }
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(msg.content)) return true
    } catch {}
  }
  return false
}

async function gate(msg: Message): Promise<GateResult> {
  const access = loadAccess()
  if (pruneExpired(access)) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  const isThread = msg.channel.isThread()
  const channelId = isThread ? (msg.channel.parentId ?? msg.channelId) : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }

  // A channel dedicated to one session, or a thread inside it, is already an
  // explicit address — making the user @mention in it too would be friction.
  const parentId = isThread ? ((msg.channel as { parentId?: string | null }).parentId ?? null) : null
  const dedicated =
    registry.isBoundChannel(msg.channelId) || (parentId ? registry.isBoundChannel(parentId) : false)
  const requireMention = policy.requireMention ?? true
  if (requireMention && !dedicated && !(await isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

// ── pairing approvals ────────────────────────────────────────────────────────

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }
    void (async () => {
      try {
        const ch = await fetchTextChannel(dmChannelId)
        if ('send' in ch) await ch.send('Paired! Say hi to Claude.')
      } catch (err) {
        log(`failed to send approval confirm: ${err}`)
      } finally {
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ── tool execution (called on behalf of a session) ───────────────────────────

async function runTool(tool: string, args: Record<string, unknown>): Promise<string> {
  switch (tool) {
    case 'reply': {
      const chat_id = args.chat_id as string
      const text = args.text as string
      const reply_to = args.reply_to as string | undefined
      const files = (args.files as string[] | undefined) ?? []

      const ch = await fetchAllowedChannel(chat_id)
      if (!('send' in ch)) throw new Error('channel is not sendable')

      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`,
          )
        }
      }
      if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')

      const access = loadAccess()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'length'
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(text, limit, mode)
      const sentIds: string[] = []

      try {
        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo =
            reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          const sent = await ch.send({
            content: chunks[i],
            ...(i === 0 && files.length > 0 ? { files } : {}),
            ...(shouldReplyTo
              ? { reply: { messageReference: reply_to, failIfNotExists: false } }
              : {}),
          })
          noteSent(sent.id)
          sentIds.push(sent.id)
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${m}`)
      }
      return sentIds.length === 1
        ? `sent (id: ${sentIds[0]})`
        : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    }
    case 'fetch_messages': {
      const ch = await fetchAllowedChannel(args.channel as string)
      const limit = Math.min((args.limit as number) ?? 20, 100)
      const msgs = await ch.messages.fetch({ limit })
      const me = client.user?.id
      const arr = [...msgs.values()].reverse()
      if (arr.length === 0) return '(no messages)'
      return arr
        .map(m => {
          const who = m.author.id === me ? 'me' : m.author.username
          const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
          const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
          return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
        })
        .join('\n')
    }
    case 'react': {
      const ch = await fetchAllowedChannel(args.chat_id as string)
      const msg = await ch.messages.fetch(args.message_id as string)
      await msg.react(args.emoji as string)
      return 'reacted'
    }
    case 'edit_message': {
      const ch = await fetchAllowedChannel(args.chat_id as string)
      const msg = await ch.messages.fetch(args.message_id as string)
      const edited = await msg.edit(args.text as string)
      return `edited (id: ${edited.id})`
    }
    case 'download_attachment': {
      const ch = await fetchAllowedChannel(args.chat_id as string)
      const msg = await ch.messages.fetch(args.message_id as string)
      if (msg.attachments.size === 0) return 'message has no attachments'
      const lines: string[] = []
      for (const att of msg.attachments.values()) {
        const path = await downloadAttachment(att)
        const kb = (att.size / 1024).toFixed(0)
        lines.push(`  ${path}  (${safeAttName(att)}, ${att.contentType ?? 'unknown'}, ${kb}KB)`)
      }
      return `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}`
    }
    default:
      throw new Error(`unknown tool: ${tool}`)
  }
}

// ── spawned session channels ─────────────────────────────────────────────────

const WORKSPACE_ROOT = join(homedir(), 'workspace')

/** Directories a `claude` install lands in, newest node version first. */
function claudeBinDirs(): string[] {
  const nvm = join(homedir(), '.nvm', 'versions', 'node')
  let nvmBins: string[] = []
  try {
    nvmBins = readdirSync(nvm)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(v => join(nvm, v, 'bin'))
  } catch {}
  return [
    ...nvmBins,
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), 'bin'),
    '/usr/local/bin',
  ]
}

/**
 * The `claude` binary to spawn. Resolved rather than hardcoded: the systemd
 * unit points at an nvm path that changes with every Node upgrade.
 *
 * A login shell is not enough to find it. nvm puts its PATH entry in
 * ~/.bashrc, which returns early when the shell is not interactive, so
 * `bash -lc` resolves nothing, the bare name is left to tmux, and the session
 * exits on ENOENT the moment it starts — which surfaces as a session that died
 * rather than one that never had a binary to run.
 */
const CLAUDE_BIN: string = (() => {
  const fromEnv = process.env.CLAUDE_BIN
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  for (const flags of ['-lc', '-ic']) {
    try {
      const found = execFileSync('bash', [flags, 'command -v claude'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (found && existsSync(found)) return found
    } catch {}
  }
  const installed = claudeBinDirs()
    .map(d => join(d, 'claude'))
    .find(existsSync)
  if (installed) return installed
  log('no claude binary found on PATH or in the usual install dirs; set CLAUDE_BIN')
  return 'claude'
})()

/**
 * Spawned sessions get a tmux server of their own, on its own socket.
 *
 * The default server is claude-cc.service's forking main process, and that unit
 * is KillMode=control-group — so `systemctl stop|restart claude-cc`, which is
 * what `restart-cc` and `update-discord --restart` run, reaped every session in
 * the cgroup along with it. Only the systemd-managed session came back, which is
 * why a second concurrent session never survived long enough to be useful.
 */
const SESSION_SOCKET = 'cc-sessions'

/**
 * systemd-run reaches the user manager over the session bus, which the broker
 * does not inherit when it is started from inside a systemd-managed session.
 */
function userBusEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus`,
  }
}

/** Whether the sessions server is up — `list-sessions` fails when it is not. */
function sessionServerRunning(): boolean {
  try {
    execFileSync('tmux', ['-L', SESSION_SOCKET, 'list-sessions'], {
      timeout: 5_000,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Run a tmux command that may have to start the sessions server. A process
 * cannot fork its way out of a cgroup, so the invocation that starts the server
 * goes through `systemd-run --user --scope` to land in one that does not belong
 * to claude-cc.service. Sessions created later are spawned by the running server
 * and inherit that cgroup for free.
 */
function startOnSessionServer(tmuxArgs: string[]): void {
  const opts: ExecFileSyncOptions = { timeout: 20_000, stdio: ['ignore', 'ignore', 'pipe'] }
  if (sessionServerRunning()) {
    execFileSync('tmux', tmuxArgs, opts)
    return
  }
  try {
    execFileSync(
      'systemd-run',
      ['--user', '--scope', '--collect', '--quiet', '--', 'tmux', ...tmuxArgs],
      { ...opts, env: userBusEnv() },
    )
  } catch (e) {
    // A session that still dies with claude-cc beats no session at all, but say
    // so plainly — this is the exact condition the separate server exists to avoid.
    log(
      `systemd-run unavailable (${String(e).slice(0, 200)}); ` +
        `starting the sessions server in the broker's own cgroup, where a ` +
        `claude-cc restart will kill it`,
    )
    execFileSync('tmux', tmuxArgs, opts)
  }
}

/**
 * Whether the session is really running. `tmux new-session -d` exits 0 as soon
 * as the session exists, so a command that dies a moment later is independent
 * of that exit code; the settle wait is what distinguishes the two.
 */
async function sessionAppears(name: string): Promise<boolean> {
  let seen = false
  for (let i = 0; i < 10 && !seen; i++) {
    await new Promise(r => setTimeout(r, 200))
    seen = tmuxSessions().includes(name)
  }
  if (!seen) return false
  await new Promise(r => setTimeout(r, 1_500))
  return tmuxSessions().includes(name)
}

/** Where /new starts sessions. One root for all of them, by design: edits
 *  routinely span repos, so a session is not scoped to one. */
function spawnRoot(access: Access): string {
  return access.spawnRoot ?? WORKSPACE_ROOT
}

/** Repo names used only to prefix a channel name, never to pick a cwd. */
function knownRepos(access: Access): string[] {
  try {
    return readdirSync(spawnRoot(access), { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } catch {
    return []
  }
}

/** The channel /new was invoked from — home for announcements. */
function homeChannel(): string | null {
  const groups = Object.keys(loadAccess().groups)
  return groups.length > 0 ? groups[0]! : null
}

async function findOrCreateCategory(guild: import('discord.js').Guild, name: string) {
  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase(),
  )
  if (existing) return existing
  return guild.channels.create({ name, type: ChannelType.GuildCategory })
}

/**
 * Tasks queued for sessions that haven't registered yet, keyed by the channel
 * they were spawned for. Delivered as an ordinary inbound message once the
 * shim connects, which reuses the normal routing path rather than driving
 * keystrokes into tmux.
 */
const pendingTasks = new Map<string, { task: string; userId: string; username: string; at: number }>()
const SPAWN_TIMEOUT_MS = 90_000

setInterval(() => {
  const now = Date.now()
  for (const [channelId, p] of [...pendingTasks]) {
    if (now - p.at < SPAWN_TIMEOUT_MS) continue
    pendingTasks.delete(channelId)
    void (async () => {
      try {
        const ch = await fetchSendableChannel(channelId)
        // Alive-but-silent and gone are different faults and want different
        // next steps, so look before saying which one this is.
        const spawnedName = loadAccess().spawned?.[channelId]?.name
        const alive = spawnedName ? tmuxSessions().includes(tmuxNameFor(spawnedName)) : false
        await ch.send(
          alive
            ? 'That session started but never registered with the broker. ' +
                `\`tmux -L ${SESSION_SOCKET} attach\` to see what it is doing; ` +
                '`~/.claude/channels/discord/broker.log` has the detail.'
            : 'That session is gone — it exited before connecting. ' +
                `\`tmux -L ${SESSION_SOCKET} ls\` shows what is left; ` +
                '`~/.claude/channels/discord/broker.log` has the detail.',
        )
      } catch {}
    })()
  }
}, 15_000).unref()

/**
 * Create a channel and start a Claude session bound to it.
 *
 * The session is launched under tmux to match how the systemd-managed session
 * already runs, so `tmux attach -t <name>` keeps working from a terminal.
 */
async function spawnSession(
  guildId: string,
  task: string,
  userId: string,
  username: string,
): Promise<{ channelId: string; name: string; tmux: string }> {
  const access = loadAccess()
  const guild = await client.guilds.fetch(guildId)
  await guild.channels.fetch()

  const taken = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).map(c => c.name)
  const name = channelNameFor(task || 'session', knownRepos(access), taken)
  const category = await findOrCreateCategory(guild, access.sessionCategory ?? 'claude-sessions')

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Claude Code session · starting · ${spawnRoot(access)}`,
    reason: `Claude Code session spawned by ${username}`,
  })

  // Register the channel before launching, so the first thing the session says
  // is not rejected by the gate for arriving in an unknown channel.
  const a = loadAccess()
  a.groups[channel.id] = { requireMention: false, allowFrom: [userId] }
  a.spawned = { ...(a.spawned ?? {}), [channel.id]: { name, createdAt: Date.now(), createdBy: userId } }
  saveAccess(a)

  const tmux = tmuxNameFor(name)
  const cwd = spawnRoot(access)

  // A spawn that did not take should leave no half-made channel or stale access
  // entry behind for the operator to clear up by hand.
  const rollback = async (reason: string): Promise<void> => {
    const undo = loadAccess()
    delete undo.groups[channel.id]
    if (undo.spawned) delete undo.spawned[channel.id]
    saveAccess(undo)
    await channel.delete(reason).catch(() => {})
  }

  try {
    // -e keeps the binding out of the command line, where it would show in ps.
    startOnSessionServer(sessionTmuxArgs(tmux, cwd, channel.id))
  } catch (e) {
    await rollback('Claude Code session failed to start')
    throw e
  }

  // Trusting tmux's exit code was how a dead spawn came to look like a live one:
  // the channel stayed, nothing was listening in it, and the only sign was a
  // timeout message 90 seconds later.
  if (!(await sessionAppears(tmux))) {
    await rollback('Claude Code session exited immediately')
    log(`spawn died immediately: ${tmux} — channel ${channel.id} rolled back`)
    throw new Error(
      `the session started and exited immediately — nothing in \`tmux -L ${SESSION_SOCKET} ls\` ` +
        `for ${tmux}. It was launched as ${CLAUDE_BIN}.`,
    )
  }

  if (task.trim()) pendingTasks.set(channel.id, { task, userId, username, at: Date.now() })
  log(`spawned session in #${name} (tmux -L ${SESSION_SOCKET} ${tmux}, channel ${channel.id})`)
  return { channelId: channel.id, name, tmux }
}

/**
 * Called once a session's shim has registered. A session spawned by `/new`
 * claims its channel here and picks up the task that was queued for it —
 * delivered as an ordinary inbound message, so it travels the same path as
 * anything typed in the channel.
 */
async function onSessionReady(meta: SessionMeta): Promise<void> {
  const channelId = meta.bindChannel
  if (!channelId) return
  registry.bindChannel(meta.sessionId, channelId)
  // It came back, so whatever archive its disconnect scheduled is moot.
  cancelArchive(channelId)

  const s = registry.get(meta.sessionId)
  if (!s) return

  // A brand-new channel may be in a guild we haven't registered commands for.
  void registerCommands()

  try {
    const ch = await fetchSendableChannel(channelId)
    await ch.send(
      `Session \`${shortId(meta.sessionId)}\` is up — \`${meta.cwd}\`` +
        (meta.gitBranch ? ` on \`${meta.gitBranch}\`` : '') +
        `\nMessages here go straight to it. No mention needed.`,
    )
  } catch (e) {
    log(`greeting ${channelId} failed: ${e}`)
  }

  const queued = pendingTasks.get(channelId)
  if (!queued) return
  pendingTasks.delete(channelId)
  registry.touch(meta.sessionId)
  send(s, {
    t: 'inbound',
    content: queued.task,
    meta: {
      chat_id: channelId,
      user: queued.username,
      user_id: queued.userId,
      ts: new Date().toISOString(),
      session_id: meta.sessionId,
    },
  })
}

/** The systemd unit owns this one; killing it belongs to `restart-cc`. */
const PROTECTED_TMUX = 'cc'

function tmuxSessions(): string[] {
  try {
    return execFileSync('tmux', ['-L', SESSION_SOCKET, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Retire a spawned channel: rename, move to the archive category, and leave
 * it there. Nothing is deleted — a category caps at 50 channels, so these do
 * accumulate, but silently destroying a session's history is worse.
 */
/**
 * Archiving is deferred, because a disconnect is not the same as an ending.
 * A shim reconnects after a broker restart or a dropped socket, and retiring
 * its channel the instant the socket closed would rename a live session's
 * channel out from under it. `onSessionReady` cancels the pending archive.
 */
const pendingArchives = new Map<string, ReturnType<typeof setTimeout>>()
const ARCHIVE_GRACE_MS = 60_000

function scheduleArchive(channelId: string): void {
  if (pendingArchives.has(channelId)) return
  // A suspension also closes the socket, but that channel is still live —
  // archiving it would retire a session the user is about to come back to.
  if (loadAccess().spawned?.[channelId]?.suspendedSession) return
  const timer = setTimeout(() => {
    pendingArchives.delete(channelId)
    // Still gone after the grace period — now it has really ended.
    if (registry.isBoundChannel(channelId)) return
    void archiveChannel(channelId)
  }, ARCHIVE_GRACE_MS)
  timer.unref?.()
  pendingArchives.set(channelId, timer)
}

function cancelArchive(channelId: string): void {
  const timer = pendingArchives.get(channelId)
  if (!timer) return
  clearTimeout(timer)
  pendingArchives.delete(channelId)
}

/**
 * Retire a spawned channel and forget it. Forgetting is the point: `spawned`
 * and `groups` were only ever appended to, so they had grown to 27 and 28
 * entries against ten live sessions. A channel deleted in Discord drops its
 * access grant too; one that still exists keeps it, so the transcript stays
 * readable after the session behind it has gone.
 */
async function archiveChannel(channelId: string): Promise<void> {
  const access = loadAccess()
  if (!access.spawned?.[channelId]) return
  let deleted = false
  try {
    const ch = await client.channels.fetch(channelId)
    if (!ch || ch.type !== ChannelType.GuildText) return
    const text = ch as TextChannel
    if (!text.name.startsWith('✓')) {
      const category = await findOrCreateCategory(
        text.guild,
        access.archiveCategory ?? 'claude-archive',
      )
      await text.setParent(category.id, { lockPermissions: false })
      await text.setName(`✓-${text.name}`.slice(0, 100))
      await text.send('Session ended.')
    }
  } catch (e) {
    // 10003 is Unknown Channel: it was deleted in Discord, so there is nothing
    // to archive and no reason to keep granting access to it.
    deleted = typeof e === 'object' && e !== null && (e as { code?: number }).code === 10003
    if (!deleted) {
      log(`archive of ${channelId} failed: ${e}`)
      return // leave the entry so a later reconcile can retry
    }
  }
  forgetSpawned(channelId, deleted)
}

/** Drop a retired channel's bookkeeping. */
function forgetSpawned(channelId: string, alsoRevokeAccess: boolean): void {
  const a = loadAccess()
  if (a.spawned) delete a.spawned[channelId]
  if (alsoRevokeAccess) delete a.groups[channelId]
  saveAccess(a)
}

/**
 * Per-session memory bounds. The tmux *server* already runs in a systemd scope,
 * but every session started afterwards inherits that one cgroup — so a limit
 * set there would cap the whole pool rather than one session. Wrapping the
 * claude process itself gives each session a scope of its own, which is what
 * makes a runaway die alone instead of the kernel shooting whichever session
 * happens to be largest.
 */
const SESSION_MEMORY_HIGH = process.env.DISCORD_SESSION_MEMORY_HIGH ?? '1200M'
const SESSION_MEMORY_MAX = process.env.DISCORD_SESSION_MEMORY_MAX ?? '1600M'

/** tmux argv for a session, optionally resuming an existing Claude session. */
function sessionTmuxArgs(
  tmux: string,
  cwd: string,
  channelId: string,
  resumeId?: string,
): string[] {
  return [
    '-L', SESSION_SOCKET,
    'new-session', '-d',
    '-s', tmux,
    '-c', cwd,
    // -e keeps the binding out of the command line, where it would show in ps.
    '-e', `DISCORD_BIND_CHANNEL=${channelId}`,
    'systemd-run', '--user', '--scope', '--collect', '--quiet',
    `--property=MemoryHigh=${SESSION_MEMORY_HIGH}`,
    `--property=MemoryMax=${SESSION_MEMORY_MAX}`,
    '--',
    CLAUDE_BIN,
    '--channels', 'plugin:discord@claude-plugins-official',
    ...(resumeId ? ['--resume', resumeId] : []),
  ]
}

// ── idle suspension ──────────────────────────────────────────────────────────

/**
 * Sessions are suspended rather than ended. Killing the process reclaims the
 * ~400MB it holds, but the transcript outlives it, so the next message in the
 * channel resumes the same conversation with `--resume`. That distinction is
 * what makes a short timeout safe: this user habitually returns to a session
 * the next morning, and a reaper that destroyed context would throw away the
 * longest-running work on the machine.
 */
const DEFAULT_SESSION_IDLE_MS = 2 * 60 * 60 * 1000
const IDLE_SWEEP_MS = 5 * 60 * 1000

function sessionIdleMs(access: Access): number {
  return access.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS
}

async function suspendSession(s: Session): Promise<void> {
  const channelId = s.channelId
  if (!channelId) return
  const access = loadAccess()
  const entry = access.spawned?.[channelId]
  if (!entry) return // not ours to suspend

  const tmux = tmuxNameFor(entry.name)
  if (tmux === PROTECTED_TMUX) return
  try {
    execFileSync('tmux', ['-L', SESSION_SOCKET, 'kill-session', '-t', tmux], {
      timeout: 10_000,
      stdio: 'ignore',
    })
  } catch (e) {
    log(`suspend of ${tmux} failed: ${String(e).slice(0, 200)}`)
    return
  }

  // Recorded before the socket close lands, so the archive path can tell a
  // suspension from a session that really ended.
  const a = loadAccess()
  if (a.spawned?.[channelId]) {
    a.spawned[channelId].suspendedSession = s.meta.sessionId
    a.spawned[channelId].suspendedAt = Date.now()
    saveAccess(a)
  }
  log(`suspended ${shortId(s.meta.sessionId)} (${tmux}) after idle`)

  try {
    const ch = await client.channels.fetch(channelId)
    if (ch && ch.type === ChannelType.GuildText) {
      const hours = Math.round(sessionIdleMs(loadAccess()) / 3_600_000)
      await (ch as TextChannel).send(
        `Suspended after ${hours}h idle to free memory — its context is kept. ` +
          `Send a message here and it picks up where it left off.`,
      )
    }
  } catch {}
}

function sweepIdleSessions(): void {
  const access = loadAccess()
  const idleMs = sessionIdleMs(access)
  if (idleMs <= 0) return
  for (const s of registry.idleFor(idleMs)) {
    // Only spawned sessions are suspendable; the systemd one and any
    // hand-started session are left alone.
    if (!s.channelId || !access.spawned?.[s.channelId]) continue
    void suspendSession(s)
  }
}

/**
 * Bring back a session suspended from this channel. Returns false when there is
 * nothing to resume, so the caller can fall through to its usual handling.
 */
/**
 * Channels whose session died without a clean exit — an OOM kill, a reboot —
 * stay bound to a session that no longer exists, and nothing ever noticed
 * because archival only ran on a deliberate stop. Reconciling at startup is
 * what stops `spawned` growing without bound.
 */
async function reconcileSpawned(): Promise<void> {
  const access = loadAccess()
  const spawned = access.spawned ?? {}
  const live = new Set(tmuxSessions())
  let archived = 0
  for (const [channelId, entry] of Object.entries(spawned)) {
    if (entry.suspendedSession) continue // intentionally parked
    if (live.has(tmuxNameFor(entry.name))) continue
    if (registry.isBoundChannel(channelId)) continue
    await archiveChannel(channelId)
    archived++
  }
  if (archived > 0) {
    const left = Object.keys(loadAccess().spawned ?? {}).length
    log(`reconciled ${archived} channel(s) whose session was gone; ${left} tracked`)
  }
}

async function resumeSuspended(channelId: string): Promise<boolean> {
  const access = loadAccess()
  const entry = access.spawned?.[channelId]
  if (!entry?.suspendedSession) return false

  const tmux = tmuxNameFor(entry.name)
  if (tmuxSessions().includes(tmux)) return false // already running

  const cwd = spawnRoot(access)
  try {
    startOnSessionServer(sessionTmuxArgs(tmux, cwd, channelId, entry.suspendedSession))
  } catch (e) {
    log(`resume of ${tmux} failed: ${String(e).slice(0, 200)}`)
    return false
  }
  if (!(await sessionAppears(tmux))) {
    log(`resume died immediately: ${tmux}`)
    return false
  }

  const a = loadAccess()
  if (a.spawned?.[channelId]) {
    delete a.spawned[channelId].suspendedSession
    delete a.spawned[channelId].suspendedAt
    saveAccess(a)
  }
  cancelArchive(channelId)
  log(`resumed ${shortId(entry.suspendedSession)} into ${tmux}`)
  return true
}


/**
 * Discord's typing indicator lapses after about ten seconds, and a turn here
 * runs a median of two and a half minutes — so the single sendTyping() this
 * replaces left every observed turn looking dead long before the answer
 * arrived. Re-firing on an interval is the cheapest honest "still working".
 */
const TYPING_INTERVAL_MS = 8_000
const typingTimers = new Map<string, ReturnType<typeof setInterval>>()

function startTyping(sessionId: string, channel: unknown): void {
  stopTyping(sessionId)
  if (!channel || typeof channel !== 'object' || !('sendTyping' in channel)) return
  const send = () => void (channel as TextChannel).sendTyping().catch(() => {})
  send()
  const timer = setInterval(send, TYPING_INTERVAL_MS)
  timer.unref?.()
  typingTimers.set(sessionId, timer)
}

function stopTyping(sessionId: string): void {
  const timer = typingTimers.get(sessionId)
  if (!timer) return
  clearInterval(timer)
  typingTimers.delete(sessionId)
}


// ── trace threads ────────────────────────────────────────────────────────────

/**
 * A thread per turn, holding the steps taken to answer it.
 *
 * Lifecycle is driven by two events the broker already sees: a turn's first
 * trace event opens the thread, and the session posting its reply closes it.
 * Nothing infers turn boundaries from the transcript.
 *
 * Everything written here goes through the redactor. Tool arguments and tool
 * output are reproduced close to verbatim, and `Bash` is the most-used tool by
 * a wide margin, so this is the most likely path by which a secret would reach
 * a channel.
 */
const redactor = new Redactor()

type TraceThread = {
  threadId: string
  /** The message currently being appended to, and its text. */
  messageId: string | null
  buffer: string
  /** Pending lines not yet flushed to Discord. */
  queue: string[]
  flushTimer: ReturnType<typeof setTimeout> | null
  turn: number
}

const traceThreads = new Map<string, TraceThread>()
/** Highest turn number seen per session, for naming a thread opened mid-turn. */
const lastTurn = new Map<string, number>()
/** Last message we delivered to a session, so a thread can hang off it. */
const lastInboundMessage = new Map<string, { channelId: string; messageId: string }>()

const TRACE_MAX_MESSAGE = 1900
const TRACE_FLUSH_MS = 2_000

function traceEnabled(): boolean {
  return loadAccess().trace === true
}

async function openTraceThread(s: Session, turn: number, prompt: string): Promise<TraceThread | null> {
  const anchor = lastInboundMessage.get(s.meta.sessionId)
  const channelId = anchor?.channelId ?? s.channelId
  if (!channelId) return null
  try {
    const parent = await fetchThreadParent(channelId)
    const title = `💭 ${prompt ? prompt.slice(0, 60) : `turn ${turn}`}`
    let thread
    if (anchor?.messageId && anchor.channelId === channelId) {
      const msg = await parent.messages.fetch(anchor.messageId).catch(() => null)
      thread = msg
        ? await msg.startThread({ name: title.slice(0, 100), autoArchiveDuration: 60 })
        : null
    }
    if (!thread) {
      thread = await parent.threads.create({
        name: title.slice(0, 100),
        autoArchiveDuration: 60,
        reason: 'Claude Code trace',
      })
    }
    return { threadId: thread.id, messageId: null, buffer: '', queue: [], flushTimer: null, turn }
  } catch (e) {
    log(`trace thread create failed: ${e}`)
    return null
  }
}

/**
 * Appends by editing one message rather than posting per event. Per-event
 * posting would exceed the 5-messages-per-5s channel limit within a single
 * turn of ordinary tool use.
 */
async function flushTrace(t: TraceThread): Promise<void> {
  if (t.queue.length === 0) return
  const lines = t.queue.splice(0, t.queue.length)
  try {
    const thread = await client.channels.fetch(t.threadId)
    if (!thread || !thread.isThread()) return
    for (const raw of lines) {
      const line = raw.slice(0, TRACE_MAX_MESSAGE)
      const fits = t.messageId !== null && t.buffer.length + line.length + 1 <= TRACE_MAX_MESSAGE
      if (fits) {
        const grown = `${t.buffer}\n${line}`
        const msg = await thread.messages.fetch(t.messageId!).catch(() => null)
        if (msg) {
          await msg.edit(grown)
          t.buffer = grown
          continue
        }
        // The message we were appending to is gone; start a new one below.
        t.messageId = null
      }
      const sent = await thread.send(line)
      t.messageId = sent.id
      t.buffer = line
    }
  } catch (e) {
    log(`trace flush failed: ${e}`)
  }
}

function queueTrace(sessionId: string, line: string): void {
  const t = traceThreads.get(sessionId)
  if (!t) return
  t.queue.push(line)
  if (t.flushTimer) return
  t.flushTimer = setTimeout(() => {
    t.flushTimer = null
    void flushTrace(t)
  }, TRACE_FLUSH_MS)
  t.flushTimer.unref?.()
}

function renderTrace(e: TraceEvent): string | null {
  switch (e.k) {
    case 'tool':
      return `▸ \`${redactor.redact(e.summary).slice(0, 300)}\``
    case 'result': {
      const body = redactor.redact(e.preview)
      const suffix = e.lines > 1 ? ` _(${e.lines} lines)_` : ''
      return `   ↳ ${e.name === 'error' ? '⚠️ ' : ''}${body.replace(/\n/g, ' ⏎ ').slice(0, 400)}${suffix}`
    }
    case 'text':
      return `> ${redactor.redact(e.text).replace(/\n/g, '\n> ').slice(0, 700)}`
    default:
      return null
  }
}

/**
 * Trace batches arrive every couple of seconds and each one awaits Discord
 * calls, so without a queue two batches could interleave and open two threads
 * for one turn. Work is chained per session instead.
 */
const traceQueue = new Map<string, Promise<void>>()

function onTrace(s: Session, events: TraceEvent[]): void {
  const id = s.meta.sessionId
  const next = (traceQueue.get(id) ?? Promise.resolve())
    .then(() => applyTrace(s, events))
    .catch(e => log(`trace handling failed: ${e}`))
  traceQueue.set(id, next)
  void next.finally(() => {
    if (traceQueue.get(id) === next) traceQueue.delete(id)
  })
}

async function applyTrace(s: Session, events: TraceEvent[]): Promise<void> {
  if (!traceEnabled()) return
  for (const e of events) {
    if (e.k === 'turn') {
      lastTurn.set(s.meta.sessionId, e.n)
      // A new turn supersedes whatever thread was open.
      await closeTraceThread(s.meta.sessionId)
      const t = await openTraceThread(s, e.n, redactor.redact(e.prompt))
      if (t) traceThreads.set(s.meta.sessionId, t)
      continue
    }
    if (!traceThreads.has(s.meta.sessionId)) {
      // Steps arriving with no open thread — a turn that began before tracing
      // was switched on, or one whose thread was closed by a reply and then
      // continued — still deserve somewhere to land.
      const n = (lastTurn.get(s.meta.sessionId) ?? 0) + 1
      lastTurn.set(s.meta.sessionId, n)
      const t = await openTraceThread(s, n, '')
      if (t) traceThreads.set(s.meta.sessionId, t)
    }
    const line = renderTrace(e)
    if (line) queueTrace(s.meta.sessionId, line)
  }
}

/**
 * Flush what's pending, then archive — the turn is over.
 *
 * The entry is removed first so a step arriving mid-close opens a fresh
 * thread rather than appending to one being archived.
 */
async function closeTraceThread(sessionId: string): Promise<void> {
  const t = traceThreads.get(sessionId)
  if (!t) return
  traceThreads.delete(sessionId)
  if (t.flushTimer) {
    clearTimeout(t.flushTimer)
    t.flushTimer = null
  }
  await flushTrace(t)
  try {
    const thread = await client.channels.fetch(t.threadId)
    if (thread?.isThread()) await thread.setArchived(true)
  } catch (e) {
    log(`trace thread archive failed: ${e}`)
  }
}

// ── status in channel topics ─────────────────────────────────────────────────

/**
 * Channel topics carry the status that used to live in the bot's presence.
 *
 * The trade is deliberate: a topic is per-channel, so each session's own
 * channel can show its own usage, where presence is global to the bot. The
 * cost is cadence — channel edits are rate-limited far harder than presence
 * (roughly 2 per 10 minutes per channel, against 5 per 20s), so this runs on a
 * 5-minute timer with state changes allowed to jump the queue. `/status` stays
 * the surface for an answer that is accurate right now.
 */
const TOPIC_INTERVAL_MS = 5 * 60 * 1000
const lastTopic = new Map<string, string>()
const topicWrittenAt = new Map<string, number>()
let topicTimer: ReturnType<typeof setTimeout> | null = null

function sessionTopic(s: Session): string {
  const p = pct(s.usage)
  const bits = [label(s), p === null ? 'starting' : `${p}% ctx`]
  if (s.usage) bits.push(`${s.usage.turns} turns`)
  return `Claude Code · ${bits.join(' · ')}`
}

function aggregateTopic(): string {
  const live = liveSessions()
  if (live.length === 0) return 'Claude Code · idle · no sessions'
  const focused = live[0]!
  const p = pct(focused.usage)
  const ctx = p === null ? 'starting' : `${p}% ctx`
  return live.length === 1
    ? `Claude Code · ${label(focused)} · ${ctx}`
    : `Claude Code · ${live.length} sessions · ${label(focused)} ${ctx}`
}

async function writeTopic(channelId: string, text: string): Promise<void> {
  if (lastTopic.get(channelId) === text) return
  const last = topicWrittenAt.get(channelId) ?? 0
  if (Date.now() - last < TOPIC_INTERVAL_MS) return
  try {
    const ch = await client.channels.fetch(channelId)
    if (!ch || ch.type !== ChannelType.GuildText) return
    await (ch as TextChannel).setTopic(text.slice(0, 1024))
    lastTopic.set(channelId, text)
    topicWrittenAt.set(channelId, Date.now())
  } catch (e) {
    // A 429 here is expected under churn; the next tick tries again.
    log(`topic update failed for ${channelId}: ${e}`)
  }
}

async function updateTopics(): Promise<void> {
  if (!client.isReady()) return
  const access = loadAccess()
  for (const s of liveSessions()) {
    if (s.channelId) await writeTopic(s.channelId, sessionTopic(s))
  }
  for (const channelId of Object.keys(access.groups)) {
    if (registry.isBoundChannel(channelId)) continue
    if (access.spawned?.[channelId]) continue
    await writeTopic(channelId, aggregateTopic())
  }
}

/**
 * Coalescing scheduler: a burst of registrations produces one write, and a
 * quiet period still refreshes on the interval.
 */
function scheduleTopicUpdate(immediate = false): void {
  if (topicTimer) return
  topicTimer = setTimeout(
    () => {
      topicTimer = null
      void updateTopics()
    },
    immediate ? 1_500 : TOPIC_INTERVAL_MS,
  )
  topicTimer.unref?.()
}

setInterval(() => scheduleTopicUpdate(), TOPIC_INTERVAL_MS).unref()

function usageEmbed(): EmbedBuilder {
  const live = liveSessions()
  const embed = new EmbedBuilder()
    .setTitle(live.length === 1 ? 'Session' : `${live.length} sessions`)
    .setColor(0xd97757)
  if (live.length === 0) {
    embed.setDescription('No Claude Code sessions are connected.')
    return embed
  }
  const focusedId = live[0]!.meta.sessionId
  for (const s of live.slice(0, 20)) {
    const u = s.usage
    const p = pct(u)
    const mark = s.meta.sessionId === focusedId ? '▸ ' : ''
    const bar = p === null ? '' : `${'█'.repeat(Math.round(p / 10))}${'░'.repeat(10 - Math.round(p / 10))} ${p}%`
    const lines = [
      u
        ? `ctx ${bar} (${fmtTokens(u.contextTokens)} / ${fmtTokens(u.contextLimit)})`
        : 'ctx — waiting for first turn',
      u ? `in ${fmtTokens(u.inputTokens)} · out ${fmtTokens(u.outputTokens)} · cached ${fmtTokens(u.cacheReadTokens)} · ${u.turns} turns` : '',
      u?.model ? `model \`${u.model}\`` : '',
      s.channelId ? `<#${s.channelId}>` : '',
    ].filter(Boolean)
    embed.addFields({
      name: `${mark}${label(s)} · ${shortId(s.meta.sessionId)}`,
      value: lines.join('\n').slice(0, 1024),
      inline: false,
    })
  }
  embed.setFooter({ text: '▸ receives messages sent to the channel root' })
  return embed
}

// ── slash commands ───────────────────────────────────────────────────────────

const COMMANDS: ApplicationCommandDataResolvable[] = [
  { name: 'status', description: 'Show connected Claude Code sessions and their token usage' },
  { name: 'sessions', description: 'List sessions and switch which one the channel talks to' },
  {
    name: 'new',
    description: 'Start a Claude Code session in a channel of its own',
    options: [
      {
        name: 'task',
        description: 'What it should start on (also names the channel)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
  {
    name: 'kill',
    description: 'Stop a spawned session and archive its channel',
    options: [
      {
        name: 'session',
        description: 'Session id, or leave blank for the one in this channel',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
  {
    name: 'plan',
    description: 'Ask the focused session to plan a task without making changes',
    options: [
      {
        name: 'task',
        description: 'What to plan',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: 'review',
    description: 'Run a code review in the focused session',
    options: [
      {
        name: 'target',
        description: 'PR number, branch, or path (default: the current diff)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
      {
        name: 'effort',
        description: 'Review depth (default: medium)',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: 'low', value: 'low' },
          { name: 'medium', value: 'medium' },
          { name: 'high', value: 'high' },
          { name: 'max', value: 'max' },
        ],
      },
    ],
  },
]

async function registerCommands(): Promise<void> {
  const access = loadAccess()
  const guildIds = new Set<string>()
  for (const channelId of Object.keys(access.groups)) {
    try {
      const ch = await client.channels.fetch(channelId)
      const gid = ch && 'guildId' in ch ? (ch.guildId as string | null) : null
      if (gid) guildIds.add(gid)
    } catch {}
  }
  for (const gid of guildIds) {
    try {
      const guild = await client.guilds.fetch(gid)
      await guild.commands.set(COMMANDS)
      log(`registered ${COMMANDS.length} commands in guild ${gid}`)
    } catch (e) {
      log(`command registration failed for guild ${gid}: ${e}`)
    }
  }
}

/**
 * Commands become ordinary inbound turns for the target session. The marker
 * lives in meta, never in content — an in-content tag would be forgeable by
 * anyone who can type in the channel.
 */
function dispatchDirective(
  s: Session,
  kind: string,
  content: string,
  chatId: string,
  userId: string,
  username: string,
): void {
  registry.touch(s.meta.sessionId)
  send(s, {
    t: 'inbound',
    content,
    meta: {
      chat_id: chatId,
      user: username,
      user_id: userId,
      ts: new Date().toISOString(),
      command: kind,
      session_id: s.meta.sessionId,
    },
  })
}

// ── permission relay ─────────────────────────────────────────────────────────

/**
 * Which session asked. With one session this was implicit; with several the
 * prompt is meaningless unless it says whose it is, and the answer has to go
 * back to the session that asked.
 */
const pendingPermissions = new Map<
  string,
  { sessionId: string; tool_name: string; description: string; input_preview: string }
>()

async function relayPermissionRequest(
  sessionId: string,
  request_id: string,
  tool_name: string,
  description: string,
  input_preview: string,
): Promise<void> {
  pendingPermissions.set(request_id, { sessionId, tool_name, description, input_preview })
  const access = loadAccess()
  const s = registry.get(sessionId)
  const who = s ? ` · ${label(s)}` : ''
  const text = `🔐 Permission: ${tool_name}${who}`
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`perm:more:${request_id}`)
      .setLabel('See more')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`perm:allow:${request_id}`)
      .setLabel('Allow')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`perm:deny:${request_id}`)
      .setLabel('Deny')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  )
  // A session with its own channel prompts there, so the request sits next to
  // the work that triggered it. Otherwise fall back to DMing the operators.
  if (s?.channelId) {
    try {
      const th = await fetchTextChannel(s.channelId)
      if ('send' in th) {
        const sent = await th.send({ content: text, components: [row] })
        noteSent(sent.id)
        return
      }
    } catch (e) {
      log(`permission prompt to channel failed, falling back to DM: ${e}`)
    }
  }
  for (const userId of access.allowFrom) {
    void (async () => {
      try {
        const user = await client.users.fetch(userId)
        await user.send({ content: text, components: [row] })
      } catch (e) {
        log(`permission_request send to ${userId} failed: ${e}`)
      }
    })()
  }
}

// ── interactions ─────────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await onCommand(interaction)
    if (interaction.isStringSelectMenu()) return await onSelect(interaction)
    if (interaction.isButton()) return await onButton(interaction)
  } catch (e) {
    log(`interaction handler failed: ${e}`)
  }
})

async function onCommand(interaction: import('discord.js').ChatInputCommandInteraction) {
  const access = loadAccess()
  const rootId = interaction.channel?.isThread()
    ? (interaction.channel.parentId ?? interaction.channelId)
    : interaction.channelId
  if (!isOperator(access, interaction.user.id, rootId)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true })
    return
  }

  if (interaction.commandName === 'status') {
    await interaction.reply({ embeds: [usageEmbed()] })
    return
  }

  if (interaction.commandName === 'sessions') {
    const live = liveSessions()
    if (live.length === 0) {
      await interaction.reply({ content: 'No sessions connected.', ephemeral: true })
      return
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId('sess:focus')
      .setPlaceholder('Send channel messages to…')
      .addOptions(
        live.slice(0, 25).map(s => ({
          label: `${label(s)} · ${shortId(s.meta.sessionId)}`.slice(0, 100),
          description: s.meta.cwd.slice(0, 100),
          value: s.meta.sessionId,
        })),
      )
    await interaction.reply({
      embeds: [usageEmbed()],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    })
    return
  }

  if (interaction.commandName === 'new') {
    const task = interaction.options.getString('task') ?? ''
    if (!interaction.guildId) {
      await interaction.reply({ content: '`/new` needs a server channel.', ephemeral: true })
      return
    }
    await interaction.deferReply()
    try {
      const { channelId, name, tmux } = await spawnSession(
        interaction.guildId,
        task,
        interaction.user.id,
        interaction.user.username,
      )
      await interaction.editReply(
        `Started **#${name}** — <#${channelId}>\n` +
          `\`tmux -L ${SESSION_SOCKET} attach -t ${tmux}\` to drive it from a terminal.` +
          (task ? '\nIts first task is queued and runs as soon as it connects.' : ''),
      )
    } catch (e) {
      log(`spawn failed: ${e}`)
      await interaction.editReply(`Could not start a session: ${String(e).slice(0, 400)}`)
    }
    return
  }

  if (interaction.commandName === 'kill') {
    const wanted = interaction.options.getString('session')
    const s = wanted
      ? (liveSessions().find(x => x.meta.sessionId.startsWith(wanted)) ?? null)
      : registry.ownerOfChannel(rootId)
    if (!s) {
      await interaction.reply({
        content: wanted ? 'No session with that id.' : 'No session owns this channel — pass one.',
        ephemeral: true,
      })
      return
    }
    await interaction.deferReply()
    const name = tmuxNameFor(loadAccess().spawned?.[s.channelId ?? '']?.name ?? '')
    const target = tmuxSessions().find(t => t === name)
    if (!target) {
      await interaction.editReply(
        `That session has no tmux session I can stop${
          s.channelId ? '' : ''
        } — it may be the systemd-managed one. Use \`restart-cc\` for that.`,
      )
      return
    }
    if (target === PROTECTED_TMUX) {
      await interaction.editReply('That one is managed by systemd — use `restart-cc`.')
      return
    }
    try {
      execFileSync('tmux', ['-L', SESSION_SOCKET, 'kill-session', '-t', target], {
        timeout: 10_000,
        stdio: 'ignore',
      })
      await interaction.editReply(`Stopped \`${target}\`. Archiving its channel.`)
      if (s.channelId) await archiveChannel(s.channelId)
    } catch (e) {
      await interaction.editReply(`Could not stop it: ${String(e).slice(0, 300)}`)
    }
    return
  }

  // /plan and /review target whichever session the channel is pointed at.
  const target =
    registry.routeForMessage(interaction.channelId, rootId) ?? registry.routeFor(rootId)

  if (!target) {
    await interaction.reply({ content: 'No sessions connected.', ephemeral: true })
    return
  }

  if (interaction.commandName === 'plan') {
    const task = interaction.options.getString('task', true)
    dispatchDirective(
      target,
      'plan',
      'Enter plan mode (the EnterPlanMode tool) and work out an approach for the task below. ' +
        'Research as needed, but make no edits or commits yet. When the plan is ready, post it ' +
        'to Discord with the reply tool and wait for approval before exiting plan mode.\n\n' +
        `Task: ${task}`,
      interaction.channelId,
      interaction.user.id,
      interaction.user.username,
    )
    await interaction.reply(`🧭 Planning in **${label(target)}** — \`${shortId(target.meta.sessionId)}\``)
    return
  }

  if (interaction.commandName === 'review') {
    const tgt = interaction.options.getString('target')
    const effort = interaction.options.getString('effort') ?? 'medium'
    dispatchDirective(
      target,
      'review',
      `Run the code-review skill at ${effort} effort on ${tgt ? `\`${tgt}\`` : 'the current diff'}. ` +
        'The findings belong on the pull request, not only in chat: if the branch under ' +
        'review has no open PR, push it and open one (draft is fine) first, then pass ' +
        '--comment so the findings land as inline PR comments. ' +
        'Then reply in Discord with the PR link and a one-line summary per finding, most ' +
        'severe first, each with file:line. Do not apply fixes unless asked.',
      interaction.channelId,
      interaction.user.id,
      interaction.user.username,
    )
    await interaction.reply(
      `🔍 Reviewing ${tgt ? `\`${tgt}\`` : 'the current diff'} in **${label(target)}** — \`${shortId(target.meta.sessionId)}\``,
    )
    return
  }
}

async function onSelect(interaction: import('discord.js').StringSelectMenuInteraction) {
  if (interaction.customId !== 'sess:focus') return
  const access = loadAccess()
  const rootId = interaction.channel?.isThread()
    ? (interaction.channel.parentId ?? interaction.channelId)
    : interaction.channelId
  if (!isOperator(access, interaction.user.id, rootId)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true })
    return
  }
  const chosen = interaction.values[0]!
  const s = registry.get(chosen)
  if (!s || !registry.setFocus(rootId, chosen)) {
    await interaction.reply({ content: 'That session has disconnected.', ephemeral: true })
    return
  }
  registry.touch(chosen)
  scheduleTopicUpdate(true)
  await interaction.reply(`▸ Channel messages now go to **${label(s)}** — \`${shortId(chosen)}\``)
}

async function onButton(interaction: import('discord.js').ButtonInteraction) {
  const access = loadAccess()

  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(interaction.customId)
  if (!m) return
  if (!access.allowFrom.includes(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m
  const entry = pendingPermissions.get(request_id!)

  if (behavior === 'more') {
    if (!entry) {
      await interaction.reply({ content: 'Details no longer available.', ephemeral: true }).catch(() => {})
      return
    }
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(entry.input_preview), null, 2)
    } catch {
      prettyInput = entry.input_preview
    }
    const s = registry.get(entry.sessionId)
    const expanded =
      `🔐 Permission: ${entry.tool_name}${s ? ` · ${label(s)}` : ''}\n\n` +
      `tool_name: ${entry.tool_name}\n` +
      `description: ${entry.description}\n` +
      `input_preview:\n${prettyInput}`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm:allow:${request_id}`)
        .setLabel('Allow')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm:deny:${request_id}`)
        .setLabel('Deny')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    )
    await interaction.update({ content: expanded.slice(0, 1900), components: [row] }).catch(() => {})
    return
  }

  answerPermission(request_id!, behavior as 'allow' | 'deny')
  const label_ = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await interaction
    .update({ content: `${interaction.message.content}\n\n${label_}`, components: [] })
    .catch(() => {})
}

/** Route a decision back to the session that asked for it. */
function answerPermission(request_id: string, behavior: 'allow' | 'deny'): void {
  const entry = pendingPermissions.get(request_id)
  pendingPermissions.delete(request_id)
  const msg: BrokerMsg = { t: 'permission', request_id, behavior }
  if (entry) {
    const s = registry.get(entry.sessionId)
    if (s) {
      send(s, msg)
      return
    }
  }
  // Unknown request (broker restarted mid-prompt) — every session ignores ids
  // it isn't waiting on, so a broadcast is safe and beats dropping the answer.
  for (const s of registry.all()) send(s, msg)
}

// ── inbound ──────────────────────────────────────────────────────────────────

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  handleInbound(msg).catch(e => log(`handleInbound failed: ${e}`))
})

async function handleInbound(msg: Message): Promise<void> {
  const result = await gate(msg)
  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await msg.reply(`${lead} — run in Claude Code:\n\n/discord:access pair ${result.code}`)
    } catch (err) {
      log(`failed to send pairing code: ${err}`)
    }
    return
  }

  const chat_id = msg.channelId
  if (msg.channel.type === ChannelType.DM) dmChannelUsers.set(chat_id, msg.author.id)

  // Permission replies are answered by the broker directly — they're never
  // relayed to a session as chat.
  const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
  if (permMatch) {
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    answerPermission(permMatch[2]!.toLowerCase(), behavior)
    void msg.react(behavior === 'allow' ? '✅' : '❌').catch(() => {})
    return
  }

  // Route: a session's own channel is unambiguous, and so is a thread inside
  // it; anywhere else follows focus.
  const parentId = msg.channel.isThread() ? (msg.channel.parentId ?? null) : null
  const target = registry.routeForMessage(chat_id, parentId)

  if (!target) {
    // The channel may own a suspended session; bring it back and let the user
    // resend rather than reporting nothing is connected.
    if (await resumeSuspended(parentId ?? chat_id)) {
      await msg
        .reply('Resuming that session — it will pick up your message shortly.')
        .then(m => noteSent(m.id))
        .catch(() => {})
      pendingTasks.set(parentId ?? chat_id, {
        task: msg.content,
        userId: msg.author.id,
        username: msg.author.username,
        at: Date.now(),
      })
      return
    }
    await msg
      .reply('No Claude Code session is connected right now.')
      .then(m => noteSent(m.id))
      .catch(() => {})
    return
  }
  registry.touch(target.meta.sessionId)

  startTyping(target.meta.sessionId, msg.channel)

  const access = result.access
  if (access.ackReaction) void msg.react(access.ackReaction).catch(() => {})

  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }
  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  send(target, {
    t: 'inbound',
    content,
    meta: {
      chat_id,
      message_id: msg.id,
      user: msg.author.username,
      user_id: msg.author.id,
      ts: msg.createdAt.toISOString(),
      session_id: target.meta.sessionId,
      ...(atts.length > 0
        ? { attachment_count: String(atts.length), attachments: atts.join('; ') }
        : {}),
    },
  })
  // Remembered so this turn's trace thread can hang off the message that
  // started it. Threads can't nest, so a message already inside one anchors
  // to its parent channel instead.
  lastInboundMessage.set(target.meta.sessionId, {
    channelId: parentId ?? chat_id,
    messageId: parentId ? '' : msg.id,
  })
  scheduleTopicUpdate(true)
}

// ── socket server ────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | null = null

function armIdleExit(): void {
  if (idleTimer) clearTimeout(idleTimer)
  // Under a supervisor the exit is pointless churn: systemd restarts the broker
  // immediately, and in the gap the bot is simply absent from Discord. 0 keeps
  // it resident.
  if (IDLE_EXIT_MS <= 0) return
  if (registry.size > 0) return
  idleTimer = setTimeout(() => {
    if (registry.size === 0) {
      log('no sessions for the idle grace period — exiting')
      shutdown()
    }
  }, IDLE_EXIT_MS)
  idleTimer.unref?.()
}

function onConnection(sock: Socket): void {
  let sessionId: string | null = null
  sock.setNoDelay(true)

  const read = makeLineReader(line => {
    let msg: ShimMsg
    try {
      msg = JSON.parse(line) as ShimMsg
    } catch {
      return
    }
    switch (msg.t) {
      case 'hello': {
        const meta = msg.meta as SessionMeta
        sessionId = meta.sessionId
        // A reconnect for a session we already hold: drop the old socket
        // rather than leaving two live connections for one session.
        const prev = socks.get(sessionId)
        if (prev && prev !== sock) prev.destroy()
        registry.add(meta)
        socks.set(sessionId, sock)
        log(`session ${shortId(sessionId)} registered (${meta.project}, pid ${meta.pid})`)
        sock.write(encode({ t: 'welcome', v: PROTOCOL_VERSION, version: PLUGIN_VERSION, pid: process.pid }))
        // A shim from a newer build means the plugin was updated under us.
        // Step aside once we're the only thing holding it up — the shim will
        // reconnect and start a broker running the new code.
        if (msg.version && msg.version !== PLUGIN_VERSION && registry.size <= 1) {
          log(`shim is version ${msg.version}, broker is ${PLUGIN_VERSION} — stepping aside`)
          setTimeout(shutdown, 250)
          break
        }
        if (idleTimer) clearTimeout(idleTimer)
        scheduleTopicUpdate(true)
        void onSessionReady(meta)
        break
      }
      case 'usage': {
        registry.setUsage(msg.sessionId, msg.usage)
        // Transcript growth is the only signal that distinguishes a session
        // working alone from one that has been abandoned.
        registry.progress(msg.sessionId)
        scheduleTopicUpdate(true)
        break
      }
      case 'trace': {
        const s = registry.get(msg.sessionId)
        if (s) onTrace(s, msg.events)
        break
      }
      case 'call': {
        void (async () => {
          let reply: BrokerMsg
          try {
            reply = { t: 'result', id: msg.id, ok: true, text: await runTool(msg.tool, msg.args) }
            // The answer has been posted, so this turn's trace is complete.
            // A later step reopens a thread; that is the intended rhythm.
            if (msg.tool === 'reply' && sessionId) {
              stopTyping(sessionId)
              await closeTraceThread(sessionId)
            }
          } catch (e) {
            reply = {
              t: 'result',
              id: msg.id,
              ok: false,
              text: e instanceof Error ? e.message : String(e),
            }
          }
          // The session may have gone away while the call was in flight.
          try {
            sock.write(encode(reply))
          } catch {}
        })()
        break
      }
      case 'permission_request': {
        if (!sessionId) break
        void relayPermissionRequest(
          sessionId,
          msg.request_id,
          msg.tool_name,
          msg.description,
          msg.input_preview,
        )
        break
      }
      case 'bye': {
        sock.end()
        break
      }
    }
  })

  sock.on('data', read)
  sock.on('error', () => {})
  sock.on('close', () => {
    if (!sessionId) return
    // If the shim reconnected before we saw this close, the registration now
    // belongs to the newer socket — tearing it down here would silently
    // unroute a session that is in fact connected.
    if (socks.get(sessionId) !== sock) return
    socks.delete(sessionId)
    const gone = registry.remove(sessionId)
    stopTyping(sessionId)
    void closeTraceThread(sessionId)
    lastInboundMessage.delete(sessionId)
    lastTurn.delete(sessionId)
    log(`session ${shortId(sessionId)} disconnected`)
    // A spawned session's channel is retired with it; the control channel and
    // any hand-started session keep theirs.
    if (gone?.channelId) scheduleArchive(gone.channelId)
    scheduleTopicUpdate(true)
    armIdleExit()
  })
}

/**
 * Set only by claude-broker.service. INVOCATION_ID looks like the obvious
 * marker and is not one: systemd sets it for every process in a unit and
 * children inherit it, so a broker the shim started inside claude-cc.service
 * reported itself supervised, refused to stand down, and fought the real one.
 */
const SUPERVISED = process.env.CLAUDE_BROKER_SUPERVISED === '1'
const PID_PATH = join(STATE_DIR, 'broker.pid')
const BROKER_UNIT = 'claude-broker.service'

/**
 * A shim starts a broker whenever it finds no socket. Once the job belongs to a
 * unit that is the wrong instinct: every handover briefly frees the socket, the
 * shims pile into that gap, and the supervised broker spends its life taking
 * over from replacements it caused — 31 of them in one observed restart. An
 * unsupervised broker therefore stands down whenever the unit is *enabled*.
 * Enablement is the stable signal: is-active reads "activating" for the whole
 * of a restart, which is exactly the window the shims race into.
 */
function supervisorOwnsThis(): boolean {
  if (SUPERVISED) return false
  try {
    // A shim-spawned broker inherits Claude Code's environment, which carries
    // neither XDG_RUNTIME_DIR nor the bus address — without them systemctl
    // fails with "Failed to connect to bus", the check reads false, and the
    // contender it was meant to remove starts anyway.
    const out = execFileSync('systemctl', ['--user', 'is-enabled', BROKER_UNIT], {
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: userBusEnv(),
    })
    return out.trim() === 'enabled'
  } catch {
    // Not active, no systemd, or no user manager — carry on as before.
    return false
  }
}

/**
 * Ask the incumbent broker to stand down. It handles SIGTERM by releasing the
 * socket, so the caller only has to wait before rebinding. Returns false when
 * there is nothing to signal, in which case the caller should step aside as
 * before rather than spin.
 */
function takeOverFrom(): boolean {
  let pid = 0
  try {
    pid = Number(readFileSync(PID_PATH, 'utf8').trim())
  } catch {
    return false
  }
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return false // already gone; the socket file is stale and will be reclaimed
  }
  log(`taking over from unsupervised broker (pid ${pid})`)
  return true
}

function startSocket(): void {
  if (supervisorOwnsThis()) {
    log(`${BROKER_UNIT} is running — leaving the socket to it`)
    process.exit(0)
  }
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const server = createServer(onConnection)
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Either a live broker won the race, or a socket file outlived its
      // process. Probe it: a refused connection means the latter.
      const probe = new Socket()
      probe.on('error', () => {
        log('stale socket, reclaiming')
        try {
          rmSync(SOCKET_PATH, { force: true })
        } catch {}
        server.listen(SOCKET_PATH)
      })
      probe.on('connect', () => {
        probe.destroy()
        // A shim bootstraps a broker whenever it finds no socket, which races
        // the supervised one on startup. Yielding here left systemd restarting
        // every five seconds and exiting each time, while the unsupervised
        // broker it deferred to stayed unsupervised. The managed instance takes
        // over instead; an unmanaged one still steps aside.
        if (SUPERVISED && takeOverFrom()) {
          setTimeout(() => server.listen(SOCKET_PATH), 500)
          return
        }
        log('another broker is already listening — exiting')
        process.exit(0)
      })
      probe.connect(SOCKET_PATH)
      return
    }
    log(`socket error: ${err}`)
    process.exit(1)
  })
  server.listen(SOCKET_PATH, () => {
    try {
      chmodSync(SOCKET_PATH, 0o600)
    } catch {}
    try {
      writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 })
    } catch {}
    log(`listening on ${SOCKET_PATH}`)
    armIdleExit()
    login()
  })
}

// ── lifecycle ────────────────────────────────────────────────────────────────

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  try {
    rmSync(SOCKET_PATH, { force: true })
  } catch {}
  // Only clear the pidfile if it is still ours: a broker taking over has
  // already written its own, and removing that would strand the next takeover.
  try {
    if (readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) {
      rmSync(PID_PATH, { force: true })
    }
  } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.on('error', err => log(`client error: ${err}`))

client.once('ready', c => {
  log(`gateway connected as ${c.user.tag}`)
  void registerCommands()
  scheduleTopicUpdate(true)
  void reconcileSpawned()
  setInterval(sweepIdleSessions, IDLE_SWEEP_MS).unref()
})

function login(): void {
  client.login(TOKEN).catch(err => {
    log(`login failed: ${err}`)
    process.exit(1)
  })
}

startSocket()
