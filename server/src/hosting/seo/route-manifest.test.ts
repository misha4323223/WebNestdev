import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRouteManifest,
  parseRouteManifest,
  resolveRoutingMode,
  sitemapRoutes,
} from "./route-manifest.js";

test("route manifest берёт только реальные HTML-файлы и нормализует index", () => {
  const manifest = buildRouteManifest([
    { path: "index.html" },
    { path: "about/index.html" },
    { path: "blog/post.html" },
    { path: "404.html" },
    { path: "assets/app.js" },
    { path: ".hidden/index.html" },
    { path: "api/index.html" },
  ]);
  assert.deepEqual(manifest.routes, [
    { path: "/", file: "index.html" },
    { path: "/about/", file: "about/index.html" },
    { path: "/api/", file: "api/index.html" },
    { path: "/blog/post.html", file: "blog/post.html" },
  ]);
  assert.equal(manifest.has404, true);
  assert.equal(manifest.htmlFiles, 5);
  assert.deepEqual(sitemapRoutes(manifest).map(route => route.path), ["/", "/about/", "/blog/post.html"]);
});

test("auto не ломает одностарничный SPA, но выбирает static для многостраничной сборки", () => {
  const onePage = buildRouteManifest([{ path: "index.html" }]);
  assert.equal(resolveRoutingMode({ requested: undefined, kind: "static-build", manifest: onePage }), "spa");
  assert.equal(resolveRoutingMode({ requested: "auto", kind: "instant-site", manifest: onePage }), "static");
  assert.equal(resolveRoutingMode({ requested: "spa", kind: "instant-site", manifest: onePage }), "spa");

  const manyPages = buildRouteManifest([{ path: "index.html" }, { path: "about/index.html" }]);
  assert.equal(resolveRoutingMode({ requested: "auto", kind: "static-build", manifest: manyPages }), "static");

  const with404 = buildRouteManifest([{ path: "index.html" }, { path: "404.html" }]);
  assert.equal(resolveRoutingMode({ requested: "auto", kind: "static-build", manifest: with404 }), "static");
});

test("сохранённый manifest читается безопасно и не принимает мусор", () => {
  const parsed = parseRouteManifest(JSON.stringify({
    version: 1,
    routes: [
      { path: "/", file: "index.html" },
      { path: "/bad", file: "../secret.html" },
      { path: "no-slash", file: "index.html" },
      { path: "/", file: "other.html" },
    ],
    has404: true,
    htmlFiles: 2,
  }));
  assert.deepEqual(parsed?.routes, [{ path: "/", file: "index.html" }]);
  assert.equal(parsed?.has404, true);
  assert.equal(parseRouteManifest("not-json"), null);
});
