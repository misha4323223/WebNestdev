import test from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "./parse.js";

test("JS/TS: импорты, re-export, require и динамический import", () => {
  const parsed = parseSource(".ts", [
    'import { helper } from "./helper";',
    'import type { User } from "@/types";',
    'import "./side.css";',
    'export { buildSession as session } from "./session";',
    'const legacy = require("./legacy");',
    'const lazy = import("./lazy");',
    "",
    "export interface Session { token: string }",
    "export type Role = \"admin\" | \"user\";",
    "export class AuthService {}",
    "export function buildSession(user: User): Session { return { token: user.id }; }",
    "export const formatName = (name: string) => name.trim();",
    "export { helper as help };",
  ].join("\n"));
  assert.equal(parsed.language, "ts");
  assert.deepEqual(parsed.imports.map(item => item.specifier).sort(), [
    "./helper", "./lazy", "./legacy", "./session", "./side.css", "@/types",
  ].sort());
  assert.deepEqual(parsed.symbols.sort(), [
    "AuthService", "Role", "Session", "buildSession", "formatName", "help", "session",
  ].sort());
});

test("комментарии и внешние ссылки не становятся импортами", () => {
  const parsed = parseSource(".tsx", [
    '// import { old } from "./old";',
    '/* import { dead } from "./dead"; */',
    'import { live } from "./live";',
    'const url = "https://example.com";',
  ].join("\n"));
  assert.deepEqual(parsed.imports.map(item => item.specifier), ["./live"]);
});

test("Python: относительный импорт, пакет и top-level символы", () => {
  const parsed = parseSource(".py", [
    "from .helper import load",
    "from . import settings",
    "import os",
    "import app.services.orders",
    "",
    "class AuthService:",
    "    def login(self):",
    "        pass",
    "",
    "def build_session():",
    "    pass",
  ].join("\n"));
  assert.equal(parsed.language, "python");
  assert.deepEqual(parsed.imports.map(item => item.specifier), [".helper", ".", "os", "app.services.orders"]);
  assert.deepEqual(parsed.symbols.sort(), ["AuthService", "build_session"].sort());
});

test("CSS и HTML дают локальные ссылки, но не http", () => {
  const css = parseSource(".css", '@import "./base.css";\n@import url("https://fonts.example/x.css");\n');
  assert.deepEqual(css.imports.map(item => item.specifier), ["./base.css"]);
  const html = parseSource(".html", '<link href="./style.css"><script src="/app.js"></script><a href="https://example.com">x</a>');
  assert.deepEqual(html.imports.map(item => item.specifier).sort(), ["./style.css", "/app.js"].sort());
});
