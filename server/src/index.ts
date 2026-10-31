import Fastify from "fastify";
import { ZodError } from "zod";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeStorage, closeStorage, describeStorage, assertStorageConfigured } from "./storage/ydb.js";
import { reapOrphanPreviews, reapRemotePreviews } from "./preview-manager.js";
import { startPreviewSweeper } from "./preview/idle-sweep.js";
import { describePreviewMode } from "./preview/static-preview.js";
import { describePreviewHostServer, startPreviewHostServer, stopPreviewHostServer } from "./preview/preview-host-server.js";
import { describePreviewLimits } from "./preview/preview-limiter.js";
import { describeRunLimiter } from "./agent/run-limiter.js";
import { describeContextBudget } from "./agent/context-budget.js";
import { describeProviderRetry } from "./provider/provider-retry.js";
import { describeFreeModelRoute } from "./provider/free-model.js";
import { describeImageGeneration } from "./provider/image-generation.js";
import { describeSandboxLimiter } from "./sandbox/sandbox-limiter.js";
import { cleanupSandboxJobs } from "./sandbox/jobs.js";
import { describeWebSearch } from "./web/search.js";
import { assertEncryptionConfigured } from "./storage/secret-crypto.js";
import { describeTrustProxy, trustProxyOption } from "./security/client-ip.js";
import { registerSameOriginGuard } from "./security/same-origin.js";
import { registerSecurityHeaders } from "./security/headers.js";
import { describeSandboxPaths, describeSandboxRuntime, sandboxRuntime } from "./sandbox/config.js";
import { initializeNodeRegistry, stopNodeHeartbeat } from "./nodes/local-node.js";
import { stopRemoteNodeHeartbeat } from "./nodes/remote-heartbeat.js";
import { NoSandboxNodeError } from "./nodes/placement.js";
import { SandboxNodeUnavailableError, SharedWorkspaceRequiredError } from "./sandbox/host.js";
import { configureDockerEndpoint, describeDockerEndpoint } from "./sandbox/docker/endpoint.js";
import { describeSandboxMount,verifySandboxMount } from "./sandbox/sandbox-check.js";
import { ensureDataDir } from "./project-store.js";
import { clearAllPreviewSecrets } from "./secrets/preview-secrets.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPanelFiles } from "./routes/panel-static.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerThemeRoutes } from "./routes/theme.js";
import { registerAgentWebSocket } from "./routes/agent-ws.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerGitHubRoutes } from "./routes/github.js";
import { registerGitLabRoutes } from "./routes/gitlab.js";
import { registerRepoRoutes } from "./repos/routes.js";
import { REPO_PROVIDERS } from "./repos/index.js";
import { registerYandexRoutes } from "./routes/yandex.js";
import { registerDatabaseRoutes } from "./routes/database.js";
import { registerCloudRoutes } from "./routes/cloud.js";
import { registerDomainRoutes } from "./routes/domains.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerSecretRoutes } from "./routes/secrets.js";
import { registerAccessRoutes } from "./routes/access.js";
import { registerDeploymentRoutes } from "./routes/deployment.js";
import { registerQuestionRoutes } from "./routes/questions.js";
import { registerChangesRoutes } from "./routes/changes.js";
import { registerTasksRoutes } from "./routes/tasks.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAdminAnalyticsRoutes } from "./routes/admin-analytics.js";
import { registerAdminEconomicsRoutes } from "./routes/admin-economics.js";
import { registerAdminAuditRoutes } from "./routes/admin-audit.js";
import { registerAdminInfraRoutes } from "./routes/admin-infra.js";
import { registerAdminNodeRoutes } from "./routes/admin-nodes.js";
import { registerAdminPruneRoutes } from "./routes/admin-prune.js";
import { registerAdminMailRoutes } from "./routes/admin-mail.js";
import { registerAdminUserActionRoutes } from "./routes/admin-users.js";
import { registerAdminBillingRoutes } from "./routes/admin-billing.js";
import { registerAdminPlanRoutes } from "./routes/admin-plans.js";
import { registerAdminProjectRoutes } from "./routes/admin-projects.js";
import { registerUnsubscribeRoutes } from "./routes/unsubscribe.js";
import { describePostbox, postboxStatus } from "./mail/postbox.js";
import { startMailQueue, stopMailQueue } from "./mail/queue.js";
import { registerPhoneAuthRoutes } from "./routes/phone-auth.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerSupportRoutes } from "./routes/support.js";
import { registerDonationRoutes } from "./routes/donations.js";
import { startBillingSweeper, stopBillingSweeper } from "./billing/recurring.js";
import { startStorageReconcileScheduler } from "./account/storage-scheduler.js";
import { describeObjectStore } from "./storage/object-store.js";
import { startProjectArchiveScheduler } from "./storage/archive-scheduler.js";
import { ProjectRestoreFailedError, ProjectRestoringError } from "./storage/restore-jobs.js";
import { importArchiveRecordsFromDisk } from "./storage/project-archive-state.js";
import { startAlertScheduler } from "./health/alerts.js";
import { describeBilling, robokassaConfig } from "./billing/robokassa.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { registerPlatformPlanRoutes } from "./routes/platform-plans.js";
import { loadPlatformEnv } from "./platform/platform-env.js";
import { ensureDemoUser } from "./auth/auth-store.js";
import { ensureBootstrapAdmin } from "./admin/bootstrap.js";
import "./tools/project-tools.js";
import "./tools/filesystem-tools.js";
import "./tools/terminal-tools.js";
import "./tools/git-tools.js";
import "./tools/preview-tools.js";
import "./tools/browser-tools.js";
import "./tools/screenshot-tools.js";
import "./tools/verification-tools.js";
import "./tools/note-tools.js";
import "./tools/history-tools.js";
import "./tools/plan-tools.js";
import "./tools/yandex-tools.js";
import "./tools/cloud-tools.js";
import "./tools/domain-tools.js";
import "./tools/service-tools.js";
import "./tools/expo-tools.js";
import "./tools/database-tools.js";
import "./tools/deploy-tools.js";
import "./tools/deploy-check.js";
import "./tools/access-tools.js";
import "./tools/secret-tools.js";
import "./tools/question-tools.js";
import "./tools/web-tools.js";
import "./tools/net-tools.js";
import "./tools/python-tools.js";
import "./tools/design-tools.js";
import "./tools/image-tools.js";

