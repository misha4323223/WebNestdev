import { useEffect, useRef } from "react";
import type { BillingData } from "../../lib/billing-api";
import { CreditTopUp } from "./CreditTopUp";

/**
 * Докупка кредитов — отдельное окно, а не постоянная форма с чекбоксами внутри кабинета.
 * В обзоре остаётся компактная карточка «Докуплено», а согласия и ввод количества
 * открываются только тогда, когда человек действительно решил купить кредиты.
 */
export function CreditTopUpDialog({ open, onClose, billing, paid }: {
  open: boolean;
  onClose: () => void;
  billing: BillingData | null;
  paid: boolean;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open || !billing) return null;

  return <div className="modal-backdrop" role="presentation" onMouseDown={() => closeRef.current()}>
    <section className="modal credit-topup-modal" role="dialog" aria-modal="true" aria-label="Докупить кредиты" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-body">
        <CreditTopUp billing={billing} paid={paid} compact onClose={() => closeRef.current()}/>
      </div>
    </section>
  </div>;
}
