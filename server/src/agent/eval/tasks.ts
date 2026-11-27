import type { EvalTask, EvalTaskSize } from "./types.js";

/**
 * The baseline catalog from `docs/AI_AGENT_CAPABILITY_PLAN.md`.
 *
 * The catalog is intentionally repository-agnostic: `repo` is an `eval://` identifier that an
 * adapter maps to a prepared fixture or a checkout of a real repository. Keeping the tasks here,
 * rather than inside a runner, makes the suite comparable between the old and the new agent — the
 * only thing that changes is the adapter.
 *
 * Prompts are written the way a user writes them. Do not add implementation hints to make a stage
 * look better: a task that only passes with hints is not the task the product has to solve.
 */
export const EVAL_TASKS: EvalTask[] = [
  // 8 × landing: one-page sites and small frontends.
  {
    id: "landing-contact-section",
    title: "Секция контактов на лендинге",
    size: "landing",
    prompt: "Добавь на лендинг секцию контактов с формой и ссылками на соцсети. На мобильном всё должно оставаться читаемым.",
    verify: ["npm run build"],
    repo: "eval://landing-basic",
    expectedFiles: ["index.html"],
    maxMinutes: 5,
    tags: ["frontend", "responsive"],
  },
  {
    id: "landing-mobile-nav",
    title: "Мобильная навигация",
    size: "landing",
    prompt: "Сделай навигацию удобной на телефоне: сейчас меню не помещается и перекрывает заголовок.",
    verify: ["npm run build"],
    repo: "eval://landing-basic",
    maxMinutes: 5,
    tags: ["frontend", "responsive", "bug"],
  },
  {
    id: "landing-form-validation",
    title: "Валидация формы",
    size: "landing",
    prompt: "Добавь проверку формы обратной связи: обязательные поля, понятные ошибки и состояние отправки. Без сторонних библиотек.",
    verify: ["npm run build"],
    repo: "eval://landing-form",
    maxMinutes: 7,
    tags: ["frontend", "accessibility"],
  },
  {
    id: "landing-seo-meta",
    title: "SEO-метаданные",
    size: "landing",
    prompt: "Приведи SEO-метаданные в порядок: title, description, Open Graph и canonical для главной и страницы услуг.",
    verify: ["npm run build"],
    repo: "eval://landing-multi-page",
    expectedFiles: ["index.html", "services.html"],
    maxMinutes: 5,
    // SEO-правка без прогона seo.check — это «сделал и надеюсь»; внешний деплой здесь не нужен.
    mustCall: ["seo.check"],
    mustNotCall: ["deploy.plan"],
    tags: ["frontend", "seo"],
  },
  {
    id: "landing-theme-tokens",
    title: "Тёмная тема через токены",
    size: "landing",
    prompt: "Добавь переключение светлой и тёмной темы. Цвета должны браться из токенов, а выбор — сохраняться после перезагрузки.",
    verify: ["npm run build"],
    repo: "eval://landing-theme",
    maxMinutes: 7,
    tags: ["frontend", "css"],
  },
  {
    id: "landing-pricing",
    title: "Блок тарифов",
    size: "landing",
    prompt: "Сверстай блок из трёх тарифов с выделенным средним и адаптивной сеткой. Тексты возьми из README.",
    verify: ["npm run build"],
    repo: "eval://landing-basic",
    maxMinutes: 5,
    tags: ["frontend", "layout"],
  },
  {
    id: "landing-broken-cta",
    title: "Не работает кнопка на первом экране",
    size: "landing",
    prompt: "Кнопка «Оставить заявку» на первом экране ничего не делает. Найди причину и исправь, не меняя остальную вёрстку.",
    verify: ["npm run build"],
    repo: "eval://landing-bug",
    maxMinutes: 5,
    mustCall: ["project.verify"],
    mustNotCall: ["deploy.plan"],
    tags: ["frontend", "bug", "debugging"],
  },
  {
    id: "landing-image-assets",
    title: "Битые изображения",
    size: "landing",
    prompt: "На странице не отображаются изображения из секции «Работы». Исправь пути и добавь alt, не скачивая новые картинки.",
    verify: ["npm run build"],
    repo: "eval://landing-assets",
    maxMinutes: 5,
    tags: ["frontend", "assets", "bug"],
  },

  // 8 × MVP: a small full-stack product with storage, API and states.
  {
    id: "mvp-auth-crud",
    title: "Личный кабинет с CRUD",
    size: "mvp",
    prompt: "Добавь вход и личный кабинет со списком заметок: создание, редактирование и удаление. Показывай пустое состояние и ошибки.",
    verify: ["npm test", "npm run build"],
    repo: "eval://mvp-notes",
    maxMinutes: 10,
    // Хранение данных: соединение проверяется до кода, а не после падения запроса.
    mustCall: ["database.status"],
    tags: ["fullstack", "auth", "crud"],
  },
  {
    id: "mvp-api-validation",
    title: "Валидация API",
    size: "mvp",
    prompt: "API принимает пустые и некорректные поля. Добавь валидацию на сервере и понятные ошибки для клиента.",
    verify: ["npm test"],
    repo: "eval://mvp-api",
    maxMinutes: 8,
    tags: ["backend", "validation"],
  },
  {
    id: "mvp-db-migration",
    title: "Миграция без потери данных",
    size: "mvp",
    prompt: "Нужно добавить поле статуса к заказам. Сделай миграцию, которая не теряет существующие заказы и заполняет статус разумным значением.",
    verify: ["npm test", "npm run migrate"],
    repo: "eval://mvp-orders",
    maxMinutes: 10,
    mustCall: ["database.status"],
    tags: ["database", "migration"],
  },
  {
    id: "mvp-search-filter",
    title: "Поиск и фильтры",
    size: "mvp",
    prompt: "Добавь поиск по названию и фильтр по категории в список товаров. Состояние фильтров должно сохраняться в URL.",
    verify: ["npm test", "npm run build"],
    repo: "eval://mvp-catalog",
    maxMinutes: 10,
    tags: ["fullstack", "search", "state"],
  },
  {
    id: "mvp-upload",
    title: "Загрузка файлов",
    size: "mvp",
    prompt: "Добавь загрузку аватара: проверка типа и размера, сохранение и показ текущего изображения. Ошибки должны быть понятны пользователю.",
    verify: ["npm test", "npm run build"],
    repo: "eval://mvp-upload",
    maxMinutes: 10,
    tags: ["fullstack", "files"],
  },
  {
    id: "mvp-email",
    title: "Письмо после заказа",
    size: "mvp",
    prompt: "После оформления заказа отправляй письмо с номером и составом заказа. Ключ провайдера уже есть в окружении; не печатай его.",
    verify: ["npm test"],
    repo: "eval://mvp-orders",
    maxMinutes: 8,
    // Ключ уже в окружении: сначала посмотреть имена секретов, а не просить ключ в чате.
    mustCall: ["service.secrets"],
    mustNotCall: ["secrets.request"],
    tags: ["backend", "email", "secrets"],
  },
  {
    id: "mvp-regression-test",
    title: "Сломанный сценарий",
    size: "mvp",
    prompt: "Пользователи не могут повторно войти после выхода: сессия остаётся, но приложение считает пользователя гостем. Найди и исправь, добавь тест.",
    verify: ["npm test"],
    repo: "eval://mvp-auth-bug",
    maxMinutes: 10,
    tags: ["fullstack", "bug", "tests"],
  },
  {
    id: "mvp-error-states",
    title: "Состояния загрузки и ошибок",
    size: "mvp",
    prompt: "При медленном API экран выглядит зависшим, а ошибка показывается только в консоли. Добавь скелетоны, повтор и понятное сообщение.",
    verify: ["npm run build", "npm test"],
    repo: "eval://mvp-dashboard",
    maxMinutes: 8,
    tags: ["frontend", "ux"],
  },

  // 8 × large: multiple modules, a real change with a regression check.
  {
    id: "large-refactor-module",
    title: "Выделение модуля",
    size: "large",
    prompt: "Вынеси работу с платежами из контроллера в отдельный модуль с тестами. Поведение API не должно измениться.",
    verify: ["npm test", "npm run build"],
    repo: "eval://large-shop",
    maxMinutes: 10,
    tags: ["refactor", "backend", "tests"],
  },
  {
    id: "large-cross-file-bug",
    title: "Ошибка в нескольких файлах",
    size: "large",
    prompt: "После оформления заказа иногда списываются деньги, но заказ не создаётся. Разберись по логам и тестам и устрани причину.",
    verify: ["npm test"],
    repo: "eval://large-shop",
    maxMinutes: 10,
    tags: ["debugging", "cross-module", "transactions"],
  },
  {
    id: "large-feature-e2e",
    title: "Сквозная функция",
    size: "large",
    prompt: "Добавь возвраты: страница в админке, API, состояние заказа и письмо клиенту. Нужны тесты на основной сценарий и отказ.",
    verify: ["npm test", "npm run build"],
    repo: "eval://large-shop",
    maxMinutes: 10,
    mustCall: ["plan.update"],
    tags: ["fullstack", "feature", "tests"],
  },
  {
    id: "large-safe-migration",
    title: "Безопасная миграция схемы",
    size: "large",
    prompt: "Раздели имя пользователя на имя и фамилию, не ломая старые записи и текущий API. Нужен план отката.",
    verify: ["npm test", "npm run migrate"],
    repo: "eval://large-crm",
    maxMinutes: 10,
    mustCall: ["database.status"],
    tags: ["database", "migration", "backward-compatibility"],
  },
  {
    id: "large-api-version",
    title: "Версия API без поломки клиентов",
    size: "large",
    prompt: "Добавь v2 эндпоинта заказов с новым форматом, сохранив v1. Клиенты не должны заметить изменений.",
    verify: ["npm test"],
    repo: "eval://large-shop",
    maxMinutes: 10,
    tags: ["backend", "api", "compatibility"],
  },
  {
    id: "large-n-plus-one",
    title: "Медленный список",
    size: "large",
    prompt: "Список заказов открывается несколько секунд. Найди причину, измерь и ускорь, не меняя ответ API.",
    verify: ["npm test", "npm run benchmark"],
    repo: "eval://large-shop",
    maxMinutes: 10,
    tags: ["performance", "database", "measurement"],
  },
  {
    id: "large-test-coverage",
    title: "Тесты для опасного модуля",
    size: "large",
    prompt: "Модуль расчёта скидок почти не покрыт тестами. Добавь тесты на границы, округление и конфликтующие скидки; найденные ошибки исправь.",
    verify: ["npm test"],
    repo: "eval://large-shop",
    maxMinutes: 10,
    tags: ["tests", "backend"],
  },
  {
    id: "large-authz",
    title: "Проверка прав",
    size: "large",
    prompt: "Пользователь может открыть чужой заказ, изменив id в запросе. Закрой доступ на сервере и добавь регрессионные тесты.",
    verify: ["npm test"],
    repo: "eval://large-shop",
    maxMinutes: 10,
    tags: ["security", "backend", "tests"],
  },

  // 6 × monorepo: workspace boundaries, shared packages and build order.
  {
    id: "mono-shared-type",
    title: "Общий тип в monorepo",
    size: "monorepo",
    prompt: "Тип заказа продублирован в приложении и API и уже разошёлся. Вынеси его в общий пакет и обнови оба потребителя.",
    verify: ["npm test", "npm run build"],
    repo: "eval://mono-shop",
    maxMinutes: 10,
    tags: ["monorepo", "types", "refactor"],
  },
  {
    id: "mono-package-api",
    title: "Новый пакет",
    size: "monorepo",
    prompt: "Добавь пакет для форматирования денег и подключи его в двух приложениях. Сборка и тесты должны работать из корня.",
    verify: ["npm test", "npm run build"],
    repo: "eval://mono-shop",
    maxMinutes: 10,
    tags: ["monorepo", "packages", "build"],
  },
  {
    id: "mono-build-order",
    title: "Сборка падает только с нуля",
    size: "monorepo",
    prompt: "После чистого клонирования `npm run build` падает, а после повторного запуска проходит. Найди причину и сделай сборку воспроизводимой.",
    verify: ["npm run build"],
    repo: "eval://mono-build",
    maxMinutes: 10,
    tags: ["monorepo", "build", "debugging"],
  },
  {
    id: "mono-cross-package-bug",
    title: "Ошибка на границе пакетов",
    size: "monorepo",
    prompt: "Приложение получает от пакета данных undefined после обновления. Найди расхождение контракта и исправь его в источнике.",
    verify: ["npm test", "npm run build"],
    repo: "eval://mono-shop",
    maxMinutes: 10,
    tags: ["monorepo", "debugging", "types"],
  },
  {
    id: "mono-lint-typecheck",
    title: "Проверки в корне",
    size: "monorepo",
    prompt: "Сделай так, чтобы `npm run typecheck` и `npm run lint` из корня проверяли все пакеты и падали при ошибке хотя бы в одном.",
    verify: ["npm run typecheck", "npm run lint"],
    repo: "eval://mono-build",
    maxMinutes: 8,
    tags: ["monorepo", "ci", "types"],
  },
  {
    id: "mono-dependency-upgrade",
    title: "Обновление зависимости",
    size: "monorepo",
    prompt: "Обнови общий пакет до новой мажорной версии, исправь несовместимости и убедись, что все приложения собираются.",
    verify: ["npm test", "npm run build"],
    repo: "eval://mono-shop",
    maxMinutes: 10,
    tags: ["monorepo", "dependencies", "migration"],
  },

  // 6 × real NestDev tasks: the platform's own repository and production-shaped requests.
  {
    id: "real-custom-domain-stepper",
    title: "Статусы подключения домена",
    size: "real",
    prompt: "В карточке своего домена шаги подключения показывают разное состояние при уже активном домене. Приведи статусы к одному источнику правды.",
    verify: ["npm test", "npm run build"],
    repo: "eval://nestdev",
    maxMinutes: 10,
    tags: ["real", "frontend", "bug"],
  },
  {
    id: "real-preview-restore",
    title: "Восстановление preview",
    size: "real",
    prompt: "После восстановления проекта preview иногда остаётся старым. Найди, где теряется инвалидация, и исправь с тестом.",
    verify: ["npm test"],
    repo: "eval://nestdev",
    maxMinutes: 10,
    mustCall: ["project.verify"],
    tags: ["real", "backend", "bug"],
  },
  {
    id: "real-agent-tool",
    title: "Новый инструмент агента",
    size: "real",
    prompt: "Добавь read-only инструмент, который показывает карту символов файла. Он должен быть в каталоге, иметь тест и не ломать планировщик.",
    verify: ["npm test", "npm run build"],
    repo: "eval://nestdev",
    maxMinutes: 10,
    tags: ["real", "agent", "feature"],
  },
  {
    id: "real-db-recovery",
    title: "Проверка восстановления базы",
    size: "real",
    prompt: "После переключения на standby приложение работает, но часть запросов идёт в старую базу. Найди источник подключения и исправь.",
    verify: ["npm test"],
    repo: "eval://nestdev",
    maxMinutes: 10,
    mustCall: ["database.status"],
    tags: ["real", "database", "reliability"],
  },
  {
    id: "real-seo-mode",
    title: "SEO для проекта",
    size: "real",
    prompt: "Добавь в публикацию проекта корректные canonical и sitemap для выбранного режима рендеринга, не ломая SPA-маршруты.",
    verify: ["npm test", "npm run build"],
    repo: "eval://nestdev",
    maxMinutes: 10,
    mustCall: ["seo.check"],
    mustNotCall: ["deploy.plan"],
    tags: ["real", "seo", "fullstack"],
  },
  {
    id: "real-storage-guard",
    title: "Защита общего storage",
    size: "real",
    prompt: "После перезагрузки ноды каталог проекта остаётся пустым, пока storage не перемонтируется. Сделай проверку явной и восстановление безопасным.",
    verify: ["npm test"],
    repo: "eval://nestdev",
    maxMinutes: 10,
    tags: ["real", "infrastructure", "reliability"],
  },
];

