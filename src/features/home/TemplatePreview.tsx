/**
 * Превью шаблона — картинка-обложка из public/templates или, если обложки ещё нет,
 * маленькая сцена, собранная в DOM: заголовок, подпись и предмет в палитре платформы
 * (графит, латунь, тёплая кромка).
 *
 * Обложки лежат в двух разрешениях: 720 px по ширине в public/templates в WebP q85 (на
 * карточку 196 px этого хватает с запасом на ретину), полные исходники — в docs/template-cards.
 */
export type TemplatePreviewKind =
  | "landing" | "corporate" | "shop" | "marketplace" | "blog"
  | "mobile" | "pwa" | "telegram" | "saas"
  | "game3d" | "game2d" | "showcase3d"
  | "dashboard" | "crm" | "bot" | "ai";

/** Короткая подпись внутри превью: что человек увидит в этом шаблоне. */
const scenes: Record<TemplatePreviewKind, { title: string; note: string }> = {
  landing: { title: "Сайт за вечер", note: "Оффер и заявка" },
  corporate: { title: "Сайт компании", note: "Услуги и кейсы" },
  shop: { title: "Магазин с оплатой", note: "Каталог и корзина" },
  marketplace: { title: "Продавцы и заказы", note: "Роли и кабинеты" },
  blog: { title: "Статьи и рубрики", note: "Поиск и подписка" },
  mobile: { title: "Приложение", note: "Телефон и планшет" },
  pwa: { title: "Работает офлайн", note: "Установка из браузера" },
  telegram: { title: "Мини-приложение", note: "Внутри мессенджера" },
  saas: { title: "Сервис с тарифами", note: "Аккаунты и кабинет" },
  game3d: { title: "3D-сцена", note: "Управление и счёт" },
  game2d: { title: "Аркада", note: "Уровни и рекорды" },
  showcase3d: { title: "Витрина 3D", note: "Вращение и ракурсы" },
  dashboard: { title: "Метрики вживую", note: "Графики и фильтры" },
  crm: { title: "Клиенты и сделки", note: "Таблицы и роли" },
  bot: { title: "Бот отвечает", note: "Команды и сценарии" },
  ai: { title: "Ассистент", note: "Чат и знания" },
};

/** Шаблоны с готовой обложкой-картинкой; остальные дорисовываются сценой в DOM. */
const photos: Partial<Record<TemplatePreviewKind, string>> = {
  landing: "landing",
  corporate: "corporate",
  shop: "shop",
  marketplace: "marketplace",
  blog: "blog",
  mobile: "mobile",
  pwa: "pwa",
  telegram: "telegram",
  saas: "saas",
  crm: "crm",
  dashboard: "dashboard",
  game3d: "game3d",
  game2d: "game2d",
  showcase3d: "showcase3d",
  bot: "bot",
  ai: "ai",
};

/** Предмет сцены: у каждого шаблона свой, поэтому полку видно с первого взгляда. */
function Item({ kind }: { kind: TemplatePreviewKind }) {
  switch (kind) {
    case "landing":
      return <span className="tpl-rings"><i/><i/></span>;
    case "corporate":
      return <span className="tpl-columns"><i/><i/><i/></span>;
    case "shop":
      return <><span className="tpl-vase"/><span className="tpl-pill">1 990 ₽</span></>;
    case "marketplace":
      return <span className="tpl-tiles"><i/><i/><i/><i/></span>;
    case "blog":
      return <span className="tpl-sheets"><i/><i/><i/></span>;
    case "mobile":
      return <><span className="tpl-phone is-back"><i/></span><span className="tpl-phone"><i/></span></>;
    case "pwa":
      return <><span className="tpl-phone"><i/></span><span className="tpl-pill">Офлайн</span></>;
    case "telegram":
    case "bot":
      return <>
        <span className="tpl-bubble">{kind === "bot" ? "Старт" : "Привет"}</span>
        <span className="tpl-bubble is-mine">Готово</span>
      </>;
    case "saas":
      return <><span className="tpl-plans"><i/><i/></span><span className="tpl-pill">Плюс</span></>;
    case "game3d":
      return <><span className="tpl-hills"><i/><i/><i/></span><span className="tpl-spark"/></>;
    case "game2d":
      return <><span className="tpl-pixels"><i/><i/><i/></span><span className="tpl-coin"/></>;
    case "showcase3d":
      return <><span className="tpl-vitrine"><i/></span><span className="tpl-pill">360°</span></>;
    case "dashboard":
      return <>
        <span className="tpl-bars"><i/><i/><i/><i/><i/></span>
        <span className="tpl-metric"><b>24 530</b><small>посетители</small></span>
      </>;
    case "crm":
      return <><span className="tpl-rows"><i/><i/><i/></span><span className="tpl-pill">В работе</span></>;
    case "ai":
      return <><span className="tpl-orb"/><span className="tpl-pill">Чат</span></>;
  }
}

export function TemplatePreview({ kind }: { kind: TemplatePreviewKind }) {
  const photo = photos[kind];
  if (photo) {
    return <span className={"starter-shot tpl is-photo tpl-" + kind}>
      <img className="tpl-img" src={"/templates/" + photo + ".webp"} alt="" loading="lazy" decoding="async"/>
    </span>;
  }
  const scene = scenes[kind];
  return <span className={"starter-shot tpl tpl-" + kind}>
    <span className="tpl-copy"><strong>{scene.title}</strong><small>{scene.note}</small></span>
    <span className="tpl-art"><Item kind={kind}/></span>
  </span>;
}
