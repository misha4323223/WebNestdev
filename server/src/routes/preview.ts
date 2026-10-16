import type { FastifyInstance,FastifyReply } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { startPreview,stopPreview,previewStatus,previewLogs } from "../preview-manager.js";
import { canRewritePreviewBody,previewProxyBase,rewritePreviewBody } from "../preview/preview-rewrite.js";
import { touchPreview as touchPreviewStore, unsettlePreview } from "../preview/preview-store.js";

/**
 * The routes take their collaborators as a parameter (the same way the agent WebSocket takes
 * its runtime), so the proxy can be exercised in tests without a Docker daemon and without
 * an authenticated session.
 */
/**
 * Сколько ждать ответа приложения на проксированный запрос.
 *
 * Без ограничения подвисший запрос приложения держит кадр панели белым до общего таймаута запроса
 * (две минуты), и пользователь видит «ничего» вместо причины: именно так выглядит белый экран
 * предпросмотра. Бюджет в 30 с — это медленный первый рендер dev-сервера, а не «никогда»;
 * `PREVIEW_PROXY_TIMEOUT_MS` меняет его в обе стороны.
 */
export function previewProxyTimeoutMs(){
  const raw=Number(process.env.PREVIEW_PROXY_TIMEOUT_MS);
  return Number.isFinite(raw)&&raw>=100?Math.floor(raw):30_000;
}

/**
 * Причина отказа словами. «Не ответил за N секунд» и «соединение отвергнуто» — разные диагнозы: в первом
 * случае приложение живо внутри контейнера, но недоступно снаружи (сеть/петля), во втором — на этом
 * порту никто не слушает (предпросмотр был поднят на другом порту или уже упал).
 */
export function describeProxyFailure(error:unknown,host:string,port:number,timeoutMs:number){
  const name=error instanceof Error?error.name:"";
  const detail=error instanceof Error?error.message:String(error);
  if(name==="TimeoutError"||name==="AbortError"){
    const seconds=Math.max(1,Math.round(timeoutMs/1000));
    return "адрес "+host+":"+port+" не ответил за "+seconds+" с: приложение запущено внутри контейнера, но снаружи недоступно. Обновите статус предпросмотра (платформа подключит контейнер к сети сервера или пробросит порт) и посмотрите логи предпросмотра";
  }
  return detail;
}

export type PreviewRouteDeps={
  /** Only truthiness matters: the real one returns the user or null (and sends the reply). */
  authorize:(request:unknown,reply:unknown,projectId:string)=>Promise<unknown>;
  getSandbox:(projectId:string)=>Promise<Parameters<typeof startPreview>[0]>;
  startPreview:typeof startPreview;
  stopPreview:typeof stopPreview;
  previewStatus:typeof previewStatus;
  previewLogs:typeof previewLogs;
  /** Last-use mark for the idle sweeper; only the panel's heartbeat calls it directly. */
  touchPreview:(projectId:string)=>boolean;
};

const defaultDeps:PreviewRouteDeps={
  authorize:async (request,reply,projectId)=>requireProjectUser(request as never,reply as never,projectId),
  getSandbox,
  startPreview,
  stopPreview,
  previewStatus,
  previewLogs,
  touchPreview:touchPreviewStore,
};

export async function registerPreviewRoutes(app:FastifyInstance,deps:PreviewRouteDeps=defaultDeps){
  app.post("/api/projects/:id/preview/start",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    return previewReply(reply,async()=>deps.startPreview(await deps.getSandbox(p.id)));
  });
  app.post("/api/projects/:id/preview/stop",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    return previewReply(reply,()=>deps.stopPreview(p.id));
  });
  app.get("/api/projects/:id/preview/status",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    return previewReply(reply,()=>deps.previewStatus(p.id));
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
    return reply.code(302).redirect(previewProxyBase(p.id));
  });
  app.get("/api/projects/:id/preview/open/*",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    if(!await deps.authorize(request,reply,p.id))return;
    const params=request.params as {id:string;"*":string};
    return previewReply(reply,()=>proxyPreview(request,p.id,params["*"]||""));
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

  /**
   * The framed app is served from this origin, so its own root-absolute URLs (assets, HMR
   * client, framework chunks) would ask WebNestdev instead of the app. Text bodies are
   * rewritten onto the proxy prefix; anything binary goes through untouched. The app's own
   * X-Frame-Options and CSP are dropped: our own header allows the frame, the app must not
   * forbid it.
   */
  async function proxyPreview(request:{raw:{url?:string}},projectId:string,suffix:string){
    const state=await deps.previewStatus(projectId);
    if(!state.running)throw new Error("Предпросмотр не запущен");
    const incoming=new URL(request.raw.url??"/","http://webnestdev.local");
    const host=state.host||process.env.PREVIEW_PROXY_HOST||"127.0.0.1";
    const target="http://"+host+":"+state.port+"/"+suffix+(incoming.search||"");
    const timeoutMs=previewProxyTimeoutMs();
    try{
      // Ограниченный запрос: иначе неотвечающее приложение висит до таймаута самого сервера, а панель
      // всё это время показывает пустой белый кадр без причины (см. previewProxyTimeoutMs).
      const upstream=await fetch(target,{redirect:"manual",signal:AbortSignal.timeout(timeoutMs)});
      const headers=new Headers(upstream.headers);
      headers.delete("connection");
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("x-frame-options");
      headers.delete("content-security-policy");
      const contentType=upstream.headers.get("content-type");
      if(!contentType||!canRewritePreviewBody(contentType)){
        return new Response(await upstream.arrayBuffer(),{status:upstream.status,headers});
      }
      const body=rewritePreviewBody(await upstream.text(),previewProxyBase(projectId),contentType);
      return new Response(body,{status:upstream.status,headers});
    }catch(error){
      // Прокси — первый, кто видит, что подтверждённый адрес перестал работать (dev-сервер
      // перезапустился на другом порту после правки конфига): подтверждение снимается, и
      // следующая проверка статуса сводит адрес заново.
      unsettlePreview(projectId);
      throw new Error("Прокси предпросмотра не сработал: "+describeProxyFailure(error,host,state.port,timeoutMs));
    }
  }
}
