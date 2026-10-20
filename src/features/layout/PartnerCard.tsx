import { useEffect, useState } from "react";
import { ArrowUpRight, Megaphone } from "lucide-react";
import { PARTNER_SLOTS, PARTNER_SLOT_MS, partnerSlotAt, rememberPartnerSlot } from "./sponsors";

/**
 * Партнёрский слот внизу сайдбара.
 *
 * Показывает один слот за раз и меняет его раз в 10 минут. Точки под карточкой переключают вручную:
 * так человек за один экран видит, что слотов несколько, а будущий рекламодатель — как устроен
 * показ. Тонкая полоса внизу карточки отсчитывает время до следующего слота.
 *
 * Ротация — это содержимое, а не анимация интерфейса, поэтому она не зависит от
 * `prefers-reduced-motion`; отключается только полоса-таймер.
 */
export function PartnerCard() {
  const [clock, setClock] = useState(partnerSlotAt);
  const slot = PARTNER_SLOTS[clock.index] ?? PARTNER_SLOTS[0];

  // Следующий слот приходит по таймеру, а не по интервалу: после ручного переключения отсчёт
  // начинается заново, и карточка не прыгает через секунду после клика.
  useEffect(() => {
    if (PARTNER_SLOTS.length < 2) return;
    const remaining = Math.max(1_500, PARTNER_SLOT_MS - clock.elapsedMs);
    const timer = window.setTimeout(() => {
      const next = (clock.index + 1) % PARTNER_SLOTS.length;
      rememberPartnerSlot(next);
      setClock({ index: next, elapsedMs: 0 });
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [clock]);

  function show(index: number) {
    if (index === clock.index) return;
    rememberPartnerSlot(index);
    setClock({ index, elapsedMs: 0 });
  }

  const position = String(clock.index + 1).padStart(2, "0");
  const total = String(PARTNER_SLOTS.length).padStart(2, "0");

  return <section className="partner" data-accent={slot.accent} aria-label="Партнёрский слот">
    <div className="partner-head">
      <span className="partner-eyebrow"><Megaphone size={10}/> {slot.kind === "partner" ? "РЕКЛАМА" : "ПАРТНЁРСКИЙ СЛОТ"}</span>
      <span className="partner-count" title="Слоты меняются каждые 10 минут">{position}/{total}</span>
    </div>

    <a className="partner-card" href={slot.href} target="_blank" rel="noopener noreferrer" title={slot.brand + " — " + slot.cta}>
      <span className="partner-logo" aria-hidden="true">{slot.logo}</span>
      <span className="partner-text">
        <strong>{slot.brand}</strong>
        <span>{slot.tagline}</span>
      </span>
      <ArrowUpRight size={13} className="partner-arrow"/>
      <span
        key={clock.index}
        className="partner-timer"
        aria-hidden="true"
        style={{
          animationDuration: Math.max(1_500, PARTNER_SLOT_MS - clock.elapsedMs) + "ms",
          ...(clock.elapsedMs ? { animationDelay: "-" + clock.elapsedMs + "ms" } : {}),
        }}
      />
    </a>

    <div className="partner-foot">
      <span className="partner-cta">{slot.cta}</span>
      <span className="partner-dots" role="group" aria-label="Слоты партнёров">
        {PARTNER_SLOTS.map((item, index) => <button
          key={item.id}
          type="button"
          className={index === clock.index ? "active" : ""}
          aria-label={"Слот " + (index + 1) + ": " + item.brand}
          aria-current={index === clock.index}
          title={item.brand}
          onClick={() => show(index)}
        />)}
      </span>
    </div>
  </section>;
}
