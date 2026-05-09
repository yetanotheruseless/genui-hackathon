/**
 * Cockpit pane — Three.js starfield, throttle, warp/impulse drive.
 *
 * Multiplayer-aware: extracts `gameId` + `playerId` from the initial tool
 * result, threads both through every subsequent server call. Shows the
 * current Culture ship name + Mind in the top strip. Renders other
 * players' ships as small markers when they're inside the visible volume,
 * and renders Orbitals as ring sprites.
 */
import * as THREE from "three";

import { callTool, poll, setupPaneApp } from "./shared.js";

type StarLite = {
  id: string; name: string; position: [number, number, number];
  spectralClass: string; spectralType: string; lumClass: string;
  distanceLy: number; hasPlanets: boolean;
};

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;
const speedReadout = document.getElementById("speed-readout") as HTMLElement;
const throttleEl = document.getElementById("throttle") as HTMLInputElement;
const headingReadout = document.getElementById("heading-readout") as HTMLElement;
const warpBtn = document.getElementById("warp-btn") as HTMLButtonElement;
const hudPos = document.getElementById("hud-pos") as HTMLElement;
const hudDistance = document.getElementById("hud-distance") as HTMLElement;
const hudTarget = document.getElementById("hud-target") as HTMLElement;
const hudLlm = document.getElementById("hud-llm") as HTMLElement;
const hudShip = document.getElementById("hud-ship") as HTMLElement | null;
const hudMind = document.getElementById("hud-mind") as HTMLElement | null;
const nearestList = document.getElementById("nearest-list") as HTMLOListElement;
const targetTag = document.getElementById("target-tag") as HTMLElement;

const pane = setupPaneApp("Culture Cockpit");
let gameId = "";
let playerId = "";
let stars: StarLite[] = [];
const observed = new Set<string>();

// --- scene setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x040814);
scene.fog = new THREE.FogExp2(0x040814, 0.0005);
const camera = new THREE.PerspectiveCamera(70, 1, 0.001, 5000);
camera.position.set(0, 0, 0);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

const starPoints = new THREE.Group();
scene.add(starPoints);
const orbitalGroup = new THREE.Group();
scene.add(orbitalGroup);
const otherShipsGroup = new THREE.Group();
scene.add(otherShipsGroup);

function spectralColor(cls: string, lum: string): number {
  if (cls === "WD") return 0xeaffff;
  if (cls === "NS") return 0x9999ff;
  if (lum === "Ia" || lum === "Iab" || lum === "Ib") {
    return cls === "M" || cls === "K" ? 0xff7f50 : 0x9bb8ff;
  }
  switch (cls) {
    case "O": return 0x9bb8ff;
    case "B": return 0xaecaff;
    case "A": return 0xffffff;
    case "F": return 0xfff4d6;
    case "G": return 0xfff099;
    case "K": return 0xffc06b;
    case "M": return 0xff8a4f;
    default: return 0xcccccc;
  }
}

function buildStarMeshes() {
  starPoints.clear();
  for (const s of stars) {
    const color = spectralColor(s.spectralClass, s.lumClass);
    const isSupergiant = s.lumClass === "Ia" || s.lumClass === "Iab" || s.lumClass === "Ib";
    const baseSize = isSupergiant ? 1.2
                   : s.spectralClass === "WD" ? 0.12
                   : s.spectralClass === "M"  ? 0.20
                   : s.spectralClass === "K"  ? 0.30
                   : s.spectralClass === "G"  ? 0.40
                   : s.spectralClass === "F"  ? 0.50
                   : s.spectralClass === "A"  ? 0.65
                   : s.spectralClass === "B"  ? 0.80
                   : 0.30;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      color, sizeAttenuation: true, transparent: true, opacity: 0.95,
    }));
    sprite.scale.set(baseSize, baseSize, 1);
    sprite.position.set(...s.position);
    sprite.userData = { star: s };
    starPoints.add(sprite);

    if (s.hasPlanets) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.01, 4, 32),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
      );
      ring.position.set(...s.position);
      ring.rotation.x = Math.PI / 2;
      starPoints.add(ring);
    }
  }
}

