# claude-kimi

## Overview

A Claude Code plugin that delegates tasks to the local **kimi** CLI agent via its wire protocol (JSON-RPC 2.0 over stdio). It exposes an MCP server, a slash command, a subagent, and a skill so you can hand off work from Claude Code to kimicode.

## Prerequisites

- **Node.js** >= 18
- **kimi CLI** installed and available on `$PATH`
- Dependencies are installed automatically on the first session start via the `SessionStart` hook

## Install

1. Clone or copy this repository into your Claude Code plugins directory.
2. Ensure `.mcp.json` points to the plugin entry, or install it as a standard Claude Code plugin.
3. Restart Claude Code. The `SessionStart` hook will run `npm install` if `node_modules` is missing.

## Usage

### Slash command

- `/kimi <task>` — Delegates the given task description to kimicode immediately.

### Subagent

- `kimi-delegate` — A dedicated subagent for heavy, well-scoped tasks that do not require back-and-forth clarification with the user.

### Skill

- `delegating-to-kimi` — Auto-applies a pre-flight checklist whenever Claude calls an `ask_kimi*` tool.

### MCP tools

- **`ask_kimi`** — Delegate a self-contained text task to kimicode.  
  Required: `goal` (string), `work_dir` (string).  
  Notable optional: `spec_files` (string[]), `plan_files` (string[]), `memory_files` (string[]), `context_files` (string[]), `constraints` (string[]), `expected_output` (string), `allowed_dirs` (string[]), `plan_mode` (boolean), `max_steps` (integer).  
  `*_files` must be absolute paths outside `work_dir`. `plan_mode=true` runs kimicode in read-only plan mode.

- **`ask_kimi_with_images`** — Like `ask_kimi`, but attaches images for multimodal reasoning.  
  Required: `goal` (string), `work_dir` (string), `image_paths` (string[]).  
  Notable optional: same as `ask_kimi`.  
  `*_files` must be absolute paths outside `work_dir`. Each entry of `image_paths` may be an absolute file path, a `file://` URI, or an `http(s)://` URL.

- **`cancel_kimi`** — Cancel the in-flight kimicode turn (kimi process stays alive, session intact).  
  Optional: `work_dir` (string). If omitted, cancels every active kimicode session.

- **`reset_kimi`** — Kill the kimicode process(es) and wipe wire-protocol session memory. Use when switching to an unrelated task.  
  Optional: `work_dir` (string). If omitted, resets every active session.

- **`compact_kimi`** — Have kimi summarize the current session (under 300 words), return the summary, then kill the process. Use when switching to a related-but-different task and you want to preserve the gist; pass the returned summary into the next `ask_kimi` as part of `goal` or `constraints`.  
  Required: `work_dir` (string).

### Session model

Within one Claude Code session, all `ask_kimi` calls for the same `work_dir` share **the same long-lived `kimi --wire` process**, so kimi keeps wire-protocol session memory between turns — no need for Claude to re-explain context. Different `work_dir`s get separate processes (so projects don't bleed into each other), and different Claude Code sessions get separate MCP servers (so they don't see each other's pool). When you want to drop the session memory, call `reset_kimi`; when you want a clean slate but keep a summary, call `compact_kimi`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KIMI_BIN` | `kimi` | Path to the `kimi` executable (falls back to `$PATH`) |
| `KIMI_MAX_FILE_BYTES` | `200000` | Per-file size limit for inline embedding (bytes) |
| `KIMI_MAX_TOTAL_BYTES` | `1000000` | Total inline embedding budget (bytes) |
| `KIMI_RPC_TIMEOUT_MS` | `600000` | Default RPC call timeout (ms) |
| `KIMI_RPC_FAST_TIMEOUT_MS` | `30000` | Fast-path RPC timeout (ms) |
| `KIMI_RPC_INIT_TIMEOUT_MS` | `60000` | Process initialization timeout (ms) |
| `KIMI_MAX_RESPONSE_BYTES` | `16384` | Hard ceiling for finished-turn response text (bytes) |
| `KIMI_LOG_THINK` | — | Set to `1` to enable think-content logging |

## Development

- Run unit tests: `npm test`
- Run the end-to-end smoke test against a real `kimi` process: `npm run smoke`

## Documentation

- Spec: docs/superpowers/specs/2026-05-06-kimicode-delegation-design.md
- Implementation plan: docs/superpowers/plans/2026-05-06-kimicode-delegation-plan.md

## License

MIT
