import test from "node:test";
import assert from "node:assert/strict";
import { ownerTarget, projectIdFromUrl } from "./owner-router.js";

test("project id is extracted only from project-scoped API paths", () => {
  assert.equal(projectIdFromUrl("/api/projects/p1/files?path=a"), "p1");
  assert.equal(projectIdFromUrl("/api/projects/p1"), "p1");
  assert.equal(projectIdFromUrl("/api/projects"), null);
  assert.equal(projectIdFromUrl("/api/projects/"), null);
  assert.equal(projectIdFromUrl("/api/project/p1"), null);
  assert.equal(projectIdFromUrl("/api/projects/p%201/file"), "p 1");
  assert.equal(projectIdFromUrl("/api/projects/%E0%A4%A/file"), null);
});

test("owner address accepts host:port and URL, but not paths or credentials", () => {
  assert.deepEqual(ownerTarget("10.0.0.4:8791"), {
    protocol: "http:",
    hostname: "10.0.0.4",
    port: 8791,
  });
  assert.deepEqual(ownerTarget("http://10.0.0.4:8791"), {
    protocol: "http:",
    hostname: "10.0.0.4",
    port: 8791,
  });
  assert.deepEqual(ownerTarget("https://node-1.internal"), {
    protocol: "https:",
    hostname: "node-1.internal",
    port: 8791,
  });
  assert.equal(ownerTarget("http://10.0.0.4:8791/admin"), null);
  assert.equal(ownerTarget("http://user:pass@10.0.0.4:8791"), null);
  assert.equal(ownerTarget(""), null);
});
