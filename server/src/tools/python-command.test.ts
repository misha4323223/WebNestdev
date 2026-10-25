import test from "node:test";
import assert from "node:assert/strict";
import { buildPipInstallCommand, shellQuote } from "./python-command.js";

test("a version range is quoted, so the shell does not read it as a redirect", () => {
  const command = buildPipInstallCommand({ packages: ["requests>=2.32,<3"] });
  assert.match(command, /'requests>=2\.32,<3'/);
  // Без кавычек `>` стал бы записью в файл `=2.32,<3`.
  assert.ok(!command.includes("requests>=2.32,<3 "), "версия должна быть в кавычках");
});

test("no packages means requirements.txt, with the -r flag", () => {
  const command = buildPipInstallCommand({ packages: [] });
  assert.match(command, /'-r' 'requirements\.txt'/);
  assert.match(command, /'--target' '\.python'/);
});

test("upgrade and extra flags stay separate arguments", () => {
  const command = buildPipInstallCommand({ packages: ["django"], upgrade: true, extraFlags: ["--break-system-packages"] });
  assert.match(command, /'--break-system-packages'/);
  assert.match(command, /'--upgrade'/);
  assert.match(command, /'django'/);
});

test("a quote inside a value is escaped instead of ending the argument", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
