import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("deploy/Caddyfile подключает map режимов, strict 404 и SEO-файлы", async () => {
  const config = await readFile(fileURLToPath(new URL("../../../deploy/Caddyfile", import.meta.url)), "utf8");
  assert.match(config, /import \/etc\/caddy\/custom\/hosting-modes\.map/);
  assert.match(config, /hosting_mode/);
  assert.match(config, /hosting_canonical/);
  assert.match(config, /hosting_slash/);
  assert.match(config, /import \/etc\/caddy\/custom\/hosting-redirects\.map/);
  assert.match(config, /@mode_static/);
  assert.match(config, /@mode_hybrid/);
  assert.match(config, /handle_errors/);
  assert.match(config, /\/seo\/sitemap\.xml/);
  assert.match(config, /\/seo\/robots\.txt/);
  assert.match(config, /sitemap-\*\.xml/);
  assert.match(config, /google\*\.html/);
  assert.match(config, /X-Robots-Tag/);
});
