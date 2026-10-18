import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashAuditIp, listSecretAudit, recordSecretAudit, secretAuditFile } from "./secret-audit.js";

async function withAuditDir<T>(action: () => Promise<T>): Promise<T> {
  const previous = process.env.WEBNESTDEV_DATA_DIR;
  const root = await mkdtemp(path.join(tmpdir(), "wnd-audit-"));
  process.env.WEBNESTDEV_DATA_DIR = root;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.WEBNESTDEV_DATA_DIR;
    else process.env.WEBNESTDEV_DATA_DIR = previous;
  }
}

test("журнал хранит имена и метаданные, но не значение секрета", async () => {
  await withAuditDir(async () => {
    const result = await recordSecretAudit({
      projectId: "p1",
      userId: "u1",
      action: "write",
      names: ["STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY"],
      file: ".env.local",
      ipHash: hashAuditIp("203.0.113.5"),
    });
    assert.equal(result.ok, true);

    const raw = await readFile(secretAuditFile(), "utf8");
    assert.doesNotMatch(raw, /sk_live|secret-value/i);
    assert.match(raw, /STRIPE_SECRET_KEY/);

    const entries = await listSecretAudit("p1");
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].names, ["STRIPE_SECRET_KEY"]);
    assert.equal(entries[0].action, "write");
    assert.equal(entries[0].projectId, "p1");
    assert.equal(entries[0].userId, "u1");
    assert.equal(entries[0].ipHash.length, 32);
  });
});

test("события другого проекта не попадают в выборку, новые идут первыми", async () => {
  await withAuditDir(async () => {
    await recordSecretAudit({
      projectId: "p1", userId: "u1", action: "import", names: ["A"], file: ".env.local", ipHash: "",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordSecretAudit({
      projectId: "p1", userId: "u1", action: "delete", names: ["A"], file: ".env.local", ipHash: "",
    });
    await recordSecretAudit({
      projectId: "p2", userId: "u2", action: "write", names: ["B"], file: ".env.local", ipHash: "",
    });

    const entries = await listSecretAudit("p1");
    assert.deepEqual(entries.map((entry) => entry.action), ["delete", "import"]);
    assert.deepEqual(entries.map((entry) => entry.projectId), ["p1", "p1"]);
  });
});

test("хеш IP не равен открытому адресу и стабилен для одного адреса", () => {
  const first = hashAuditIp("203.0.113.5");
  const second = hashAuditIp("203.0.113.5");
  assert.equal(first, second);
  assert.notEqual(first, "203.0.113.5");
  assert.notEqual(first, hashAuditIp("203.0.113.6"));
  assert.equal(hashAuditIp(undefined), "");
});
