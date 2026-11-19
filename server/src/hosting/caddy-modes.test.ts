import test from "node:test";
import assert from "node:assert/strict";
import { buildHostingModeRoutes, renderHostingModesCaddy } from "./caddy-modes.js";
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
    routingMode: "auto",
    effectiveRoutingMode: "static",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T00:00:00.000Z",
    unpublishedAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

function domain(overrides: Partial<CustomDomain> = {}): CustomDomain {
  return {
    id: "domain-1",
    groupId: "group-1",
    siteId: "site-1",
    userId: "user-1",
    hostname: "example.ru",
    displayHostname: "example.ru",
    kind: "apex",
    status: "active",
    verificationToken: "token",
    verificationHost: "_nestdev-verify.example.ru",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    lastCheckedAt: "2026-01-01T00:00:00.000Z",
    lastError: "",
    certificateStatus: "active",
    certificateError: "",
    certificateStartedAt: null,
    isCanonical: true,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("map отдаёт режим и canonical только для live-сайта с активным доменом", () => {
  const routes = buildHostingModeRoutes({
    sites: [site(), site({ id: "site-2", slug: "second", effectiveRoutingMode: "spa" })],
    domains: [
      domain(),
      domain({ id: "d2", hostname: "www.example.ru", isCanonical: false }),
      domain({ id: "d3", siteId: "site-2", hostname: "second.example.ru", status: "verified", isCanonical: true }),
    ],
    publicDomain: "host.nestdev.ru",
  });
  assert.deepEqual(routes, [
    { hostname: "my-site.host.nestdev.ru", mode: "static", canonicalHostname: "example.ru", trailingSlash: "always" },
    { hostname: "second.host.nestdev.ru", mode: "spa", canonicalHostname: "", trailingSlash: "ignore" },
  ]);
});

test("map имеет безопасный default spa для старых записей", () => {
  const content = renderHostingModesCaddy(buildHostingModeRoutes({
    sites: [site({ effectiveRoutingMode: undefined })],
    domains: [],
    publicDomain: "host.nestdev.ru",
  }));
  assert.match(content, /default "spa" "" "ignore"/);
  assert.match(content, /"my-site\.host\.nestdev\.ru" "spa" "" "ignore"/);
});

test("map не принимает некорректный hostname и slug", () => {
  const routes = buildHostingModeRoutes({
    sites: [site({ slug: "../secret" }), site({ id: "site-2", status: "draft" })],
    domains: [],
    publicDomain: "host.nestdev.ru",
  });
  assert.equal(routes.length, 0);
  const content = renderHostingModesCaddy(routes);
  assert.doesNotMatch(content, /secret/);
  assert.match(content, /default "spa" "" "ignore"/);
});
