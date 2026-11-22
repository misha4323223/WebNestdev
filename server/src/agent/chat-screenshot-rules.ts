/**
 * Финальный кадр в переписке — часть результата, а не служебный лог.
 *
 * Агент уже умеет снимать страницу для собственной проверки, но такой PNG оставался в
 * дереве проекта: человек видел только путь. Здесь правило связывает проверку, показ
 * снимка в чате и ссылку на ту же страницу, чтобы после визуальной правки не приходилось
 * искать предпросмотр вручную.
 */
export const CHAT_SCREENSHOT_RULES =
  " FINAL SCREENSHOT IN CHAT: when a task changed a visible page, finish with a real frame of the running Preview. After project.verify or browser.runtime passes, call browser.screenshot with the route you changed and `show:true`; for responsive work take a second viewport and also pass `show:true` for the frame worth showing. The result carries `shownInChat` and `pageUrl`, and the panel shows the PNG with an “Открыть страницу” link. Then call ui.render with one preview block using the returned screenshot paths (desktop and mobile when both exist) and an actions block with 2–4 ready-to-send next steps when they are genuinely useful. The preview block itself links to the running page, so mention the same path in one short sentence instead of pasting the URL twice. Use `show:true` for the final frame, not for every intermediate diagnostic shot. If browser.screenshot fails or the Preview is unavailable, say plainly that the visual check and screenshot did not happen; never invent a screenshot, paste base64, or substitute an arbitrary image URL. A static page, a component demo and a full landing page all deserve this final frame; an API-only or terminal-only task does not.";
