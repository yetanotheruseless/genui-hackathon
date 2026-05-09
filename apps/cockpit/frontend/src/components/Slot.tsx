import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCockpit, type SlotName } from "@/lib/store";
import { McpAppFrame } from "./McpAppFrame";

export function Slot({
  name,
  label,
  hint,
  className,
  children,
}: {
  name: SlotName;
  label?: string;
  hint?: string;
  className?: string;
  /** If provided, rendered instead of the MCP frame (useful for `captain`). */
  children?: ReactNode;
}) {
  const mount = useCockpit((s) => s.slots[name]);
  return (
    <Card className={`flex flex-col overflow-hidden ${className ?? ""}`}>
      <CardHeader className="border-b py-2 px-3 flex-shrink-0">
        <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
          {label ?? name}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        {children
          ? children
          : mount
          ? <McpAppFrame resourceUri={mount.resourceUri} toolResult={mount.toolResult} />
          : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              awaiting mount{hint ? ` · ${hint}` : ""}
            </div>
          )}
      </CardContent>
    </Card>
  );
}
