import { create } from "zustand";

export type SlotName = "viewport" | "side" | "bottom" | "captain";

export type CockpitState = {
  sessionId: string | null;
  gameId: string | null;
  playerId: string | null;
  /** Latest `get_state` payload from the backend (pushed via WS). */
  gameState: unknown | null;
  /** Resource URI mounted in each slot. Empty entries render the fallback. */
  slots: Partial<Record<SlotName, string>>;

  setSession: (sessionId: string) => void;
  bindPlayer: (gameId: string, playerId: string) => void;
  setGameState: (state: unknown) => void;
  mountSlot: (slot: SlotName, resourceUri: string) => void;
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
  mountSlot: (slot, resourceUri) =>
    set((s) => ({ slots: { ...s.slots, [slot]: resourceUri } })),
  clearSlot: (slot) =>
    set((s) => {
      const next = { ...s.slots };
      delete next[slot];
      return { slots: next };
    }),
}));
