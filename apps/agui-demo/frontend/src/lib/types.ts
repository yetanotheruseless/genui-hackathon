// Mirror of agent_core/render.py — keep these in sync.

export type Markdown = { kind: "markdown"; text: string };
export type Latex = { kind: "latex"; tex: string };
export type PlotSpec = {
  kind: "plot";
  title: string;
  plot_type: "line" | "scatter" | "heatmap" | "surface";
  x: number[];
  y: number[];
  z?: number[][] | null;
  x_label?: string;
  y_label?: string;
};
export type DiagramSpec = { kind: "diagram"; title: string; mermaid: string };
export type Card = {
  kind: "card";
  title: string;
  fields: Record<string, string | number>;
  body?: string;
};
export type Table = { kind: "table"; title: string; columns: string[]; rows: unknown[][] };

export type RenderBlock = Markdown | Latex | PlotSpec | DiagramSpec | Card | Table;

// AG-UI event subset we actually consume.
export type AGUIEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string }
  | { type: "RUN_FINISHED"; threadId: string; runId: string }
  | { type: "RUN_ERROR"; message: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: string }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string; parentMessageId?: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; messageId: string; toolCallId: string; content: string; role: string };
