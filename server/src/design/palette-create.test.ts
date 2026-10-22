import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectPalette, planPalette } from "./palette-create.js";
import { readPalette, scanProjectFiles } from "./palette.js";

async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-palette-create-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const SITE = {
  "index.html": "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><a class=\"btn\">x</a></body></html>",
  "styles.css": [
    "body{background:#f7f3ec;color:#221c15}",
    ".card{background:#ffffff;color:#221c15;border:1px solid #e2d9c9}",
    ".btn{background:#2f6f4f;color:#ffffff;border-radius:8px}",
    "a{color:#2f6f4f}",
    "/* background:#000000 — комментарий, а не цвет страницы */",
    ".hero{background:url(\"/bg-#000000.png\") center/cover}",
  ].join("\n"),
};

test("палитра собирается из частых цветов страницы и переводит совпавшие стили на var()", async () => {
  const root = await project(SITE);
  const outcome = await createProjectPalette(root);
  assert.deepEqual(outcome, { created: true });

  const theme = await readFile(path.join(root, "theme.css"), "utf8");
  assert.match(theme, /--color-bg:#f7f3ec;/);
  assert.match(theme, /--color-surface:#ffffff;/);
  assert.match(theme, /--color-text:#221c15;/);
  assert.match(theme, /--color-accent:#2f6f4f;/);
  assert.match(theme, /--color-border:#e2d9c9;/);

  const css = await readFile(path.join(root, "styles.css"), "utf8");
  assert.match(css, /^@import "\.\/theme\.css";/);
  assert.match(css, /body\{background:var\(--color-bg\);color:var\(--color-text\)\}/);
  assert.match(css, /\.card\{background:var\(--color-surface\);color:var\(--color-text\);border:1px solid var\(--color-border\)\}/);
  assert.match(css, /\.btn\{background:var\(--color-accent\);color:#ffffff;/, "белый текст кнопки не выдаётся за «второстепенный»");
  // Комментарии и data-путь со словом цвета — не объявления, их трогать нельзя.
  assert.match(css, /\/\* background:#000000/, "комментарий остался как был");
  assert.match(css, /url\("\/bg-#000000\.png"\)/, "hex внутри url() — не цвет проекта");

  // После перевода палитра читается из проекта и страница действительно её использует.
  const palette = await readPalette(root);
  assert.deepEqual(palette.tokens.map(token => token.variable), [
    "--color-bg", "--color-surface", "--color-text", "--color-accent", "--color-border",
  ]);
  assert.ok(palette.tokens.every(token => token.used), "все токены должны читаться через var(--…)");
  assert.equal(palette.tokens.some(token => token.variable === "--color-muted"), false, "неиспользуемый производный цвет не выдаётся за палитру");
});

test("второй запуск ничего не перезаписывает: палитра уже есть", async () => {
  const root = await project({
    ...SITE,
    "theme.css": ":root{\n  --bg:#f7f3ec;\n  --ink:#221c15;\n}\n",
    "styles.css": ":root{--bg:#f7f3ec;--ink:#221c15}\nbody{background:var(--bg);color:var(--ink)}",
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, false);
  assert.equal(await readFile(path.join(root, "theme.css"), "utf8"), ":root{\n  --bg:#f7f3ec;\n  --ink:#221c15;\n}\n");
});

test("чужой theme.css без подключения не перезаписывается", async () => {
  const root = await project({
    "styles.css": "body{background:#f7f3ec;color:#221c15}",
    "theme.css": ":root{--brand:#123456}",
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, false);
  assert.match(outcome.reason ?? "", /theme\.css/);
  assert.equal(await readFile(path.join(root, "theme.css"), "utf8"), ":root{--brand:#123456}");
});

test("палитра из блока <style> подключится ссылкой, а не @import", async () => {
  const root = await project({
    "index.html": "<!doctype html><html><head><title>Сайт</title></head><body><style>body{background:#fff8f0;color:#241d16}a{color:#b23c17}</style></body></html>",
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, true);

  const html = await readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /<link rel="stylesheet" href="\.\/theme\.css">/, "страница получает подключение темы");
  assert.match(html, /body\{background:var\(--color-bg\);color:var\(--color-text\)\}/);
  assert.match(html, /a\{color:var\(--color-accent\)\}/, "единственный яркий цвет становится акцентом, а не второстепенным текстом");
  assert.match(await readFile(path.join(root, "theme.css"), "utf8"), /--color-bg:#fff8f0;/);

  const palette = await readPalette(root);
  assert.equal(palette.tokens.some(token => token.used), true);
});

test("если цветов в стилях нет, причина возвращается, а файлы не пишутся", async () => {
  const root = await project({
    "index.html": "<!doctype html><html><body><div class=\"bg-white text-slate-900\">x</div></body></html>",
    "app.css": ".bg-white{background:var(--tw-white)}",
    "App.tsx": "export const App = () => <div style={{ background: \"#fff\" }} />;",
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, false);
  assert.match(outcome.reason ?? "", /агент/i);
  await assert.rejects(stat(path.join(root, "theme.css")));
});

test("план перевода не берёт цвета из inline-стилей разметки", async () => {
  const root = await project({
    "index.html": "<!doctype html><html><body><div style=\"background:#ff0000;color:#00ff00\">x</div></body></html>",
  });
  const files = await scanProjectFiles(root);
  assert.equal(planPalette(files), null);
});
