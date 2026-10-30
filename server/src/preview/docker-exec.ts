import { dockerTimeoutMessage } from "../sandbox/docker/cli.js";
import { sandboxHost } from "../sandbox/host.js";
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
