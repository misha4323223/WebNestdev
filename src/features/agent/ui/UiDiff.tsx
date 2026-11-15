import type { UiDiffBlock } from "../../../lib/ui-blocks";
import { diffLines } from "../agent-diff";

export function UiDiff({ block }: { block: UiDiffBlock }) {
  const preview = diffLines(block.before, block.after);
  return <section className="ui-block ui-diff" aria-label={block.title ?? "Изменения кода"}>
    <header className="ui-block-head ui-diff-head">
      <strong>{block.title ?? "Изменения кода"}</strong>
      {block.path && <code>{block.path}</code>}
      <span className="ui-diff-count">+{preview.added} −{preview.removed}</span>
    </header>
    {preview.lines.length
      ? <div className="action-code ui-diff-code" role="region" aria-label={block.title ?? "Diff"}>
        {preview.lines.map((line, index) => <div key={line.line + ":" + index} className={"code-line code-" + line.kind}>
          <span className="code-no">{line.line}</span>
          <span className="code-sign">{line.sign}</span>
          <code>{line.text || " "}</code>
        </div>)}
        {preview.truncated && <div className="action-code-more">Показаны первые {preview.lines.length} из {preview.total} строк</div>}
      </div>
      : <p className="ui-block-empty">Содержимое не изменилось.</p>}
  </section>;
}
