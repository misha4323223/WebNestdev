import type { FastifyInstance } from "fastify";
import { sandboxStatus } from "../docker-sandbox.js";
import { isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { runQueueStats } from "../agent/run-limiter.js";
import { sandboxQueueStats } from "../sandbox/sandbox-limiter.js";
import { browserQueueStats } from "../tools/browser-limiter.js";
import { liveRuntimePreviews, liveStaticPreviews, perUserPreviewLimit, runtimePreviewLimit } from "../preview/preview-limiter.js";
import { previewAddresses } from "../preview/preview-store.js";
import { previewPublicDomain } from "../preview/preview-host.js";
import { execProxyQueueStats } from "../preview/exec-proxy.js";
import { DEFAULT_CHARS_PER_TOKEN,contextBudgetTokens,contextMaxMessages } from "../agent/context-budget.js";
import { sandboxHostRootDir,sandboxRootDir,sandboxRuntime } from "../sandbox/config.js";
import { lastSandboxMountCheck } from "../sandbox/sandbox-check.js";
import { diskStatus, memoryStatus } from "../health/host-metrics.js";
import { smsReadiness, smsSummary } from "../auth/sms.js";
import { supportKeyStatus } from "../support/support-api-key.js";
import { mailSettings, mailSettingsSource } from "../mail/mailer.js";
import { postboxConfig, postboxCredentialSummary } from "../mail/postbox.js";
import { lastMailFailure } from "../mail/mail-health.js";
import { archiveStats } from "../storage/archive-health.js";
import { getPlatformEnv, platformEnvSetByPanel } from "../platform/platform-env.js";
import { normalizeAddress } from "../security/client-ip.js";
import type { FastifyRequest } from "fastify";

/**
 * Какая сборка работает на сервере. Значение запекается в образ при выкатке
 * (WEBNESTDEV_BUILD передаёт workflow), и это единственный честный ответ на вопрос,
 * который иначе превращается в догадки: та ли версия сейчас в проде, которую только
 * что выкатили, или ВМ осталась на предыдущей. Браузер с закешированным документом
 * тоже проверяется по этому числу — если оно новое, а вид старый, дело в кеше,
 * а не в выкатке.
 */
function buildId() {
  return process.env.WEBNESTDEV_BUILD?.trim() || "dev";
}

async function dependencyStatus(){
  const sandbox=await sandboxStatus();
  const mode: "json"|"ydb"|"postgres" = isYdbEnabled() ? "postgres" : "json";
  let storage:{mode:string;ok:boolean}={mode,ok:true};
  if(isYdbEnabled()){
    try{await ydbQuery()`SELECT 1 AS ok`;}catch{storage={mode,ok:false};}
  }
  return {
    storage,
    // Пути и последняя проверка монтирования. Без них расхождение «сервер пишет в один
    // каталог, контейнеры монтируют другой» выглядит как жалоба агента на пропавшие файлы,
    // а не как ошибка выкатки с понятным исправлением.
    sandbox:{...sandbox,runtime:sandboxRuntime(),sandboxDir:sandboxRootDir(),sandboxHostDir:sandboxHostRootDir(),mount:lastSandboxMountCheck()},
  };
}

/**
 * What the host is doing right now — the same numbers the launch checklist tells an operator to
 * watch, in one place, so nobody has to guess why a preview or a run is waiting:
 *
 * - the three queues (conversations, sandbox containers, Chromium) with what is running, what is
 *   waiting and what the limit is;
 * - how many previews are alive per kind, because a static preview is a listener (~0.5 MB) and a
 *   runtime preview is a container, and only the second one has a cap;
 * - disk and memory, because those are what actually run out first.
 */
async function activity(){
  return {
    // После этапа 2.2 сервер должен работать не от uid 0. Значение читается из процесса, а не
    // из переменной окружения: именно оно отвечает, сбросил ли entrypoint права на самом деле.
    process: {
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
    },
    runs: runQueueStats(),
    sandbox: sandboxQueueStats(),
    browser: browserQueueStats(),
    previews: {
      runtime: liveRuntimePreviews().length,
      // Сколько контейнерных предпросмотров разрешено одному аккаунту: это правило продукта.
      runtimePerUser: perUserPreviewLimit(),
      // Предохранитель на весь хост; 0 — не задан (см. preview/preview-limiter.ts).
      runtimeLimit: runtimePreviewLimit(),
      static: liveStaticPreviews().length,
      // Адреса живых предпросмотров: `settled` — этот адрес подтверждён запросом самого сервера,
      // то есть приложение видно и панели, и Chromium. `settled: false` у работающего предпросмотра
      // — это ответ на «предпросмотр запущен, а в панели белый экран», который иначе искали бы
      // только на ВМ (см. preview/preview-address.ts).
      addresses: previewAddresses(),
      // Очередь второй двери к приложению (`docker exec`): она включается только тогда, когда
      // адрес контейнера серверу недоступен, и без этих чисел «предпросмотр стал медленным»
      // выглядело бы как непонятное замедление, а не как исчерпанный предел (preview/exec-proxy.ts).
      exec: execProxyQueueStats(),
      // Публичный домен предпросмотра: пусто — адресов `<проект>.<домен>` на этом хосте нет,
      // и панель показывает приложение только своим путём (PREVIEW_PUBLIC_DOMAIN).
      publicDomain: previewPublicDomain(),
    },
    // Сколько контекста уходит модели за один шаг: без этого числа отказ провайдера по размеру
    // промпта выглядит необъяснимым (agent/context-budget.ts).
    // `charsPerTokenDefault` — стартовая оценка: во время запуска она уточняется по отчёту
    // провайдера (см. `run.progress.tokens`), поэтому здесь честно только значение по умолчанию.
    context: { budgetTokens: contextBudgetTokens(), maxMessages: contextMaxMessages(), charsPerTokenDefault: DEFAULT_CHARS_PER_TOKEN },
    // Холодный ярус: сколько проектов он освободил с запуска, сколько было ошибок и что
    // показал последний проход. По этим числам видно, работает ли архивация по давлению,
    // не читая логи и не заходя на ВМ.
    archive: archiveStats(),
    disk: await diskStatus(sandboxRootDir()),
    memory: await memoryStatus(),
  };
}

/**
 * Состояние SMS для /api/health: провайдер, тестовый режим, способ аутентификации и —
 * главное — читается ли выбранный ключ. Без последнего «ключ задан» было неотличимо от
 * «ключ не читается», и об этом узнавали только по отказу отправки.
 */
async function smsInfo(){
  const readiness=await smsReadiness();
  return {
    ...smsSummary(),
    ready:readiness.ready,
    // Каким путём прочитан ключ сервисного аккаунта: /app/… в переменной и файл в каталоге
    // секретов — разные вещи, и именно это различие решает, уходят SMS или нет.
    ...(readiness.keyFile===undefined?{}:{keyFile:readiness.keyFile}),
    ...(readiness.note===undefined?{}:{note:readiness.note}),
    ...(readiness.problem===undefined?{}:{problem:readiness.problem}),
  };
}

/**
 * Состояние почты: чем подписывается письмо, откуда взят ключ и что сервис ответил в последний раз.
 *
 * Без этого блока разбор «ответ из админки не уходит» начинался с чтения `.env` на ВМ: снаружи
 * неотличимы «ключ не задан», «ключ SMTP вместо ключа рассылки» и «сервис отказал». Токен возраста
 * здесь нет там, где его не знает никто (готовый `POSTBOX_IAM_TOKEN`), — лучше `null`, чем число,
 * которое ничего не значит.
 */
function mailInfo(){
  const settings=mailSettings();
  const source=mailSettingsSource();
  const credential=postboxCredentialSummary();
  const campaigns=postboxConfig();
  const campaignsReady=Boolean(campaigns.auth)||credential.kind==="metadata";
  const sender=settings?.from ?? (campaigns.sender || null);
  // Значение из панели важнее .env выкатки, поэтому при замене переменной в GitHub ответ
  // «почему адрес прежний» лежит здесь, а не в логах деплоя.
  const senderKey=source==="MAIL_SMTP" ? "MAIL_FROM" : "POSTBOX_SENDER";
  return {
    provider:"postbox" as const,
    sender,
    senderSource:sender ? (platformEnvSetByPanel(senderKey) ? "panel" : "environment") : null,
    // Домен вместо адреса (`nestdev.ru` вместо `mail@nestdev.ru`) — это 550 на шаге from,
    // и по одному виду значения это видно раньше, чем по отказу отправки.
    senderIsAddress:sender ? sender.includes("@") : null,
    // Чем реально уходят письма поддержки и оплаты. Вид и источник описывают одно и то же:
    // раньше здесь могли оказаться ключ писем и ключ рассылки вперемешку, и поле врало именно
    // в том разборе, для которого сделано. Ключ рассылки — в `campaigns.credentialKind`.
    credentialKind:source==="MAIL_SMTP" ? "smtp-credentials" : source==="POSTBOX_KEY" ? "smtp-key" : "none",
    credentialSource:source ?? null,
    // Каталог, в котором создан сервисный аккаунт: его не хватает в разборе «403 от Postbox».
    folderId:(getPlatformEnv("YANDEX_FOLDER_ID") ?? "").trim() || null,
    tokenAgeSeconds:credential.tokenAgeSeconds,
    ready:Boolean(settings),
    campaigns:{
      configured:campaignsReady,
      credentialKind:credential.kind,
      ...(campaignsReady?{}:{reason:"нет ключа рассылки: нужен POSTBOX_IAM_TOKEN, POSTBOX_STATIC_KEY_ID и POSTBOX_STATIC_SECRET или ключ сервисного аккаунта. POSTBOX_KEY_ID и POSTBOX_SECRET — ключ SMTP, для REST он не годится"}),
    },
    lastError:lastMailFailure(),
  };
}

/**
 * Подробности health нужны оператору и health-check на самой ВМ, а не посетителю сайта.
 * Публичный ответ через Caddy не должен показывать абсолютные пути песочниц, очереди и
 * адреса предпросмотров: это карта внутреннего устройства. Считаем запрос внутренним, только
 * если он пришёл напрямую на loopback (health-check контейнера или `docker compose exec`).
 */
function isInternalHealthRequest(request:FastifyRequest){
  const address=normalizeAddress(request.raw.socket.remoteAddress);
  return address==="127.0.0.1"||address==="::1";
}

export async function registerHealthRoutes(app:FastifyInstance){
  app.get("/api/health",async request=>{
    // Настроен ли ключ чтения обращений и откуда он взят — без самого значения. Это отличает
    // «ключ не сохранён» от «сохранён в панели, но запрос попал в процесс без него».
    const support = supportKeyStatus();
    if(!isInternalHealthRequest(request)){
      return {ok:true,service:"webnestdev-server",build:buildId(),sms:await smsInfo(),mail:mailInfo(),support};
    }
    return {
      ok:true,
      service:"webnestdev-server",
      build:buildId(),
      ...(await dependencyStatus()),
      // Настроен ли вход по SMS на самом деле: провайдер по имени и способ аутентификации.
      // Секретов здесь нет, зато «SMS перестали приходить» проверяется одной командой
      // curl localhost:8787/api/health вместо чтения .env на ВМ.
      sms:await smsInfo(),
      // Почта: откуда ключ, чем подписывается письмо и что ответил сервис в последний раз.
      mail:mailInfo(),
      support,
      activity:await activity(),
    };
  });
  //
  // Только номер сборки и ничего больше: открытая вкладка панели спрашивает его, чтобы понять,
  // не устарела ли она после выкатки (см. src/lib/app-build.ts). Поэтому здесь нет ни Docker, ни
  // базы, ни метрик — проверка идёт с каждой вкладки раз в пару минут и должна стоить почти ноль.
  //
  app.get("/api/version",async()=>({ok:true,build:buildId()}));
  app.get("/api/ready",async(request,reply)=>{
    const dependencies=await dependencyStatus();
    // Расхождение путей песочницы — не временная неисправность хоста, а сломанная выкатка:
    // агент пишет файлы, которых не видит терминал. Готовность обязана об этом сказать.
    const ok=dependencies.storage.ok && dependencies.sandbox.available && dependencies.sandbox.mount?.reason!=="mismatch";
    if(!isInternalHealthRequest(request)){
      return reply.code(ok?200:503).send({ok,service:"webnestdev-server",build:buildId()});
    }
    return reply.code(ok?200:503).send({ok,service:"webnestdev-server",build:buildId(),...dependencies,sms:await smsInfo(),activity:await activity()});
  });
  app.get("/api/sandbox/status",async()=>sandboxStatus());
}