/** The catalog is stable enough to be compared between runs; an accidental duplicate is a bug. */
export function validateEvalCatalog(tasks: EvalTask[] = EVAL_TASKS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id.trim()) problems.push("задача без id");
    if (ids.has(task.id)) problems.push("повтор id: " + task.id);
    ids.add(task.id);
    if (!task.prompt.trim()) problems.push(task.id + ": пустой prompt");
    if (!task.verify.length) problems.push(task.id + ": нет команд проверки");
    if (task.maxMinutes !== undefined && (task.maxMinutes <= 0 || task.maxMinutes > 10)) {
      problems.push(task.id + ": maxMinutes должен быть от 1 до 10");
    }
    const must = task.mustCall ?? [];
    const not = task.mustNotCall ?? [];
    if ([...must, ...not].some(name => !name.trim())) {
      problems.push(task.id + ": пустое имя инструмента в политике вызовов");
    }
    const overlap = must.filter(name => not.includes(name));
    if (overlap.length) {
      problems.push(task.id + ": инструмент одновременно обязательный и запрещённый: " + overlap.join(", "));
    }
  }
  if (tasks.length < 30 || tasks.length > 40) problems.push("в каталоге должно быть 30–40 задач, сейчас " + tasks.length);
  const sizes: EvalTaskSize[] = ["landing", "mvp", "large", "monorepo", "real"];
  for (const size of sizes) {
    if (!tasks.some(task => task.size === size)) problems.push("нет задач размера " + size);
  }
  return problems;
}

export type { EvalTask } from "./types.js";
