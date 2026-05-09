import { anthropic } from "@ai-sdk/anthropic";
import { jsonSchema, streamText, tool } from "ai";

import { callTool, getMcpClient, getToolUiMeta } from "./mcp-client.js";

const MODEL = process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001";

export type CaptainEvent =
  | { type: "captain-token"; text: string }
  | { type: "captain-tool"; name: string; args: unknown; result: unknown }
  | { type: "mount"; slot: string; resourceUri: string; toolResult: unknown }
  | { type: "captain-done" }
  | { type: "captain-error"; error: string };

type Emit = (e: CaptainEvent) => void;

type ChatTurn = { role: "user" | "assistant"; content: string };

const histories = new Map<string, ChatTurn[]>();

function systemPrompt(gameId: string, playerId: string): string {
  return `You are the captain of a Culture Contact-section starship. The user gives you high-level orders; you operate the ship by calling tools.

Live session:
  gameId   = ${gameId}
  playerId = ${playerId}

The ship's Mind narrates discoveries (observe) and chats with the user (talk_to_mind) — those go into the bridge pane and the user sees them directly. Don't repeat the Mind's words; just confirm what you did.

Tool style:
  - gameId / playerId are auto-injected; you don't need to pass them.
  - Object ids are snake_case (e.g. "proxima_centauri", "alpha_centauri_a", "barnards_star", "sirius_a"), NOT the display name. ALWAYS call list_objects first to get the exact id, then pass that id to warp_to / observe. Never guess an id from the display name.
  - Keep replies short. Three sentences max unless the user asks for detail.`;
}

export async function runCaptainTurn(opts: {
  sessionId: string;
  gameId: string;
  playerId: string;
  message: string;
  emit: Emit;
}): Promise<void> {
  const { sessionId, gameId, playerId, message, emit } = opts;

  const history = histories.get(sessionId) ?? [];
  history.push({ role: "user", content: message });

  const client = await getMcpClient();
  const list = await client.listTools();

  const tools = Object.fromEntries(
    list.tools.map((t) => {
      const props = (t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
      return [
        t.name,
        tool({
          description: t.description ?? "",
          parameters: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (raw: unknown) => {
            const args = { ...(raw as Record<string, unknown>) };
            if ("gameId" in props && args.gameId == null) args.gameId = gameId;
            if ("playerId" in props && args.playerId == null) args.playerId = playerId;
            const result = await callTool(t.name, args);
            const ui = await getToolUiMeta(t.name);
            if (ui?.slot && ui.resourceUri) {
              emit({ type: "mount", slot: ui.slot, resourceUri: ui.resourceUri, toolResult: result });
            }
            emit({ type: "captain-tool", name: t.name, args, result });
            return result;
          },
        }),
      ];
    }),
  );

  let assistantText = "";

  try {
    const result = streamText({
      model: anthropic(MODEL),
      system: systemPrompt(gameId, playerId),
      messages: history.map((h) => ({ role: h.role, content: h.content })),
      tools,
      maxSteps: 10,
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        assistantText += part.textDelta;
        emit({ type: "captain-token", text: part.textDelta });
      } else if (part.type === "error") {
        emit({ type: "captain-error", error: String(part.error) });
      }
    }

    history.push({ role: "assistant", content: assistantText });
    // Cap history at last ~20 turns to avoid runaway context.
    histories.set(sessionId, history.slice(-20));
  } catch (e) {
    emit({ type: "captain-error", error: String(e) });
  } finally {
    emit({ type: "captain-done" });
  }
}

export function clearCaptainHistory(sessionId: string): void {
  histories.delete(sessionId);
}
