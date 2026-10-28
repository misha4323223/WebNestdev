/** The port the preview command always listens on inside the container. */
export const PREVIEW_APP_PORT=3000;
/** Docker label that marks preview containers, so orphans can be found after a restart. */
export const PREVIEW_LABEL="webnestdev.preview";
/**
 * Two ways to show a project. `container` is the dev server in its own container: live
 * reload, but a container's memory per project. `static` serves the built app from the
 * server process itself, so it costs no container at all and no hot reload is possible.
 */
export type PreviewMode="container"|"static";
/** `lastUsedAt` is the last real use (status, logs, proxied request): the idle sweeper reads it. */
/**
 * `port` — адрес, по которому приложение доступно серверу: он может отличаться от порта самой
 * команды (приложение выбрало своё) и от порта внутри контейнера (когда поднят проброс).
 * `settled` — этот адрес уже подтверждён запросом; до подтверждения статус доводит его заново
 * (см. preview/preview-address.ts).
 */
export type PreviewState={mode:PreviewMode;containerId:string;port:number;host:string;projectId:string;startedAt:number;lastUsedAt:number;settled?:boolean;/**
 * Адрес контейнера недоступен серверу (Docker изолирует bridge-сети), и запросы панели идут внутрь
 * контейнера через `docker exec` (см. preview/exec-proxy.ts). Снимается, когда адрес подтверждён
 * заново: прямой путь быстрее и отдаёт поток.
 */execOnly?:boolean;/**
 * Последний полный ответ проверки адреса: `ready` — приложение ответило внутри контейнера,
 * `checkedAt` — когда это проверялось. Прокси читает статус на КАЖДЫЙ файл приложения, а полная
 * проверка (inspect + запрос внутрь контейнера + починка адреса) стоит десятки секунд, если адрес
 * не отвечает: без этого кэша кадр панели оставался белым не из-за приложения, а из-за статуса.
 */ready?:boolean;checkedAt?:number;/**
 * Когда прямой адрес проверялся в последний раз в деградировавшем режиме. Полная проверка — это
 * `docker inspect`, запрос внутрь контейнера и попытки починить адрес, а статус читается на каждый
 * файл приложения, поэтому повторяют её не чаще `PREVIEW_EXEC_RETRY_MS` (см. preview-manager.ts).
 */execOnlyCheckedAt?:number};
/**
 * What the panel and the agent see: a running preview always carries its address. `settled` — этот
 * адрес подтверждён запросом самого сервера; без подтверждения панель, агент и Chromium до
 * приложения не доходят, даже когда оно отвечает внутри контейнера (`ready`).
 */
export type PreviewStatus={running:false}|{running:true;ready:boolean;port:number;host:string;containerId:string;startedAt:number;mode?:PreviewMode;settled?:boolean;/** Приложение отдаётся панели через `docker exec`: адрес контейнера серверу недоступен. */viaExec?:boolean;hint?:string};
export type DockerExecResult={code:number;stdout:string;stderr:string};
