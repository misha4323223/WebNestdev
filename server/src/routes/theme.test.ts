import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerThemeRoutes, type ThemeRouteDeps } from "./theme.js";

async function project(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-theme-route-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

async function appFor(root: string, refreshed: string[] = []) {
  const deps: ThemeRouteDeps = {
    authorize: async () => ({ id: "user-1" }),
    getSandbox: async () => ({ root }),
    refreshPreview: async projectId => {
      refreshed.push(projectId);
      return true;
    },
  };
  const app = Fastify();
  await registerThemeRoutes(app, deps);
  await app.ready();
  return { app, refreshed };
}

const OWN_PALETTE = {
  "index.html": "<!doctype html><link rel=\"stylesheet\" href=\"styles.css\"><body><h1>Привет</h1></body>",
  "styles.css": [
    ":root{",
    "  --bg:#f7f3ec;",
    "  --ink:#221c15;",
    "}",
    "body{background:var(--bg);color:var(--ink)}",
  ].join("\n"),
};

test("GET returns the palette the project really declares", async () => {
  const { app } = await appFor(await project(OWN_PALETTE));
  const response = await app.inject({ method: "GET", url: "/api/projects/p1/theme" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.present, true);
  assert.equal(body.used, true);
  assert.deepEqual(body.tokens, { "--bg": "#f7f3ec", "--ink": "#221c15" });
  const ink = body.fields.find((field: { variable: string }) => field.variable === "--ink");
  assert.equal(ink.file, "styles.css");
  assert.equal(ink.used, true);
  assert.equal(ink.kind, "color");
});

test("GET tells the truth about a project that has no palette variables", async () => {
  const { app } = await appFor(await project({
    "index.html": "<!doctype html><style>body{background:#fff8f0;color:#241d16}</style>",
  }));
  const response = await app.inject({ method: "GET", url: "/api/projects/p1/theme" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.present, false);
  assert.equal(body.used, false);
  assert.deepEqual(body.fields, []);
});

test("PUT writes into the file where the variable is declared", async () => {
  const root = await project(OWN_PALETTE);
  const { app, refreshed } = await appFor(root);
  const response = await app.inject({
    method: "PUT",
    url: "/api/projects/p1/theme",
    payload: { tokens: { "--ink": "#101010" } },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().tokens["--ink"], "#101010");
  const css = await readFile(path.join(root, "styles.css"), "utf8");
  assert.match(css, /--ink:#101010;/);
  // Остальные объявления и правила не тронуты: панель правит только значение токена.
  assert.match(css, /--bg:#f7f3ec;/);
  assert.match(css, /body\{background:var\(--bg\);color:var\(--ink\)\}/);
  assert.deepEqual(refreshed, ["p1"]);
});

test("GET shows the project's own colours, not the unloaded theme.css defaults", async () => {
  // Ровно тот случай, на который жаловались: панель когда-то создала theme.css с палитрой по
  // умолчанию, а страница живёт на своих переменных в styles.css — панель показывала чужой цвет,
  // а правка уходила в файл, который никто не подключал.
  const root = await project({
    "theme.css": ":root{\n  --color-bg:#0b0d10;\n  --color-text:#eef0f3;\n}\n",
    ...OWN_PALETTE,
  });
  const { app } = await appFor(root);
  const body = (await app.inject({ method: "GET", url: "/api/projects/p1/theme" })).json();

  // Неподключённый theme.css в каскаде не участвует: его значения не выдаются за палитру проекта.
  assert.equal(body.tokens["--color-bg"], undefined);
  assert.equal(body.tokens["--color-text"], undefined);
  assert.equal(body.tokens["--bg"], "#f7f3ec");
  assert.equal(body.tokens["--ink"], "#221c15");
  assert.equal(body.used, true);
  assert.deepEqual(body.fields.map((field: { file: string }) => field.file), ["styles.css", "styles.css"]);

  const saved = await app.inject({ method: "PUT", url: "/api/projects/p1/theme", payload: { tokens: { "--ink": "#101010" } } });
  assert.equal(saved.statusCode, 200);
  assert.match(await readFile(path.join(root, "styles.css"), "utf8"), /--ink:#101010;/);
  assert.match(await readFile(path.join(root, "theme.css"), "utf8"), /--color-bg:#0b0d10;/);
});

test("PUT writes fonts and radii too, and groups edits by file", async () => {
  const root = await project({
    "index.html": "<link rel=\"stylesheet\" href=\"theme.css\"><link rel=\"stylesheet\" href=\"styles.css\">",
    "theme.css": ":root{\n  --color-bg:#0b0d10;\n  --font-body:ui-sans-serif, system-ui, sans-serif;\n}\n",
    "styles.css": ":root{--radius:12px}\nbody{background:var(--color-bg);font-family:var(--font-body);border-radius:var(--radius)}",
  });
  const { app, refreshed } = await appFor(root);
  const response = await app.inject({
    method: "PUT",
    url: "/api/projects/p1/theme",
    payload: { tokens: { "--color-bg": "#123456", "--font-body": "Georgia, \"Times New Roman\", serif", "--radius": "4px" } },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.tokens["--font-body"], "Georgia, \"Times New Roman\", serif");
  assert.equal(body.tokens["--radius"], "4px");
  assert.match(await readFile(path.join(root, "theme.css"), "utf8"), /--font-body:Georgia, "Times New Roman", serif;/);
  assert.match(await readFile(path.join(root, "styles.css"), "utf8"), /--radius:4px/);
  assert.deepEqual(refreshed, ["p1"]);
});

test("PUT refuses a variable the project does not declare", async () => {
  const { app } = await appFor(await project(OWN_PALETTE));
  const response = await app.inject({
    method: "PUT",
    url: "/api/projects/p1/theme",
    payload: { tokens: { "--color-text": "#ffffff" } },
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /--color-text/);
});

test("PUT refuses a value that would break out of the declaration", async () => {
  const root = await project(OWN_PALETTE);
  const { app } = await appFor(root);
  const response = await app.inject({
    method: "PUT",
    url: "/api/projects/p1/theme",
    payload: { tokens: { "--bg": "#fff;}body{display:none" } },
  });
  assert.equal(response.statusCode, 400);
  const css = await readFile(path.join(root, "styles.css"), "utf8");
  assert.match(css, /--bg:#f7f3ec;/);
});
