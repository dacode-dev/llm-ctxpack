# llm-ctxpack

Pack a repo into LLM-ready context — **git-diff-aware** and **token-budget-aware**, so you're not pasting your whole codebase into a chat window every time.

- **`--since <ref>`** — restricts the *packed file set* to what changed since a git ref, rather than dumping the whole repo and appending a diff on top of it. If 5 files changed in a 2,000-file repo, you get 5 files.
- **`--budget <tokens>`** — actually fits the output to a token budget: keeps the most recently modified files and drops the rest with an explicit list of what was cut, rather than just failing/erroring when you're over the limit.
- **Secret redaction, on by default** — API keys, private key blocks, tokens, and `SECRET=`/`PASSWORD=`-style env values get redacted before anything is written out, so you don't accidentally paste a live credential into a chat window. Use `--no-redact` if you really want raw output.

## Install

No install needed:

```bash
npx llm-ctxpack .
```

Or install globally:

```bash
npm install -g llm-ctxpack
```

## Usage

```bash
llm-ctxpack .                              # pack whole repo
llm-ctxpack . --since main                 # only what changed vs main
llm-ctxpack . --budget 50000               # fit within a 50k token budget
llm-ctxpack . --since main --budget 20000 -o context.md
```

Output is Markdown: a file tree with per-file token counts, then fenced code blocks for each file, ready to paste into any LLM chat or agent context.

Respects `.gitignore` automatically, plus sensible defaults (`node_modules`, lockfiles, binaries, build output).

## Hosted option for agents

If an agent needs a ready HTTPS service instead of adding local deployment and monitoring, the operated [Agent Context API](https://agent-context-api-proxy.agent-context-proxy.workers.dev/) provides x402 routes for context preflight, secret redaction, and fresh agent-work/market signals. The public [landing page](https://dacode-dev.github.io/agent-context-api.html) lists current prices and the machine-readable manifest.

The API source is also public and self-hosting remains supported. The hosted charge is for the maintained run—fresh upstream polling, normalization, health checks, bounded probes, and repairs—not for exclusive code or data. Buyers should use it only when that operational convenience is worth the small per-request price.

## Options

| Flag | Description |
|---|---|
| `--since <ref>` | Only include files changed since this git ref (e.g. `main`, `HEAD~5`) |
| `--budget <tokens>` | Cap total output tokens, keeping most recently modified files first |
| `--out, -o <file>` | Write to a file instead of stdout |
| `--no-redact` | Disable secret redaction (on by default) |

Token counts use the same tokenizer family as GPT/Claude-class models ([`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer)), so budgets are a close real-world estimate, not a guess.

## Works with

Any tool that takes pasted-in text as context: Claude, Claude Code, ChatGPT, Cursor, GitHub Copilot Chat, or a custom agent's system prompt. `--model` presets cover the common ones; `--budget` works for anything else.

## Why

Every "dump repo to text" tool assumes you want everything. In practice, agentic coding workflows usually want **the diff** (what changed) trimmed to **what fits** (the model's context window). `llm-ctxpack` does both without extra flags or config files.

## License

MIT

## Support this project

`llm-ctxpack` is free, MIT-licensed, and has no paid tier. If it saved you time, you can send a tip to the project wallet — no account or sign-up needed on either end.

If you use Claude Code, a suggested `$12` tip also unlocks three private bonus commands/agents in the [Claude Code Power Pack Pro](https://github.com/dacode-dev/claude-code-power-pack#support). Send a supported native coin or USDC, then use the automated claim form; payment verification and repository access are handled by GitHub Actions.

**[dacode-dev.github.io](https://dacode-dev.github.io/)** — QR code + copy-paste address, one page, no tracking.

Or directly: `0xc4e8021CdFf1a11946Ed16bd264f77D6B3C0C0e9`

Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche C-Chain — same address on all of them, native token or stablecoins (USDC/USDT). Pick whichever has the lowest fee for you (Base/Arbitrum/Polygon are cheapest).
