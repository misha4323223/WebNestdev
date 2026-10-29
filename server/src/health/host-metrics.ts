import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

/**
 * The numbers that decide when a host needs more hardware. They are read here, in their own
 * module, because they are the only part of health that talks to the operating system rather
 * than to this process: disk, memory and swap, each with the same tolerant shape so a host that
 * cannot answer (another OS, a missing file) reports `null` instead of failing the request.
 *
 * Disk matters most: a full disk breaks Postgres, builds and project writes at once, and it
 * happens long before RAM runs out — every project carries its own `node_modules`.
 */

export type DiskStatus = { path: string; totalMb: number; freeMb: number; usedPercent: number } | null;
export type MemoryStatus = {
  rssMb: number;
  totalMb: number;
  freeMb: number;
  /** `MemAvailable` из /proc/meminfo: свободная память плюс то, что ядро отдаст из кэша. */
  availableMb: number | null;
  swapTotalMb: number | null;
  swapFreeMb: number | null;
};

export type Meminfo = {
  availableKb: number | null;
  swapTotalKb: number | null;
  swapFreeKb: number | null;
};

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** Free space where the projects live, or `null` when the path cannot be measured. */
export async function diskStatus(path: string): Promise<DiskStatus> {
  try {
    const info = await statfs(path);
    const totalBytes = Number(info.blocks) * Number(info.bsize);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const used = Math.max(0, totalBytes - freeBytes);
    return {
      path,
      totalMb: mb(totalBytes),
      freeMb: mb(freeBytes),
      usedPercent: Math.round((used / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

/**
 * Разбор /proc/meminfo. Вынесен отдельно, чтобы границы проверялись тестом без Linux-хоста.
 * `MemAvailable` есть в ядре с 3.14; на старом ядре его нет — тогда остаётся `null`, а не
 * подмена `MemFree`, которая снова считала бы кэш занятой памятью.
 */
export function parseMeminfo(text: string): Meminfo {
  const value = (name: string) => {
    const match = new RegExp("^" + name + ":\\s+(\\d+)", "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    availableKb: value("MemAvailable"),
    swapTotalKb: value("SwapTotal"),
    swapFreeKb: value("SwapFree"),
  };
}

async function meminfo(): Promise<Meminfo | null> {
  try {
    return parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

/**
 * `rssMb` is this process — the server that also hosts the preview listeners and Chromium — and
 * it is the number to watch when the host starts swapping, because the containers are capped and
 * this process is not.
 */
export async function memoryStatus(): Promise<MemoryStatus> {
  const info = await meminfo();
  return {
    rssMb: mb(process.memoryUsage().rss),
    totalMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMb: Math.round(os.freemem() / 1024 / 1024),
    availableMb: info?.availableKb !== null && info?.availableKb !== undefined ? mb(info.availableKb * 1024) : null,
    swapTotalMb: info?.swapTotalKb !== null && info?.swapTotalKb !== undefined ? Math.round(info.swapTotalKb / 1024) : null,
    swapFreeMb: info?.swapFreeKb !== null && info?.swapFreeKb !== undefined ? Math.round(info.swapFreeKb / 1024) : null,
  };
}
