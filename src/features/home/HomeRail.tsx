import { useEffect, useState } from "react";
import { ArrowRight, CreditCard, Database, FolderGit2, Globe2, Pencil, Plug, Trash2, UserRound } from "lucide-react";
import { IntegrationsList } from "../integrations/IntegrationsList";
import { ProjectRenameForm } from "./ProjectRename";
import { type Project } from "../../lib/project-api";
import { getAccountClientDatabase, type ClientDatabaseStatus } from "../../lib/client-database-api";
import { balanceLabel, bytesLabel, creditsLabel, getBilling, moneyLabel, paymentNotice, type BillingData, type PlanId } from "../../lib/billing-api";
import { getAccountHosts, type AccountHost, type AccountHosts } from "../../lib/hosting-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";
import { SupportButton } from "../support/SupportDialog";
import { NotificationsBell } from "../notifications/NotificationsBell";

export type RailSection = "integrations" | "projects" | "account" | "billing";

export type HomeRailProps = {
  projects: Project[];
  activeProjectId: string | null;
  /** Раздел колонки: на ПК переключается здесь, на телефоне — вкладками над главной.
   *  `null` — все категории свёрнуты, видно только оглавление. */
  section: RailSection | null;
  onSection: (section: RailSection) => void;
  onOpen: (project: Project) => void;
  onRename: (project: Project, name: string) => Promise<boolean>;
  onDelete: (project: Project) => void;
  onOpenPlans: () => void;
  onOpenSubscriptions: () => void;
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
  const { projects, activeProjectId, section, onSection, onOpen, onRename, onDelete, onOpenPlans, onOpenSubscriptions } = props;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the OAuth return flag is consumed once on mount
  useEffect(() => {
    if (!localStorage.getItem("webnestdev.openIntegrations")) return;
    localStorage.removeItem("webnestdev.openIntegrations");
    onSection("integrations");
  }, []);

  return <aside className="home-rail">
    <nav className="rail-nav" aria-label="Разделы аккаунта">
      {nav.map(item => {
        const Icon = item.icon;
        return <button key={item.id} className={"rail-nav-item" + (section === item.id ? " active" : "")} aria-expanded={section === item.id} title={section === item.id ? "Свернуть раздел" : "Открыть раздел"} onClick={() => { onSection(item.id); setRenaming(""); }}>
          <Icon size={14}/> <span>{item.label}</span><ArrowRight size={12} className="rail-nav-chevron"/>
        </button>;
      })}
    </nav>

    {/* Колокольчик стоит между оглавлением и содержимым: на главной нет шапки, поэтому без
        него общее уведомление было бы видно только в рабочей области. */}
    <NotificationsBell variant="rail"/>

    {section && <div className="rail-content">
      {section === "integrations" && <section className="rail-section">
        <div className="rail-section-head"><span className="eyebrow">ИНТЕГРАЦИИ</span><strong>Подключения</strong></div>
        <IntegrationsList surface="home" planId={activePlanId(billing)}/>
      </section>}

      {section === "projects" && <section className="rail-section">
        <div className="rail-section-head"><span className="eyebrow">ПРОЕКТЫ</span><strong>Все проекты · {projects.length}</strong></div>
        {projects.length === 0
          ? <p className="account-muted">Проектов пока нет. Опишите идею на главной — проект появится здесь.</p>
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

      {section === "account" && <section className="rail-section">
        <div className="rail-section-head"><span className="eyebrow">АККАУНТ</span><strong>Профиль и тарифы</strong></div>
        <p className="account-muted">Полные настройки аккаунта открыты в основной области: профиль, тарифы, база данных и безопасность.</p>
      </section>}

      {section === "billing" && <RailBilling billing={billing} choice={planChoice} error={billingError} onOpenPlans={onOpenPlans} onOpenSubscriptions={onOpenSubscriptions}/>}
    </div>}

    <div className="rail-foot">
      <button className="rail-upsell" onClick={onOpenPlans} title="Открыть выбор тарифа">
        <span className="rail-upsell-icon"><CreditCard size={14}/></span>
        <span className="rail-upsell-copy">
          <small>Подписка</small>
          <span className="rail-upsell-line">
            <strong>{planName(billing, activePlanId(billing))}</strong>
            {isPendingChoice(planChoice, billing) && <><span className="rail-upsell-arrow" aria-hidden="true">→</span><em>{planName(billing, chosenPlanId(planChoice))}</em></>}
          </span>
        </span>
        <ArrowRight size={13} className="rail-upsell-go"/>
      </button>
      {/* Поддержка — действие аккаунта; выход теперь в разделе «Аккаунт». */}
      <SupportButton variant="rail"/>
    </div>
  </aside>;
}

function RailBilling({ billing, choice, error, onOpenPlans, onOpenSubscriptions }: { billing: BillingData | null; choice: PlanId | null; error: string; onOpenPlans: () => void; onOpenSubscriptions: () => void }) {
  // Действующий тариф — с сервера; выбор пользователя только показывается рядом как пожелание.
  const plan = billing?.plans.find(item => item.id === activePlanId(billing));
  const subscription = billing?.subscription;
  const paid = Boolean(subscription?.renewsAt) && (subscription?.plan ?? "free") !== "free";
  const storageLimit = billing?.limits.storageBytes ?? 0;
  const storageUsed = billing?.storage?.usedBytes ?? 0;
  const runsLimit = billing?.limits.agentRunsPerWeek ?? null;
  const runsUsed = billing?.usage.agentRunsWeek ?? 0;
  // The plan the user selected is what they want to move to, so it is written next
  // to the current plan here as well, not only inside the pricing screens.
  const chosen = billing && choice ? billing.plans.find(item => item.id === choice) : undefined;
  // Ресурсы аккаунта грузятся отдельно от тарифа: база и сайты принадлежат аккаунту, а не
  // выбранному проекту. Запросы идут только когда открыт раздел «Оплата и подписка».
  const [database, setDatabase] = useState<ClientDatabaseStatus | null>(null);
  const [databaseError, setDatabaseError] = useState("");
  const [accountHosts, setAccountHosts] = useState<AccountHosts | null>(null);
  const [hostsError, setHostsError] = useState("");
  useEffect(() => {
    let active = true;
    void getAccountClientDatabase()
      .then(value => { if (active) setDatabase(value); })
      .catch(() => { if (active) setDatabaseError("Не удалось проверить базу."); });
    void getAccountHosts()
      .then(value => { if (active) setAccountHosts(value); })
      .catch(() => { if (active) setHostsError("Не удалось загрузить хосты."); });
    return () => { active = false; };
  }, []);
  const activeDatabase = database?.available === true ? database : null;
  const databaseIncluded = activeDatabase ? activeDatabase.limitBytes > 0 : false;
  const databasePercent = activeDatabase && activeDatabase.limitBytes > 0
    ? Math.min(100, Math.round(activeDatabase.usedBytes / activeDatabase.limitBytes * 100))
    : 0;
  const databaseConnected = Boolean(activeDatabase?.provisioned && activeDatabase.reachable && databaseIncluded);
  const databaseState = databaseError
    ? "не удалось проверить"
    : !database
      ? "проверяем…"
      : !activeDatabase
        ? "не подключена"
        : !databaseIncluded
          ? "не подключена"
          : !activeDatabase.provisioned
            ? "не подключена"
            : !activeDatabase.reachable
              ? "не отвечает"
              : activeDatabase.readOnly
                ? "только чтение"
                : "подключена";
  const databaseHint = databaseError
    ? "Проверьте соединение и обновите страницу."
    : !database
      ? "Проверяем подключение…"
      : !activeDatabase
        ? "Встроенная база отключена на этой установке."
        : !databaseIncluded
          ? "Встроенная база доступна на «Плюсе» и «Премиуме»."
          : !activeDatabase.provisioned
            ? "Подключите в «Аккаунт» → «База данных»."
            : !activeDatabase.reachable
              ? "База не отвечает: проверьте подключение."
              : activeDatabase.readOnly
                ? "Квота исчерпана: запись приостановлена, данные сохранены."
                : "PostgreSQL для сайтов и приложений аккаунта.";
  const hosts = accountHosts?.hosts ?? [];
  const hostsDomain = accountHosts?.domain ?? "";

  return <section className="rail-section">
    <div className="rail-section-head"><span className="eyebrow">ОПЛАТА И ПОДПИСКА</span><strong>Текущий тариф</strong></div>
    {error && <div className="settings-error">{error}</div>}
    {!billing && !error && <div className="modal-state">Загружаем тариф…</div>}
    {billing && <>
      <div className="rail-plan">
        <div><span>Тариф</span><strong>{plan?.name ?? "Старт"}</strong></div>
        <span className="plan-pill">{plan?.priceLabel ?? "0 ₽"}</span>
      </div>
      <div className="rail-money">
        <div><span>Баланс</span><strong>{balanceLabel(billing.balance)}</strong></div>
        <div><span>Расходы сегодня</span><strong>{billing.cost.pricesConfigured ? moneyLabel(billing.cost.costEstimate, billing.cost.currency) : "—"}</strong></div>
      </div>
      {subscription?.renewsAt && <div className="rail-chosen">
        <span>{paid ? (subscription.autoRenew ? "Подписка · автопродление" : "Подписка · без автопродления") : "Тариф"}</span>
        <strong>{paid ? "до " + dateLabel(subscription.renewsAt) : "Старт"}</strong>
      </div>}
      {chosen && !billing.paymentsEnabled && <div className="rail-chosen">
        <span>Выбранный тариф · включим вместе с оплатой</span>
        <strong>{chosen.name} · {chosen.priceLabel}</strong>
      </div>}
      <p className="account-muted">{paymentNotice(billing)}</p>
      <div className="rail-usage">
        {runsLimit != null && <>
          <div><span>Запуски на неделе</span><strong>{runsUsed} / {runsLimit}</strong></div>
          <div className="usage-meter-track"><span style={{ width: `${Math.min(100, runsUsed / Math.max(1, runsLimit) * 100)}%` }}/></div>
        </>}
        {billing.credits && billing.credits.limit > 0 && <>
          <div><span>Кредиты на агента</span><strong>{creditsLabel(billing.credits.used)} / {creditsLabel(billing.credits.limit)}</strong></div>
          <div className="usage-meter-track"><span style={{ width: `${Math.min(100, billing.credits.used / Math.max(1, billing.credits.limit) * 100)}%` }}/></div>
          {billing.credits.purchased > 0 && <small className="account-muted">{creditsLabel(billing.credits.purchased)} докупленных не сгорают</small>}
        </>}
        {storageLimit > 0 && <>
          <div><span>Хранилище</span><strong>{(storageUsed / 1024 / 1024).toFixed(1)} / {(storageLimit / 1024 / 1024 / 1024).toFixed(1)} ГБ</strong></div>
          <div className="usage-meter-track"><span style={{ width: `${Math.min(100, storageUsed / storageLimit * 100)}%` }}/></div>
        </>}
      </div>
      <div className={"rail-database" + (databaseConnected ? " is-connected" : "")}>
        <div className="rail-database-head">
          <span><Database size={11}/> База данных</span>
          <strong>{databaseState}</strong>
        </div>
        {databaseConnected && activeDatabase && <>
          <div className="rail-database-meta">
            <span>{bytesLabel(activeDatabase.usedBytes)} / {bytesLabel(activeDatabase.limitBytes)}</span>
            <span>{databasePercent}%</span>
          </div>
          <div className="usage-meter-track"><span style={{ width: `${Math.max(2, databasePercent)}%` }}/></div>
          <small className="rail-database-endpoint" title={activeDatabase.maskedUrl}>{activeDatabase.maskedUrl}</small>
        </>}
        <p className="rail-database-note">{databaseHint}</p>
      </div>
      <div className="rail-hosts">
        <div className="rail-hosts-head">
          <span><Globe2 size={11}/> Хосты аккаунта</span>
          <strong>{accountHosts ? hosts.length : "—"}</strong>
        </div>
        {hostsError && <p className="rail-hosts-empty">{hostsError}</p>}
        {!accountHosts && !hostsError && <p className="rail-hosts-empty">Загружаем хосты…</p>}
        {accountHosts && hosts.length === 0 && <p className="rail-hosts-empty">Хостов пока нет. Опубликуйте сайт в проекте — он появится здесь.</p>}
        {hosts.length > 0 && <ul className="rail-hosts-list">{hosts.map(host => <HostRow key={host.siteId} host={host} domain={hostsDomain}/>)}</ul>}
      </div>
      <p className="account-muted">На бесплатном тарифе — 10 запусков в неделю. На платных тарифах расход ограничен кредитами; свой AI-провайдер доступен на «Плюсе» и «Премиуме».</p>
      <div className="rail-plan-actions">
        <button className="plan-action" onClick={onOpenPlans}>{billing.paymentsEnabled ? (paid ? "Тариф и кредиты" : "Оплатить тариф") : "Сменить тариф"}</button>
        {paid && billing.credits && billing.credits.limit > 0 && <button className="ghost-button" onClick={() => {
          try { localStorage.setItem("webnestdev.openCreditTopUp", "1"); } catch {}
          onOpenSubscriptions();
        }}>Докупить кредиты <ArrowRight size={12}/></button>}
        <button className="ghost-button" onClick={onOpenSubscriptions}>Подробнее о тарифах <ArrowRight size={12}/></button>
      </div>
    </>}
  </section>;
}

const hostStatusLabel: Record<AccountHost["status"], string> = {
  draft: "черновик",
  live: "опубликован",
  unpublished: "снят с публикации",
  suspended: "заблокирован",
};

const customDomainStatusLabel: Record<AccountHost["customDomains"][number]["status"], string> = {
  pending_dns: "ждёт DNS",
  verified: "проверен",
  configuring: "настраивается",
  issuing_certificate: "сертификат",
  active: "активен",
  error: "ошибка",
};

/** Один сайт аккаунта: основной адрес платформы и подключённые к нему домены. */
function HostRow({ host, domain }: { host: AccountHost; domain: string }) {
  const hostname = host.url
    ? host.url.replace(/^https?:\/\//, "")
    : host.slug + (domain ? "." + domain : "");
  return <li className="rail-host">
    <div className="rail-host-top">
      <Globe2 size={10}/>
      {host.url
        ? <a href={host.url} target="_blank" rel="noopener noreferrer" title={host.url}>{hostname}</a>
        : <span title={hostname}>{hostname}</span>}
      <em className={"rail-host-status " + host.status}>{hostStatusLabel[host.status]}</em>
    </div>
    <small className="rail-host-project">{host.projectName}</small>
    {host.customDomains.length > 0 && <div className="rail-host-domains">{host.customDomains.map(item =>
      <span key={item.hostname} className={"rail-host-domain " + item.status} title={item.hostname}>
        {item.hostname}<em>{customDomainStatusLabel[item.status]}</em>{item.isCanonical && <b>основной</b>}
      </span>,
    )}</div>}
  </li>;
}
