import { apiJson } from "./api";

/**
 * Знакомство при входе: контакты для связи и несколько вопросов о человеке и его задаче,
 * как в Replit и похожих сервисах. Ответы нужны не для анкеты, а для агента: с ними он сразу
 * понимает, кто перед ним и что именно строить, поэтому первый план не приходится переписывать.
 *
 * Данные профиля живут на сервере: знакомство должно появиться у всех, кто его ещё не проходил,
 * включая аккаунты, созданные до этой формы, и на любом устройстве. Ответы на вопросы проекта
 * остаются подсказкой для первого запуска.
 */

export type OnboardingProfileInput = {
  name: string;
  /** Почта для обратной связи, не логин: аккаунт может быть привязан к телефону. */
  email: string;
  /** Письма о работе сервиса. */
  newsletter: boolean;
  /** Рекламные и информационные письма: уходят только при явном согласии. */
  productUpdates: boolean;
  /** Откуда человек узнал о NestDev. */
  source?: string;
};

export type OnboardingProfile = Omit<OnboardingProfileInput, "source"> & {
  source: string;
  completedAt: string;
  updatedAt: string;
};

export type OnboardingAnswers = {
  /** Кто человек: разработчик, основатель, студент… */
  role: string;
  /** Опыт в разработке. */
  level: string;
  /** Что он хочет создать. */
  build: string;
  /** Зачем ему инструмент. */
  goal: string;
  /** Идея проекта своими словами. */
  idea: string;
  /** Название проекта. */
  projectName: string;
};

export async function saveOnboardingProfile(input: OnboardingProfileInput): Promise<OnboardingProfile> {
  const data = await apiJson<{ profile: OnboardingProfile }>("/api/account/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.profile;
}

/**
 * Точечная правка профиля: источник знакомства, согласие или почта меняются по одному полю.
 * Сервер сам сохраняет остальные значения, поэтому форма настроек не переписывает чужие данные.
 */
export async function updateOnboardingProfile(
  patch: Partial<Pick<OnboardingProfileInput, "name" | "email" | "newsletter" | "productUpdates" | "source">>,
): Promise<OnboardingProfile> {
  const data = await apiJson<{ profile: OnboardingProfile }>("/api/account/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return data.profile;
}

/** Ответ на вопрос «откуда узнали» сохраняется отдельно от контактов: он идёт после них. */
export function saveOnboardingSource(source: string): Promise<OnboardingProfile> {
  return updateOnboardingProfile({ source });
}

/**
 * Ответы уходят агенту вместе с идеей: роль задаёт тон, опыт — глубину объяснений, а вид проекта
 * и цель подсказывают структуру и разделы. Агенту прямо сказано не пересказывать это человеку.
 */
export function onboardingBrief(answers: OnboardingAnswers): string {
  return [
    "Контекст из знакомства при входе. Учитывай его в вопросах и плане, но не пересказывай:",
    "- Роль: " + answers.role,
    "- Опыт в разработке: " + answers.level,
    "- Что хочет создать: " + answers.build,
    "- Зачем: " + answers.goal,
  ].join("\n");
}
