/**
 * Three.js wireframe scene.
 *
 * Walls are simple boxes with `wireframe: true` material — cheap, looks
 * good in dark mode, and reads as "Tron-y first-person dungeon" in a
 * 200-pixel-tall viewport without needing textures or lights.
 *
 * The renderer doesn't own state. It diffs from the GameState each frame:
 * adds wall meshes for newly-loaded chunks, removes meshes for chunks
 * that have drifted far from the player (we never actually unload right
 * now — the chunk count grows — but the hook is here for free).
 */
import * as THREE from "three";

import { CELL, CHUNK, type Chunk, type GameState, chunkKey, ensureChunk } from "./game.js";

export type SceneHandles = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  resize: () => void;
  render: (state: GameState) => void;
  decoMeshes: Map<string, THREE.Object3D>;
};

const WALL_COLOR = 0x6ee7ff;
const FLOOR_COLOR = 0x1a1c28;
const DECO_COLOR = 0xffb86b;

export function createScene(canvas: HTMLCanvasElement): SceneHandles {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x08080d, 4, 14);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 60);
  camera.position.set(0, 0.5, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setClearColor(0x08080d, 1);

  // Floor — a single big plane is enough; wireframe grid via shader-y trick.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000, 1, 1),
    new THREE.MeshBasicMaterial({ color: FLOOR_COLOR, wireframe: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  scene.add(floor);

  // Subtle grid for orientation.
  const grid = new THREE.GridHelper(2000, 2000, 0x222633, 0x16181f);
  grid.position.y = 0.01;
  scene.add(grid);

  const wallMat = new THREE.MeshBasicMaterial({ color: WALL_COLOR, wireframe: true });

  // Per-chunk wall group, lazily added.
  const chunkGroups = new Map<string, THREE.Group>();
  const decoMeshes = new Map<string, THREE.Object3D>(); // key: "cx,cy:dx,dy"

  function ensureChunkMeshes(chunk: Chunk) {
    const key = chunkKey(chunk.cx, chunk.cy);
    if (chunkGroups.has(key)) return;
    const group = new THREE.Group();
    const baseX = chunk.cx * CHUNK;
    const baseY = chunk.cy * CHUNK;
    const inst = new THREE.InstancedMesh(
      new THREE.BoxGeometry(CELL * 0.96, CELL * 0.96, CELL * 0.96),
      wallMat,
      CHUNK * CHUNK,
    );
    let n = 0;
    const m = new THREE.Matrix4();
    for (let y = 0; y < CHUNK; y++) {
      for (let x = 0; x < CHUNK; x++) {
        if (chunk.cells[y][x] === 1) {
          m.makeTranslation(baseX + x + 0.5, 0.5, baseY + y + 0.5);
          inst.setMatrixAt(n++, m);
        }
      }
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    scene.add(group);
    chunkGroups.set(key, group);
  }

  function ensureDecorations(chunk: Chunk) {
    if (!chunk.loreLoaded) return;
    const baseX = chunk.cx * CHUNK;
    const baseY = chunk.cy * CHUNK;
    for (const d of chunk.decorations) {
      const id = `${chunk.cx},${chunk.cy}:${d.x},${d.y}`;
      if (decoMeshes.has(id)) continue;
      const obj = decorationMesh(d.kind);
      obj.position.set(baseX + d.x + 0.5, 0.25, baseY + d.y + 0.5);
      obj.userData = { id, deco: d, chunk: { cx: chunk.cx, cy: chunk.cy } };
      scene.add(obj);
      decoMeshes.set(id, obj);
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

  function render(state: GameState) {
    // Materialise meshes for every chunk currently in state.
    for (const chunk of state.chunks.values()) {
      ensureChunkMeshes(chunk);
      ensureDecorations(chunk);
    }
    camera.position.x = state.player.wx;
    camera.position.z = state.player.wy;
    camera.position.y = 0.5;
    camera.rotation.order = "YXZ";
    camera.rotation.y = -state.player.angle + Math.PI / 2; // map +y world to -z view
    renderer.render(scene, camera);
  }

  return { scene, camera, renderer, resize, render, decoMeshes };
}

function decorationMesh(kind: string): THREE.Object3D {
  const color = decoColor(kind);
  const geom = decoGeom(kind);
  const mat = new THREE.MeshBasicMaterial({ color, wireframe: true });
  return new THREE.Mesh(geom, mat);
}

function decoGeom(kind: string): THREE.BufferGeometry {
  switch (kind) {
    case "chest":
      return new THREE.BoxGeometry(0.5, 0.4, 0.35);
    case "altar":
      return new THREE.BoxGeometry(0.6, 0.7, 0.6);
    case "statue":
      return new THREE.ConeGeometry(0.25, 0.9, 5);
    case "glyph":
      return new THREE.RingGeometry(0.18, 0.32, 6);
    case "crystal":
      return new THREE.OctahedronGeometry(0.3, 0);
    case "bones":
      return new THREE.SphereGeometry(0.18, 6, 4);
    case "book":
      return new THREE.BoxGeometry(0.25, 0.05, 0.18);
    case "goblin":
      return new THREE.ConeGeometry(0.18, 0.55, 4);
    case "slime":
      return new THREE.SphereGeometry(0.27, 6, 4);
    case "wisp":
      return new THREE.SphereGeometry(0.15, 6, 4);
    default:
      return new THREE.TetrahedronGeometry(0.3);
  }
}

function decoColor(kind: string): number {
  switch (kind) {
    case "chest": return 0xffb86b;
    case "altar": return 0xc896ff;
    case "statue": return 0x9aa0b5;
    case "glyph": return 0x6ee7ff;
    case "crystal": return 0x88f1ff;
    case "bones": return 0xd6cfb9;
    case "book": return 0xa07a4e;
    case "goblin": return 0xf08c87;
    case "slime": return 0x8ee089;
    case "wisp": return 0xffffff;
    default: return DECO_COLOR;
  }
}

/**
 * Find the nearest decoration within `range` cells of the player.
 * Used by the "interact" button.
 */
export function nearestDecoration(
  state: GameState,
  range: number = 1.2,
): { id: string; deco: { x: number; y: number; kind: string; label?: string }; cx: number; cy: number } | null {
  let best: any = null;
  let bestDist = range;
  for (const chunk of state.chunks.values()) {
    if (!chunk.loreLoaded) continue;
    for (const d of chunk.decorations) {
      const dx = chunk.cx * CHUNK + d.x + 0.5 - state.player.wx;
      const dy = chunk.cy * CHUNK + d.y + 0.5 - state.player.wy;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        bestDist = dist;
        best = { id: `${chunk.cx},${chunk.cy}:${d.x},${d.y}`, deco: d, cx: chunk.cx, cy: chunk.cy };
      }
    }
  }
  return best;
}
