import type { FastifyInstance,FastifyReply } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { startPreview,stopPreview,previewStatus,previewLogs } from "../preview-manager.js";
import { previewProxyBase } from "../preview/preview-rewrite.js";
import { proxyPreviewRequest, previewRequestBody, type PreviewDoor } from "../preview/preview-proxy.js";
import { execFetchPreview, type ExecFetchResult } from "../preview/exec-proxy.js";
import { setPreviewExecOnly, touchPreview as touchPreviewStore, unsettlePreview } from "../preview/preview-store.js";
import { mintPreviewTicket, previewTicketTtlMs, previewTicketUrl, PREVIEW_TICKET_PARAM } from "../preview/preview-ticket.js";
import { previewHostTarget, previewPublicUrl } from "../preview/preview-host.js";
import { getProject } from "../project-store.js";

/**
 * The routes take their collaborators as a parameter (the same way the agent WebSocket takes
 * its runtime), so the proxy can be exercised in tests without a Docker daemon and without
 * an authenticated session.
 */
export type PreviewRouteDeps={
  /** Возвращает владельца проекта (и при отказе сам отправляет ответ) — его id нужен песочнице. */
  authorize:(request:unknown,reply:unknown,projectId:string)=>Promise<{id:string}|null>;
  /**
   * Вторая дверь к приложению — запрос изнутри его контейнера (`docker exec`). Взята как
   * параметр, как и остальные соучастники: путь прокси проверяется тестом без Docker.
   */
  execPreview:(input:{containerId:string;port:number;path:string;method:string;headers:Record<string,string>;body?:Buffer;timeoutMs:number})=>Promise<ExecFetchResult|null>;
  getSandbox:(projectId:string,userId:string)=>Promise<Parameters<typeof startPreview>[0]>;
  startPreview:typeof startPreview;
  stopPreview:typeof stopPreview;
  previewStatus:typeof previewStatus;
  previewLogs:typeof previewLogs;
  /** Last-use mark for the idle sweeper; only the panel's heartbeat calls it directly. */
  touchPreview:(projectId:string)=>boolean;
  /**
   * Публичный адрес предпросмотра (`<проект>.preview.nestdev.ru`) и билет к нему. Пустой адрес —
   * публичные адреса на этом хосте выключены, и панель открывает приложение только путём.
   */
  publicUrl:(projectId:string)=>string;
  mintTicket:(projectId:string)=>string;
  ticketTtlMs:()=>number;
  /** Имя хоста → проект: по нему реверс-прокси спрашивает, можно ли выдать сертификат. */
  hostTarget:(host:string|undefined)=>string|null;
  projectExists:(projectId:string)=>Promise<boolean>;
};

const defaultDeps:PreviewRouteDeps={
  authorize:async (request,reply,projectId)=>requireProjectUser(request as never,reply as never,projectId),
  execPreview:execFetchPreview,
  getSandbox,
  startPreview,
  stopPreview,
  previewStatus,
  previewLogs,
  touchPreview:touchPreviewStore,
  publicUrl:previewPublicUrl,
  mintTicket:mintPreviewTicket,
  ticketTtlMs:previewTicketTtlMs,
  hostTarget:host=>previewHostTarget(host)?.projectId??null,
  projectExists:async projectId=>Boolean(await getProject(projectId)),
};

/**
 * Почему путь в панели закрыт без публичного адреса.
 *
 * Код проекта — это пользовательский код (и код, который пишет модель). Если отдавать его по
 * `/api/projects/<id>/preview/open/`, он выполняется на том же origin, что и панель: получает доступ
 * к её DOM, cookie сессии и API от имени вошедшего человека. Публичный поддомен — единственная
 * внятная граница, поэтому в production без `PREVIEW_PUBLIC_DOMAIN` путь закрывается, а не работает
 * «как раньше». В разработке (localhost) путь остаётся: там панель и API и так на одной машине.
 */
function previewPathClosed(deps:PreviewRouteDeps,projectId:string){
  return process.env.NODE_ENV === "production" && !deps.publicUrl(projectId);
}

const PREVIEW_PATH_CLOSED_MESSAGE =
  "Предпросмотр по адресу панели выключен: код проекта не должен выполняться на одном origin с панелью. " +
  "Задайте PREVIEW_PUBLIC_DOMAIN (например preview.example.ru) и откройте предпросмотр по публичному адресу.";

