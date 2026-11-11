/**
 * Команда для резервной копии PostgreSQL: загрузка дампа, манифест, проверка свежести и
 * выдача дампа для восстановления.
 *
 * Запускается внутри контейнера сервера (там есть S3-клиент и ключи хранилища), а `pg_dump`
 * и `pg_restore` выполняет контейнер `postgres:17` — см. `deploy/scripts/pg-backup.sh`.
 *
 * Примеры:
 *   node server/dist/scripts/postgres-backup.js put --database webnestdev < dump
 *   node server/dist/scripts/postgres-backup.js check --database webnestdev --max-age-hours 36
 *   node server/dist/scripts/postgres-backup.js manifest --database webnestdev
 *   node server/dist/scripts/postgres-backup.js get --key <key> --sha256 <hash> > dump
 *
 * stdout — только машиночитаемый результат (JSON или байты дампа); всё человеческое идёт в
 * stderr, поэтому оболочка может безопасно перехватывать вывод.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { objectStoreConfigFromEnv, s3ObjectStore } from "../storage/object-store.js";
import { checkBackup, putBackup, readBackup, readManifest } from "../storage/postgres-backup.js";

const USAGE = [
  "postgres-backup config",
  "postgres-backup put --database <имя>",
  "postgres-backup manifest --database <имя>",
  "postgres-backup check --database <имя> [--max-age-hours 30]",
  "postgres-backup get --key <ключ> --sha256 <сумма>",
  "postgres-backup put-object --key <ключ>   (stdin → S3)",
  "postgres-backup get-object --key <ключ>   (S3 → stdout)",
  "postgres-backup head-object --key <ключ>",
].join("\n");

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string) {
  const value = flag(name);
  if (!value) throw new Error("нужен " + name);
  return value;
}

function database() {
  const value = required("--database");
  if (!/^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/.test(value)) throw new Error("некорректное имя базы: " + value);
  return value;
}

function store() {
  const config = objectStoreConfigFromEnv();
  if (!config) {
    throw new Error(
      "объектное хранилище не настроено: задайте PLATFORM_S3_ENDPOINT, PLATFORM_S3_BUCKET, " +
      "PLATFORM_S3_ACCESS_KEY_ID и PLATFORM_S3_SECRET_ACCESS_KEY",
    );
  }
  return s3ObjectStore(config);
}

/**
 * Ключи PITR: только под нашим префиксом и без выхода из каталога.
 *
 * Отдельная проверка нужна потому, что эти команды вызываются из shell-скрипта выкатки и
 * принимают имя объекта снаружи: ключ `../` увёл бы загрузку в чужой каталог бакета.
 */
function pitrObjectKey(): string {
  const key = required("--key").replace(/^\/+/, "");
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key) || key.split("/").includes("..")) {
    throw new Error("некорректный ключ объекта: " + key);
  }
  const prefix = objectStoreConfigFromEnv()?.prefix ?? "webnestdev";
  if (!key.startsWith(prefix + "/pitr/")) {
    throw new Error("ключ PITR должен начинаться с " + prefix + "/pitr/");
  }
  return key;
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.error(USAGE);
    return;
  }

  switch (command) {
    case "config": {
      const config = objectStoreConfigFromEnv();
      if (!config) {
        throw new Error(
          "объектное хранилище не настроено: задайте PLATFORM_S3_ENDPOINT, PLATFORM_S3_BUCKET, " +
          "PLATFORM_S3_ACCESS_KEY_ID и PLATFORM_S3_SECRET_ACCESS_KEY",
        );
      }
      // Только адрес, бакет и префикс: ключи не печатаются даже частично.
      console.log(JSON.stringify({
        ok: true,
        endpoint: new URL(config.endpoint).host,
        bucket: config.bucket,
        prefix: config.prefix,
        region: config.region,
      }));
      return;
    }
    case "put": {
      const manifest = await putBackup({ store: store(), database: database(), input: process.stdin });
      console.log(JSON.stringify({ ok: true, ...manifest }));
      return;
    }
    case "manifest": {
      const manifest = await readManifest(store(), database());
      console.log(JSON.stringify(manifest));
      return;
    }
    case "check": {
      const raw = flag("--max-age-hours");
      const maxAgeHours = raw === undefined ? 30 : Number(raw);
      if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
        throw new Error("--max-age-hours должен быть положительным числом");
      }
      const result = await checkBackup({ store: store(), database: database(), maxAgeHours });
      console.log(JSON.stringify({ ok: true, ageHours: Math.round(result.ageHours * 10) / 10, ...result.manifest }));
      return;
    }
    case "get": {
      const key = required("--key");
      const sha256 = required("--sha256");
      await readBackup({ store: store(), key, sha256, output: process.stdout });
      return;
    }
    case "put-object": {
      // Файл может быть большим (base backup), поэтому он идёт через временный файл: putFile
      // требует путь, а держать такой объём в памяти незачем.
      const key = pitrObjectKey();
      const dir = await mkdtemp(path.join(tmpdir(), "wnd-pitr-"));
      try {
        const file = path.join(dir, "object");
        await pipeline(process.stdin, createWriteStream(file, { mode: 0o600 }));
        const bytes = await store().putFile(key, file, "application/octet-stream");
        const head = await store().head(key);
        if (!head || head.size !== bytes) throw new Error("хранилище не подтвердило объект " + key);
        console.log(JSON.stringify({ ok: true, key, bytes }));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }
    case "get-object": {
      const key = pitrObjectKey();
      const dir = await mkdtemp(path.join(tmpdir(), "wnd-pitr-"));
      try {
        const file = path.join(dir, "object");
        if (!(await store().getToFile(key, file))) throw new Error("объекта нет: " + key);
        await pipeline(createReadStream(file), process.stdout);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }
    case "head-object": {
      const key = pitrObjectKey();
      const head = await store().head(key);
      console.log(JSON.stringify({ ok: true, exists: Boolean(head), bytes: head?.size ?? 0 }));
      return;
    }
    default:
      console.error("Неизвестная команда: " + command + "\n" + USAGE);
      process.exitCode = 2;
  }
}

// `pg_restore` может закрыть поток раньше (ошибка в дампе): это не повод падать с шумом,
// итог восстановления всё равно решает код возврата самого `pg_restore` в конвейере.
process.stdout.on("error", error => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  console.error("[postgres-backup] запись в stdout: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});

main().catch(error => {
  console.error("[postgres-backup] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
