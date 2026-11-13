/** The port the preview command always listens on inside the container. */
export const PREVIEW_APP_PORT=3000;
/** Docker label that marks preview containers, so orphans can be found after a restart. */
export const PREVIEW_LABEL="webnestdev.preview";
/**
 * Docker label that distinguishes the backend container of a hybrid preview from the ordinary
 * dev-server container. Without it a failed hybrid start could be adopted as the next
 * container preview, and its backend would be treated as a dev server.
 */
export const PREVIEW_KIND_LABEL="webnestdev.preview.kind";
/**
 * Three ways to show a project. `container` is the dev server in its own container: live
 * reload, but a container's memory per project. `static` serves the built app from the
 * server process itself, so it costs no container at all and no hot reload is possible.
 * `hybrid` serves a static frontend from the API process and proxies configured paths to a
 * backend container: no frontend hot reload, but a real API and WebSocket.
 */
export type PreviewMode="container"|"static"|"hybrid";
/** Hybrid is a runtime preview: its backend container must count against the container cap. */
export function isRuntimePreviewMode(mode:PreviewMode){return mode==="container"||mode==="hybrid";}
/** `lastUsedAt` is the last real use (status, logs, proxied request): the idle sweeper reads it. */
/**
 * `port` — адрес, по которому приложение доступно серверу: он может отличаться от порта самой
 * команды (приложение выбрало своё) и от порта внутри контейнера (когда поднят проброс).
 * `settled` — этот адрес уже подтверждён запросом; до подтверждения статус доводит его заново
 * (см. preview/preview-address.ts).
 */
export type PreviewState={mode:PreviewMode;containerId:string;port:number;host:string;projectId:string;startedAt:number;lastUsedAt:number;/**
 * Hybrid only: the backend endpoint the listener proxies HTTP and WebSocket requests to. For a
 * container preview the app itself lives at `host`/`port`; for hybrid those fields point at the
 * listener, and these two fields point at the backend container.
 */backendHost?:string;backendPort?:number;/**
 * Владелец проекта. Нужен общему лимиту preview: вторая реплика API не может выяснить владельца
 * по своей локальной карте, а запросы к `project-store` на каждый чужой preview — лишние.
 */ownerUserId?:string;/**
 * The project's execution node. A preview on a remote runner must keep its container, logs and
 * relay on that node; the API never falls back to its own Docker socket.
 */node?:string;/**
 * The port inside the container that serves the app (or the in-container TCP relay). For a local
 * preview this equals `port`; on a runner `port` is the private relay's port and this is the
 * target the API uses for `docker exec` fallback.
 */containerPort?:number;settled?:boolean;/**
 * Адрес контейнера недоступен серверу (Docker изолирует bridge-сети), и запросы панели идут внутрь
 * контейнера через `docker exec` (см. preview/exec-proxy.ts). Снимается, когда адрес подтверждён
 * заново: прямой путь быстрее и отдаёт поток.
 */execOnly?:boolean;/**
 * Приватный адрес двери публичных предпросмотров (`host:port`), которая умеет отдать этот preview:
 * для контейнера — дверь его узла, для static — дверь процесса, который держит слушатель. Вторая
 * реплика проксирует запрос туда, вместо того чтобы пытаться достучаться до чужого Docker-моста.
 */ownerAddress?:string;/**
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
 * Что сейчас делает долгий `preview.start`: панель показывает это вместо пустого кадра и
 * неопределённости. `phase` — машинный этап, `message` — готовая строка для человека.
 */
export type PreviewStartPhase="checking"|"installing"|"building"|"starting"|"waiting";
export type PreviewStartProgress={phase:PreviewStartPhase;message:string;detail?:string;startedAt:number;updatedAt:number};
/**
 * What the panel and the agent see: a running preview always carries its address. `settled` — этот
 * адрес подтверждён запросом самого сервера; без подтверждения панель, агент и Chromium до
 * приложения не доходят, даже когда оно отвечает внутри контейнера (`ready`).
 * `starting` присутствует, пока идёт установка/сборка/первый ответ приложения.
 */
export type PreviewStatus=({running:false}|{running:true;ready:boolean;port:number;host:string;containerId:string;startedAt:number;mode?:PreviewMode;settled?:boolean;/** Hybrid only: backend endpoint behind the listener, for diagnostics and tests. */backendHost?:string;backendPort?:number;/** Port inside the container for the exec fallback; absent means the same as `port`. */containerPort?:number;/** Execution node that owns the container and relay. */node?:string;/** Приватная дверь, которая умеет отдать этот preview (см. PreviewState.ownerAddress). */ownerAddress?:string;/** Приложение отдаётся панели через `docker exec`: адрес контейнера серверу недоступен. */viaExec?:boolean;hint?:string})&{starting?:PreviewStartProgress};
export type DockerExecResult={code:number;stdout:string;stderr:string};
