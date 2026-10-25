import type {
  DeploymentArchitecture,
  DeploymentCloud,
  DeploymentDatabase,
  DeploymentDatabaseOption,
  DeploymentOptions,
  DeploymentProjectType,
  DeploymentService,
} from "./deployment-api";

export const DEPLOYMENT_BRIEF_PREFIX = "Разверни проект по квизу.";
export const DEPLOYMENT_RESUME_PREFIX = "Продолжи развёртывание по квизу.";

export type DeploymentHostingShape = "object" | "functions" | "object-functions" | "container" | "vm";

export type DeploymentChoice = {
  projectName: string;
  /** Архитектура, которую пользователь подтвердил или выбрал вручную. */
  architecture: DeploymentArchitecture;
  /** true — пользователь изменил автоопределение кнопкой «Выбрать». */
  manualType: boolean;
  projectType: DeploymentProjectType;
  hosting: { shape: DeploymentHostingShape; provider: DeploymentCloud };
  domain: { mode: "own" | "new" | "none"; value?: string };
  database: { mode: "connected" | "create" | "none"; option?: DeploymentDatabaseOption; current?: Extract<DeploymentDatabase, { connected: true }> };
  services: DeploymentService[];
  sms?: boolean;
  plan: DeploymentOptions["plan"];
  /** Пользователь выбрал «Новый план» вместо продолжения старого развёртывания. */
  freshStart?: boolean;
};

const ARCH_LABEL: Record<DeploymentArchitecture, string> = {
  static: "статический сайт",
  "static-functions": "статический фронтенд + Cloud Functions",
  functions: "API на Cloud Functions",
  server: "приложение с сервером",
  unknown: "тип проекта не определён",
};

const SHAPE_LABEL: Record<DeploymentHostingShape, string> = {
  object: "Object Storage + CDN",
  functions: "Cloud Functions",
  "object-functions": "Object Storage + CDN + Cloud Functions",
  container: "контейнер",
  vm: "виртуальная машина",
};

function domainLine(choice: DeploymentChoice) {
  if (choice.domain.mode === "none") return "без домена — использовать адрес провайдера";
  const value = choice.domain.value?.trim() || "уточнить у пользователя";
  return choice.domain.mode === "own"
    ? value + " (домен уже есть у пользователя)"
    : value + " (нужно подобрать и проверить; покупку делает пользователь)";
}

function databaseLine(choice: DeploymentChoice) {
  if (choice.database.mode === "none") return "не нужна";
  const target = choice.architecture === "server" ? "сервер" : "функции";
  if (choice.database.mode === "connected") {
    return choice.database.current
      ? "уже подключена — " + choice.database.current.engine + " · " + choice.database.current.host + " (database.env, переменные " + target + ")"
      : "уже подключена (database.env, переменные " + target + ")";
  }
  return "создать новую" + (choice.database.option ? " · " + choice.database.option.name : "") +
    "; строку подключения запиши в переменные " + target + " через database.env; если создать нельзя — запроси её через access.request kind=database";
}

function hostingLines(choice: DeploymentChoice) {
  const provider = choice.hosting.provider;
  // Yandex Cloud подключается отдельным видом доступа: у него свой формат ключа и свои
  // инструменты, поэтому kind=cloud с provider=yandex не сработает.
  const accessKind = provider.id === "yandex" ? "yandex" : "cloud";
  const connection = provider.connected ? " (уже подключено)" : " (доступа нет — запроси его через access.request kind=" + accessKind + ")";
  // Архитектура важнее автоопределения: при ручном выборе «статика + функции» фронтенд
  // остаётся статическим, даже если классификатор не нашёл index.html.
  const frontendStatic = choice.architecture !== "functions";
  if (choice.hosting.shape === "object") {
    return ["Размещение: статические файлы в Object Storage, раздача через CDN · " + provider.name + connection + "."];
  }
  if (choice.hosting.shape === "functions") {
    return ["Размещение: Cloud Functions — " + (choice.architecture === "static"
      ? "функция отдаёт файлы сайта"
      : "функции отдают API" + (frontendStatic ? " и могут отдавать статические файлы" : "")) + " · " + provider.name + connection + "."];
  }
  if (choice.hosting.shape === "object-functions") {
    return ["Размещение: статические файлы в Object Storage + CDN, API в Cloud Functions · " + provider.name + connection + "."];
  }
  if (choice.hosting.shape === "container") {
    return ["Размещение: контейнер · " + provider.name + connection + "."];
  }
  return ["Размещение: виртуальная машина · " + provider.name + connection + "."];
}

