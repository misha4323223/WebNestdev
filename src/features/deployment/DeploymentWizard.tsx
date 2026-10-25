import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, Check, ChevronLeft, Cloud, CreditCard, Database,
  Globe2, HardDrive, Mail, MessageSquare, Rocket, Server, ShieldCheck, Sparkles, X,
} from "lucide-react";
import { NestLoader } from "../../components/NestLoader";
import { BrandMark, type BrandId } from "../../components/BrandLogo";
import {
  getDeploymentOptions,
  type DeploymentArchitecture,
  type DeploymentOptions,
  type DeploymentService,
} from "../../lib/deployment-api";
import { deploymentBrief, deploymentResumePrompt, type DeploymentChoice, type DeploymentHostingShape } from "../../lib/deployment-brief";

/**
 * Квиз развёртывания — единственный экран, где пользователь принимает решения, а не пишет
 * техническое задание. Тип проекта уже определён сервером, поэтому первый шаг — короткая сводка,
 * а не вопрос: выбор остаётся только там, где он действительно нужен (где размещать, какой домен,
 * какие сервисы), и спрятан за кнопкой «Выбрать», если автоопределение ошиблось.
 *
 * Отдельно различаются две вещи: чем отдаётся фронтенд и что выполняет бэкенд. Статический сайт
 * с оплатой, базой и рассылкой может работать как хранилище + функции — тогда шаг базы и сервисов
 * остаётся, хотя «серверного процесса» у проекта нет.
 *
 * После «Развернуть» окно закрывается, а агент получает собранный бриф и ведёт развёртывание
 * по deploy_project.md; недостающие ключи он запросит безопасными полями.
 */

type StepId = "target" | "project" | "hosting" | "domain" | "database" | "services" | "review";
type KnownArchitecture = Exclude<DeploymentArchitecture, "unknown">;

const STEP_LABEL: Record<StepId, string> = {
  target: "Хостинг",
  project: "Проект",
  hosting: "Размещение",
  domain: "Домен",
  database: "База",
  services: "Сервисы",
  review: "Проверка",
};

const ARCH_LABEL: Record<DeploymentArchitecture, string> = {
  static: "Статический сайт",
  "static-functions": "Статика + функции",
  functions: "API на функциях",
  server: "Приложение с сервером",
  unknown: "Тип не определён",
};

const SHAPE_LABEL: Record<DeploymentHostingShape, string> = {
  object: "Хранилище + CDN",
  functions: "Функции",
  "object-functions": "Хранилище + CDN + функции",
  container: "Контейнер",
  vm: "Виртуальная машина",
};

const TYPE_CHOICES: Array<{ id: KnownArchitecture; name: string; note: string }> = [
  { id: "static", name: "Статический сайт", note: "Готовые файлы, сервер не нужен." },
  { id: "static-functions", name: "Статика + функции", note: "Файлы в хранилище, API в функциях." },
  { id: "server", name: "Приложение с сервером", note: "Контейнер или виртуальная машина." },
];

const CLOUD_BRANDS: Record<string, BrandId> = {
  yandex: "yandex-cloud",
  timeweb: "timeweb",
  cloudru: "cloudru",
  mws: "mts",
  regru: "regru",
};

const CATEGORY_LABEL: Record<DeploymentService["category"], string> = {
  storage: "Файлы",
  email: "Почта",
  payments: "Оплата",
  ai: "AI",
  maps: "Карты",
  crm: "CRM",
};

function typeIcon(id: KnownArchitecture) {
  if (id === "static") return <Globe2 size={17}/>;
  if (id === "static-functions") return <Cloud size={17}/>;
  if (id === "functions") return <Sparkles size={17}/>;
  return <Server size={17}/>;
}

function defaultShape(architecture: DeploymentArchitecture): DeploymentHostingShape {
  if (architecture === "static") return "object";
  if (architecture === "static-functions") return "object-functions";
  if (architecture === "functions") return "functions";
  if (architecture === "server") return "container";
  return "object";
}

