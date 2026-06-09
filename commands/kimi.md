---
description: Delegate a self-contained task to the local kimicode CLI agent.
argument-hint: <task description for kimi>
allowed-tools: ["Bash(pwd)", "mcp__kimicode__ask_kimi", "mcp__plugin_claude-kimi_kimicode__ask_kimi"]
---

Current working directory: !`pwd`

The user wants to delegate the following task to the local kimicode CLI agent.

Steps:
1. Take the directory printed above as the absolute `work_dir` (trim trailing newline).
2. Compose a single sentence as `goal` from the user argument below. If the argument already reads as one sentence, use it verbatim. If it's longer, lift the first sentence into `goal` and put the rest into `constraints` as bullets.
3. If the user mentioned external files (memory, spec, plan, docs) by absolute path or by `~/...` path, expand them and put them in the matching field (`memory_files` / `spec_files` / `plan_files` / `context_files`). Never paste file contents into `goal`.
4. If the task is research-only ("audit", "analyze", "should we…", "find places that…"), set `plan_mode: true`.
5. Set `expected_output` to a specific bounded form ("unified diff", "JSON list of paths", "<300-word summary"). Avoid vague phrasing — kimi will respond verbosely otherwise.
6. Call the `ask_kimi` tool with the composed object. When installed as a plugin its name is `mcp__plugin_claude-kimi_kimicode__ask_kimi`; as a bare project MCP server it is `mcp__kimicode__ask_kimi`. Both are pre-authorized — use whichever the tool list exposes.

User argument:

```
$ARGUMENTS
```

After kimi returns:
- If the response begins with `[kimi status=cancelled ...]`, surface the status and suggest narrowing the prompt; do not auto-retry.
- If kimi's reply is short (≲ 200 words) and contains no diffs, file lists, or structured output, **relay it verbatim** — do not "summarize" a one-paragraph answer into bullets, that throws away the actual content. A leading `[kimi ctx=...]` status line may be omitted or kept, your choice.
- Otherwise (long output, or contains diffs / file lists / structured blocks), summarize what kimi did in 2–5 bullets and quote the diffs/lists verbatim inside fenced blocks. Do not paste long prose verbatim.
