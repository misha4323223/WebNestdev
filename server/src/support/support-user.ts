import type { PlanId } from "../account/plans.js";
import { planDisplayName } from "../billing/plan-settings.js";
import { getTokenBudget, getUsageSnapshot } from "../account/usage-store.js";
import { getUserProfile, type OnboardingProfile } from "../account/profile-store.js";
import { getUser, getUserLastSeenAt } from "../auth/auth-store.js";
import { findPhoneByUserId, formatPhone } from "../auth/phone-store.js";
import { findYandexIdentityByUserId, type YandexIdentity } from "../auth/yandex-account-store.js";
import { accountPlanFor, getSubscriptionRecord, isSubscriptionLive, type SubscriptionRecord } from "../billing/store.js";
import { listProjects, type Project } from "../project-store.js";
import type { SupportReporter, SupportSignIn } from "./support-store.js";

/**
 * Карточка человека для админки поддержки.
 *
 * Обращение само по себе отвечает «что случилось», но не «у кого». Поэтому здесь собирается
 * безопасная часть аккаунта: контакты, способ входа, тариф, проекты и текущий расход. Пароля,
 * хешей, токенов, ключей и содержимого проектов тут нет — поддержке эти данные не нужны.
 *
 * Функция читает существующие хранилища и работает и на JSON, и на Postgres. Её ошибка не должна
 * отменять обращение: маршрут сохранения оборачивает вызов в try/catch, потому что тикет важнее
 * карточки.
 *
 * Снимок для списка и для тикета дешёвый: без месячного пула токенов и дневного расхода. Полная
 * карточка (`loadSupportUser`) добавляет их только когда админ открыл одно обращение.
 */

export type SupportSubscription = {
  plan: PlanId;
  planName: string;
  status: "active" | "canceled";
  startedAt: string;
  renewsAt: string;
  autoRenew: boolean;
};

export type SupportProjectRef = {
  id: string;
  name: string;
  updatedAt: string;
};

export type SupportUsage = {
  date: string;
  agentRuns: number;
  browserChecks: number;
  webSearches: number;
};

export type SupportTokens = {
  month: string;
  used: number;
  limit: number;
  remaining: number;
};

export type SupportUserDetails = SupportReporter & {
  yandexLogin: string | null;
  subscription: SupportSubscription | null;
  recentProjects: SupportProjectRef[];
  usage: SupportUsage;
  tokens: SupportTokens;
};

type SupportUserBase = {
  id: string;
  email: string;
  accountCreatedAt: string;
  profile: OnboardingProfile | null;
  phone: string | null;
  identity: YandexIdentity | null;
  plan: PlanId;
  projects: Project[];
  record: SubscriptionRecord | null;
  lastSeenAt: string | null;
};

/** Самая поздняя из отметок; ISO-строки сравниваются по времени, а не лексикографически. */
function newest(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestTime = 0;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time <= latestTime) continue;
    latest = value;
    latestTime = time;
  }
  return latest;
}

async function loadSupportBase(userId: string): Promise<SupportUserBase | null> {
  const user = await getUser(userId);
  if (!user) return null;
  const [profile, phone, identity, plan, projects, record, lastSeenAt] = await Promise.all([
    getUserProfile(userId),
    findPhoneByUserId(userId),
    findYandexIdentityByUserId(userId),
    accountPlanFor(userId),
    listProjects(userId),
    getSubscriptionRecord(userId),
    getUserLastSeenAt(userId),
  ]);
  return {
    id: user.id,
    email: user.email,
    accountCreatedAt: user.createdAt,
    profile,
    phone,
    identity,
    plan,
    projects,
    record,
    lastSeenAt,
  };
}

/** Снимок, который кладётся в тикет и в список: без «живых» полей, которые быстро устаревают. */
function reporterFromBase(base: SupportUserBase): SupportReporter {
  const phoneSynthetic = base.email.endsWith("@phone.webnestdev.local");
  const signIn: SupportSignIn[] = [];
  if (base.identity) signIn.push("yandex");
  if (base.phone || phoneSynthetic) signIn.push("phone");
  if (!base.identity && !phoneSynthetic) signIn.push("password");
  if (!signIn.length) signIn.push("password");

  return {
    id: base.id,
    email: base.email,
    name: base.profile?.name ?? null,
    contactEmail: base.profile?.email || null,
    phone: base.phone ? formatPhone(base.phone) : null,
    signIn,
    plan: base.plan,
    planName: planDisplayName(base.plan),
    accountCreatedAt: base.accountCreatedAt,
    projects: base.projects.length,
    lastActiveAt: newest([base.lastSeenAt, base.projects[0]?.updatedAt]),
  };
}

/**
 * Подробная, но безопасная карточка аккаунта. `null` — пользователя больше нет; снимок в самом
 * тикете при этом остаётся, поэтому обращение не теряет автора.
 */
export async function loadSupportUser(userId: string): Promise<SupportUserDetails | null> {
  const base = await loadSupportBase(userId);
  if (!base) return null;

  const [usage, tokens] = await Promise.all([
    getUsageSnapshot(userId),
    getTokenBudget(userId, base.plan),
  ]);
  const subscription = base.record && isSubscriptionLive(base.record)
    ? {
        plan: base.record.plan,
        planName: planDisplayName(base.record.plan),
        status: base.record.autoRenew ? "active" as const : "canceled" as const,
        startedAt: base.record.startedAt,
        renewsAt: base.record.renewsAt,
        autoRenew: base.record.autoRenew,
      }
    : null;

  return {
    ...reporterFromBase(base),
    yandexLogin: base.identity?.login ?? null,
    subscription,
    recentProjects: base.projects.slice(0, 10).map(project => ({
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
    })),
    usage,
    tokens,
  };
}

/** Снимок для тикета и списка: дешевле полной карточки, без расхода и пула токенов. */
export async function supportReporterFor(userId: string): Promise<SupportReporter | null> {
  const base = await loadSupportBase(userId);
  return base ? reporterFromBase(base) : null;
}

/** Снимок из уже прочитанной полной карточки — чтобы не повторять запросы в detail-маршруте. */
export function supportReporterFrom(user: SupportUserDetails): SupportReporter {
  const { yandexLogin, subscription, recentProjects, usage, tokens, ...reporter } = user;
  return reporter;
}
