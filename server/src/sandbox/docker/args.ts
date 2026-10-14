import { workspaceMountSource } from "../config.js";
import type { SandboxConfig } from "../sandbox-types.js";
import type { DockerSandboxOptions } from "./types.js";

export function dockerRunArgs(config:SandboxConfig,cwd:string,options:DockerSandboxOptions,command:string,network=options.network){
  const suffix=cwd===config.root?"":cwd.slice(config.root.length).replaceAll("\\","/");
  // Монтируется путь хоста (см. workspaceMountSource): docker разбирает его на хосте, а не в этом
  // процессе. Когда песочницы лежат на хосте, оба пути совпадают, и это ничего не меняет.
  return ["run","--rm","--init","--network",network,"--cpus",options.cpus,"--memory",options.memory,"--pids-limit",options.pids,"--read-only","--tmpfs","/tmp:rw,nosuid,size=256m","--user","1000:1000","-v",workspaceMountSource(config)+":/workspace","-w","/workspace"+suffix,"-e","HOME=/tmp","-e","WEBNESTDEV_PROJECT_ID="+config.projectId,"-e","CI=1",options.image,"/bin/sh","-lc",command];
}