// Неизвестный бэкенд или postgres без DATABASE_URL — ошибка конфигурации, а не повод молча
// работать на JSON-файлах: иначе данные «теряются» при первом же переезде.
assertStorageConfigured();
assertEncryptionConfigured();
// Опечатка в SANDBOX_RUNTIME должна остановить старт, а не оставить контейнеры на runc, пока
// оператор считает, что включён gVisor.
sandboxRuntime();
// Адрес Docker выбирается до первого вызова `docker`: контейнер брокера поднимается вместе с
// сервером, и без ожидания первый `docker run` ушёл бы в закрытый сокет. Если брокера нет,
// функция снимает DOCKER_HOST; в контейнере прямого сокета нет, поэтому API поднимается без
// песочниц и превью, а не с неверным адресом.
await configureDockerEndpoint();

// Адрес клиента: порт приложения наружу не публикуется, поэтому без доверия к Caddy все клиенты
// выглядели бы одним адресом и делили один счётчик попыток входа. Список прокси — из окружения,
// по умолчанию только loopback (см. security/client-ip.ts).
const app=Fastify({logger:true,bodyLimit:2_000_000,requestTimeout:120_000,trustProxy:trustProxyOption()});
console.log("[security] " + describeTrustProxy());
const production = process.env.NODE_ENV === "production";
const configuredOrigins = process.env.WEBNESTDEV_ALLOWED_ORIGINS;
if (production && !configuredOrigins) throw new Error("В production обязательна переменная WEBNESTDEV_ALLOWED_ORIGINS");
const allowedOrigins = (configuredOrigins ?? "").split(",").map(value => value.trim()).filter(Boolean);
// Админ-приложение живёт на своём источнике, поэтому его адрес добавляется отдельным списком.
// Маршруты /api/admin/* не читают cookie (вход по Bearer-токену), так что расширение CORS не даёт
// чужой странице приложить пользовательский вход и не отдаёт ей данные панели.
const adminOrigins = (process.env.WEBNESTDEV_ADMIN_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
for (const origin of adminOrigins) {
  if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
}
if (production && allowedOrigins.some(origin => /^https?:\/\/localhost(?::\d+)?$/i.test(origin))) {
  throw new Error("В production в WEBNESTDEV_ALLOWED_ORIGINS нельзя указывать localhost");
}
await ensureDataDir();
// Временные env-файлы предпросмотра — открытый текст на диске. После падения процесса они
// остаются в каталоге песочниц; старт обязан их убрать, пока не поднялся ни один предпросмотр.
// На общем Docker-хосте с несколькими репликами `PREVIEW_REAP_ON_START=0` выключает и это:
// иначе старт одной реплики удалял бы файлы предпросмотров, которые ведёт другая.
if (process.env.PREVIEW_REAP_ON_START !== "0") await clearAllPreviewSecrets();
// Ключи платформы (GitHub OAuth, Yandex Cloud, SMS, модель платформы), введённые в панели,
// читаются один раз при старте: файл шифрован тем же ключом, что и секреты проектов.
await loadPlatformEnv();
// The live backend is printed once at startup: it is the first thing to check when an
// account, a conversation or an integration seems to have disappeared.
console.log("[storage] " + describeStorage());
// Холодный ярус проектов: настроен ли бакет и включена ли архивация. Без этой строки «диск
// кончается, а архивов нет» выглядит как поломка, хотя причина — незаданные PLATFORM_S3_*.
console.log("[storage] " + describeObjectStore());
// Which preview mode this host runs is the first thing to check when memory or a project's
// preview behaves unexpectedly (PREVIEW_MODE: auto | static | container).
console.log("[preview] " + describePreviewMode() + "; " + describePreviewLimits());
// Публичные адреса предпросмотра (`<проект>.preview.<домен>`): по какому адресу их отдаёт
// реверс-прокси и поднята ли дверь. Без этой строки «предпросмотр работает только в панели»
// выглядит как поведение по умолчанию, а не как незаданная переменная PREVIEW_PUBLIC_DOMAIN.
console.log("[preview] " + describePreviewHostServer());
// How many conversations this host runs in parallel (AGENT_MAX_CONCURRENT_RUNS) and how many
// containers they may start at once (SANDBOX_MAX_CONCURRENT). The second line is the memory
// one: a run is mostly waiting on the model, a container is what costs RAM.
console.log("[agent] " + describeRunLimiter());
// Сколько контекста сервер готов отправить модели за один шаг: именно это число (а не лимит
// провайдера) решает, дойдёт ли запрос вообще — см. agent/context-budget.ts.
console.log("[agent] " + describeContextBudget());
// Что делает отказ провайдера по лимиту частоты: шаг ждёт и повторяется, а запуск продолжается
// (provider-retry.ts). Без этой строки «агент вдруг думает дольше обычного» выглядит непонятно.
console.log("[agent] " + describeProviderRetry());
// Какая модель обслуживает бесплатный тариф и есть ли у неё резерв: без этой строки «на старте
// отвечает не то, что ожидали» выглядит как случайность, а не как незаданный PLATFORM_AI_FREE_*.
console.log("[agent] " + describeFreeModelRoute());
// Готова ли генерация картинок для проектов (инструмент image.generate): без этой строки «агент
// не смог нарисовать картинку» и «PLATFORM_IMAGE_* не заданы» выглядят одинаково.
console.log("[image] " + describeImageGeneration());
console.log("[sandbox] " + describeSandboxLimiter());
// Кто отвечает за поиск в интернете и настроен ли платный провайдер: без этой строки «поиск
// возвращает отказ» и «ключ Yandex не подхватился» выглядят одинаково.
console.log("[web] " + describeWebSearch());
// Настроена ли оплата и в каком режиме: без этой строки «кнопка оплаты не работает» и «ключи не
// сохранились» выглядят одинаково.
console.log("[billing] " + describeBilling());
// При НПД чек создаёт Робокасса через «Робочеки СМЗ», а не наша передача Receipt. Включённый
// флаг не ломает оплату, но чек может задвоиться или не сойтись с кассой, поэтому он заметен
// в логе, а не только в панели ключей.
if (robokassaConfig().receipt) console.warn("[billing] Receipt JSON включён: при НПД чеки формирует Робокасса («Робочеки СМЗ»), проверьте, что Receipt действительно нужен");
// Настроена ли рассылка через Postbox и с какими пределами: проверка идёт в фоне, потому что
// без ключа она ждёт метаданные ВМ, а старт сервера ждать этого не должен.
void postboxStatus()
  .then(status => console.log("[mail] " + describePostbox(status)))
  .catch(error => console.warn("[mail] состояние рассылки не проверено: " + (error instanceof Error ? error.message : error)));
// Каталог песочниц у сервера и у docker — разные вещи: контейнеры проектов монтируют путь,
// который демон разбирает на хосте. Оба печатаются при старте, чтобы расхождение было видно
// сразу, а не после того, как агент пожалуется на пустой терминал.
console.log("[sandbox] " + describeSandboxPaths());
console.log("[sandbox] " + describeSandboxRuntime());
console.log("[docker] " + describeDockerEndpoint());
// База инициализируется в фоне: DDL на «холодной» серверлесс-базе занимает 30–60 с.
// Если дождаться её здесь, app.listen() так и не выполнится (порт 8787 не поднимется,
// а healthcheck и клиенты не дождутся ответа). HTTP стартует сразу; DDL отрабатывает в фоне.
// Сверка размеров хранилища стартует после инициализации базы: она читает проекты и пишет
// размеры, а не поднимает сервер. Первый проход отложен, чтобы не спорить с контейнерами,
// которые поднимаются сразу после деплоя; дальше — раз в сутки (см. storage-scheduler.ts).
let stopStorageReconcile: (() => void) | null = null;
initializeStorage()
  .then(async () => {
    stopStorageReconcile = startStorageReconcileScheduler();
    // Отметки холодного яруса переезжают из JSON на хосте в таблицу. Импорт идемпотентен и
    // повторяется при каждом старте: файл, которого ещё нет в базе, будет перенесён. Ошибка
    // импорта не должна мешать серверу подняться — архивы и без неё читаются по старым файлам
    // в JSON-режиме, а в PostgreSQL просто не будет части отметок до следующего старта.
    try {
      await importArchiveRecordsFromDisk();
    } catch (error) {
      app.log.warn(
        { error: error instanceof Error ? error.message : error },
        "cold tier markers import skipped",
      );
    }
    // The local node is the first placement target and the source of the project-node backfill.
    // A failure here must not prevent the API from starting: the first project creation retries
    // registration, and a clear error is better than serving projects pinned to nowhere.
    try {
      const registry = await initializeNodeRegistry();
      app.log.info(
        { node: registry.node.id, backfilledProjects: registry.backfilledProjects },
        "node registry ready",
      );
    } catch (error) {
      app.log.warn(
        { error: error instanceof Error ? error.message : error },
        "node registry initialization skipped",
      );
    }
    // Первый администратор из окружения — путь для ВМ, где нет удобного терминала
    // (docs/ADMIN_API.md). Существующая запись не меняется; пароль в лог не попадает.
    // Ошибка здесь не должна выглядеть как «хранилище не поднялось»: база уже готова.
    try {
      const bootstrap = await ensureBootstrapAdmin();
      if (bootstrap.status === "created") app.log.info({ email: bootstrap.email }, "admin account created from environment");
      else if (bootstrap.status === "skipped" && process.env.ADMIN_BOOTSTRAP_EMAIL) {
        app.log.warn({ reason: bootstrap.reason }, "admin bootstrap skipped");
      }
    } catch (error) {
      app.log.error({ error: error instanceof Error ? error.message : error }, "admin bootstrap failed");
    }
  })
  .catch((err) => {
    console.error("[storage] init failed (background):", err?.message ?? err);
  });

const demoEnabled = process.env.WEBNESTDEV_DEMO_USER ? process.env.WEBNESTDEV_DEMO_USER !== "0" : !production;
if (demoEnabled) {
  const demo = await ensureDemoUser();
  app.log.info({ demoEmail: demo.email, created: demo.created }, "demo account ready");
}

app.addHook("onClose", async () => { stopBillingSweeper(); stopMailQueue(); stopStorageReconcile?.(); stopNodeHeartbeat(); stopRemoteNodeHeartbeat(); await stopPreviewHostServer(); await closeStorage(); });

await registerSecurityHeaders(app);

app.setErrorHandler((error, request, reply) => {
  // Проект в холодном ярусе: первый доступ ставит восстановление в фон, а клиент получает
  // `409 PROJECT_RESTORING` с прогрессом — это нормальный ход, а не сбой сервера.
  if (error instanceof ProjectRestoringError || error instanceof ProjectRestoreFailedError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      jobId: error.jobId,
      bytesDone: error.bytesDone,
      bytesTotal: error.bytesTotal,
    });
  }
  if (error instanceof NoSandboxNodeError || error instanceof SandboxNodeUnavailableError || error instanceof SharedWorkspaceRequiredError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "Некорректный запрос",
      issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    });
  }
  request.log.error(error);
  if (reply.sent) return;
  return reply.code(500).send({ error: "Внутренняя ошибка сервера" });
});
// In development the browser origin varies (localhost, LAN IP, hosted preview
// domain), so any origin is reflected unless WEBNESTDEV_ALLOWED_ORIGINS pins a list.
await app.register(cors,{origin: production || configuredOrigins ? allowedOrigins : true, credentials:true});
await app.register(cookie);
await app.register(websocket);
// CSRF: изменяющий запрос с чужого источника отклоняется. `SameSite=Lax` не помогает, когда
// приложение пользователя открыто на поддомене предпросмотра — это тот же сайт. Запросы без
// `Origin` (серверные вызовы, вебхуки оплаты) пропускаются: подделать cookie межсайтовая
// страница всё равно не может (см. security/same-origin.ts).
await registerSameOriginGuard(app);

