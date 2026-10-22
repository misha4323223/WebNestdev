import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, Heart, RefreshCw, Send, X } from "lucide-react";
import { sendDonation, type DonationResult } from "../../lib/donation-api";

/** Суммы, с которых начинают чаще всего: человек выбирает сумму одним нажатием, а не считает в голове. */
const presets = [199, 499, 999, 2999];

function rub(value: number) {
  return value.toLocaleString("ru-RU") + " ₽";
}

/**
 * Окно поддержки проекта.
 *
 * Здесь нет витрины тарифов: это добровольная помощь, поэтому сумма выбирается свободно, а
 * сообщение необязательно. Платёж создаётся на сервере (Робокасса), а текст сохраняется рядом с
 * ним — позже его будет отправлять на почту команды подключённый сервис.
 */
export function DonateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState(499);
  const [custom, setCustom] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DonationResult | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setError("");
    setResult(null);
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

  const ready = Number.isFinite(amount) && amount >= 100 && amount <= 100_000;

  async function submit() {
    if (!ready || sending) return;
    setSending(true);
    setError("");
    try {
      const donation = await sendDonation({ amount, message: message.trim() });
      setResult(donation);
      // Настроенный приём денег уводит на защищённую страницу оплаты. Без него сумма и сообщение
      // всё равно сохраняются, поэтому окно честно говорит, что платёж ещё не подключён.
      if (donation.paymentUrl) window.location.assign(donation.paymentUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отправить поддержку");
    } finally {
      setSending(false);
    }
  }

  const close = () => { if (!sending) closeRef.current(); };

  return createPortal(<div className="modal-backdrop donate-backdrop" role="presentation" onMouseDown={close}>
    <section className="modal donate-modal" role="dialog" aria-modal="true" aria-labelledby="donate-title" onMouseDown={event => event.stopPropagation()}>
      <header className="modal-head">
        <div>
          <span className="eyebrow">ПОДДЕРЖКА ПРОЕКТА</span>
          <h2 id="donate-title">{result ? "Спасибо, что вы рядом" : "Ваша помощь проекту"}</h2>
        </div>
        <button type="button" className="icon-button" onClick={close} aria-label="Закрыть"><X size={16}/></button>
      </header>

      {result
        ? <div className="modal-body donate-success">
            <span className="donate-success-icon"><Check size={22}/></span>
            <strong>Спасибо — это правда много значит</strong>
            <p>
              {result.status === "recorded"
                ? "Мы сохранили сумму и сообщение. Приём донатов ещё подключается — как только оплата заработает, здесь появится кнопка оплаты."
                : "Платёж создан. После подтверждения сумма и сообщение появятся у команды — и в списке поддержавших."}
            </p>
            {message.trim() && <p className="donate-success-note">Ваше сообщение: «{message.trim()}»</p>}
            <button type="button" className="send-button" onClick={close}><Check size={13}/> Готово</button>
          </div>
        : <div className="modal-body donate-body">
            <div className="donate-hero">
              <span className="donate-hero-icon"><Heart size={18}/></span>
              <p>NestDev делает небольшая команда — без рекламы и без продажи данных. Поддержка идёт на серверы, модели и новые возможности, чтобы проект оставался доступным тем, кто только учится.</p>
            </div>

            <div className="donate-fields">
              <div className="donate-label"><span>Сумма</span><small>Добровольно, в рублях</small></div>
              <div className="donate-amounts" role="group" aria-label="Сумма поддержки">
                {presets.map(preset => <button
                  key={preset}
                  type="button"
                  className={"donate-amount" + (custom === "" && amount === preset ? " active" : "")}
                  aria-pressed={custom === "" && amount === preset}
                  onClick={() => { setCustom(""); setAmount(preset); setError(""); }}
                >{rub(preset)}</button>)}
              </div>
              <label className="donate-custom">
                <span>Своя сумма</span>
                <div className="donate-custom-field">
                  <input
                    value={custom}
                    inputMode="numeric"
                    placeholder="Например, 750"
                    onChange={event => {
                      const value = event.target.value.replace(/[^\d]/g, "").slice(0, 6);
                      setCustom(value);
                      // Неверная своя сумма обнуляет платёж, а не оставляет прошлый пресет:
                      // иначе «50» в поле отправляло бы 499 ₽ из соседней кнопки.
                      const parsed = Number(value);
                      setAmount(value === "" ? 499 : parsed >= 100 && parsed <= 100_000 ? parsed : 0);
                      setError("");
                    }}
                  />
                  <span>₽</span>
                </div>
              </label>
              {custom !== "" && !ready && <small className="donate-custom-hint">Минимум 100 ₽, максимум 100 000 ₽</small>}
            </div>

            <label className="donate-message">
              <span>Сообщение команде <i>необязательно</i></span>
              <textarea
                value={message}
                maxLength={1200}
                rows={4}
                placeholder="Пожелание, идея или просто слова поддержки"
                onChange={event => { setMessage(event.target.value); setError(""); }}
              />
              <small><span>Увидит только команда — почту для доставки подключим позже.</span><b>{message.length} / 1200</b></small>
            </label>

            {error && <div className="settings-error donate-error" role="alert">{error}</div>}

            <button type="button" className="donate-submit" onClick={() => void submit()} disabled={!ready || sending}>
              {sending ? <><RefreshCw size={14} className="spin"/> Отправляем…</> : <><Heart size={14}/> Поддержать на {ready ? rub(amount) : "—"} <ArrowUpRight size={13}/></>}
            </button>
            <p className="donate-fineprint">Оплата картой или через СБП. Это добровольный взнос, а не подписка: он ничего не включает и не продлевает.</p>
          </div>}

      <footer className="modal-foot donate-foot">
        <span><Send size={12}/> Спасибо, что помогаете проекту расти.</span>
        <button type="button" className="ghost-button" onClick={close}>Закрыть</button>
      </footer>
    </section>
  </div>, document.body);
}
