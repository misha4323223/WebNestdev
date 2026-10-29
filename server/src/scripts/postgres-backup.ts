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
import { objectStoreConfigFromEnv, s3ObjectStore } from "../storage/object-store.js";
import { checkBackup, putBackup, readBackup, readManifest } from "../storage/postgres-backup.js";

const USAGE = [
  "postgres-backup config",
  "postgres-backup put --database <имя>",
  "postgres-backup manifest --database <имя>",
  "postgres-backup check --database <имя> [--max-age-hours 30]",
  "postgres-backup get --key <ключ> --sha256 <сумма>",
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
