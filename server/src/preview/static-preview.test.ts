import test from "node:test";
import assert from "node:assert/strict";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { previewLogs,previewStatus,startPreview,stopPreview } from "../preview-manager.js";
import { registerPreviewRoutes } from "../routes/preview.js";
import type { SandboxConfig } from "../sandbox-manager.js";
import { execFetchPreview } from "./exec-proxy.js";
import { getPreview,removePreview,touchPreview } from "./preview-store.js";
import { previewModeSetting,refreshStaticPreview,startStaticPreview,staticPreviewLogs,stopAllStaticPreviews,stopStaticPreview } from "./static-preview.js";
import { previewHostTarget, previewPublicUrl } from "./preview-host.js";
import { mintPreviewTicket, previewTicketTtlMs } from "./preview-ticket.js";

const PROJECT_ID = "static-preview-test";
const ENV_KEYS = ["PREVIEW_MODE", "PREVIEW_STATIC_DIR", "PREVIEW_STATIC_BUILD"];

/**
 * The build is a sandbox command, so the tests never let it run: `never` serves an output that
 * is already there, which is exactly the state after the agent's verification built the project.
 */
function env(values: Record<string, string | undefined>) {
  const previous = ENV_KEYS.map(key => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function builtProject() {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-static-preview-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "dist/index.html": '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="app">WebNestDev static build</div></body></html>',
    "dist/assets/app.js": 'console.log("asset served");',
  };
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

function config(root: string): SandboxConfig {
  return { projectId: PROJECT_ID, root, memoryMb: 512, cpuLimit: 0.5, timeoutMs: 5000 };
}

async function cleanup(root: string) {
  await stopAllStaticPreviews();
  removePreview(PROJECT_ID);
  await rm(root, { recursive: true, force: true });
}

test("a static preview serves the build, its assets and client-side routes", async () => {
  const root = await builtProject();
  const restore = env({ PREVIEW_MODE: "auto", PREVIEW_STATIC_BUILD: "never", PREVIEW_STATIC_DIR: undefined });
  try {
    const started = await startStaticPreview(config(root));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const status = started.status;
    assert.equal(status.running, true);
    if (!status.running) return;
    assert.equal(status.mode, "static");
    assert.equal(status.ready, true);
    assert.ok(status.port > 0, "порт слушателя должен быть известен");
    assert.equal(getPreview(PROJECT_ID)?.mode, "static");

    const base = "http://127.0.0.1:" + status.port;
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(String(page.headers.get("content-type")), /text\/html/);
    assert.match(await page.text(), /WebNestDev static build/);

    const asset = await fetch(base + "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers.get("content-type")), /javascript/);

    // A client-side route has no file of its own: the app's index.html is returned.
    const route = await fetch(base + "/settings/profile");
    assert.equal(route.status, 200);
    assert.match(await route.text(), /WebNestDev static build/);

    // A missing asset stays a 404 instead of silently becoming HTML.
    assert.equal((await fetch(base + "/assets/missing.js")).status, 404);

    // A server path is not a client route: answering it with index.html made an app that expects
    // JSON render a blank screen (its session check got HTML), and the failure looked like the
    // app's own bug. The static preview has no API, and now it says so with a 404.
    const api = await fetch(base + "/api/account/settings");
    assert.equal(api.status, 404);
    assert.match(String(api.headers.get("content-type")), /application\/json/);
    assert.ok(!(await api.text()).includes("WebNestDev static build"), "на /api не должен отдаваться index.html");
    // ...and nothing outside the build output is reachable.
    const traversal = await fetch(base + "/..%2f..%2fpackage.json");
    assert.ok(traversal.status >= 400, "выход за пределы каталога сборки запрещён: " + traversal.status);

    assert.match(staticPreviewLogs(PROJECT_ID), /Статический предпросмотр/);

    await stopStaticPreview(PROJECT_ID);
    await assert.rejects(fetch(base + "/"), "после остановки порт должен быть свободен");
  } finally {
    restore();
    await cleanup(root);
  }
});

test("the workspace proxy serves the static preview through the project's own URL", async () => {
  const root = await builtProject();
  const restore = env({ PREVIEW_MODE: "auto", PREVIEW_STATIC_BUILD: "never", PREVIEW_STATIC_DIR: undefined });
  const app = Fastify();
  try {
    assert.equal((await startStaticPreview(config(root))).ok, true);
    // The real routes with the real preview functions: this is the iframe's URL, not the port.
    await registerPreviewRoutes(app, {
      authorize: async () => ({ id: "test-user" }),
      getSandbox: async () => config(root),
      // Настоящая вторая дверь к приложению: у статического предпросмотра её не спрашивают,
      // но набор соучастников — тот же, что в index.ts.
      execPreview: execFetchPreview,
      startPreview,
      stopPreview,
      previewStatus,
      previewLogs,
      touchPreview,
      // Публичные адреса предпросмотра в этом тесте выключены: набор соучастников тот же, что в index.ts,
      // а сами ответы проверяются в preview-host-server.test.ts и routes/preview.test.ts.
      publicUrl: previewPublicUrl,
      mintTicket: mintPreviewTicket,
      ticketTtlMs: previewTicketTtlMs,
      hostTarget: host => previewHostTarget(host)?.projectId ?? null,
      projectExists: async projectId => projectId === PROJECT_ID,
    });
    await app.ready();
    const status = await app.inject({ method: "GET", url: "/api/projects/" + PROJECT_ID + "/preview/status" });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().running, true);
    assert.equal(status.json().mode, "static");

    const page = await app.inject({ method: "GET", url: "/api/projects/" + PROJECT_ID + "/preview/open/" });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.body, /WebNestDev static build/);
    // A root-absolute asset URL is rewritten onto the proxy prefix, exactly as for a dev server.
    assert.ok(page.body.includes('src="/api/projects/' + PROJECT_ID + '/preview/open/assets/app.js"'), page.body);

    const logs = await app.inject({ method: "GET", url: "/api/projects/" + PROJECT_ID + "/preview/logs" });
    assert.equal(logs.statusCode, 200);
    assert.match(logs.json().logs, /Статический предпросмотр/);
  } finally {
    await app.close();
    restore();
    await cleanup(root);
  }
});

test("a second start serves the same build instead of rebuilding it", async () => {
  const root = await builtProject();
  const restore = env({ PREVIEW_MODE: "auto", PREVIEW_STATIC_BUILD: "never", PREVIEW_STATIC_DIR: undefined });
  try {
    const first = await startStaticPreview(config(root));
    const second = await startStaticPreview(config(root));
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.status.running && second.status.running, true);
    if (!first.status.running || !second.status.running) return;
    assert.equal(second.status.port, first.status.port);
  } finally {
    restore();
    await cleanup(root);
  }
});

