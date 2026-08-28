# Discord

Connect a Discord bot to your Claude Code with an MCP server.

When the bot receives a message, it is forwarded to Claude, which gets tools to
reply, react, and edit messages.

One bot serves **any number of concurrent Claude Code sessions**. Slash commands
drive planning and code review from the chat, and the bot's status line shows
live token usage.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a Discord application and bot.**

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it a name.

Navigate to **Bot** in the sidebar. Give your bot a username.

Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

**2. Generate a bot token.**

Still on the **Bot** page, scroll up to **Token** and press **Reset Token**. Copy the token — it's only shown once. Hold onto it for step 5.

**3. Invite the bot to a server.**

Discord won't let you DM a bot unless you share a server with it.

Navigate to **OAuth2** → **URL Generator**. Select the `bot` **and
`applications.commands`** scopes — the second one is what allows `/status`,
`/sessions`, `/plan`, and `/review` to register. Under **Bot Permissions**,
enable:

- View Channels
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Read Message History
- Attach Files
- Add Reactions

> Already have a bot invited without `applications.commands`? Re-run the URL
> generator with both scopes and open the new URL — it re-authorises in place,
> no need to kick the bot. Without that scope the plugin still works, but
> command registration fails with `Missing Access` in `broker.log`.

Integration type: **Guild Install**. Copy the **Generated URL**, open it, and add the bot to any server you're in.

> For DM-only use you technically need zero permissions — but enabling them now saves a trip back when you want guild channels later.

**4. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install discord@claude-plugins-official
```

**5. Give the server the token.**

```
/discord:configure MTIz...
```

Writes `DISCORD_BOT_TOKEN=...` to `~/.claude/channels/discord/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `DISCORD_STATE_DIR` at a different directory per instance.

**6. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:discord@claude-plugins-official
```

**7. Pair.**

With Claude Code running from the previous step, DM your bot on Discord — it replies with a pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/discord:access pair <code>
```

Your next DM reaches the assistant.

**8. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/discord:access policy allowlist` directly.

## Multiple sessions on one bot

A Discord bot token can hold only one gateway connection, but Claude Code
spawns a plugin's MCP server once per session. So the plugin splits in two:

- **`broker.ts`** — one detached daemon per machine. It owns the gateway,
  `access.json`, gating, routing, and slash commands. The first session to find
  no broker starts one; it outlives individual sessions and exits after ten
  idle minutes with none connected.
- **`server.ts`** — the per-session MCP shim Claude Code actually spawns. It
  holds no Discord connection, just relays over a unix socket at
  `~/.claude/channels/discord/broker.sock`.

Sessions identify themselves from `CLAUDE_CODE_SESSION_ID` and
`CLAUDE_PROJECT_DIR`, so each shows up as its project and git branch.

### Where a message goes

1. A message in a **session thread** goes to that session. No `@mention`
   needed inside one — the thread is already dedicated.
2. Anything else goes to the channel's **focused** session.
3. Focus defaults to the most recently active session; `/sessions` changes it.

With a single session connected nothing changes from the single-session
behaviour: it receives everything, and no threads are created. Threads appear
once a second session registers (set `autoThread: false` in `access.json` to
opt out, or press **Open a thread per session** in `/sessions`).

If the focused session disconnects, the channel falls back to whoever is still
live rather than going silent.

## Slash commands

Registered per guild on startup, for every channel opted in via
`/discord:access`. Only allowlisted users may run them.

| Command | Effect |
| --- | --- |
| `/status` | Per-session context usage, cumulative tokens, model, and thread link. |
| `/sessions` | Same table, plus a menu to change focus and a button to open a thread per session. |
| `/plan <task>` | Asks the target session to enter plan mode, research, and post a plan before touching anything. |
| `/review [target] [effort]` | Runs a code review in the target session and posts findings back. `target` is a PR number, branch, or path; defaults to the current diff. |

`/plan` and `/review` go to the session that owns the thread you ran them in,
or to the focused session otherwise. Both are marked as commands in the
notification's metadata, never in the message body — text in a message that
claims to be a command is not one.

## Session usage in the status line

The bot's presence shows the live picture — `thematic@main · 41% ctx`, or
`3 sessions · serv@main 12% ctx` when several are connected. `/status` breaks
it down per session.

Numbers come from each session's own transcript
(`~/.claude/projects/<project>/<session-id>.jsonl`), which records token usage
per turn. It's read-only and needs no internal APIs.

> **Context percentages are an estimate.** The transcript records the model id
> but never the context window, and the id is plain (`claude-opus-5`) even for
> a 1M-context session. The plugin assumes the standard window and widens to
> the next tier if it ever sees a larger prompt — so the figure self-corrects
> rather than reading over 100%, but it can be wrong until then. Set
> `contextLimit` in `access.json` to pin the real value:
>
> ```json
> { "contextLimit": 1000000 }
> ```

## Permission prompts

Permission requests relayed to Discord name the session that raised them, and
appear in that session's thread when it has one — otherwise they DM every
allowlisted user, as before. Answer with the buttons or `y <code>` / `n <code>`.

## Updating the plugin

The broker is detached and outlives sessions, so it keeps running your old code
after an update. Sessions send their version on connect: when a newer one
appears and the broker is the last thing holding the socket, it steps aside and
the new session starts a replacement. To force it:

```sh
pkill -f 'broker.ts'
```

Broker logs go to `~/.claude/channels/discord/broker.log`.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are Discord **snowflakes** (numeric — enable Developer Mode, right-click → Copy ID). Default policy is `pairing`. Guild channels are opt-in per channel ID.

## Tools exposed to the assistant

Unchanged from the single-session version — the shim forwards each call to the
broker and returns its result.

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a channel. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments — max 10 files, 25MB each. Auto-chunks; files attach to the first chunk. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to any message by ID. Unicode emoji work directly; custom emoji need `<:name:id>` form. |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `fetch_messages` | Pull recent history from a channel (oldest-first). Capped at 100 per call. Each line includes the message ID so the model can `reply_to` it; messages with attachments are marked `+Natt`. Discord's search API isn't exposed to bots, so this is the only lookback. |
| `download_attachment` | Download all attachments from a specific message by ID to `~/.claude/channels/discord/inbox/`. Returns file paths + metadata. Use when `fetch_messages` shows a message has attachments. |

Inbound messages trigger a typing indicator automatically — Discord shows
"botname is typing…" while the assistant works on a response.

## Attachments

Attachments are **not** auto-downloaded. The `<channel>` notification lists
each attachment's name, type, and size — the assistant calls
`download_attachment(chat_id, message_id)` when it actually wants the file.
Downloads land in `~/.claude/channels/discord/inbox/`.

Same path for attachments on historical messages found via `fetch_messages`
(messages with attachments are marked `+Natt`).