/**
 * API Gateway нужен только functions-архитектуре со своим доменом: он держит сертификат,
 * маршрутизирует /api/* в функцию и отдаёт остальное статике. Без домена достаточно публичного
 * адреса функции и бакета, поэтому лишний ресурс не навязывается.
 */
function gatewayLine(choice: DeploymentChoice) {
  const functions = choice.hosting.shape === "functions" || choice.hosting.shape === "object-functions";
  if (!functions) return "";
  if (choice.domain.mode === "none") {
    return "Без своего домена используй публичный адрес функции и бакета; API Gateway не обязателен.";
  }
  if (choice.hosting.provider.id !== "yandex") {
    return "Домен и маршруты: настрой HTTP-триггер функции и маршрутизацию на него по документации " + choice.hosting.provider.name + "; сертификат — там же.";
  }
  if (choice.hosting.shape === "object-functions") {
    return "Домен и маршруты: API Gateway → Cloud Functions (маршрут /api/* на функцию), статика — на бакет/CDN; сертификат и A/CNAME — на API Gateway.";
  }
  return "Домен и маршруты: API Gateway → Cloud Functions (все маршруты на функцию); сертификат и A/CNAME — на API Gateway.";
}

const SERVICE_CATEGORY_LABEL: Record<DeploymentService["category"], string> = {
  storage: "файлы",
  email: "письма",
  payments: "оплата",
  ai: "AI",
  maps: "карты",
  crm: "CRM",
};

function databaseName(choice: DeploymentChoice) {
  if (choice.database.mode === "connected") {
    return choice.database.current
      ? choice.database.current.engine + " · " + choice.database.current.host
      : "уже подключённая база";
  }
  if (choice.database.mode === "create") return choice.database.option?.name ?? "новая база";
  return "не нужна";
}

/** Одна строка, по которой видно всю схему: что где лежит и какие сервисы подключены. */
function schemeLine(choice: DeploymentChoice) {
  const parts: string[] = [];
  if (choice.hosting.shape === "object") {
    parts.push("файлы в Object Storage + CDN");
  } else if (choice.hosting.shape === "object-functions") {
    parts.push("файлы в Object Storage + CDN", "API в Cloud Functions");
  } else if (choice.hosting.shape === "functions") {
    parts.push(choice.architecture === "static"
      ? "файлы сайта в Cloud Functions"
      : choice.architecture === "static-functions"
        ? "файлы сайта и API в Cloud Functions"
        : "API в Cloud Functions");
  } else if (choice.hosting.shape === "container") {
    parts.push("приложение в контейнере");
  } else {
    parts.push("приложение на виртуальной машине");
  }

  parts.push("база — " + databaseName(choice));
  for (const service of choice.services) {
    parts.push(SERVICE_CATEGORY_LABEL[service.category] + " — " + service.name +
      (service.connected ? " (уже подключён)" : " (ключи — защищённые поля в чате)"));
  }
  if (choice.sms) parts.push("SMS — ключ приложения через секреты");
  return "Итоговая схема: " + parts.join("; ") + ".";
}

function servicesLine(choice: DeploymentChoice) {
  if (!choice.services.length) return "дополнительные сервисы не нужны";
  return choice.services.map(service =>
    service.name + " [" + service.id + "] (" + service.category +
    (service.env.length ? "; env: " + service.env.join(", ") : "") +
    (service.connected ? "; уже подключён" : "; ключи — access.request kind=service: поля в чате, зашифрованное хранилище") + ")"
  ).join("; ");
}

