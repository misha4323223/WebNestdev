/**
 * Официальные логотипы сервисов, к которым подключается проект. Файлы лежат в
 * `public/brand/logos` и отдаются как есть — в отличие от буквенных монограмм, логотип
 * узнаётся до чтения названия, а бренд не перекрашивается в цвет темы.
 *
 * Плитка у всех одна: квадратный знак и длинный словесный логотип занимают одинаковое
 * место, поэтому карточки не «пляшут» по ширине. Словесный логотип вписывается в ту же
 * плитку целиком — он уменьшается, а не обрезается и не растягивает строку. Фон у всех
 * светлый, потому что большинство логотипов тёмные, а на тёмной панели они исчезают.
 */

export type BrandId =
  | "github"
  | "gitlab"
  | "gitverse"
  | "sourcecraft"
  | "yandex"
  | "yandex-cloud"
  | "vk"
  | "selectel"
  | "timeweb"
  | "cloudru"
  | "beget"
  | "regru"
  | "mts"
  | "notisend"
  | "sendsay"
  | "rusender"
  | "unisender"
  | "yookassa"
  | "cloudpayments"
  | "robokassa"
  | "tbank"
  | "gigachat"
  | "2gis"
  | "retailcrm"
  | "bitrix24"
  | "amocrm"
  | "expo";

type BrandSpec = {
  /** Путь внутри `public`: Vite копирует его в сборку без хэша в имени. */
  src: string;
  /** Квадратный знак или словесный логотип — от этого зависит, как знак вписан в плитку. */
  shape?: "mark" | "wordmark";
  /** Светлый логотип (белая надпись) виден только на тёмной плитке. */
  tone?: "dark";
};

const BRAND_LOGOS: Record<BrandId, BrandSpec> = {
  github: { src: "/brand/logos/github.svg" },
  gitlab: { src: "/brand/logos/gitlab.svg" },
  gitverse: { src: "/brand/logos/gitverse.png" },
  sourcecraft: { src: "/brand/logos/sourcecraft.svg" },
  yandex: { src: "/brand/logos/yandex-wordmark.svg", shape: "wordmark" },
  "yandex-cloud": { src: "/brand/logos/yandex-cloud.svg" },
  vk: { src: "/brand/logos/vk.svg" },
  selectel: { src: "/brand/logos/selectel.svg" },
  timeweb: { src: "/brand/logos/timeweb.svg" },
  cloudru: { src: "/brand/logos/cloudru.png" },
  beget: { src: "/brand/logos/beget.svg", shape: "wordmark" },
  regru: { src: "/brand/logos/regru.svg", shape: "wordmark" },
  mts: { src: "/brand/logos/mts.svg" },
  notisend: { src: "/brand/logos/notisend.svg", shape: "wordmark", tone: "dark" },
  sendsay: { src: "/brand/logos/sendsay.svg", shape: "wordmark" },
  rusender: { src: "/brand/logos/rusender.svg" },
  unisender: { src: "/brand/logos/unisender.png", shape: "wordmark" },
  yookassa: { src: "/brand/logos/yookassa.svg", shape: "wordmark" },
  cloudpayments: { src: "/brand/logos/cloudpayments.png" },
  robokassa: { src: "/brand/logos/robokassa.svg", shape: "wordmark" },
  tbank: { src: "/brand/logos/tbank.svg" },
  gigachat: { src: "/brand/logos/gigachat.png", tone: "dark" },
  "2gis": { src: "/brand/logos/2gis.svg", shape: "wordmark" },
  retailcrm: { src: "/brand/logos/retailcrm.svg", shape: "wordmark" },
  bitrix24: { src: "/brand/logos/bitrix24.svg", shape: "wordmark" },
  amocrm: { src: "/brand/logos/amocrm.png" },
  expo: { src: "/brand/logos/expo.svg" },
};

/**
 * Плитка с логотипом для заголовка карточки интеграции. Размер задаёт стиль, а не вызывающий
 * код: это единственный способ, чтобы «GitHub» и «Robokassa» занимали одинаковое место.
 */
export function BrandLogo({ brand, className }: { brand: BrandId; className?: string }) {
  const spec = BRAND_LOGOS[brand];
  const shape = spec.shape ?? "mark";
  return <span
    className={"brand-logo is-" + shape + (spec.tone === "dark" ? " on-dark" : "") + (className ? " " + className : "")}
    aria-hidden="true"
  >
    <img src={spec.src} alt="" loading="lazy" decoding="async" draggable={false} />
  </span>;
}

/**
 * Логотип без плитки — для мест, где плитка уже есть (карточки OAuth-сервисов, чипы
 * провайдеров баз данных). `variant="light"` берёт белую версию знака для тёмного фона.
 */
export function BrandMark({ brand, size = 18, variant = "color", className }: {
  brand: BrandId;
  size?: number;
  variant?: "color" | "light";
  className?: string;
}) {
  const spec = BRAND_LOGOS[brand];
  const src = variant === "light" && brand === "github" ? "/brand/logos/github-white.svg" : spec.src;
  return <img
    className={"brand-mark" + (className ? " " + className : "")}
    src={src}
    alt=""
    width={size}
    height={size}
    loading="lazy"
    decoding="async"
    draggable={false}
    aria-hidden="true"
  />;
}
