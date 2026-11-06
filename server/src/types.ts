import type { PlanId } from "./account/plans.js";

export type Role="user"|"assistant"|"system"|"tool";
/**
 * Один узел дерева размышлений. Сейчас шаг — корневой узел запуска; `parentId` уже хранится,
 * чтобы будущий субагент мог стать ребёнком шага, не меняя формат истории.
 */
export type ReasoningBlockKind="step"|"subagent";
export type ReasoningBlockStatus="running"|"done"|"error";
export type ReasoningBlock={
  id:string;
  runId:string;
  parentId?:string;
  kind:ReasoningBlockKind;
  title:string;
  text:string;
  step:number;
  status:ReasoningBlockStatus;
  startedAt:string;
  finishedAt?:string;
};
/**
 * Байты одного изображения для шага модели: тип и base64 без префикса.
 *
 * В историю это не попадает никогда: сообщение пользователя в сессии хранит только текст с
 * публичной ссылкой, а картинка подставляется в запрос на время запуска. Иначе одна фотография
 * занимала бы мегабайты в PostgreSQL и уезжала бы в каждый следующий запрос разговора.
 */
export type MessageImage={contentType:string;data:string;name?:string};
export type ChatMessage=
  | {role:"user";content:string;/** Только на время запуска: см. MessageImage. */images?:MessageImage[]}
  | {role:"system";content:string}
  /**
   * `reasoning` is what the model thought before answering. It is shown to the user and kept in the
   * session; DeepSeek thinking mode also receives it back with tools, while other providers do not.
   */
  | {role:"assistant";content:string;reasoning?:string;reasoningBlocks?:ReasoningBlock[];tool_calls?:Array<{id:string;name:string;arguments:Record<string,unknown>}>}
  | {role:"tool";content:string;tool_call_id:string};
export type PlanItemStatus="pending"|"in_progress"|"done";
export type PlanItem={title:string;status:PlanItemStatus;note?:string};
export type PlanState={items:PlanItem[];updatedAt:string};
export type AgentEvent=
  | {type:"run.started";runId:string}
  | {type:"message.delta";runId:string;delta:string}
  | {type:"reasoning.start";runId:string;blockId:string;step:number;title:string;startedAt:string;parentId?:string;blockKind?:ReasoningBlockKind}
  | {type:"reasoning.delta";runId:string;delta:string;blockId?:string;step?:number}
  | {type:"reasoning.end";runId:string;blockId:string;status:"done"|"error";finishedAt:string;title?:string;text?:string}
  | {type:"tool.started";runId:string;toolCallId:string;name:string;input:unknown}
  | {type:"tool.finished";runId:string;toolCallId:string;name:string;output:unknown}
  | {type:"plan.updated";runId:string;plan:PlanState}
  /** `tokens`/`budget` are the context size of the step that is starting (agent/context-budget.ts). */
  | {type:"run.progress";runId:string;step:number;maxSteps:number;tokens?:number;budget?:number}
  /**
   * Провайдер ответил «подожди» (лимит частоты, 5xx, обрыв сети), и шаг ждёт, а не падает:
   * `attempt` — какая попытка идёт, `waitSeconds` — сколько агент подождёт перед ней.
   */
  | {type:"run.retrying";runId:string;attempt:number;attempts:number;waitSeconds:number;code?:string}
  /**
   * Инструмент `secrets.request` просит пользователя ввести ключ в модальном окне. Событие несёт
   * только имя переменной, файл и причину — само значение идёт другим путём: HTTP-запросом в
   * `/api/projects/:id/secrets`, в зашифрованное хранилище проекта, и модели не возвращается никогда.
   */
  | {type:"secret.requested";runId:string;requestId:string;variable:string;purpose:string;file:string;expiresAt:number}
  /**
   * Инструмент `access.request` просит доступ к провайдеру. Карточка в чате показывает поля
   * кабинета (не значения), шаги и документацию; ответ сохраняется в хранилище интеграций и
   * возвращает модели только подтверждение аккаунта. `writes` — поддерживает ли провайдер
   * изменения, `defaultAllowWrites` — что стоит в переключателе разрешения.
   */
  | {type:"access.requested";runId:string;requestId:string;kind:"cloud"|"domain"|"service"|"database"|"yandex";provider:string;name:string;purpose:string;fields:Array<{key:string;label:string;placeholder:string;secret?:boolean;multiline?:boolean;optional?:boolean}>;steps:string[];keyUrl?:string;docsUrl?:string;verificationNote:string;writes:boolean;defaultAllowWrites:boolean;expiresAt:number}
  /**
   * Инструмент `question.ask` спрашивает пользователя о выборе. Окно с вариантами выезжает над
   * полем ввода, запуск ждёт ответа, а сам ответ приходит маршрутом
   * `/api/projects/:id/questions/:requestId/answer` — то есть тем же путём, что и запрос ключа:
   * разговор с человеком не мешается с потоком задачи.
   */
  | {type:"question.asked";runId:string;requestId:string;question:string;options:Array<{label:string;description?:string;imageUrl?:string}>;multiSelect:boolean;maxSelections?:number;allowCustom:boolean;expiresAt:number}
  /**
   * Задача закончилась и её изменения записаны в историю проекта. Событие приходит до
   * `run.completed`, чтобы панель успела показать новую точку, пока соединение ещё открыто.
   * `pushed` здесь всегда false: отправка на GitHub — решение пользователя, а не агента.
   */
  | {type:"changes.created";runId:string;checkpoint:{sha:string;shortSha:string;subject:string;filesChanged:number};branch:string;pushed:boolean;pushError?:string}
  | {type:"run.completed";runId:string}
  /** `code` is a machine-readable reason (CONTEXT_OVERFLOW, AUTH, RATE_LIMIT) for the panel. */
  | {type:"run.failed";runId:string;error:string;code?:string};
