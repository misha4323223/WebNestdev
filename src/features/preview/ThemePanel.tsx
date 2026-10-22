import { Check, Loader2, Palette, Pipette, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createProjectTheme, getProjectTheme, saveProjectTheme, type ProjectTheme, type ThemeField } from "../../lib/project-api";
import { composeAgentPrompt, THEME_SETUP_PROMPT } from "../../lib/agent-compose";

/**
 * Тема проекта: палитра, шрифтовая пара и скругление.
 *
 * Панель правит ровно те переменные, которые читает агент (см. server/src/design/theme.ts),
 * поэтому цвет, выбранный здесь мышкой, попадает и в предпросмотр, и в собранный сайт — без
 * запроса к модели и без расхода лимита.
 *
 * Файла темы может не быть: у проекта, собранного до появления палитры, его просто нет. Тогда
 * панель создаёт `theme.css` сама, с полоской хода работы, — отправлять человека к агенту за
 * одной таблицей значений незачем. Если же файл есть, а стили проекта его переменные не читают,
 * панель говорит это прямо: иначе «нажимаю — ничего не происходит» выглядит поломкой панели.
 */

/** `EyeDropper` есть не во всех браузерах, поэтому в типах его нет: объявление локальное. */
type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Нативное поле цвета понимает только полный hex: `#abc` расширяется в `#aabbcc`. */
function expandHex(value: string) {
  if (!HEX.test(value)) return "#000000";
  if (value.length === 7) return value.toLowerCase();
  return ("#" + value.slice(1).split("").map(char => char + char).join("")).toLowerCase();
}

/** Шаги создания файла темы: проценты показывают ход работы, а не выдуманное время. */
const CREATE_STEPS = { start: 12, file: 45, read: 70, preview: 92, done: 100 } as const;

