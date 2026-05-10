import { create } from "zustand";

// "side" hosts the compendium iframe (legacy slot name kept for backcompat).
// "overview" is the new EvE-style overview iframe — physically lives in the
// same area as compendium but has its own slot so the host can mount both
// and tab between them rather than swap.
export type SlotName = "viewport" | "side" | "overview" | "bottom" | "captain";

export type MountedSlot = {
  resourceUri: string;
  /** The CallToolResult that triggered this mount, forwarded to the iframe via AppBridge.sendToolResult so its `ontoolresult` handler fires with the init payload. */
  toolResult?: unknown;
};

export type CockpitState = {
  sessionId: string | null;
  gameId: string | null;
  playerId: string | null;
  /** Latest `get_state` payload from the backend (pushed via WS). */
  gameState: unknown | null;
  /** Mount per slot. Empty entries render the fallback. */
  slots: Partial<Record<SlotName, MountedSlot>>;

  setSession: (sessionId: string) => void;
  bindPlayer: (gameId: string, playerId: string) => void;
  setGameState: (state: unknown) => void;
  mountSlot: (slot: SlotName, resourceUri: string, toolResult?: unknown) => void;
  clearSlot: (slot: SlotName) => void;
};

export const useCockpit = create<CockpitState>((set) => ({
  sessionId: null,
  gameId: null,
  playerId: null,
  gameState: null,
  slots: {},

  setSession: (sessionId) => set({ sessionId }),
  bindPlayer: (gameId, playerId) => set({ gameId, playerId }),
  setGameState: (gameState) => set({ gameState }),
  mountSlot: (slot, resourceUri, toolResult) =>
    set((s) => ({ slots: { ...s.slots, [slot]: { resourceUri, toolResult } } })),
  clearSlot: (slot) =>
    set((s) => {
      const next = { ...s.slots };
      delete next[slot];
      return { slots: next };
    }),
}));
