#!/usr/bin/env node
import { writeFileSync } from "fs";
import { resolve } from "path";
import {
  walkRepo,
  getChangedFiles,
  filterFiles,
  topFiles,
  buildFileEntries,
  selectWithinBudget,
  renderMarkdown,
  budgetForModel,
} from "../src/lib.js";

function parseNumeric(argv, i, flag) {
  const raw = argv[i + 1];
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`llm-ctxpack: ${flag} requires a positive integer (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

function parseArgs(argv) {
  const args = { root: ".", out: null, since: null, budget: null, model: null, redact: true, include: [], exclude: [], top: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--budget") args.budget = parseNumeric(argv, i++, "--budget");
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--no-redact") args.redact = false;
    else if (a === "--include") args.include.push(argv[++i]);
    else if (a === "--exclude") args.exclude.push(argv[++i]);
    else if (a === "--top") args.top = parseNumeric(argv, i++, "--top");
    else if (a === "--version") args.version = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args.root = a;
  }
  return args;
}

function printHelp() {
  console.log(`llm-ctxpack — pack a repo into LLM-ready context

Usage:
  llm-ctxpack [path] [options]

Options:
  --since <ref>     Only include files changed since this git ref (e.g. main, HEAD~5)
  --budget <tokens>  Cap total output to this many tokens, keeping most recently modified files
  --model <name>    Set budget from a model's context window instead of a raw number
                     (e.g. claude-sonnet, gpt-5, grok, gemini). Leaves headroom for the response.
  --include <glob>  Only include paths matching this gitignore-style pattern (repeatable)
  --exclude <glob>  Skip paths matching this gitignore-style pattern (repeatable; wins over --include)
  --top <n>         After packing, print the n largest packed files by token count to stderr
  --out, -o <file>  Write output to a file instead of stdout
  --no-redact       Don't redact detected API keys/secrets (redaction is on by default)
  --help, -h        Show this help

Examples:
  llm-ctxpack .                       # pack whole repo
  llm-ctxpack . --since main          # pack only what changed vs main
  llm-ctxpack . --budget 50000        # fit within a 50k token budget
  llm-ctxpack . --model claude-sonnet # fit within Claude's context window
  llm-ctxpack . --include "src/**"    # only files under src/
  llm-ctxpack . --exclude "*.test.js" --exclude "docs/**"
  llm-ctxpack . --top 10              # show the 10 largest files by token count
  llm-ctxpack . --since main --budget 20000 -o context.md
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.version) {
    console.log(`llm-ctxpack v${process.env.npm_package_version || "0.5.0"}`);
    return;
  }

  if (args.model) {
    const modelBudget = budgetForModel(args.model);
    if (modelBudget === null) {
      console.error(`Unknown model "${args.model}". Use --budget <tokens> instead.`);
      process.exit(1);
    }
    args.budget = args.budget ? Math.min(args.budget, modelBudget) : modelBudget;
  }

  const root = resolve(args.root);
  let relFiles = filterFiles(walkRepo(root), { include: args.include, exclude: args.exclude });

  if (args.since) {
    const changed = getChangedFiles(root, args.since);
    relFiles = relFiles.filter((f) => changed.has(f));
  }

  let { entries, redactedCount } = buildFileEntries(root, relFiles, { redact: args.redact });
  let dropped = [];
  if (args.budget) {
    const result = selectWithinBudget(entries, args.budget);
    entries = result.selected;
    dropped = result.dropped;
  }

  if (args.top) {
    const top = topFiles(entries, args.top);
    if (top.length) {
      console.error(`\nTop ${top.length} largest packed file(s):`);
      for (const e of top) console.error(`  ${String(e.tokens).padStart(7)} tok  ${e.rel}`);
    }
  }

  const markdown = renderMarkdown(entries, {
    root,
    meta: { since: args.since, dropped },
  });

  if (args.out) {
    writeFileSync(args.out, markdown);
    const totalTokens = entries.reduce((s, e) => s + e.tokens, 0);
    console.error(`Wrote ${entries.length} files (~${totalTokens} tokens) to ${args.out}`);
    if (dropped.length) {
      console.error(`Dropped ${dropped.length} files to stay within budget.`);
    }
  } else {
    process.stdout.write(markdown);
  }

  if (redactedCount > 0) {
    console.error(
      `\nRedacted ${redactedCount} likely secret(s) before output. Use --no-redact to disable.`
    );
  }
}

main();
