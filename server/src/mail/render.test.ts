import test from "node:test";
import assert from "node:assert/strict";
import { readUnsubscribeToken, renderSubject, renderText, textToHtml, unknownTags, unsubscribeFooter, unsubscribeToken, unsubscribeUrl } from "./render.js";

/**
 * Подстановки и отписка. Неизвестный тег не выбрасывается — админка предупреждает о нём до
 * отправки, а письмо с `{{plan}}` посередине всё равно честнее письма с дыркой.
 */

const tags = { name: "Иван", email: "ivan@nestdev.ru", project: "Магазин", plan: "Плюс" };

test("известные теги раскрываются, неизвестные остаются как есть", () => {
  assert.equal(renderSubject("{{name}}, тариф {{plan}}", tags), "Иван, тариф Плюс");
  assert.equal(renderText("Здравствуйте, {{name}}!\\n\\nВаш проект: {{project}}.", tags), "Здравствуйте, Иван!\\n\\nВаш проект: Магазин.");
  assert.equal(renderText("Привет, {{ник}}", tags), "Привет, {{ник}}");
  assert.deepEqual(unknownTags("{{name}} и {{ник}} или {{ Итого }}"), ["ник", "Итого"]);
  assert.deepEqual(unknownTags("{{name}} {{email}} {{project}} {{plan}} {{unsubscribe}}"), []);
});

test("HTML-версия ссылку отписки делает ссылкой, а теги экранирует", () => {
  const url = "https://nestdev.ru/unsubscribe?t=abc.def";
  const html = textToHtml("Оплата < 990 ₽\\n\\n" + unsubscribeFooter(url), url);
  assert.match(html, /&lt; 990/);
  assert.match(html, new RegExp('<a href="' + url.replace(/[.?]/g, "\\$&") + '">'));
  assert.match(html, /<p>/);
});

test("ссылка отписки подписана и подпись проверяется", () => {
  const token = unsubscribeToken("Ivan@NestDev.ru");
  assert.equal(readUnsubscribeToken(token), "ivan@nestdev.ru", "адрес нормализуется и при выдаче, и при проверке");
  assert.equal(readUnsubscribeToken(token.replace(/.$/, "0")), null, "подделанная подпись не проходит");
  assert.equal(readUnsubscribeToken("не-токен"), null);
  assert.equal(readUnsubscribeToken(""), null);
  assert.match(unsubscribeUrl("https://nestdev.ru/", "ivan@nestdev.ru"), /^https:\/\/nestdev\.ru\/unsubscribe\?t=/);
});
