# Claude Relay

Let local Claude Code sessions talk to each other in natural language.

Running two Claude sessions on different projects? In one, say _"ask the backend session if the auth token shape changed"_ and the other answers. Or _"ask everyone what they're working on"_ and replies stream back.

<img width="1280" height="678" alt="ezgif-7f30f78a18c9905f" src="https://github.com/user-attachments/assets/9a132dfa-9db1-4550-96e0-cd25a2744fce" />

## Install

Claude Relay ships as a Claude Code plugin. Three steps.

### 1. Add the marketplace

From any Claude Code session:

```
/plugin marketplace add vildanbina/claude-relay
```

### 2. Install the plugin

```
/plugin install relay@claude-relay
```

This registers the MCP server and slash commands.

### 3. Launch sessions with the channel capability

Relay delivers inbound messages via `notifications/claude/channel` — a Claude Code capability still in research preview. Every session that should send or receive messages must be launched with:

```bash
claude --dangerously-load-development-channels plugin:relay@claude-relay
```

The `dangerously-` prefix is required until Anthropic promotes the channels capability to general availability and adds this plugin to the trusted allowlist. We will submit for review and drop the flag as soon as it's approved.

Open two sessions in different project dirs and try the examples below.

## Usage

Try:

- _"what sessions are active?"_
- _"ask backend-api what they're working on"_
- _"ask everyone to report status"_

Rename your session: `/relay-rename backend-api`. Natural language works too (_"call yourself backend-api"_), but the slash command is faster. Claude Code's built-in `/rename` also auto-syncs.

### Tools

| Tool              | What it does                                                       |
| ----------------- | ------------------------------------------------------------------ |
| `relay_peers`     | List active sessions on this machine                               |
| `relay_ask`       | Ask one peer; returns immediately, reply arrives as a notification |
| `relay_reply`     | Answer an incoming ask by `ask_id`                                 |
| `relay_broadcast` | Ask every other peer; replies stream back as notifications         |
| `relay_rename`    | Rename this session                                                |

Claude routes to these automatically. You rarely call them by name.

If two sessions share a slugged basename (both `~/Code/backend/api`), Relay suffixes `-2`, `-3`. Use `relay_peers` to disambiguate by `cwd`.

### Preset name via env (for orchestrators)

Set `CLAUDE_RELAY_PRESET_NAME` in the spawned session's environment to pre-register under a deterministic name:

```bash
CLAUDE_RELAY_PRESET_NAME=home-office-agent-12 claude ...
```

Useful when a parent process pty-spawns many sessions and needs each to land under a known name instead of the directory-basename fallback. Same validation as `/relay-rename` applies (max 64 chars, `[A-Za-z0-9._-]+`); invalid values are ignored. The preset only seeds the initial registration — `/rename` and `/relay-rename` continue to work normally.

## Error codes

| Code                 | Meaning                                               |
| -------------------- | ----------------------------------------------------- |
| `peer_not_found`     | No peer registered under that name                    |
| `peer_gone`          | Target peer disconnected before replying              |
| `timeout`            | Ask timed out waiting for a reply                     |
| `name_taken`         | Rename or register name already in use                |
| `not_registered`     | Caller tried to use a tool before registering         |
| `already_registered` | Same socket tried to register twice                   |
| `unknown_ask`        | Reply references an `ask_id` the hub has no record of |
| `bad_msg`            | Malformed JSON or schema-invalid payload              |
| `hub_unreachable`    | Hub socket died or never replied                      |
| `bad_args`           | Tool called with missing or wrong-typed arguments     |
| `protocol_mismatch`  | Client version != hub version; kill the hub and retry |

## Debugging

Runtime data lives under `$CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/relay-claude-relay/`).

```bash
DATA=~/.claude/plugins/data/relay-claude-relay
tail -f "$DATA/logs/relay-$(date +%Y-%m-%d).log" | jq   # today's log
pgrep -f hub-daemon.ts                                  # hub alive?
pkill -f hub-daemon.ts && rm -f "$DATA/hub.sock"        # force reset
ps -Ao pid,ppid,args | grep 'relay/src/main.ts' | awk '$2==1'   # orphaned channels (should be none)
```

Versions before 0.1.5 leaked one channel process per session exit. If you ran an older version, clear the orphans once:

```bash
pkill -f 'relay/src/main.ts'; pkill -f 'relay/src/hub-daemon.ts'
```

Per-session MCP stderr lives under `~/Library/Caches/claude-cli-nodejs/<project-slug>/mcp-logs-*/`. Start there when a channel fails to register.

## How it works

Three pieces:

- **Session** — a Claude Code process you launched.
- **Channel** — per-session MCP server (this plugin). Exposes the `relay_*` tools to Claude and listens for incoming messages.
- **Hub** — single detached daemon per machine. Routes messages between channels over a Unix socket at `$CLAUDE_PLUGIN_DATA/hub.sock`.

The first session to launch spawns the hub; later sessions connect to it. The hub survives session restarts and self-exits five minutes after the last peer disconnects. Incoming peer messages arrive as `notifications/claude/channel` so Claude sees them between turns.

Details: [docs/architecture.md](docs/architecture.md).

## Out of scope

- No persistence — peer state lives in the hub process only
- Single user per machine; no auth or access control
- Same-host only; no cross-machine relaying

## Development

Requires [Bun](https://bun.sh) and Claude Code 2.1.80+.

```bash
git clone https://github.com/vildanbina/claude-relay
cd claude-relay && bun install
bun run check   # typecheck + lint + format + test
```

For a live-reload loop (edits hit Claude Code on restart), bypass the plugin with a project-scope `.mcp.json`:

```bash
cp .mcp.json.example .mcp.json
/plugin uninstall relay@claude-relay
```

Launch Claude Code with `--dangerously-load-development-channels server:relay` (note `server:`, since the MCP is now manually registered). Reinstall the plugin when you're done. `.mcp.json` is gitignored.

Open an issue before a PR so we can align on scope.

## License

MIT
