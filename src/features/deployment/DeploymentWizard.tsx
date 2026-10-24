import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, Check, ChevronLeft, Cloud, CreditCard, Database,
  Globe2, HardDrive, Mail, MessageSquare, Rocket, Server, ShieldCheck, Sparkles, X,
} from "lucide-react";
import { NestLoader } from "../../components/NestLoader";
import {
  getDeploymentOptions,
  type DeploymentArchitecture,
  type DeploymentOptions,
  type DeploymentProjectType,
  type DeploymentService,
} from "../../lib/deployment-api";
import { deploymentBrief, deploymentResumePrompt, type DeploymentChoice, type DeploymentHostingShape } from "../../lib/deployment-brief";

/**
 * Квиз развёртывания — единственный экран, где пользователь принимает решения, а не пишет
 * техническое задание. Тип проекта уже определён сервером, поэтому первый шаг — короткая сводка,
 * а не вопрос: выбор остаётся только там, где он действительно нужен (где размещать, какой домен,
 * какие сервисы), и спрятан за ссылкой «Это не так?», если автоопределение ошиблось.
 *
 * Отдельно различаются две вещи: чем отдаётся фронтенд и что выполняет бэкенд. Статический сайт
 * с оплатой, базой и рассылкой может работать как Object Storage + Cloud Functions — тогда шаг
 * базы и сервисов остаётся, хотя «серверного процесса» у проекта нет.
 *
 * После «Развернуть» окно закрывается, а агент получает собранный бриф и ведёт развёртывание
 * по deploy_project.md; недостающие ключи он попросит полями в чате.
 */

type StepId = "project" | "hosting" | "domain" | "database" | "services" | "review";
type KnownArchitecture = Exclude<DeploymentArchitecture, "unknown">;

const STEP_LABEL: Record<StepId, string> = {
  project: "Сводка",
  hosting: "Размещение",
  domain: "Домен",
  database: "База данных",
  services: "Сервисы",
  review: "Проверка",
};

const ARCH_LABEL: Record<DeploymentArchitecture, string> = {
  static: "Статический сайт",
  "static-functions": "Статика + Cloud Functions",
  functions: "API на Cloud Functions",
  server: "Приложение с сервером",
  unknown: "Тип не определён",
};

const SHAPE_LABEL: Record<DeploymentHostingShape, string> = {
  object: "Object Storage + CDN",
  functions: "Cloud Functions",
  "object-functions": "Object Storage + CDN + Cloud Functions",
  container: "Контейнер",
  vm: "Виртуальная машина",
};

const TYPE_CHOICES: Array<{ id: KnownArchitecture; name: string; note: string }> = [
  { id: "static", name: "Статический сайт", note: "Файлы и CDN. Серверный процесс и база не нужны." },
  { id: "static-functions", name: "Статика + функции", note: "Файлы в Object Storage, API в Cloud Functions: база, оплата, рассылка." },
  { id: "server", name: "Приложение с сервером", note: "Нужен работающий процесс: контейнер или виртуальная машина." },
];

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
      { id: "object", name: "Object Storage + CDN", note: "Собранные файлы лежат в бакете и раздаются через CDN. Для сайта это дешевле всего." },
      { id: "functions", name: "Cloud Functions", note: "Функция может отдавать файлы сайта и обрабатывать запросы. Платите за вызовы, возможен холодный старт." },
    ];
  }
  if (architecture === "static-functions") {
    return [
      { id: "object-functions", name: "Object Storage + Cloud Functions", note: "Файлы — в бакете и CDN, API, оплата и рассылка — в функциях. Основной вариант для такого сайта." },
      { id: "functions", name: "Только Cloud Functions", note: "Функции отдают и файлы, и API. Проще, но больше холодных стартов и лимитов." },
    ];
  }
  if (architecture === "functions") {
    return [
      { id: "functions", name: "Cloud Functions", note: "API по HTTP-триггеру; статического фронтенда нет." },
    ];
  }
  return [
    { id: "container", name: "Контейнер", note: "Приложение работает в контейнере, платформа сама перезапускает его при сбое." },
    { id: "vm", name: "Виртуальная машина", note: "Полный сервер: Docker, cron, свои службы. Больше контроля и больше обслуживания." },
  ];
}

