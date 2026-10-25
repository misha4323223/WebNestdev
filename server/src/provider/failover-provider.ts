import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { ProviderHttpError } from "./provider-errors.js";
import { providerRetryDecision } from "./provider-retry.js";
import type { Provider, ProviderChunk, ProviderStreamOptions } from "./provider-types.js";

/**
 * Один адрес модели в цепочке. `primary` — бесплатные ключи, `fallback` — платная модель
 * платформы: она включается только тогда, когда ни один бесплатный ключ не ответил.
 */
export type FailoverEndpoint = {
  /** Стабильное имя для памяти о паузах; сам ключ в него не попадает. */
  id: string;
  /** Человеческое имя для лога, без значения ключа. */
  label: string;
  role: "primary" | "fallback";
  baseUrl: string;
  model: string;
  token?: string;
};

export type FailoverState = {
  /** До какого момента ключ в паузе. Время в миллисекундах, как у Date.now(). */
  cooldowns: Map<string, number>;
  /** Последний ключ, который реально ответил: с него начинается следующий шаг. */
  activeId: string | null;
};

/** Своё состояние — тестам и будущим изолированным цепочкам. */
export function createFailoverState():FailoverState{
  return { cooldowns: new Map(), activeId: null };
}

/** Состояние живёт на процесс: пауза одного запуска должна действовать и для следующего. */
const sharedState: FailoverState = createFailoverState();

/** Тестам нужна чистая память: отказ одного прогона не должен влиять на следующий. */
export function resetFailoverState() {
  sharedState.cooldowns.clear();
  sharedState.activeId = null;
}

type FailureKind = "auth" | "rate" | "unavailable" | "bad-request";

const AUTH_COOLDOWN_MS = 10 * 60_000;
const RATE_COOLDOWN_MS = 60_000;
const UNAVAILABLE_COOLDOWN_MS = 30_000;
const BAD_REQUEST_COOLDOWN_MS = 5 * 60_000;
const MIN_RATE_COOLDOWN_MS = 5_000;

/**
 * Почему ключ выбыл из работы. Отказ по размеру контекста и по числу сообщений сюда не входит:
 * такой запрос лечится не сменой ключа, а сокращением истории (agent/step-runner.ts), и
 * переключение только сожгло бы соседние ключи на том же отказе.
 *
 * `BAD_REQUEST` переключает: бесплатная модель может не поддерживать инструменты или конкретный
 * формат запроса, а платная — поддерживать. Это именно тот случай, ради которого нужен резерв.
 */
function failureKind(error: unknown): FailureKind | null {
  if (error instanceof ProviderHttpError) {
    if (error.code === "AUTH") return "auth";
    if (error.code === "RATE_LIMIT") return "rate";
    if (error.code === "UNAVAILABLE") return "unavailable";
    if (error.code === "BAD_REQUEST") return "bad-request";
    return null;
  }
  // Сетевые ошибки fetch: соединение не установилось, ответ не начался — повтор безопасен.
  if (providerRetryDecision(error).retryable) return "unavailable";
  return null;
}

function cooldownFor(kind: FailureKind, error: unknown) {
  if (kind === "auth") return AUTH_COOLDOWN_MS;
  if (kind === "bad-request") return BAD_REQUEST_COOLDOWN_MS;
  if (kind === "unavailable") return UNAVAILABLE_COOLDOWN_MS;
  const asked = error instanceof ProviderHttpError ? error.retryAfterMs : undefined;
  return Math.max(MIN_RATE_COOLDOWN_MS, asked && asked > 0 ? asked : RATE_COOLDOWN_MS);
}

export type FailoverOptions = {
  /** Своё состояние — для тестов; по умолчанию общее на процесс. */
  state?: FailoverState;
  /** Часы — для тестов, чтобы не ждать настоящие минуты. */
  now?: () => number;
  /** Как создать провайдера для адреса; по умолчанию OpenAI-совместимый. */
  create?: (endpoint: FailoverEndpoint) => Provider;
  /** Куда писать переключения; по умолчанию в лог сервера. */
  log?: (message: string) => void;
};

/**
 * Модель с несколькими ключами и резервом.
 *
 * Обычная работа идёт через первый доступный бесплатный ключ. Если он отвечает отказом до первого
 * байта ответа, шаг переходит к следующему ключу, а затем к платной модели платформы. Успешный
 * ключ запоминается, чтобы следующий шаг не начинался с только что отказавшего.
 *
 * Три правила, без которых это ломает работу:
 *
 * - переключение только до первого байта: часть ответа уже показана пользователю, и повтор
 *   прислал бы её второй раз;
 * - отказ по контексту и по числу сообщений не переключает: это лечится сокращением истории;
 * - резерв не становится основным: как только пауза бесплатного ключа кончилась, следующий шаг
 *   снова начинает с бесплатных, даже если предыдущий закончился на платной модели.
 */
