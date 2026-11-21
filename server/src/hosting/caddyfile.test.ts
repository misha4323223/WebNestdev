import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function blockDepthAt(config: string, marker: string): number {
  let depth = 0;
  for (const line of config.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "}") depth--;
    if (trimmed.startsWith(marker)) return depth;
    // Caddy site- и handler-блоки открываются строкой, которая заканчивается `{`.
    if (trimmed.endsWith("{")) depth++;
  }
  return -1;
}

test("deploy/Caddyfile подключает map режимов, strict 404 и SEO-файлы", async () => {
  const config = await readFile(fileURLToPath(new URL("../../../deploy/Caddyfile", import.meta.url)), "utf8");
  const wildcardStart = config.indexOf("*.{$HOSTING_PUBLIC_DOMAIN:");
  const wildcardEnd = config.indexOf("\n{$HOSTING_API_HOST", wildcardStart);
  const modesImport = config.indexOf("import /etc/caddy/custom/hosting-modes.map");
  assert.ok(wildcardStart >= 0, "wildcard-блок платформенных сайтов должен существовать");
  assert.ok(wildcardEnd > wildcardStart, "wildcard-блок должен закрываться до API-блока");
  assert.ok(modesImport > wildcardStart && modesImport < wildcardEnd,
    "hosting-modes.map импортируется внутри wildcard-блока: map недопустим на верхнем уровне");
  assert.doesNotMatch(config.slice(0, wildcardStart), /hosting-modes\.map/,
    "на верхнем уровне Caddyfile не должно быть import hosting-modes.map");
  assert.match(config, /hosting_mode/);
  assert.match(config, /hosting_canonical/);
  assert.match(config, /hosting_slash/);
  assert.match(config, /import \/etc\/caddy\/custom\/hosting-redirects\.map/);
  assert.match(config, /@mode_static/);
  assert.match(config, /@mode_hybrid/);
  assert.match(config, /handle_errors/);
  // handle_errors — site-level директива. Если потерять закрывающую скобку handle @site,
  // Caddy увидит её внутри handle и откажется принимать конфиг (2.11).
  assert.equal(blockDepthAt(config, "handle_errors"), 1,
    "handle_errors должен находиться на уровне site-блока, а не внутри handle @site");
  assert.match(config, /\/seo\/sitemap\.xml/);
  assert.match(config, /\/seo\/robots\.txt/);
  assert.match(config, /sitemap-\*\.xml/);
  assert.match(config, /google\*\.html/);
  assert.match(config, /X-Robots-Tag/);
});
