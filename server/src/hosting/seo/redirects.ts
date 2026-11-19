import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";

/**
 * `_redirects` — файл пользователя в корне релиза, а не отдельная таблица в базе.
 *
 * Парсер намеренно строгий: правило, которое может увести на чужой сайт, зациклиться или
 * превратить отсутствующий ассет в HTML, не применяется. Ошибки не валят публикацию: сайт
 * остаётся рабочим, а панель и SEO-аудит показывают, что именно исправить.
 */

export type HostingRedirectRule = {
  /** Путь или путь с одним `*` в конце. */
  from: string;
  /** Внутренний путь; `:splat` заменяется хвостом wildcard-правила. */
  to: string;
  status: 301 | 302;
  wildcard: boolean;
};

export type HostingRedirectError = {
  line: number;
  message: string;
};

export type HostingRedirects = {
  rules: HostingRedirectRule[];
  errors: HostingRedirectError[];
};

export const REDIRECTS_FILE = "_redirects";
export const MAX_REDIRECTS = 100;
export const MAX_REDIRECTS_BYTES = 256 * 1024;

const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function badLine(line: number, message: string): HostingRedirectError {
  return { line, message };
}

function safePath(value: string) {
  if (!SAFE_PATH.test(value) || value.length > 512) return false;
  if (value.startsWith("//") || value.includes("\\") || value.includes("\0")) return false;
  // Некоторые клиенты декодируют `%2F` и `%5C` до проверки origin; такой путь может
  // превратиться в `//host` и стать открытым редиректом. Не принимаем его вовсе.
  if (/%2f%2f|%5c/i.test(value)) return false;
  return !value.split("/").some(part => part === ".." || part === ".");
}

function splitTarget(target: string, wildcard: boolean) {
  if (!safePath(target)) return null;
  if (!wildcard && target.includes(":splat")) return null;
  if (target.includes("?") || target.includes("#")) return null;
  return target;
}

/**
 * Проверка цикла по точным правилам. Wildcard-правило с `:splat` может ссылаться на другой
 * раздел; проверяем также случай, когда оно возвращает запрос в собственный префикс.
 */
function findCycle(rules: readonly HostingRedirectRule[]): HostingRedirectRule | null {
  const exact = new Map<string, string>();
  for (const rule of rules) {
    if (!rule.wildcard) exact.set(rule.from, rule.to);
  }
  for (const rule of rules) {
    if (rule.wildcard) {
      const prefix = rule.from.slice(0, -1);
      const target = rule.to.replaceAll(":splat", "");
      if (target.startsWith(prefix)) return rule;
      continue;
    }
    const seen = new Set<string>([rule.from]);
    let current = rule.to;
    while (exact.has(current)) {
      if (seen.has(current)) return rule;
      seen.add(current);
      current = exact.get(current)!;
    }
  }
  return null;
}

/**
 * Строки формата `/old /new 301` и `/blog/* /articles/:splat 301`.
 * Внешние адреса не принимаются: публичный редирект на чужой origin — это open redirect,
 * а для внешнего переезда пользователь может поставить обычную ссылку в контенте.
 */
export function parseRedirects(text: string): HostingRedirects {
  const rules: HostingRedirectRule[] = [];
  const errors: HostingRedirectError[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith("#")) continue;
    if (rules.length >= MAX_REDIRECTS) {
      errors.push(badLine(index + 1, "Больше " + MAX_REDIRECTS + " правил: лишние не применены"));
      break;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) {
      errors.push(badLine(index + 1, "Ожидается: /старый /новый 301"));
      continue;
    }
    const from = parts[0]!;
    const target = parts[1]!;
    const statusText = parts[2] ?? "301";
    const status = statusText === "301" ? 301 : statusText === "302" ? 302 : 0;
    if (!status) {
      errors.push(badLine(index + 1, "Код редиректа должен быть 301 или 302"));
      continue;
    }
    if (!from.startsWith("/") || !safePath(from) || from.includes("?") || from.includes("#")) {
      errors.push(badLine(index + 1, "Источник должен быть внутренним путём без query и #"));
      continue;
    }
    const stars = (from.match(/\*/g) ?? []).length;
    const wildcard = stars === 1 && from.endsWith("*");
    if (stars > 1 || (stars === 1 && !wildcard)) {
      errors.push(badLine(index + 1, "В источнике допустим только один * в конце"));
      continue;
    }
    if (wildcard && !from.slice(0, -1).endsWith("/")) {
      errors.push(badLine(index + 1, "Wildcard должен стоять после /: /blog/*"));
      continue;
    }
    const to = splitTarget(target, wildcard);
    if (!to) {
      errors.push(badLine(index + 1, "Цель должна быть внутренним путём без query, # и внешнего origin"));
      continue;
    }
    const key = from.toLowerCase();
    if (seen.has(key)) {
      errors.push(badLine(index + 1, "Дублирующее правило для " + from));
      continue;
    }
    seen.add(key);
    rules.push({ from, to, status, wildcard });
  }

  const cycle = findCycle(rules);
  if (cycle) {
    const atom = rules.indexOf(cycle) + 1;
    errors.push(badLine(atom, "Правило образует цикл: " + cycle.from + " → " + cycle.to));
    return { rules: rules.filter(rule => rule !== cycle), errors };
  }
  return { rules, errors };
}