function needLabel(key: keyof DeploymentOptions["needs"]) {
  return { database: "База данных", storage: "Хранилище файлов", email: "Почта", sms: "SMS", payments: "Оплата", ai: "AI-модели", maps: "Карты", crm: "CRM" }[key];
}

function architectureSummary(architecture: DeploymentArchitecture) {
  if (architecture === "static") return "Файлы отдаются напрямую — серверный процесс не нужен.";
  if (architecture === "static-functions") return "Статический фронтенд и API на Cloud Functions — размещение выберете дальше.";
  if (architecture === "functions") return "Только API на Cloud Functions; статического фронтенда нет.";
  if (architecture === "server") return "Нужен работающий процесс: контейнер или виртуальная машина.";
  return "";
}

function frontendValue(type: DeploymentProjectType, architecture: DeploymentArchitecture, manual: boolean) {
  if (architecture === "functions") return "нет статики";
  if (manual) {
    if (architecture === "static" || architecture === "static-functions") return "статические файлы";
    if (type.frontend === "static") return "статические файлы";
    if (type.frontend === "ssr") return "SSR";
    return "не определён";
  }
  if (type.frontend === "static") return "статические файлы";
  if (type.frontend === "ssr") return "SSR";
  return "не определён";
}

function backendValue(type: DeploymentProjectType, architecture: DeploymentArchitecture, manual: boolean) {
  if (manual) {
    if (architecture === "static") return "не нужен";
    if (architecture === "static-functions" || architecture === "functions") return "Cloud Functions";
    return "серверный процесс";
  }
  if (type.backend === "functions") {
    const dirs = type.functions.map(entry => entry.path === "." ? "корень проекта" : entry.path).join(", ");
    return "Cloud Functions" + (dirs ? " · " + dirs : "");
  }
  if (type.backend === "server") return "серверный процесс" + (type.serverDir && type.serverDir !== "." ? " · " + type.serverDir : "");
  return "не нужен";
}

