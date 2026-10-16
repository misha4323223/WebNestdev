import { apiUrl } from "./api";

/**
 * Открытая вкладка сама замечает, что на сервере работает другая сборка, и перезагружает себя —
 * один раз, с обходом кэша.
 *
 * Это последний рубеж против «после выкатки показывается старая версия». Документ платформы и так
 * отдаётся без кэша и без валидаторов (см. server/src/routes/cache-headers.ts), но вкладку мог
 * закэшировать посредник, который на эти заголовки не смотрит, а вместе с документом живут ссылки на
 * ассеты прошлой сборки — у них в имени хэш и срок в 30 дней, поэтому старая версия продолжает
 * работать и выглядит совершенно исправной. Полагаться на то, что кто-то там что-то не закэширует,
 * нельзя: вкладка обязана почувствовать, что она устарела.
 *
 * Перезагрузка помечается в `sessionStorage` на номер той сборки, к которой перезагружались: если
 * новая версия до вкладки так и не доехала (посредник отдаёт ту же старую копию), второго круга не
 * будет. Так проверка не может превратиться в цикл перезагрузок, а следующая выкатка снова даст ей
 * одну попытку.
 */

/** Сборка, зашитая в этот бандл; пусто — версия не передана (dev, локальная сборка без SHA). */
export function loadedBuild(): string {
  const value = import.meta.env.VITE_BUILD;
  return typeof value === "string" && value.trim() && value.trim() !== "unknown" ? value.trim() : "";
}

const RELOADED_KEY = "webnestdev:reloaded-for";
/** Редко и дёшево: `/api/version` отдаёт только номер сборки, без Docker, базы и метрик. */
const POLL_MS = 120_000;

export type BuildWatchOptions = {
  /** Сборка этой вкладки; по умолчанию — зашитая в бандл. */
  build?: () => string;
  /** Как узнать сборку на сервере. */
  fetchBuild?: () => Promise<string>;
  /** Что сделать, когда сборки разошлись; по умолчанию — перезагрузка с обходом кэша. */
  reload?: (build: string) => void;
  /** Куда помнить попытку перезагрузки; по умолчанию `sessionStorage`. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  pollMs?: number;
};

/**
 * Адрес с меткой сборки: параметр заодно обходит кэш, который считает разные адреса разными
 * документами. `replace` — чтобы у пользователя не появлялась история из перезагрузок.
 */
export function reloadForBuild(build: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("v", build);
  window.location.replace(url.toString());
}

/** Сборка, которая работает на сервере сейчас. Без кэша: иначе ответило бы то же самое значение. */
export async function fetchRunningBuild(): Promise<string> {
  const response = await fetch(apiUrl("/api/version"), { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) return "";
  const data = (await response.json().catch(() => null)) as { build?: unknown } | null;
  return typeof data?.build === "string" ? data.build.trim() : "";
}

/**
 * Начинает следить за сборкой: сразу, при возвращении к вкладке и по таймеру. Возвращает остановку —
 * её ставит React в cleanup эффекта. Если версия не передана при сборке, наблюдение выключено, чтобы
 * локальная разработка и `vite build` без SHA не перезагружали страницу сами.
 */
export function watchForNewBuild(options: BuildWatchOptions = {}) {
  const loaded = (options.build ?? loadedBuild)();
  if (!loaded) return () => {};
  const fetchBuild = options.fetchBuild ?? fetchRunningBuild;
  const reload = options.reload ?? reloadForBuild;
  const storage = options.storage ?? window.sessionStorage;
  let stopped = false;

  const check = async () => {
    if (stopped || document.visibilityState !== "visible") return;
    const served = await fetchBuild().catch(() => "");
    // Ответ мог прийти уже после остановки: ничего не делаем, вкладку могли закрыть.
    if (stopped) return;
    if (!served || served === loaded) {
      // Ничего не устарело — и метка попытки больше не нужна: следующая выкатка получит свой шанс.
      try { storage.removeItem(RELOADED_KEY) } catch {}
      return;
    }
    let reloadedFor = "";
    try { reloadedFor = storage.getItem(RELOADED_KEY) ?? "" } catch {}
    if (reloadedFor === served) return;
    try { storage.setItem(RELOADED_KEY, served) } catch {}
    stopped = true;
    reload(served);
  };

  const onVisible = () => { if (document.visibilityState === "visible") void check() };
  void check();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  // Шаг назад/вперёд восстанавливает страницу из кэша целиком, без запроса к сети (`pageshow` с
  // `persisted`): без этого возврат по истории показывал бы сборку до выкатки сколько угодно долго.
  window.addEventListener("pageshow", onVisible);
  const timer = window.setInterval(() => void check(), options.pollMs ?? POLL_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    window.removeEventListener("pageshow", onVisible);
  };
}
