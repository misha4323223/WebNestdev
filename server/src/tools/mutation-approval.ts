import { askUser } from "../questions/pending-questions.js";

/**
 * Подтверждение изменяющего запроса к облаку или DNS.
 *
 * `allowWrites` на подключении — это разрешение «в принципе», а не согласие на конкретное
 * действие. Модель может ошибиться или выполнить инструкцию из чужого текста, поэтому каждая
 * мутация (POST/PUT/PATCH/DELETE) показывается человеку карточкой с провайдером, методом,
 * ресурсом и телом. Без панели подтверждение невозможно — тогда запрос не выполняется
 * (fail closed), как и у отправки секрета в `net.request`.
 */
export type MutationApprovalContext = {
  projectId: string;
  userId: string;
  runId: string;
  emit?: unknown;
  signal?: AbortSignal;
};

export type MutationRequest = {
  provider: string;
  method: string;
  resource: string;
  body?: unknown;
};

export const MUTATION_APPROVAL_OPTIONS = [
  { label: "Разрешить изменение" },
  { label: "Отклонить" },
];

/** Структурированные данные для карточки подтверждения в панели. */
export type MutationApprovalDetails = {
  kind: "mutation";
  provider: string;
  method: string;
  resource: string;
  body?: string;
};

function stringifyBody(body: unknown, pretty: boolean): string {
  if (body === undefined) return "";
  try {
    return (pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body)) ?? "";
  } catch {
    return String(body);
  }
}

function bodyPreview(body: unknown): string {
  const text = stringifyBody(body, false);
  if (!text) return "";
  return text.length > 160 ? text.slice(0, 160) + "…" : text;
}

/** Тело для карточки: пустой объект не показываем как отдельную строку. */
function approvalBody(body: unknown): string {
  const text = stringifyBody(body, true);
  if (!text || text === "{}") return "";
  return text.length > 1200 ? text.slice(0, 1200) + "…" : text;
}

/** Данные карточки; отдельная функция, чтобы их можно было проверить в тесте. */
export function mutationApprovalDetails(request: MutationRequest): MutationApprovalDetails {
  const body = approvalBody(request.body);
  return {
    kind: "mutation",
    provider: request.provider,
    method: request.method,
    resource: request.resource,
    ...(body ? { body } : {}),
  };
}

/** Текст для клиентов без структурной карточки; панель показывает поля отдельно. */
export function mutationApprovalQuestion(request: MutationRequest): string {
  const body = bodyPreview(request.body);
  return (
    "Агент подготовил изменение. Провайдер: " +
    request.provider +
    ". Метод: " +
    request.method +
    " " +
    request.resource +
    "." +
    (body ? " Тело: " + body + "." : "") +
    " Подтвердить?"
  ).slice(0, 400);
}

export async function approveMutation(
  context: MutationApprovalContext,
  request: MutationRequest,
): Promise<boolean> {
  const emit = context.emit as ((event: unknown) => void) | undefined;
  if (!emit) {
    console.warn(
      "[mutation] подтверждение недоступно без панели: " + request.provider + " " + request.method + " " + request.resource,
    );
    return false;
  }
  const { question, answer } = askUser({
    projectId: context.projectId,
    userId: context.userId,
    question: mutationApprovalQuestion(request),
    options: MUTATION_APPROVAL_OPTIONS,
    multiSelect: false,
    allowCustom: false,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  emit({
    type: "question.asked",
    runId: context.runId,
    requestId: question.id,
    question: question.question,
    options: question.options,
    multiSelect: false,
    allowCustom: false,
    approval: mutationApprovalDetails(request),
    expiresAt: question.expiresAt,
  });
  const resolution = await answer;
  const approved =
    resolution.ok &&
    "selected" in resolution &&
    resolution.selected[0] === MUTATION_APPROVAL_OPTIONS[0].label;
  console.log(
    "[mutation] " +
      (approved ? "allowed" : "denied") +
      " " +
      request.provider +
      " " +
      request.method +
      " " +
      request.resource,
  );
  return approved;
}