function domainError(value: string) {
  const text = value.trim();
  if (!text) return "Укажите домен или выберите «Без домена»";
  if (/\s/.test(text)) return "В имени домена не должно быть пробелов";
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
    if (!options || architecture === "unknown") return ["project"];
    const list: StepId[] = ["project", "hosting", "domain"];
    if (databaseStep) list.push("database");
    if (options.services.length || (options.needs.sms && !options.smsSupported)) list.push("services");
    list.push("review");
    return list;
  }, [architecture, databaseStep, options]);

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
  const planResume = Boolean(options?.plan.exists && !options.plan.complete && !ignorePlan);
  const architectureTitle = manualType ? ARCH_LABEL[architecture] : options?.projectType.label ?? ARCH_LABEL[architecture];
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
    setStepIndex(0);
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
    setStepIndex(0);
    setFormError("");
  }

  function next() {
    if (architecture === "unknown") {
      setFormError("Выберите тип проекта — от него зависят следующие шаги.");
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
    if (!options || !selectedCloud) return;
    if (architecture === "unknown") { setFormError("Выберите тип проекта — без него нельзя собрать план."); return; }
    if (domainMode !== "none") {
      const error = domainError(domain);
      if (error) { setFormError(error); goTo(steps.indexOf("domain")); return; }
    }
    if (!confirmed) { setFormError("Подтвердите, что разрешаете агенту создать ресурсы по этому плану."); return; }
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

      {!loading && options && <div className="deploy-steps" aria-label="Шаги развёртывания">
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
        {loading && <div className="deploy-loading"><NestLoader size={32} label="Изучаем проект"/><span>Смотрим, что за проект и что уже подключено…</span></div>}
        {loadError && <div className="deploy-empty"><AlertTriangle size={20}/><strong>Не удалось открыть развёртывание</strong><span>{loadError}</span><button className="ghost-button" onClick={() => setReload(value => value + 1)}>Повторить</button></div>}

        {!loading && options && step === "project" && <>

          {planResume && <div className="deploy-plan-banner">
            <div>
              <span className="eyebrow">ПЛАН УЖЕ ЕСТЬ</span>
              <strong>Развёртывание остановилось на шаге {options.plan.done + 1} из {options.plan.total}</strong>
              <small>{options.plan.current ?? "Продолжите с того же места — агент прочитает deploy_project.md."}</small>
            </div>
            <div className="deploy-plan-actions">
              <button className="send-button" onClick={() => onStarted(deploymentResumePrompt())}><Rocket size={13}/> Продолжить</button>
              <button className="ghost-button" onClick={() => setIgnorePlan(true)}>Новый план</button>
            </div>
          </div>}

          {architecture === "unknown"
            ? <div className="deploy-warning">
                <AlertTriangle size={14}/>
                <span>Автоопределение не справилось: в проекте нет понятных признаков. Выберите тип — от него зависят шаги и варианты размещения.</span>
              </div>
            : <>
                <div className="deploy-detected">
                  <div className="deploy-detected-head">
                    <span className="deploy-detected-icon"><Check size={14}/></span>
                    <div className="deploy-detected-title">
                      <span className="eyebrow">{manualType ? "ВЫБРАНО ВРУЧНУЮ" : "ОПРЕДЕЛЕНО АВТОМАТИЧЕСКИ"}</span>
                      <strong>{architectureTitle}</strong>
                      <small>{architectureSummary(architecture)}</small>
                    </div>
                    {!manualType && !showTypeChoice && <button type="button" className="deploy-link" onClick={() => setShowTypeChoice(true)}>Это не так?</button>}
                  </div>

                  <div className="deploy-facts">
                    <div><span>Фронтенд</span><strong>{frontendValue(options.projectType, architecture, manualType)}</strong></div>
                    <div><span>Бэкенд</span><strong>{backendValue(options.projectType, architecture, manualType)}</strong></div>
                    {options.projectType.framework && <div><span>Фреймворк</span><strong>{options.projectType.framework}</strong></div>}
                    {options.projectType.buildCommand && <div><span>Сборка</span><code>{options.projectType.buildCommand}</code></div>}
                    {options.projectType.startCommand && <div><span>Запуск</span><code>{options.projectType.startCommand}</code></div>}
                    {options.projectType.evidence.length > 0 && <div><span>Признаки</span><strong>{options.projectType.evidence.join(" · ")}</strong></div>}
                  </div>

                  {!manualType && <p className="deploy-muted">Почему: {options.projectType.reason}</p>}
                  {manualType && !showTypeChoice && <div className="deploy-note">
                    <ShieldCheck size={13}/><span>
                      Автоопределение было: {options.projectType.label} — {options.projectType.reason}.{" "}
                      <button type="button" className="deploy-link" onClick={() => setShowTypeChoice(true)}>Выбрать другой тип</button>
                      {" · "}
                      <button type="button" className="deploy-link" onClick={resetArchitecture}>Вернуть автоопределение</button>
                    </span>
                  </div>}
                </div>

                <div className="deploy-subhead"><span className="eyebrow">ЧТО ПОНАДОБИТСЯ</span><span className="deploy-muted">Ключи попросим по ходу</span></div>
                <div className="deploy-needs">
                  {visibleNeeds.map(key => <span className="deploy-need" key={key} title={options.needsEvidence[key]?.join(", ")}>
                    <Check size={11}/>{needLabel(key)}
                  </span>)}
                  {visibleNeeds.length === 0 && <span className="deploy-muted">Проекту не нужны дополнительные сервисы — только размещение.</span>}
                </div>
              </>}

          {showTypeChoice && <div className="deploy-override">
            <div className="deploy-subhead">
              <span className="eyebrow">ВЫБРАТЬ ТИП ВРУЧНУЮ</span>
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
                <span><strong>Только API на функциях</strong><small>Без статического фронтенда: функции отвечают по HTTP.</small></span>
                {architecture === "functions" && <Check size={14} className="deploy-check"/>}
              </button>}
            </div>
          </div>}

          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "hosting" && <>
          <div className="deploy-lead">
            <span className="eyebrow">КАК РАЗМЕЩАЕМ</span>
            <p>{architecture === "server"
              ? "Приложению нужен контейнер или машина — выбираем формат и облако."
              : architecture === "functions" || architecture === "static-functions"
                ? "Файлы и API размещаются отдельно: функция выполняет API, бакет отдаёт статику."
                : "Для статики не нужен сервер: файлы или функции."}</p>
          </div>
          <div className="deploy-shapes">
            {shapeOptions(architecture).map(item => <button key={item.id} className={"deploy-choice" + (shape === item.id ? " selected" : " ")} onClick={() => setShape(item.id)}>
              <span className="deploy-choice-mark">{shape === item.id ? <Check size={12}/> : null}</span>
              <span><strong>{item.name}</strong><small>{item.note}</small></span>
            </button>)}
          </div>

          {functionsShape && <div className="deploy-note">
            <Cloud size={13}/><span>{architecture === "static"
              ? "Функция может отдавать файлы сайта и обрабатывать запросы. Свой домен настраивается через шлюз провайдера — в Yandex Cloud это API Gateway."
              : "Функции выполняют API по HTTP-триггеру. Свой домен и маршруты к ним настраиваются через шлюз провайдера — в Yandex Cloud это API Gateway. При редких запросах возможен холодный старт."}</span>
          </div>}

          <div className="deploy-subhead"><span className="eyebrow">ГДЕ</span><span className="deploy-muted">Можно подключить позже — агент попросит ключ в чате.</span></div>
          <div className="deploy-providers">
            {options.clouds.map(cloud => <button key={cloud.id} className={"deploy-provider" + (providerId === cloud.id ? " selected" : "")} onClick={() => setProviderId(cloud.id)}>
              <span className="deploy-provider-icon"><Cloud size={15}/></span>
              <span className="deploy-provider-copy">
                <strong>{cloud.name}</strong>
                <small>{cloud.connected ? "Подключено" + (cloud.account ? " · " + cloud.account : "") : "Ключ попросим в чате"}</small>
              </span>
              {providerId === cloud.id && <Check size={13} className="deploy-check"/>}
            </button>)}
          </div>
          {selectedCloud && !selectedCloud.connected && <div className="deploy-note">
            <ShieldCheck size={13}/><span>Ключ от {selectedCloud.name} не хранится в проекте: агент попросит его полями в чате и сохранит в зашифрованных интеграциях.</span>
          </div>}

          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "domain" && <>
          <div className="deploy-lead">
            <span className="eyebrow">ДОМЕН</span>
            <p>Домен можно подключить сейчас или позже. Покупку и оплату всегда делает пользователь — агент только проверяет имя и настраивает DNS.</p>
          </div>
          <div className="deploy-domain-modes">
            {([
              { id: "own" as const, icon: Globe2, name: "Домен уже есть", note: "Укажите его — агент проверит DNS и добавит запись." },
              { id: "new" as const, icon: Sparkles, name: "Нужен новый домен", note: "Агент проверит свободность и даст ссылку на покупку." },
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
                ? "Регистратор подключён: " + options.domains.filter(item => item.connected).map(item => item.name).join(", ") + " — агент сможет изменить DNS."
                : "Регистратор пока не подключён: когда дойдёт до DNS, агент запросит доступ к REG.RU, Beget или Timeweb в чате."}
            </span>
          </div>
          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "database" && <>
          <div className="deploy-lead">
            <span className="eyebrow">ДАННЫЕ</span>
            <p>{architecture === "server"
              ? "База нужна серверному приложению, которое хранит данные. Если она уже подключена — агент просто пропишет её в проект."
              : "База нужна API на функциях. Если она уже подключена — агент пропишет её в переменные функции."}</p>
          </div>
          {options.database.connected && <button className={"deploy-choice" + (databaseMode === "connected" ? " selected" : "")} onClick={() => setDatabaseMode("connected")}>
            <span className="deploy-choice-mark">{databaseMode === "connected" ? <Check size={12}/> : null}</span>
            <span><strong>Уже подключена</strong><small>{options.database.engine} · {options.database.host} · {options.database.database}</small></span>
            <Database size={15} className="deploy-choice-icon"/>
          </button>}

          <button className={"deploy-choice" + (databaseMode === "create" ? " selected" : "")} onClick={() => setDatabaseMode("create")}>
            <span className="deploy-choice-mark">{databaseMode === "create" ? <Check size={12}/> : null}</span>
            <span><strong>Создать новую</strong><small>Агент создаст базу в выбранном облаке или попросит строку подключения.</small></span>
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
            <span><strong>База не нужна</strong><small>Приложение не хранит данные или использует внешний сервис.</small></span>
          </button>

          <div className="deploy-note"><ShieldCheck size={13}/><span>Пароль и строку подключения агент не увидит: они попадут в зашифрованное хранилище, а в проект — только как <code>DATABASE_URL</code>{architecture === "server" ? "." : " в переменных функции."}</span></div>
          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "services" && <>
          <div className="deploy-lead">
            <span className="eyebrow">СЕРВИСЫ</span>
            <p>Показываем только то, что проект действительно использует по зависимостям и <code>.env.example</code>. Ничего лишнего.</p>
          </div>
          <div className="deploy-muted">В каждой категории — один сервис: тот, чей ключ вы готовы дать агенту. Остальные можно выбрать вместо него.</div>
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
                <span className={"deploy-service-state" + (service.connected ? " connected" : "")}>{service.connected ? "подключён" : service.preferred ? "найден в проекте" : selected ? "ключ в чате" : ""}</span>
              </button>;
            })}
          </div>
          {options.needs.sms && !options.smsSupported && <button className={"deploy-sms" + (wantsSms ? " selected" : "")} onClick={() => setWantsSms(value => !value)} role="checkbox" aria-checked={wantsSms}>
            <span className="deploy-choice-mark">{wantsSms ? <Check size={12}/> : null}</span>
            <span><strong>SMS-уведомления</strong><small>Отдельной интеграции пока нет. Агент попросит ключ приложения через <code>secrets.request</code> и отметит шаг, если без провайдера он невозможен.</small></span>
          </button>}
          {!options.services.length && !(options.needs.sms && !options.smsSupported) && <div className="deploy-muted">Проект не использует сервисы с ключами — этот шаг не нужен.</div>}
          {formError && <div className="connector-notice" role="alert">{formError}</div>}
        </>}

        {!loading && options && step === "review" && <>
          <div className="deploy-lead">
            <span className="eyebrow">ПРОВЕРКА</span>
            <p>Агент начнёт с плана в <code>deploy_project.md</code>, создаст ресурсы и после каждого шага отметит прогресс. Ключи, которых нет, он попросит полями в чате.</p>
          </div>
          <div className="deploy-summary">
            <div><span>Архитектура</span><strong>{architectureTitle}{manualType ? " · выбрано вручную" : ""}</strong></div>
            <div><span>Размещение</span><strong>{SHAPE_LABEL[shape]} · {selectedCloud?.name ?? "облако не выбрано"}</strong></div>
            <div><span>Домен</span><strong>{domainMode === "none" ? "без домена" : domain.trim()}</strong></div>
            {databaseStep && <div><span>База</span><strong>{databaseMode === "none" ? "не нужна" : databaseMode === "connected" ? "уже подключена" : "создать" + (selectedDatabase ? " · " + selectedDatabase.name : "")}</strong></div>}
            {functionsShape && selectedCloud && <div><span>Маршруты</span><strong>{domainMode === "none"
              ? "без шлюза: публичный адрес функции"
              : selectedCloud.id === "yandex" ? "API Gateway → Cloud Functions · домен на шлюз" : "HTTP-триггер функции · домен на него"}</strong></div>}
            <div><span>Сервисы</span><strong>{selectedServices.length ? selectedServices.map(service => service.name).join(", ") : "не нужны"}{wantsSms ? " · SMS" : ""}</strong></div>
          </div>

          {(selectedCloud && !selectedCloud.connected) || (domainMode !== "none" && !options.domains.some(item => item.connected)) || selectedServices.some(service => !service.connected)
            ? <div className="deploy-warning">
                <AlertTriangle size={14}/>
                <span>Некоторые доступы ещё не подключены. Агент попросит их полями в чате и продолжит после сохранения; отказываться от них не обязательно.</span>
              </div>
            : null}

          <label className={"deploy-consent" + (confirmed ? " checked" : "")}>
            <input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); setFormError(""); }}/>
            <span><strong>Разрешаю создать ресурсы по этому плану</strong><small>Создание облачных ресурсов может быть платным. Агент не покупает домен и не удаляет ресурсы без отдельной просьбы.</small></span>
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
          {step !== "review"
            ? <button className="send-button deploy-next" onClick={next} disabled={!options || architecture === "unknown" || (step === "hosting" && !selectedCloud)}>
                Далее <ArrowRight size={13}/>
              </button>
            : <button className="send-button deploy-start" onClick={start} disabled={!confirmed || !selectedCloud || architecture === "unknown"}>
                <Rocket size={13}/> Развернуть проект
              </button>}
        </div>
      </footer>
    </section>
  </div>;
}
