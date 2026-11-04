/**
 * Первое сообщение агенту для нового проекта.
 *
 * Идея — это не только имя проекта: агент открывается сразу в планировщике и сам спрашивает,
 * что именно нужно, вместо пустого чата, где человек писал бы то же самое второй раз. Здесь же
 * едет контекст знакомства (роль, опыт, цель), чтобы первый план не приходилось переписывать.
 */
export function ideaKickoff(idea: string, context?: string) {
  return `${idea.trim()}${context ? `\n\n${context}` : ""}\n\nЭто первый запрос по новому проекту. Сейчас нужен только план: не изучай файлы, не упоминай, что проект пуст, и не пиши промежуточных рассуждений. Задай через question.ask два коротких вопроса по одному — для кого продукт и какие разделы и данные важны, затем какой стиль и тон. После ответов собери резюме проекта через plan.update: цель и аудитория, страницы и экраны, данные, интеграции, визуальный стиль, проверка. Все пункты оставь pending и не начинай разработку.`;
}

/**
 * Служебные части автозапуска, которые не должен видеть человек.
 *
 * Первое сообщение проекта — это не реплика пользователя: шаблон, импорт и знакомство складывают
 * туда инструкции планировщику, контекст анкеты и пути загруженных файлов. Модель обязана их
 * получить, а в переписке они выглядят как чужой промт, поэтому чат показывает только смысл:
 * идею проекта или короткую подпись автозапуска. История при этом не меняется — на сервер уходит
 * исходный текст, и агент по-прежнему видит все инструкции.
 */
export type PublicAttachment = {
  /** Путь в проекте или публичная ссылка из хранилища. */
  path: string;
  image: boolean;
  remote: boolean;
};

export type PublicMessage = {
  text: string;
  /** true — сообщение целиком служебное и в закладках-запросах ему делать нечего. */
  internal: boolean;
  /** Вложения, восстановленные из служебного хвоста: по ним чат показывает превью. */
  attachments: PublicAttachment[];
};

const plannerTail = /\s*Сначала работай в режиме планировщика[\s\S]*$/;
// Задачу «собрать тему» запускает кнопка панели «Тема», а не пользователь: в переписке ей хватает
// одной строки, хотя модели уходит весь текст с шагами (см. lib/agent-compose.ts).
const themeSetup = /^Собери тему проекта/;
const onboardingContext = /\s*Контекст из знакомства при входе\.[\s\S]*?(?=\s*(?:Сначала работай в режиме планировщика|$))/;
const attachmentTail = /\s*Эти файлы уже (?:доступны|лежат в проекте, используй их по путям):\s*([\s\S]*)$/;
const imageFile = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[?#].*)?$/i;

function parseAttachments(tail: string): PublicAttachment[] {
  const attachments: PublicAttachment[] = [];
  for (const line of tail.split("\n")) {
    const match = /^-\s+(.+?)\s+\((изображение в проекте|файл в проекте|изображение по публичной ссылке|файл по публичной ссылке|публичная ссылка в хранилище)\)\s*$/.exec(line);
    if (!match) continue;
    const attachmentPath = match[1] ?? "";
    const label = match[2] ?? "";
    const remote = label.includes("ссылк");
    attachments.push({
      path: attachmentPath,
      image: label.startsWith("изображение") || (label === "публичная ссылка в хранилище" && imageFile.test(attachmentPath)),
      remote,
    });
  }
  return attachments;
}

export function publicUserMessage(raw: string): PublicMessage {
  const text = raw.trim();
  if (/^Разверни проект по квизу\./.test(text)) return { text: "Развернуть проект по выбранным параметрам", internal: false, attachments: [] };
  if (/^Продолжи развёртывание по квизу\./.test(text)) return { text: "Продолжить развёртывание", internal: false, attachments: [] };
  if (/^План утверждён\./.test(text)) return { text: "План утверждён — начинаю разработку", internal: true, attachments: [] };
  const repository = /^Импортирован репозиторий GitHub:\s*([^\s(]+)/.exec(text);
  if (repository) return { text: "Импорт репозитория " + repository[1], internal: true, attachments: [] };
  const template = /^Быстрый старт(?:\s*:\s*[^→]+→\s*|\s+по шаблону\s*)«([^»]+)»/.exec(text);
  if (template) return { text: "Шаблон «" + template[1] + "»", internal: true, attachments: [] };
  if (themeSetup.test(text)) return { text: "Собрать тему проекта", internal: true, attachments: [] };
  const attachmentMatch = attachmentTail.exec(text);
  const attachments = attachmentMatch ? parseAttachments(attachmentMatch[1] ?? "") : [];
  const visible = text
    .replace(plannerTail, "")
    .replace(onboardingContext, "")
    .replace(attachmentTail, "")
    .trim();
  // `internal` относится ко всему сообщению, а не к вырезанной части: идея проекта и текст
  // с прикреплёнными файлами остаются запросами пользователя, даже если служебный хвост у них убран.
  const fallback = attachments.some(item => item.image) ? "Изображение" : attachments.length ? "Файл" : "Новая задача";
  return { text: visible || fallback, internal: !visible && attachments.length === 0, attachments };
}
