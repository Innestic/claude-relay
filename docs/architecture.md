# Architecture

## Overview

Relay lets N Claude Code sessions on one machine talk to each other. Each session runs an MCP channel; a single detached hub daemon routes messages between them over a Unix socket. Incoming peer messages arrive in the destination session as `notifications/claude/channel` events that Claude sees between turns.

```
Session A  ┐                              ┌  Session B
           │                              │
  Claude ──┼── stdio ── Channel A ── ◄─┐  │
           │                           │  │
           └──────── MCP Tools ────────┘  │
                                          │
                                     Unix socket ($CLAUDE_PLUGIN_DATA/hub.sock)
                                          │
                                        Hub Daemon
                                     (single process,
                                      detached, survives
                                      session restart)
                                          │
                                          ▼
                       Channel B ◄─── stdio ─── Claude
```

## Processes

Three kinds of process at runtime:

| Process | Count | Lifetime | Purpose |
|---|---|---|---|
| Claude Code | N | User-driven | Hosts the conversation |
| Channel MCP server | N (one per session) | Same as parent Claude | Exposes tools + routes notifications |
| Hub daemon | 1 | Spawned detached; self-exits after 5min idle | Routes messages between channels |

The first channel to start spawns the hub via `bun run src/hub-daemon.ts` with `detached: true` and unreffed, so the hub outlives the spawning session. All subsequent channels find the socket and connect as clients.

Claude Code sends no shutdown signal, and the MCP stdio transport ignores stdin EOF, so a channel would otherwise outlive its session forever. `channel/parent-watch.ts` exits the process on stdin EOF, with a parent-pid liveness poll as a backstop. When the last channel disconnects, the hub's idle timer takes the daemon down too.

## Layers

### Protocol (`src/protocol.ts`)

Zod discriminated union for every wire message. Client→hub: `register`, `rename`, `list_peers`, `ask`, `reply`, `broadcast`. Hub→client: `ack`, `err`, `peers`, `incoming_ask`, `incoming_reply`, `broadcast_ack`. Single source of truth for shapes and error codes.

### Framing (`src/framing.ts`)

Line-delimited JSON over the Unix socket. `readLines(socket, onLine)` buffers bytes and emits one callback per newline. `writeLine(socket, obj)` serializes + appends `\n`.

### Hub (`src/hub/`)

| Module | Concern |
|---|---|
| `registry.ts` | In-memory peer directory (`name → peer entry`, plus reverse indexes for socket lookup) |
| `pending-asks.ts` | Table of in-flight asks with per-entry timers; supports cleanup on disconnect and name migration on rename |
| `socket-recovery.ts` | Stale-socket detection (probe → unlink → retry listen) |
| `handlers.ts` | One function per message type; dispatched from `handleLine` |
| `index.ts` | `startHub` orchestration: listens, accepts, wires the idle-exit timer |

### Channel (`src/channel/`)

| Module | Concern |
|---|---|
| `hub-connection.ts` | Owns the socket to the hub; request/response correlation via `req_id`; resolves in-flight work with `hub_unreachable` on disconnect |
| `bootstrap.ts` | Connect to existing hub, or spawn a detached daemon and wait for the socket |
| `daemon-spawn.ts` | The actual `spawn(..., {detached: true})` + readiness poll |
| `register.ts` | Register with the hub; retry with `-2`, `-3`, ... on `name_taken` |
| `tools.ts` | `callTool` dispatcher; one function per MCP tool (`relayPeers`, `relayAsk`, `relayReply`, `relayBroadcast`, `relayRename`) |
| `tool-schemas.ts` | Static tool definitions and zod→JSON-Schema conversion for `ListTools` |
| `routing.ts` | Wires hub messages to the pending-broadcast table and to MCP notification emission |
| `notifications.ts` | Builds the `{content, meta}` payload for `notifications/claude/channel` |
| `mcp-server.ts` | Creates the MCP Server with `experimental.claude/channel` capability, wires `ListTools` and `CallTool` |
| `pending-broadcasts.ts` | Channel-side table of in-flight `relay_broadcast` calls with timeouts for the broadcast-ack round-trip |
| `parent-watch.ts` | Exits the channel when the parent Claude Code process goes away (stdin EOF, plus a parent-pid liveness poll) |
| `index.ts` | `startChannel` orchestration |

