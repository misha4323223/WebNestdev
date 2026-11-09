import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Shared mailbox between the admin API and the HA controllers.
 *
 * The API can be served by either node, and the node that receives the request
 * may be the one whose PostgreSQL is about to be stopped. A control file in the
 * shared data volume lets both controllers see the same planned operation
 * without adding a second network service or a privileged endpoint.
 */

export const SWITCHOVER_FILE = "ha-switchover.json";
export const ACTIVE_SWITCHOVER_STATES = ["requested", "target_ready", "source_stopped"] as const;
export const SWITCHOVER_STATES = [
  ...ACTIVE_SWITCHOVER_STATES,
  "promoted",
  "failed",
  "rolled_back",
] as const;

export type SwitchoverState = (typeof SWITCHOVER_STATES)[number];

export type SwitchoverCommand = {
  id: string;
  action: "switchover";
  target: string;
  state: SwitchoverState;
  createdAt: string;
  updatedAt: string;
  requestedBy: string;
  reason?: string;
  replayLsn?: string;
  apiStoppedAt?: string;
  stoppedAt?: string;
  promotedAt?: string;
  message?: string;
};

export type SwitchoverStatus = SwitchoverCommand & { ageMs: number };

function dataDirectory() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

export function switchoverFile() {
  return path.join(dataDirectory(), SWITCHOVER_FILE);
}

export async function readSwitchover(): Promise<SwitchoverCommand | null> {
  let text: string;
  try {
    text = await readFile(switchoverFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Файл switchover повреждён: " + switchoverFile());
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Файл switchover повреждён");
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    value.action !== "switchover" ||
    typeof value.target !== "string" ||
    !(SWITCHOVER_STATES as readonly unknown[]).includes(value.state)
  ) {
    throw new Error("Файл switchover не содержит корректной операции");
  }
  return value as unknown as SwitchoverCommand;
}

export function isSwitchoverActive(command: SwitchoverCommand | null): boolean {
  return Boolean(command && (ACTIVE_SWITCHOVER_STATES as readonly string[]).includes(command.state));
}

/**
 * Persist a new request. An active operation cannot be replaced: the operator
 * must wait for `promoted`, `failed` or `rolled_back` first.
 */
export async function requestSwitchover(input: {
  target: string;
  requestedBy: string;
  reason?: string;
}): Promise<SwitchoverCommand> {
  const file = switchoverFile();
  await mkdir(path.dirname(file), { recursive: true });
  return withSwitchoverLock(file, async () => {
    const existing = await readSwitchover();
    if (isSwitchoverActive(existing)) {
      throw new Error("Уже выполняется switchover " + existing?.id + " в состоянии " + existing?.state);
    }
    const now = new Date().toISOString();
    const command: SwitchoverCommand = {
      id: randomUUID(),
      action: "switchover",
      target: input.target,
      state: "requested",
      createdAt: now,
      updatedAt: now,
      requestedBy: input.requestedBy,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    await writeSwitchover(command);
    return command;
  });
}

/**
 * Serialize request creation across API replicas. `mkdir` is atomic on the
 * shared POSIX volume and does not need an external lock daemon. A stale lock
 * from a crashed API process is removed after a short grace period.
 */
async function withSwitchoverLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const lock = file + ".admin-lock";
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > 10_000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Не удалось получить блокировку switchover: повторите запрос");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function switchoverStatus(command: SwitchoverCommand | null, now = Date.now()): SwitchoverStatus | null {
  if (!command) return null;
  const created = Date.parse(command.createdAt);
  return { ...command, ageMs: Number.isFinite(created) ? Math.max(0, now - created) : 0 };
}

async function writeSwitchover(command: SwitchoverCommand) {
  const file = switchoverFile();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + process.pid + ".tmp";
  // The HA controller runs as root, the API as uid 1000. The file contains no
  // secrets; 0644 keeps the state readable regardless of the shared volume's
  // ownership and lets the controller replace it atomically.
  await writeFile(temporary, JSON.stringify(command, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
  await rename(temporary, file);
}
