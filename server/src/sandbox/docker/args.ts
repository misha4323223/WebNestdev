import type { SandboxConfig } from "../sandbox-types.js";
import type { DockerSandboxOptions } from "./types.js";

export function dockerRunArgs(config:SandboxConfig,cwd:string,options:DockerSandboxOptions,command:string,network=options.network){
  const suffix=cwd===config.root?"":cwd.slice(config.root.length).replaceAll("\\","/");
  return ["run","--rm","--init","--network",network,"--cpus",options.cpus,"--memory",options.memory,"--pids-limit",options.pids,"--read-only","--tmpfs","/tmp:rw,nosuid,size=256m","--user","1000:1000","-v",config.root+":/workspace","-w","/workspace"+suffix,"-e","HOME=/tmp","-e","WEBNESTDEV_PROJECT_ID="+config.projectId,"-e","CI=1",options.image,"/bin/sh","-lc",command];
}
