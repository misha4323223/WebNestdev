import { runDockerSandbox, type DockerCommandResult } from "./docker-sandbox.js";
import { withSandboxSlot } from "./sandbox/sandbox-limiter.js";
import type { SandboxConfig } from "./sandbox-manager.js";
import { previewSecretMounts } from "./secrets/preview-secrets.js";
export type CommandResult = DockerCommandResult;
export type SandboxRunOptions = {
  network?: "none"|"bridge";
  signal?: AbortSignal;
  /**
   * Заменить секретные env-файлы пустыми read-only файлами внутри контейнера. Включается для
   * команд агента и сборки, но не для предпросмотра: приложению ключи нужны.
   */
  maskSecretEnvFiles?: boolean;
  /**
   * Смонтировать канонические секреты проекта как обычные env-файлы. Только для сборки и
   * предпросмотра: у команды агента противоположная задача — файл должен быть пустым.
   */
  injectSecretEnvFile?: boolean;
  /** Дополнительные `-v` аргументы; используется маскированием и предпросмотром. */
  extraMounts?: string[];
};
/**
 * Every container command in the platform goes through here — the agent's `terminal.exec`,
 * `npm.install`, the git tools, the project terminal in the panel and the preview build — so
 * this is the single place where the host's container limit is enforced. A command that arrives
 * while the limit is reached waits for a place instead of starting another container.
 */
export async function runInSandbox(config:SandboxConfig,command:string,cwd:string,options:SandboxRunOptions={}):Promise<CommandResult>{
  // Ждать в очереди тоже надо с сигналом: иначе остановленный запуск ещё минуту держал бы
  // место, а потом всё равно стартовал контейнер ради немедленной отмены.
  if (!options.injectSecretEnvFile) {
    return withSandboxSlot(()=>runDockerSandbox(config,command,cwd,options),options.signal);
  }

  // Секреты сборки живут вне проекта: файл создаётся перед запуском и удаляется после него.
  // Если создание не удалось, команда не выполняется — сборка без секретов лучше, чем
  // сборка, которая молча получила пустой ключ и записала его в артефакт.
  const injection = await previewSecretMounts(config);
  try {
    return await withSandboxSlot(
      () => runDockerSandbox(config, command, cwd, {
        ...options,
        extraMounts: [...(options.extraMounts ?? []), ...injection.mounts],
      }),
      options.signal,
    );
  } finally {
    await injection.cleanup();
  }
}
