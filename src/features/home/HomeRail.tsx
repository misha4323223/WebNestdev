import { useEffect, useState } from "react";
import { ArrowRight, CreditCard, FolderGit2, LogOut, Pencil, Plug, Plus, Sparkles, Trash2, UserRound } from "lucide-react";
import { WebNestLogo } from "../../components/WebNestLogo";
import { IntegrationsList } from "../integrations/IntegrationsList";
import { ProjectRenameForm } from "./ProjectRename";
import { type Project } from "../../lib/project-api";
import { apiJson } from "../../lib/api";
import { getBilling, paymentsPendingNotice, type BillingData, type PlanId } from "../../lib/billing-api";
import { activePlanId, upgradeLabel, usePlanChoice } from "../../lib/plan-choice";
import { readCachedPreferences, type UserPreferences } from "../../lib/preferences";

export type RailSection = "integrations" | "projects" | "account" | "billing";

export type HomeRailProps = {
  projects: Project[];
  activeProjectId: string | null;
  /** Раздел колонки: на ПК переключается здесь, на телефоне — вкладками над главной. */
  section: RailSection;
  onSection: (section: RailSection) => void;
  onOpen: (project: Project) => void;
  onRename: (project: Project, name: string) => Promise<boolean>;
  onDelete: (project: Project) => void;
  onNewProject: () => void;
  onOpenPlans: () => void;
  onOpenSubscriptions: () => void;
  onExit: () => void;
};

const nav: Array<{ id: RailSection; label: string; icon: typeof Plug }> = [
  { id: "integrations", label: "Интеграции", icon: Plug },
  { id: "projects", label: "Проекты", icon: FolderGit2 },
  { id: "account", label: "Аккаунт", icon: UserRound },
  { id: "billing", label: "Оплата и подписка", icon: CreditCard },
];

