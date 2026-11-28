import test from "node:test";
import assert from "node:assert/strict";
import { failureLine } from "./failure-line.js";

test("причиной становится отказ docker, а не подсказка про --help", () => {
  const stderr = [
    "docker: Error response from daemon: failed to create task for container: OCI runtime create failed.",
    "",
    "Run 'docker run --help' for more information",
  ].join("\n");

  const line = failureLine({ stderr }) ?? "";
  assert.match(line, /Error response from daemon/);
  assert.doesNotMatch(line, /--help/);
});

test("хвост лога npm не скрывает строку с отказом реестра", () => {
  const stderr = [
    "npm ERR! code ENOTFOUND",
    "npm ERR! errno ENOTFOUND",
    "npm ERR! network request to https://registry.npmjs.org/vite failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
    "npm ERR! A complete log of this run can be found in: /root/.npm/_logs/2026-11-28T10_00_00_000Z-debug-0.log",
  ].join("\n");

  const line = failureLine({ stderr }) ?? "";
  assert.match(line, /getaddrinfo ENOTFOUND/);
  assert.doesNotMatch(line, /complete log/);
});

test("блок Usage из живого вывода docker причиной не считается", () => {
  // Точный stderr `docker run --runtime=runsc --bogus-flag` на ВМ (28.11.2026): причина — первая
  // строка, а последними идут блок Usage и подсказка про --help.
  const stderr = [
    "unknown flag: --bogus-flag",
    "",
    "Usage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]",
    "",
    "Run 'docker run --help' for more information",
  ].join("\n");

  assert.equal(failureLine({ stderr }), "unknown flag: --bogus-flag");
});

test("без явных признаков причины остаётся последняя содержательная строка", () => {
  assert.equal(failureLine({ stderr: "первая строка\nвторая строка\n\n" }), "вторая строка");
});

test("CRLF и пустой stderr не дают пустой причины", () => {
  assert.equal(failureLine({ stderr: "a\r\nb\r\n" }), "b");
  assert.equal(failureLine({ stderr: "   \n\n" }), undefined);
  assert.equal(failureLine({}), undefined);
});
