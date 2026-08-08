import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  walkRepo,
  countTokens,
  selectWithinBudget,
  buildFileEntries,
  budgetForModel,
  redactSecrets,
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
  const cases = [
    "AKIAABCDEFGHIJKLMNOP",
    "ghp_" + "a".repeat(36),
    "xoxb-1234567890-abcdefghij",
    "AIza" + "a".repeat(35),
    "sk_live_" + "a".repeat(24),
    "sk-" + "a".repeat(20),
    "sk-ant-" + "a".repeat(20),
    "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
  ];
  for (const secret of cases) {
    const { content, count } = redactSecrets(`const x = "${secret}";`);
    assert.ok(count >= 1, `expected redaction for: ${secret.slice(0, 20)}...`);
    assert.ok(!content.includes(secret), `expected secret to be gone: ${secret.slice(0, 20)}...`);
  }
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

test("CLI runs end to end and writes output file", () => {
  const dir = makeTmpRepo();
  const outFile = join(dir, "out.md");
  execFileSync("node", [join(import.meta.dirname, "../bin/llm-ctxpack.js"), dir, "-o", outFile]);
  const content = readFileSync(outFile, "utf8");
  assert.match(content, /# Context pack/);
  assert.match(content, /src\/a\.js/);
  rmSync(dir, { recursive: true, force: true });
});
