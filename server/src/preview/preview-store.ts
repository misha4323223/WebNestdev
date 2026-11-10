import {
  getSharedPreview,
  listSharedPreviews,
  removeSharedPreview,
  saveSharedPreview,
  touchSharedPreview,
} from "./preview-registry.js";
import type { PreviewState } from "./types.js";

const previews = new Map<string, PreviewState>();

/**
 * Запись в общий реестр не должна задерживать прокси: локальная карта — источник истины для
 * текущего запроса, база догоняет. Очередь на проект сохраняет порядок set → touch → remove,
 * иначе поздний `save` после `remove` воскрешал бы строку.
 */
const writes = new Map<string, Promise<void>>();

function enqueueWrite(projectId: string, task: () => Promise<void>) {
  const previous = writes.get(projectId) ?? Promise.resolve();
  const next = previous.then(task, task).catch(error => {
    console.warn("[preview] общий реестр не принял запись " + projectId + ": " + describeError(error));
  });
  writes.set(projectId, next);
  void next.finally(() => {
    if (writes.get(projectId) === next) writes.delete(projectId);
  });
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Дождаться фоновой записи одного проекта или всех: после старта бронь снимается только тогда,
 * когда строка preview уже в общем реестре. */
export async function flushPreviewWrites(projectId?: string) {
  if (projectId) {
    const pending = writes.get(projectId);
    if (pending) await pending;
    return;
  }
  while (writes.size) await Promise.all([...writes.values()]);
}

/** Для тестов: дождаться, пока фоновые записи реестра действительно ушли в backend. */
export async function flushPreviewWritesForTests() {
  await flushPreviewWrites();
}

export function getPreview(projectId: string) {
  return previews.get(projectId);
}

export function listPreviews() {
  return [...previews.values()];
}

/**
 * Кладёт состояние в локальный кэш, не записывая его в базу. Нужен при подъёме чужого preview:
 * вторая реплика не должна перезаписывать строку владельца только потому, что прочитала её.
 */
export function rememberPreview(state: PreviewState) {
  const current = previews.get(state.projectId);
  const lastUsedAt = Math.max(state.lastUsedAt || 0, current?.lastUsedAt ?? 0) || Date.now();
  const next: PreviewState = {
    ...state,
    lastUsedAt,
    ...(state.ownerUserId || current?.ownerUserId
      ? { ownerUserId: state.ownerUserId ?? current?.ownerUserId }
      : {}),
  };
  previews.set(state.projectId, next);
  return next;
}

/**
 * Keeps the last-use mark the caller supplies (the runner sets a fresh one); fills it when missing.
 * A write that carries a mark older than the stored one must not move it back: bringing the
 * address to a working one happens after the status read has already marked the preview as used,
 * and the idle sweeper would otherwise see a preview nobody touched.
 */
export function setPreview(state: PreviewState) {
  const next = rememberPreview(state);
  enqueueWrite(next.projectId, () => saveSharedPreview(next));
}

export function removePreview(projectId: string) {
  previews.delete(projectId);
  lastSharedTouch.delete(projectId);
  enqueueWrite(projectId, () => removeSharedPreview(projectId));
}

/**
 * Снимает подтверждение адреса (прокси увидел, что он не работает): следующая проверка статуса
 * снова сведёт адрес приложения — например, после перезапуска dev-сервера на другом порту.
 */
export function unsettlePreview(projectId: string) {
  const current = previews.get(projectId);
  if (!current || !current.settled) return false;
  const next = { ...current, settled: false };
  previews.set(projectId, next);
  enqueueWrite(projectId, () => saveSharedPreview(next));
  return true;
}

/**
 * Адреса живых предпросмотров для `/api/health`: режим, порт, подтверждён ли адрес запросом сервера
 * и сколько предпросмотр уже живёт. Без этого поля «предпросмотр не работает» неотличимо от
 * «предпросмотр не запущен», а `settled: false` у живого предпросмотра — точный признак того, что
 * сервер до приложения не доходит (панель и Chromium тоже).
 */
export function previewAddresses(now = Date.now()) {
  return listPreviews().map(state => ({
    mode: state.mode,
    port: state.port,
    settled: Boolean(state.settled),
    // Предпросмотр виден панели, но не по адресу контейнера: `settled: false` без этого поля
    // выглядит как «сервер до приложения не доходит», хотя кадр в панели не пустой.
    viaExec: Boolean(state.execOnly),
    execCheckedAt: state.execOnlyCheckedAt ?? null,
    ageSeconds: Math.max(0, Math.round((now - state.startedAt) / 1000)),
  }));
}

/**
 * Переключает предпросмотр на путь через `docker exec` (см. preview/exec-proxy.ts) и обратно.
 * Ставится прокси, когда адрес контейнера не отвечает, а приложение внутри него живо; снимается,
 * когда адрес подтверждён заново — тогда панель снова идёт прямым путём.
 */
export function setPreviewExecOnly(projectId: string, execOnly: boolean) {
  const current = previews.get(projectId);
  if (!current || current.mode !== "container" || Boolean(current.execOnly) === execOnly) return false;
  // Отметка времени — вместе с признаком: включивший его прокси только что убедился, что прямой
  // адрес не отвечает, поэтому повторная проверка адреса отсчитывается от этого момента.
  const next: PreviewState = {
    ...current,
    execOnly,
    execOnlyCheckedAt: execOnly ? Date.now() : undefined,
  };
  previews.set(projectId, next);
  enqueueWrite(projectId, () => saveSharedPreview(next));
  return true;
}

/**
 * How often a heartbeat extends the shared TTL. The panel pings on every visible preview and the
 * proxy touches on every file, so writing each touch would turn a page load into dozens of
 * updates. Fifteen seconds is far below the TTL, and a live preview is saved in full when it
 * starts and when its address changes.
 */
const SHARED_TOUCH_INTERVAL_MS = 15_000;
const lastSharedTouch = new Map<string, number>();

/** Marks a preview as used now; returns false when the project has no running preview. */
export function touchPreview(projectId: string, now = Date.now()) {
  const current = previews.get(projectId);
  if (!current) return false;
  previews.set(projectId, { ...current, lastUsedAt: now });
  if (now - (lastSharedTouch.get(projectId) ?? 0) < SHARED_TOUCH_INTERVAL_MS) return true;
  lastSharedTouch.set(projectId, now);
  enqueueWrite(projectId, () => touchSharedPreview(projectId, now));
  return true;
}

/**
 * Поднимает состояние preview, начатого на другой реплике. Горячий путь (локальный кэш) не
 * меняется: поход в базу случается только при первом обращении API к чужому preview.
 */
export async function hydratePreview(projectId: string): Promise<PreviewState | undefined> {
  const local = previews.get(projectId);
  if (local) return local;
  try {
    const shared = await getSharedPreview(projectId);
    if (!shared) return undefined;
    // Между запросом и ответом локальный preview мог появиться: он свежее прочитанной строки.
    return previews.get(projectId) ?? rememberPreview(shared);
  } catch (error) {
    console.warn("[preview] общий реестр недоступен, работаю по локальному кэшу: " + describeError(error));
    return undefined;
  }
}

/**
 * Все container-preview, видимые кластеру. Локальная запись важнее строки из базы для того же
 * проекта: процесс, который держит контейнер, знает его адрес точнее.
 */
export async function listPreviewsAcrossReplicas(): Promise<PreviewState[]> {
  let shared: PreviewState[] = [];
  try {
    shared = await listSharedPreviews();
  } catch (error) {
    console.warn("[preview] не удалось прочитать общий реестр: " + describeError(error));
  }
  const merged = new Map(shared.map(state => [state.projectId, state]));
  for (const state of previews.values()) merged.set(state.projectId, state);
  return [...merged.values()];
}
