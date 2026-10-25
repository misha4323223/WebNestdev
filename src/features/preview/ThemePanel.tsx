import { Check, Loader2, Palette, Pipette, SlidersHorizontal, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createProjectTheme, getProjectTheme, saveProjectTheme, type ProjectTheme, type ThemeField } from "../../lib/project-api";
import { composeAgentPrompt, THEME_SETUP_PROMPT } from "../../lib/agent-compose";
import { Hint } from "../../components/Hint";

/**
 * Палитра проекта: цвета, шрифты, скругление и размеры — те переменные, которые проект объявил сам.
 *
 * Панель показывает настоящую палитру страницы, а не значения по умолчанию: у проекта по
 * контракту это `--color-…` из `theme.css`, у проекта постарше — свои `--bg`/`--ink` из
 * `styles.css`. Правка уходит в тот файл, где переменная объявлена, поэтому цвет появляется в
 * предпросмотре без запроса к модели.
 *
 * Вкладка «Конструктор» — это не отдельный редактор исходников: она применяет готовые образы
 * к уже найденным цветам и даёт руками подвинуть размеры и отступы, которые проект объявил
 * переменными. Ничего не пересчитывается на сервере сверх одной записи файла.
 */

/** `EyeDropper` есть не во всех браузерах, поэтому в типах его нет: объявление локальное. */
type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Больше этого скругление не задаётся — тот же предел, что проверяет сервер. */
const MAX_RADIUS = 40;
const SIZE = /^(-?\d+(?:\.\d+)?)(px|rem|em|%|vw|vh|vmin|vmax|ch)?$/i;

type Tab = "theme" | "constructor";
type PresetRole = "bg" | "surface" | "text" | "muted" | "accent" | "border";
type PalettePreset = { id: string; label: string; colors: Record<PresetRole, string> };

/**
 * Готовые образы. Это не «темы со своим CSS»: панель раскладывает цвета по ролям уже найденных
 * переменных, поэтому образ работает и у проекта с контрактными `--color-…`, и у старого с
 * `--bg`/`--ink`. Незнакомые роли не трогаются — лучше не перекрасить, чем перекрасить не то.
 */
const PRESETS: PalettePreset[] = [
  { id: "dark", label: "Тёмная", colors: { bg: "#0b0d10", surface: "#14181d", text: "#eef0f3", muted: "#8b939e", accent: "#6fbf8b", border: "#242a31" } },
  { id: "light", label: "Светлая", colors: { bg: "#f7f6f2", surface: "#ffffff", text: "#1b1f24", muted: "#6b7280", accent: "#2f7a55", border: "#e2e0d9" } },
  { id: "warm", label: "Тёплая", colors: { bg: "#fbf5ec", surface: "#fffaf2", text: "#2a2118", muted: "#7c6a58", accent: "#b5643c", border: "#e8d8c4" } },
  { id: "nature", label: "Природная", colors: { bg: "#f1f5ef", surface: "#ffffff", text: "#1f2a22", muted: "#63756a", accent: "#3f7d58", border: "#d7e2d8" } },
  { id: "sea", label: "Морская", colors: { bg: "#f2f7fa", surface: "#ffffff", text: "#102a36", muted: "#5d7480", accent: "#1f7a8c", border: "#d3e2e9" } },
  { id: "graphite", label: "Графит", colors: { bg: "#17191c", surface: "#202328", text: "#f0f1f3", muted: "#9aa0a8", accent: "#c9a227", border: "#2f343a" } },
];

/** Нативная поле цвета понимает только полный hex: `#abc` расширяется в `#aabbcc`. */
function expandHex(value: string) {
  if (!HEX.test(value)) return "#000000";
  if (value.length === 7) return value.toLowerCase();
  return ("#" + value.slice(1).split("").map(char => char + char).join("")).toLowerCase();
}

/**
 * Роль цвета по имени переменной. Контрактные имена точные, остальные — по словам в имени:
 * `--card-bg` — поверхность, `--line` — граница, `--ink` — текст. Если роль не угадана,
 * образ эту переменную не трогает.
 */
function colorRole(variable: string): PresetRole | null {
  const name = variable.toLowerCase();
  const exact: Record<string, PresetRole> = {
    "--color-bg": "bg",
    "--color-surface": "surface",
    "--color-text": "text",
    "--color-muted": "muted",
    "--color-accent": "accent",
    "--color-border": "border",
  };
  if (exact[name]) return exact[name];
  if (/muted|subtle|secondary|dim|hint|caption/.test(name)) return "muted";
  if (/surface|card|panel|elev|sheet|paper/.test(name)) return "surface";
  if (/border|line|divider|stroke|outline|rule/.test(name)) return "border";
  if (/accent|brand|primary|action|link|highlight/.test(name)) return "accent";
  if (/(^|[-_])(bg|background|page|base|canvas)([-_]|$)/.test(name)) return "bg";
  if (/(text|ink|fg|foreground|copy)/.test(name)) return "text";
  return null;
}

