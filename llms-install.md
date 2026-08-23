# llm-ctxpack — machine-readable install & usage

Zero-install CLI that packs a git repository into an LLM-ready Markdown
context: git-diff-aware, token-budget-aware, secret-redacted by default.

## Run without installing

```bash
npx llm-ctxpack .
```

## Install globally

```bash
npm install -g llm-ctxpack
```

Requires Node.js >= 18. No API keys, no network calls, no telemetry: the tool
reads your repository locally and writes to stdout or a file.

## Core recipes (all commands tested)

```bash
# Pack the whole repo (respects .gitignore + sane defaults)
llm-ctxpack .

# Only what changed vs a git ref — 5 changed files in a 2k-file repo = 5 files packed
llm-ctxpack . --since main

# Fit a token budget; keeps most recently modified files, lists what was dropped
llm-ctxpack . --budget 50000

# Budget from a model's context window with 15% headroom for the reply
llm-ctxpack . --model claude-sonnet

# Restrict the pack set with gitignore-style patterns (repeatable)
llm-ctxpack . --include "src/**"
llm-ctxpack . --exclude "*.test.js" --exclude "docs/**"

# Show the largest packed files by token count (stderr, does not change output)
llm-ctxpack . --top 10

# Combine: diff-scoped, filtered, budgeted, written to a file
llm-ctxpack . --since main --include "src/**" --budget 20000 -o context.md
```

## Output shape

Markdown: header with file/token totals, a per-file token tree, an explicit
"Dropped (over budget)" section when budgeting, then fenced code blocks per
file. Paste-ready for any LLM chat or agent context.

## Secret redaction (on by default)

Before writing anything, likely credentials are replaced with labeled
placeholders: AWS access keys, GitHub/GitLab tokens, Slack tokens, Google API
keys, Stripe/OpenAI/Anthropic keys, JWTs, private key blocks, SendGrid,
Twilio, npm, HuggingFace, Vercel, and Linear tokens, `SECRET=`/`PASSWORD=`-style
env assignments, and passwords embedded in database connection URLs
(`postgres://user:[REDACTED]@host`). Disable only for trusted local use with
`--no-redact`.

## Related surfaces

- VS Code extension (`ctxpack`) on GitHub Releases — same engine via command palette.
- Hosted x402 HTTP variant for agents: see `agent-context-api` repository.
