import type { AgentEvent,AgentRunRequest,ReasoningEffort,ScoutRunner } from "../types.js";
export type EventSink=(event:AgentEvent)=>void;
export type AgentContext={
  runId:string;
  request:AgentRunRequest;
  emit:EventSink;
  signal?:AbortSignal;
  /** Номер шага текущего запуска: по нему строится узел reasoning. */
  step?:number;
  /**
   * Инструменты, которые модель видит в этом запуске. Набор фиксируется на старте, чтобы
   * схемы не менялись между шагами и не ломали кэш префикса DeepSeek.
   */
  toolNames?:readonly string[];
  /** Глубина, выбранная для этого шага; `auto` уже разрешён в конкретное значение. */
  reasoning?:ReasoningEffort;
  /** Read-only субагент для независимого исследования репозитория. */
  scout?:ScoutRunner;
};
