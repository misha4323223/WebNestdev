import test from "node:test";
import assert from "node:assert/strict";
import { isApiUpstreamPath, isPrivateAddress, parseApiUpstream } from "./api-upstream.js";

test("api upstream accepts a plain HTTPS API base", () => {
  const parsed = parseApiUpstream("https://api.example.com/api");
  assert.equal(parsed.kind, "configured");
  if (parsed.kind !== "configured") return;
  assert.equal(parsed.config.base, "https://api.example.com/api");
  assert.equal(parsed.config.basePath, "/api");
});

test("api upstream rejects unsafe or malformed targets", () => {
  for (const value of [
    "http://api.example.com/api",
    "https://localhost/api",
    "https://127.0.0.1/api",
    "https://10.0.0.5/api",
    "https://[::1]/api",
    "https://user:pass@api.example.com/api",
    "https://api.example.com/api?token=1",
    "not a url",
    "",
  ]) {
    const parsed = parseApiUpstream(value);
    assert.equal(parsed.kind, "invalid", value);
  }
});

test("api upstream path is exact and slash-delimited", () => {
  assert.equal(isApiUpstreamPath("/api/upstream"), true);
  assert.equal(isApiUpstreamPath("/api/upstream/products?limit=1"), true);
  assert.equal(isApiUpstreamPath("/api/upstream-other"), false);
  assert.equal(isApiUpstreamPath("/api/upstreamish/products"), false);
  assert.equal(isApiUpstreamPath("/api/products"), false);
});

test("private address detection covers loopback, LAN and IPv6", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2a00:1450:4001:80b::200e"), false);
});