test("a project without a build script reports why it cannot be served statically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-static-nobuild-"));
  const restore = env({ PREVIEW_MODE: "auto", PREVIEW_STATIC_BUILD: "never", PREVIEW_STATIC_DIR: undefined });
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const started = await startStaticPreview(config(root));
    assert.equal(started.ok, false);
    if (started.ok) return;
    // The reason now comes from the project detector, which describes the whole project rather
    // than one missing field: "нет скрипта сборки" says what to add, "нет package.json" did not.
    assert.match(started.reason, /без скрипта сборки/);
    assert.match(started.reason, /песочниц/, "причина объясняет, что проект проверим в песочнице");
  } finally {
    restore();
    await cleanup(root);
  }
});

test("a plain HTML project is served instantly, without a build and without a container", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-instant-site-"));
  const restore = env({ PREVIEW_MODE: "auto", PREVIEW_STATIC_BUILD: undefined, PREVIEW_STATIC_DIR: undefined });
  try {
    await writeFile(path.join(root, "index.html"), "<!doctype html><html><body>готовая статика</body></html>");
    const started = await startStaticPreview(config(root));
    assert.equal(started.ok, true, "готовая статика должна отдаваться с первого раза, без сборки");
    if (!started.ok) return;
    const status = started.status;
    assert.equal(status.running, true);
    if (!status.running) return;
    assert.equal(status.mode, "static");
    assert.equal(status.ready, true);
    assert.match(staticPreviewLogs(PROJECT_ID), /сборка не нужна/);
    // The served file is read from disk on every request, so an edit is visible without a rebuild.
    await writeFile(path.join(root, "index.html"), "<!doctype html><html><body>правка видна сразу</body></html>");
    const page = await fetch("http://127.0.0.1:" + status.port + "/");
    assert.match(await page.text(), /правка видна сразу/);
  } finally {
    restore();
    await cleanup(root);
  }
});

test("PREVIEW_STATIC_BUILD=never refuses instead of building a missing output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-static-unbuilt-"));
  const restore = env({ PREVIEW_MODE: "auto", PREVIEW_STATIC_BUILD: "never", PREVIEW_STATIC_DIR: undefined });
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    const started = await startStaticPreview(config(root));
    assert.equal(started.ok, false);
    if (started.ok) return;
    assert.match(started.reason, /index\.html/);
  } finally {
    restore();
    await cleanup(root);
  }
});

test("a theme edit does not restart a preview that is served from disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-instant-theme-"));
  const restore = env({ PREVIEW_MODE: "auto", PREVIEW_STATIC_BUILD: undefined, PREVIEW_STATIC_DIR: undefined });
  try {
    await writeFile(path.join(root, "index.html"), "<!doctype html><html><body>старая палитра</body></html>");
    const started = await startStaticPreview(config(root));
    assert.equal(started.ok, true);
    if (!started.ok || !started.status.running) return;
    // Правка — это то, что делает панель «Тема»: файл пишется, панель перезагружает кадр.
    await writeFile(path.join(root, "index.html"), "<!doctype html><html><body>новая палитра</body></html>");
    // Готовая статика читается с диска, поэтому пересборка не нужна и порт не меняется.
    assert.equal(await refreshStaticPreview(PROJECT_ID), false);
    const page = await fetch("http://127.0.0.1:" + started.status.port + "/");
    assert.match(await page.text(), /новая палитра/);
    // Предпросмотра нет — пересобирать нечего, и это не ошибка.
    await stopStaticPreview(PROJECT_ID);
    assert.equal(await refreshStaticPreview(PROJECT_ID), false);
    assert.equal(await refreshStaticPreview("no-such-project"), false);
  } finally {
    restore();
    await cleanup(root);
  }
});

test("PREVIEW_MODE reads container, static, and anything else as auto", () => {
  const restore = env({ PREVIEW_MODE: undefined });
  try {
    assert.equal(previewModeSetting(), "auto");
    process.env.PREVIEW_MODE = "container";
    assert.equal(previewModeSetting(), "container");
    process.env.PREVIEW_MODE = "STATIC";
    assert.equal(previewModeSetting(), "static");
    process.env.PREVIEW_MODE = "nonsense";
    assert.equal(previewModeSetting(), "auto");
  } finally {
    restore();
  }
});
