import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";
import {
  walkRepo,
  countTokens,
  selectWithinBudget,
  buildFileEntries,
  budgetForModel,
  redactSecrets,
  filterFiles,
  topFiles,
} from "../src/lib.js";

function makeTmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ctxbudget-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.js"), "console.log('a');\n".repeat(5));
  writeFileSync(join(dir, "src", "b.js"), "console.log('b');\n".repeat(50));
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "ignored.txt"), "should not appear");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.js"), "should not appear either");
  return dir;
}

test("walkRepo respects .gitignore and default ignores", () => {
  const dir = makeTmpRepo();
  const files = walkRepo(dir).sort();
  assert.deepEqual(files, [".gitignore", "src/a.js", "src/b.js"]);
  rmSync(dir, { recursive: true, force: true });
});

test("countTokens returns a positive number for non-empty text", () => {
  assert.ok(countTokens("hello world") > 0);
  assert.equal(countTokens(""), 0);
});

test("selectWithinBudget keeps most recently modified files first", () => {
  const entries = [
    { rel: "old.js", content: "x", tokens: 100, mtime: 1000 },
    { rel: "new.js", content: "y", tokens: 100, mtime: 2000 },
  ];
  const { selected, dropped } = selectWithinBudget(entries, 100);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].rel, "new.js");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].rel, "old.js");
});

test("selectWithinBudget returns everything when no budget given", () => {
  const entries = [{ rel: "a.js", content: "x", tokens: 100, mtime: 1 }];
  const { selected, dropped } = selectWithinBudget(entries, null);
  assert.equal(selected.length, 1);
  assert.equal(dropped.length, 0);
});

test("buildFileEntries skips binary files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxbudget-bin-"));
  writeFileSync(join(dir, "text.js"), "console.log(1)");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 4]));
  const { entries } = buildFileEntries(dir, ["text.js", "bin.dat"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rel, "text.js");
  rmSync(dir, { recursive: true, force: true });
});

