import { useEffect, useState } from "react";

/**
 * Согласия перед оплатой — три отдельные, не проставленные заранее отметки.
 *
 * первая — на обработку персональных данных: по ч. 1 ст. 9 152-ФЗ (в редакции с 01.09.2025)
 * согласие не объединяется с другими документами, поэтому у него свой документ и своя отметка;
 * вторая — акцепт оферты и условий оплаты и возврата: без них договор не заключён;
 * третья — отдельное согласие на автопродление. По 376-ФЗ (в силе с 01.03.2026) онлайн-подписка
 * продлевается только по сознательному согласию человека, поэтому отметка необязательная и
 * снятая по умолчанию: без неё платёж разовый, а с ней в счёт попадает `Recurring=true` и у новой
 * подписки включается продление. Отключить продление можно в любой момент в личном кабинете —
 * это и есть «простой отказ», которого требует закон.
 *
 * Ссылки внутри label гасят всплытие: иначе нажатие «оферта» переключало бы галочку и человек
 * принимал условия, которых не читал.
 */
export type CheckoutConsentState = {
  /** Обе обязательные отметки стоят — кнопка оплаты активна. */
  ready: boolean;
  /** Отдельная отметка «продлевать автоматически»: её отсутствие оплату не блокирует. */
  autoRenew: boolean;
};

export function CheckoutConsent({ recurring, onChange }: { recurring: boolean; onChange: (state: CheckoutConsentState) => void }) {
  const [personalData, setPersonalData] = useState(false);
  const [terms, setTerms] = useState(false);
  const [autoRenew, setAutoRenew] = useState(false);

  useEffect(() => {
    onChange({ ready: personalData && terms, autoRenew: recurring && autoRenew });
  }, [personalData, terms, autoRenew, recurring, onChange]);

  const link = (href: string, text: string) => <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    onClick={event => event.stopPropagation()}
  >{text}</a>;

  return <div className="checkout-consent">
    <span className="eyebrow">ПЕРЕД ОПЛАТОЙ</span>
    <label className="checkout-consent-row">
      <input type="checkbox" checked={personalData} onChange={event => setPersonalData(event.target.checked)}/>
      <span>
        Даю {link("/legal/consent", "согласие на обработку персональных данных")} для оформления и оплаты подписки
        и подтверждаю, что ознакомлен с {link("/legal/privacy", "Политикой обработки данных")}.
      </span>
    </label>
    <label className="checkout-consent-row">
      <input type="checkbox" checked={terms} onChange={event => setTerms(event.target.checked)}/>
      <span>
        Принимаю {link("/legal/offer", "публичную оферту")} и {link("/legal/payments", "условия оплаты и возврата")}.{" "}
        {recurring
          ? "Продление — только по отдельному согласию ниже."
          : "Оплата разовая — за один календарный месяц: автопродление сейчас не подключено."}
      </span>
    </label>
    {/* Отметка автопродления отдельная и необязательная: она не входит в условие готовности,
        потому что без неё оплата остаётся законной — просто разовой. */}
    {recurring && <label className="checkout-consent-row">
      <input type="checkbox" checked={autoRenew} onChange={event => setAutoRenew(event.target.checked)}/>
      <span>
        Отдельно согласен на автопродление: стоимость тарифа (сумма — на кнопке оплаты) будет
        списываться раз в месяц, в дату окончания оплаченного периода, пока продление включено.
        Отключить можно в любой момент в личном кабинете.
      </span>
    </label>}
    <small className="checkout-consent-note">Оплата проходит на стороне «Робокассы». Данные карты вводятся там и в NestDev не попадают.</small>
  </div>;
}
