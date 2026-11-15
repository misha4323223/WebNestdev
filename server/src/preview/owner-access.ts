import { isLocalPreviewOwner } from "./preview-owner.js";
import { previewPublicUrl } from "./preview-host.js";
import { mintPreviewTicket, PREVIEW_TICKET_COOKIE } from "./preview-ticket.js";
import type { PreviewStatus } from "./types.js";

/**
 * Адрес, по которому серверная проверка может увидеть preview, и cookie для публичной двери.
 *
 * Прямой `host:port` из `PreviewStatus` пригоден только на той реплике, где живёт listener
 * (hybrid/static) или контейнер (container). На второй ноде тот же `127.0.0.1:<port>` — это
 * чужой процесс, и проверка ошибочно сообщает «preview недоступен», хотя панель открывает
 * приложение. Для чужого владельца используем публичный адрес проекта: он всегда идёт через
 * owner-aware дверь, которая пересылает запрос на ноду-владельца. Cookie даёт проверке доступ
 * к этому конкретному проекту, не расширяя сессию панели на домен preview.
 *
 * `source` нужен диагностике и метрикам: локальная проверка и проверка через owner — разные
 * пути, и в отчёте агента не должно быть одного неразличимого «fetch failed».
 */
export type PreviewAccessSource = "local" | "owner";

export type PreviewAccessCookie = { name: string; value: string };

export type PreviewAccess = {
  source: PreviewAccessSource;
  /** Корень для браузера: локальный адрес или публичный адрес проекта. */
  baseUrl: string;
  /** Путь проекта относительно корня; наружу абсолютные URL не пропускаются. */
  urlFor: (path: string) => string;
  /** Cookie только для публичной двери; в локальном режиме её нет. */
  cookie?: PreviewAccessCookie;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
};

export type PreviewAccessDeps = {
  fetch: typeof fetch;
  publicUrl: (projectId: string) => string;
  isLocalOwner: (owner: string | undefined) => boolean;
  mintTicket: (projectId: string) => string;
  ownerAware: boolean;
};

const defaultDeps: Omit<PreviewAccessDeps, "ownerAware"> = {
  fetch,
  publicUrl: previewPublicUrl,
  isLocalOwner: isLocalPreviewOwner,
  mintTicket: mintPreviewTicket,
};

/**
 * Аварийный выключатель для выкатки: `PREVIEW_OWNER_AWARE=0` возвращает прежний прямой путь.
 * По умолчанию owner-aware включён: без него вторая нода не может проверить чужой preview.
 */
export function ownerAwarePreviewEnabled(raw = process.env.PREVIEW_OWNER_AWARE): boolean {
  return raw?.trim() !== "0";
}

function hostForUrl(host: string): string {
  const value = host.trim() || "127.0.0.1";
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

/** Путь проверки без схемы и хоста: инструменты не должны превращаться в открытый прокси. */
export function previewCheckPath(path: string): string {
  const value = path.trim();
  if (!value) return "/";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error("Путь проверки preview не может быть абсолютным URL");
  }
  return value.startsWith("/") ? value : "/" + value;
}

function joinPath(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + previewCheckPath(path);
}

/**
 * Собирает доступ к preview по статусу из общего реестра. Если владелец другой, публичный адрес
 * обязателен: тихо ходить на локальный порт нельзя — именно это давало ложные провалы на второй
 * ноде.
 */
export function previewAccessFor(
  projectId: string,
  status: PreviewStatus,
  overrides: Partial<PreviewAccessDeps> = {},
): PreviewAccess {
  if (!status.running) throw new Error("Предпросмотр не запущен");
  // Флаг читается при вызове, а не при импорте: иначе значение, загруженное из окружения
  // позже старта модуля, не смогло бы выключить owner-aware путь без перезапуска процесса.
  const deps: PreviewAccessDeps = {
    ...defaultDeps,
    ownerAware: ownerAwarePreviewEnabled(),
    ...overrides,
  };
  const remote = deps.ownerAware && Boolean(status.ownerAddress) && !deps.isLocalOwner(status.ownerAddress);

  if (!remote) {
    if (!status.host || !status.port) {
      throw new Error("У запущенного предпросмотра нет доступного адреса");
    }
    const baseUrl = `http://${hostForUrl(status.host)}:${status.port}`;
    const urlFor = (path: string) => joinPath(baseUrl, path);
    return {
      source: "local",
      baseUrl,
      urlFor,
      fetch: (path, init) => deps.fetch(urlFor(path), init),
    };
  }

  const baseUrl = deps.publicUrl(projectId).replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "Предпросмотр принадлежит другой ноде, а PREVIEW_PUBLIC_DOMAIN не задан: проверка с этой реплики невозможна",
    );
  }
  const ticket = deps.mintTicket(projectId);
  if (!ticket) throw new Error("Не удалось выпустить билет доступа к предпросмотру");
  const cookie = { name: PREVIEW_TICKET_COOKIE, value: ticket };
  const urlFor = (path: string) => joinPath(baseUrl, path);
  return {
    source: "owner",
    baseUrl,
    urlFor,
    cookie,
    fetch: (path, init = {}) => {
      const headers = new Headers(init.headers);
      // Инструменты не передают cookie приложения; билет — только доказательство доступа к
      // публичной двери. Не перезаписываем явно заданную cookie, чтобы не ломать будущие вызовы.
      if (!headers.has("cookie")) {
        headers.set("cookie", cookie.name + "=" + encodeURIComponent(cookie.value));
      }
      return deps.fetch(urlFor(path), { ...init, headers });
    },
  };
}
