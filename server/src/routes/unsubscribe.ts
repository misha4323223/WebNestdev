import type { FastifyInstance } from "fastify";
import { addSuppression, findSuppression } from "../mail/mail-store.js";
import { readUnsubscribeToken } from "../mail/render.js";

/**
 * Страница отписки — адрес, на который ведёт ссылка из каждого письма рассылки.
 *
 * Ссылка подписана (`t=<адрес>.<HMAC>`, см. mail/render.ts), поэтому список выданных ссылок
 * хранить не нужно, а подставить чужой адрес нельзя: без ключа подпись не сойдётся.
 *
 * Отписка делается кнопкой, а не самим открытием страницы. Причина не в лишнем клике: почтовые
 * сервисы и антивирусы сами открывают ссылки из писем, чтобы проверить их, и отписка по GET
 * срабатывала бы от такой проверки — человек продолжал бы получать письма, уже ничего не понимая.
 * Токен передаётся в адресе и на POST: тело формы не разбирается, потому что это единственный
 * маршрут платформы, куда приходит обычная HTML-форма, а не JSON.
 *
 * Страница отдаётся сервером, а не панелью: ссылка из письма должна открываться и на телефоне, и
 * без сессии, и в письме — только адрес, без параметров сборки панели.
 */

const PALETTE = {
  background: "#0b0d10",
  panel: "#0e1014",
  line: "#2e2822",
  text: "#e8eaed",
  muted: "#8b929c",
  accent: "#ccc3b2",
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function page(title: string, content: string) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;background:${PALETTE.background};color:${PALETTE.text};
       font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:480px;background:${PALETTE.panel};border:1px solid ${PALETTE.line};
        border-radius:14px;padding:28px}
  h1{margin:0 0 12px;font-size:20px;line-height:1.3}
  p{margin:0 0 14px;color:${PALETTE.text}}
  .muted{color:${PALETTE.muted};font-size:14px}
  .address{display:inline-block;margin:2px 0 16px;padding:6px 10px;border-radius:8px;
           border:1px solid ${PALETTE.line};background:#13171c;font-size:14px;word-break:break-all}
  button{font:inherit;font-weight:600;color:#12151a;background:${PALETTE.accent};border:0;
         border-radius:10px;padding:11px 18px;cursor:pointer}
  button:hover{background:#dbd3c4}
  a{color:${PALETTE.accent}}
</style>
</head>
<body><div class="card">${content}</div></body>
</html>`;
}

export async function registerUnsubscribeRoutes(app: FastifyInstance) {
  app.get("/unsubscribe", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const query = request.query as Record<string, unknown>;
    const token = typeof query.t === "string" ? query.t : "";
    const email = readUnsubscribeToken(token);
    if (!email) {
      return reply.code(400).type("text/html; charset=utf-8").send(
        page(
          "Ссылка недействительна",
          "<h1>Ссылка не сработала</h1>" +
            "<p>Ссылку из письма, скорее всего, разорвал почтовый сервис или она устарела.</p>" +
            '<p class="muted">Откройте письмо и нажмите «Отписаться» ещё раз — или ответьте на него, и мы отпишем вас вручную.</p>',
        ),
      );
    }

    const existing = await findSuppression(email);
    if (existing) {
      return reply.type("text/html; charset=utf-8").send(
        page(
          "Вы уже отписаны",
          "<h1>Вы уже отписаны</h1>" +
            "<p>На адрес <span class=\"address\">" + escapeHtml(email) + "</span> рассылка не приходит.</p>" +
            '<p class="muted">Если письма всё ещё приходят, ответьте на любое из них — разберёмся.</p>',
        ),
      );
    }

    // Один клик по кнопке: форма отправляется на тот же адрес с тем же токеном, тело не нужно.
    const action = "/unsubscribe?t=" + encodeURIComponent(token);
    return reply.type("text/html; charset=utf-8").send(
      page(
        "Отписка от рассылки",
        "<h1>Отписаться от рассылки NestDev?</h1>" +
          "<p>Письма о новостях и обновлениях платформы перестанут приходить на адрес</p>" +
          '<span class="address">' + escapeHtml(email) + "</span>" +
          '<form method="post" action="' + escapeHtml(action) + '"><button type="submit">Отписаться</button></form>' +
          '<p class="muted" style="margin-top:18px">Важные письма об оплате и работе сервиса приходят отдельно: это служебные уведомления, а не рассылка.</p>',
      ),
    );
  });

  app.post("/unsubscribe", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const query = request.query as Record<string, unknown>;
    const token = typeof query.t === "string" ? query.t : "";
    const email = readUnsubscribeToken(token);
    if (!email) {
      return reply.code(400).type("text/html; charset=utf-8").send(
        page(
          "Ссылка недействительна",
          "<h1>Ссылка не сработала</h1><p>Отписка не записана: подпись ссылки не сошлась.</p>",
        ),
      );
    }
    await addSuppression(email, "unsubscribed", "ссылка из письма");
    request.log.info({ email }, "mail unsubscribe");
    return reply.type("text/html; charset=utf-8").send(
      page(
        "Вы отписаны",
        "<h1>Готово, вы отписаны</h1>" +
          "<p>Адрес <span class=\"address\">" + escapeHtml(email) + "</span> больше не получит рассылку.</p>" +
          '<p class="muted">Передумаете — напишите в поддержку, и мы вернём письма.</p>',
      ),
    );
  });
}