export class FailoverProvider implements Provider {
  private readonly state: FailoverState;
  private readonly now: () => number;
  private readonly create: (endpoint: FailoverEndpoint) => Provider;
  private readonly log: (message: string) => void;

  constructor(private readonly endpoints: FailoverEndpoint[], options: FailoverOptions = {}) {
    this.state = options.state ?? sharedState;
    this.now = options.now ?? Date.now;
    this.create = options.create ?? (endpoint => new OpenAICompatibleProvider(endpoint.baseUrl, endpoint.token));
    this.log = options.log ?? (message => console.warn(message));
  }

  private isCooling(endpoint: FailoverEndpoint) {
    return (this.state.cooldowns.get(endpoint.id) ?? 0) > this.now();
  }

  /**
   * Порядок попыток на этот шаг. Бесплатные ключи важнее резерва: резерв попадает в список
   * последним и только если он не в паузе.
   */
  private attemptOrder(): FailoverEndpoint[] {
    const live = this.endpoints.filter(endpoint => !this.isCooling(endpoint));
    const primaries = live.filter(endpoint => endpoint.role === "primary");
    const fallback = live.find(endpoint => endpoint.role === "fallback");
    if (primaries.length) {
      const active = primaries.find(endpoint => endpoint.id === this.state.activeId);
      return [...(active ? [active] : []), ...primaries.filter(endpoint => endpoint !== active), ...(fallback ? [fallback] : [])];
    }
    return fallback ? [fallback] : [];
  }

  /** Сколько ждать до ближайшего освободившегося ключа: это уходит в повтор шага. */
  private nextRecoveryMs() {
    const now = this.now();
    const times = this.endpoints
      .map(endpoint => this.state.cooldowns.get(endpoint.id) ?? 0)
      .filter(until => until > now);
    return times.length ? Math.min(...times) - now : 0;
  }

  private coolDown(endpoint: FailoverEndpoint, kind: FailureKind, error: unknown) {
    const wait = cooldownFor(kind, error);
    this.state.cooldowns.set(endpoint.id, this.now() + wait);
    const reason = kind === "auth" ? "ключ отклонён"
      : kind === "rate" ? "лимит частоты"
        : kind === "bad-request" ? "запрос отклонён"
          : "модель недоступна";
    this.log("[provider] " + endpoint.label + ": " + reason + ", пауза " + Math.round(wait / 1000) + " с");
  }

  async *stream(
    messages: Parameters<Provider["stream"]>[0],
    _model: string,
    tools?: unknown[],
    signal?: AbortSignal,
    options?: ProviderStreamOptions,
  ): AsyncGenerator<ProviderChunk> {
    if (!this.endpoints.length) throw new Error("Не настроен ни один адрес модели");
    if (signal?.aborted) throw new Error("Запуск агента отменён");

    const order = this.attemptOrder();
    if (!order.length) {
      // Все ключи в паузе. Отдаём 429 с реальным сроком: provider-retry подождёт и повторит шаг,
      // а не будет долбить остывающие ключи на каждом шаге.
      const wait = Math.max(1_000, this.nextRecoveryMs());
      throw new ProviderHttpError(429, "Все ключи бесплатной модели временно недоступны", wait);
    }

    let lastError: unknown = null;
    for (const endpoint of order) {
      if (signal?.aborted) throw new Error("Запуск агента отменён");
      if (this.isCooling(endpoint)) continue;

      let emitted = false;
      try {
        const provider = this.create(endpoint);
        for await (const chunk of provider.stream(messages, endpoint.model, tools, signal, options)) {
          emitted = true;
          yield chunk;
        }
        this.state.cooldowns.delete(endpoint.id);
        // Резерв не запоминается как основной: после паузы бесплатные ключи снова первые.
        if (endpoint.role === "primary") this.state.activeId = endpoint.id;
        return;
      } catch (error) {
        // Ответ уже начал уходить пользователю: второй ключ прислал бы его заново.
        if (emitted) throw error;
        if (signal?.aborted) throw error;
        const kind = failureKind(error);
        if (!kind) throw error;
        lastError = error;
        this.coolDown(endpoint, kind, error);
      }
    }

    throw lastError ?? new ProviderHttpError(429, "Все ключи бесплатной модели временно недоступны", Math.max(1_000, this.nextRecoveryMs()));
  }
}
