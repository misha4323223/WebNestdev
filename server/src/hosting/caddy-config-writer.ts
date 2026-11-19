import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Общий файл для custom domains лежит в каталоге, который смонтирован и серверу (на запись),
 * и Caddy (только на чтение). Отдельный файл, а не правка основного Caddyfile: основной
 * Caddyfile приезжает выкаткой, а этот файл целиком принадлежит API.
 *
 * Запись атомарная: Caddy не должен прочитать половину списка доменов между двумя сайтами.
 * Если содержимое не изменилось, файл не перезаписывается — таймер reload на обеих нодах
 * не перезагружает Caddy зря.
 */

export const CUSTOM_DOMAINS_CADDY_FILE = "custom-domains.caddy";
/** Не `.caddy`: глобальный import custom-каталога не должен подхватить map как site-блок. */
export const HOSTING_MODES_CADDY_FILE = "hosting-modes.map";
/** Импортируется внутрь wildcard-блока платформенных сайтов. */
export const HOSTING_REDIRECTS_CADDY_FILE = "hosting-redirects.map";

export function customDomainsCaddyDir(): string {
  const raw = (process.env.CUSTOM_DOMAINS_CADDY_DIR ?? "/srv/caddy-custom").trim();
  const dir = path.resolve(raw || "/srv/caddy-custom");
  if (dir === path.parse(dir).root) {
    throw new Error("CUSTOM_DOMAINS_CADDY_DIR не может быть корнем файловой системы");
  }
  return dir;
}

export function customDomainsCaddyPath(): string {
  return path.join(customDomainsCaddyDir(), CUSTOM_DOMAINS_CADDY_FILE);
}

export function hostingModesCaddyPath(): string {
  return path.join(customDomainsCaddyDir(), HOSTING_MODES_CADDY_FILE);
}

export function hostingRedirectsCaddyPath(): string {
  return path.join(customDomainsCaddyDir(), HOSTING_REDIRECTS_CADDY_FILE);
}

export type WriteCaddyConfigResult = {
  file: string;
  changed: boolean;
  sha256: string;
};

async function writeCaddyTextFile(
  fileName: string,
  content: string,
  options: { dir?: string } = {},
): Promise<WriteCaddyConfigResult> {
  const dir = options.dir ? path.resolve(options.dir) : customDomainsCaddyDir();
  const file = path.join(dir, fileName);
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

  await mkdir(dir, { recursive: true, mode: 0o755 });
  let previous: string | null = null;
  try {
    previous = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous === content) return { file, changed: false, sha256 };

  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, content, { encoding: "utf8", mode: 0o644 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { file, changed: true, sha256 };
}

export async function writeCustomDomainsCaddy(
  content: string,
  options: { dir?: string } = {},
): Promise<WriteCaddyConfigResult> {
  return writeCaddyTextFile(CUSTOM_DOMAINS_CADDY_FILE, content, options);
}

export async function writeHostingModesCaddy(
  content: string,
  options: { dir?: string } = {},
): Promise<WriteCaddyConfigResult> {
  return writeCaddyTextFile(HOSTING_MODES_CADDY_FILE, content, options);
}

export async function writeHostingRedirectsCaddy(
  content: string,
  options: { dir?: string } = {},
): Promise<WriteCaddyConfigResult> {
  return writeCaddyTextFile(HOSTING_REDIRECTS_CADDY_FILE, content, options);
}
