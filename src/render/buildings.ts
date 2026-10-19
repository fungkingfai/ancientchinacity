/**
 * 華夏古城 — 建築渲染（architecture-dev）
 *
 * 特點：
 *  - 22 種建築各由 `building-prototypes.ts` 程序化建立中式模型（曲簷、青瓦、
 *    紅柱、白牆、匾額、燈籠、旗幡、窗櫺……）。
 *  - 每種建築只建立一份原型；實例以 `clone()` 共用 geometry/material，
 *    同材質靜態面已合併，每棟約 6~12 個 draw call。
 *  - 燈籠搖曳、旗幡飄動、炊煙裊裊、船身起伏、爐火明滅都用極廉價的
 *    transform 動畫（不改材質、不重建幾何），上百棟仍可 60fps。
 *  - `setPreview()` 以快取的幽靈原型＋佔地格線正確顯示建築佔地與可否建造，
 *    且只在 hover／valid 變化時更新。
 *  - 所有可點擊 mesh 都設定 userData.buildingId。
 *
 * 對外介面固定：
 *   createBuildingsView(state): BuildingsView
 *   BuildingsView.group / update(state, dt) / setPreview(state, tool, hover, valid) / dispose()
 */

import * as THREE from 'three';
import { BUILDINGS } from '../core/config';
import type { Building, GameState } from '../core/types';
import { buildingAnchor, buildingWorldCenter, TILE, tileWorld } from './coords';
import { MaterialLibrary } from './models/materials';
import { createPrototypeFactory, type PrototypeFactory } from './models/building-prototypes';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface BuildingsView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  setPreview(state: GameState, tool: string | null, hover: number, valid: boolean): void;
  dispose(): void;
}

/** 建築底部（與 terrain／city-view 約定一致） */
const GROUND_Y = 0.28;
/** 幽靈佔地提示高度（略高於地面，避免 z-fighting） */
const PAD_Y = 0.34;

// ─────────────────────────── 動畫部件 ───────────────────────────

type AnimKind = 'lantern' | 'banner' | 'smoke' | 'bob' | 'glow' | 'wheel';

interface SmokeChild {
  mesh: THREE.Object3D;
  baseScale: number;
  baseY: number;
  offset: number;
}

interface AnimPart {
  obj: THREE.Object3D;
  kind: AnimKind;
  phase: number;
  baseY: number;
  baseRotX: number;
  baseRotY: number;
  baseRotZ: number;
  baseScale: number;
  smokeChildren?: SmokeChild[];
}

interface BuildingInstance {
  id: number;
  key: string;
  group: THREE.Group;
  parts: AnimPart[];
  /** 夜間地面暖光暈（每棟 1 個 mesh，白天隱藏，不增加白天 draw call） */
  glow: THREE.Mesh | null;
}

interface GlowSpec {
  color: number;
  opacity: number;
  scale: number;
}

// ─────────────────────────── 視圖 ───────────────────────────

