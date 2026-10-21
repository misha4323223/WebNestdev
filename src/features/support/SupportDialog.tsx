import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Bug, Check, ImagePlus, Lightbulb, RefreshCw, Send, X } from "lucide-react";
import { sendSupportTicket, type SupportCategory } from "../../lib/support-api";

/**
 * Знак поддержки — спасательный круг, а не ещё одна служебная иконка: у него мятная обводка,
 * косые перекладины и точка-искра. Рисуется здесь, потому что lucide даёт симметричный круг,
 * который в узкой колонке не отличить от «помощи».
 */
export function SupportIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="5.9"/>
    <circle cx="8" cy="8" r="2.1"/>
    <path d="M3.6 3.6 5.9 5.9M12.4 3.6 10.1 5.9M3.6 12.4l2.3-2.3M12.4 12.4l-2.3-2.3"/>
    <circle cx="12.9" cy="3.1" r="0.9" fill="currentColor" stroke="none"/>
  </svg>;
}

const severityLevels = [
  { upTo: 2, label: "Мелочь", tone: "low" },
  { upTo: 4, label: "Не срочно", tone: "low" },
  { upTo: 6, label: "Заметно мешает", tone: "mid" },
  { upTo: 8, label: "Серьёзно", tone: "high" },
  { upTo: 10, label: "Очень важно", tone: "high" },
];

function severityInfo(value: number) {
  return severityLevels.find(level => value <= level.upTo) ?? severityLevels[severityLevels.length - 1];
}

function bytesLabel(value: number) {
  if (value < 1024) return value + " Б";
  if (value < 1024 * 1024) return Math.round(value / 1024) + " КБ";
  return (value / 1024 / 1024).toFixed(1) + " МБ";
}

/**
 * Скриншот уменьшается и пережимается в браузере: полноразмерный снимок 4K весит больше лимита
 * запроса, а для разбора хватает 1600 px по ширине. Белая подложка нужна JPEG-у, иначе прозрачные
 * места становятся чёрными.
 */
async function fileToScreenshot(file: File) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Приложите изображение PNG, JPEG или WebP");
  if (file.size > 12 * 1024 * 1024) throw new Error("Файл больше 12 МБ — сделайте скриншот поменьше");
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, 1600 / Math.max(1, bitmap.width));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не удалось подготовить скриншот");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  const bytes = Math.round((dataUrl.split(",")[1]?.length ?? 0) * 0.75);
  if (!bytes) throw new Error("Не удалось прочитать скриншот");
  if (bytes > 4 * 1024 * 1024) throw new Error("Скриншот больше 4 МБ даже после сжатия");
  return { dataUrl, name: file.name.replace(/\.(png|jpe?g|webp)$/i, "") || "Скриншот", bytes };
}

