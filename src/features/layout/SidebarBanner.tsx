import { useState } from "react";
import { ArrowUpRight, HandCoins } from "lucide-react";

import { DonateDialog } from "../support/DonateDialog";

/**
 * Баннер внизу сайдбара — компактный вход в поддержку проекта.
 *
 * Вся карточка — одна кнопка с иконкой и коротким пояснением: она не занимает пол-колонки
 * и не спорит с тарифом и аккаунтом за место. Превью и «сердечки» убраны: это действие,
 * а не декоративная открытка.
 */
export function SidebarBanner() {
  const [open, setOpen] = useState(false);
  return <>
  <button type="button" className="sidebar-banner" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Поддержать проект">
    <span className="sidebar-banner-icon" aria-hidden="true"><HandCoins size={15}/></span>
    <span className="sidebar-banner-copy">
      <strong>Поддержать проект</strong>
      <small>Помочь NestDev развиваться</small>
    </span>
    <ArrowUpRight size={13} className="sidebar-banner-arrow" aria-hidden="true"/>
  </button>
  <DonateDialog open={open} onClose={() => setOpen(false)}/>
  </>;
}
