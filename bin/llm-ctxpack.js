#!/usr/bin/env node
import { writeFileSync } from "fs";
import { resolve } from "path";
import {
  walkRepo,
  getChangedFiles,
  buildFileEntries,
  selectWithinBudget,
  renderMarkdown,
  budgetForModel,
} from "../src/lib.js";

function parseArgs(argv) {
  const args = { root: ".", out: null, since: null, budget: null, model: null, redact: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--budget") args.budget = parseInt(argv[++i], 10);
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--no-redact") args.redact = false;
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
                     (e.g. claude-sonnet, gpt-4o, gemini). Leaves headroom for the response.
  --out, -o <file>  Write output to a file instead of stdout
  --no-redact       Don't redact detected API keys/secrets (redaction is on by default)
  --help, -h        Show this help

Examples:
  llm-ctxpack .                       # pack whole repo
  llm-ctxpack . --since main          # pack only what changed vs main
  llm-ctxpack . --budget 50000        # fit within a 50k token budget
  llm-ctxpack . --model claude-sonnet # fit within Claude's context window
  llm-ctxpack . --since main --budget 20000 -o context.md
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  if (args.model) {
    const modelBudget = budgetForModel(args.model);
    if (modelBudget === null) {
      console.error(`Unknown model "${args.model}". Use --budget <tokens> instead.`);
      process.exit(1);
    }
    args.budget = args.budget ? Math.min(args.budget, modelBudget) : modelBudget;
  }

  const root = resolve(args.root);
  let relFiles = walkRepo(root);

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
