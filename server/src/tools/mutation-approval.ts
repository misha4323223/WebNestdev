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

function bodyPreview(body: unknown): string {
  if (body === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(body) ?? "";
  } catch {
    text = String(body);
  }
  if (!text) return "";
  return text.length > 160 ? text.slice(0, 160) + "…" : text;
}

/** Текст карточки; отдельная функция, чтобы его можно было проверить в тесте. */
export function mutationApprovalQuestion(request: MutationRequest): string {
  const body = bodyPreview(request.body);
  return (
    "Агент просит изменить ресурс. Провайдер: " +
    request.provider +
    ". Действие: " +
    request.method +
    " " +
    request.resource +
    "." +
    (body ? " Тело: " + body + "." : "") +
    " Выполнить?"
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
