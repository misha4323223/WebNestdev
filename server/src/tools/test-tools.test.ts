import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTestCommand, parseGitStatusPaths, runDeclaredTests, sandboxConcurrencyArgs, scopedTestCommand, shellQuote, summarizeTestOutput } from "./test-tools.js";

async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-test-tool-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test("npm test определяется по scripts.test", async () => {
  const root = await project({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
  try {
    assert.deepEqual(await detectTestCommand(root), {
      status: "configured",
      kind: "node",
      command: "npm test",
      packageManager: "npm",
      testScript: "vitest run",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pnpm-lock и packageManager выбирают правильный менеджер", async () => {
  const pnpm = await project({
    "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  });
  const bun = await project({
    "package.json": JSON.stringify({ packageManager: "bun@1.2.0", scripts: { test: "bun test" } }),
    "package-lock.json": "{}",
  });
  try {
    const pnpmDetected = await detectTestCommand(pnpm);
    const bunDetected = await detectTestCommand(bun);
    assert.equal(pnpmDetected.status === "configured" ? pnpmDetected.command : "", "pnpm test");
    assert.equal(bunDetected.status === "configured" ? bunDetected.command : "", "bun run test");
  } finally {
    await rm(pnpm, { recursive: true, force: true });
    await rm(bun, { recursive: true, force: true });
  }
});

test("pytest включается только по python-конфигурации", async () => {
  const root = await project({ "pyproject.toml": "[tool.pytest.ini_options]\n" });
  const empty = await project({ "README.md": "нет тестов\n" });
  try {
    const detected = await detectTestCommand(root);
    assert.equal(detected.status, "configured");
    assert.equal(detected.status === "configured" ? detected.kind : "", "python");
    const missing = await detectTestCommand(empty);
    assert.equal(missing.status, "not_configured");
    assert.match(missing.status === "not_configured" ? missing.reason : "", /scripts\.test/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

test("сводка понимает TAP, Vitest и pytest", () => {
  const tap = summarizeTestOutput("not ok 1 - loader\n  error: Error: boom\n# fail 1\n# pass 2\n", "");
  assert.deepEqual(tap.failures, ["loader"]);
  assert.equal(tap.failureDetails[0]?.message, "Error: boom");
  assert.match(tap.summary, /1/);

  const vitest = summarizeTestOutput("FAIL src/app.test.ts\n● app > loads\n  expected 1, got 2\nTests 1 failed | 2 passed\n", "");
  assert.ok(vitest.failures.includes("src/app.test.ts"));
  assert.equal(vitest.failureDetails.find(item => item.name === "app > loads")?.message, "expected 1, got 2");

  const pytest = summarizeTestOutput("FAILED tests/test_app.py::test_load - AssertionError\n1 failed, 2 passed\n", "");
  assert.deepEqual(pytest.failures, ["tests/test_app.py::test_load"]);
  assert.equal(pytest.failureDetails[0]?.message, "AssertionError");
});

test("сводка не выдумывает провал из пустого вывода", () => {
  const empty = summarizeTestOutput("", "");
  assert.deepEqual(empty.failures, []);
  assert.match(empty.summary, /без распознанной/);
});

test("affected-only добавляется только известному раннеру и внутри cwd", () => {
  const node = {
    status: "configured" as const,
    kind: "node" as const,
    command: "npm test",
    packageManager: "npm",
    testScript: "vitest run",
  };
  assert.deepEqual(scopedTestCommand(node, ["src/b.test.ts", "src/a.test.ts"], ""), {
    command: "npm test -- 'src/b.test.ts' 'src/a.test.ts'",
    scope: "affected",
  });
  assert.equal(scopedTestCommand(node, ["src/a.test.ts"], "packages/ui").scope, "full");
  assert.equal(scopedTestCommand({ ...node, testScript: "echo test" }, ["src/a.test.ts"], "").scope, "full");
  assert.equal(scopedTestCommand({ ...node, testScript: "vitest --watch" }, ["src/a.test.ts"], "").scope, "full");
  assert.equal(scopedTestCommand(node, [], "").scope, "full");
  assert.equal(scopedTestCommand(node, ["src/a.test.ts"], "", true).scope, "full");
});

test("runDeclaredTests различает pass, fail и timeout", async () => {
  const detected = {
    status: "configured" as const,
    kind: "node" as const,
    command: "npm test",
    packageManager: "npm",
    testScript: "vitest run",
  };
  let seen = "";
  const passed = await runDeclaredTests({
    detected,
    command: "npm test",
    timeoutMs: 1000,
    run: async command => {
      seen = command;
      return { ok: true, exitCode: 0, signal: null, stdout: "# pass 2\n", stderr: "", truncated: false };
    },
  });
  assert.equal(seen, "npm test");
  assert.equal(passed.status, "passed");
  assert.equal(passed.ok, true);
  assert.match(passed.summary, /прошло: 2/);

  const failed = await runDeclaredTests({
    detected,
    command: "npm test",
    timeoutMs: 1000,
    run: async () => ({ ok: false, exitCode: 1, signal: null, stdout: "not ok 1 - loader\n# fail 1\n# pass 0\n", stderr: "", truncated: false }),
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.failures, ["loader"]);
  assert.match(failed.summary, /провалено: 1/);

  const timeout = await runDeclaredTests({
    detected,
    command: "npm test",
    timeoutMs: 1000,
    run: async () => ({ ok: false, exitCode: 124, signal: "SIGKILL", stdout: "", stderr: "", truncated: false }),
  });
  assert.equal(timeout.status, "timeout");
  assert.match(timeout.hint ?? "", /лимит/);
});

test("sandbox-режим добавляет concurrency и сохраняет affected paths", () => {
  const vitest = {
    status: "configured" as const,
    kind: "node" as const,
    command: "npm test",
    packageManager: "npm",
    testScript: "vitest run",
  };
  assert.deepEqual(sandboxConcurrencyArgs(vitest), ["--maxWorkers=1"]);
  assert.deepEqual(scopedTestCommand(vitest, ["src/a.test.ts"], "", false, true), {
    command: "npm test -- --maxWorkers=1 'src/a.test.ts'",
    scope: "affected",
  });
  assert.deepEqual(
    sandboxConcurrencyArgs({ ...vitest, testScript: "node --test" }),
    ["--test-concurrency=1"],
  );
  assert.deepEqual(
    scopedTestCommand({ ...vitest, testScript: "node --test" }, ["src/a.test.ts"], "", false, true),
    { command: "npm test -- --test-concurrency=1 'src/a.test.ts'", scope: "affected" },
  );
});

test("git status -z разбирает обычные, новые и переименованные пути", () => {
  assert.deepEqual(
    parseGitStatusPaths(" M src/a.ts\0?? src/new.test.ts\0R  src/b.ts\0src/old.ts\0"),
    ["src/a.ts", "src/new.test.ts", "src/b.ts"],
  );
  assert.deepEqual(parseGitStatusPaths("\0\0"), []);
});

test("pytest получает пути без npm-разделителя, а кавычки не ломают shell", () => {
  const python = {
    status: "configured" as const,
    kind: "python" as const,
    command: "PYTHONPATH=.python python3 -m pytest -q",
    packageManager: "pytest",
  };
  assert.deepEqual(scopedTestCommand(python, ["tests/test_a.py"], ""), {
    command: "PYTHONPATH=.python python3 -m pytest -q 'tests/test_a.py'",
    scope: "affected",
  });
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