function dateLabel(value: string) {
  return new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export function HomeRail(props: HomeRailProps) {
  const { projects, activeProjectId, section, onSection, onOpen, onRename, onDelete, onNewProject, onOpenPlans, onOpenSubscriptions, onExit } = props;
  const [renaming, setRenaming] = useState("");
  // One billing request for the rail: the billing section and the footer call to action
  // both show the plan the user actually has (or would get next).
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [billingError, setBillingError] = useState("");
  // The chosen plan is shared state, so the footer button and the billing section
  // name the same plan the user selected on the pricing screen.
  const planChoice = usePlanChoice();

  useEffect(() => {
    let active = true;
    void getBilling()
      .then(data => { if (active) setBilling(data); })
      .catch(e => { if (active) setBillingError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  // A blocked-popup OAuth return asks for the integrations rail from the address bar.
  useEffect(() => {
    if (!localStorage.getItem("webnestdev.openIntegrations")) return;
    localStorage.removeItem("webnestdev.openIntegrations");
    onSection("integrations");
  }, []);

  return <aside className="home-rail">
    <div className="rail-brand">
      <span className="rail-brand-mark"><WebNestLogo size={28} tone="light"/></span>
      <span className="rail-brand-name">WebNestdev</span>
    </div>

    <button className="rail-create" onClick={onNewProject}><Plus size={14}/> Создать проект</button>

    <nav className="rail-nav" aria-label="Разделы аккаунта">
      {nav.map(item => {
        const Icon = item.icon;
        return <button key={item.id} className={"rail-nav-item" + (section === item.id ? " active" : "")} onClick={() => { onSection(item.id); setRenaming(""); }}>
          <Icon size={14}/> <span>{item.label}</span><ArrowRight size={12} className="rail-nav-chevron"/>
        </button>;
      })}
    </nav>

    <div className="rail-content">
      {section === "integrations" && <section className="rail-section">
        <div className="rail-section-head"><span className="eyebrow">ИНТЕГРАЦИИ</span><strong>Подключения</strong></div>
        <IntegrationsList surface="home"/>
      </section>}

      {section === "projects" && <section className="rail-section">
        <div className="rail-section-head"><span className="eyebrow">ПРОЕКТЫ</span><strong>Все проекты · {projects.length}</strong></div>
        {projects.length === 0
          ? <p className="account-muted">Проектов пока нет. Нажмите «Создать проект» вверху — он появится здесь.</p>
          : <ul className="rail-projects">{projects.map(project => <li key={project.id} className={project.id === activeProjectId ? "active" : ""}>
              {renaming === project.id
                ? <ProjectRenameForm initial={project.name} onSubmit={name => { void onRename(project, name).then(saved => { if (saved) setRenaming(""); }); }} onCancel={() => setRenaming("")}/>
                : <>
                  <button className="rail-project-open" onClick={() => onOpen(project)} title={"Открыть проект «" + project.name + "»"}>
                    <span className="rail-project-icon"><FolderGit2 size={12}/></span>
                    <strong>{project.name}</strong>
                  </button>
                  <div className="rail-project-tools">
                    <button className="icon-button" onClick={() => setRenaming(project.id)} title="Переименовать" aria-label={"Переименовать проект " + project.name}><Pencil size={13}/></button>
                    <button className="icon-button danger" onClick={() => onDelete(project)} title="Удалить" aria-label={"Удалить проект " + project.name}><Trash2 size={13}/></button>
                  </div>
                </>}
            </li>)}
          </ul>}
      </section>}

      {section === "account" && <RailAccount/>}

      {section === "billing" && <RailBilling billing={billing} choice={planChoice} error={billingError} onOpenPlans={onOpenPlans} onOpenSubscriptions={onOpenSubscriptions}/>}
    </div>

    <div className="rail-foot">
      <button className="rail-upsell" onClick={onOpenPlans} title="Открыть выбор тарифа">
        <Sparkles size={13}/> <span>{upgradeLabel(billing, planChoice)}</span> <ArrowRight size={12}/>
      </button>
      <button className="rail-exit" onClick={onExit}><LogOut size={14}/> Выйти</button>
    </div>
  </aside>;
}

type AccountData = { user: { id: string; email: string; createdAt: string }; preferences: UserPreferences };

function RailAccount() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void apiJson<AccountData>("/api/account/settings")
      .then(data => { if (active) setAccount(data); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);

  const preferences = account?.preferences ?? readCachedPreferences();

  return <section className="rail-section">
    <div className="rail-section-head"><span className="eyebrow">АККАУНТ</span><strong>Профиль</strong></div>
    {error && <div className="settings-error">{error}</div>}
    {!account && !error && <div className="modal-state">Загружаем профиль…</div>}
    {account && <div className="rail-fields">
      <div><span>Email</span><strong title={account.user.email}>{account.user.email}</strong></div>
      <div><span>Дата регистрации</span><strong>{dateLabel(account.user.createdAt)}</strong></div>
      <div><span>Язык интерфейса</span><strong>{preferences.language === "ru" ? "Русский" : "English"}</strong></div>
      <div><span>Компактный режим</span><strong>{preferences.compactMode ? "Включён" : "Выключен"}</strong></div>
    </div>}
    <p className="account-muted rail-note">Настройки аккаунта и предпочтения открываются внутри рабочей области: «Настройки» → «Аккаунт и тариф».</p>
  </section>;
}

function RailBilling({ billing, choice, error, onOpenPlans, onOpenSubscriptions }: { billing: BillingData | null; choice: PlanId | null; error: string; onOpenPlans: () => void; onOpenSubscriptions: () => void }) {
  const plan = billing?.plans.find(item => item.id === activePlanId());
  // The plan the user selected is what they want to move to, so it is written next
  // to the current plan here as well, not only inside the pricing screens.
  const chosen = billing && choice ? billing.plans.find(item => item.id === choice) : undefined;

  return <section className="rail-section">
    <div className="rail-section-head"><span className="eyebrow">ОПЛАТА И ПОДПИСКА</span><strong>Текущий тариф</strong></div>
    {error && <div className="settings-error">{error}</div>}
    {!billing && !error && <div className="modal-state">Загружаем тариф…</div>}
    {billing && <>
      <div className="rail-plan">
        <div><span>Тариф</span><strong>{plan?.name ?? "Бесплатный"}</strong></div>
        <span className="plan-pill">{plan?.priceLabel ?? "0 ₽"}</span>
      </div>
      {chosen && <div className="rail-chosen">
        <span>Выбранный тариф · включим вместе с оплатой</span>
        <strong>{chosen.name} · {chosen.priceLabel}</strong>
      </div>}
      <p className="account-muted">{paymentsPendingNotice}</p>
      <div className="rail-usage">
        <div><span>Запуски агента</span><strong>{billing.usage.agentRuns} / {billing.limits.agentRunsPerDay}</strong></div>
        <div className="usage-meter-track"><span style={{ width: `${Math.min(100, billing.usage.agentRuns / Math.max(1, billing.limits.agentRunsPerDay) * 100)}%` }}/></div>
        <div><span>Браузерные проверки</span><strong>{billing.usage.browserChecks} / {billing.limits.browserChecksPerDay}</strong></div>
        <div className="usage-meter-track"><span style={{ width: `${Math.min(100, billing.usage.browserChecks / Math.max(1, billing.limits.browserChecksPerDay) * 100)}%` }}/></div>
      </div>
      <p className="account-muted">Запуски считаются на встроенной модели платформы. Со своим AI-провайдером — без дневного лимита.</p>
      <div className="rail-plan-actions">
        <button className="plan-action" onClick={onOpenPlans}>Сменить тариф</button>
        <button className="ghost-button" onClick={onOpenSubscriptions}>Подробнее о тарифах <ArrowRight size={12}/></button>
      </div>
    </>}
  </section>;
}
