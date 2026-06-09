---
description: Use this skill when Claude is preparing to call any mcp__kimicode__ask_kimi* tool, or when the user explicitly says "delegate to kimi" / "have kimi do this", or when a coding task is heavy/long/codebase-wide and would consume large amounts of Claude Code context. The skill is a checklist that ensures kimi gets the absolute paths to spec/plan/memory it needs, and that the response stays bounded so Claude's tokens are protected.
---

# Delegating to kimi

Kimi runs in a separate process and sees nothing of Claude's conversation. The MCP server inlines the contents of `*_files` paths server-side, so Claude only pays tokens for the paths it sends and the response kimi returns. To keep the discipline tight, follow this checklist when composing an `ask_kimi` call.

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
