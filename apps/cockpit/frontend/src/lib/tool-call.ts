import { useCockpit, type SlotName } from "./store";

export type ToolCallResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
  _meta?: { ui?: { resourceUri?: string; slot?: string } };
};

const SLOT_NAMES: readonly SlotName[] = ["viewport", "side", "bottom", "captain"];
const isSlot = (s: string): s is SlotName => (SLOT_NAMES as readonly string[]).includes(s);

export async function callTool(name: string, args: unknown): Promise<ToolCallResult> {
  const r = await fetch(`/tool/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });
  if (!r.ok) throw new Error(`/tool/${name} -> ${r.status}`);
  const result = (await r.json()) as ToolCallResult;
  const ui = result._meta?.ui;
  if (ui?.slot && ui?.resourceUri && isSlot(ui.slot)) {
    useCockpit.getState().mountSlot(ui.slot, ui.resourceUri);
  }
  return result;
}

export function parseToolText<T = unknown>(result: ToolCallResult): T | null {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
