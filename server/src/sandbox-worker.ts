import { runDockerSandbox, type DockerCommandResult } from "./docker-sandbox.js";
import { withSandboxSlot } from "./sandbox/sandbox-limiter.js";
import { openProjectForSandbox } from "./sandbox/permissions.js";
import type { SandboxConfig } from "./sandbox-manager.js";
import { previewSecretMounts } from "./secrets/preview-secrets.js";
export type CommandResult = DockerCommandResult;
export type SandboxRunOptions = {
  network?: "none"|"bridge";
  /**
   * Переменные только для этого контейнера. Так токен интеграции попадает в процесс EAS,
   * не оказываясь ни в файле проекта, ни в команде оболочки.
   */
  env?: Record<string,string>;
  signal?: AbortSignal;
  /** Предел времени одной команды; по умолчанию `config.timeoutMs`. Ограничен сверху в docker-sandbox. */
  timeoutMs?: number;
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
  // Каталог проекта перед командой открывается контейнеру заново: его мог создать от root
  // любой путь сервера (клон, распаковка архива, переключение ветки), а `npm run build`
  // создаёт `dist` рядом с файлами — и получает EACCES задолго до первой ошибки сборки.
  // Обход пропускает node_modules и .git, поэтому для обычного проекта это единицы миллисекунд.
  await openProjectForSandbox(config.root);
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
