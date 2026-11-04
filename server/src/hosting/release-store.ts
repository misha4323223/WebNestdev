import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { objectStoreConfigFromEnv, s3ObjectStore, type ObjectStore } from "../storage/object-store.js";
import { inspectArtifact, type ArtifactLimits, type ArtifactManifest } from "./artifact.js";
import { hostingBucketMode, hostingBucketPrefix, hostingLimits, hostingSitesDir } from "./config.js";
import { ensureSiteLayout, hostingTmpDir } from "./paths.js";
import { assertHostingReleaseId } from "./slug.js";
import { HostingError, type HostingRelease, type HostingSite } from "./types.js";

/**
 * Этап 8: готовый релиз уезжает в объектное хранилище.
 *
 * Бакет — источник правды для готовых релизов, локальный каталог — горячий кэш, который
 * читает Caddy. Поэтому публикация не становится «сайтом из S3»: на запрос пользователя
 * по-прежнему отвечает файл с диска, без похода в сеть. А при потере диска активный релиз
 * можно восстановить из архива, не собирая проект заново.
 *
 * Один релиз — два объекта: `*.tar.gz` со всем артефактом и `*.json` с манифестом. Тысячи
 * объектов на сайт не нужны: тарифы S3 считают запросы, а восстановление читает один архив.
 * Ключи строятся из userId/siteId/releaseId, поэтому их можно удалить по строке БД, не
 * разбирая бакет.
 *
 * Лёгкие картинки и шрифты, попавшие в сборку, остаются в архиве релиза. Большие медиа
 * проекта живут отдельно, в публичном бакете (`media/`): их загружает браузер по presigned
 * multipart URL, и они не раздувают релиз на 50 МиБ.
 */

export type StoredRelease = {
  storageKey: string;
  manifestKey: string;
  /** Размер tar.gz, а не распакованного артефакта: это то, что реально лежит в бакете. */
  storedBytes: number;
};

export type ReleaseStore = {
  readonly kind: "s3";
  keys(site: HostingSite, releaseId: string): { storageKey: string; manifestKey: string };
  put(input: { site: HostingSite; releaseId: string; dir: string; manifest: ArtifactManifest }): Promise<StoredRelease>;
  restore(input: { site: HostingSite; release: HostingRelease; dir: string }): Promise<void>;
  remove(input: { site: HostingSite; release: HostingRelease }): Promise<void>;
  removeKeys(storageKey: string, manifestKey: string): Promise<void>;
  has(input: { site: HostingSite; release: HostingRelease }): Promise<boolean>;
};

