import { useState } from "react";
import { Card } from "@/components/ui/card";
import { useCockpit, type SlotName } from "@/lib/store";
import { McpAppFrame } from "./McpAppFrame";

/**
 * Side panel housing two tabbed iframes — Overview (default) and
 * Compendium. Both slots stay mounted across tab switches (rendered in
 * the DOM, just hidden via visibility) so the iframes don't reinitialize
 * and lose their AppBridge handshake every time you switch tabs.
 */
type TabKey = "overview" | "side";

const TAB_LABELS: Record<TabKey, string> = {
  overview: "Overview",
  side: "Compendium",
};
const TAB_HINTS: Record<TabKey, string> = {
  overview: "EvE-style table of stars + planets + orbitals",
  side: "compendium · galaxy + log",
};

export function SideArea({ className }: { className?: string }) {
  const [active, setActive] = useState<TabKey>("overview");

  return (
    <Card className={`flex flex-col overflow-hidden ${className ?? ""}`}>
      <div className="flex border-b flex-shrink-0">
        {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
          <button
            key={key}
            onClick={() => setActive(key)}
            className={
              "flex-1 px-3 py-2 text-xs uppercase tracking-widest border-b-2 transition-colors " +
              (active === key
                ? "text-foreground border-primary"
                : "text-muted-foreground border-transparent hover:text-foreground")
            }
          >
            {TAB_LABELS[key]}
          </button>
        ))}
      </div>
      <div className="relative flex-1 overflow-hidden">
        {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
          <div
            key={key}
            className="absolute inset-0"
            style={{ visibility: active === key ? "visible" : "hidden" }}
          >
            <SlotInner name={key as SlotName} hint={TAB_HINTS[key]} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function SlotInner({ name, hint }: { name: SlotName; hint: string }) {
  const mount = useCockpit((s) => s.slots[name]);
  if (!mount) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        awaiting mount · {hint}
      </div>
    );
  }
  return (
    <McpAppFrame resourceUri={mount.resourceUri} toolResult={mount.toolResult} />
  );
}
