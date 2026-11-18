import type { IdleStopInfo } from "./idle-stop-marker.js";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);
}

/**
 * Страница по старой ссылке после остановки по простою. Отдельный документ, а не JSON-ошибка:
 * человек открыл preview в новой вкладке и должен понять, что это штатное завершение, а не
 * сломанный адрес или упавший проект.
 */
export function idleStoppedPage(info: IdleStopInfo): string {
  const runtime = info.mode === "container" || info.mode === "hybrid";
  const title = runtime ? "Контейнер остановлен после простоя" : "Предпросмотр остановлен после простоя";
  const text = "Он был остановлен после периода бездействия. Откройте панель проекта и запустите предпросмотр снова — эта ссылка заработает.";
  return "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<meta name=\"robots\" content=\"noindex,nofollow\"><title>" + escapeHtml(title) + "</title>" +
    "<style>" +
    "html,body{margin:0;min-height:100%;background:#0b0f14;color:#e8eef6}" +
    "body{display:grid;place-items:center;padding:24px;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;" +
    "background-image:radial-gradient(50% 42% at 50% 0%,rgba(204,195,178,.09),transparent 70%)}" +
    "main{width:min(34rem,100%);padding:34px 28px;text-align:center;border:1px solid #2c3038;border-radius:16px;" +
    "background:linear-gradient(180deg,#131820,#0e1218);box-shadow:0 24px 70px rgba(0,0,0,.38)}" +
    ".mark{width:58px;height:58px;margin:0 auto 18px;display:grid;place-items:center;border:1px solid #4a402e;" +
    "border-radius:50%;background:radial-gradient(circle at 50% 28%,#232a33,#14191f);color:#c9bda8;font-size:25px}" +
    ".eyebrow{margin:0 0 8px;color:#9b8d74;font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}" +
    "h1{margin:0 0 12px;font-size:22px;line-height:1.25;font-weight:600}" +
    "p{margin:0;color:#9fb0c3;font-size:14px}" +
    ".note{margin-top:18px;color:#6f7b88;font-size:12px}" +
    "</style></head><body><main>" +
    "<div class=\"mark\" aria-hidden=\"true\">◷</div>" +
    "<p class=\"eyebrow\">NESTDEV · PREVIEW</p>" +
    "<h1>" + escapeHtml(title) + "</h1>" +
    "<p>" + escapeHtml(text) + "</p>" +
    "<p class=\"note\">Предпросмотр не запущен. Это не ошибка проекта.</p>" +
    "</main></body></html>";
}
