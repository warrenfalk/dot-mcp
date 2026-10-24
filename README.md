# Dot → Codex MCP

A local stdio MCP server that lets ChatGPT Dot inspect and control existing sessions in your shared Codex app-server. All projects and session sources are accessible. Thread creation and approval responses are deliberately absent.

## Build and check

```sh
direnv allow
pnpm install --frozen-lockfile
pnpm build
pnpm run doctor
pnpm test
DOT_MCP_LIVE=1 pnpm test
```

Without direnv, prefix commands with `nix develop -c`. The flake supplies Node 24 and pnpm 12.9.0. `pnpm run doctor` is this project's app-server probe; `pnpm doctor` is pnpm's own diagnostic command.

The live test uses the real MCP stdio process for read-only discovery, metadata, control state and history reads. It does not request control or send messages to live sessions. The isolated tests exercise mutation serialization and failure behavior against a fake WebSocket app-server.

Run `bin/dot-mcp` after building. Stdout is reserved for MCP; diagnostics go to stderr. The launcher works from any directory and enters the pinned Nix shell. A tunnel client can keep this process running as its stdio child.

## Connect to the shared server

By default the bridge opens a WebSocket over:

```text
$CODEX_HOME/app-server-control/app-server-control.sock
```

`CODEX_HOME` defaults to `~/.codex`. Set `CODEX_APP_SERVER_SOCKET` to an absolute Unix socket path if necessary. Environment settings can go in the ignored `.env.local` for interactive direnv use. For a tunnel/service process, supply settings in that process's environment; the launcher does not source `.env.local`.

Connect to the **same process** used by your TUI/GUI. Starting another server against the same directory cannot reveal the first process's active turns or grants. The bridge never starts, restarts or updates Codex. Missing protocol support fails closed.

On each connection, the bridge initializes, sends `initialized`, registers the fixed controller identity `dot` as its first subsequent request, and subscribes to `event/firehose`. It exposes no arbitrary RPC, controller identity, configuration, command execution, creation, or approval tool. Keep the underlying app-server socket private.

## Tools

| Tool                       | Purpose                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `connection_status`        | Server identity and connection generation                                          |
| `list_threads`             | Paginated saved sessions, across all providers and sources                         |
| `list_loaded_threads`      | Loaded session IDs, including unsaved sessions                                     |
| `read_thread`              | Metadata and execution status                                                      |
| `list_turns`, `list_items` | Paginated history and results                                                      |
| `read_control`             | Authoritative grant, request, lock and active-turn state                           |
| `request_control`          | Request permission and return immediately                                          |
| `send_message`             | Start a turn in an existing idle session, or explicitly steer an exact active turn |
| `interrupt_task`           | Interrupt an exact turn with a current grant                                       |
| `release_control`          | Release a grant without interrupting work                                          |
| `read_events`              | Poll bounded live observations, including human approval prompts                   |

`list_threads` defaults to non-archived sessions; use `archived: true` for archived sessions and follow `nextCursor`. It reads the state DB without repairing metadata from rollout files. Use `list_loaded_threads` plus `read_thread` to inspect live sessions that are not yet saved. No read operation marks a session as read.

A normal interaction is:

1. Discover a session and inspect its current state/history.
2. Call `request_control` with a fresh unique request ID and a reason.
3. Poll `read_control`. Use only a non-null current grant belonging to `dot`. A running turn or interactive attachment normally causes a 60-second wait; locked threads require explicit human approval. Server state decides permission, never the bridge's clock. Respect denial; do not repeatedly submit new requests to bypass it.
4. Call `send_message` with the grant ID. Omit `expectedTurnId` to require an idle session. Include it only to deliberately steer that exact running turn. The bridge resumes the session first without configuration overrides. The app-server validates grants and turn preconditions atomically.
5. Read events/history in later calls; input returns a turn ID immediately. Human execution approvals remain in the Codex UI.
6. Release control when finished. Disconnection does not release it; an app-server restart clears grants and requests.

Human input can revoke Dot's grant. Stale grants fail rather than silently obtaining control again. Ensure your GUI implements the fork's control notices and revoke-on-submission contract before relying on its permission countdown; the TUI exposes `/control` commands.

## Failures and event limits

Requests have a 15-second local deadline. Calls return promptly rather than waiting for permission or task completion. On a lost response or timeout, input and interruption report `outcomeUnknown: true`. They may already have succeeded: **never automatically repeat them**. Reconcile history and current control state. Calls are never automatically replayed; a later tool call reconnects and registers `dot` again.

Live observations are held in memory, with a 4 MiB total budget and 64 KiB per-event limit. Oversized event bodies are explicitly omitted; read transcript history for details. Use `nextCursor` as `after` to poll incrementally. `gap` or `resetRequired` indicates lost observations, reconnection, or a different process; reread authoritative state/history. Events before startup, during disconnection, or after eviction cannot be recovered from this buffer. It does not provide a durable audit log.

Observed approval prompts are informational. This bridge cannot answer them, replay already-pending prompts on connection, or determine their authoritative pending state from the event buffer. Codex retains and handles those approvals. Tool results are capped at 6 MiB; an oversized history response returns an explicit error so the caller can reduce the page size.

## Secure MCP Tunnel

Official instructions: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server).

Create a tunnel in Platform and associate it with the target ChatGPT workspace and Platform organization. Obtain the tunnel ID and runtime key. Install `tunnel-client` from Platform's download link or the official [latest release](https://github.com/openai/tunnel-client/releases/latest). Keep credentials outside this repository and do not paste them into chat.

After building this project, configure the stdio command using its absolute path:

```sh
export CONTROL_PLANE_API_KEY="..." # Supply from your secret manager/environment.
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile dot-codex \
  --tunnel-id tunnel_YOUR_ID \
  --mcp-command "/home/warren/source/codex-cli/dot-mcp/bin/dot-mcp"
tunnel-client doctor --profile dot-codex --explain
tunnel-client run --profile dot-codex
```

Keep the client running. In ChatGPT, open Plugins → plus → Add custom MCP server → Tunnel, select the tunnel, configure authentication, create the plugin and install it. Begin by calling `connection_status` and `list_threads`.

This stdio adapter trusts its local parent process; it has no HTTP listener or built-in OAuth server. Tunnel access must be restricted to your intended account/workspace. The fixed `dot` controller is a local authorization identity, not proof of the remote caller's identity. If other users gain access to this tunnel/plugin, they would share Dot's authority. A multi-user deployment needs an explicit authentication design before use.

Tunnel runtime credentials and ChatGPT plugin permissions are separate. Tunnel requests have an absolute 120-second deadline; this adapter uses short submissions followed by separate status/history reads. Account/workspace tunnel availability and end-to-end ChatGPT invocation must be verified during setup.

## Protocol source

The fork's contract is `../codex/codex-rs/app-server/thread-control.md`. This project does not modify the fork. The initial live verification accepted `controller/register`, firehose subscription, loaded-session listing and this session's control read on Codex **0.164.0**. That verifies the protocol used here; a reported version alone does not prove an exact source revision.
