import { Check, Loader2, Palette, Pipette, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getProjectTheme, saveProjectTheme, type ProjectTheme, type ThemeField } from "../../lib/project-api";
import { composeAgentPrompt, THEME_SETUP_PROMPT } from "../../lib/agent-compose";

/**
 * Тема проекта: палитра, шрифтовая пара и скругление.
 *
 * Панель правит ровно те переменные, которые читает агент (см. server/src/design/theme.ts),
 * поэтому цвет, выбранный здесь мышкой, попадает и в предпросмотр, и в собранный сайт — без
 * запроса к модели и без расхода лимита. Если файла темы в проекте нет, честно предлагается
 * одна кнопка: собрать тему агентом (это правка файлов, а не запись одного токена).
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
  const savedTimer = useRef<number | null>(null);

  const eyedropper = useMemo<EyeDropperConstructor | undefined>(() => {
    const api = (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
    return typeof api === "function" ? api : undefined;
  }, []);

  async function load() {
    setError("");
    try {
      const next = await getProjectTheme(projectId);
      setTheme(next);
      setDraft(next.fields.reduce<Record<string, string>>((values, field) => {
        values[field.variable] = next.tokens[field.variable] ?? field.value;
        return values;
      }, {}));
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
      setTheme(next);
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

  return <section className="theme-sheet" aria-label="Тема проекта">
    <div className="theme-head">
      <div className="theme-title">
        <span className="eyebrow">ТЕМА</span>
        <strong>Палитра и шрифты</strong>
      </div>
      <button className="icon-button" onClick={onClose} title="Закрыть" aria-label="Закрыть тему"><X size={15}/></button>
    </div>

    <div className="theme-body">
      {!theme && !error && <div className="theme-loading"><Loader2 size={16} className="spin"/> Загружаем тему проекта…</div>}
      {error && <div className="theme-error">{error}</div>}

      {theme && !theme.present && <div className="theme-empty">
        <div className="theme-empty-icon"><Palette size={20}/></div>
        <strong>В проекте ещё нет темы</strong>
        <p>
          Палитра живёт в файле <code>theme.css</code>: его переменные используют компоненты.
          Собрать файл и перевести на него текущие цвета может агент — после этого палитра
          ниже будет менять страницу мгновенно, без запросов к модели.
        </p>
        <button className="theme-action theme-empty-action" onClick={askAgent}>
          <Sparkles size={14}/> Собрать тему агентом
        </button>
        <button className="ghost-button theme-empty-retry" onClick={() => void load()}>Проверить снова</button>
      </div>}

      {theme?.present && <>
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