### Identity (`src/identity.ts`)

`defaultName(cwd)` → the slugified basename of the working directory (e.g. `~/Code/relay` → `relay`). The hub's register handler returns `name_taken` on collision; `registerWithRetries` appends `-2`, `-3`, ... until a name sticks.

### Logging (`src/logger.ts`)

Winston-based JSON logger with daily rotation to `$CLAUDE_PLUGIN_DATA/logs/` (plugin) or `~/.claude-relay/logs/` (manual install). `makeLogger(label)` returns a per-module logger pre-bound with `label` and an event-formatter. Silently disables itself under `NODE_ENV=test` (set by `bun test`) so tests don't pollute the filesystem.

## Data flow: one ask, start to reply

1. User in session A: *"ask session B if tests pass"*
2. Claude A calls `relay_ask(to, question)`
3. Channel A generates `ask_id`, writes `{type:"ask", to, question, ask_id}` to the hub socket, and returns `{ok:true, ask_id}` to Claude A immediately — the tool call does not wait for a reply
4. Hub receives, looks up target in registry, records pending entry, forwards `{type:"incoming_ask", from, question, ask_id}` to channel B
5. Channel B emits `notifications/claude/channel` with `{content: question, meta: {from, ask_id}}`
6. Claude Code wraps that into `<channel source="relay" from="..." ask_id="...">question</channel>` and surfaces it to Claude B at its next turn boundary
7. Claude B's instructions tell it to answer via `relay_reply(ask_id, text)` before continuing
8. Channel B writes `{type:"reply", ask_id, text}` to the hub
9. Hub matches pending entry, forwards `{type:"incoming_reply", from, text, ask_id}` to channel A, clears pending
10. Channel A emits a `notifications/claude/channel` with `{content: text, meta: {from, ask_id, thread_id?}}`; Claude A sees the reply at its next turn boundary and correlates by `ask_id`

Errors on an in-flight ask (hub-side timeout, target disconnect → `peer_gone`, unknown target → `peer_not_found`) travel the same way: the hub sends `{type:"err", code, ask_id}` to the caller's channel, which emits a channel notification with `meta: {ask_id, code}`.

Broadcast follows a related path but fan-out: `relay_broadcast` does wait for a short `broadcast_ack` round-trip so the caller learns the `peer_count`; individual replies come back as `incoming_reply` notifications tagged with the `broadcast_id`.

## Design decisions

**Detached hub.** Early version ran the hub in-process inside the first channel's Claude Code child. When that session closed, the hub died and other sessions lost their connection. Now the hub is always a separate detached process; any channel can spawn it, and it outlives all of them.

**First-wins names.** `rename` is race-free: the first channel to claim a name gets it; the second gets `name_taken`. Same for `register` defaults.

**In-memory only.** No persistence. A peer that disconnects is gone; its in-flight asks resolve with `peer_gone`. Reconnection means re-registering. Simpler and matches the cooperative-session use case.

**Cooperative multitasking at turn boundaries.** Channel notifications interleave with Claude's own work. A peer mid-tool-call won't reply until it reaches a turn boundary. The hub enforces a 120s default timeout per ask server-side; after that, the caller gets a `timeout` error notification and any late reply from the target is discarded.

**Async ask.** `relay_ask` returns `{ok, ask_id}` immediately; the reply (or any hub-side error for that `ask_id`) arrives later as a channel notification. This mirrors broadcast semantics and removes the failure mode where a blocked caller lost a race with its own client-side timeout while the target had already queued the question.

**Factory functions, no classes.** Each stateful concept (registry, pending table, hub connection) is a factory that returns an object of closures. No `this`, no inheritance, uniform style.

## Testing

Per-module test file alongside each source file (`registry.ts` / `registry.test.ts` etc.). All tests are integration-style: real sockets, real message framing, asserted on the wire. Unit-level coverage is implicit in that. 74 tests, ~1.5s to run. `bun run check` runs typecheck + eslint + prettier + tests; husky's pre-commit hook invokes it.

Shared test helpers: `src/test-helpers.ts` provides `tmpSocket()` and `rawConnect()`; per-dir thin wrappers in `src/hub/test-helpers.ts` and `src/channel/test-helpers.ts` add domain-specific helpers (`startCh`).
