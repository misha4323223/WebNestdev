import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Хранилище — файловый режим и временный каталог: модуль читает окружение при импорте,
// поэтому переменные ставятся до динамического импорта.
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "nestdev-domains-"));

const { getDomainConnection, listDomainConnections, saveDomainConnection } = await import("./connections.js");

const now = "2026-10-22T00:00:00.000Z";

test("a registrar connection stores the allow-changes decision", async () => {
  await saveDomainConnection({
    userId: "user-1",
    provider: "regru",
    secret: JSON.stringify({ username: "u", password: "p" }),
    account: "u",
    allowWrites: false,
    createdAt: now,
    updatedAt: now,
  });
  const connection = await getDomainConnection("user-1", "regru");
  assert.equal(connection?.allowWrites, false);
  // Пароль возвращается только расшифрованным — это проверяет сам стор, наружу он не идёт.
  assert.match(connection?.secret ?? "", /"username":"u"/);
});

test("turning changes back on is the only field that changes", async () => {
  const before = await getDomainConnection("user-1", "regru");
  assert.ok(before);
  await saveDomainConnection({ ...before, allowWrites: true, updatedAt: "2026-10-22T01:00:00.000Z" });
  const after = await getDomainConnection("user-1", "regru");
  assert.equal(after?.allowWrites, true);
  assert.equal(after?.createdAt, now);
  assert.equal(after?.updatedAt, "2026-10-22T01:00:00.000Z");
});

test("a cabinet connected before the switch reads as changes allowed", async () => {
  // Так выглядит файл, записанный прошлой версией: поля allowWrites в нём нет.
  const dir = path.join(process.env.WEBNESTDEV_DATA_DIR as string, "domains");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "user-2.json"), JSON.stringify({
    beget: { secret: JSON.stringify({ login: "l", passwd: "p" }), account: "l", createdAt: now, updatedAt: now },
  }));
  const connections = await listDomainConnections("user-2");
  assert.equal(connections.length, 1);
  assert.equal(connections[0].allowWrites, true);
  await readFile(path.join(dir, "user-2.json"), "utf8");
});
