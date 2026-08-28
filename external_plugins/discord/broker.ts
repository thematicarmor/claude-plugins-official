#!/usr/bin/env bun
/**
 * Discord channel broker — the single process that owns the gateway.
 *
 * Claude Code spawns a plugin MCP server per session. A bot token can only
 * hold one gateway connection, so instead of each session connecting, exactly
 * one broker connects and every session's shim (server.ts) talks to it over a
 * unix socket. The broker owns: the gateway, access.json, gating, pairing,
 * routing, slash commands, and presence.
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
  ActivityType,
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
  type UsageSnapshot,
} from './protocol.ts'
import { fmtTokens } from './usage.ts'
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
  process.stderr.write(`[broker] ${s}\n`)
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
  /** Auto-create a per-session thread once more than one session is live. */
  autoThread?: boolean
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
      autoThread: parsed.autoThread,
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

  // A session-owned thread is already an explicit, dedicated channel to one
  // session — making the user @mention in it too would be pure friction.
  const inSessionThread = isThread && registry.isSessionThread(msg.channelId)
  const requireMention = policy.requireMention ?? true
  if (requireMention && !inSessionThread && !(await isMentioned(msg, access.mentionPatterns))) {
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

// ── per-session threads ──────────────────────────────────────────────────────

/**
 * Threads are how several sessions share one channel without talking over each
 * other. We only open them once there's genuinely more than one session — with
 * a single session the channel behaves exactly as it did before this change.
 */
async function openThread(s: Session, channelId: string): Promise<string | null> {
  if (s.threadId) return s.threadId
  try {
    const parent = await fetchAllowedChannel(channelId)
    if (parent.isThread() || !('threads' in parent)) return null
    const thread = await (parent as TextChannel).threads.create({
      name: `${label(s)} · ${shortId(s.meta.sessionId)}`.slice(0, 100),
      autoArchiveDuration: 1440,
      reason: 'Claude Code session thread',
    })
    registry.setThread(s.meta.sessionId, thread.id)
    await thread.send(
      `Session \`${shortId(s.meta.sessionId)}\` — \`${s.meta.cwd}\`` +
        (s.meta.gitBranch ? ` on \`${s.meta.gitBranch}\`` : '') +
        `\nMessages here go to this session. No @mention needed.`,
    )
    return thread.id
  } catch (e) {
    log(`thread create failed: ${e}`)
    return null
  }
}

/** Home channel for threads/announcements: the sole opted-in guild channel. */
function homeChannel(): string | null {
  const groups = Object.keys(loadAccess().groups)
  return groups.length > 0 ? groups[0]! : null
}

async function autoThreadIfNeeded(): Promise<void> {
  const access = loadAccess()
  if (access.autoThread === false) return
  const live = liveSessions()
  if (live.length < 2) return
  const home = homeChannel()
  if (!home) return
  for (const s of live) {
    if (!s.threadId) await openThread(s, home)
  }
}

// ── presence ─────────────────────────────────────────────────────────────────

let lastPresence = ''
/** Discord throttles presence updates (5 per 20s); one every 15s is safe. */
function updatePresence(): void {
  if (!client.isReady()) return
  const live = liveSessions()
  let text: string
  if (live.length === 0) {
    text = 'idle · no sessions'
  } else {
    const focused = live[0]!
    const p = pct(focused.usage)
    const ctx = p === null ? 'starting' : `${p}% ctx`
    text = live.length === 1 ? `${label(focused)} · ${ctx}` : `${live.length} sessions · ${label(focused)} ${ctx}`
  }
  if (text === lastPresence) return
  lastPresence = text
  try {
    // discord.js promotes `name` to `state` for a Custom activity, which is
    // what makes the bare text show up under the bot's name.
    client.user?.setPresence({
      activities: [{ name: text.slice(0, 128), type: ActivityType.Custom }],
      status: 'online',
    })
  } catch (e) {
    log(`presence update failed: ${e}`)
  }
}

setInterval(updatePresence, 15_000).unref()

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
      s.threadId ? `<#${s.threadId}>` : '',
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
  { name: 'sessions', description: 'List sessions, switch focus, or open a session thread' },
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
  // A session with its own thread prompts there, so the request sits next to
  // the work that triggered it. Otherwise fall back to DMing the operators.
  if (s?.threadId) {
    try {
      const th = await fetchTextChannel(s.threadId)
      if ('send' in th) {
        const sent = await th.send({ content: text, components: [row] })
        noteSent(sent.id)
        return
      }
    } catch (e) {
      log(`permission prompt to thread failed, falling back to DM: ${e}`)
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
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sess:threads')
        .setLabel('Open a thread per session')
        .setStyle(ButtonStyle.Secondary),
    )
    await interaction.reply({
      embeds: [usageEmbed()],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), buttons],
    })
    return
  }

  // /plan and /review target whichever session the channel is pointed at.
  const target =
    (interaction.channel?.isThread() ? registry.ownerOfThread(interaction.channelId) : null) ??
    registry.routeFor(rootId)

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
        'Post the findings to Discord with the reply tool, most severe first, each with file:line ' +
        'and a one-line failure scenario. Do not apply fixes unless asked.',
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
  updatePresence()
  await interaction.reply(`▸ Channel messages now go to **${label(s)}** — \`${shortId(chosen)}\``)
}

async function onButton(interaction: import('discord.js').ButtonInteraction) {
  const access = loadAccess()

  if (interaction.customId === 'sess:threads') {
    const rootId = interaction.channel?.isThread()
      ? (interaction.channel.parentId ?? interaction.channelId)
      : interaction.channelId
    if (!isOperator(access, interaction.user.id, rootId)) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true })
      return
    }
    await interaction.deferReply({ ephemeral: true })
    const made: string[] = []
    for (const s of liveSessions()) {
      const id = await openThread(s, rootId)
      if (id) made.push(`<#${id}>`)
    }
    await interaction.editReply(made.length ? `Threads: ${made.join(' ')}` : 'Could not open threads.')
    return
  }

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

  // Route: a session thread is unambiguous; anywhere else follows focus.
  const target = registry.routeForMessage(chat_id)

  if (!target) {
    await msg
      .reply('No Claude Code session is connected right now.')
      .then(m => noteSent(m.id))
      .catch(() => {})
    return
  }
  registry.touch(target.meta.sessionId)

  if ('sendTyping' in msg.channel) void msg.channel.sendTyping().catch(() => {})

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
  updatePresence()
}

// ── socket server ────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | null = null

function armIdleExit(): void {
  if (idleTimer) clearTimeout(idleTimer)
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
        void autoThreadIfNeeded()
        updatePresence()
        break
      }
      case 'usage': {
        registry.setUsage(msg.sessionId, msg.usage)
        updatePresence()
        break
      }
      case 'call': {
        void (async () => {
          let reply: BrokerMsg
          try {
            reply = { t: 'result', id: msg.id, ok: true, text: await runTool(msg.tool, msg.args) }
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
    registry.remove(sessionId)
    log(`session ${shortId(sessionId)} disconnected`)
    updatePresence()
    armIdleExit()
  })
}

function startSocket(): void {
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
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.on('error', err => log(`client error: ${err}`))

client.once('ready', c => {
  log(`gateway connected as ${c.user.tag}`)
  void registerCommands()
  updatePresence()
})

function login(): void {
  client.login(TOKEN).catch(err => {
    log(`login failed: ${err}`)
    process.exit(1)
  })
}

startSocket()
