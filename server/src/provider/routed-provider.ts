import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import {
  FailoverProvider,
  createFailoverState,
  type FailoverEndpoint,
  type FailoverState,
} from "./failover-provider.js";
import {
  getUpstreamModelCatalog,
  isWithinUpstreamPrice,
  rankUpstreamProviders,
  resolveUpstreamProviderName,
  type UpstreamCatalogModel,
} from "./upstream-catalog.js";
import type { Provider, ProviderChunk, ProviderStreamOptions } from "./provider-types.js";
import { isUpstreamRouted, type UpstreamRouting } from "./upstream-routing.js";

/**
 * Ответ «ни один провайдер из настроенной цепочки сейчас недоступен». Отдельный код нужен,
 * чтобы панель показала настройку, а не общий текст ошибки провайдера.
 */
export class UpstreamRoutingError extends Error {
  readonly code = "UPSTREAM_UNAVAILABLE";
  constructor(readonly notes: string[]) {
    super("Нет доступных upstream-провайдеров для модели" +
      (notes.length ? ": " + notes.join("; ") : "") +
      ". Проверьте маршрутизацию в админке или включите fallback на автоматический выбор.");
    this.name = "UpstreamRoutingError";
  }
}

export type UpstreamCatalogLookup = (
  baseUrl: string,
  token: string | undefined,
  model: string,
) => Promise<UpstreamCatalogModel | null>;

export type RoutedProviderDeps = {
  /** Подмена каталога в тестах; по умолчанию кэширующий клиент Polza. */
  catalog?: UpstreamCatalogLookup;
  /** Своё состояние пауз и активного провайдера; по умолчанию на экземпляр запуска. */
  state?: FailoverState;
  /** Как создать провайдера для адреса; по умолчанию OpenAI-совместимый. */
  create?: (endpoint: FailoverEndpoint) => Provider;
  log?: (message: string) => void;
  now?: () => number;
};

type ResolvedPlan = {
  /** Запрос без `provider`, шлюз выбирает сам. */
  auto: boolean;
  endpoints: FailoverEndpoint[];
  notes: string[];
};

/**
 * Провайдер с управляемой цепочкой upstream-провайдеров одной модели.
 *
 * Режимы:
 * - `auto` — как раньше: поле `provider` не отправляется, выбирает шлюз;
 * - `fixed` — точный порядок из админки. Если провайдера больше нет в каталоге (например,
 *   Morph выключили), он пропускается ещё до запроса; если он ответил отказом до первого байта,
 *   попытка переходит к следующему;
 * - `cheapest` — порядок считается по каталогу под профиль вход/выход; белый список из админки
 *   ограничивает круг, но не задаёт порядок.
 *
 * Почему не `allow_fallbacks: true` у шлюза: тогда при отказе дешёвого провайдера Polza сама
 * уйдёт к любому другому, включая официальный DeepSeek в 3 раза дороже. Здесь каждый запрос
 * идёт с `only: [provider]` и `allow_fallbacks: false`, а переключение делает наш FailoverProvider
 * только по следующему разрешённому имени. Так цена не меняется молча.
 */
