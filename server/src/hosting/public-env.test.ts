import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "webnestdev-public-env-"));
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(root, "sandboxes");
process.env.WEBNESTDEV_STORAGE = "json";

const { publicEnvMounts } = await import("./public-env.js");

test("в публичную сборку попадают только публичные env, а заглушка не остаётся в проекте", async () => {
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, ".env.local"), [
    "VITE_API_URL=https://api.example.test",
    "VITE_SECRET_KEY=must-not-leak",
    "DATABASE_URL=postgres://private",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });

  const result = await publicEnvMounts({
    projectId: "public-env-test",
    root: projectRoot,
    memoryMb: 128,
    cpuLimit: 1,
    timeoutMs: 1_000,
  });
  assert.deepEqual(result.names, ["VITE_API_URL"]);
  assert.equal(result.mounts.length, 2);
  assert.match(result.mounts[1] ?? "", /:\/workspace\/\.env\.local:ro$/);

  // `loadProjectSecretFiles` переносит секреты в шифрованное хранилище и удаляет исходник.
  // Публичный mount читает значения из хранилища; секрет с приватным словом в имени — нет.
  const target = path.join(projectRoot, ".env.local");
  assert.equal((await lstat(target).catch(() => null))?.isFile(), true);
  assert.match(await readFile(result.mounts[1]!.split(":")[0]!, "utf8"), /VITE_API_URL=https:\/\/api\.example\.test/);
  await result.cleanup();
  assert.equal(await lstat(target).catch(() => null), null);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});