function syncOrbitals(orbitals: any[]) {
  // Cheap rebuild — orbitals don't churn fast.
  orbitalGroup.clear();
  for (const o of orbitals) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(Math.max(0.05, o.ringRadius * 100), 0.008, 4, 32),
      new THREE.MeshBasicMaterial({ color: 0x9c6cff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.position.set(o.position[0], o.position[1], o.position[2]);
    ring.rotation.x = Math.PI / 2.5;
    orbitalGroup.add(ring);
  }
}

function syncOtherShips(others: any[]) {
  otherShipsGroup.clear();
  for (const o of others) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0x88ffd9, sizeAttenuation: true, transparent: true, opacity: 0.9,
    }));
    sprite.scale.set(0.15, 0.15, 1);
    sprite.position.set(o.position[0], o.position[1], o.position[2]);
    otherShipsGroup.add(sprite);
  }
}

// --- state ---
const ship = {
  position: new THREE.Vector3(0, 0, 0),
  yaw: 0, pitch: 0,
  throttle: 0,
  hoveredId: null as string | null,
  targetId: null as string | null,
  warpEngaged: false,
};
let lastSyncedTargetId: string | null = null;
const OBSERVE_RANGE_LY = 0.15;

// --- input ---
let dragging = false;
let dragStart = { x: 0, y: 0 };
let dragMoved = false;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true; dragStart = { x: e.clientX, y: e.clientY }; dragMoved = false;
  overlay.classList.add("hidden"); canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (Math.hypot(dx, dy) > 4) dragMoved = true;
  dragStart = { x: e.clientX, y: e.clientY };
  ship.yaw   -= dx * 0.004;
  ship.pitch -= dy * 0.004;
  ship.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, ship.pitch));
});
canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  if (!dragMoved) pickStarUnderClick(e.clientX, e.clientY);
});

throttleEl.addEventListener("input", () => { ship.throttle = parseFloat(throttleEl.value); });
warpBtn.addEventListener("click", () => { if (ship.hoveredId) engageWarp(ship.hoveredId); });

function pickStarUnderClick(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  let bestId: string | null = null;
  let bestAngle = 0.04;
  for (const obj of starPoints.children) {
    if (!(obj instanceof THREE.Sprite)) continue;
    const v = obj.position.clone().sub(camera.position).normalize();
    const angle = v.angleTo(raycaster.ray.direction);
    if (angle < bestAngle) {
      bestAngle = angle;
      bestId = (obj.userData?.star as StarLite | undefined)?.id ?? null;
    }
  }
  if (bestId) engageWarp(bestId);
}

async function engageWarp(objectId: string) {
  if (!gameId || !playerId) return;
  ship.targetId = objectId;
  ship.warpEngaged = true;
  lastSyncedTargetId = objectId;
  await callTool(pane.app, "warp_to", { gameId, playerId, objectId });
}

// --- init ---
pane.initial.then((init) => {
  gameId = init.gameId;
  playerId = init.playerId;
  stars = init.stars || [];
  buildStarMeshes();
  if (init.llm) hudLlm.textContent = `${init.llm.online ? "" : "offline · "}${init.llm.provider}/${init.llm.model}`;
  if (init.ship && hudShip) hudShip.textContent = init.ship.name;
  if (init.ship && hudMind) hudMind.textContent = init.ship.class;
});

