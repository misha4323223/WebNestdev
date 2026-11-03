import { useState } from "react";
import { ArrowUpRight, HandCoins } from "lucide-react";

import { DonateDialog } from "../support/DonateDialog";

/**
 * Баннер внизу сайдбара — компактный вход в поддержку проекта.
 *
 * Вся карточка — одна кнопка с иконкой и названием: она не занимает пол-колонки и не спорит
 * с тарифом и аккаунтом за место. Пояснение убрано — в узкой колонке оно обрезалось, а
 * название помещается целиком.
 */
export function SidebarBanner() {
  const [open, setOpen] = useState(false);
  return <>
  <button type="button" className="sidebar-banner" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Поддержать проект">
    <span className="sidebar-banner-icon" aria-hidden="true"><HandCoins size={15}/></span>
    <span className="sidebar-banner-copy">
      <strong>Поддержать проект</strong>
    </span>
    <ArrowUpRight size={13} className="sidebar-banner-arrow" aria-hidden="true"/>
  </button>
  <DonateDialog open={open} onClose={() => setOpen(false)}/>
  </>;
}
