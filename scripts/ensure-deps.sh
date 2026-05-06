#!/usr/bin/env bash
set -eu

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ -d "$ROOT/node_modules/@modelcontextprotocol/sdk" ]; then
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[claude-kimi] npm not found on PATH; install Node.js >=18 then run: cd $ROOT && npm install" >&2
  exit 0
fi

echo "[claude-kimi] first-run: installing MCP server dependencies in $ROOT..." >&2
( cd "$ROOT" && npm install --silent --no-audit --no-fund ) || {
  echo "[claude-kimi] npm install failed; the kimicode MCP server will not start. Run manually: cd $ROOT && npm install" >&2
}
