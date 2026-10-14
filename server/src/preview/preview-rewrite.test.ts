import test from "node:test";
import assert from "node:assert/strict";
import { canRewritePreviewBody, previewProxyBase, rewritePreviewBody } from "./preview-rewrite.js";

const base = previewProxyBase("p1");
const page = (body: string, type = "text/html") => rewritePreviewBody(body, base, type);

test("the proxy base carries the project id and stays root-absolute", () => {
  assert.equal(base, "/api/projects/p1/preview/open/");
  assert.equal(previewProxyBase("a b"), "/api/projects/a%20b/preview/open/");
});

test("html assets are rewritten, protocol-relative and prefixed urls are left alone", () => {
  const html = [
    '<script type="module" src="/@vite/client"></script>',
    '<link rel="stylesheet" href="/src/styles.css">',
    '<img src="//cdn.example/logo.png">',
    '<a href="'+base+'about">about</a>',
    '<img src="./local.png">',
  ].join("\n");
  const rewritten = page(html);
  assert.ok(rewritten.includes('src="' + base + '@vite/client"'));
  assert.ok(rewritten.includes('href="' + base + 'src/styles.css"'));
  assert.ok(rewritten.includes('src="//cdn.example/logo.png"'));
  assert.ok(rewritten.includes('href="' + base + 'about"'));
  assert.ok(rewritten.includes('src="./local.png"'));
});

test("javascript module specifiers are rewritten while routing paths stay untouched", () => {
  const code = [
    'import { createRoot } from "/node_modules/.vite/deps/react-dom_client.js";',
    'import "/src/index.css";',
    'const page = await import("/src/pages/Dashboard.tsx");',
    'export { thing } from "/src/thing.ts";',
    'const router = [{ path: "/about", component: About }];',
    'fetch("/api/items");',
  ].join("\n");
  const rewritten = page(code, "application/javascript");
  assert.ok(rewritten.includes('from "' + base + 'node_modules/.vite/deps/react-dom_client.js"'));
  assert.ok(rewritten.includes('import "' + base + 'src/index.css"'));
  assert.ok(rewritten.includes('import("' + base + 'src/pages/Dashboard.tsx")'));
  assert.ok(rewritten.includes('from "' + base + 'src/thing.ts"'));
  assert.ok(rewritten.includes('path: "/about"'));
  assert.ok(rewritten.includes('fetch("/api/items")'));
});

test("css url() and @import are rewritten", () => {
  const css = '@import "/src/base.css";\nbody{background:url("/img/bg.png") no-repeat}\n.icon{background:url(//cdn/x.svg)}';
  const rewritten = page(css, "text/css");
  assert.ok(rewritten.includes('@import "' + base + 'src/base.css"'));
  assert.ok(rewritten.includes('url("' + base + 'img/bg.png")'));
  assert.ok(rewritten.includes("url(//cdn/x.svg)"));
});

test("the rewrite is idempotent and leaves binary and unknown types alone", () => {
  const once = page('<script src="/x.js"></script>');
  assert.equal(page(once), once);
  assert.equal(canRewritePreviewBody("image/png"), false);
  assert.equal(canRewritePreviewBody("text/html; charset=utf-8"), true);
  assert.equal(rewritePreviewBody('<script src="/x.js"></script>', base, "image/png"), '<script src="/x.js"></script>');
});
