import test from "node:test";
import assert from "node:assert/strict";
import { FONT_OPTIONS, THEME_FIELDS, normalizeToken, parseTheme, patchTheme, themeFile } from "./theme.js";

const SAMPLE = [
  "/* палитра проекта */",
  ":root{",
  "  --color-bg:#0b0d10;",
  "  --color-text: #eef0f3;",
  "  --radius:12px;",
  "  --brand-shadow:0 10px 30px rgba(0,0,0,.4);",
  "}",
  "",
  ".card{background:var(--color-surface);border:1px solid var(--color-border)}",
  "",
].join("\n");

test("parseTheme reads the tokens of the contract and ignores the rest", () => {
  const tokens = parseTheme(SAMPLE);
  assert.equal(tokens["--color-bg"], "#0b0d10");
  assert.equal(tokens["--color-text"], "#eef0f3");
  assert.equal(tokens["--radius"], "12px");
  assert.equal(tokens["--brand-shadow"], undefined);
  assert.equal(tokens["--color-surface"], undefined);
});

test("patchTheme rewrites only the value and keeps the formatting", () => {
  const patched = patchTheme(SAMPLE, { "--color-bg": "#101820" });
  assert.match(patched, /:root\{\n  --color-bg:#101820;\n  --color-text: #eef0f3;/);
  assert.match(patched, /\.card\{background:var\(--color-surface\)/);
});

test("patchTheme keeps a space after the colon when the file had one", () => {
  const patched = patchTheme(SAMPLE, { "--color-text": "#ffffff" });
  assert.match(patched, /--color-text: #ffffff;/);
});

test("patchTheme appends a missing token to the existing :root block", () => {
  const patched = patchTheme(SAMPLE, { "--color-accent": "#e0603c" });
  // Токен встаёт последним объявлением блока, а не отдельным блоком после него.
  assert.match(patched, /--brand-shadow:[^;]+;\n  --color-accent:#e0603c;\n\}/);
  assert.equal(parseTheme(patched)["--color-accent"], "#e0603c");
  assert.equal(parseTheme(patched)["--color-bg"], "#0b0d10");
});

test("patchTheme writes a :root block when the file has none", () => {
  const patched = patchTheme(".card{color:red}", { "--color-bg": "#000000" });
  assert.match(patched, /:root\{\n  --color-bg:#000000;\n\}/);
  assert.match(patched, /^\.card\{color:red\}/);
});

test("normalizeToken refuses anything outside the contract", () => {
  assert.throws(() => normalizeToken("--color-bg", "#fff; } body{color:red"), /#rrggbb/);
  assert.throws(() => normalizeToken("--color-bg", "red"), /#rrggbb/);
  assert.throws(() => normalizeToken("--radius", "12rem"), /пикселях/);
  assert.throws(() => normalizeToken("--radius", "99px"), /пикселях/);
  assert.throws(() => normalizeToken("--font-body", "Comic Sans MS"), /не из списка/);
  assert.throws(() => normalizeToken("--color-brand", "#ffffff"), /Неизвестный токен/);
  assert.equal(normalizeToken("--color-bg", "#ABCDEF"), "#abcdef");
  assert.equal(normalizeToken("--font-heading", FONT_OPTIONS[1].value), FONT_OPTIONS[1].value);
});

test("patchTheme rejects an injected value instead of writing it into the file", () => {
  assert.throws(() => patchTheme(SAMPLE, { "--color-bg": "#fff;}body{display:none" }), /#rrggbb/);
});

test("themeFile produces a file every token of the contract can be read from", () => {
  const css = themeFile({ "--color-accent": "#ff8800" });
  const tokens = parseTheme(css);
  for (const field of THEME_FIELDS) assert.equal(tokens[field.variable], field.variable === "--color-accent" ? "#ff8800" : field.value);
  assert.match(css, /:root\{/);
});