export async function registerPreviewRoutes(app:FastifyInstance,deps:PreviewRouteDeps=defaultDeps){
  /** Общая дверь к приложению: и панель, и публичный адрес идут через неё (см. preview/preview-proxy.ts). */
  const door:PreviewDoor={
    previewStatus:deps.previewStatus,
    execPreview:deps.execPreview,
    unsettle:unsettlePreview,
    setExecOnly:setPreviewExecOnly,
  };
  app.post("/api/projects/:id/preview/start",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await deps.authorize(request,reply,p.id);
    if(!user)return;
    return previewReply(reply,async()=>deps.startPreview(await deps.getSandbox(p.id,user.id)));
  });
  app.post("/api/projects/:id/preview/stop",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    return previewReply(reply,()=>deps.stopPreview(p.id));
  });
  app.get("/api/projects/:id/preview/status",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    const url=deps.publicUrl(p.id);
    return previewReply(reply,async()=>({...await deps.previewStatus(p.id),...(url?{publicUrl:url}:{})}));
  });
  /**
   * Билет на публичный адрес. Панель просит его перед тем, как открыть предпросмотр в отдельной
   * вкладке или в кадре: по адресу предпросмотра cookie сессии панели не отправляется, а cookie
   * сессии на весь домен расширять нельзя — он уходил бы и в приложение пользователя.
   */
  app.post("/api/projects/:id/preview/ticket",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    const baseUrl=deps.publicUrl(p.id);
    if(!baseUrl)return reply.code(400).send({error:"Публичные адреса предпросмотра не настроены: задайте PREVIEW_PUBLIC_DOMAIN (docs/PRODUCTION_DEPLOYMENT.md)"});
    const ticket=deps.mintTicket(p.id);
    return reply.send({baseUrl,url:previewTicketUrl(baseUrl,ticket),expiresAt:Date.now()+deps.ticketTtlMs(),param:PREVIEW_TICKET_PARAM});
  });
  /**
   * Ответ на вопрос реверс-прокси, можно ли выдать сертификат на это имя (Caddy: `on_demand_tls
   * { ask … }`). 200 — имя принадлежит проекту на этом хосте, 404 — всё остальное, включая
   * собственный домен предпросмотра и любой чужой поддомен. Без этой проверки подстановочная
   * DNS-запись `*.preview…` позволяла бы любому запросить сертификат Let's Encrypt на
   * произвольное имя, а лимит выдачи на домен исчерпывался бы чужими запросами.
   */
  app.get("/api/preview/tls-ask",async(request,reply)=>{
    const parsed=z.object({domain:z.string().min(1).max(255)}).safeParse(request.query);
    if(!parsed.success)return reply.code(400).send({error:"Не передан параметр domain"});
    const projectId=deps.hostTarget(parsed.data.domain);
    if(!projectId)return reply.code(404).send({error:"Этот адрес не обслуживает предпросмотр"});
    if(!await deps.projectExists(projectId))return reply.code(404).send({error:"Проект не найден"});
    return reply.send({allowed:true,host:parsed.data.domain});
  });
  app.get("/api/projects/:id/preview/logs",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    return previewReply(reply,()=>deps.previewLogs(p.id));
  });
  // The panel's heartbeat: an open, visible preview keeps its container, a closed tab lets it
  // stop after PREVIEW_IDLE_MS. Deliberately cheap — no Docker call, only the last-use mark.
  app.post("/api/projects/:id/preview/touch",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    return reply.send({ok:deps.touchPreview(p.id)});
  });
  // Без слэша в конце относительные ссылки приложения ("style.css", "app.js") разрешаются на
  // уровень выше — в платформенный обработчик, который отвечает JSON-404. Браузер тогда отказывается
  // применять стили и скрипты ("MIME type application/json"), а страница выглядит сломанной.
  // Поэтому вход без слэша всегда переводится на канонический адрес со слэшем.
  app.get("/api/projects/:id/preview/open",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    if(previewPathClosed(deps,p.id))return reply.code(503).send({error:PREVIEW_PATH_CLOSED_MESSAGE});
    return reply.code(302).redirect(previewProxyBase(p.id));
  });
  // Все методы, а не только GET: приложение внутри кадра шлёт и POST (свой API, `fetch`), и такие
  // запросы раньше попадали в платформенный обработчик — в JSON-404, из-за которого приложение в
  // панели выглядит сломанным (на прямой адрес те же запросы уходили бы к самому приложению).
  // Тело доходит для типов, которые Fastify разбирает сам (JSON и текст);`multipart/form-data` и
  // form-urlencoded он отвергает до маршрута, и это отдельный шаг — общий разборщик тела.
  app.all("/api/projects/:id/preview/open/*",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    if(previewPathClosed(deps,p.id))return reply.code(503).send({error:PREVIEW_PATH_CLOSED_MESSAGE});
    const params=request.params as {id:string;"*":string};
    const incoming=new URL(request.raw.url??"/","http://webnestdev.local");
    return previewReply(reply,()=>proxyPreviewRequest(door,{
      projectId:p.id,
      path:"/"+(params["*"]||"")+(incoming.search||""),
      method:request.method,
      headers:request.headers,
      body:previewRequestBody(request),
      // Приложение живёт не в корне этого адреса, поэтому его корневые ссылки переписываются
      // на префикс прокси (см. preview/preview-rewrite.ts).
      rewriteBase:previewProxyBase(p.id),
    }));
  });

  /**
   * A preview failure is a diagnostic the panel and the agent both need ("нужен package.json",
   * "Docker недоступен"), so the reason travels to the caller instead of the generic
   * "Внутренняя ошибка сервера" the global handler would produce.
   */
  async function previewReply(reply:FastifyReply,action:()=>Promise<unknown>){
    try{
      return reply.send(await action());
    }catch(error){
      return reply.code(400).send({error:error instanceof Error?error.message:String(error)});
    }
  }
}
