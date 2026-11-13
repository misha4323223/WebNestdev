import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCustomDomainsCaddy } from "./caddy-config-writer.js";
import { renderCustomDomainsCaddy } from "./caddy-config.js";
import { buildCustomDomainRoutes } from "./caddy-routes.js";
import type { CustomDomain } from "./domain-types.js";
import type { HostingSite } from "./types.js";

function site(overrides: Partial<HostingSite> = {}): HostingSite {
  return {
    id: "site-1",
    userId: "user-1",
    projectId: "project-1",
    slug: "my-site",
    status: "live",
    activeReleaseId: "release-1",
    publishingReleaseId: null,
    nodeId: "node-1",
    lastError: "",
    suspendReason: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
    unpublishedAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

function domain(id: string, hostname: string, overrides: Partial<CustomDomain> = {}): CustomDomain {
  return {
    id,
    groupId: "group-1",
    siteId: "site-1",
    userId: "user-1",
    hostname,
    displayHostname: hostname,
    kind: hostname.startsWith("www.") ? "www" : "apex",
    status: "active",
    verificationToken: "token",
    verificationHost: "_nestdev-verify." + hostname,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    lastCheckedAt: "2026-01-01T00:00:00.000Z",
    lastError: "",
    certificateStatus: "active",
    certificateError: "",
    isCanonical: true,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("канонический домен отдаёт сайт, второй адрес — 301", () => {
  const routes = buildCustomDomainRoutes({
    sites: [site()],
    domains: [
      domain("d1", "example.ru"),
      domain("d2", "www.example.ru", { isCanonical: false }),
    ],
  });
  assert.equal(routes.length, 2);
  const config = renderCustomDomainsCaddy(routes);
  assert.match(config, /example\.ru \{/);
  assert.match(config, /root \* \/srv\/sites\/my-site\/current/);
  assert.match(config, /www\.example\.ru \{/);
  assert.match(config, /redir https:\/\/example\.ru\{uri\} permanent/);
  assert.doesNotMatch(config, /http\.request\.host/);
  assert.equal(config.match(/root \* /g)?.length, 1);
});

test("канонический www и apex-редирект", () => {
  const routes = buildCustomDomainRoutes({
    sites: [site()],
    domains: [
      domain("d1", "example.ru", { isCanonical: false }),
      domain("d2", "www.example.ru"),
    ],
  });
  const config = renderCustomDomainsCaddy(routes);
  assert.match(config, /www\.example\.ru \{/);
  assert.match(config, /root \* \/srv\/sites\/my-site\/current/);
  assert.match(config, /redir https:\/\/www\.example\.ru\{uri\} permanent/);
});

test("pending/verified и неопубликованный сайт не попадают в конфиг", () => {
  const routes = buildCustomDomainRoutes({
    sites: [site()],
    domains: [
      domain("d1", "pending.example.ru", { status: "pending_dns" }),
      domain("d2", "verified.example.ru", { status: "verified" }),
      domain("d3", "active.example.ru"),
      domain("d4", "gone.example.ru"), // сайт другой
    ].map((item, index) => index === 3 ? { ...item, siteId: "site-2" } : item),
  });
  assert.deepEqual(routes.map(route => route.hostname), ["active.example.ru"]);

  const unpublished = buildCustomDomainRoutes({
    sites: [site({ status: "unpublished" })],
    domains: [domain("d1", "example.ru")],
  });
  assert.equal(unpublished.length, 0);
});

test("если canonical ещё не готов, canonical выбирается из готовых адресов группы", () => {
  const routes = buildCustomDomainRoutes({
    sites: [site()],
    domains: [
      domain("d1", "example.ru", { status: "verified", isCanonical: true }),
      domain("d2", "www.example.ru", { status: "configuring", isCanonical: false }),
    ],
  });
  assert.deepEqual(routes, [{
    hostname: "www.example.ru",
    canonicalHostname: "www.example.ru",
    siteSlug: "my-site",
    isCanonical: true,
  }]);
});

test("некорректный slug не даёт Caddy путь к чужому каталогу", () => {
  const routes = buildCustomDomainRoutes({
    sites: [site({ slug: "../secret" })],
    domains: [domain("d1", "example.ru")],
  });
  assert.equal(routes.length, 0);
  assert.throws(
    () => renderCustomDomainsCaddy([{
      hostname: "example.ru",
      canonicalHostname: "example.ru",
      siteSlug: "../secret",
      isCanonical: true,
    }]),
    /slug/,
  );
});

test("пустой список даёт детерминированный файл без site-блоков", () => {
  const first = renderCustomDomainsCaddy([]);
  const second = renderCustomDomainsCaddy([]);
  assert.equal(first, second);
  assert.match(first, /Сгенерировано API/);
  assert.doesNotMatch(first, /example\.ru/);
});

test("писатель атомарно обновляет файл и не перезаписывает совпадающий текст", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "webnestdev-caddy-config-"));
  try {
    const first = await writeCustomDomainsCaddy("first\n", { dir });
    assert.equal(first.changed, true);
    assert.equal(await readFile(first.file, "utf8"), "first\n");
    assert.equal((await writeCustomDomainsCaddy("first\n", { dir })).changed, false);
    const second = await writeCustomDomainsCaddy("second\n", { dir });
    assert.equal(second.changed, true);
    assert.equal(await readFile(second.file, "utf8"), "second\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