export class RoutedProvider implements Provider {
  private readonly state: FailoverState;
  private readonly catalog: UpstreamCatalogLookup;
  private readonly create: (endpoint: FailoverEndpoint) => Provider;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly loggedNotes = new Set<string>();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly routing: UpstreamRouting,
    deps: RoutedProviderDeps = {},
  ) {
    this.state = deps.state ?? createFailoverState();
    this.catalog = deps.catalog ?? ((base, token, model) => getUpstreamModelCatalog(base, token, model));
    this.create = deps.create ?? (endpoint => new OpenAICompatibleProvider(endpoint.baseUrl, endpoint.token));
    this.log = deps.log ?? (message => console.warn(message));
    this.now = deps.now ?? Date.now;
  }

  private note(message: string) {
    if (this.loggedNotes.has(message)) return;
    this.loggedNotes.add(message);
    this.log("[provider] " + message);
  }

  private endpoint(model: string, name: string): FailoverEndpoint {
    const maxPrice = this.routing.maxPrice;
    return {
      // Идентификатор не содержит ключ и остаётся стабильным между шагами: по нему
      // FailoverProvider запоминает, кто ответил, и не возвращается к только что отказавшему.
      id: "upstream:" + this.baseUrl + "|" + model + "|" + name,
      label: name,
      role: "primary",
      baseUrl: this.baseUrl,
      model,
      ...(this.token ? { token: this.token } : {}),
      upstream: {
        only: [name],
        allowFallbacks: false,
        ...(maxPrice ? { maxPrice } : {}),
      },
    };
  }

  private autoEndpoint(model: string): FailoverEndpoint {
    return {
      id: "auto:" + this.baseUrl + "|" + model,
      label: "авто-выбор шлюза",
      role: "fallback",
      baseUrl: this.baseUrl,
      model,
      ...(this.token ? { token: this.token } : {}),
    };
  }

  private async resolve(model: string): Promise<ResolvedPlan> {
    if (!isUpstreamRouted(this.routing)) return { auto: true, endpoints: [], notes: [] };

    let catalog: UpstreamCatalogModel | null = null;
    try {
      catalog = await this.catalog(this.baseUrl, this.token, model);
    } catch (error) {
      this.note("каталог провайдеров не прочитан: " + (error instanceof Error ? error.message : String(error)));
    }
    const notes: string[] = [];
    const names: string[] = [];

    if (this.routing.mode === "fixed") {
      if (catalog && catalog.providers.length) {
        const byName = new Map(catalog.providers.map(provider => [provider.name, provider]));
        for (const configured of this.routing.providers) {
          // В админке провайдер может быть сохранён подписью («Sail Research»). Шлюзу нужно
          // точное имя каталога (`sail-research/fp4`), иначе fixed молча останется без адресов.
          const name = resolveUpstreamProviderName(catalog.providers, configured);
          const provider = name ? byName.get(name) : undefined;
          if (!name || !provider) {
            notes.push(configured + " отсутствует в каталоге — пропущен");
            continue;
          }
          if (name !== configured) notes.push("«" + configured + "» → " + name);
          if (provider.ambiguous) {
            notes.push(name + " встречается в каталоге несколько раз — выбран первый вариант");
          }
          if (!isWithinUpstreamPrice(provider, this.routing.maxPrice)) {
            notes.push(name + " дороже maxPrice — пропущен");
            continue;
          }
          names.push(name);
        }
      } else {
        // Каталог не ответил или шлюз не отдаёт массив providers (OpenRouter и другие): не
        // блокируем запуск. Если провайдер действительно выключен, его отказ придёт до первого
        // байта и FailoverProvider перейдёт к следующему.
        names.push(...this.routing.providers);
        notes.push(catalog
          ? "каталог не вернул провайдеров — проверка доступности пропущена"
          : "каталог провайдеров недоступен — проверка доступности пропущена");
      }
    } else {
      if (catalog && catalog.providers.length) {
        let candidates = catalog.providers;
        if (this.routing.providers.length) {
          const allowed = new Set<string>();
          for (const configured of this.routing.providers) {
            const name = resolveUpstreamProviderName(catalog.providers, configured);
            if (!name) {
              notes.push(configured + " отсутствует в каталоге — пропущен");
              continue;
            }
            if (name !== configured) notes.push("«" + configured + "» → " + name);
            allowed.add(name);
          }
          candidates = candidates.filter(provider => allowed.has(provider.name));
        }
        names.push(...rankUpstreamProviders(candidates, this.routing).map(provider => provider.name));
        if (!names.length) {
          notes.push("в каталоге нет провайдеров с инструментами и подходящей ценой");
        }
      } else {
        names.push(...this.routing.providers);
        notes.push(catalog
          ? "каталог не вернул провайдеров — порядок взят из настроек"
          : "каталог провайдеров недоступен — порядок взят из настроек");
      }
    }

    if (!this.routing.allowFallback) names.splice(1);
    if (!names.length) {
      if (this.routing.fallbackToAuto) {
        this.note("разрешённых провайдеров нет — перехожу на автоматический выбор шлюза");
        return { auto: true, endpoints: [], notes };
      }
      throw new UpstreamRoutingError(notes);
    }

    const endpoints = names.map(name => this.endpoint(model, name));
    if (this.routing.fallbackToAuto) {
      endpoints.push(this.autoEndpoint(model));
      notes.push("после всей цепочки разрешён автоматический выбор шлюза");
    }
    for (const note of notes) this.note(note);
    return { auto: false, endpoints, notes };
  }

  async *stream(
    messages: Parameters<Provider["stream"]>[0],
    model: string,
    tools?: unknown[],
    signal?: AbortSignal,
    options?: ProviderStreamOptions,
  ): AsyncGenerator<ProviderChunk> {
    const plan = await this.resolve(model);
    for (const note of plan.notes) this.note(note);

    if (plan.auto) {
      const provider = this.create(this.autoEndpoint(model));
      yield* provider.stream(messages, model, tools, signal, options);
      return;
    }

    const failover = new FailoverProvider(plan.endpoints, {
      state: this.state,
      create: this.create,
      log: this.log,
      now: this.now,
    });
    yield* failover.stream(messages, model, tools, signal, options);
  }
}
