import type { PlanState } from "../types.js";

/**
 * Тема коммита для автоматической точки после задачи.
 *
 * Раньше в тему попадала первая строка запроса пользователя, обрезанная до 140 символов. В
 * истории проекта это выглядело как кусок переписки («Привет! У меня есть проект на React,
 * помоги…»), а не как описание сделанного. Здесь тема собирается из плана задачи: его пункты
 * модель уже формулирует коротко и по делу, и они относятся к изменениям, а не к просьбе.
 *
 * Если плана нет (мелкая задача в одно действие), берётся первое предложение запроса — без
 * markdown, ссылок и служебных обёрток импорта. Ограничение в 72 символа — обычная длина темы
 * коммита: длиннее git-клиенты обрезают сами, и тогда теряется конец фразы, а не её смысл.
 */

const MAX_SUBJECT_CHARS = 72;

function clip(value: string, limit = MAX_SUBJECT_CHARS) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(" ");
  const head = boundary >= limit / 2 ? cut.slice(0, boundary) : cut;
  return head.replace(/[\s,;:.–—-]+$/, "") + "…";
}

/** Первая буква заглавная: тема коммита — предложение, а не продолжение чата. */
function sentenceCase(value: string) {
  const text = value.trim();
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Пункты плана, которые действительно сделаны: незавершённые в тему не попадают. Служебные шаги
 * («изучить проект», «проверить сборку») тоже не описывают изменение, поэтому в тему идут только
 * рабочие пункты — и не больше двух, чтобы она оставалась темой.
 */
const SERVICE_STEP = /^(изуч|прочит|проанализир|посмотр|провер|протест|запуст|откры|собер|убед)/i;

function planSubject(plan: PlanState) {
  const titles = plan.items
    .filter(item => item.status === "done")
    .map(item => item.title.replace(/^[\s\d.)-]+/, "").trim())
    .filter(title => title && !SERVICE_STEP.test(title));
  return [...new Set(titles)].slice(0, 2).join("; ");
}

/**
 * Убирает из запроса то, что не является описанием работы: заголовки markdown, код, ссылки,
 * служебную первую строку импорта и обёртку «Что сделать с проектом».
 */
function cleanTask(task: string) {
  let value = task.replace(/\r/g, "").trim();
  // Импорт добавляет к запросу свой заголовок. Пользователь его не писал, и в истории проекта
  // он повторялся бы в каждой задаче, начатой сразу после импорта.
  if (/^импортирован репозиторий/i.test(value)) {
    const rest = value.split(/\n\s*\n/).slice(1).join("\n");
    value = rest.trim() || value;
  }
  value = value
    .replace(/^что сделать с проектом:\s*/i, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    // Заголовок — это рубрика, а не описание работы: строку убираем целиком.
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, "")
    .replace(/^\s{0,3}(>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__/g, "");
  let first = value.split(/\n/).map(line => line.trim()).find(Boolean) ?? "";
  // Приветствие — не дело: «Привет! Добавь кнопку» в истории должно выглядеть как «Добавь кнопку».
  first = first.replace(/^(привет|здравствуйте|добрый день|добрый вечер|хай)[!,.\s]*/i, "").trim();
  first = first.replace(/^(пожалуйста|будь добр|будьте добры)[,.\s]*/i, "").trim();
  // Первое предложение: точка/вопрос/восклицание, после которого начинается новое. Точка в
  // «src/app.ts» или «v1.2» предложением не считается — там нет пробела после знака.
  const sentence = first.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? first;
  return sentenceCase(clip(sentence, 140));
}

export function commitSubject(options: {
  task: string;
  plan?: PlanState;
  planFromPreviousRun?: boolean;
}): string {
  // План прошлого запуска — не описание этой работы: он остался в рабочей памяти как контекст,
  // но модель могла его не обновлять.
  const planned = options.plan && !options.planFromPreviousRun ? planSubject(options.plan) : "";
  return clip(planned || cleanTask(options.task) || "Изменения проекта");
}