function ColorRow({ field, value, onChange, eyedropper }: {
  field: ThemeField;
  value: string;
  onChange: (next: string) => void;
  eyedropper?: EyeDropperConstructor;
}) {
  const [text, setText] = useState(value);
  // Значение могло измениться снаружи (загрузка темы, «Сбросить») — поле текста идёт за ним.
  useEffect(() => { setText(value) }, [value]);
  const [picking, setPicking] = useState(false);

  function commit(next: string) {
    setText(next);
    const trimmed = next.trim();
    if (HEX.test(trimmed)) onChange(trimmed.toLowerCase());
  }

  async function pick() {
    if (!eyedropper || picking) return;
    setPicking(true);
    try {
      const result = await new eyedropper().open();
      if (/^#[0-9a-f]{6}$/i.test(result.sRGBHex)) onChange(result.sRGBHex.toLowerCase());
    } catch {
      // Отмена пипетки — обычное действие, а не ошибка: значение остаётся прежним.
    } finally {
      setPicking(false);
    }
  }

  return <div className="theme-color-row">
    <label className="theme-color-chip" style={{ background: expandHex(value) }} title={field.label}>
      <input type="color" value={expandHex(value)} onChange={event => onChange(event.target.value.toLowerCase())} aria-label={field.label}/>
    </label>
    <div className="theme-color-meta">
      <span>{field.label}</span>
      <input className={"theme-color-hex" + (HEX.test(text.trim()) ? "" : " invalid")} value={text} spellCheck={false} autoComplete="off" onChange={event => commit(event.target.value)} aria-label={field.label + ": значение"}/>
    </div>
    {eyedropper && <button type="button" className={"theme-pick" + (picking ? " active" : "")} onClick={() => void pick()} title="Взять цвет с экрана" aria-label={"Взять цвет с экрана: " + field.label}>
      <Pipette size={13}/>
    </button>}
  </div>;
}

export function ThemePanel({ projectId, onClose, onApplied }: {
  projectId: string;
  onClose: () => void;
  /** Вызывается после записи: кадр предпросмотра перезагружается и показывает новую палитру. */
  onApplied: () => void;
}) {
  const [theme, setTheme] = useState<ProjectTheme | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [progress, setProgress] = useState<{ percent: number; label: string } | null>(null);
  const savedTimer = useRef<number | null>(null);
  // StrictMode в разработке монтирует компонент дважды: без этого флага файл темы создавался бы
  // двумя параллельными запросами (сервер идемпотентен, но полоска хода мигала бы дважды).
  const creating = useRef(false);

  const eyedropper = useMemo<EyeDropperConstructor | undefined>(() => {
    const api = (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
    return typeof api === "function" ? api : undefined;
  }, []);

  function apply(next: ProjectTheme) {
    setTheme(next);
    setDraft(next.fields.reduce<Record<string, string>>((values, field) => {
      values[field.variable] = next.tokens[field.variable] ?? field.value;
      return values;
    }, {}));
  }

  /**
   * Создание файла темы. Это единственный шаг, который видит полоску хода: он ходит на сервер,
   * а после записи сервер ещё и пересобирает статический предпросмотр, поэтому пауза заметна.
   */
  async function create() {
    if (creating.current) return;
    creating.current = true;
    setError("");
    setProgress({ percent: CREATE_STEPS.start, label: "Создаём файл темы…" });
    try {
      const next = await createProjectTheme(projectId);
      setProgress({ percent: CREATE_STEPS.file, label: "Читаем палитру проекта…" });
      apply(next);
      setProgress({ percent: CREATE_STEPS.preview, label: "Обновляем предпросмотр…" });
      onApplied();
      setProgress({ percent: CREATE_STEPS.done, label: "Палитра готова" });
      window.setTimeout(() => setProgress(null), 700);
    } catch (failure) {
      setProgress(null);
      setError(failure instanceof Error ? failure.message : "Не удалось создать файл темы");
    } finally {
      creating.current = false;
    }
  }

  async function load() {
    setError("");
    try {
      const next = await getProjectTheme(projectId);
      if (next.present) {
        apply(next);
        return;
      }
      // Файла нет — панель заводит его сама, вместо пустого экрана и похода к агенту.
      await create();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось прочитать тему проекта");
    }
  }

  useEffect(() => { void load() }, [projectId]);
  useEffect(() => () => { if (savedTimer.current) window.clearTimeout(savedTimer.current) }, []);

  const dirty = Boolean(theme?.present) && theme!.fields.some(field => draft[field.variable] !== (theme!.tokens[field.variable] ?? field.value));

  function set(variable: string, value: string) {
    setDraft(current => ({ ...current, [variable]: value }));
    setSaved(false);
  }

  async function save() {
    if (!theme?.present || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await saveProjectTheme(projectId, draft);
      apply(next);
      setSaved(true);
      onApplied();
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 1800);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось сохранить тему");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!theme) return;
    setDraft(theme.fields.reduce<Record<string, string>>((values, field) => {
      values[field.variable] = theme.tokens[field.variable] ?? field.value;
      return values;
    }, {}));
    setSaved(false);
  }

  function askAgent() {
    composeAgentPrompt(THEME_SETUP_PROMPT);
    onClose();
  }

  const colors = theme?.fields.filter(field => field.kind === "color") ?? [];
  const fonts = theme?.fields.filter(field => field.kind === "font") ?? [];
  const radius = theme?.fields.find(field => field.kind === "radius");
  // Файл есть, но страница читает свои цвета напрямую: палитра сохранится и ничего не изменит.
  const unused = Boolean(theme?.present) && theme!.used === false;

  return <section className="theme-sheet" aria-label="Тема проекта">
    <div className="theme-head">
      <div className="theme-title">
        <span className="eyebrow">ТЕМА</span>
        <strong>Палитра и шрифты</strong>
      </div>
      <button className="icon-button" onClick={onClose} title="Закрыть" aria-label="Закрыть тему"><X size={15}/></button>
    </div>

    <div className="theme-body">
      {progress && <div className="theme-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={progress.label}>
        <div className="theme-progress-track"><div className="theme-progress-fill" style={{ width: progress.percent + "%" }}/></div>
        <div className="theme-progress-meta"><span>{progress.label}</span><b>{progress.percent}%</b></div>
      </div>}

      {!theme && !error && !progress && <div className="theme-loading"><Loader2 size={16} className="spin"/> Загружаем тему проекта…</div>}
      {error && <div className="theme-error">{error}</div>}

      {!theme && !progress && error && <div className="theme-empty">
        <div className="theme-empty-icon"><Palette size={20}/></div>
        <strong>Не удалось подготовить файл темы</strong>
        <p>
          Палитра живёт в файле <code>theme.css</code>: его переменные используют компоненты.
          Повторите попытку — файл создаётся одним запросом, без участия модели.
        </p>
        <button className="theme-action theme-empty-action" onClick={() => void create()}>
          <Palette size={14}/> Создать палитру
        </button>
      </div>}

      {theme?.present && <>
        {unused && <div className="theme-warning" role="status">
          <TriangleAlert size={14}/>
          <div>
            <strong>Страница не использует переменные темы</strong>
            <span>
              Файл <code>{theme.file}</code> есть, но стили проекта берут цвета напрямую, поэтому смена
              палитры их не перекрасит. Перевести цвета на <code>var(--color-…)</code> может агент —
              это правка файлов, а не запись токена.
            </span>
            <button className="ghost-button theme-warning-action" onClick={askAgent}>
              <Sparkles size={13}/> Перевести цвета на тему
            </button>
          </div>
        </div>}

        <div className="theme-group">
          <div className="theme-group-head">
            <span>Цвета</span>
            {eyedropper && <small>пипетка берёт цвет с экрана</small>}
          </div>
          {colors.map(field => <ColorRow
            key={field.variable}
            field={field}
            value={draft[field.variable] ?? field.value}
            onChange={next => set(field.variable, next)}
            eyedropper={eyedropper}
          />)}
        </div>

        <div className="theme-group">
          <div className="theme-group-head"><span>Шрифты</span></div>
          {fonts.map(field => <label className="theme-font-row" key={field.variable}>
            <span>{field.label}</span>
            <select value={draft[field.variable] ?? field.value} onChange={event => set(field.variable, event.target.value)}>
              {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>)}
        </div>

        {radius && <div className="theme-group">
          <div className="theme-group-head"><span>{radius.label}</span><small>{Number.parseInt(draft[radius.variable] ?? radius.value, 10) || 0} px</small></div>
          <input
            className="theme-range"
            type="range"
            min={0}
            max={32}
            step={1}
            value={Number.parseInt(draft[radius.variable] ?? radius.value, 10) || 0}
            onChange={event => set(radius.variable, event.target.value + "px")}
            aria-label={radius.label}
          />
        </div>}

        <p className="theme-note">
          Файл темы: <code>{theme.file}</code>. Те же значения доступны агенту — он не перекрашивает
          страницу мимо токенов.
        </p>
      </>}
    </div>

    {theme?.present && <div className="theme-foot">
      <button className="ghost-button" onClick={reset} disabled={!dirty || busy}>Сбросить</button>
      <button className="theme-action theme-save" onClick={() => void save()} disabled={!dirty || busy}>
        {busy ? <><Loader2 size={13} className="spin"/> Сохраняем</> : saved ? <><Check size={13}/> Сохранено</> : "Сохранить"}
      </button>
    </div>}
  </section>;
}
