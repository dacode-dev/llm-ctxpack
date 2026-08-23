import { readFileSync, statSync, readdirSync } from "fs";
import { join, relative, extname } from "path";
import { execFileSync } from "child_process";
import ignore from "ignore";
import { encode } from "gpt-tokenizer";

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.svg",
  "*.pdf",
  "*.woff*",
  "*.ttf",
  "*.eot",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.mp4",
  "*.mov",
];

const LANG_BY_EXT = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "bash",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".json": "json",
  ".md": "markdown",
  ".html": "html",
  ".css": "css",
  ".sql": "sql",
};

function loadIgnore(root) {
  const ig = ignore().add(DEFAULT_IGNORES);
  try {
    ig.add(readFileSync(join(root, ".gitignore"), "utf8"));
  } catch {
    // no .gitignore, defaults only
  }
  return ig;
}

export function walkRepo(root) {
  const ig = loadIgnore(root);
  const out = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (ig.ignores(rel) || ig.ignores(entry.isDirectory() ? rel + "/" : rel)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  walk(root);
  return out;
}

// Filter a relative-path list through user-supplied include/exclude patterns.
// Both use gitignore-style syntax via the `ignore` package. Excludes win over
// includes; an empty include list means "everything not excluded".
export function filterFiles(relFiles, { include = [], exclude = [] } = {}) {
  let files = relFiles;
  if (include.length) {
    const igInclude = ignore().add(include);
    files = files.filter((f) => igInclude.ignores(f));
  }
  if (exclude.length) {
    const igExclude = ignore().add(exclude);
    files = files.filter((f) => !igExclude.ignores(f));
  }
  return files;
}

export function topFiles(entries, n) {
  return [...entries].sort((a, b) => b.tokens - a.tokens).slice(0, Math.max(0, Math.floor(n)));
}

export function getChangedFiles(root, sinceRef) {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", sinceRef, "--"],
      { cwd: root, encoding: "utf8" }
    );
    return new Set(output.split("\n").filter(Boolean));
  } catch (err) {
    throw new Error(`git diff against "${sinceRef}" failed: ${err.message}`);
  }
}

function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function readFileSafe(root, rel) {
  const full = join(root, rel);
  const buf = readFileSync(full);
  if (isProbablyBinary(buf)) return null;
  return buf.toString("utf8");
}

const SECRET_PATTERNS = [
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: "gitlab-pat", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe-key", re: /\b(?:sk|pk|rk)_live_[0-9a-zA-Z]{24,}\b/g },
  { name: "openai-key", re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "private-key-block", re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { name: "twilio-api-key", re: /\bSK[a-f0-9]{32}\b/g },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: "vercel-token", re: /\bvercel_[A-Za-z0-9]{16,}\b/g },
  { name: "linear-api-key", re: /\blin_api_[A-Za-z0-9_]{20,}\b/g },
];

// Database/service connection URLs carrying an embedded password, e.g.
// postgres://user:secretpw@host:5432/db. The password segment is replaced;
// scheme, user, host, and path are preserved so the line stays readable.
const CONN_URL_RE =
  /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql):\/\/[^:\/\s"@]+:)([^@"\s]{6,})(@)/g;

// KEY=value / KEY: "value" style assignments where the key name looks secret-ish.
const ENV_ASSIGNMENT_RE =
  /^(\s*[\w.]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY)[\w.]*\s*[:=]\s*['"]?)([^\s'"]{6,})(['"]?)/gim;

export function redactSecrets(content) {
  let redacted = content;
  let count = 0;
  for (const { name, re } of SECRET_PATTERNS) {
    redacted = redacted.replace(re, () => {
      count++;
      return `[REDACTED:${name}]`;
    });
  }
  redacted = redacted.replace(ENV_ASSIGNMENT_RE, (_m, pre, _val, post) => {
    count++;
    return `${pre}[REDACTED]${post}`;
  });
  // Connection URLs: keep scheme+user, drop the password. Run after the
  // token patterns so a token that also looks like a URL password is
  // labeled with its more specific class.
  redacted = redacted.replace(CONN_URL_RE, (_m, pre, _pw, at) => {
    count++;
    return `${pre}[REDACTED]${at}`;
  });
  return { content: redacted, count };
}

export function countTokens(text) {
  return encode(text).length;
}

const MODEL_CONTEXT_WINDOWS = [
  [/claude.*(opus|sonnet|haiku)/i, 200000],
  [/claude/i, 200000],
  [/gpt-4o|gpt-4-turbo|gpt-4\.1/i, 128000],
  [/gpt-3\.5/i, 16000],
  [/gpt/i, 128000],
  [/gemini/i, 1000000],
  [/llama-3\.1|llama-3\.2|llama-3\.3/i, 128000],
  [/llama/i, 8000],
  [/mistral|mixtral/i, 128000],
  [/deepseek/i, 128000],
];

// Reserve headroom for the system prompt, instructions, and the model's own
// response — you don't get to spend the whole window on pasted-in files.
const HEADROOM_RATIO = 0.15;

export function budgetForModel(name) {
  for (const [pattern, window] of MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(name)) {
      return Math.floor(window * (1 - HEADROOM_RATIO));
    }
  }
  return null;
}

export function buildFileEntries(root, relFiles, { redact = true } = {}) {
  const entries = [];
  let redactedCount = 0;
  for (const rel of relFiles) {
    let content;
    try {
      content = readFileSafe(root, rel);
    } catch {
      continue;
    }
    if (content === null) continue;
    if (redact) {
      const result = redactSecrets(content);
      content = result.content;
      redactedCount += result.count;
    }
    const tokens = countTokens(content);
    const mtime = statSync(join(root, rel)).mtimeMs;
    entries.push({ rel, content, tokens, mtime });
  }
  return { entries, redactedCount };
}

export function selectWithinBudget(entries, budget) {
  if (!budget) return { selected: entries, dropped: [] };
  const sorted = [...entries].sort((a, b) => b.mtime - a.mtime);
  const selected = [];
  const dropped = [];
  let used = 0;
  for (const e of sorted) {
    if (used + e.tokens <= budget) {
      selected.push(e);
      used += e.tokens;
    } else {
      dropped.push(e);
    }
  }
  const byOriginalOrder = new Set(selected.map((e) => e.rel));
  return {
    selected: entries.filter((e) => byOriginalOrder.has(e.rel)),
    dropped,
  };
}

export function renderMarkdown(entries, { root, meta = {} } = {}) {
  const totalTokens = entries.reduce((s, e) => s + e.tokens, 0);
  const lines = [];
  lines.push(`# Context pack`);
  if (meta.since) lines.push(`_Changed files since \`${meta.since}\`_`);
  lines.push(`\n${entries.length} files, ~${totalTokens} tokens\n`);
  lines.push(`## File tree\n`);
  for (const e of entries) lines.push(`- ${e.rel} (${e.tokens} tok)`);
  if (meta.dropped && meta.dropped.length) {
    lines.push(`\n## Dropped (over budget)\n`);
    for (const e of meta.dropped) lines.push(`- ${e.rel} (${e.tokens} tok)`);
  }
  lines.push(`\n## Files\n`);
  for (const e of entries) {
    const lang = LANG_BY_EXT[extname(e.rel)] || "";
    lines.push(`### ${e.rel}\n`);
    lines.push("```" + lang);
    lines.push(e.content.replace(/```/g, "​```"));
    lines.push("```\n");
  }
  return lines.join("\n");
}