function shapeOptions(architecture: DeploymentArchitecture): Array<{ id: DeploymentHostingShape; name: string; note: string }> {
  if (architecture === "static") {
    return [
      { id: "object", name: "Хранилище + CDN", note: "Файлы в облачном хранилище, раздача через CDN." },
      { id: "functions", name: "Функции", note: "Функция отдаёт файлы и отвечает на запросы. Оплата за вызовы, возможен холодный старт." },
    ];
  }
  if (architecture === "static-functions") {
    return [
      { id: "object-functions", name: "Хранилище + CDN + функции", note: "Файлы в хранилище, API в функциях." },
      { id: "functions", name: "Только функции", note: "Функции отдают и файлы, и API. Проще, но чаще холодный старт." },
    ];
  }
  if (architecture === "functions") {
    return [
      { id: "functions", name: "Функции", note: "API по HTTP-триггеру, без сайта." },
    ];
  }
  return [
    { id: "container", name: "Контейнер", note: "Приложение в контейнере. При сбое платформа перезапустит его сама." },
    { id: "vm", name: "Виртуальная машина", note: "Свой сервер: Docker, cron и любые службы. Обслуживать нужно самому." },
  ];
}

function needLabel(key: keyof DeploymentOptions["needs"]) {
  return { database: "База данных", storage: "Хранилище файлов", email: "Почта", sms: "SMS", payments: "Оплата", ai: "AI-модели", maps: "Карты", crm: "CRM" }[key];
}

function architectureSummary(architecture: DeploymentArchitecture) {
  if (architecture === "static") return "Готовые файлы, без серверного процесса.";
  if (architecture === "static-functions") return "Сайт из файлов, API в функциях.";
  if (architecture === "functions") return "Только API на функциях, без сайта.";
  if (architecture === "server") return "Нужен работающий сервер: контейнер или виртуальная машина.";
  return "";
}

function domainError(value: string) {
  const text = value.trim();
  if (!text) return "Укажите домен или выберите «Без домена»";
  if (/\s/.test(text)) return "В имени домена не должно быть пробелов";
  if (text.length > 253) return "Слишком длинное имя домена";
  const labels = text.split(".");
  if (labels.some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    return "Проверьте имя домена: части не должны быть пустыми или начинаться и заканчиваться дефисом";
  }
  if (!/^[a-zа-яё0-9][a-zа-яё0-9.-]*\.[a-zа-яё]{2,}$/i.test(text)) return "Похоже на неполное имя: нужен домен вида example.ru";
  return "";
}

