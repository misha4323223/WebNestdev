import { egressProxyEnv } from "../../egress/config.js";
import { proxyReachableFrom } from "../../egress/network.js";
import { workspaceMountSource } from "../config.js";
import type { SandboxConfig } from "../sandbox-types.js";
import type { DockerSandboxOptions } from "./types.js";

export function dockerRunArgs(
  config: SandboxConfig,
  cwd: string,
  options: DockerSandboxOptions,
  command: string,
  network = options.network,
  name?: string,
  extraMounts: string[] = [],
  mode: { detached?: boolean; labels?: Record<string, string> } = {},
  env: Record<string, string> = {},
) {
  const suffix=cwd===config.root?"":cwd.slice(config.root.length).replaceAll("\\","/");
  // Монтируется путь хоста (см. workspaceMountSource): docker разбирает его на хосте, а не в этом
  // процессе. Когда песочницы лежат на хосте, оба пути совпадают, и это ничего не меняет.
  // extraMounts идут после рабочего каталога: маска секретного файла должна перекрыть
  // настоящий `.env.local`, а не быть перекрытой общей папкой проекта.
  // `--cap-drop ALL` и `no-new-privileges` — страховка поверх uid 1000: контейнеру не нужны ни
  // capabilities, ни setuid-бинарники, а команда приходит из модели. `--read-only` уже не даёт
  // писать в корень образа, но без сброса capabilities остаются пути повышения прав внутри него.
  // Набор флагов ниже — контракт с Docker-брокером (deploy/docker-broker/policy.mjs): он требует
  // read-only корень, cap-drop ALL, no-new-privileges, uid 1000 и лимиты, а монтирования пускает
  // только внутрь каталога песочниц. Новый флаг здесь появляется вместе с правилом в политике.
  const labels = Object.entries(mode.labels ?? {}).flatMap(([key, value]) => ["--label", key + "=" + value]);
  // env — только для конкретной команды (например, EXPO_TOKEN у EAS CLI): значение уходит
  // в окружение контейнера, а не в текст команды, поэтому не печатается в логах шага.
  // Переменные egress-прокси (пункт 5.1) — только контейнерам, которые до него дотягиваются:
  // прокси живёт в сети предпросмотра, а `none` и `bridge` — другие сети (в bridge же
  // оказываются и удалённые runner'ы). Передать их там значило бы сломать установку пакетов
  // адресом, которого нет.
  const proxyEnv = proxyReachableFrom(network) ? egressProxyEnv() : {};
  const envArgs = [...Object.entries({ ...proxyEnv, ...env })].flatMap(([key, value]) => ["-e", key + "=" + value]);
  // gVisor включается одной переменной. Флаг добавляется ко всем контейнерам команд и заданий;
  // политика брокера разрешает только тот Runtime, который назван в BROKER_RUNTIME.
  const runtimeArgs = options.runtime==="runsc"?["--runtime=runsc"]:[];
  return ["run",...(mode.detached?["-d"]:["--rm"]),"--init",...runtimeArgs,...(name?["--name",name]:[]),...labels,"--network",network,"--cap-drop","ALL","--security-opt","no-new-privileges:true","--cpus",options.cpus,"--memory",options.memory,"--pids-limit",options.pids,"--read-only","--tmpfs","/tmp:rw,nosuid,size=256m","--user","1000:1000","-v",workspaceMountSource(config)+":/workspace",...extraMounts,"-w","/workspace"+suffix,"-e","HOME=/tmp",
    // Кэш npm по умолчанию живёт в $HOME/.npm, то есть в /tmp — а это tmpfs на 256 МБ. На дереве
    // из нескольких сотен пакетов он переполняется, и npm умирает посреди установки
    // (`Exit handler never called!`, `ENOTEMPTY`), оставляя node_modules без `.bin`. Кэш на диске
    // проекта решает это и не попадает в архив холодного яруса: `./node_modules/.cache` уже
    // исключён в project-archive.ts.
    "-e","npm_config_cache=/workspace/node_modules/.cache/npm",
    "-e","WEBNESTDEV_PROJECT_ID="+config.projectId,"-e","CI=1",...envArgs,
    // Репозиторий создаёт сервер от root, а git в контейнере работает от uid 1000. Права на
    // `.git` открывает openGitForSandbox, но git всё равно сверяет владельца и без этой записи
    // отказывается работать в чужом репозитории (`dubious ownership`). Внутри изолированного
    // контейнера проверка ничего не защищает: там один проект и один пользователь.
    "-e","GIT_CONFIG_COUNT=1","-e","GIT_CONFIG_KEY_0=safe.directory","-e","GIT_CONFIG_VALUE_0=*",
    options.image,"/bin/sh","-lc",command];
}
