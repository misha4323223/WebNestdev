/**
 * Превью шаблона — настоящий макет будущего проекта, снятый в палитре платформы:
 * глубокий графит, тёплый песочный акцент, тонкие кромки и мягкий свет.
 *
 * Файлы лежат в `public/templates/*.webp` по 2–13 КБ (640×346, сжатие WebP): карточка
 * показывает их в 196 px, поэтому на ретине картинка остаётся резкой, а вся полка весит
 * меньше одного экрана лендинга. Текст на превью намеренно нечитаемый — это макет, а не
 * обещание конкретного контента; подпись под карточкой даёт настоящее название.
 */
export type TemplatePreviewKind =
  | "landing" | "corporate" | "shop" | "marketplace" | "blog"
  | "mobile" | "pwa" | "telegram" | "saas"
  | "game3d" | "game2d" | "showcase3d"
  | "dashboard" | "crm" | "bot" | "ai";

/** Размер исходника: совпадает с файлами, поэтому браузер резервирует место до загрузки. */
const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 346;

export function TemplatePreview({ kind }: { kind: TemplatePreviewKind }) {
  return <img
    className="starter-shot-image"
    src={"/templates/" + kind + ".webp"}
    alt=""
    width={PREVIEW_WIDTH}
    height={PREVIEW_HEIGHT}
    loading="lazy"
    decoding="async"
    draggable={false}
  />;
}
