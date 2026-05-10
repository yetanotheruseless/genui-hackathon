import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCockpit, type SlotName } from "@/lib/store";
import { McpAppFrame } from "./McpAppFrame";

export function Slot({
  name,
  label,
  hint,
  className,
}: {
  name: SlotName;
  label?: string;
  hint?: string;
  className?: string;
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
        {mount
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