function sizeParts(value: string) {
  const match = SIZE.exec(value.trim());
  if (!match) return null;
  return { number: Number(match[1]), unit: match[2] ?? "px" };
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

/** Ползунок размера: единица сохраняется, меняется только число. */
function LengthRow({ field, value, onChange }: { field: ThemeField; value: string; onChange: (next: string) => void }) {
  const parts = sizeParts(value) ?? { number: 0, unit: "px" };
  const unit = parts.unit;
  const numeric = parts.number;
  // Потолок подстраивается под текущее значение: у `--gap: 24px` не нужен ползунок до 1600.
  const max = unit === "%" ? Math.max(100, Math.ceil(Math.abs(numeric))) : unit === "px"
    ? Math.max(40, Math.min(1600, Math.ceil(Math.abs(numeric) * 2 / 10) * 10))
    : Math.max(2, Math.ceil(Math.abs(numeric) * 2 * 10) / 10);
  const min = numeric < 0 ? -max : 0;
  function update(next: number) {
    if (!Number.isFinite(next)) return;
    onChange(String(next) + unit);
  }
  return <div className={"theme-size-row" + (field.used === false ? " unused" : "")}>
    <div className="theme-size-head">
      <span>{field.label}{field.used === false && <em className="theme-unused-mark">не используется</em>}</span>
      <span className="theme-size-value">
        <input type="number" value={numeric} min={-4000} max={4000} step={unit === "px" ? 1 : 0.05} onChange={event => update(Number(event.target.value))} aria-label={field.label + ": значение"}/>
        <em>{unit}</em>
      </span>
    </div>
    <input className="theme-range theme-size-range" type="range" min={min} max={max} step={unit === "px" ? 1 : 0.05} value={Math.min(max, Math.max(min, numeric))} onChange={event => update(Number(event.target.value))} aria-label={field.label}/>
  </div>;
}

function WeightRow({ field, value, onChange }: { field: ThemeField; value: string; onChange: (next: string) => void }) {
  const options = ["100", "200", "300", "400", "500", "600", "700", "800", "900"];
  const own = options.includes(value) ? [] : [value];
  return <label className={"theme-size-row" + (field.used === false ? " unused" : "")}>
    <span className="theme-size-head">{field.label}{field.used === false && <em className="theme-unused-mark">не используется</em>}</span>
    <select className="theme-size-select" value={value} onChange={event => onChange(event.target.value)}>
      {[...options, ...own].map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  </label>;
}

function NumberRow({ field, value, onChange }: { field: ThemeField; value: string; onChange: (next: string) => void }) {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 1;
  return <div className={"theme-size-row" + (field.used === false ? " unused" : "")}>
    <div className="theme-size-head">
      <span>{field.label}{field.used === false && <em className="theme-unused-mark">не используется</em>}</span>
      <span className="theme-size-value">
        <input type="number" value={value} min={-100} max={100} step={0.05} onChange={event => onChange(event.target.value)} aria-label={field.label + ": значение"}/>
      </span>
    </div>
    <input className="theme-range theme-size-range" type="range" min={0} max={8} step={0.05} value={Math.min(8, Math.max(0, safe))} onChange={event => onChange(event.target.value)} aria-label={field.label}/>
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
  const [tab, setTab] = useState<Tab>("theme");
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

  /**
   * Готовый образ правит только черновик: человек видит новые цвета в полях и сам решает,
   * сохранять их. Так один клик не пересобирает предпросмотр и не тратит запрос впустую.
   */
  function applyPreset(preset: PalettePreset) {
    if (!theme) return;
    const next = { ...draft };
    let matched = 0;
    for (const field of theme.fields) {
      if (field.kind !== "color") continue;
      const role = colorRole(field.variable);
      if (!role) continue;
      next[field.variable] = preset.colors[role];
      matched++;
    }
    if (!matched) {
      setError("Не удалось определить роли цветов в этом проекте — поправьте их вручную во вкладке «Тема».");
      return;
    }
    setError("");
    setDraft(next);
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
  const lengths = theme?.fields.filter(field => field.kind === "length") ?? [];
  const weights = theme?.fields.filter(field => field.kind === "weight") ?? [];
  const numbers = theme?.fields.filter(field => field.kind === "number") ?? [];
  // Файлы палитры: их может быть несколько, если проект объявил свои переменные в styles.css.
  const files = Array.from(new Set(theme?.fields.map(field => field.file).filter(Boolean) as string[]));

  return <section className="theme-sheet" aria-label="Конструктор стиля">
    <div className="theme-head">
      <div className="theme-title">
        <span className="eyebrow">СТИЛЬ</span>
        <div className="theme-title-line">
          <strong>Конструктор</strong>
          <Hint label="Что здесь">Цвета, шрифты, размеры и отступы проекта.</Hint>
        </div>
      </div>
      <button className="icon-button" onClick={onClose} title="Закрыть" aria-label="Закрыть стиль"><X size={15}/></button>
    </div>

    <div className="theme-tabs" role="tablist" aria-label="Разделы конструктора">
      <button role="tab" aria-selected={tab === "theme"} className={"theme-tab" + (tab === "theme" ? " active" : "")} onClick={() => setTab("theme")}>
        <Palette size={12}/> Тема
      </button>
      <button role="tab" aria-selected={tab === "constructor"} className={"theme-tab" + (tab === "constructor" ? " active" : "")} onClick={() => setTab("constructor")}>
        <SlidersHorizontal size={12}/> Конструктор
      </button>
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
        <p>Цвета заданы в коде или картинках. Агент переведёт их на переменные темы.</p>
        <div className="theme-empty-actions">
          <button className="ghost-button theme-empty-retry" onClick={() => void create(theme)}>Попробовать снова</button>
          <button className="theme-action theme-empty-action" onClick={askAgent}>
            <Sparkles size={14}/> Перевести цвета на тему
          </button>
        </div>
      </div>}

      {theme?.present && tab === "theme" && <>
        {unused && <div className="theme-warning" role="status">
          <TriangleAlert size={14}/>
          <div>
            <strong>Страница не читает переменные палитры</strong>
            <span>Переменные есть, но стили их не используют. Агент заменит вписанные цвета на <code>var(--…)</code>.</span>
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

      {theme?.present && tab === "constructor" && <>
        {colors.length > 0 && <div className="theme-group">
          <div className="theme-group-head">
            <span>Готовые образы</span>
            <small>применяются к найденным цветам</small>
          </div>
          <div className="theme-presets">
            {PRESETS.map(preset => <button
              key={preset.id}
              type="button"
              className="theme-preset"
              onClick={() => applyPreset(preset)}
              title={"Применить образ «" + preset.label + "»"}
            >
              <span className="theme-preset-swatch" style={{ background: "linear-gradient(135deg, " + preset.colors.bg + " 0 34%, " + preset.colors.accent + " 34% 67%, " + preset.colors.text + " 67%)" }}/>
              <span>{preset.label}</span>
            </button>)}
          </div>
          <p className="theme-hint">Образ меняет только черновик — проверьте цвета и нажмите «Сохранить».</p>
        </div>}

        {(lengths.length > 0 || weights.length > 0 || numbers.length > 0) && <div className="theme-group">
          <div className="theme-group-head"><span>Размеры и отступы</span><small>переменные проекта</small></div>
          {lengths.map(field => <LengthRow key={field.variable} field={field} value={draft[field.variable] ?? field.value} onChange={next => set(field.variable, next)}/>)}
          {weights.map(field => <WeightRow key={field.variable} field={field} value={draft[field.variable] ?? field.value} onChange={next => set(field.variable, next)}/>)}
          {numbers.map(field => <NumberRow key={field.variable} field={field} value={draft[field.variable] ?? field.value} onChange={next => set(field.variable, next)}/>)}
        </div>}

        {lengths.length === 0 && weights.length === 0 && numbers.length === 0 && <div className="theme-empty">
          <div className="theme-empty-icon"><SlidersHorizontal size={20}/></div>
          <strong>Размеры заданы не переменными</strong>
          <p>В проекте нет переменных отступов и размеров, которые можно подвинуть ползунком. Цвета и шрифты доступны во вкладке «Тема», а точечную правку блока можно отправить агенту через выбор элемента.</p>
          <button className="theme-action theme-empty-action" onClick={() => { setTab("theme") }}>
            <Palette size={14}/> Открыть тему
          </button>
        </div>}

        {unused && <p className="theme-hint">Страница не читает переменные — сначала переведите стили на тему, иначе правки не появятся в предпросмотре.</p>}
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
