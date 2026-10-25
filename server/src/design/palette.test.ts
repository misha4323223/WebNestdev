import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { colorToHex, normalizePaletteValue, patchPaletteValue, readPalette } from "./palette.js";

async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-palette-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

test("readPalette reads the variables a project declared itself", async () => {
  const root = await project({
    "index.html": "<!doctype html><link rel=\"stylesheet\" href=\"styles.css\"><body><h1>Привет</h1></body>",
    "styles.css": ":root{--bg:#f7f3ec;--ink:#221c15;--brand:#c9552b}\nbody{background:var(--bg);color:var(--ink)}\na{color:var(--brand)}",
  });
  const palette = await readPalette(root);
  const byName = new Map(palette.tokens.map(token => [token.variable, token]));
  assert.deepEqual([...byName.keys()], ["--bg", "--ink", "--brand"]);
  assert.equal(byName.get("--bg")?.value, "#f7f3ec");
  assert.equal(byName.get("--bg")?.kind, "color");
  assert.equal(byName.get("--bg")?.file, "styles.css");
  assert.equal(byName.get("--bg")?.label, "--bg");
  assert.equal(byName.get("--bg")?.used, true);
  assert.equal(palette.themeFile, null);
});

test("readPalette keeps the contract labels and order for a theme.css project", async () => {
  const root = await project({
    "theme.css": ":root{\n  --color-bg:#0b0d10;\n  --color-text:#eef0f3;\n  --radius:12px;\n}\n",
    "src/main.tsx": "import \"./theme.css\";",
    "src/app.css": "body{background:var(--color-bg);color:var(--color-text);border-radius:var(--radius)}",
  });
  const palette = await readPalette(root);
  assert.equal(palette.themeFile, "theme.css");
  assert.deepEqual(palette.tokens.map(token => token.variable), ["--color-bg", "--color-text", "--radius"]);
  assert.equal(palette.tokens[0].label, "Фон");
  assert.equal(palette.tokens[2].kind, "radius");
  assert.ok(palette.tokens.every(token => token.used));
});

test("readPalette exposes sizes and typography as editable tokens, not as fonts", async () => {
  const root = await project({
    "index.html": "<link rel=\"stylesheet\" href=\"theme.css\">",
    "theme.css": [
      ":root{",
      "  --font-body:ui-sans-serif, system-ui, sans-serif;",
      "  --font-size:18px;",
      "  --font-weight:500;",
      "  --line-height:1.6;",
      "  --space:24px;",
      "  --container:1120px;",
      "  --border-width:1px;",
      "  --z-index:10;",
      "  --duration:200ms;",
      "}",
      "body{font-family:var(--font-body);font-size:var(--font-size);font-weight:var(--font-weight);line-height:var(--line-height)}",
      ".wrap{padding:var(--space);max-width:var(--container);border-width:var(--border-width)}",
    ].join("\n"),
  });
  const kinds = new Map((await readPalette(root)).tokens.map(token => [token.variable, token.kind]));
  assert.equal(kinds.get("--font-body"), "font");
  assert.equal(kinds.get("--font-size"), "length", "размер шрифта — не шрифтовой стек");
  assert.equal(kinds.get("--font-weight"), "weight");
  assert.equal(kinds.get("--line-height"), "number");
  assert.equal(kinds.get("--space"), "length");
  assert.equal(kinds.get("--container"), "length");
  assert.equal(kinds.get("--border-width"), "length");
  assert.equal(kinds.get("--z-index"), undefined, "z-index не должен становиться ползунком");
  assert.equal(kinds.get("--duration"), undefined, "время анимации — не размер");
});

test("readPalette marks a declared variable the page never reads", async () => {
  const root = await project({
    "index.html": "<link rel=\"stylesheet\" href=\"theme.css\"><link rel=\"stylesheet\" href=\"styles.css\">",
    "theme.css": ":root{--color-bg:#0b0d10;--color-text:#eef0f3;}",
    "styles.css": "body{background:var(--color-bg);color:#111111}",
  });
  const palette = await readPalette(root);
  const tokens = new Map(palette.tokens.map(token => [token.variable, token.used]));
  assert.equal(tokens.get("--color-bg"), true);
  assert.equal(tokens.get("--color-text"), false);
});

test("readPalette finds nothing when colours are written inline", async () => {
  const root = await project({
    "index.html": "<!doctype html><style>body{background:#fff8f0;color:#241d16}</style><h1 style=\"color:#241d16\">Привет</h1>",
  });
  const palette = await readPalette(root);
  assert.deepEqual(palette.tokens, []);
});