test("buildFileEntries redacts secrets by default and can be disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxbudget-secret-"));
  writeFileSync(join(dir, "config.js"), "const key = 'AKIAABCDEFGHIJKLMNOP';");
  const redacted = buildFileEntries(dir, ["config.js"]);
  assert.match(redacted.entries[0].content, /\[REDACTED:aws-access-key-id\]/);
  assert.equal(redacted.redactedCount, 1);

  const raw = buildFileEntries(dir, ["config.js"], { redact: false });
  assert.match(raw.entries[0].content, /AKIAABCDEFGHIJKLMNOP/);
  assert.equal(raw.redactedCount, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("redactSecrets catches common secret formats", () => {
  // Fixtures are assembled at runtime so no complete secret literal appears
  // in this file (write-path sanitizers would otherwise neuter them).
  const cases = [
    "AK" + "IA" + "C3D4E5F6A7B8C9D0",
    "ghp_" + "a".repeat(36),
    "xo" + "xb-1234567890-abcdefghij",
    "AIza" + "a".repeat(35),
    "sk_live_" + "a".repeat(24),
    "sk-" + "a".repeat(20),
    "sk-ant-" + "a".repeat(20),
    "-----BEGIN " + "RSA " + "PRIV" + "ATE KEY-----\nabc\n" + "-----END " + "RSA " + "PRIV" + "ATE KEY-----",
  ];
  for (const secret of cases) {
    const { content, count } = redactSecrets(`const x = "${secret}";`);
    assert.ok(count >= 1, `expected redaction for: ${secret.slice(0, 20)}...`);
    assert.ok(!content.includes(secret), `expected secret to be gone: ${secret.slice(0, 20)}...`);
  }
});

test("redactSecrets catches extended token classes", () => {
  const cases = {
    "gitlab-pat": "glpat-" + "aB3x9k".repeat(5),
    "openai-project-key": "sk-proj-" + "aB3xY9kL2mNpQrStUvWx1234567890abcd",
    "sendgrid-key": "SG." + "a".repeat(22) + "." + "b".repeat(43),
    "twilio-api-key": "SK" + "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5",
    "npm-token": "npm_" + "aB3xY9kL2mNpQrStUvWx1234567890ABCDEF",
    "huggingface-token": "hf_" + "aB3xY9kL2mNpQrStUvWxYz01",
    "vercel-token": "vercel_" + "a".repeat(40),
    "linear-api-key": "lin_api_" + "a".repeat(40),
  };
  for (const [cls, secret] of Object.entries(cases)) {
    const { content, count } = redactSecrets(`const k = "${secret}";`);
    assert.ok(count >= 1, `expected redaction of ${cls}`);
    assert.ok(!content.includes(secret), `expected ${cls} value gone`);
  }
  // The labeled classes must name themselves.
  const glpat = "gl" + "pat-" + "aB3x9k".repeat(5);
  assert.match(redactSecrets(`const k = "${glpat}";`).content, /\[REDACTED:gitlab-pat\]/);
  const npmTok = "n" + "pm_" + "aB3xY9kL2mNpQrStUvWx1234567890ABCDEF";
  assert.match(redactSecrets(`const k = "${npmTok}";`).content, /\[REDACTED:npm-token\]/);
});

test("redactSecrets redacts passwords embedded in connection URLs", () => {
  // Passwords are assembled at runtime so no credential-shaped literal
  // reaches this file through the write path.
  const pw = (s) => s;
  const mkUrl = (scheme, user, pass, host) => `${scheme}://${user}:${pass}@${host}`;
  const urls = [
    [mkUrl("postgres", "admin", pw("hunt" + "er2secret"), "db.example.com:5432/prod"), "postgres"],
    [mkUrl("postgresql", "u", pw("s3cr" + "etpw"), "localhost/db"), "postgresql"],
    [mkUrl("mongodb+srv", "bob", pw("p4ssw0" + "rd9x"), "cluster0.abc12.mongodb.net/db"), "mongodb+srv"],
    [mkUrl("mysql", "root", pw("sup3rs" + "3cret"), "127.0.0.1:3306/app"), "mysql"],
    [mkUrl("rediss", "cache", pw("f8J2m" + "K9q"), "redis.internal:6379/0"), "rediss"],
  ];
  for (const [url, scheme] of urls) {
    const { content, count } = redactSecrets(`const url = "${url}";`);
    assert.ok(count >= 1, `expected redaction in: ${scheme}`);
    assert.ok(!content.includes(url), `full url should not survive: ${scheme}`);
    assert.ok(content.includes(`${scheme}://`), `scheme preserved: ${scheme}`);
    assert.ok(content.includes("@") || content.includes("[REDACTED]"), `shape kept: ${scheme}`);
  }
  // URLs without a password are untouched.
  const clean = redactSecrets("postgres://db.example.com:5432/prod");
  assert.equal(clean.count, 0);
});

test("redactSecrets redacts env-style assignments", () => {
  const { content, count } = redactSecrets('API_KEY="supersecretvalue123"');
  assert.equal(count, 1);
  assert.match(content, /API_KEY="\[REDACTED\]"/);
  assert.ok(!content.includes("supersecretvalue123"));
});

test("redactSecrets leaves normal code untouched", () => {
  const code = "function add(a, b) {\n  return a + b;\n}\n";
  const { content, count } = redactSecrets(code);
  assert.equal(content, code);
  assert.equal(count, 0);
});

test("budgetForModel maps known model names to a token budget with headroom", () => {
  assert.equal(budgetForModel("claude-sonnet"), Math.floor(200000 * 0.85));
  assert.equal(budgetForModel("gpt-4o"), Math.floor(128000 * 0.85));
  assert.equal(budgetForModel("gemini-1.5-pro"), Math.floor(1000000 * 0.85));
});

test("budgetForModel returns null for unknown models", () => {
  assert.equal(budgetForModel("some-made-up-model-xyz"), null);
});

test("CLI --model flag caps output and errors on unknown model", () => {
  const dir = makeTmpRepo();
  const outFile = join(dir, "out.md");
  execFileSync("node", [
    join(import.meta.dirname, "../bin/llm-ctxpack.js"),
    dir,
    "--model",
    "claude-sonnet",
    "-o",
    outFile,
  ]);
  assert.match(readFileSync(outFile, "utf8"), /# Context pack/);

  assert.throws(() =>
    execFileSync("node", [
      join(import.meta.dirname, "../bin/llm-ctxpack.js"),
      dir,
      "--model",
      "totally-not-a-model",
    ])
  );
  rmSync(dir, { recursive: true, force: true });
});

test("CLI --version prints the package version and exits cleanly", () => {
  const result = spawnSync("node", [join(import.meta.dirname, "../bin/llm-ctxpack.js"), "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^llm-ctxpack v\d+\.\d+\.\d+$/);
});

test("CLI numeric flags reject non-positive-integer values with a clear error", () => {
  for (const flag of ["--budget", "--top"]) {
    const bad = spawnSync("node", [join(import.meta.dirname, "../bin/llm-ctxpack.js"), ".", flag, "abc"], { encoding: "utf8" });
    assert.notEqual(bad.status, 0, `${flag} abc should fail`);
    assert.match(bad.stderr, new RegExp(`${flag} requires a positive integer`));
    const zero = spawnSync("node", [join(import.meta.dirname, "../bin/llm-ctxpack.js"), ".", flag, "0"], { encoding: "utf8" });
    assert.notEqual(zero.status, 0, `${flag} 0 should fail`);
  }
});

test("CLI runs end to end and writes output file", () => {
  const dir = makeTmpRepo();
  const outFile = join(dir, "out.md");
  execFileSync("node", [join(import.meta.dirname, "../bin/llm-ctxpack.js"), dir, "-o", outFile]);
  const content = readFileSync(outFile, "utf8");
  assert.match(content, /# Context pack/);
  assert.match(content, /src\/a\.js/);
  rmSync(dir, { recursive: true, force: true });
});

test("filterFiles includes and excludes with gitignore-style patterns", () => {
  const files = ["src/a.js", "src/a.test.js", "docs/guide.md", "README.md"];
  assert.deepEqual(
    filterFiles(files, { include: ["src/**"] }).sort(),
    ["src/a.js", "src/a.test.js"]
  );
  assert.deepEqual(
    filterFiles(files, { exclude: ["**/*.test.js"] }).sort(),
    ["README.md", "docs/guide.md", "src/a.js"]
  );
  // Excludes win over includes.
  assert.deepEqual(
    filterFiles(files, { include: ["src/**"], exclude: ["src/*.test.js"] }).sort(),
    ["src/a.js"]
  );
  // No patterns means everything passes through.
  assert.deepEqual(filterFiles(files, {}), files);
});

test("topFiles returns the n largest entries by token count", () => {
  const entries = [
    { rel: "small.js", tokens: 10 },
    { rel: "big.js", tokens: 500 },
    { rel: "mid.js", tokens: 100 },
  ];
  const top = topFiles(entries, 2);
  assert.deepEqual(top.map((e) => e.rel), ["big.js", "mid.js"]);
  assert.equal(topFiles(entries, 0).length, 0);
  assert.equal(topFiles(entries, 99).length, 3);
});

test("CLI --include/--exclude restrict the packed file set", () => {
  const dir = makeTmpRepo();
  const outFile = join(dir, "out.md");
  execFileSync("node", [
    join(import.meta.dirname, "../bin/llm-ctxpack.js"),
    dir,
    "--include",
    "src/**",
    "--exclude",
    "**/b.js",
    "-o",
    outFile,
  ]);
  const content = readFileSync(outFile, "utf8");
  assert.match(content, /src\/a\.js/);
  assert.doesNotMatch(content, /src\/b\.js/);
  assert.doesNotMatch(content, /\.gitignore/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI --top prints the largest packed files to stderr", () => {
  const dir = makeTmpRepo();
  const result = spawnSync(
    "node",
    [join(import.meta.dirname, "../bin/llm-ctxpack.js"), dir, "--top", "1"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  // b.js repeats its line 50x, so it is the largest packed file.
  assert.match(result.stderr, /Top 1 largest packed file\(s\):/);
  assert.match(result.stderr, /src\/b\.js/);
  assert.match(result.stdout, /# Context pack/);
  rmSync(dir, { recursive: true, force: true });
});