export function createBuildingsView(state: GameState): BuildingsView {
  const group = new THREE.Group();
  group.name = 'buildings';

  const lib = new MaterialLibrary();
  const factory: PrototypeFactory = createPrototypeFactory(lib);
  const instances = new Map<number, BuildingInstance>();
  let elapsed = 0;

  // ── 夜間「萬家燈火」：共用徑向漸層貼圖 + 共用材質快取 ──
  // 每棟建築只有 1 個地面暖光暈 mesh（僅夜間 visible），因此夜晚每棟 +1 draw call，
  // 白天完全不增加；材質與幾何全部共用，update 只會切 visible 與共用材質參數。
  const glowTexture = lib.canvasTexture(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 3, 64, 64, 63);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  });
  const glowGroundQuad = new THREE.PlaneGeometry(1, 1);
  glowGroundQuad.rotateX(-Math.PI / 2);
  const glowVerticalQuad = new THREE.PlaneGeometry(0.95, 0.95);
  glowVerticalQuad.translate(0, 0.55, 0);
  const glowGeometry = mergeGeometries([glowGroundQuad, glowVerticalQuad], false) ?? glowGroundQuad;
  glowGroundQuad.dispose();
  glowVerticalQuad.dispose();
  const glowMaterials = new Map<string, THREE.MeshBasicMaterial>();
  const glowMaterialFor = (color: number, opacity: number): THREE.MeshBasicMaterial => {
    const key = `${color}|${opacity}`;
    const found = glowMaterials.get(key);
    if (found) return found;
    const mat = lib.own(
      new THREE.MeshBasicMaterial({
        map: glowTexture ?? undefined,
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        fog: false,
      }),
    ) as THREE.MeshBasicMaterial;
    glowMaterials.set(key, mat);
    return mat;
  };

  /** 建築類型的夜間燈火配色：民居暖黃、商業橙黃、寺廟／衙門偏紅、生產偏暗。 */
  const glowSpecFor = (key: string): GlowSpec => {
    switch (key) {
      case 'temple':
        return { color: 0xff6a44, opacity: 0.95, scale: 1.25 };
      case 'yamen':
        return { color: 0xff5a3c, opacity: 0.9, scale: 1.35 };
      case 'market':
      case 'teahouse':
      case 'inn':
        return { color: 0xffcf85, opacity: 0.95, scale: 1.2 };
      case 'hut':
      case 'house':
      case 'manor':
        return { color: 0xffbf72, opacity: 0.85, scale: 1.1 };
      case 'pavilion':
        return { color: 0xffc87a, opacity: 0.7, scale: 0.82 };
      case 'well':
        return { color: 0xffb96a, opacity: 0.55, scale: 0.7 };
      case 'dock':
        return { color: 0xffbd70, opacity: 0.75, scale: 1.0 };
      default:
        return { color: 0xffa85c, opacity: 0.6, scale: 1.0 };
    }
  };

  const isNightClock = (clock: GameState['clock']): boolean => {
    const minutes = clock.hour * 60 + clock.minute;
    return minutes >= 18 * 60 + 30 || minutes < 6 * 60 + 30;
  };
  let nightMode = isNightClock(state.clock);
  lib.setNightMode(nightMode);

  /** 只在日／夜狀態切換時更新共用材質與所有光暈可見度。 */
  const applyNightMode = (night: boolean): void => {
    if (night === nightMode) return;
    nightMode = night;
    lib.setNightMode(night);
    for (const inst of instances.values()) {
      if (inst.glow) inst.glow.visible = night;
    }
  };

  // ── 幽靈／佔地預覽 ──
  const ghostLayer = new THREE.Group();
  ghostLayer.name = 'buildings-preview';
  ghostLayer.visible = false;
  group.add(ghostLayer);
  const ghostHolder = new THREE.Group();
  ghostLayer.add(ghostHolder);

  const ghostOkMat = new THREE.MeshBasicMaterial({
    color: 0x7fd6a0,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ghostBadMat = new THREE.MeshBasicMaterial({
    color: 0xd46060,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const padOkMat = new THREE.MeshBasicMaterial({
    color: 0x7fd6a0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const padBadMat = new THREE.MeshBasicMaterial({
    color: 0xd46060,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const lineOkMat = new THREE.LineBasicMaterial({ color: 0xbff2cf, transparent: true, opacity: 0.9 });
  const lineBadMat = new THREE.LineBasicMaterial({ color: 0xffc9c9, transparent: true, opacity: 0.9 });

  const ghostCache = new Map<string, THREE.Group>();
  const padCache = new Map<string, { pad: THREE.BufferGeometry; lines: THREE.BufferGeometry }>();
  const padMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.04, 1),
    padOkMat,
  );
  padMesh.visible = false;
  ghostLayer.add(padMesh);
  const padLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineOkMat);
  padLines.visible = false;
  ghostLayer.add(padLines);
  let currentGhost: THREE.Group | null = null;
  let lastPreviewSig = '';

  // ─────────────────────── 建立／移除實例 ───────────────────────

  const collectAnimParts = (root: THREE.Object3D, building: Building): AnimPart[] => {
    const parts: AnimPart[] = [];
    const phaseBase = building.id * 0.73;
    root.traverse((obj) => {
      const kind = obj.userData?.anim as AnimKind | undefined;
      if (!kind) return;
      const part: AnimPart = {
        obj,
        kind,
        phase: phaseBase + parts.length * 1.7,
        baseY: obj.position.y,
        baseRotX: obj.rotation.x,
        baseRotY: obj.rotation.y,
        baseRotZ: obj.rotation.z,
        baseScale: obj.scale.x,
      };
      if (kind === 'smoke') {
        part.smokeChildren = obj.children.map((child, i) => ({
          mesh: child,
          baseScale: child.scale.x,
          baseY: child.position.y,
          offset: i * 0.3,
        }));
      }
      parts.push(part);
    });
    return parts;
  };

  /** 碼頭要朝向最近的水面（模型吊臂／棧橋預設朝 +x）。 */
  const dockYaw = (s: GameState, bx: number, by: number, w: number, h: number): number => {
    const test = (dx: number, dz: number): boolean => {
      if (dx !== 0) {
        const x = dx > 0 ? bx + w : bx - 1;
        if (x < 0 || x >= s.width) return false;
        for (let i = 0; i < h; i++) {
          const y = by + i;
          if (y < 0 || y >= s.height) continue;
          if (s.tiles[y * s.width + x].terrain === 'water') return true;
        }
      } else {
        const y = dz > 0 ? by + h : by - 1;
        if (y < 0 || y >= s.height) return false;
        for (let i = 0; i < w; i++) {
          const x = bx + i;
          if (x < 0 || x >= s.width) continue;
          if (s.tiles[y * s.width + x].terrain === 'water') return true;
        }
      }
      return false;
    };
    if (test(1, 0)) return 0;
    if (test(-1, 0)) return Math.PI;
    if (test(0, 1)) return -Math.PI / 2;
    if (test(0, -1)) return Math.PI / 2;
    return 0;
  };

  const addBuilding = (s: GameState, building: Building): void => {
    const proto = factory.get(building.key, building.id);
    const model = proto.root.clone(true);
    const center = buildingWorldCenter(s, building);
    model.position.set(center.x, GROUND_Y, center.z);
    if (building.key === 'dock') {
      model.rotation.y = dockYaw(s, building.x, building.y, building.w, building.h);
    }
    model.userData.buildingId = building.id;
    model.traverse((obj) => {
      obj.userData.buildingId = building.id;
    });

    // 夜間地面暖光暈（不設 buildingId，raycast 停用，避免影響點選）
    let glow: THREE.Mesh | null = null;
    if (glowTexture) {
      const spec = glowSpecFor(building.key);
      const footprint = (proto.footprintW + proto.footprintD) / 2;
      const size = Math.min(5.2, Math.max(2.4, footprint + 1.0 * spec.scale));
      glow = new THREE.Mesh(glowGeometry, glowMaterialFor(spec.color, spec.opacity));
      glow.position.set(0, 0.02, proto.footprintD / 2 + 0.3);
      glow.scale.setScalar(size);
      glow.renderOrder = 2;
      glow.visible = nightMode;
      glow.raycast = () => {
        /* 光暈不參與點選 */
      };
      model.add(glow);
    }

    group.add(model);
    instances.set(building.id, {
      id: building.id,
      key: building.key,
      group: model,
      parts: collectAnimParts(model, building),
      glow,
    });
  };

  const removeBuilding = (id: number): void => {
    const inst = instances.get(id);
    if (!inst) return;
    group.remove(inst.group);
    instances.delete(id);
  };

  const sync = (s: GameState): void => {
    const seen = new Set<number>();
    for (const b of s.buildings) {
      seen.add(b.id);
      if (!instances.has(b.id)) addBuilding(s, b);
    }
    for (const id of [...instances.keys()]) {
      if (!seen.has(id)) removeBuilding(id);
    }
  };

  sync(state);

  // ─────────────────────── 每幀動畫 ───────────────────────

  const animateParts = (inst: BuildingInstance): void => {
    for (const part of inst.parts) {
      const t = elapsed;
      switch (part.kind) {
        case 'lantern': {
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.35 + part.phase) * 0.075;
          part.obj.rotation.x = part.baseRotX + Math.sin(t * 0.9 + part.phase * 1.3) * 0.03;
          break;
        }
        case 'banner': {
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.6 + part.phase) * 0.06;
          part.obj.rotation.y = part.baseRotY + Math.sin(t * 0.8 + part.phase * 0.7) * 0.04;
          break;
        }
        case 'smoke': {
          part.obj.position.y = part.baseY + ((t * 0.22 + part.phase * 0.12) % 1) * 0.35;
          if (part.smokeChildren) {
            for (const child of part.smokeChildren) {
              const cycle = (t * 0.22 + part.phase * 0.12 + child.offset) % 1;
              const grow = 0.35 + cycle * 1.5;
              child.mesh.scale.setScalar(child.baseScale * grow);
              child.mesh.position.y = child.baseY + cycle * 0.9;
            }
          }
          break;
        }
        case 'bob': {
          part.obj.position.y = part.baseY + Math.sin(t * 0.85 + part.phase) * 0.05;
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 0.6 + part.phase) * 0.025;
          break;
        }
        case 'glow': {
          const pulse = 1 + Math.sin(t * 3.1 + part.phase) * 0.12;
          part.obj.scale.setScalar(part.baseScale * pulse);
          break;
        }
        case 'wheel': {
          part.obj.rotation.z = part.baseRotZ + t * 0.8;
          break;
        }
      }
    }
  };

  // ─────────────────────── 預覽 ───────────────────────

  const getGhost = (key: string, valid: boolean): THREE.Group => {
    const cacheKey = `${key}|${valid ? 1 : 0}`;
    const found = ghostCache.get(cacheKey);
    if (found) return found;
    const proto = factory.get(key, 0);
    const ghost = proto.root.clone(true);
    const mat = valid ? ghostOkMat : ghostBadMat;
    ghost.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = mat;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
    ghostCache.set(cacheKey, ghost);
    return ghost;
  };

  /** 佔地格線幾何（外框＋每格分隔線）。 */
  const getPadGeometry = (wTiles: number, hTiles: number): { pad: THREE.BufferGeometry; lines: THREE.BufferGeometry } => {
    const key = `${wTiles}x${hTiles}`;
    const found = padCache.get(key);
    if (found) return found;
    const w = wTiles * TILE;
    const h = hTiles * TILE;
    const pad = new THREE.BoxGeometry(w - 0.12, 0.04, h - 0.12);
    const pts: number[] = [];
    const y = 0.03;
    // 外框
    pts.push(-w / 2 + 0.06, y, -h / 2 + 0.06, w / 2 - 0.06, y, -h / 2 + 0.06);
    pts.push(w / 2 - 0.06, y, -h / 2 + 0.06, w / 2 - 0.06, y, h / 2 - 0.06);
    pts.push(w / 2 - 0.06, y, h / 2 - 0.06, -w / 2 + 0.06, y, h / 2 - 0.06);
    pts.push(-w / 2 + 0.06, y, h / 2 - 0.06, -w / 2 + 0.06, y, -h / 2 + 0.06);
    // 格線
    for (let i = 1; i < wTiles; i++) {
      const x = -w / 2 + i * TILE;
      pts.push(x, y, -h / 2 + 0.06, x, y, h / 2 - 0.06);
    }
    for (let j = 1; j < hTiles; j++) {
      const z = -h / 2 + j * TILE;
      pts.push(-w / 2 + 0.06, y, z, w / 2 - 0.06, y, z);
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const entry = { pad, lines };
    padCache.set(key, entry);
    return entry;
  };

  const showPad = (wTiles: number, hTiles: number, cx: number, cz: number, valid: boolean, y = PAD_Y): void => {
    const entry = getPadGeometry(wTiles, hTiles);
    padMesh.geometry = entry.pad;
    padMesh.position.set(cx, y, cz);
    padMesh.material = valid ? padOkMat : padBadMat;
    padMesh.visible = true;
    padLines.geometry = entry.lines;
    padLines.position.set(cx, y + 0.02, cz);
    padLines.material = valid ? lineOkMat : lineBadMat;
    padLines.visible = true;
  };

  const hidePad = (): void => {
    padMesh.visible = false;
    padLines.visible = false;
  };

  const clearGhost = (): void => {
    if (currentGhost) {
      ghostHolder.remove(currentGhost);
      currentGhost = null;
    }
  };

  const setPreview = (s: GameState, tool: string | null, hover: number, valid: boolean): void => {
    const sig = `${tool}|${hover}|${valid ? 1 : 0}|${s.buildings.length}|${s.ui.mode}`;
    if (sig === lastPreviewSig) return;
    lastPreviewSig = sig;

    if (!tool || hover < 0 || hover >= s.tiles.length || s.ui.mode !== 'city') {
      ghostLayer.visible = false;
      clearGhost();
      hidePad();
      return;
    }

    ghostLayer.visible = true;
    const tile = s.tiles[hover];
    const tx = hover % s.width;
    const ty = Math.floor(hover / s.width);

    // 道路／拆除：只顯示該格佔地
    if (tool === 'road' || tool === 'demolish') {
      clearGhost();
      const center = tileWorld(tx, ty, s.width, s.height);
      const ok = tool === 'road' ? valid : tile.buildingId >= 0 || tile.road;
      showPad(1, 1, center.x, center.z, ok, 0.42);
      return;
    }

    const def = BUILDINGS[tool];
    if (!def) {
      ghostLayer.visible = false;
      clearGhost();
      hidePad();
      return;
    }
    const [w, h] = def.size;
    const anchor = buildingAnchor(s, tool, w, h, tx, ty);
    const cx = (anchor.x + w / 2) * TILE - (s.width * TILE) / 2;
    const cz = (anchor.y + h / 2) * TILE - (s.height * TILE) / 2;
    const ghost = getGhost(tool, valid);
    if (currentGhost !== ghost) {
      clearGhost();
      ghostHolder.add(ghost);
      currentGhost = ghost;
    }
    // 幽靈模型本體
    if (tool === 'dock') {
      ghost.rotation.y = dockYaw(s, anchor.x, anchor.y, w, h);
    } else {
      ghost.rotation.y = 0;
    }
    ghostHolder.position.set(cx, GROUND_Y, cz);
    ghostHolder.visible = true;
    showPad(w, h, cx, cz, valid, GROUND_Y + 0.02);
  };

  // ─────────────────────── 對外 ───────────────────────

  return {
    group,

    update(s: GameState, dt: number): void {
      elapsed += Math.min(0.1, dt);
      applyNightMode(isNightClock(s.clock));
      sync(s);
      for (const inst of instances.values()) animateParts(inst);
    },

    setPreview,

    dispose(): void {
      for (const id of [...instances.keys()]) removeBuilding(id);
      factory.dispose();
      ghostCache.clear();
      for (const entry of padCache.values()) {
        entry.pad.dispose();
        entry.lines.dispose();
      }
      padCache.clear();
      glowGeometry.dispose();
      padMesh.geometry.dispose();
      padLines.geometry.dispose();
      ghostOkMat.dispose();
      ghostBadMat.dispose();
      padOkMat.dispose();
      padBadMat.dispose();
      lineOkMat.dispose();
      lineBadMat.dispose();
      lib.dispose();
    },
  };
}