test("readPalette converts rgb()/hsl() and skips translucent and alias values", async () => {
  const root = await project({
    "index.html": "<link rel=\"stylesheet\" href=\"theme.css\">",
    "theme.css": [
      ":root{",
      "  --color-bg:rgb(247, 243, 236);",
      "  --color-accent:hsl(210 40% 20%);",
      "  --color-shadow:rgba(0,0,0,.4);",
      "  --color-text:var(--ink);",
      "  --ink:#221c15;",
      "}",
      "body{background:var(--color-bg);color:var(--color-text)}",
    ].join("\n"),
  });
  const palette = await readPalette(root);
  const tokens = new Map(palette.tokens.map(token => [token.variable, token.value]));
  assert.equal(tokens.get("--color-bg"), "#f7f3ec");
  assert.equal(tokens.get("--color-accent"), "#1f3347");
  assert.equal(tokens.get("--color-shadow"), undefined);
  assert.equal(tokens.get("--color-text"), undefined);
  assert.equal(tokens.get("--ink"), "#221c15");
});

test("readPalette ignores a theme.css the page does not load", async () => {
  const root = await project({
    "theme.css": ":root{--color-bg:#0b0d10;}",
    "styles.css": ":root{--color-bg:#f7f3ec}\nbody{background:var(--color-bg)}",
    "index.html": "<link rel=\"stylesheet\" href=\"styles.css\">",
  });
  const palette = await readPalette(root);
  const bg = palette.tokens.find(token => token.variable === "--color-bg");
  // Неподключённый файл темы не переопределяет палитру: панель показывает и правит styles.css.
  assert.equal(bg?.value, "#f7f3ec");
  assert.equal(bg?.file, "styles.css");
  assert.equal(bg?.used, true);
});

test("readPalette prefers the imported theme.css over a duplicate declaration", async () => {
  const root = await project({
    "theme.css": ":root{--color-bg:#0b0d10;}",
    "styles.css": ":root{--color-bg:#f7f3ec}\nbody{background:var(--color-bg)}",
    "main.tsx": "import \"./theme.css\";\nimport \"./styles.css\";",
  });
  const palette = await readPalette(root);
  const bg = palette.tokens.find(token => token.variable === "--color-bg");
  assert.equal(bg?.value, "#0b0d10");
  assert.equal(bg?.file, "theme.css");
  // Правка уйдёт в подключённый файл темы, а не в перекрывающее объявление.
  assert.equal(bg?.used, true);
});

test("colorToHex understands the formats projects really use", () => {
  assert.equal(colorToHex("#ABC"), "#aabbcc");
  assert.equal(colorToHex("#aabbcc"), "#aabbcc");
  assert.equal(colorToHex("#aabbccff"), "#aabbcc");
  assert.equal(colorToHex("#aabbcc80"), null);
  assert.equal(colorToHex("rgb(255 0 0)"), "#ff0000");
  assert.equal(colorToHex("rgba(255,0,0,1)"), "#ff0000");
  assert.equal(colorToHex("rgba(255,0,0,.5)"), null);
  assert.equal(colorToHex("hsl(0, 100%, 50%)"), "#ff0000");
  assert.equal(colorToHex("white"), "#ffffff");
  assert.equal(colorToHex("transparent"), null);
  assert.equal(colorToHex("var(--ink)"), null);
  assert.equal(colorToHex("0 10px 30px rgba(0,0,0,.4)"), null);
});

test("patchPaletteValue rewrites only the value it was given", () => {
  const css = ":root{\n  --bg:#f7f3ec;\n  --ink:#221c15;\n}\nbody{background:#f7f3ec}";
  const patched = patchPaletteValue(css, "--bg", "color", "#101820");
  assert.match(patched, /--bg:#101820;/);
  assert.match(patched, /--ink:#221c15;/);
  // Значение вне объявления (использование в правиле) не трогается: палитра правит токены.
  assert.match(patched, /body\{background:#f7f3ec\}/);
});

test("patchPaletteValue refuses an injected value and an unknown variable", () => {
  assert.throws(() => patchPaletteValue(":root{--bg:#ffffff;}", "--bg", "color", "#fff;}body{display:none"), /#rrggbb/);
  assert.throws(() => patchPaletteValue(":root{--bg:#ffffff;}", "--nope", "color", "#ffffff"), /больше нет переменной/);
});

test("normalizePaletteValue checks the value by the kind of the token", () => {
  assert.equal(normalizePaletteValue("color", "#ABCDEF"), "#abcdef");
  assert.throws(() => normalizePaletteValue("color", "red"), /#rrggbb/);
  assert.throws(() => normalizePaletteValue("radius", "99px"), /пикселях/);
  assert.equal(normalizePaletteValue("radius", "8px"), "8px");
  assert.throws(() => normalizePaletteValue("font", "Arial; } body{display:none}"), /стеком/);
  assert.throws(() => normalizePaletteValue("font", "url(https://cdn.example/font.woff2)"), /стеком/);
  assert.equal(normalizePaletteValue("length", "1.5REM"), "1.5rem");
  assert.throws(() => normalizePaletteValue("length", "12"), /единицей/);
  assert.throws(() => normalizePaletteValue("length", "99999px"), /пределы/);
  assert.equal(normalizePaletteValue("weight", "700"), "700");
  assert.throws(() => normalizePaletteValue("weight", "950"), /100 до 900/);
  assert.equal(normalizePaletteValue("number", "1.6"), "1.6");
  assert.throws(() => normalizePaletteValue("number", "1.6px"), /без единиц/);
});
