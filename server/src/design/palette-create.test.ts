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

test("если цветов нет ни в стилях, ни в классах, причина возвращается, а файлы не пишутся", async () => {
  const root = await project({
    "index.html": "<!doctype html><html><body><div class=\"row\">x</div></body></html>",
    "app.css": ".row{display:flex;gap:8px}",
    "App.tsx": "export const App = () => <div style={{ padding: 8 }} />;",
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, false);
  assert.match(outcome.reason ?? "", /агент/i);
  await assert.rejects(stat(path.join(root, "theme.css")));
});

test("цвета из inline-стилей разметки попадают в палитру и переводятся на var()", async () => {
  const root = await project({
    "index.html": [
      "<!doctype html><html><head></head><body>",
      '<div style="background:#f7f3ec;color:#221c15">x</div>',
      '<a style="background:#2f6f4f;color:#ffffff">y</a>',
      "</body></html>",
    ].join("\n"),
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, true);

  const html = await readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /<link rel="stylesheet" href="\.\/theme\.css">/);
  assert.match(html, /style="background:var\(--color-bg\);color:var\(--color-text\)"/);
  assert.match(html, /style="background:var\(--color-accent\);color:#ffffff"/, "цвет кнопки становится акцентом");
  assert.match(await readFile(path.join(root, "theme.css"), "utf8"), /--color-bg:#f7f3ec;/);
});

test("проект на Tailwind: цвета из классов и inline-стилей JSX переходят на тему", async () => {
  const root = await project({
    "src/index.css": "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n",
    "src/App.tsx": [
      '"use client";',
      "export function App(){",
      '  return <main className="bg-slate-950 text-slate-100">',
      '    <button className="bg-emerald-500 text-white hover:bg-emerald-400" style={{ borderColor: "#1e293b" }}>ok</button>',
      "  </main>;",
      "}",
    ].join("\n"),
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, true);

  const tsx = await readFile(path.join(root, "src/App.tsx"), "utf8");
  assert.match(tsx, /^"use client";\nimport "\.\.\/theme\.css";/, "директива остаётся первой строкой, тема подключается импортом");
  assert.match(tsx, /className="bg-\[var\(--color-bg\)\] text-\[var\(--color-text\)\]"/);
  assert.match(tsx, /bg-\[var\(--color-accent\)\] text-\[var\(--color-muted\)\] hover:bg-emerald-400/, "свой вариант без токена не трогается");
  assert.match(tsx, /style=\{\{ borderColor: "var\(--color-border\)" \}\}/);

  const theme = await readFile(path.join(root, "theme.css"), "utf8");
  assert.match(theme, /--color-bg:#020617;/, "слейт-950 из класса становится фоном");
  assert.match(theme, /--color-accent:#10b981;/, "единственный яркий цвет становится акцентом");
});

test("статика из public/: тема лежит рядом со страницей и реально отдаётся сервером", async () => {
  const root = await project({
    "public/index.html": "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><h1>x</h1></body></html>",
    "public/styles.css": "body{background:#f7f3ec;color:#221c15}\n.btn{background:#2f6f4f;color:#ffffff}",
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, true);
  await assert.rejects(stat(path.join(root, "theme.css")));

  const css = await readFile(path.join(root, "public/styles.css"), "utf8");
  assert.match(css, /^@import "\.\/theme\.css";/);
  assert.match(await readFile(path.join(root, "public/theme.css"), "utf8"), /--color-bg:#f7f3ec;/);

  const palette = await readPalette(root);
  assert.equal(palette.tokens.find(token => token.variable === "--color-bg")?.file, "public/theme.css");
});

test("серверный HTML-шаблон: палитра из <style> в .js без импорта CSS", async () => {
  const server = [
    'import express from "express";',
    "const app = express();",
    "const page = `<!doctype html><html><head><style>",
    "body{background:#0f172a;color:#e2e8f0}",
    ".card{background:#1e293b;border:1px solid #334155}",
    ".btn{background:#22c55e;color:#ffffff}",
    "</style></head><body><h1>Привет</h1></body></html>`;",
    'app.get("/", (_req,res)=>res.send(page));',
  ].join("\n");
  const root = await project({ "server.js": server });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, true);

  const code = await readFile(path.join(root, "server.js"), "utf8");
  assert.doesNotMatch(code, /import "\.\/theme\.css"/, "в серверный JS нельзя импортировать CSS");
  assert.match(code, /:root\{/, "переменные объявлены в самом шаблоне");
  assert.match(code, /--color-bg:#0f172a;/);
  assert.match(code, /body\{background:var\(--color-bg\);color:var\(--color-text\)\}/);
  assert.match(code, /\.btn\{background:var\(--color-accent\);/);
  await assert.rejects(stat(path.join(root, "theme.css")), "отдельный theme.css не нужен");

  const palette = await readPalette(root);
  assert.ok(palette.tokens.length >= 3, "панель видит палитру из серверного шаблона");
  assert.ok(palette.tokens.every(token => token.used), "все токены читаются через var(--…)");
  assert.equal(palette.tokens.find(token => token.variable === "--color-bg")?.file, "server.js");
});

test("серверная страница в обычной строке не ломается переводами строк", async () => {
  const root = await project({
    "server.js": "const page = '<!doctype html><html><head><style>body{background:#0f172a;color:#e2e8f0}</style></head><body>x</body></html>';\nmodule.exports = page;\n",
  });
  const outcome = await createProjectPalette(root);
  assert.equal(outcome.created, true);
  const code = await readFile(path.join(root, "server.js"), "utf8");
  assert.equal(code.split("\n")[0].includes(":root{"), true, "блок темы остался в той же строке");
  assert.equal(code.trimEnd().split("\n").length, 2, "переводов строк внутри строки не добавилось");
  assert.match(code, /background:var\(--color-bg\)/);
});

test("классы не переписываются там, где Tailwind не подключён", async () => {
  const root = await project({
    "index.html": '<!doctype html><html><body><div class="bg-white">x</div></body></html>',
    "styles.css": ".bg-white{background:#ffffff}\nbody{background:#f7f3ec;color:#221c15}",
  });
  const files = await scanProjectFiles(root);
  const plan = planPalette(files);
  assert.ok(plan);
  assert.equal(plan.files.some(file => file.file === "index.html"), false, "свой класс bg-white из рукописного CSS не превращается в утилиту Tailwind");
});
