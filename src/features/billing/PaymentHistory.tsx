import { Receipt } from "lucide-react";
import {
  dateLabel,
  paymentStatusLabel,
  rubLabel,
  type BillingPayment,
} from "../../lib/billing-api";

/**
 * История платежей свёрнута по умолчанию: в кабинете она нужна для проверки, а не для
 * ежедневного чтения. В заголовке остаётся количество и последний платёж, чтобы состояние
 * было видно без раскрытия.
 */
export function PaymentHistory({ payments }: { payments: BillingPayment[] }) {
  const latest = payments[0];
  return <details className="billing-payments-details">
    <summary>
      <span className="billing-payments-summary">
        <Receipt size={13}/>
        <strong>Платежи</strong>
        <small>{latest
          ? "последний " + rubLabel(latest.amount) + " · " + paymentStatusLabel(latest.status)
          : "пока пусто"}</small>
      </span>
      <span className="billing-payments-count">{payments.length || ""}</span>
    </summary>
    {payments.length > 0
      ? <div className="billing-payments">
          {payments.map(payment => <div className="billing-payment" key={payment.invId}>
            <div>
              <strong>{payment.planName} · {rubLabel(payment.amount)}</strong>
              <small>Счёт №{payment.invId} · {dateLabel(payment.createdAt)}{payment.kind === "renewal" ? " · продление" : ""}</small>
            </div>
            <span className={"billing-payment-status " + payment.status}>{paymentStatusLabel(payment.status)}</span>
          </div>)}
        </div>
      : <div className="billing-empty"><Receipt size={14}/><div><strong>Платежей пока нет</strong><span>Здесь появятся счета, суммы и даты оплаты.</span></div></div>}
  </details>;
}
