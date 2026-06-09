---
description: Use this skill when Claude is preparing to call any ask_kimi* tool (named mcp__plugin_claude-kimi_kimicode__ask_kimi when installed as a plugin, or mcp__kimicode__ask_kimi as a bare project MCP server), or when the user explicitly says "delegate to kimi" / "have kimi do this", or when a coding task is heavy/long/codebase-wide and would consume large amounts of Claude Code context. The skill is a checklist that ensures kimi gets the absolute paths to spec/plan/memory it needs, and that the response stays bounded so Claude's tokens are protected.
---

# Delegating to kimi

Kimi runs in a separate process and sees nothing of Claude's conversation. The MCP server inlines the contents of `*_files` paths server-side, so Claude only pays tokens for the paths it sends and the response kimi returns. To keep the discipline tight, follow this checklist when composing an `ask_kimi` call.

## When to delegate (and when not to)

The win is **token economy**: kimi reads/writes large amounts of code in its own process, and Claude pays only for the paths sent plus the bounded response. So delegate work whose *inputs or intermediate steps* are large but whose *useful result* is small.

**Good fits — delegate these:**
- Codebase-wide audits / searches ("find every callsite of X", "where is Y configured") where the answer is a short list but the search would flood Claude's context.
- Mechanical multi-file refactors (rename, signature change, codemod) that produce a diff Claude just needs to review.
- Long, self-contained build/test/fix loops kimi can grind on independently.
- Reading & summarizing large files or generated output Claude doesn't need verbatim.

**Poor fits — do it in Claude instead:**
- Tasks needing back-and-forth clarification with the user — kimi can't see the conversation and won't ask.
- Work that depends on context already live in Claude's session (prior decisions, half-built state) — kimi starts blind every spawn.
- Small edits (a few lines in a known file) — the delegation overhead and round-trip cost more than just doing it.
- Anything where Claude must reason over the *full* output token-by-token — you'd pay for it on the way back anyway.

When unsure: if the task's result fits in a tight `expected_output` spec but getting there is bulky, delegate; otherwise keep it.

## Required fields

- `goal` — one sentence. Detail goes in `constraints` / `expected_output`, not in `goal`.
- `work_dir` — **absolute** path. Typically the user's current working directory; use Bash `pwd` if unsure.

## External file references

If the task references any file outside `work_dir` (memory, spec, plan, design doc, external schema, etc.), put its **absolute path** in the matching field:

| Field             | Use for                                        |
|-------------------|------------------------------------------------|
| `spec_files`      | spec / design / requirement docs               |
| `plan_files`      | implementation plans, checklists               |
| `memory_files`    | `~/.claude/memory/*.md`, project notes         |
| `context_files`   | other reference docs (READMEs from elsewhere)  |

Rules:
- Paths must be **absolute** and **outside `work_dir`** (server rejects otherwise — files inside `work_dir` are kimi's own to read with its tools).
- **Never** paste file contents into `goal`. The point of these fields is to keep contents out of Claude's context.
- Short literal snippets (a few lines) belong in `constraints`, not in a fake file.

## Bound the output

`expected_output` must be specific and bounded — vague phrasing produces verbose responses that Claude pays for:

- ✅ `"unified diff"`, `"JSON list of {file, line, finding}"`, `"<300-word summary"`, `"list of file paths"`, `"single function name"`
- ❌ `"a summary"`, `"the result"`, `"explain"`

## Permission flags

- `plan_mode: true` for research-only tasks (audit, analyze, "should we…"). Kimi will not write files.
- ⚠️ When `plan_mode` is omitted/false, kimi runs in **YOLO (auto-approve)** mode — it writes files anywhere it can reach under `work_dir` without confirmation. Use `plan_mode: true` whenever you only want analysis.

## After the call

- Status `finished` → summarize 2–5 bullets, quote salient diffs/lists. Do **not** paste long output verbatim — that costs Claude tokens.
- Status `cancelled` / error → surface to the user.

## Worked example

User: "Audit every callsite of the deprecated `legacyParse()` in this repo and write a migration plan to `docs/migrations/legacy-parse.md`. Use the style guide at `~/.claude/memory/style-guide.md`."

Claude composes:

```json
{
  "goal": "Audit all callsites of legacyParse() and write a migration plan.",
  "work_dir": "/Users/me/projects/foo",
  "memory_files": ["/Users/me/.claude/memory/style-guide.md"],
  "constraints": [
    "Match the style guide for the new code suggestions",
    "Migration plan must be a checklist, one bullet per callsite"
  ],
  "expected_output": "After completion, return a 5-bullet summary of: total callsites found, target file written, riskiest 2 callsites with reasoning. Do not echo the plan back."
}
```
