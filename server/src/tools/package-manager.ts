/**
 * Выбор пакетного менеджера для `npm.install` (название историческое: инструмент ставит Node-
 * зависимости проекта, а не только npm). `packageManager` в package.json важнее lock-файлов:
 * так проект явно фиксирует версию менеджера, даже если рядом лежит чужой старый lock.
 */

export type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type NodePackageJson = {
  packageManager?: string;
};

export const NODE_LOCKFILES: ReadonlyArray<{ name: string; manager: NodePackageManager }> = [
  { name: "pnpm-lock.yaml", manager: "pnpm" },
  { name: "yarn.lock", manager: "yarn" },
  { name: "bun.lockb", manager: "bun" },
  { name: "bun.lock", manager: "bun" },
  { name: "package-lock.json", manager: "npm" },
  { name: "npm-shrinkwrap.json", manager: "npm" },
];

const MANAGERS = new Set<NodePackageManager>(["npm", "pnpm", "yarn", "bun"]);

/** `pnpm@9.12.0` → `pnpm`; неизвестный или пустой packageManager игнорируется. */
export function declaredPackageManager(pkg: NodePackageJson | null | undefined): NodePackageManager | null {
  const raw = pkg?.packageManager?.trim();
  if (!raw) return null;
  const name = raw.split("@")[0]?.trim().toLowerCase();
  return name && MANAGERS.has(name as NodePackageManager) ? name as NodePackageManager : null;
}

/** Первый существующий lock-файл в стабильном порядке; он же определяет frozen-режим. */
export function lockfilePackageManager(lockfiles: readonly string[]): NodePackageManager | null {
  for (const entry of NODE_LOCKFILES) {
    if (lockfiles.includes(entry.name)) return entry.manager;
  }
  return null;
}

export function packageManagerFor(
  pkg: NodePackageJson | null | undefined,
  lockfiles: readonly string[],
): NodePackageManager {
  return declaredPackageManager(pkg) ?? lockfilePackageManager(lockfiles) ?? "npm";
}

export function lockfileFor(manager: NodePackageManager): string | null {
  return NODE_LOCKFILES.find(entry => entry.manager === manager)?.name ?? null;
}

/**
 * Воспроизводимая установка: при наличии lock-файла frozen/ci, иначе обычный install.
 * Команда не принимает пользовательских аргументов — только перечисление менеджеров.
 */
export function installCommandFor(manager: NodePackageManager, hasLockfile: boolean): string {
  switch (manager) {
    case "npm":
      return hasLockfile ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
    case "pnpm":
      return hasLockfile ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "yarn":
      return hasLockfile ? "yarn install --frozen-lockfile" : "yarn install";
    case "bun":
      return hasLockfile ? "bun install --frozen-lockfile" : "bun install";
  }
}