export function deploymentBrief(choice: DeploymentChoice) {
  const auto = choice.projectType.label + " — " + choice.projectType.reason;
  const functionDirs = choice.projectType.functions
    .map(entry => entry.path === "." ? "корень проекта" : entry.path)
    .join(", ");
  // Код функций относится только к functions-архитектуре. При ручном выборе контейнера
  // или статики упоминание каталога functions запутало бы агента и он развернул лишнее.
  const usesFunctions = choice.architecture === "static-functions" || choice.architecture === "functions";
  const architecture = choice.manualType
    ? "Архитектура: " + ARCH_LABEL[choice.architecture] + " (выбрано пользователем вручную; автоопределение было: " + auto + ")."
    : "Архитектура: " + ARCH_LABEL[choice.architecture] + " (автоопределение: " + auto + ").";
  // Пустой файл — это ещё не план: на первом запуске незачем читать его через deploy.status.
  const freshStart = Boolean(choice.freshStart || !choice.plan.exists || choice.plan.total === 0);

  return [
    DEPLOYMENT_BRIEF_PREFIX,
    "",
    "Проект: " + choice.projectName + ".",
    ...(choice.freshStart ? ["ВАЖНО: пользователь начал новое развёртывание. Старый deploy_project.md не продолжай — составь новый план через deploy.plan. Перед созданием ресурса проверь, не существует ли он уже, и переиспользуй работающее."] : []),
    architecture,
    ...(usesFunctions && functionDirs ? ["Код функций: " + functionDirs + "."] : []),
    ...(choice.projectType.framework ? ["Фреймворк: " + choice.projectType.framework + "."] : []),
    ...(choice.projectType.buildCommand ? ["Сборка: " + choice.projectType.buildCommand + "."] : []),
    ...hostingLines(choice),
    "Способ размещения: " + SHAPE_LABEL[choice.hosting.shape] + ".",
    schemeLine(choice),
    ...(gatewayLine(choice) ? [gatewayLine(choice)] : []),
    "Домен: " + domainLine(choice) + ".",
    "База данных: " + databaseLine(choice) + ".",
    "Сервисы: " + servicesLine(choice) + ".",
    ...(choice.sms ? ["SMS: нужен сервис отправки; отдельной интеграции в каталоге нет — ключ приложения запроси через secrets.request, а ручной шаг отметь blocked."] : []),
    "",
    "Порядок работы:",
    freshStart
      ? "1. Это новое развёртывание: готового плана нет. Не вызывай deploy.status — сразу переходи к плану."
      : "1. Сначала deploy.status. Если deploy_project.md уже есть и он не завершён — продолжай с текущего шага, не начинай заново.",
    freshStart
      ? "2. Сразу составь полный план через deploy.plan до создания первого ресурса. Включай только то, что нужно этому проекту, и не добавляй ресурсы другого типа: для functions не нужен контейнер или ВМ, для контейнера не нужны функции. Для статики + функций собери фронтенд и загрузи файлы в бакет, API разверни функцией; API Gateway добавляй только если нужен свой домен или маршруты к функции."
      : "2. Если плана нет, составь полный план через deploy.plan до создания первого ресурса. Включай только то, что нужно этому проекту, и не добавляй ресурсы другого типа: для functions не нужен контейнер или ВМ, для контейнера не нужны функции. Для статики + функций собери фронтенд и загрузи файлы в бакет, API разверни функцией; API Gateway добавляй только если нужен свой домен или маршруты к функции.",
    "3. Отсутствующие доступы к облаку, регистратору, сервису или базе запрашивай через access.request — поля появятся в чате, запуск встанет и продолжится сам после сохранения. Порядок: сначала доступ, без которого нельзя разместить (облако), затем база, затем домен, затем сервисы. Один запрос за раз: не открывай следующую карточку, пока не сохранена текущая. Ключи самого приложения, которых нет в каталоге сервисов, запрашивай через secrets.request. Никогда не проси ключ текстом и не пиши его в deploy_project.md.",
    "4. После каждого проверенного шага обновляй deploy.plan полным списком. Ничего, что отмечено done, не создавай заново.",
    "5. Платные и ручные действия (оплата, подтверждение в кабинете, покупка домена) помечай blocked, давай точную ссылку на документацию и продолжай с того, что можно сделать.",
    "6. В конце проверь боевой адрес и покажи короткий отчёт: что создано, где, какой URL и что осталось за пользователем.",
  ].join("\n");
}

export function deploymentResumePrompt() {
  return [
    DEPLOYMENT_RESUME_PREFIX,
    "",
    "Сначала deploy.status и продолжи с текущего шага deploy_project.md.",
    "Если deploy.status вернул exists:false или empty:true — плана нет, сразу составь его через deploy.plan, не продолжай пустой файл.",
    "Не создавай заново ресурсы, отмеченные done, и не начинай развёртывание с нуля.",
    "Если для следующего шага нужен доступ к провайдеру — access.request; если ключ приложения — secrets.request. После каждого проверенного шага обновляй deploy.plan.",
  ].join("\n");
}
