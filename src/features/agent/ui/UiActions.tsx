import type { UiActionsBlock } from "../../../lib/ui-blocks";
import type { UiActionHandler } from "./UiBlocks";

export function UiActions({ block, busy, onAction }: {
  block: UiActionsBlock;
  busy?: boolean;
  onAction: UiActionHandler;
}) {
  return <section className="ui-block ui-actions" aria-label={block.title}>
    <header className="ui-block-head">
      <strong>{block.title}</strong>
      {block.description && <p>{block.description}</p>}
    </header>
    <div className="ui-actions-row">
      {block.actions.map(action => <button
        type="button"
        key={action.label}
        className={"ui-block-submit ui-action-" + (action.variant ?? "primary")}
        disabled={busy}
        onClick={() => onAction(action.prompt)}
      >
        {action.label}
      </button>)}
    </div>
  </section>;
}