export function DeploymentWizard({ projectId, onClose, onStarted }: {
  projectId: string;
  onClose: () => void;
  onStarted: (brief: string) => void;
}) {
  const [options, setOptions] = useState<DeploymentOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [formError, setFormError] = useState("");
  const [architecture, setArchitecture] = useState<DeploymentArchitecture>("unknown");
  const [manualType, setManualType] = useState(false);
  const [showTypeChoice, setShowTypeChoice] = useState(false);
  const [shape, setShape] = useState<DeploymentHostingShape>("object");
  const [providerId, setProviderId] = useState("");
  const [domainMode, setDomainMode] = useState<"own" | "new" | "none">("none");
  const [domain, setDomain] = useState("");
  const [databaseMode, setDatabaseMode] = useState<"connected" | "create" | "none">("none");
  const [databaseOptionId, setDatabaseOptionId] = useState("yandex-postgresql");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [wantsSms, setWantsSms] = useState(false);
  const [ignorePlan, setIgnorePlan] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Развилка появляется до сводки: пользователь сначала выбирает, где живёт проект.
  // Хостинг проекта пока только помечен статусом «Скоро» и никуда не ведёт.
  const [target, setTarget] = useState<"external" | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError("");
    void getDeploymentOptions(projectId)
      .then(data => {
        if (!alive) return;
        setOptions(data);
        const detected = data.projectType.id;
        setArchitecture(detected);
        setManualType(false);
        setShowTypeChoice(detected === "unknown");
        setShape(defaultShape(detected));
        setProviderId((data.clouds.find(cloud => cloud.connected) ?? data.clouds[0])?.id ?? "");
        // Без признаков базы в проекте не предлагаем создать её по умолчанию: кнопка «Далее»
        // не должна означать согласие на платный кластер, которого никто не просил.
        setDatabaseMode(detected === "static" || detected === "unknown"
          ? "none"
          : data.needs.database ? (data.database.connected ? "connected" : "create") : data.database.connected ? "connected" : "none");
        setDatabaseOptionId(data.describeDatabase[0]?.id ?? "yandex-postgresql");
        // В категории (файлы, почта, оплата…) нужен один провайдер, а не все сразу.
        // Приоритет: провайдер, который уже есть в проекте (Postbox, Robokassa), затем
        // подключённый, затем первый в каталоге. Остальные остаются выбором.
        const bestByCategory = new Map<string, DeploymentService>();
        const score = (service: DeploymentService) => (service.preferred ? 4 : 0) + (service.connected ? 2 : 0);
        for (const service of data.services) {
          const current = bestByCategory.get(service.category);
          if (!current || score(service) > score(current)) bestByCategory.set(service.category, service);
        }
        setServiceIds([...bestByCategory.values()].map(service => service.id));
        setWantsSms(data.needs.sms && !data.smsSupported);
      })
      .catch(error => { if (alive) setLoadError(error instanceof Error ? error.message : "Не удалось загрузить данные проекта"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, reload]);

  const databaseStep = Boolean(architecture === "server" || (options?.needs.database && architecture !== "static" && architecture !== "unknown"));

  const steps = useMemo<StepId[]>(() => {
    // Пока не выбраны внешние облака, дальше развилки не пускаем: хостинг проекта
    // ещё не подключён и остаётся только статусом в первой карточке.
    if (target !== "external" || !options) return ["target"];
    if (architecture === "unknown") return ["target", "project"];
    const list: StepId[] = ["target", "project", "hosting", "domain"];
    if (databaseStep) list.push("database");
    if (options.services.length || (options.needs.sms && !options.smsSupported)) list.push("services");
    list.push("review");
    return list;
  }, [architecture, databaseStep, options, target]);

  useEffect(() => { setStepIndex(index => Math.min(index, steps.length - 1)); }, [steps.length]);

  // Escape закрывает квиз так же, как крестик: окно не должно ловить пользователя.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const step = steps[stepIndex] ?? "project";
  const selectedCloud = options?.clouds.find(cloud => cloud.id === providerId) ?? null;
  const selectedServices = options?.services.filter(service => serviceIds.includes(service.id)) ?? [];
  const selectedDatabase = options?.describeDatabase.find(option => option.id === databaseOptionId) ?? null;
  const planResume = Boolean(options?.plan.exists && options.plan.total > 0 && !options.plan.complete && !ignorePlan);
  const architectureTitle = ARCH_LABEL[architecture];
  const visibleNeeds = options
    ? (Object.keys(options.needs) as Array<keyof DeploymentOptions["needs"]>).filter(key => options.needs[key] && !(architecture === "static" && key === "database"))
    : [];
  const functionsShape = shape === "functions" || shape === "object-functions";

  function goTo(next: number) {
    setFormError("");
    setStepIndex(Math.max(0, Math.min(steps.length - 1, next)));
  }

  function defaultDatabaseMode(next: DeploymentArchitecture) {
    if (next === "static" || next === "unknown") return "none";
    if (options?.database.connected) return "connected";
    if (options?.needs.database) return "create";
    return "none";
  }

  function chooseArchitecture(next: KnownArchitecture) {
    setArchitecture(next);
    setManualType(next !== options?.projectType.id);
    setShowTypeChoice(false);
    setShape(defaultShape(next));
    setDatabaseMode(defaultDatabaseMode(next));
    // Смена типа меняет набор шагов: оставаться на «Проверке» старой архитектуры нельзя.
    // Возвращаемся к сводке, а не к развилке хостинга — она уже пройдена.
    setStepIndex(1);
    setFormError("");
  }

  function resetArchitecture() {
    if (!options) return;
    const detected = options.projectType.id;
    setArchitecture(detected);
    setManualType(false);
    setShowTypeChoice(detected === "unknown");
    setShape(defaultShape(detected));
    setDatabaseMode(defaultDatabaseMode(detected));
    setStepIndex(1);
    setFormError("");
  }

  function next() {
    if (step === "target") {
      if (target !== "external") { setFormError("Выберите хостинг."); return; }
      goTo(1);
      return;
    }
    if (architecture === "unknown") {
      setFormError("Выберите тип проекта.");
      return;
    }
    if (step === "domain" && domainMode !== "none") {
      const error = domainError(domain);
      if (error) { setFormError(error); return; }
    }
    goTo(stepIndex + 1);
  }

  /** Один провайдер на категорию: выбор почты не должен тянуть за собой все пять каталогов. */
  function toggleService(service: DeploymentService) {
    setServiceIds(current => {
      if (current.includes(service.id)) return current.filter(item => item !== service.id);
      const sameCategory = options?.services.filter(item => item.category === service.category).map(item => item.id) ?? [];
      return [...current.filter(item => !sameCategory.includes(item)), service.id];
    });
  }

  function start() {
    if (!options || !selectedCloud || target !== "external") return;
    if (architecture === "unknown") { setFormError("Выберите тип проекта."); return; }
    if (domainMode !== "none") {
      const error = domainError(domain);
      if (error) { setFormError(error); goTo(steps.indexOf("domain")); return; }
    }
    if (!confirmed) { setFormError("Подтвердите создание ресурсов."); return; }
    const currentDatabase = options.database.connected ? options.database : undefined;
    const choice: DeploymentChoice = {
      projectName: options.project.name,
      architecture,
      manualType,
      projectType: options.projectType,
      hosting: { shape, provider: selectedCloud },
      domain: { mode: domainMode, ...(domainMode === "none" ? {} : { value: domain.trim() }) },
      database: {
        mode: databaseMode,
        ...(databaseMode === "create" && selectedDatabase ? { option: selectedDatabase } : {}),
        ...(databaseMode === "connected" && currentDatabase ? { current: currentDatabase } : {}),
      },
      services: selectedServices,
      sms: wantsSms,
      plan: options.plan,
      freshStart: ignorePlan && options.plan.exists,
    };
    onStarted(deploymentBrief(choice));
  }

  return <div className="modal-backdrop tech-backdrop deploy-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="modal tech-modal deploy-wizard" role="dialog" aria-modal="true" aria-labelledby="deploy-title" onMouseDown={event => event.stopPropagation()}>
      <header className="modal-head">
        <div className="tech-modal-title">
          <span className="tech-modal-icon" aria-hidden="true"><Rocket size={15}/></span>
          <div className="tech-modal-heading">
            <span className="eyebrow">РАЗВЁРТЫВАНИЕ</span>
            <h2 id="deploy-title">Развернуть проект</h2>
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onClose} title="Закрыть" aria-label="Закрыть квиз"><X size={16}/></button>
      </header>

      {!loading && options && steps.length > 1 && <div className="deploy-steps" aria-label="Шаги развёртывания">
        {steps.map((item, index) => <button
          type="button"
          key={item}
          className={"deploy-step" + (index === stepIndex ? " active" : "") + (index < stepIndex ? " done" : "")}
          onClick={() => goTo(index)}
          aria-current={index === stepIndex ? "step" : undefined}
        >
          <span>{index < stepIndex ? <Check size={10}/> : index + 1}</span>
          {STEP_LABEL[item]}
        </button>)}
      </div>}

      <div className="modal-body deploy-body">
        {step === "target" && <>
          <div className="deploy-target-lead">
            <span className="eyebrow">ХОСТИНГ</span>
            <p>Где размещаем проект.</p>
          </div>

          <div className="deploy-targets" aria-label="Где размещаем проект">
            <div className="deploy-target is-soon" aria-label="Хостинг проекта — скоро">
              <span className="deploy-target-head">
                <span className="deploy-target-icon"><Server size={18}/></span>
                <span className="deploy-target-badge soon"><Sparkles size={9}/> СКОРО</span>
              </span>
              <span className="deploy-target-kicker">NESTDEV CLOUD</span>
              <strong>Хостинг проекта</strong>
              <span className="deploy-target-copy">Развернуть проект прямо в NestDev: контейнеры, домены и HTTPS — без внешнего облака.</span>
              <span className="deploy-target-soon-note"><span className="deploy-target-soon-dot" aria-hidden="true"/>Готовим запуск. Пока выберите внешнее облако →</span>
            </div>

            <button
              type="button"
              className={"deploy-target" + (target === "external" ? " selected" : "")}
              onClick={() => { setTarget("external"); setFormError(""); }}
              aria-pressed={target === "external"}
            >
              <span className="deploy-target-head">
                <span className="deploy-target-icon"><Cloud size={17}/></span>
                <span className="deploy-target-badge live">ДОСТУПНО</span>
              </span>
              <span className="deploy-target-brands" role="list" aria-label="Yandex Cloud, Cloud.ru, MWS, Timeweb Cloud, REG.RU">
                <span className="deploy-brand" role="listitem" title="Yandex Cloud"><BrandMark brand="yandex-cloud" size={18}/></span>
                <span className="deploy-brand" role="listitem" title="Cloud.ru"><BrandMark brand="cloudru" size={18}/></span>
                <span className="deploy-brand" role="listitem" title="MWS (МТС)"><BrandMark brand="mts" size={18}/></span>
                <span className="deploy-brand" role="listitem" title="Timeweb Cloud"><BrandMark brand="timeweb" size={18}/></span>
                <span className="deploy-brand" role="listitem" title="REG.RU"><BrandMark brand="regru" size={18}/></span>
              </span>
              <strong>Внешние облака</strong>
              <span className="deploy-target-copy">Проект размещается в вашем облаке.</span>
              <span className="deploy-target-list">
                <span><Check size={11}/> Контейнеры и виртуальные машины</span>
                <span><Globe2 size={11}/> Свой домен и DNS</span>
              </span>
              <span className="deploy-target-cta">{target === "external" ? "Выбрано" : "Выбрать"} <ArrowRight size={12}/></span>
            </button>
          </div>


          {loadError && <div className="deploy-empty"><AlertTriangle size={20}/><strong>Не удалось открыть развёртывание</strong><span>{loadError}</span><button className="ghost-button" onClick={() => setReload(value => value + 1)}>Повторить</button></div>}
          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {step !== "target" && loading && <div className="deploy-loading"><NestLoader size={32} label="Проверяем проект"/>
            <span>Собираем данные о проекте…</span></div>}
        {step !== "target" && loadError && <div className="deploy-empty"><AlertTriangle size={20}/><strong>Не удалось открыть развёртывание</strong><span>{loadError}</span><button className="ghost-button" onClick={() => setReload(value => value + 1)}>Повторить</button></div>}

        {!loading && options && step === "project" && <>

          {planResume && <div className="deploy-plan-banner">
            <div>
              <span className="eyebrow">ПЛАН</span>
              <strong>Остановились на шаге {options.plan.done + 1} из {options.plan.total}</strong>
              <small>{options.plan.current ?? "Продолжим с этого шага."}</small>
            </div>
            <div className="deploy-plan-actions">
              <button className="send-button" onClick={() => onStarted(deploymentResumePrompt())}><Rocket size={13}/> Продолжить</button>
              <button className="ghost-button" onClick={() => setIgnorePlan(true)}>Новый план</button>
            </div>
          </div>}

          {architecture === "unknown"
            ? <div className="deploy-warning">
                <AlertTriangle size={14}/>
                <span>Не удалось определить тип проекта. Выберите его вручную.</span>
              </div>
            : <>
                <div className="deploy-detected">
                  <div className="deploy-detected-head">
                    <span className="deploy-detected-icon"><Check size={14}/></span>
                    <div className="deploy-detected-title">
                      <strong>{architectureTitle}</strong>
                      <small>{architectureSummary(architecture)}</small>
                    </div>
                    {!manualType && !showTypeChoice && <button
                      type="button"
                      className="ghost-button deploy-pick"
                      onClick={() => setShowTypeChoice(true)}
                      aria-label="Выбрать тип проекта"
                    >Выбрать</button>}
                  </div>

                  {manualType && !showTypeChoice && <div className="deploy-note">
                    <ShieldCheck size={13}/><span>
                      Тип выбран вручную.{" "}
                      <button type="button" className="deploy-link" onClick={() => setShowTypeChoice(true)}>Выбрать другой</button>
                      {" · "}
                      <button type="button" className="deploy-link" onClick={resetArchitecture}>Определить заново</button>
                    </span>
                  </div>}
                </div>

                <div className="deploy-subhead">
                  <span className="eyebrow">ЧТО НУЖНО</span>
                  <span className="deploy-muted">Можно подключить позже.</span>
                </div>
                <div className="deploy-needs">
                  {visibleNeeds.map(key => <span className="deploy-need" key={key} title={options.needsEvidence[key]?.join(", ")}>
                    <Check size={11}/>{needLabel(key)}
                  </span>)}
                  {visibleNeeds.length === 0 && <span className="deploy-muted">Дополнительные сервисы не нужны.</span>}
                </div>
              </>}

          {showTypeChoice && <div className="deploy-override">
            <div className="deploy-subhead">
              <span className="eyebrow">ТИП ПРОЕКТА</span>
              {/* У неопределённого проекта это единственный путь вперёд: скрыть выбор нельзя. */}
              {!manualType && architecture !== "unknown" && <button type="button" className="deploy-link" onClick={() => setShowTypeChoice(false)}>Скрыть</button>}
            </div>
            <div className="deploy-types">
              {TYPE_CHOICES.map(choice => <button
                type="button"
                key={choice.id}
                className={"deploy-type" + (architecture === choice.id ? " selected" : "")}
                onClick={() => chooseArchitecture(choice.id)}
              >
                <span className="deploy-type-icon">{typeIcon(choice.id)}</span>
                <span><strong>{choice.name}</strong><small>{choice.note}</small></span>
                {architecture === choice.id && <Check size={14} className="deploy-check"/>}
              </button>)}
              {options.projectType.backend === "functions" && <button
                type="button"
                className={"deploy-type" + (architecture === "functions" ? " selected" : "")}
                onClick={() => chooseArchitecture("functions")}
              >
                <span className="deploy-type-icon">{typeIcon("functions")}</span>
                <span>
                  <strong>Только API</strong>
                  <small>Без сайта, только HTTP-API.</small>
                </span>
                {architecture === "functions" && <Check size={14} className="deploy-check"/>}
              </button>}
            </div>
          </div>}

          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "hosting" && <>
          <div className="deploy-lead">
            <span className="eyebrow">РАЗМЕЩЕНИЕ</span>
            <p>{architecture === "server"
              ? "Выберите формат и облако."
              : architecture === "functions" || architecture === "static-functions"
                ? "Файлы и API размещаются отдельно."
                : "Сервер не нужен: файлы или функции."}</p>
          </div>
          <div className="deploy-shapes">
            {shapeOptions(architecture).map(item => <button key={item.id} className={"deploy-choice" + (shape === item.id ? " selected" : " ")} onClick={() => setShape(item.id)}>
              <span className="deploy-choice-mark">{shape === item.id ? <Check size={12}/> : null}</span>
              <span><strong>{item.name}</strong><small>{item.note}</small></span>
            </button>)}
          </div>

          {functionsShape && <div className="deploy-note">
            <Cloud size={13}/><span>{architecture === "static"
              ? "Функция отдаёт файлы и обрабатывает запросы. Домен подключается через шлюз провайдера."
              : "Функции выполняют API по HTTP-триггеру. Домен и маршруты — через шлюз провайдера. При редких запросах возможен холодный старт."}</span>
          </div>}

          <div className="deploy-subhead">
            <span className="eyebrow">ОБЛАКО</span>
            <span className="deploy-muted">Можно подключить позже.</span>
          </div>
          <div className="deploy-providers">
            {options.clouds.map(cloud => {
              const brand = CLOUD_BRANDS[cloud.id];
              return <button key={cloud.id} className={"deploy-provider" + (providerId === cloud.id ? " selected" : "")} onClick={() => setProviderId(cloud.id)}>
                <span className="deploy-provider-icon">
                  {brand ? <BrandMark brand={brand} size={18}/> : <Cloud size={15}/>}
                </span>
                <span className="deploy-provider-copy">
                  <strong>{cloud.name}</strong>
                  <small>{cloud.connected ? "Подключено" + (cloud.account ? " · " + cloud.account : "") : "Не подключено"}</small>
                </span>
                {providerId === cloud.id && <Check size={13} className="deploy-check"/>}
              </button>;
            })}
          </div>
          {selectedCloud && !selectedCloud.connected && <div className="deploy-note">
            <ShieldCheck size={13}/><span>Ключ от {selectedCloud.name} сохранится в зашифрованных интеграциях. В проект он не попадёт.</span>
          </div>}

          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "domain" && <>
          <div className="deploy-lead">
            <span className="eyebrow">ДОМЕН</span>
            <p>Можно сейчас или позже. Домен покупаете вы, DNS настраивает агент.</p>
          </div>
          <div className="deploy-domain-modes">
            {([
              { id: "own" as const, icon: Globe2, name: "Домен уже есть", note: "Агент проверит DNS и добавит запись." },
              { id: "new" as const, icon: Sparkles, name: "Нужен новый домен", note: "Агент проверит домен и даст ссылку на покупку." },
              { id: "none" as const, icon: Server, name: "Без домена", note: "Проект откроется по адресу провайдера." },
            ]).map(item => {
              const Icon = item.icon;
              return <button key={item.id} className={"deploy-choice" + (domainMode === item.id ? " selected" : "")} onClick={() => { setDomainMode(item.id); setFormError(""); }}>
                <span className="deploy-choice-mark">{domainMode === item.id ? <Check size={12}/> : null}</span>
                <span><strong>{item.name}</strong><small>{item.note}</small></span>
                <Icon size={15} className="deploy-choice-icon"/>
              </button>;
            })}
          </div>
          {domainMode !== "none" && <label className="deploy-field">
            <span>{domainMode === "own" ? "Ваш домен" : "Желаемое имя"}</span>
            <input
              value={domain}
              onChange={event => { setDomain(event.target.value); setFormError(""); }}
              placeholder="example.ru"
              autoFocus
              spellCheck={false}
              aria-label={domainMode === "own" ? "Ваш домен" : "Желаемое имя домена"}
            />
          </label>}
          <div className="deploy-note">
            <Globe2 size={13}/><span>
              {options.domains.some(item => item.connected)
                ? "Регистратор подключён: " + options.domains.filter(item => item.connected).map(item => item.name).join(", ") + ". Агент сможет менять DNS."
                : "Регистратор не подключён. Его можно добавить позже."}
            </span>
          </div>
          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "database" && <>
          <div className="deploy-lead">
            <span className="eyebrow">ДАННЫЕ</span>
            <p>{architecture === "server" ? "База для данных приложения." : "База для данных API."}</p>
          </div>
          {options.database.connected && <button className={"deploy-choice" + (databaseMode === "connected" ? " selected" : "")} onClick={() => setDatabaseMode("connected")}>
            <span className="deploy-choice-mark">{databaseMode === "connected" ? <Check size={12}/> : null}</span>
            <span><strong>Уже подключена</strong><small>{options.database.engine} · {options.database.host} · {options.database.database}</small></span>
            <Database size={15} className="deploy-choice-icon"/>
          </button>}

          <button className={"deploy-choice" + (databaseMode === "create" ? " selected" : "")} onClick={() => setDatabaseMode("create")}>
            <span className="deploy-choice-mark">{databaseMode === "create" ? <Check size={12}/> : null}</span>
            <span><strong>Создать новую</strong><small>Агент создаст базу в выбранном облаке.</small></span>
            <Sparkles size={15} className="deploy-choice-icon"/>
          </button>

          {databaseMode === "create" && <div className="deploy-db-options">
            {options.describeDatabase.map(option => <button key={option.id} className={"deploy-db-option" + (databaseOptionId === option.id ? " selected" : "")} onClick={() => setDatabaseOptionId(option.id)}>
              <span>{option.name}</span>
              <small>{option.note}</small>
            </button>)}
          </div>}

          <button className={"deploy-choice" + (databaseMode === "none" ? " selected" : "")} onClick={() => setDatabaseMode("none")}>
            <span className="deploy-choice-mark">{databaseMode === "none" ? <Check size={12}/> : null}</span>
            <span><strong>База не нужна</strong><small>Приложение не хранит данные.</small></span>
          </button>

          <div className="deploy-note"><ShieldCheck size={13}/><span>Пароль хранится в зашифрованном виде. В проект попадёт только <code>DATABASE_URL</code>{architecture === "server" ? "." : " в переменных функции."}</span></div>
          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "services" && <>
          <div className="deploy-lead">
            <span className="eyebrow">СЕРВИСЫ</span>
            <p>Только сервисы, которые использует проект.</p>
          </div>
          <div className="deploy-muted">В каждой категории — один сервис.</div>
          <div className="deploy-services">
            {options.services.map(service => {
              const selected = serviceIds.includes(service.id);
              const Icon = service.category === "email" ? Mail : service.category === "payments" ? CreditCard : service.category === "storage" ? HardDrive : service.category === "ai" ? Sparkles : service.category === "maps" ? Globe2 : MessageSquare;
              return <button key={service.id} className={"deploy-service" + (selected ? " selected" : "")} onClick={() => toggleService(service)} role="checkbox" aria-checked={selected}>
                <span className="deploy-service-icon"><Icon size={15}/></span>
                <span className="deploy-service-copy">
                  <strong>{service.name}<em>{CATEGORY_LABEL[service.category]}</em></strong>
                  <small>{service.tagline}</small>
                  <code>{service.env.join(" · ")}</code>
                </span>
                <span className={"deploy-service-state" + (service.connected ? " connected" : "")}>{service.connected ? "подключён" : service.preferred ? "есть в проекте" : selected ? "нужен ключ" : ""}</span>
              </button>;
            })}
          </div>
          {options.needs.sms && !options.smsSupported && <button className={"deploy-sms" + (wantsSms ? " selected" : "")} onClick={() => setWantsSms(value => !value)} role="checkbox" aria-checked={wantsSms}>
            <span className="deploy-choice-mark">{wantsSms ? <Check size={12}/> : null}</span>
            <span><strong>SMS-уведомления</strong><small>Отдельной интеграции пока нет. Агент запросит ключ приложения, когда дойдёт до SMS.</small></span>
          </button>}
          {!options.services.length && !(options.needs.sms && !options.smsSupported) && <div className="deploy-muted">Сервисы с ключами не нужны.</div>}
          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "review" && <>
          <div className="deploy-lead">
            <span className="eyebrow">ПРОВЕРКА</span>
            <p>Агент создаст ресурсы по плану и отметит прогресс. Недостающие ключи попросит по ходу.</p>
          </div>
          <div className="deploy-summary">
            <div><span>Архитектура</span><strong>{architectureTitle}{manualType ? " · выбрано вручную" : ""}</strong></div>
            <div><span>Размещение</span><strong>{SHAPE_LABEL[shape]} · {selectedCloud?.name ?? "облако не выбрано"}</strong></div>
            <div><span>Домен</span><strong>{domainMode === "none" ? "без домена" : domain.trim()}</strong></div>
            {databaseStep && <div><span>База</span><strong>{databaseMode === "none" ? "не нужна" : databaseMode === "connected" ? "уже подключена" : "создать" + (selectedDatabase ? " · " + selectedDatabase.name : "")}</strong></div>}
            {functionsShape && selectedCloud && <div><span>Маршруты</span><strong>{domainMode === "none"
              ? "без шлюза: публичный адрес функции"
              : selectedCloud.id === "yandex" ? "шлюз → функции · домен на шлюз" : "HTTP-триггер · домен на функцию"}</strong></div>}
            <div><span>Сервисы</span><strong>{selectedServices.length ? selectedServices.map(service => service.name).join(", ") : "не нужны"}{wantsSms ? " · SMS" : ""}</strong></div>
          </div>

          {(selectedCloud && !selectedCloud.connected) || (domainMode !== "none" && !options.domains.some(item => item.connected)) || selectedServices.some(service => !service.connected)
            ? <div className="deploy-warning">
                <AlertTriangle size={14}/>
                <span>Не всё подключено. Агент запросит недостающие доступы по ходу.</span>
              </div>
            : null}

          <label className={"deploy-consent" + (confirmed ? " checked" : "")}>
            <input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); setFormError(""); }}/>
            <span><strong>Разрешаю создать ресурсы</strong><small>Ресурсы могут быть платными. Домен агент не покупает, ресурсы без просьбы не удаляет.</small></span>
          </label>

          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}
      </div>

      <footer className="modal-foot deploy-foot">
        <div className="deploy-foot-left">
          {stepIndex > 0 && <button className="ghost-button" onClick={() => goTo(stepIndex - 1)}><ChevronLeft size={13}/> Назад</button>}
          {options && <span className="deploy-progress-text">{STEP_LABEL[step]} · {stepIndex + 1} из {steps.length}</span>}
        </div>
        <div className="deploy-foot-actions">
          <button className="ghost-button" onClick={onClose}>Отмена</button>
          {step === "target" && target !== "external"
            ? <button className="send-button deploy-next" disabled>Выберите хостинг</button>
            : step !== "review"
              ? <button className="send-button deploy-next" onClick={next} disabled={!options || loading || (step !== "target" && architecture === "unknown") || (step === "hosting" && !selectedCloud)}>
                  Далее <ArrowRight size={13}/>
                </button>
              : <button className="send-button deploy-start" onClick={start} disabled={!confirmed || !selectedCloud || architecture === "unknown" || target !== "external"}>
                  <Rocket size={13}/> Развернуть проект
                </button>}
        </div>
      </footer>
    </section>
  </div>;
}
