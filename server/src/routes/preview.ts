import type { FastifyInstance,FastifyReply } from "fastify";
import { z } from "zod";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { startPreview,stopPreview,previewStatus,previewLogs } from "../preview-manager.js";
import { canRewritePreviewBody,previewProxyBase,rewritePreviewBody } from "../preview/preview-rewrite.js";
import { execFetchPreview, type ExecFetchResult } from "../preview/exec-proxy.js";
import { setPreviewExecOnly, touchPreview as touchPreviewStore, unsettlePreview } from "../preview/preview-store.js";

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
  /**
   * Вторая дверь к приложению — запрос изнутри его контейнера (`docker exec`). Взята как
   * параметр, как и остальные соучастники: путь прокси проверяется тестом без Docker.
   */
  execPreview:(input:{containerId:string;port:number;path:string;method:string;headers:Record<string,string>;body?:Buffer;timeoutMs:number})=>Promise<ExecFetchResult|null>;
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
  execPreview:execFetchPreview,
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
  // Все методы, а не только GET: приложение внутри кадра шлёт и POST (свой API, `fetch`), и такие
  // запросы раньше попадали в платформенный обработчик — в JSON-404, из-за которого приложение в
  // панели выглядит сломанным (на прямой адрес те же запросы уходили бы к самому приложению).
  // Тело доходит для типов, которые Fastify разбирает сам (JSON и текст);`multipart/form-data` и
  // form-urlencoded он отвергает до маршрута, и это отдельный шаг — общий разборщик тела.
  app.all("/api/projects/:id/preview/open/*",async(request,reply)=>{
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
  async function proxyPreview(request:PreviewProxyRequest,projectId:string,suffix:string){
    const state=await deps.previewStatus(projectId);
    if(!state.running)throw new Error("Предпросмотр не запущен");
    const incoming=new URL(request.raw.url??"/","http://webnestdev.local");
    const host=state.host||process.env.PREVIEW_PROXY_HOST||"127.0.0.1";
    const path="/"+suffix+(incoming.search||"");
    const timeoutMs=previewProxyTimeoutMs();
    // Прямой путь первым: он отдаёт ответ потоком и работает с websocket живого HMR. Если адрес
    // контейнера уже помечен недоступным (execOnly), попытка не повторяется — иначе каждый файл
    // приложения платил бы за заведомо неудачное соединение.
    let directError:unknown=null;
    if(!state.viaExec){
      try{
        // Ограниченный запрос: иначе неотвечающее приложение висит до таймаута самого сервера, а панель
        // всё это время показывает пустой белый кадр без причины (см. previewProxyTimeoutMs).
        const upstream=await fetch("http://"+host+":"+state.port+path,{redirect:"manual",signal:AbortSignal.timeout(timeoutMs)});
        const contentType=upstream.headers.get("content-type");
        const headers=sanitizedPreviewHeaders(upstream.headers);
        return !contentType||!canRewritePreviewBody(contentType)
          ? new Response(Buffer.from(await upstream.arrayBuffer()),{status:upstream.status,headers})
          : new Response(rewritePreviewBody(await upstream.text(),previewProxyBase(projectId),contentType),{status:upstream.status,headers});
      }catch(error){directError=error}
    }
    // Вторая дверь: адрес контейнера серверу недоступен (Docker изолирует bridge-сети друг от друга),
    // но приложение живо и отвечает внутри своего контейнера — тем же путём, каким платформа
    // проверяет его готовность. Без этого живой предпросмотр оставался в панели белым кадром.
    const viaExec=await deps.execPreview({
      containerId:state.containerId,
      port:state.port,
      path,
      method:request.method??"GET",
      headers:forwardedPreviewHeaders(request.headers),
      body:previewRequestBody(request),
      timeoutMs,
    }).catch(()=>null);
    if(viaExec){
      // Прямой адрес только что не ответил: подтверждение снимается, чтобы статус не показывал
      // «settled» у адреса, до которого панель больше не доходит (подтвердит заново проверка).
      unsettlePreview(projectId);
      setPreviewExecOnly(projectId,true);
      const headers=sanitizedPreviewHeaders(new Headers(viaExec.headers));
      const contentType=viaExec.headers["content-type"]??null;
      return !contentType||!canRewritePreviewBody(contentType)
        // `Uint8Array.from` не только копирует: он даёт буфер, пригодный для тела ответа (Buffer из
        // другого модуля шире, чем ожидает Response).
        ? new Response(Uint8Array.from(viaExec.body),{status:viaExec.status,headers})
        : new Response(rewritePreviewBody(viaExec.body.toString("utf8"),previewProxyBase(projectId),contentType),{status:viaExec.status,headers});
    }
    // Обе двери закрыты: подтверждение адреса снимается (прокси — первый, кто видит, что
    // подтверждённый адрес перестал работать), и следующая проверка статуса сводит адрес заново.
    unsettlePreview(projectId);
    // Оба пути названы в одной строке: «fetch failed» без второй попытки не говорит, что делать,
    // а она уже сделана — приложение не ответило ни по адресу контейнера, ни внутри него.
    const reason=directError
      ? describeProxyFailure(directError,host,state.port,timeoutMs)
      : "адрес "+host+":"+state.port+" недоступен";
    throw new Error("Прокси предпросмотра не сработал: "+reason+" — и внутри контейнера приложение тоже не ответило. Посмотрите логи предпросмотра (logs)");
  }
}

type PreviewProxyRequest={
  method?:string;
  body?:unknown;
  headers?:Record<string,string|string[]|undefined>;
  raw:{url?:string};
};

/**
 * Служебные заголовки не пересылаются в обе стороны: соединение до приложения закрывается на
 * сервере, тело перекодируется, а кадровые запреты приложения убираются — их ставит сама платформа.
 */
const HOP_BY_HOP_HEADERS=new Set(["host","connection","content-length","transfer-encoding","keep-alive","upgrade","te","trailer","accept-encoding","proxy-authorization","proxy-connection"]);

function sanitizedPreviewHeaders(source:Headers){
  const headers=new Headers(source);
  for(const name of HOP_BY_HOP_HEADERS)headers.delete(name);
  headers.delete("x-frame-options");
  headers.delete("content-security-policy");
  return headers;
}

/** Заголовки запроса панели, пригодные для повторения внутри контейнера. */
export function forwardedPreviewHeaders(source:Record<string,string|string[]|undefined>|undefined){
  const headers:Record<string,string>={};
  for(const [name,value] of Object.entries(source??{})){
    if(value===undefined||HOP_BY_HOP_HEADERS.has(name.toLowerCase()))continue;
    headers[name]=Array.isArray(value)?value.join(", "):String(value);
  }
  return headers;
}

/**
 * Тело запроса для второй двери. Fastify уже разобрал то, что знает (JSON и текст), поэтому
 * разобранное значение возвращается обратно в байты: страница приложения получает тот же запрос,
 * что и по прямому пути.
 */
export function previewRequestBody(request:{method?:string;body?:unknown}){
  const method=(request.method??"GET").toUpperCase();
  if(method==="GET"||method==="HEAD")return undefined;
  const body=request.body;
  if(body===undefined||body===null)return undefined;
  if(Buffer.isBuffer(body))return body;
  if(typeof body==="string")return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}
