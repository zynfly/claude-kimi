# claude-kimi

## Overview

A Claude Code plugin that delegates tasks to the local **kimi** CLI agent via its ACP (Agent Client Protocol) (JSON-RPC 2.0 over stdio). It exposes an MCP server, a slash command, and a skill so you can hand off work from Claude Code to kimicode.

## Prerequisites

- **Node.js** >= 18
- **kimi CLI** installed and available on `$PATH`
- Dependencies are installed automatically on the first session start via the `SessionStart` hook

## Install

Inside Claude Code, run:

```text
/plugin marketplace add zynfly/claude-kimi
/plugin install claude-kimi@claude-kimi
/reload-plugins
```

The first command registers this GitHub repo as a marketplace, the second enables the plugin, and `/reload-plugins` activates it without restarting the session. On first activation the `SessionStart` hook runs `npm install` automatically if `node_modules` is missing — you don't need to clone or `cd` anywhere.

To upgrade later (e.g. after a new release on `main`):

```text
/plugin marketplace update claude-kimi
/plugin update claude-kimi@claude-kimi
/reload-plugins
```

To uninstall:

```text
/plugin uninstall claude-kimi@claude-kimi
```

### Local-development install

If you've cloned this repo and want to run it from disk (e.g. while editing the plugin itself):

```text
/plugin marketplace add /absolute/path/to/claude-kimi
/plugin install claude-kimi@claude-kimi
/reload-plugins
```

The repo's `.claude-plugin/marketplace.json` already lists itself, so pointing the marketplace at the local directory is enough.

## Usage

### Slash command

- `/kimi <task>` — Delegates the given task description to kimicode immediately.

### Skill

- `delegating-to-kimi` — Auto-applies a pre-flight checklist whenever Claude calls an `ask_kimi*` tool.

### MCP tools

- **`ask_kimi`** — Delegate a self-contained text task to kimicode.  
  Required: `goal` (string), `work_dir` (string).  
  Notable optional: `spec_files` (string[]), `plan_files` (string[]), `memory_files` (string[]), `context_files` (string[]), `constraints` (string[]), `expected_output` (string), `plan_mode` (boolean).  
  `*_files` must be absolute paths outside `work_dir`. `plan_mode=true` runs kimicode in read-only plan mode.

- **`ask_kimi_with_images`** — Like `ask_kimi`, but attaches images for multimodal reasoning.  
  Required: `goal` (string), `work_dir` (string), `image_paths` (string[]).  
  Notable optional: same as `ask_kimi`.  
  `*_files` must be absolute paths outside `work_dir`. Each entry of `image_paths` may be an absolute file path, a `file://` URI, or an `http(s)://` URL.

- **`cancel_kimi`** — Cancel the in-flight kimicode turn (kimi process stays alive, session intact).  
  Optional: `work_dir` (string). If omitted, cancels every active kimicode session.

- **`reset_kimi`** — Kill the kimicode process(es) and wipe ACP session memory. Use when switching to an unrelated task.  
  Optional: `work_dir` (string). If omitted, resets every active session.

- **`compact_kimi`** — Have kimi summarize the current session (under 300 words), return the summary, then kill the process. Use when switching to a related-but-different task and you want to preserve the gist; pass the returned summary into the next `ask_kimi` as part of `goal` or `constraints`.  
  Required: `work_dir` (string).

### How it works

- **Per-`work_dir` process pool.** All `ask_kimi` calls with the same `work_dir` share a single long-lived `kimi acp` process. ACP session memory (conversation state, tool results, file context) persists across turns, so you don't need to re-explain context. Different `work_dir`s get isolated processes, and each Claude Code session has its own pool. Call `reset_kimi` to wipe a session and start fresh, or `compact_kimi` to summarize the session before killing it so a fresh process can pick up the gist.

- **Server-side file inlining.** The MCP server reads the contents of any `*_files` you pass and embeds them directly into the prompt sent to kimi. Claude pays tokens only for the file paths it sends plus the bounded response; the actual file contents never pass through Claude's context.

- **Idle-aware RPC timeouts.** Timeouts are reset on every line received from kimi, not by wall-clock duration. A long-running prompt that keeps streaming events will never be killed mid-task; the timeout only fires after the configured idle period with zero activity.

- **Response byte cap.** Finished turns are truncated to `KIMI_MAX_RESPONSE_BYTES` (default 16 KB) before returning to Claude, preventing a single turn from blowing out Claude's context window.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KIMI_BIN` | `kimi` | Path to the `kimi` executable (falls back to `$PATH`) |
| `KIMI_MAX_FILE_BYTES` | `200000` | Per-file size limit for inline embedding (bytes) |
| `KIMI_MAX_TOTAL_BYTES` | `1000000` | Total inline embedding budget (bytes) |
| `KIMI_RPC_TIMEOUT_MS` | `600000` | **Idle** timeout for `prompt` calls (ms). Resets on every line kimi sends, so a long-running task that keeps streaming events stays alive — only fires after this long with zero activity. |
| `KIMI_RPC_FAST_TIMEOUT_MS` | `30000` | Idle timeout for non-`prompt` RPC calls (ms) |
| `KIMI_RPC_INIT_TIMEOUT_MS` | `60000` | Idle timeout for the initial `initialize` handshake (ms) |
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
