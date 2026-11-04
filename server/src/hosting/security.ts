/**
 * Проверки содержимого релиза перед публикацией.
 *
 * Это не «антивирус» и не замена изоляции сборки: публичная сборка вообще не получает
 * приватных секретов, а Caddy не исполняет файлы. Здесь отсекаются очевидные ошибки, которые
 * иначе попали бы на публичный адрес: `.env`, `.git`, `node_modules`, source map, известные
 * форматы ключей и точные значения проектных секретов.
 */

const FORBIDDEN_NAMES = new Set([
  ".env",
  ".npmrc",
  ".git-credentials",
  ".gitconfig",
  ".netrc",
  ".pypirc",
  ".DS_Store",
  "id_rsa",
  "id_ed25519",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  // Служебные файлы агента не являются частью сайта: в них бывают внутренние заметки,
  // пути и планы, которые не должны стать публичными вместе с `instant-site`.
  "TASKS.md",
  "AGENTS.md",
  "CLAUDE.md",
]);

const FORBIDDEN_DIRS = new Set(["node_modules", ".git", ".ssh", ".aws", ".config", ".cache"]);

/** Известные префиксы/форматы ключей. Список намеренно узкий: ложные отказы здесь дорогие. */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "OpenAI key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "Stripe live key", pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
];

const PUBLIC_ENV_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "REACT_APP_", "PUBLIC_", "ASTRO_", "NUXT_PUBLIC_"];

/** Имена, которые нельзя считать публичными даже с публичным префиксом. */
const PRIVATE_NAME = /(?:^|_)(?:SECRET|PRIVATE|PASSWORD|PASSWD|TOKEN|DATABASE_URL|SERVICE_ROLE|ACCESS_KEY|CLIENT_SECRET)(?:_|$)/i;

export function isPublicEnvName(name: string) {
  if (!PUBLIC_ENV_PREFIXES.some(prefix => name.startsWith(prefix))) return false;
  // `VITE_API_KEY` может быть публичным (публикуемый ключ карт), а `VITE_SECRET_KEY` — нет.
  // Явные приватные слова исключаются до попадания в `.env.local` публичной сборки.
  return !PRIVATE_NAME.test(name);
}

export function isForbiddenArtifactName(name: string, allowWellKnown = true) {
  if (name === ".well-known" && allowWellKnown) return false;
  if (FORBIDDEN_NAMES.has(name)) return true;
  if (name.startsWith(".env.")) return true;
  // `.env.example` — шаблон без значений, но в релизе он не нужен и может содержать имена
  // будущих секретов. Поэтому исключаем весь `.env*`, без исключений.
  if (name.startsWith(".env")) return true;
  if (name.startsWith(".") && name !== ".well-known") return true;
  return false;
}

export function isForbiddenArtifactDir(name: string) {
  return FORBIDDEN_DIRS.has(name) || (name.startsWith(".") && name !== ".well-known");
}

export function isSourceMap(name: string) {
  return name.toLowerCase().endsWith(".map");
}

export type SecretFinding = { path: string; kind: string };

/** Ищет известные форматы ключей и точные значения секретов проекта. */
export function scanTextForSecrets(text: string, secretValues: string[], pathLabel: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) findings.push({ path: pathLabel, kind: rule.name });
  }
  for (const value of secretValues) {
    // Короткие значения дают слишком много ложных совпадений в обычном JS/CSS.
    if (value.length < 8) continue;
    if (text.includes(value)) findings.push({ path: pathLabel, kind: "project secret value" });
  }
  return findings;
}

/**
 * Значения секретов загружаются только на сервере и только для сравнения. Они не попадают
 * ни в лог, ни в ответ API, ни в публичную сборку.
 */
export async function projectSecretValuesForScan(files: Record<string, Record<string, string>> | null) {
  const values: string[] = [];
  for (const variables of Object.values(files ?? {})) {
    for (const value of Object.values(variables)) {
      if (typeof value === "string" && value.trim().length >= 8) values.push(value);
    }
  }
  return [...new Set(values)];
}

/** Redaction для build log: значения не должны попасть в БД/UI даже если build их напечатал. */
export function redactSecretText(text: string, secretValues: string[]) {
  let output = text.replace(/\u001b\[[0-9;]*m/g, "");
  for (const value of secretValues) {
    if (value.length >= 8) output = output.split(value).join("[redacted]");
  }
  // Абсолютные пути проекта не нужны пользователю и выдают внутреннюю раскладку.
  output = output.replace(/\/var\/lib\/webnestdev\/sandboxes\/[A-Za-z0-9._-]+/g, "<project>");
  return output.slice(-16_000);
}