/**
 * "planner" studies the project and publishes a plan without touching files;
 * "developer" is the full agent that writes code and verifies the result.
 */
export type AgentMode="planner"|"developer";
/**
 * How much deliberate thinking the provider is asked for: `low` answers fast, `medium` balances
 * speed and depth, `high` spends the most reasoning on hard tasks.
 */
export type ReasoningEffort="low"|"medium"|"high";
/**
 * `auto` — не отдельная сила модели, а разрешение агенту выбрать её по шагу: первый шаг
 * анализирует задачу, рутинные шаги идут дешевле, а после ошибки проверки глубина возвращается.
 * Явный low/medium/high всегда важнее автоматики.
 */
export type ReasoningMode=ReasoningEffort|"auto";
/**
 * `code` ищет по исходникам проекта, `web` — по публичным страницам, когда пользователь включил
 * поиск в интернете. Оба профиля read-only и не могут позвать друг друга.
 */
export type ScoutKind="code"|"web";
/** Read-only разведчик: отдельный контекст и отдельный ответ, без доступа к изменениям проекта. */
export type ScoutRequest={task:string;focus?:string;kind?:ScoutKind};
export type ScoutResult={ok:boolean;summary:string;files:string[];findings:string[];sources?:string[]};
export type ScoutRunner=(input:ScoutRequest)=>Promise<ScoutResult>;
/**
 * `resume` marks a run that continues an interrupted one: the history arrives as usual, but the
 * runtime tells the model that this is a continuation and where the plan stopped.
 *
 * `history` is the conversation as it is stored, put there by the route that already read it. What
 * the model sees is that, not the copy the browser sent: the stored one is the same chat the user
 * reads, it carries the tool results of the previous runs, and it does not depend on the panel
 * re-uploading the whole conversation on every run. `messages` stays the fallback for a run that
 * starts before anything is stored.
 *
 * `webSearch` — переключатель в панели ввода: по умолчанию выключен, и без него `web.search` не
 * ходит в сеть. Флаг приходит от клиента, потому что это решение пользователя на конкретный запуск,
 * а не свойство аккаунта; тариф по-прежнему выбирает провайдера (`web/search.ts`).
 *
 * `browserCheck` — отдельный переключатель того же меню: разрешает Chromium-инструменты и
 * автоматическую браузерную QA на этот запуск. Выключен по умолчанию, потому что проверка
 * добавляет шаги и результаты в контекст, а значит расходует больше токенов.
 *
 * `plan` ставит сервер, а не клиент: на бесплатном тарифе он выбирает бесплатную модель с
 * резервом на платформенную, а на платных оставляет платформенную по умолчанию.
 */
export type AgentRunRequest={projectId:string;conversationId?:string;messages:ChatMessage[];history?:ChatMessage[];model?:string;mode?:AgentMode;reasoning?:ReasoningMode;webSearch?:boolean;browserCheck?:boolean;resume?:{reason?:string};/** Первый запуск нового проекта: только вопросы и резюме, без осмотра файлов. */planning?:boolean;plan?:PlanId;userId:string};
/**
 * `emit` и `signal` нужны инструментам, которые работают не сами по себе, а вместе с пользователем:
 * `secrets.request` показывает модальное окно через поток запуска и ждёт ответа, а остановка запуска
 * должна закрыть это ожидание, а не оставить инструмент висеть.
 */
/**
 * `conversationId` нужен инструментам, которые пишут в разговор, а не в проект: заметки решений
 * принадлежат чату, а не проекту (в разных чатах одного проекта договариваются о разном).
 */
export type ToolContext={projectId:string;runId:string;userId:string;conversationId?:string;emit?:(event:AgentEvent)=>void;signal?:AbortSignal;/** `web.search`/`web.read` разрешены только когда пользователь включил поиск в панели ввода. */webSearchEnabled?:boolean;/** Тяжёлые `browser.*` разрешены только когда пользователь включил браузерную проверку. */browserCheckEnabled?:boolean;/** Read-only субагент, если текущий запуск его поддерживает. */scout?:ScoutRunner};
export type ToolHandler=(input:unknown,context:ToolContext)=>Promise<unknown>;
export type ToolDefinition={name:string;description:string;execute?:ToolHandler;async?:ToolHandler;/** Optional JSON Schema sent to the provider so the model knows the exact input shape. */parameters?:Record<string,unknown>};