export function SupportDialog({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId?: string }) {
  const [category, setCategory] = useState<SupportCategory>("bug");
  const [severity, setSeverity] = useState(3);
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [context, setContext] = useState("");
  const [screenshot, setScreenshot] = useState<{ dataUrl: string; name: string; bytes: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setSent(false);
    setError("");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;

  const level = severityInfo(severity);
  const fill = ((severity - 1) / 9) * 100;

  function close() {
    if (sending) return;
    // После отправленного обращения форма начинается с чистого листа; закрытый черновик
    // сохраняется, чтобы случайное закрытие не стирало уже написанное.
    if (sent) {
      setCategory("bug");
      setSeverity(3);
      setDescription("");
      setSteps("");
      setContext("");
      setScreenshot(null);
      setError("");
    }
    closeRef.current();
  }

  async function acceptFile(file: File | null | undefined) {
    if (!file) return;
    setError("");
    try {
      setScreenshot(await fileToScreenshot(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось приложить скриншот");
    }
  }

  async function submit() {
    const text = description.trim();
    if (text.length < 10) { setError("Опишите проблему хотя бы в двух предложениях"); return; }
    if (category === "bug" && steps.trim().length < 10) { setError("Добавьте шаги: как повторить проблему"); return; }
    if (!screenshot) { setError("Прикрепите скриншот — с ним разбираться намного быстрее"); return; }
    setSending(true);
    setError("");
    try {
      const storedProject = projectId || (() => { try { return localStorage.getItem("webnestdev.projectId") ?? undefined; } catch { return undefined; } })();
      await sendSupportTicket({
        category,
        severity,
        description: text,
        steps: steps.trim() || undefined,
        context: context.trim() || undefined,
        page: window.location.href.slice(0, 480),
        projectId: storedProject,
        screenshot: screenshot.dataUrl,
      });
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отправить обращение");
    } finally {
      setSending(false);
    }
  }

  // Диалог монтируется в body: кнопка живёт в колонке (а на телефоне — в выезжающей шторке),
  // и внутри её контекста наложения окно оказывалось под плашкой cookie. Портал ставит его
  // на верхний уровень страницы независимо от того, откуда его открыли.
  return createPortal(<div className="modal-backdrop support-backdrop" role="presentation" onMouseDown={close}>
    <section className="modal support-modal" role="dialog" aria-modal="true" aria-labelledby="support-title"
      onMouseDown={event => event.stopPropagation()}
      onPaste={event => {
        const item = Array.from(event.clipboardData.items).find(entry => entry.type.startsWith("image/"));
        if (!item) return;
        event.preventDefault();
        void acceptFile(item.getAsFile());
      }}>
      <header className="modal-head">
        <div>
          <span className="eyebrow">ПОДДЕРЖКА</span>
          <h2 id="support-title">{sent ? "Обращение отправлено" : category === "bug" ? "Сообщить о проблеме" : "Предложить идею"}</h2>
        </div>
        <button type="button" className="icon-button" onClick={close} aria-label="Закрыть"><X size={16}/></button>
      </header>

      {sent
        ? <div className="modal-body support-success">
            <span className="support-success-icon"><Check size={20}/></span>
            <strong>Спасибо — мы всё получили</strong>
            <p>Скриншот, описание и шаги сохранены. Ответ придёт на почту аккаунта.</p>
            <button type="button" className="send-button" onClick={close}><Check size={13}/> Готово</button>
          </div>
        : <div className="modal-body support-body">
            <p className="modal-lead">Опишите проблему или идею — ответим на почту аккаунта. Скриншот помогает быстрее понять, что случилось.</p>

            <div className="support-cats" role="group" aria-label="Тип обращения">
              <button type="button" className={"support-cat" + (category === "bug" ? " active" : "")} aria-pressed={category === "bug"} onClick={() => setCategory("bug")}>
                <span className="support-cat-icon"><Bug size={15}/></span>
                <span><strong>Баг</strong><small>Что-то не работает</small></span>
              </button>
              <button type="button" className={"support-cat" + (category === "idea" ? " active" : "")} aria-pressed={category === "idea"} onClick={() => setCategory("idea")}>
                <span className="support-cat-icon"><Lightbulb size={15}/></span>
                <span><strong>Идея</strong><small>Чего не хватает</small></span>
              </button>
            </div>

            <div className={"support-severity " + level.tone}>
              <div className="support-severity-head"><span>ВАЖНОСТЬ</span><strong>{severity} / 10 · {level.label}</strong></div>
              <input type="range" min={1} max={10} step={1} value={severity} aria-label="Важность обращения"
                style={{ "--fill": fill + "%" } as CSSProperties}
                onChange={event => setSeverity(Number(event.target.value))}/>
              <div className="support-severity-scale"><span>Не важно</span><span>Очень важно</span></div>
            </div>

            <div className="support-fields">
              <label className="support-field">
                <span>{category === "bug" ? "Как повторить?" : "Как вы это видите?"}</span>
                <textarea value={steps} maxLength={4000} rows={3} onChange={event => setSteps(event.target.value)}
                  placeholder={category === "bug" ? "1. Открыл проект…\n2. Нажал «Отправить»…\n3. Вместо результата — ошибка" : "Что должно появиться и как это должно работать"} />
                <small>{category === "bug" ? "По шагам: что открыли, что нажали, что увидели." : "Пара примеров или ссылок помогут понять задумку."}</small>
              </label>

              <label className="support-field">
                <span>Дополнительные логи или контекст <i>необязательно</i></span>
                <textarea value={context} maxLength={4000} rows={2} onChange={event => setContext(event.target.value)}
                  placeholder="Текст ошибки, браузер и устройство, что уже пробовали" />
              </label>
            </div>

            {error && <div className="settings-error support-error" role="alert">{error}</div>}

            {/* Нижний блок устроен как поле ввода агента: описание, вложения и отправка в одной рамке. */}
            <div className={"support-compose" + (dragActive ? " dragging" : "")}
              onDragOver={event => { if (!event.dataTransfer?.types.includes("Files")) return; event.preventDefault(); setDragActive(true); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
              onDrop={event => { event.preventDefault(); setDragActive(false); void acceptFile(event.dataTransfer.files?.[0]); }}>
              {screenshot && <div className="support-shot">
                <img src={screenshot.dataUrl} alt="Прикреплённый скриншот"/>
                <div className="support-shot-copy"><strong>{screenshot.name}</strong><small>{bytesLabel(screenshot.bytes)}</small></div>
                <button type="button" className="icon-button" onClick={() => setScreenshot(null)} title="Убрать скриншот" aria-label="Убрать скриншот"><X size={12}/></button>
              </div>}
              <textarea value={description} maxLength={4000} rows={3} onChange={event => setDescription(event.target.value)}
                placeholder={category === "bug" ? "Что случилось? Опишите проблему как можно точнее…" : "Опишите идею и зачем она нужна…"}/>
              <div className="support-compose-foot">
                <button type="button" className="icon-button support-attach" onClick={() => fileRef.current?.click()} title="Прикрепить скриншот" aria-label="Прикрепить скриншот"><ImagePlus size={15}/></button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { void acceptFile(event.target.files?.[0]); event.target.value = ""; }}/>
                <span className="support-compose-hint">{screenshot ? "Скриншот прикреплён" : dragActive ? "Отпустите скриншот" : "Скриншот обязателен · можно вставить из буфера"}</span>
                <button type="button" className="send-button support-send" disabled={sending} onClick={() => void submit()} title="Отправить обращение" aria-label="Отправить обращение">
                  {sending ? <RefreshCw size={14} className="spin"/> : <Send size={14}/>}
                </button>
              </div>
            </div>
          </div>}
    </section>
  </div>, document.body);
}

/**
 * Кнопка-вход в поддержку. Живёт в колонке рабочей области и на главной, поэтому сама держит
 * диалог: обе поверхности получают одно и то же поведение без общего провайдера.
 */
export function SupportButton({ variant = "sidebar", projectId }: { variant?: "sidebar" | "rail" | "composer"; projectId?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={"support-entry support-entry-" + variant} onClick={() => setOpen(true)} aria-haspopup="dialog"
      title="Поддержка — сообщить о проблеме или предложить идею" aria-label="Поддержка">
      <span className="support-entry-icon"><SupportIcon size={variant === "composer" ? 15 : 14}/></span>
      {variant !== "composer" && <span className="support-entry-text">Поддержка</span>}
    </button>
    <SupportDialog open={open} onClose={() => setOpen(false)} projectId={projectId}/>
  </>;
}
