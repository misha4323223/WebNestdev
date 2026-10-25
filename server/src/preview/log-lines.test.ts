import test from "node:test";
import assert from "node:assert/strict";
import { tailLogLines } from "./log-lines.js";

test("хвост берёт последние строки, а не весь лог запуска", () => {
  const raw = ["boot", "vite ready", "GET / 200", "GET /style.css 404", ""].join("\n");
  const result = tailLogLines(raw, 2);
  assert.deepEqual(result.lines, ["GET / 200", "GET /style.css 404"]);
  assert.equal(result.total, 4);
  assert.equal(result.matched, 4);
});

test("grep оставляет только совпадения и считает их до ограничения", () => {
  const raw = ["vite ready", "error EADDRINUSE :5173", "GET / 200", "error EADDRINUSE :5173", "done"].join("\n");
  const result = tailLogLines(raw, 1, "EADDRINUSE");
  assert.deepEqual(result.lines, ["error EADDRINUSE :5173"]);
  assert.equal(result.matched, 2);
});

test("несовпадение не отдаёт случайный хвост", () => {
  const result = tailLogLines("vite ready\ndone", 10, "ECONNREFUSED");
  assert.deepEqual(result.lines, []);
  assert.equal(result.matched, 0);
});

test("пустой лог и странное число строк не ломают вывод", () => {
  assert.deepEqual(tailLogLines("", 10), { lines: [], total: 0, matched: 0 });
  const result = tailLogLines("a\nb\nc", Number.NaN);
  assert.deepEqual(result.lines, ["a", "b", "c"]);
});