const TAR_TIMEOUT_MS = 3 * 60_000;
const execFile = promisify(execFileCallback);

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function tarCreate(archive: string, dir: string) {
  await execFile("tar", ["-czf", archive, "-C", dir, "."], {
    timeout: TAR_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Проверка архива до распаковки. `inspectArtifact` безопасен только на уже распакованном
 * дереве; symlink или `..` в tar успели бы создать файл вне staging до его вызова. Наш архив
 * состоит только из обычных файлов и каталогов, поэтому всё остальное — повреждение или
 * подмена объекта в бакете.
 */
async function assertSafeArchive(archive: string, limits: ArtifactLimits) {
  let listing: string;
  try {
    listing = (await execFile("tar", ["-tvzf", archive, "--numeric-owner"], {
      timeout: TAR_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    })).stdout;
  } catch (error) {
    throw new HostingError("RELEASE_NOT_READY", "Архив релиза повреждён: " + errorText(error), 409);
  }
  let unpackedBytes = 0;
  for (const line of listing.split("\n")) {
    if (!line) continue;
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new HostingError("RELEASE_NOT_READY", "В архиве релиза есть не файл и не каталог: " + line.slice(0, 160), 409);
    }
    // permissions owner/group size date time name; с --numeric-owner владелец без пробелов.
    const size = /^\S+\s+\S+\s+(\d+)\s+/.exec(line);
    if (!size) throw new HostingError("RELEASE_NOT_READY", "Не удалось разобрать список файлов архива", 409);
    unpackedBytes += Number(size[1]);
    if (unpackedBytes > limits.maxReleaseBytes) {
      throw new HostingError("RELEASE_NOT_READY", "Распакованный релиз больше лимита", 409);
    }
  }

  let names: string;
  try {
    names = (await execFile("tar", ["-tzf", archive], { timeout: TAR_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new HostingError("RELEASE_NOT_READY", "Архив релиза повреждён: " + errorText(error), 409);
  }
  for (const entry of names.split("\n")) {
    const name = entry.replace(/\r$/, "");
    if (!name) continue;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new HostingError("RELEASE_NOT_READY", "Архив релиза содержит недопустимый путь: " + name.slice(0, 160), 409);
    }
  }
}

async function tarExtract(archive: string, dir: string) {
  // `--no-same-owner` и `--no-same-permissions` не дают архиву принести владельца/биты
  // процесса сборки. Пути и symlink уже проверены assertSafeArchive до этой строки.
  await execFile("tar", ["-xzf", archive, "-C", dir, "--no-same-owner", "--no-same-permissions"], {
    timeout: TAR_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

export class S3ReleaseStore implements ReleaseStore {
  readonly kind = "s3" as const;

  constructor(
    private readonly objects: ObjectStore,
    private readonly prefix: string,
    private readonly options: { sitesDir: string; limits: ArtifactLimits },
  ) {}

  keys(site: HostingSite, releaseId: string) {
    assertHostingReleaseId(releaseId);
    const base = this.prefix + "/" + site.userId + "/" + site.id + "/releases/" + releaseId;
    return { storageKey: base + ".tar.gz", manifestKey: base + ".json" };
  }

  async put(input: { site: HostingSite; releaseId: string; dir: string; manifest: ArtifactManifest }): Promise<StoredRelease> {
    const { storageKey, manifestKey } = this.keys(input.site, input.releaseId);
    const work = await mkdtemp(path.join(tmpdir(), "hosting-release-"));
    try {
      const archive = path.join(work, "release.tar.gz");
      const manifestFile = path.join(work, "manifest.json");
      try {
        await tarCreate(archive, input.dir);
      } catch (error) {
        throw new HostingError("PUBLISH_FAILED", "Не удалось упаковать релиз: " + errorText(error), 500);
      }
      const stored = await stat(archive);
      if (!stored.isFile() || stored.size <= 0) {
        throw new HostingError("PUBLISH_FAILED", "Архив релиза получился пустым", 500);
      }
      await writeFile(manifestFile, JSON.stringify(input.manifest), { encoding: "utf8", mode: 0o600 });
      await this.objects.putFile(storageKey, archive, "application/gzip");
      await this.objects.putFile(manifestKey, manifestFile, "application/json");
      // PUT без подтверждения размера уже один раз означал оборванный поток. HEAD дешёвый
      // и отличает «загрузили» от «S3 принял часть».
      const head = await this.objects.head(storageKey);
      if (!head || head.size !== stored.size) {
        await this.removeKeys(storageKey, manifestKey);
        throw new HostingError(
          "PUBLISH_FAILED",
          "Бакет принял релиз не целиком: " + (head?.size ?? 0) + " из " + stored.size + " байт",
          500,
        );
      }
      return { storageKey, manifestKey, storedBytes: stored.size };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async restore(input: { site: HostingSite; release: HostingRelease; dir: string }): Promise<void> {
    if (!input.release.storageKey) {
      throw new HostingError("RELEASE_NOT_READY", "У релиза нет архива в бакете", 409);
    }
    await ensureSiteLayout(input.site.slug, this.options.sitesDir);
    // Временные файлы — внутри SITES_DIR: rename в releases обязан быть в той же ФС.
    const work = await mkdtemp(path.join(hostingTmpDir(input.site.slug, this.options.sitesDir), "restore-"));
    const archive = path.join(work, "release.tar.gz");
    const extract = path.join(work, "extract");
    try {
      await mkdir(extract, { recursive: true, mode: 0o755 });
      let found = false;
      try {
        found = await this.objects.getToFile(input.release.storageKey, archive);
      } catch (error) {
        throw new HostingError("RELEASE_NOT_READY", "Не удалось скачать релиз из бакета: " + errorText(error), 502);
      }
      if (!found) {
        throw new HostingError("RELEASE_NOT_READY", "Архив релиза не найден в бакете", 409);
      }
      await assertSafeArchive(archive, this.options.limits);
      try {
        await tarExtract(archive, extract);
      } catch (error) {
        throw new HostingError("RELEASE_NOT_READY", "Архив релиза повреждён: " + errorText(error), 409);
      }

      // Манифест из бакета не нужен: сверяем содержимое с тем, что уже записано в БД.
      // Подмена архива в бакете не должна превратиться в другой сайт под тем же id.
      let inspected: ArtifactManifest;
      try {
        inspected = await inspectArtifact(extract, {
          limits: this.options.limits,
          allowSourceMaps: process.env.HOSTING_ALLOW_SOURCEMAPS === "1",
        });
      } catch (error) {
        if (error instanceof HostingError) throw error;
        throw new HostingError("RELEASE_NOT_READY", "Распакованный релиз не прошёл проверку: " + errorText(error), 409);
      }
      if (input.release.sha256 && inspected.sha256 !== input.release.sha256) {
        throw new HostingError("RELEASE_NOT_READY", "Содержимое архива не совпадает с манифестом релиза", 409);
      }
      if (input.release.files > 0 && inspected.filesCount !== input.release.files) {
        throw new HostingError("RELEASE_NOT_READY", "Число файлов в архиве не совпадает с записью релиза", 409);
      }

      await mkdir(path.dirname(input.dir), { recursive: true, mode: 0o755 });
      await rm(input.dir, { recursive: true, force: true });
      await rename(extract, input.dir);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async remove(input: { site: HostingSite; release: HostingRelease }): Promise<void> {
    const keys = input.release.storageKey || input.release.manifestKey
      ? { storageKey: input.release.storageKey, manifestKey: input.release.manifestKey }
      : this.keys(input.site, input.release.id);
    await this.removeKeys(keys.storageKey, keys.manifestKey);
  }

  async removeKeys(storageKey: string, manifestKey: string): Promise<void> {
    // Сначала манифест, потом архив: при обрыве посередине релиз остаётся восстановимым по
    // одному объекту, а не превращается в запись без данных.
    if (manifestKey) await this.objects.remove(manifestKey);
    if (storageKey) await this.objects.remove(storageKey);
  }

  async has(input: { site: HostingSite; release: HostingRelease }): Promise<boolean> {
    if (input.release.storageKey) return Boolean(await this.objects.head(input.release.storageKey));
    const { storageKey } = this.keys(input.site, input.release.id);
    return Boolean(await this.objects.head(storageKey));
  }
}

function anyS3Setting() {
  return ["PLATFORM_S3_ENDPOINT", "PLATFORM_S3_BUCKET", "PLATFORM_S3_ACCESS_KEY_ID", "PLATFORM_S3_SECRET_ACCESS_KEY"]
    .some(name => (process.env[name] ?? "").trim() !== "");
}

/**
 * `null` — бакет выключен или не настроен, релизы живут только на диске (dev/test и
 * установка без S3). Ошибка конфигурации при `HOSTING_S3_ENABLED=1` не глотается: иначе
 * оператор думал бы, что релизы в бакете, а они молча оставались на ВМ. Частично заполненные
 * `PLATFORM_S3_*` — тоже ошибка, а не «бакета нет»: иначе опечатка в ключе тихо отключала бы
 * архив релизов.
 */
export function hostingReleaseStore(): ReleaseStore | null {
  const mode = hostingBucketMode();
  if (mode === "off") return null;
  let config;
  try {
    config = objectStoreConfigFromEnv();
  } catch (error) {
    if (mode === "on" || anyS3Setting()) {
      throw new HostingError("PUBLISH_FAILED", "Бакет настроен не полностью: " + errorText(error), 503);
    }
    console.warn("[hosting] бакет недоступен, релизы останутся на диске: " + errorText(error));
    return null;
  }
  if (!config) {
    if (mode === "on") {
      throw new HostingError(
        "PUBLISH_FAILED",
        "HOSTING_S3_ENABLED=1, но PLATFORM_S3_ENDPOINT/BUCKET/KEY_ID/SECRET не заданы",
        503,
      );
    }
    return null;
  }
  return new S3ReleaseStore(s3ObjectStore(config), hostingBucketPrefix(), {
    sitesDir: hostingSitesDir(),
    limits: hostingLimits(),
  });
}

/** Для reconcile и очистки: отсутствие S3 не должно ронять сайт, уже отдаваемый с диска. */
export function hostingReleaseStoreSafe(log: (message: string) => void = console.warn): ReleaseStore | null {
  try {
    return hostingReleaseStore();
  } catch (error) {
    log("[hosting] объектное хранилище недоступно: " + errorText(error));
    return null;
  }
}
