import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REDIRECTS,
  parseRedirects,
  renderRedirectsCaddy,
  renderRedirectDirectives,
} from "./redirects.js";

test("_redirects: точный и wildcard-редиректы сохраняют код и query", () => {
  const parsed = parseRedirects([
    "# комментарий",
    "/old /new 301",
    "/blog/* /articles/:splat 302",
  ].join("\n"));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rules, [
    { from: "/old", to: "/new", status: 301, wildcard: false },
    { from: "/blog/*", to: "/articles/:splat", status: 302, wildcard: true },
  ]);

  const directives = renderRedirectDirectives({
    hostname: "example.ru",
    rules: parsed.rules,
    namePrefix: "example.ru",
  }).join("\n");
  assert.match(directives, /host example\.ru/);
  assert.match(directives, /path \/old/);
  assert.match(directives, /redir @redirect_.* \/new\{\?query\} 301/);
  assert.match(directives, /path_regexp redirect_.* \^\/blog\/\(\.\*\)\$/);
  assert.match(directives, /redir @redirect_.* \/articles\/\{re\.redirect_.*\.1\}\{\?query\} 302/);
});

test("_redirects: внешние адреса, открытый редирект и query отклоняются", () => {
  const parsed = parseRedirects([
    "/a https://evil.example 301",
    "/b //evil.example 301",
    "/b2 /%2f%2fevil.example 301",
    "/c /d?x=1 301",
    "/d /ok 200",
    "/e/*/x /no 301",
    "/f /g extra 301",
  ].join("\n"));
  assert.equal(parsed.rules.length, 0);
  assert.equal(parsed.errors.length, 7);
  assert.match(parsed.errors.map(error => error.message).join(" "), /внутренним путём|301 или 302|один \*|Ожидается/);
});

test("_redirects: цикл и дубли не попадают в конфиг", () => {
  const cycle = parseRedirects("/a /b 301\n/b /a 301");
  assert.equal(cycle.rules.length, 1);
  assert.match(cycle.errors[0]?.message ?? "", /цикл/);

  const duplicate = parseRedirects("/a /b 301\n/a /c 301");
  assert.equal(duplicate.rules.length, 1);
  assert.match(duplicate.errors[0]?.message ?? "", /Дублирующее/);
});

test("_redirects: лимит правил и невалидные имена не ломают публикацию", () => {
  const lines = Array.from({ length: MAX_REDIRECTS + 1 }, (_, index) => "/old" + index + " /new" + index + " 301");
  const parsed = parseRedirects(lines.join("\n"));
  assert.equal(parsed.rules.length, MAX_REDIRECTS);
  assert.match(parsed.errors[0]?.message ?? "", /Больше/);

  const rendered = renderRedirectsCaddy([
    { hostname: "bad host", rules: parsed.rules.slice(0, 1) },
    { hostname: "example.ru", rules: parsed.rules.slice(0, 1) },
  ]);
  assert.doesNotMatch(rendered, /bad host/);
  assert.match(rendered, /example\.ru/);
});
