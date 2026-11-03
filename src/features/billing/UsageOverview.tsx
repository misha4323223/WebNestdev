import { Plus, RefreshCw } from "lucide-react";
import {
  bytesLabel,
  creditsLabel,
  tokensLabel,
  type BillingData,
  type CostModel,
} from "../../lib/billing-api";

/**
 * Один блок вместо двух отдельных карточек: кредиты агента, хранилище аккаунта и расход
 * по публичным моделям NestDev. Так в кабинете видно, что именно закончится раньше, без
 * переключения между шкалами. Upstream-модель сюда не попадает — только имя продукта.
 */
export function UsageOverview({ billing, paid, onTopUp, onRefreshStorage, refreshingStorage = false }: {
  billing: BillingData;
  paid: boolean;
  onTopUp?: () => void;
  onRefreshStorage?: () => void;
  refreshingStorage?: boolean;
}) {
  const credits = billing.credits;
  const creditLimit = credits?.limit ?? 0;
  const creditUsed = credits?.used ?? 0;
  const creditRemaining = credits?.remaining ?? 0;
  const purchased = credits?.purchased ?? 0;
  const creditState = creditLimit > 0
    ? (creditRemaining <= 0 ? "full" : creditUsed >= creditLimit * 0.8 ? "warning" : "ok")
    : "ok";
  const runsLimit = billing.limits.agentRunsPerDay ?? null;

  const storageLimit = billing.limits.storageBytes ?? 0;
  const storageUsed = billing.storage?.usedBytes ?? 0;
  const storagePercent = storageLimit > 0 ? Math.min(100, Math.round(storageUsed / storageLimit * 100)) : 0;
  const storageState = billing.storage?.state ?? (storageLimit > 0
    ? (storageUsed >= storageLimit ? "full" : storageUsed >= storageLimit * 0.8 ? "warning" : "ok")
    : "ok");
  const storageProjects = billing.storage?.projects ?? [];
  const storageMeasuredAt = billing.storage?.measuredAt
    ? new Date(billing.storage.measuredAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";

  const modelRows = modelUsageRows(billing.cost.models ?? []);
  const hasModelUsage = modelRows.some(model => model.promptTokens + model.completionTokens > 0);

  return <section className="usage-overview">
    <div className="usage-overview-head">
      <div>
        <span className="eyebrow">РЕСУРСЫ</span>
        <h2>Кредиты и хранилище</h2>
      </div>
      <small>Сегодня · {billing.usage.date}</small>
    </div>

    <div className="usage-overview-grid">
      <article className={"usage-resource" + (creditState === "ok" ? "" : " is-" + creditState)}>
        <header>
          <span>Кредиты агента</span>
          <strong>{creditLimit > 0 ? creditsLabel(creditUsed) + " / " + creditsLabel(creditLimit) : "—"}</strong>
        </header>
        {creditLimit > 0
          ? <div className="usage-meter-track"><span style={{ width: `${Math.min(100, creditUsed / Math.max(1, creditLimit) * 100)}%` }}/></div>
          : runsLimit != null
            ? <div className="usage-meter-track"><span style={{ width: `${Math.min(100, billing.usage.agentRuns / Math.max(1, runsLimit) * 100)}%` }}/></div>
            : null}
        <div className="usage-resource-meta">
          {creditLimit > 0
            ? <span><em>Осталось</em><b>{creditsLabel(creditRemaining)}</b></span>
            : runsLimit != null
              ? <span><em>Запуски сегодня</em><b>{billing.usage.agentRuns} / {runsLimit}</b></span>
              : <span><em>Кредиты</em><b>не подключены</b></span>}
          <span><em>Докуплено</em><b>{creditsLabel(purchased)}</b></span>
        </div>
        <p className="usage-resource-note">{creditLimit > 0
          ? "Месячный лимит сбрасывается 1-го числа. Докупленные кредиты не сгорают."
          : runsLimit != null
            ? "На бесплатном тарифе запуски считаются по дням."
            : "На этом тарифе кредиты не начисляются."}</p>
        {paid && onTopUp && <button type="button" className="ghost-button usage-resource-action" onClick={onTopUp}>
          <Plus size={12}/> Докупить кредиты
        </button>}
      </article>

      <article className={"usage-resource" + (storageState === "ok" ? "" : " is-" + storageState)}>
        <header>
          <span>Хранилище аккаунта</span>
          <strong>{storageLimit > 0 ? bytesLabel(storageUsed) + " / " + bytesLabel(storageLimit) : "—"}</strong>
        </header>
        <div className="usage-meter-track"><span style={{ width: `${storagePercent}%` }}/></div>
        <div className="usage-resource-meta">
          <span><em>Занято</em><b>{storagePercent}%</b></span>
          <span><em>Свободно</em><b>{bytesLabel(Math.max(0, storageLimit - storageUsed))}</b></span>
        </div>
        {storageState !== "ok" && <p className={"usage-resource-note " + storageState}>{storageState === "full"
          ? "Лимит исчерпан: запись файлов агентом приостановлена."
          : "Место заканчивается: освободите проект или смените тариф."}</p>}
        {(storageProjects.length > 0 || onRefreshStorage) && <details className="usage-storage-details">
          <summary>Проекты <span>{storageProjects.length}</span></summary>
          <div className="storage-projects">
            <div className="storage-projects-head">
              <strong>Размер по проектам</strong>
              {onRefreshStorage && <button type="button" className="ghost-button storage-refresh" onClick={onRefreshStorage} disabled={refreshingStorage}>
                <RefreshCw size={11} className={refreshingStorage ? "spin" : ""}/> {refreshingStorage ? "Считаем…" : "Пересчитать"}
              </button>}
            </div>
            {storageProjects.length === 0
              ? <p className="storage-empty">Проектов пока нет — размер появится после первого файла.</p>
              : storageProjects.slice(0, 6).map(project => <div className="storage-project" key={project.id}>
                  <span className="storage-project-name" title={project.name}>{project.name}</span>
                  <span className="storage-project-size">{bytesLabel(project.sizeBytes)}</span>
                  <span className="storage-project-share" title="Доля квоты аккаунта">{storageLimit > 0 ? Math.round(project.sizeBytes / storageLimit * 100) : 0}%</span>
                </div>)}
            {storageProjects.length > 6 && <p className="storage-empty">и ещё {storageProjects.length - 6} проектов</p>}
          </div>
          <p className="storage-hint">В размер входят все файлы проекта, включая зависимости и сборки.{storageMeasuredAt ? " Обновлено " + storageMeasuredAt + "." : ""} Сверка повторяется раз в сутки.</p>
        </details>}
      </article>
    </div>

    <div className="usage-models">
      <div className="usage-models-head">
        <strong>Модели NestDev сегодня</strong>
        <small>вход / выход токенов</small>
      </div>
      <table>
        <thead><tr><th>Модель</th><th>Вход</th><th>Выход</th><th>Запуски</th></tr></thead>
        <tbody>{modelRows.map(model => <tr key={model.id}>
          <th scope="row">{model.name}</th>
          <td>{tokensLabel(model.promptTokens)}</td>
          <td>{tokensLabel(model.completionTokens)}</td>
          <td>{model.runs}</td>
        </tr>)}</tbody>
      </table>
      {!hasModelUsage && <p className="usage-models-empty">Сегодня запусков на моделях NestDev ещё не было.</p>}
    </div>
    <p className="usage-overview-hint">Кредиты считаются только для моделей платформы. Свой AI-провайдер проекта не тратит кредиты NestDev.</p>
  </section>;
}

/** Публичные строки: Mini и Max видны всегда, остальные — только если на них были запуски. */
function modelUsageRows(models: CostModel[]): CostModel[] {
  const known: CostModel[] = [
    { id: "nestdev", name: "NestDev", promptTokens: 0, completionTokens: 0, runs: 0 },
    { id: "mini", name: "NestDev Mini", promptTokens: 0, completionTokens: 0, runs: 0 },
    { id: "max", name: "NestDev Max", promptTokens: 0, completionTokens: 0, runs: 0 },
  ];
  const used = new Map(models.map(model => [model.id, model]));
  const rows = known.map(model => used.get(model.id) ?? model);
  for (const model of models) {
    if (!rows.some(row => row.id === model.id) && model.promptTokens + model.completionTokens > 0) rows.push(model);
  }
  return rows;
}