await registerHealthRoutes(app);
await registerAuthRoutes(app);
// Вход администратора платформы: отдельные аккаунты, пароль + TOTP, сессия по Bearer-токену
// (docs/ADMIN_API.md). Ставится рядом с пользовательским входом, но не делит с ним ни записи, ни сессии.
await registerAdminRoutes(app);
// Статистика для админ-приложения: только чтение, тот же Bearer-токен и та же дверь (docs/ADMIN_API.md).
await registerAdminAnalyticsRoutes(app);
// Деньги админки: расход по моделям, выручка, маржа и цена подписки (docs/ADMIN_API.md).
await registerAdminEconomicsRoutes(app);
// Журнал безопасности: входы, второй фактор, ключи платформы, удаление проектов.
await registerAdminAuditRoutes(app);
// Инфраструктура: диск, Docker, песочницы, бакеты и база. Только чтение и только админ-токен.
await registerAdminInfraRoutes(app);
// Реестр узлов и drain: администратор видит размещение и может вывести машину из обслуживания.
await registerAdminNodeRoutes(app);
// Безопасная очистка Docker: кэш сборки и висячие образы. Контейнеры и тома не трогает.
await registerAdminPruneRoutes(app);
// Рассылка через Postbox: сегменты, предпросмотр, тест, отправка и остановка (docs/MAIL.md).
await registerAdminMailRoutes(app);
// Действия над аккаунтом: сеансы, блокировка, тариф без оплаты, надбавка к пулу токенов.
// Каждое — с `confirm: true`, записью в журнал безопасности и запретом на свой аккаунт.
await registerAdminUserActionRoutes(app);
// Реестр платежей и подписок плюс калибровка пула: сколько токенов реально выбирают.
await registerAdminBillingRoutes(app);
// Витрина тарифов: название, описание, цена и скидка. Меняется и из панели, и из внешней админки.
await registerAdminPlanRoutes(app);
// Карточка проекта: владелец, репозиторий, превью, переменные секретов, план выкатки.
await registerAdminProjectRoutes(app);
// Отписка — публичная страница, а не /api: ссылка приходит в письме и открывается без сессии.
await registerUnsubscribeRoutes(app);
await registerPhoneAuthRoutes(app);
await registerAccountRoutes(app);
// Уведомления аккаунта: подаренные токены и выданный тариф. Пишет админка, читает человек.
await registerNotificationRoutes(app);
await registerBillingRoutes(app);
await registerSupportRoutes(app);
await registerDonationRoutes(app);
await registerProjectRoutes(app);
await registerPreviewRoutes(app);
await registerToolRoutes(app);
await registerWorkspaceRoutes(app);
await registerThemeRoutes(app);
await registerProviderRoutes(app);
await registerGitHubRoutes(app);
await registerGitLabRoutes(app);
// GitVerse и SourceCraft: один и тот же набор маршрутов, разные адаптеры (/api/gitverse, /api/sourcecraft).
for (const provider of REPO_PROVIDERS) await registerRepoRoutes(app, provider);
await registerYandexRoutes(app);
await registerDatabaseRoutes(app);
await registerCloudRoutes(app);
await registerDomainRoutes(app);
await registerServiceRoutes(app);
await registerSecretRoutes(app);
await registerAccessRoutes(app);
await registerDeploymentRoutes(app);
await registerQuestionRoutes(app);
await registerChangesRoutes(app);
await registerTasksRoutes(app);
await registerPlatformRoutes(app);
await registerPlatformPlanRoutes(app);
await registerAgentWebSocket(app);

