import { dockerTimeoutMessage } from "../sandbox/docker/cli.js";
import { resolveSandboxHost, sandboxHost } from "../sandbox/host.js";
import { nodeId } from "../nodes/identity.js";
import type { DockerExecResult } from "./types.js";

/**
 * Контейнера, о котором помнит сервер, больше нет: его удалили извне, хост перезапустил Docker или
 * (пока предпросмотр запускался с `--rm`) его унёс сам Docker после выхода процесса. Ответ Docker
 * приходит по-английски (`Error response from daemon: No such container: <id>`) и не должен ни
 * попадать пользователю как текст ошибки запуска, ни оседать в логах приложения.
 */
export function missingContainer(result: DockerExecResult) {
  return result.code !== 0 && /no such container|no such object/i.test(result.stderr);
}

export { dockerTimeoutMessage };

/**
 * Preview operations still speak Docker CLI today. Going through the active host keeps them on
 * the same execution boundary as agent commands and long jobs: a remote runner can answer these
 * operations on its own node without changing the preview code.
 */
export function dockerExec(args:string[],timeoutMs=15000):Promise<DockerExecResult>{
  return sandboxHost().docker(args,timeoutMs);
}

/**
 * Docker operations for one project's node. Resolving the host lazily is what lets the same
 * preview code run on the API VM or on a remote runner: the caller already has the node id in
 * the preview state, and a missing runner fails with a clear node error instead of silently
 * running a container on the API host.
 */
export function dockerForNode(node?:string):(args:string[],timeoutMs?:number)=>Promise<DockerExecResult>{
  return async (args,timeoutMs=15000)=>{
    const host=await resolveSandboxHost(node||nodeId());
    return host.docker(args,timeoutMs);
  };
}