/**
 * Читает `_redirects` из корня релиза. Отсутствующий файл — нормальный случай, а не ошибка.
 */
export async function readRedirectsFromRelease(releaseDir: string): Promise<HostingRedirects & { present: boolean }> {
  const file = path.join(releaseDir, REDIRECTS_FILE);
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_REDIRECTS_BYTES) {
      return { present: true, rules: [], errors: [badLine(0, "Файл _redirects больше 256 КБ и не применён")] };
    }
    const buffer = Buffer.alloc(MAX_REDIRECTS_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { present: true, ...parseRedirects(buffer.subarray(0, bytesRead).toString("utf8")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, rules: [], errors: [] };
    return { present: true, rules: [], errors: [badLine(0, "Не удалось прочитать _redirects")] };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeName(value: string) {
  const readable = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "r";
  // Два валидных hostname (`a-b.ru` и `a.b.ru`) дают одинаковый читаемый префикс; хвост
  // хеша не даёт именам matcher-ов столкнуться в одном импортируемом файле.
  return readable + "_" + createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function targetWithSplat(rule: HostingRedirectRule, matcher: string) {
  if (!rule.wildcard) return rule.to;
  return rule.to.replaceAll(":splat", "{re." + matcher + ".1}");
}

/**
 * Caddy-директивы для одного сайта. `host` matcher делает файл безопасным для импорта в общий
 * wildcard-блок: правило одного сайта не может сработать на другом Host.
 */
export function renderRedirectDirectives(input: {
  hostname: string;
  rules: readonly HostingRedirectRule[];
  namePrefix: string;
}): string[] {
  if (!HOST_RE.test(input.hostname) || !input.rules.length) return [];
  const prefix = safeName(input.namePrefix);
  const lines: string[] = [];
  input.rules.forEach((rule, index) => {
    const matcher = "redirect_" + prefix + "_" + index;
    lines.push("@" + matcher + " {", "\thost " + input.hostname);
    // Функции сайта и ACME-путь не должны становиться жертвой пользовательского редиректа:
    // их обрабатывает отдельная дверь/сам Caddy, а не статический маршрут.
    lines.push("\tnot path /api/* /.well-known/*");
    if (rule.wildcard) {
      const prefixPath = rule.from.slice(0, -1);
      lines.push("\tpath_regexp " + matcher + " ^" + escapeRegex(prefixPath) + "(.*)$");
    } else {
      lines.push("\tpath " + rule.from);
    }
    lines.push("}", "redir @" + matcher + " " + targetWithSplat(rule, matcher) + "{?query} " + rule.status);
  });
  return lines;
}

export function renderRedirectsCaddy(routes: ReadonlyArray<{ hostname: string; rules: readonly HostingRedirectRule[] }>): string {
  const lines = [
    "# Сгенерировано API: пользовательские _redirects сайтов. Не редактировать вручную.",
    "# Правила с ошибками не попали в конфиг; они видны в SEO-панели.",
  ];
  for (const route of routes) {
    const directives = renderRedirectDirectives({
      hostname: route.hostname,
      rules: route.rules,
      namePrefix: route.hostname,
    });
    if (directives.length) lines.push("", ...directives);
  }
  return lines.join("\n") + "\n";
}