// Раздача собранной панели: документ никогда не кэшируется, файлы сборки — надолго. Правила и
// причина такого распределения живут в одном месте и проверяются тестом (routes/panel-static.ts).
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
await registerPanelFiles(app, rootDir);


await app.listen({host:"0.0.0.0",port:Number(process.env.PORT??8787)});
// Preview containers outlive the server that started them, so the ones left from a
// previous run are stopped on boot instead of running on with nothing owning them.
void reapOrphanPreviews()
  .then(result => { if (result.stopped) app.log.info({ stopped: result.stopped }, "stopped orphan preview containers"); })
  .catch(error => app.log.warn({ error: error instanceof Error ? error.message : error }, "preview reap skipped"));
void reapRemotePreviews()
  .then(result => { if (result.stopped) app.log.info({ stopped: result.stopped }, "stopped orphan preview containers on remote nodes"); })
  .catch(error => app.log.warn({ error: error instanceof Error ? error.message : error }, "remote preview reap skipped"));
// Долгие задания принадлежат контейнерам, а не процессу: после перезапуска прочитать их уже
// никто не сможет, поэтому они снимаются на старте — как и контейнеры предпросмотра.
void cleanupSandboxJobs()
  .then(result => { if (result.removed) app.log.info({ removed: result.removed }, "removed orphan sandbox jobs"); })
  .catch(error => app.log.warn({ error: error instanceof Error ? error.message : error }, "sandbox job reap skipped"));