// --- main loop ---
let last = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const fwd = new THREE.Vector3(
    Math.cos(ship.pitch) * Math.sin(ship.yaw),
    Math.sin(ship.pitch),
    -Math.cos(ship.pitch) * Math.cos(ship.yaw),
  );

  if (ship.warpEngaged && ship.targetId) {
    const target = stars.find((s) => s.id === ship.targetId);
    if (target) {
      const targetPos = new THREE.Vector3(...target.position);
      const dir = targetPos.clone().sub(ship.position);
      const dist = dir.length();
      dir.normalize();
      const blend = Math.min(1, dt * 3);
      const newFwd = fwd.lerp(dir, blend).normalize();
      ship.yaw   = Math.atan2(newFwd.x, -newFwd.z);
      ship.pitch = Math.asin(Math.max(-1, Math.min(1, newFwd.y)));
      const targetThrottle = dist > 1 ? 0.95 : Math.max(0.1, Math.min(0.4, dist * 0.8));
      ship.throttle = ship.throttle * 0.85 + targetThrottle * 0.15;
      throttleEl.value = ship.throttle.toString();
      if (dist <= OBSERVE_RANGE_LY) {
        ship.warpEngaged = false;
        ship.throttle = 0;
        throttleEl.value = "0";
        if (!observed.has(target.id)) {
          observed.add(target.id);
          if (gameId && playerId) {
            void callTool(pane.app, "observe", { gameId, playerId, objectId: target.id });
          }
        }
      }
    }
  }

  const speed = Math.pow(ship.throttle, 3) * 0.4;
  if (speed > 0) ship.position.addScaledVector(fwd, speed * dt);

  camera.position.copy(ship.position);
  camera.lookAt(ship.position.clone().add(fwd));

  updateHud(fwd);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function updateHud(fwd: THREE.Vector3) {
  const speed = Math.pow(ship.throttle, 3) * 0.4;
  const fmt = (s: number) => {
    if (s < 0.005) return `impulse ${(s * 200).toFixed(2)}c`;
    if (s < 0.1)   return `warp ${Math.max(1, Math.round(s * 20))}`;
    return `warp ${Math.min(9, Math.round(2 + Math.log2(Math.max(1, s * 10))))}`;
  };
  speedReadout.textContent = fmt(speed);
  headingReadout.textContent = `(${fwd.x.toFixed(2)}, ${fwd.y.toFixed(2)}, ${fwd.z.toFixed(2)})`;
  const dSol = ship.position.length();
  hudPos.textContent = dSol < 0.05 ? "at Sol" : `${dSol.toFixed(2)} ly from Sol`;

  const ranked = stars
    .map((s) => ({ star: s, dist: new THREE.Vector3(...s.position).distanceTo(ship.position) }))
    .filter((e) => e.dist > 0.001)
    .sort((a, b) => a.dist - b.dist);

  let hoveredId: string | null = null;
  let bestAngle = 0.06;
  for (const { star } of ranked.slice(0, 8)) {
    const v = new THREE.Vector3(...star.position).sub(ship.position).normalize();
    const angle = v.angleTo(fwd);
    if (angle < bestAngle) { bestAngle = angle; hoveredId = star.id; }
  }
  ship.hoveredId = hoveredId;

  if (hoveredId) {
    const s = stars.find((s) => s.id === hoveredId)!;
    const d = new THREE.Vector3(...s.position).distanceTo(ship.position);
    targetTag.style.display = "";
    targetTag.textContent = `${s.name} · ${s.spectralType} · ${d.toFixed(2)} ly`;
  } else {
    targetTag.style.display = "none";
  }
  hudTarget.textContent = ship.targetId
    ? `target: ${stars.find((s) => s.id === ship.targetId)?.name ?? "?"} ${ship.warpEngaged ? "(warping)" : ""}`
    : "no target";
  hudDistance.textContent = ship.targetId
    ? `${new THREE.Vector3(...(stars.find((s) => s.id === ship.targetId)?.position ?? [0,0,0])).distanceTo(ship.position).toFixed(2)} ly to target`
    : "—";

  nearestList.innerHTML = "";
  for (const { star, dist } of ranked.slice(0, 6)) {
    const li = document.createElement("li");
    li.textContent = `${star.name} · ${dist.toFixed(2)} ly`;
    if (star.id === ship.hoveredId) li.classList.add("target");
    nearestList.appendChild(li);
  }
}

function resize() {
  const r = canvas.parentElement!.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(1, Math.floor(r.height));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();
requestAnimationFrame(tick);

// --- server polling ---
poll(200, async () => {
  if (!gameId || !playerId) return;
  await callTool(pane.app, "sync_state", {
    gameId, playerId,
    state: {
      position: [ship.position.x, ship.position.y, ship.position.z],
      heading: [Math.sin(ship.yaw), Math.sin(ship.pitch), -Math.cos(ship.yaw)],
      throttle: ship.throttle,
      hoveredId: ship.hoveredId,
      targetId: ship.targetId,
      warpEngaged: ship.warpEngaged,
    },
  });
  const state = await callTool<any>(pane.app, "get_state", { gameId, playerId });
  if (state?.targetId && state.targetId !== lastSyncedTargetId) {
    lastSyncedTargetId = state.targetId;
    ship.targetId = state.targetId;
    ship.warpEngaged = true;
  }
  if (state?.galaxy?.orbitals) syncOrbitals(state.galaxy.orbitals);
  if (state?.galaxy?.nearbyPlayers) syncOtherShips(state.galaxy.nearbyPlayers);
});
