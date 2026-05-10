import { useEffect } from "react";
import { CaptainChat } from "@/components/CaptainChat";
import { SideArea } from "@/components/SideArea";
import { Slot } from "@/components/Slot";
import { startWs } from "@/lib/ws";

export default function App() {
  useEffect(() => {
    startWs();
  }, []);

  return (
    <div className="grid h-screen grid-cols-[1fr_380px] grid-rows-[1fr_320px] gap-2 p-2">
      <Slot name="viewport" hint="cockpit · 3D viewport"       className="col-start-1 row-start-1" />
      <SideArea                                                 className="col-start-2 row-start-1" />
      <Slot name="bottom"   hint="bridge · chat with the Mind" className="col-start-1 row-start-2" />
      <Slot name="captain"  className="col-start-2 row-start-2">
        <CaptainChat />
      </Slot>
    </div>
  );
}