// Песочница проверяется один раз после старта: маркер в каталоге песочниц и `cat` его из
// контейнера. Это единственный способ узнать, что контейнеры видят те же файлы, что и агент;
// результат остаётся в /api/health (`sandbox.mount`), а расхождение ещё и понижает /api/ready.
void verifySandboxMount()
  .then(result => {
    const line = describeSandboxMount(result);
    if (result.ok) app.log.info("sandbox mount ok: " + line);
    else app.log.error("sandbox mount failed: " + line);
  })
  .catch(error => app.log.warn({ error: error instanceof Error ? error.message : error }, "sandbox mount check skipped"));
// Публичный адрес предпросмотра отдаётся отдельным слушателем (см. preview/preview-host-server.ts):
// приложение занимает на своём поддомене весь путь, включая `/api`, и живой WebSocket с него, а
// подстановочный маршрут в этом же приложении занял бы `/*` у раздачи панели. Дверь поднимается
// только при заданном PREVIEW_PUBLIC_DOMAIN; отказ не мешает серверу работать.
void startPreviewHostServer()
  .then(result => {
    if (result.started) console.log("[preview] дверь публичных адресов слушает порт " + result.port);
    else console.log("[preview] дверь публичных адресов не поднята: " + result.reason);
  })
  .catch(error => console.error("[preview] дверь публичных адресов не поднялась: " + (error instanceof Error ? error.message : error)));
// A preview nobody uses is stopped after PREVIEW_IDLE_MS (five minutes by default): without
// the sweep every project that was ever previewed would keep a dev server and its memory.
startPreviewSweeper();
// Давно не открытые проекты уезжают в бакет и освобождают диск (PROJECT_ARCHIVE_ENABLED=1).
startProjectArchiveScheduler();
// Аварийные письма: диск, память, swap, ошибки архивации и возраст бэкапа. Почта уже настроена
// для писем платформы, отдельный сервис уведомлений не нужен; внешний монитор подключается отдельно.
startAlertScheduler();
// Автопродление подписок: раз в час, и только когда в магазине включена услуга периодических
// платежей. Без неё цикл не делает ни одного запроса к Робокассе.
startBillingSweeper();
// Очередь рассылки: одно письмо в секунду, состояние в базе. После перезапуска она продолжает
// незаконченные кампании с того письма, на котором остановилась.
startMailQueue();
