/**
 * Fixture repositories for the `landing` eval tasks.
 *
 * Each fixture is a small but real project: it declares `npm run build`, the build checks that the
 * files the page references actually exist, and the eval runs that command in the sandbox exactly
 * as a user's project would. The check that decides pass/fail for a landing task lives outside the
 * fixture (`live/checks.ts`) so the agent cannot read the grader while it works.
 */
import type { EvalFixture } from "./types.js";

const SHARED_STYLES = `:root{--bg:#fff;--ink:#14181f;--muted:#5b6472;--accent:#2f6bff}
*{box-sizing:border-box}
body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
.top{display:flex;align-items:center;gap:24px;padding:18px 28px;border-bottom:1px solid #e8ecf3}
.logo{font-weight:700;color:var(--ink);text-decoration:none}
.nav{display:flex;gap:20px;width:520px}
.nav a{color:var(--muted);text-decoration:none}
main{max-width:1040px;margin:0 auto;padding:0 24px}
.hero{padding:64px 0 32px}
.hero h1{font-size:40px;line-height:1.15;margin:0 0 12px}
.cta{margin-top:20px;padding:12px 22px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px;cursor:pointer}
section{padding:32px 0;border-top:1px solid #eef1f6}
`;

const BUILD_SCRIPT = `import { readFile, mkdir, copyFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const pages = (await readdir(root)).filter(name => name.endsWith(".html"));
if (!pages.length) throw new Error("в проекте нет ни одной HTML-страницы");
const assets = new Set();
for (const page of pages) {
  const html = await readFile(path.join(root, page), "utf8");
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const ref = match[1];
    if (!ref || ref.startsWith("#") || ref.startsWith("/") || /^https?:/.test(ref) || ref.startsWith("//")) continue;
    assets.add(ref.split("?")[0]);
  }
}
const missing = [];
for (const asset of assets) {
  try { await readFile(path.join(root, asset)); }
  catch { missing.push(asset); }
}
if (missing.length) throw new Error("страницы ссылаются на отсутствующие файлы: " + missing.join(", "));
await mkdir(path.join(root, "dist"), { recursive: true });
for (const page of pages) await copyFile(path.join(root, page), path.join(root, "dist", page));
await copyFile(path.join(root, "styles.css"), path.join(root, "dist", "styles.css"));
if (assets.has("app.js")) await copyFile(path.join(root, "app.js"), path.join(root, "dist", "app.js"));
console.log("build: " + pages.length + " страниц(ы), ссылок " + assets.size);
`;

const PACKAGE = (name: string) => JSON.stringify({
  name,
  private: true,
  version: "0.1.0",
  type: "module",
  scripts: { build: "node scripts/build.mjs" },
}, null, 2) + "\n";

const LANDING_BASIC_INDEX = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Студия «Верста» — сайты для малого бизнеса</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="top">
    <a class="logo" href="/">Верста</a>
    <nav class="nav">
      <a href="#services">Услуги</a>
      <a href="#pricing">Тарифы</a>
      <a href="#contacts">Контакты</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>Сайт, который приводит клиентов</h1>
      <p>Лендинги и небольшие каталоги под ключ: от идеи до публикации.</p>
      <button class="cta" id="lead">Оставить заявку</button>
    </section>
    <section id="services">
      <h2>Услуги</h2>
      <ul>
        <li>Лендинг за две недели</li>
        <li>Каталог с оплатой</li>
        <li>Поддержка и правки</li>
      </ul>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

const LANDING_MULTI_INDEX = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Верста — студия веб-разработки</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>Делаем сайты, которые работают</h1>
    <p>Проектируем, собираем и поддерживаем сайты для небольших команд.</p>
    <p><a href="services.html">Услуги и цены</a></p>
  </main>
</body>
</html>
`;

const LANDING_MULTI_SERVICES = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Услуги — Верста</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>Услуги</h1>
    <ul>
      <li>Лендинг — от 120 000 ₽</li>
      <li>Каталог — от 240 000 ₽</li>
      <li>Поддержка — 20 000 ₽ в месяц</li>
    </ul>
    <p><a href="/">На главную</a></p>
  </main>
</body>
</html>
`;

const LANDING_BUG_INDEX = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Мастерская «Полка» — мебель на заказ</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <section class="hero">
      <h1>Мебель по вашим размерам</h1>
      <p>Считаем стоимость за один день.</p>
      <button class="cta" id="lead">Оставить заявку</button>
    </section>
    <section id="services">
      <h2>Что делаем</h2>
      <p>Кухни, шкафы, столы.</p>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

const LANDING_BUG_APP = `// Кнопка заявки: по клику открывается форма и отправляется запрос.
const form = document.getElementById("cta");
form.addEventListener("click", async () => {
  const response = await fetch("/api/lead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "hero" }),
  });
  if (!response.ok) console.error("Не удалось отправить заявку");
});
`;

const LANDING_ASSETS_INDEX = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Портфолио — работы мастерской</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>Наши работы</h1>
    <section id="works">
      <figure><img src="assets/kitchen.jpg" alt=""><figcaption>Кухня из дуба</figcaption></figure>
      <figure><img src="assets/wardrobe.jpg" alt=""><figcaption>Шкаф в спальню</figcaption></figure>
      <figure><img src="assets/table.jpg" alt=""><figcaption>Обеденный стол</figcaption></figure>
    </section>
  </main>
</body>
</html>
`;

export const LANDING_FIXTURES: Record<string, EvalFixture> = {
  // Маленький лендинг: есть первый экран и услуги, нет контактов и тарифов — их просят задачи.
  "landing-basic": {
    files: {
      "package.json": PACKAGE("eval-landing-basic"),
      "index.html": LANDING_BASIC_INDEX,
      "styles.css": SHARED_STYLES,
      "app.js": `document.getElementById("lead").addEventListener("click", () => {\n  console.log("Заявка");\n});\n`,
      "scripts/build.mjs": BUILD_SCRIPT,
    },
  },
  // Две страницы с неполными метаданными: задача про SEO.
  "landing-multi-page": {
    files: {
      "package.json": PACKAGE("eval-landing-multi-page"),
      "index.html": LANDING_MULTI_INDEX,
      "services.html": LANDING_MULTI_SERVICES,
      "styles.css": SHARED_STYLES,
      "scripts/build.mjs": BUILD_SCRIPT,
    },
  },
  // Кнопка на первом экране не работает: обработчик ищет элемент, которого нет.
  "landing-bug": {
    files: {
      "package.json": PACKAGE("eval-landing-bug"),
      "index.html": LANDING_BUG_INDEX,
      "styles.css": SHARED_STYLES,
      "app.js": LANDING_BUG_APP,
      "scripts/build.mjs": BUILD_SCRIPT,
    },
  },
  // Изображения ссылаются на отсутствующие файлы, alt пустой.
  "landing-assets": {
    files: {
      "package.json": PACKAGE("eval-landing-assets"),
      "index.html": LANDING_ASSETS_INDEX,
      "styles.css": SHARED_STYLES,
      "scripts/build.mjs": BUILD_SCRIPT,
    },
  },
};
