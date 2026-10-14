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
export type PreviewState={mode:PreviewMode;containerId:string;port:number;host:string;projectId:string;startedAt:number;lastUsedAt:number};
/** What the panel and the agent see: a running preview always carries its address. */
export type PreviewStatus={running:false}|{running:true;ready:boolean;port:number;host:string;containerId:string;startedAt:number;mode?:PreviewMode;hint?:string};
export type DockerExecResult={code:number;stdout:string;stderr:string};
