import { positiveInt } from "../concurrency.js";

/**
 * Таймауты одного запроса к провайдеру модели.
 *
 * Раньше единственной страховкой был общий сторож запуска на 15 минут: зависший шлюз держал
 * слот аккаунта, место в очереди и Chromium всё это время. Соединение ограничено отдельно, а
 * поток — отдельно: `connect` действует до заголовков ответа, `idle` — на паузу между чанками.
 * Оба значения переопределяются окружением, потому что медленный локальный шлюз и облачный
 * провайдер терпят разные задержки.
 */
export function providerTimeouts() {
  return {
    connectMs: positiveInt(process.env.AI_CONNECT_TIMEOUT_MS, 30_000),
    idleMs: positiveInt(process.env.AI_IDLE_TIMEOUT_MS, 90_000),
  };
}

/**
 * Отказ по таймауту. В тексте есть `ETIMEDOUT`, поэтому существующее правило повторов
 * (`provider-retry.ts`) считает его сетевой ошибкой до первого байта. Если часть ответа уже
 * ушла в панель, шаг всё равно не повторяется: так решает `partialStreamed`.
 */
export class ProviderTimeoutError extends Error {
  readonly code = "TIMEOUT";

  constructor(readonly stage: "connect" | "idle", readonly timeoutMs: number) {
    super(
      "ETIMEDOUT: провайдер модели " +
        (stage === "connect" ? "не принял соединение" : "не прислал данные") +
        " за " +
        Math.round(timeoutMs / 1000) +
        " с",
    );
    this.name = "TimeoutError";
  }
}

/**
 * Оборачивает поток чанков таймаутом простоя. Таймер перезапускается перед каждым `next()`,
 * поэтому долгая, но живая генерация не обрывается, а зависшая — обрывается на первом же окне.
 * `onTimeout` нужен, чтобы вызывающий код мог отменить сам HTTP-запрос и закрыть сокет.
 */
export async function* withIdleTimeout<T>(
  source: AsyncGenerator<T>,
  idleMs: number,
  onTimeout: () => void,
): AsyncGenerator<T> {
  while (true) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new ProviderTimeoutError("idle", idleMs));
      }, idleMs);
    });
    const pending = source.next();
    let timedOut = false;
    try {
      const next = await Promise.race([pending, timeout]);
      if (next.done) return;
      yield next.value;
    } catch (error) {
      timedOut = error instanceof ProviderTimeoutError;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      // После таймаута `pending` ещё жив: отмена HTTP-запроса отклонит его уже после того,
      // как гонка завершилась. Без обработчика это unhandled rejection и падение процесса.
      if (timedOut) pending.catch(() => undefined);
    }
  }
}
