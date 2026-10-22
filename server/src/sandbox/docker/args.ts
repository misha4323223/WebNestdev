import { workspaceMountSource } from "../config.js";
import type { SandboxConfig } from "../sandbox-types.js";
import type { DockerSandboxOptions } from "./types.js";

export function dockerRunArgs(config:SandboxConfig,cwd:string,options:DockerSandboxOptions,command:string,network=options.network,name?:string,extraMounts:string[]=[]){
  const suffix=cwd===config.root?"":cwd.slice(config.root.length).replaceAll("\\","/");
  // Монтируется путь хоста (см. workspaceMountSource): docker разбирает его на хосте, а не в этом
  // процессе. Когда песочницы лежат на хосте, оба пути совпадают, и это ничего не меняет.
  // extraMounts идут после рабочего каталога: маска секретного файла должна перекрыть
  // настоящий `.env.local`, а не быть перекрытой общей папкой проекта.
  // `--cap-drop ALL` и `no-new-privileges` — страховка поверх uid 1000: контейнеру не нужны ни
  // capabilities, ни setuid-бинарники, а команда приходит из модели. `--read-only` уже не даёт
  // писать в корень образа, но без сброса capabilities остаются пути повышения прав внутри него.
  return ["run","--rm","--init",...(name?["--name",name]:[]),"--network",network,"--cap-drop","ALL","--security-opt","no-new-privileges:true","--cpus",options.cpus,"--memory",options.memory,"--pids-limit",options.pids,"--read-only","--tmpfs","/tmp:rw,nosuid,size=256m","--user","1000:1000","-v",workspaceMountSource(config)+":/workspace",...extraMounts,"-w","/workspace"+suffix,"-e","HOME=/tmp","-e","WEBNESTDEV_PROJECT_ID="+config.projectId,"-e","CI=1",
    // Репозиторий создаёт сервер от root, а git в контейнере работает от uid 1000. Права на
    // `.git` открывает openGitForSandbox, но git всё равно сверяет владельца и без этой записи
    // отказывается работать в чужом репозитории (`dubious ownership`). Внутри изолированного
    // контейнера проверка ничего не защищает: там один проект и один пользователь.
    "-e","GIT_CONFIG_COUNT=1","-e","GIT_CONFIG_KEY_0=safe.directory","-e","GIT_CONFIG_VALUE_0=*",
    options.image,"/bin/sh","-lc",command];
}
