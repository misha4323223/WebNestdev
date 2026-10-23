import { Check, Loader2, Palette, Pipette, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createProjectTheme, getProjectTheme, saveProjectTheme, type ProjectTheme, type ThemeField } from "../../lib/project-api";
import { composeAgentPrompt, THEME_SETUP_PROMPT } from "../../lib/agent-compose";

/**
 * Палитра проекта: цвета, шрифты и скругление — те переменные, которые проект объявил сам.
 *
 * Панель показывает настоящую палитру страницы, а не значения по умолчанию: у проекта по
 * контракту это `--color-…` из `theme.css`, у проекта постарше — свои `--bg`/`--ink` из
 * `styles.css`. Правка уходит в тот файл, где переменная объявлена, поэтому цвет появляется в
 * предпросмотре без запроса к модели.
 *
 * Если переменных нет или страница их не читает, панель говорит это прямо и предлагает
 * перевести стили на переменные: «нажимаю — ничего не происходит» иначе выглядит поломкой панели.
 */

/** `EyeDropper` есть не во всех браузерах, поэтому в типах его нет: объявление локальное. */
type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Больше этого скругление не задаётся — тот же предел, что проверяет сервер. */
const MAX_RADIUS = 40;

/** Нативное поле цвета понимает только полный hex: `#abc` расширяется в `#aabbcc`. */
function expandHex(value: string) {
  if (!HEX.test(value)) return "#000000";
  if (value.length === 7) return value.toLowerCase();
  return ("#" + value.slice(1).split("").map(char => char + char).join("")).toLowerCase();
}

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

  return <div className={"theme-color-row" + (field.used === false ? " unused" : "")}>
    <label className="theme-color-chip" style={{ background: expandHex(value) }} title={field.label}>
      <input type="color" value={expandHex(value)} onChange={event => onChange(event.target.value.toLowerCase())} aria-label={field.label}/>
    </label>
    <div className="theme-color-meta">
      <span>{field.label}{field.used === false && <em className="theme-unused-mark">не используется</em>}</span>
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
  /** Шаги создания палитры: проценты показывают ход работы, а не выдуманное время. */
  const [progress, setProgress] = useState<{ percent: number; label: string } | null>(null);
  const savedTimer = useRef<number | null>(null);
  // StrictMode в разработке монтирует компонент дважды: без этого флага стили проекта
  // переписывались бы двумя параллельными запросами.
  const creating = useRef(false);

  const eyedropper = useMemo<EyeDropperConstructor | undefined>(() => {
    const api = (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
    return typeof api === "function" ? api : undefined;
  }, []);

  function apply(next: ProjectTheme) {
    setTheme(next);
    setDraft(next.fields.reduce<Record<string, string>>((values, field) => {
      values[field.variable] = field.value;
      return values;
    }, {}));
  }

  /**
   * Создание палитры. Панель делает это сама, когда переменных в проекте нет: собрать токены из
   * фактических цветов страницы и перевести совпавшие значения на `var()` — механическая работа,
   * ради которой не нужен прогон модели. Пока запрос идёт, полоска медленно движется к 80%:
   * на сервере это чтение стилей, перезапись файлов и пересборка предпросмотра.
   */
  async function create(fallback: ProjectTheme) {
    if (creating.current) return;
    creating.current = true;
    setError("");
    setProgress({ percent: 8, label: "Собираем палитру из цветов страницы…" });
    const creep = window.setInterval(() => {
      setProgress(current => current && current.percent < 80
        ? { percent: Math.min(80, current.percent + 4), label: current.label }
        : current);
    }, 220);
    try {
      const next = await createProjectTheme(projectId);
      setProgress({ percent: 92, label: "Обновляем предпросмотр…" });
      apply(next);
      if (next.present) {
        onApplied();
        setProgress({ percent: 100, label: "Палитра готова" });
        window.setTimeout(() => setProgress(null), 600);
      } else {
        setProgress(null);
        setError(next.reason ?? "В стилях проекта не нашлось цветов для палитры");
      }
    } catch (failure) {
      // Сервер отказал — показываем пустое состояние с объяснением, а не вечную загрузку.
      apply(fallback);
      setProgress(null);
      setError(failure instanceof Error ? failure.message : "Не удалось создать палитру");
    } finally {
      window.clearInterval(creep);
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
      // Переменных нет — панель заводит тему сама, вместо пустого экрана и похода к агенту.
      await create(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось прочитать палитру проекта");
    }
  }

  useEffect(() => { void load() }, [projectId]);
  useEffect(() => () => { if (savedTimer.current) window.clearTimeout(savedTimer.current) }, []);

  const dirty = Boolean(theme?.present) && theme!.fields.some(field => (draft[field.variable] ?? field.value) !== field.value);
  /** Есть объявления, но страница их не читает: сохранение ничего не перекрасит. */
  const unused = Boolean(theme?.present) && theme!.used === false;
  const unusedCount = theme?.present ? theme!.fields.filter(field => field.used === false).length : 0;

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
      setError(failure instanceof Error ? failure.message : "Не удалось сохранить палитру");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!theme) return;
    setDraft(theme.fields.reduce<Record<string, string>>((values, field) => {
      values[field.variable] = field.value;
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
  // Файлы палитры: их может быть несколько, если проект объявил свои переменные в styles.css.
  const files = Array.from(new Set(theme?.fields.map(field => field.file).filter(Boolean) as string[]));

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
      {!theme && !error && !progress && <div className="theme-loading"><Loader2 size={16} className="spin"/> Загружаем палитру проекта…</div>}
      {error && <div className="theme-error">{error}</div>}

      {theme && !theme.present && !progress && <div className="theme-empty">
        <div className="theme-empty-icon"><Palette size={20}/></div>
        <strong>В стилях не нашлось цветов для палитры</strong>
        <p>
          Панель уже проверила CSS, inline-стили и классы Tailwind: цветов для палитры там нет —
          они собраны в коде или приходят из картинок. Агент переведёт цвета, шрифты и скругления
          на переменные и подключит файл темы.
        </p>
        <div className="theme-empty-actions">
          <button className="ghost-button theme-empty-retry" onClick={() => void create(theme)}>Попробовать снова</button>
          <button className="theme-action theme-empty-action" onClick={askAgent}>
            <Sparkles size={14}/> Перевести цвета на тему
          </button>
        </div>
      </div>}

      {theme?.present && <>
        {unused && <div className="theme-warning" role="status">
          <TriangleAlert size={14}/>
          <div>
            <strong>Страница не читает переменные палитры</strong>
            <span>
              Переменные объявлены, но в стилях и разметке нет <code>var(--…)</code>: смена палитры
              их не перекрасит. Агент заменит вписанные напрямую цвета на переменные — это правка
              файлов, а не запись значения.
            </span>
            <button className="ghost-button theme-warning-action" onClick={askAgent}>
              <Sparkles size={13}/> Перевести цвета на тему
            </button>
          </div>
        </div>}

        {!unused && unusedCount > 0 && <p className="theme-hint">
          Страница не читает {unusedCount === 1 ? "одну переменную" : unusedCount + " переменных"} из списка — они помечены.
        </p>}

        {colors.length > 0 && <div className="theme-group">
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
        </div>}

        {fonts.length > 0 && <div className="theme-group">
          <div className="theme-group-head"><span>Шрифты</span></div>
          {fonts.map(field => {
            const value = draft[field.variable] ?? field.value;
            const options = field.options ?? [];
            // У проекта может быть свой стек, которого нет в готовых парах: без этой строки
            // список показал бы чужой шрифт, а «Сохранить» записал бы его в файл.
            const own = options.some(option => option.value === value) ? [] : [{ value, label: "Свой стек (текущий)" }];
            return <label className="theme-font-row" key={field.variable}>
              <span>{field.label}{field.used === false && <em className="theme-unused-mark">не используется</em>}</span>
              <select value={value} onChange={event => set(field.variable, event.target.value)}>
                {[...options, ...own].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>;
          })}
        </div>}

        {radius && <div className="theme-group">
          <div className="theme-group-head">
            <span>{radius.label}{radius.used === false && <em className="theme-unused-mark">не используется</em>}</span>
            <small>{Number.parseInt(draft[radius.variable] ?? radius.value, 10) || 0} px</small>
          </div>
          <input
            className="theme-range"
            type="range"
            min={0}
            max={MAX_RADIUS}
            step={1}
            value={Math.min(MAX_RADIUS, Number.parseInt(draft[radius.variable] ?? radius.value, 10) || 0)}
            onChange={event => set(radius.variable, event.target.value + "px")}
            aria-label={radius.label}
          />
        </div>}

        <p className="theme-note">
          Значения живут в {files.length > 1 ? "файлах" : "файле"}{" "}
          {files.map((file, index) => <span key={file}>{index > 0 ? ", " : ""}<code>{file}</code></span>)}.
          Панель меняет только объявления переменных, остальные правила файла не трогает.
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
