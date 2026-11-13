import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Check, Copy, ExternalLink, Globe2, Loader2, LockKeyhole,
  RefreshCw, Server, ShieldCheck, Trash2,
} from "lucide-react";
import {
  addCustomDomain, checkCustomDomain, getCustomDomains, removeCustomDomain,
  setCanonicalCustomDomain, type CustomDomain, type CustomDomainCheck, type CustomDomainState,
  type CustomDomainStatus,
} from "../../lib/custom-domains-api";

type DomainGroup = {
  id: string;
  domains: CustomDomain[];
  canonical: CustomDomain;
};

/**
 * Свой домен — отдельный мастер внутри «Хостинга». Он не прячет DNS-записи за кнопкой
 * «показать»: без них подключение невозможно, а копирование — основная операция.
 * Статусы Caddy/Let’s Encrypt приходят с сервера; панель только показывает их и повторяет
 * проверку, пока домен не станет активным.
 */
export function CustomDomainCard({
  projectId,
  enabled,
  limit,
}: {
  projectId: string;
  enabled: boolean;
  limit: number;
}) {
  const [state, setState] = useState<CustomDomainState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [hostname, setHostname] = useState("");
  const [includeWww, setIncludeWww] = useState(true);
  const [copied, setCopied] = useState("");
  const [checks, setChecks] = useState<CustomDomainCheck[] | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await getCustomDomains(projectId);
      setState(next);
      setError("");
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!enabled) return;
    setHostname("");
    setIncludeWww(true);
    setChecks(null);
    setState(null);
    setError("");
    void load();
  }, [enabled, load]);

  const groups = useMemo<DomainGroup[]>(() => {
    const byGroup = new Map<string, CustomDomain[]>();
    for (const domain of state?.domains ?? []) {
      byGroup.set(domain.groupId, [...(byGroup.get(domain.groupId) ?? []), domain]);
    }
    return [...byGroup.entries()].map(([id, domains]) => ({
      id,
      domains,
      canonical: domains.find(domain => domain.isCanonical) ?? domains[0],
    }));
  }, [state]);

  const mergeDomains = useCallback((next: CustomDomain[]) => {
    setState(current => current
      ? { ...current, domains: current.domains.map(domain => next.find(item => item.id === domain.id) ?? domain) }
      : current);
  }, []);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  };

  const check = useCallback(async (group: DomainGroup, quiet = false) => {
    if (!quiet) setBusy("check-" + group.id);
    if (!quiet) setError("");
    try {
      const result = await checkCustomDomain(projectId, group.domains[0].id);
      mergeDomains(result.domains);
      setChecks(result.checks);
      if (!quiet) {
        const failed = result.checks.find(item => !item.txt.allowed || !item.traffic.allowed || !item.caa.allowed);
        if (failed) {
          setError(failed.txt.reason || failed.traffic.reason || failed.caa.reason || "DNS пока не подтверждён");
        }
      }
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!quiet) setBusy("");
    }
  }, [mergeDomains, projectId]);

  // DNS может обновиться не сразу. Пока есть незавершённая группа, повторяем проверку
  // не чаще раза в 8 секунд; после active опрос прекращается.
  const waiting = groups.some(group => group.domains.some(domain =>
    domain.status === "pending_dns" || domain.status === "verified"
    || domain.status === "configuring" || domain.status === "issuing_certificate"));
  useEffect(() => {
    if (!waiting || busy || loading || !enabled || document.visibilityState !== "visible") return;
    const timer = window.setTimeout(() => {
      const group = groups.find(item => item.domains.some(domain => domain.status !== "active"));
      if (group) void check(group, true);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [busy, check, enabled, groups, loading, waiting]);

  const add = () => {
    const value = hostname.trim();
    if (!value) {
      setError("Введите домен, например example.ru");
      return;
    }
    void run("add", async () => {
      await addCustomDomain(projectId, value, includeWww);
      setHostname("");
      setChecks(null);
      await load(true);
    });
  };

  const makeCanonical = (domain: CustomDomain) => {
    void run("canonical-" + domain.id, async () => {
      await setCanonicalCustomDomain(projectId, domain.id);
      await load(true);
    });
  };

  const remove = (group: DomainGroup) => {
    if (!window.confirm("Удалить домен " + group.canonical.displayHostname + "? HTTPS перестанет работать после обновления Caddy.")) return;
    void run("remove-" + group.id, async () => {
      await removeCustomDomain(projectId, group.canonical.id);
      setChecks(null);
      await load(true);
    });
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied(""), 1500);
    } catch {
      setError("Не удалось скопировать значение");
    }
  };

  if (!enabled) return null;

  const allActive = groups.length > 0 && groups.every(group => group.domains.every(domain => domain.status === "active"));
  const currentStep = groups.length === 0 ? 1 : allActive ? 3 : 2;
  const steps = [
    { number: 1, label: "Домен" },
    { number: 2, label: "DNS" },
    { number: 3, label: "HTTPS" },
  ];

  return <section className="custom-domain-card">
    <div className="custom-domain-head">
      <div>
        <span className="hosting-kicker">Свой домен</span>
        <h3><Globe2 size={16}/> Адрес на вашем домене</h3>
        <p>Один домен и его <code>www</code>. Второй адрес будет перенаправляться на основной через 301.</p>
      </div>
      <span className="domain-plan-badge"><LockKeyhole size={11}/> Плюс / Премиум</span>
    </div>

    <div className="domain-steps" aria-label="Шаги подключения">
      {steps.map(step => <div
        className={"domain-step " + (step.number < currentStep ? "done " : "") + (step.number === currentStep ? "active" : "")}
        key={step.number}
      >
        <span>{step.number < currentStep ? <Check size={10}/> : step.number}</span>
        {step.label}
      </div>)}
    </div>

    {error ? <div className="hosting-alert error"><AlertTriangle size={14}/><span>{error}</span></div> : null}

    {loading && !state ? <div className="domain-loading"><Loader2 size={16} className="spin"/> Читаем домены…</div> : null}

    {state && limit === 0 && groups.length === 0 ? <div className="domain-locked">
      <LockKeyhole size={20}/>
      <div>
        <strong>Свой домен доступен на «Плюсе» и «Премиуме»</strong>
        <p>Сайт работает на адресе платформы. Свой домен можно подключить после смены тарифа.</p>
      </div>
    </div> : null}

    {state && groups.length === 0 && limit > 0 ? <div className="domain-add">
      <div className="domain-add-title"><Server size={14}/><strong>Подключите домен</strong></div>
      <p>Укажите apex-домен. Мы добавим <code>www</code> отдельной записью, если вы отметите галочку.</p>
      <div className="domain-form-row">
        <input
          value={hostname}
          onChange={event => setHostname(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
          placeholder="example.ru"
          maxLength={253}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Домен"
          disabled={Boolean(busy)}
        />
        <button className="primary-button" onClick={add} disabled={Boolean(busy) || !hostname.trim()}>
          {busy === "add" ? <Loader2 size={13} className="spin"/> : <Globe2 size={13}/>} Подключить
        </button>
      </div>
      <label className="domain-check">
        <input type="checkbox" checked={includeWww} onChange={event => setIncludeWww(event.target.checked)} disabled={Boolean(busy)}/>
        <span>Добавить <code>www.{hostname.trim() || "example.ru"}</code></span>
      </label>
      <small>Домен должен быть вашим. После добавления появятся TXT-запись для подтверждения и A/CNAME для трафика.</small>
    </div> : null}

    {state && groups.length > 0 ? <div className="domain-groups">
      {groups.map(group => {
        const groupChecks = checks?.filter(item => group.domains.some(domain => domain.hostname === item.hostname)) ?? [];
        return <div className="domain-group" key={group.id}>
          <div className="domain-group-head">
            <div className="domain-group-title">
              <span className="domain-hostname">{group.canonical.displayHostname}</span>
              <span className={"domain-status " + statusTone(group.canonical.status)}>{statusLabel(group.canonical.status)}</span>
              {group.domains.length > 1 ? <span className="domain-www">+ www</span> : null}
            </div>
            <div className="domain-group-actions">
              <button className="ghost-button" onClick={() => void check(group)} disabled={Boolean(busy)}>
                {busy === "check-" + group.id ? <Loader2 size={12} className="spin"/> : <RefreshCw size={12}/>} Проверить DNS
              </button>
              <button className="ghost-button danger" onClick={() => remove(group)} disabled={Boolean(busy)} title="Удалить домен">
                <Trash2 size={12}/>
              </button>
            </div>
          </div>

          {group.canonical.status === "active" ? <div className="domain-active">
            <ShieldCheck size={14}/>
            <span>HTTPS работает. Основной адрес:</span>
            <a href={"https://" + group.canonical.hostname} target="_blank" rel="noreferrer">
              {group.canonical.displayHostname}<ExternalLink size={11}/>
            </a>
          </div> : null}

          {group.canonical.lastError || group.canonical.certificateError ? <div className="domain-note">
            <AlertTriangle size={12}/>
            <span>{group.canonical.lastError || group.canonical.certificateError}</span>
          </div> : null}

          <div className="domain-dns">
            <div className="domain-dns-head">
              <strong>DNS-записи</strong>
              <span>Добавьте их у регистратора домена</span>
            </div>
            {group.domains.map(domain => <div className="domain-dns-host" key={domain.id}>
              <div className="domain-dns-host-name">
                <span>{domain.displayHostname}</span>
                {domain.isCanonical ? <span className="domain-canonical">основной</span> : null}
              </div>
              {domain.dns.map(record => <div className="domain-record" key={record.type + record.purpose}>
                <span className={"domain-record-type " + record.type.toLowerCase()}>{record.type}</span>
                <div className="domain-record-name">
                  <strong>{record.relativeName || record.name}</strong>
                  <span>{record.purpose === "verification" ? "подтверждение владения" : "трафик на сайт"}</span>
                </div>
                <code title={record.name}>{record.value}</code>
                <button className="icon-button" onClick={() => void copy(record.value)} title="Скопировать значение" aria-label="Скопировать значение">
                  {copied === record.value ? <Check size={12}/> : <Copy size={12}/>}
                </button>
              </div>)}
              {group.domains.length > 1 && !domain.isCanonical ? <button
                className="domain-canonical-button"
                onClick={() => makeCanonical(domain)}
                disabled={Boolean(busy)}
              >Сделать {domain.kind === "www" ? "www" : "apex"} основным</button> : null}
            </div>)}
          </div>

          {groupChecks.length > 0 ? <div className="domain-checks">
            {groupChecks.map(item => <div className={"domain-check-row " + (item.txt.allowed && item.traffic.allowed && item.caa.allowed ? "ok" : "wait")} key={item.hostname}>
              {item.txt.allowed && item.traffic.allowed && item.caa.allowed ? <Check size={11}/> : <AlertTriangle size={11}/>}
              <span>{item.hostname}</span>
              <span>{item.txt.reason || item.traffic.reason || item.caa.reason || "DNS и CAA в порядке"}</span>
            </div>)}
          </div> : null}
        </div>;
      })}
    </div> : null}

    {state && groups.length > 0 && groups.length < limit ? <div className="domain-add domain-add-after">
      <div className="domain-add-title"><Globe2 size={14}/><strong>Ещё один домен</strong></div>
      <div className="domain-form-row">
        <input
          value={hostname}
          onChange={event => setHostname(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
          placeholder="example.ru"
          maxLength={253}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Ещё один домен"
          disabled={Boolean(busy)}
        />
        <button className="ghost-button" onClick={add} disabled={Boolean(busy) || !hostname.trim()}>
          {busy === "add" ? <Loader2 size={12} className="spin"/> : <Globe2 size={12}/>} Добавить
        </button>
      </div>
    </div> : null}

    {state ? <p className="domain-footnote">
      Для apex-домена нужна A-запись на <code>{state.ip}</code>; для <code>www</code> — CNAME на <code>{state.target}</code>.
      Если регистратор не поддерживает A для apex, используйте ALIAS/ANAME на тот же target.
    </p> : null}
  </section>;
}

function statusTone(status: CustomDomainStatus) {
  if (status === "active") return "active";
  if (status === "error") return "error";
  if (status === "configuring" || status === "issuing_certificate") return "issuing";
  return "waiting";
}

function statusLabel(status: CustomDomainStatus) {
  if (status === "pending_dns") return "Ожидает DNS";
  if (status === "verified") return "Домен подтверждён";
  if (status === "configuring") return "Настраиваем HTTPS";
  if (status === "issuing_certificate") return "Выпускаем сертификат";
  if (status === "active") return "HTTPS работает";
  return "Ошибка";
}
