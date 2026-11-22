import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { UiPreviewBlock } from "../../../lib/ui-blocks";
import { projectAssetUrl, projectPreviewPageUrl, projectScreenshotUrl } from "../../../lib/project-api";

/** Снимки проверки лежат в служебной папке и не проходят через маршрут публичных ассетов. */
function imageUrl(projectId: string, path: string) {
  return path.startsWith(".webnestdev/screenshots/") ? projectScreenshotUrl(projectId, path) : projectAssetUrl(projectId, path);
}

export function UiPreview({ block, projectId }: { block: UiPreviewBlock; projectId: string }) {
  const [active, setActive] = useState(0);
  const image = block.images[active] ?? block.images[0];
  if (!image) return null;
  const url = imageUrl(projectId, image.path);
  return <section className="ui-block ui-preview" aria-label={block.title ?? "Снимки интерфейса"}>
    <header className="ui-block-head">
      <strong>{block.title ?? "Снимки интерфейса"}</strong>
      {block.description && <p>{block.description}</p>}
    </header>
    {block.images.length > 1 && <div className="ui-preview-tabs" role="tablist" aria-label="Варианты экрана">
      {block.images.map((item, index) => <button
        type="button"
        role="tab"
        aria-selected={index === active}
        className={index === active ? "is-active" : ""}
        key={item.path + index}
        onClick={() => setActive(index)}
      >
        {item.label}
      </button>)}
    </div>}
    <a className="ui-preview-frame" href={url} target="_blank" rel="noreferrer" title="Открыть снимок в новой вкладке">
      <img src={url} alt={image.alt ?? image.label} loading="lazy"/>
    </a>
    <footer className="ui-preview-foot">
      <span>{image.label}</span>
      <a className="ui-preview-page" href={projectPreviewPageUrl(projectId)} target="_blank" rel="noreferrer" title="Открыть исправленную страницу в предпросмотре">
        Открыть страницу <ExternalLink size={10}/>
      </a>
    </footer>
  </section>;
}
