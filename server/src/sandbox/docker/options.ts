import { sandboxImage, sandboxRuntime } from "../config.js";
import type { SandboxConfig } from "../sandbox-types.js";
import type { DockerSandboxOptions } from "./types.js";

/**
 * Аргументы Docker для контейнера команды.
 *
 * `SANDBOX_MEMORY` — общий потолок по умолчанию (в production `1g`). `memoryOverrideMb` — потолок
 * конкретной команды, выбранный по её классу (`sandbox/command-memory.ts`), и он важнее общего:
 * иначе настройка из `.env` молча отключала бы деление памяти, а бюджет резервировал бы меньше,
 * чем реально выдано контейнеру. Проверено на node-1 25.11.2026: без этого приоритета лёгкие
 * команды получали полный гигабайт.
 */
export function dockerOptions(config:SandboxConfig, memoryOverrideMb?:number):DockerSandboxOptions{
  return {
    image:sandboxImage(),
    memory:memoryOverrideMb?String(Math.max(1,Math.floor(memoryOverrideMb)))+"m":process.env.SANDBOX_MEMORY??String(config.memoryMb)+"m",
    cpus:process.env.SANDBOX_CPUS??String(config.cpuLimit),
    pids:process.env.SANDBOX_PIDS_LIMIT??"128",
    network:process.env.SANDBOX_NETWORK??"none",
    maxOutput:Number(process.env.TOOL_COMMAND_MAX_OUTPUT??200000),
    runtime:sandboxRuntime()
  };
}
