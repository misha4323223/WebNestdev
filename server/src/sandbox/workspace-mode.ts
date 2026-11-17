import path from "node:path";

/**
 * Режим хранения workspace.
 *
 * `shared` — текущий production: `WEBNESTDEV_SANDBOX_DIR` смонтирован общим (Gluster), любой API
 * видит файлы любого проекта. `local` — проект живёт только на диске ноды `project.node`.
 *
 * Значение по умолчанию намеренно `shared`: код локального режима можно выкатывать, не меняя
 * поведение production, пока оператор явно не включит новый режим. Неизвестное значение — ошибка,
 * а не тихий откат к `shared`: иначе опечатка в `.env` выглядела бы как «локальный режим включён».
 */
export type WorkspaceMode = "shared" | "local";

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = "shared";
export const DEFAULT_LOCAL_WORKSPACE_DIR = "/var/lib/webnestdev/workspaces";
export const DEFAULT_INTERNAL_API_PORT = 8791;

export function workspaceMode(env: NodeJS.ProcessEnv = process.env): WorkspaceMode {
  const raw = env.WEBNESTDEV_WORKSPACE_MODE?.trim().toLowerCase();
  if (!raw) return DEFAULT_WORKSPACE_MODE;
  if (raw === "shared" || raw === "local") return raw;
  throw new Error(
    'WEBNESTDEV_WORKSPACE_MODE="' + raw + '" не поддерживается: используйте shared или local',
  );
}

/**
 * Owner-маршрутизация выключена по умолчанию. Включать её можно раньше локальных дисков: тогда
 * запросы к проекту уже проверяются на попадание к владельцу, а файлы пока лежат на общем томе.
 */
export function ownerRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WEBNESTDEV_OWNER_ROUTING?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export function localWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.WEBNESTDEV_LOCAL_WORKSPACE_DIR?.trim() || DEFAULT_LOCAL_WORKSPACE_DIR);
}

export function internalApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WEBNESTDEV_INTERNAL_API_PORT);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_INTERNAL_API_PORT;
}

/** Токен не печатается и не возвращается наружу: health показывает только факт настройки. */
export function internalApiTokenConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.WEBNESTDEV_INTERNAL_TOKEN?.trim().length ?? 0) >= 32;
}

export type WorkspaceSettings = {
  mode: WorkspaceMode;
  ownerRouting: boolean;
  sharedDir: string;
  localDir: string;
  internalApiPort: number;
  internalTokenConfigured: boolean;
};

export function workspaceSettings(env: NodeJS.ProcessEnv = process.env): WorkspaceSettings {
  return {
    mode: workspaceMode(env),
    ownerRouting: ownerRoutingEnabled(env),
    sharedDir: path.resolve(env.WEBNESTDEV_SANDBOX_DIR ?? ".webnestdev/sandboxes"),
    localDir: localWorkspaceDir(env),
    internalApiPort: internalApiPort(env),
    internalTokenConfigured: internalApiTokenConfigured(env),
  };
}

export function describeWorkspaceSettings(env: NodeJS.ProcessEnv = process.env): string {
  const settings = workspaceSettings(env);
  const routing = settings.ownerRouting
    ? "owner-routing: вкл, порт " + settings.internalApiPort +
      (settings.internalTokenConfigured ? "" : " (токен не задан)")
    : "owner-routing: выкл";
  if (settings.mode === "shared") {
    return "workspace: shared (" + settings.sharedDir + "), " + routing;
  }
  return "workspace: local (" + settings.localDir + "), " + routing;
}
