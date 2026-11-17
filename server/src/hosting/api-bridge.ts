import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Совместимость сайтов с отдельным API-хостом.
 *
 * CDN MWS не пропускает POST, поэтому формы уходят на `api.<домен>/<slug>/api/...`.
 * Пользовательские статические сайты исторически вызывают относительный `/api`, и менять
 * каждый проект при публикации нельзя. Мост — маленький same-origin скрипт в релизе: он
 * переписывает только запросы к `/api` на API-хост, не трогая остальные URL. Так старый
 * `fetch("/api/orders")` продолжает работать без правок кода сайта.
 *
 * Это именно мост совместимости, а не замена API-base в шаблоне: новые сайты могут читать
 * `window.__WEBNESTDEV_API_BASE__` напрямую. CSP сайта должен разрешать `connect-src`
 * на API-хост; иначе браузер заблокирует запрос до того, как мост что-то сделает.
 */

export const API_BRIDGE_DIR = "_webnestdev";
export const API_BRIDGE_PATH = "/_webnestdev/api-bridge.js";
const TAG_RE = /<script\b[^>]*src=["']\/_webnestdev\/api-bridge\.js["'][^>]*>\s*<\/script>/i;

export function apiBridgeSource(apiBase: string) {
  return `/* Webnestdev API bridge: POST goes to the direct API host, not the CDN. */
(function () {
  "use strict";
  var base = ${JSON.stringify(apiBase)};
  try { window.__WEBNESTDEV_API_BASE__ = base; } catch (error) {}
  try {
    if (location.hostname === new URL(base).hostname) return;
  } catch (error) { return; }

  function rewrite(value) {
    if (typeof value !== "string") return value;
    if (value === "/api" || value.indexOf("/api/") === 0) return base + value;
    try {
      var url = new URL(value, location.href);
      if (url.origin === location.origin && (url.pathname === "/api" || url.pathname.indexOf("/api/") === 0)) {
        return base + url.pathname + url.search + url.hash;
      }
    } catch (error) {}
    return value;
  }

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      if (typeof input === "string" || input instanceof URL) {
        input = rewrite(String(input));
      } else if (input && typeof input === "object" && typeof input.url === "string") {
        var next = rewrite(input.url);
        if (next !== input.url) input = new Request(next, input);
      }
      return nativeFetch.call(this, input, init);
    };
  }

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof url === "string") args[1] = rewrite(url);
    return nativeOpen.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return nativeBeacon(rewrite(url), data);
    };
  }
})();`;
}

async function htmlFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 16) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === API_BRIDGE_DIR || entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await htmlFiles(full, depth + 1));
    } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function injectTag(html: string) {
  if (TAG_RE.test(html)) return html;
  const tag = '<script src="' + API_BRIDGE_PATH + '"></script>';
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + "\n" + tag + html.slice(at);
  }
  const bodyClose = html.search(/<\/body\s*>/i);
  if (bodyClose >= 0) return html.slice(0, bodyClose) + tag + "\n" + html.slice(bodyClose);
  return html;
}

/**
 * Ставит мост в уже проверенную staging-копию релиза, а не в дерево проекта: публикация
 * не должна менять исходники пользователя. Вызывающий код после этого заново считает
 * манифест, потому что размер и sha256 index.html изменились.
 */
export async function installApiBridge(dir: string, apiBase: string) {
  const root = await lstat(dir).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return false;
  const bridgeDir = path.join(dir, API_BRIDGE_DIR);
  await mkdir(bridgeDir, { recursive: true, mode: 0o755 });
  await writeFile(path.join(bridgeDir, "api-bridge.js"), apiBridgeSource(apiBase), {
    encoding: "utf8",
    mode: 0o644,
  });
  let changed = false;
  for (const file of await htmlFiles(dir)) {
    const html = await readFile(file, "utf8");
    const next = injectTag(html);
    if (next !== html) {
      await writeFile(file, next, { encoding: "utf8" });
      changed = true;
    }
  }
  return changed;
}
