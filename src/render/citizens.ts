/**
 * 市民／搬運工／馬車渲染（citizen-dev）
 *
 * - 低多邊形村民：斗笠、長衫、腰帶、手腳擺動、朝向移動方向；衣色／膚色由 look 決定
 * - 工作／購物中的市民會出現在所屬建築周圍，在家者隱藏（室內）
 * - 搬運工 + 馬車：拉車人、車板、貨箱（顏色隨 ResourceKey）、車輪轉動（讀 state.carts，只讀不寫）
 * - 全部使用 InstancedMesh，人口上限 800 時仍可維持效能
 *
 * 對外介面（不可破壞）：
 *   createCitizensView(state): CitizensView
 *   CitizensView.group / update(state, dt) / dispose()
 *
 * 座標：
 *   citizen.x / y 為「格中心座標」（格 (tx,ty) 中心 = tx+0.5, ty+0.5）
 *   cart.x / y 為「格索引浮點」（沿用基準版公式 (x+0.5)*TILE）
 */

import * as THREE from 'three';
import { BUILDINGS, RESOURCES } from '../core/config';
import type { Building, Citizen, GameState, TerrainType } from '../core/types';
import { TILE } from './coords';

export interface CitizensView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

// ─────────────────────────── 設定 ───────────────────────────

const MAX_VISIBLE = 900;
const MAX_CARTS = 80;

/** 長衫配色（低飽和漢服色系） */
const ROBE_COLORS = [0x7d5a4f, 0x5c6f7d, 0x8a7a55, 0x6d5c7a, 0x8a5a44, 0x4f6b5a, 0x9c6b4a, 0x546a8a, 0x7a6a5a, 0x6b5f7d];
const SASH_COLORS = [0x8f2f2a, 0x2f4a6a, 0x6a4a2a, 0x9c7a2a, 0x4a3a2a, 0x7a2f3a];
const SKIN_COLORS = [0xe0bc96, 0xd3a97f, 0xc79a70, 0xb98a63];
const HAT_COLOR = 0xc7ac74;

/** 地形表面高度（與 render/terrain.ts 基準版公式一致；世界渲染改版時只需調這裡） */
const LAND_HEIGHT: Record<TerrainType, number> = {
  grass: 0.18,
  fertile: 0.16,
  forest: 0.24,
  hill: 0.75,
  mountain: 1.8,
  water: 0.02,
  sand: 0.1,
};

function groundYForTile(state: GameState, tx: number, ty: number): number {
  const x = Math.min(state.width - 1, Math.max(0, tx));
  const y = Math.min(state.height - 1, Math.max(0, ty));
  const tile = state.tiles[y * state.width + x];
  if (!tile) return 0.34;
  if (tile.terrain === 'water') return 0.12;
  let ground = (LAND_HEIGHT[tile.terrain] ?? 0.2) + tile.elevation * 0.35;
  if (tile.road) ground = Math.max(ground, 0.33);
  return ground + 0.01;
}

// ─────────────────────────── 小工具 ───────────────────────────

function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (b - a) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return a + delta * t;
}

interface FacingState {
  x: number;
  y: number;
  yaw: number;
  touch: number;
}

interface InstancedSet {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

function makeInstanced(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  count: number,
  colored: boolean,
): InstancedSet {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  if (colored) {
    // 先配置 instanceColor 緩衝（白色基底，實際顏色每幀設定）
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < count; i++) mesh.setColorAt(i, white);
    if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  group.add(mesh);
  return { mesh, geometry, material };
}

// ─────────────────────────── 建立視圖 ───────────────────────────

export function createCitizensView(state: GameState): CitizensView {
  const group = new THREE.Group();
  group.name = 'citizens';

  // ── 幾何體（共用、低多邊形） ──
  const bodyGeo = new THREE.CylinderGeometry(0.17, 0.265, 0.62, 7);
  const headGeo = new THREE.SphereGeometry(0.135, 8, 6);
  const hatGeo = new THREE.ConeGeometry(0.32, 0.16, 9);
  const sashGeo = new THREE.CylinderGeometry(0.225, 0.245, 0.08, 7);
  const armGeo = new THREE.BoxGeometry(0.075, 0.32, 0.075);
  const footGeo = new THREE.BoxGeometry(0.1, 0.14, 0.14);

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const headMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const hatMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const sashMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const armMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const footMat = new THREE.MeshLambertMaterial({ color: 0x2f2a25 });

  const body = makeInstanced(group, bodyGeo, bodyMat, MAX_VISIBLE, true);
  const head = makeInstanced(group, headGeo, headMat, MAX_VISIBLE, true);
  const hat = makeInstanced(group, hatGeo, hatMat, MAX_VISIBLE, true);
  const sash = makeInstanced(group, sashGeo, sashMat, MAX_VISIBLE, true);
  const armL = makeInstanced(group, armGeo, armMat, MAX_VISIBLE, false);
  const armR = makeInstanced(group, armGeo, armMat, MAX_VISIBLE, false);
  const footL = makeInstanced(group, footGeo, footMat, MAX_VISIBLE, false);
  const footR = makeInstanced(group, footGeo, footMat, MAX_VISIBLE, false);

  // ── 搬運工（拉車人） ──
  const porterBody = makeInstanced(group, bodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_CARTS, true);
  const porterHead = makeInstanced(group, headGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_CARTS, true);
  const porterHat = makeInstanced(group, hatGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_CARTS, true);

  // ── 馬車 ──
  const cartGeo = new THREE.BoxGeometry(1.0, 0.18, 0.6);
  const cartMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
  const cartBed = makeInstanced(group, cartGeo, cartMat, MAX_CARTS, false);

  const cartGoodsGeo = new THREE.BoxGeometry(0.32, 0.26, 0.3);
  const cartGoodsMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const cargo = makeInstanced(group, cartGoodsGeo, cartGoodsMat, MAX_CARTS * 3, true);

  const wheelGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.07, 8);
  wheelGeo.rotateZ(Math.PI / 2); // 輪軸沿 X
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x3a2a1c });
  const wheels = makeInstanced(group, wheelGeo, wheelMat, MAX_CARTS * 2, false);

  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  const color = new THREE.Color();

  // ── 狀態 ──
  const visible: Citizen[] = new Array(MAX_VISIBLE);
  const lastIds = new Int32Array(MAX_VISIBLE).fill(-1);
  const facing = new Map<number, FacingState>();
  let frame = 0;
  let elapsed = 0;

  const setMatrix = (
    target: InstancedSet,
    index: number,
    px: number,
    py: number,
    pz: number,
    rx: number,
    ry: number,
    rz: number,
    scale: number,
    scaleY = scale,
  ): void => {
    dummy.position.set(px, py, pz);
    dummy.rotation.set(rx, ry, rz);
    dummy.scale.set(scale, scaleY, scale);
    dummy.updateMatrix();
    target.mesh.setMatrixAt(index, dummy.matrix);
  };

  /** 依實際移動量決定朝向（靜止者沿用上次朝向） */
  const computeYaw = (citizen: Citizen, wx: number, wz: number): number => {
    let f = facing.get(citizen.id);
    if (!f) {
      f = { x: wx, y: wz, yaw: citizen.look * Math.PI * 2, touch: frame };
      facing.set(citizen.id, f);
      return f.yaw;
    }
    const dx = wx - f.x;
    const dz = wz - f.y;
    if (dx * dx + dz * dz > 1e-5) {
      const target = Math.atan2(dx, dz);
      f.yaw = lerpAngle(f.yaw, target, 0.35);
    }
    f.x = wx;
    f.y = wz;
    f.touch = frame;
    return f.yaw;
  };

  const update = (s: GameState, dt: number): void => {
    elapsed += dt;
    frame++;

    const halfW = (s.width * TILE) / 2;
    const halfH = (s.height * TILE) / 2;
    const byId = new Map<number, Building>();
    for (const b of s.buildings) byId.set(b.id, b);

    // ── 收集可見市民（在家者不畫） ──
    let count = 0;
    for (const citizen of s.citizens) {
      if (citizen.state === 'home') continue;
      if (count >= MAX_VISIBLE) break;
      visible[count++] = citizen;
    }

    let colorsDirty = false;

    for (let i = 0; i < count; i++) {
      const citizen = visible[i];
      const building =
        citizen.state === 'working' || citizen.state === 'shopping' ? byId.get(citizen.targetId) : undefined;

      let wx: number;
      let wz: number;
      let ground: number;
      if (building) {
        const centerX = (building.x + building.w / 2) * TILE - halfW;
        const centerZ = (building.y + building.h / 2) * TILE - halfH;
        const angle = citizen.look * Math.PI * 2 + citizen.id * 0.37;
        const radius = TILE * (0.22 + 0.24 * Math.min(building.w, building.h));
        const wobble = Math.sin(elapsed * 0.9 + citizen.look * 9) * 0.08;
        wx = centerX + Math.cos(angle) * (radius + wobble);
        wz = centerZ + Math.sin(angle) * (radius + wobble);
        ground = groundYForTile(s, Math.floor(building.x + building.w / 2), Math.floor(building.y + building.h / 2));
      } else {
        wx = citizen.x * TILE - halfW;
        wz = citizen.y * TILE - halfH;
        ground = groundYForTile(s, Math.floor(citizen.x), Math.floor(citizen.y));
        // 同格內以 look 種子做微小偏移，避免市民完全重疊（docs/GAME_DESIGN.md §4.4）
        wx += (citizen.look - 0.5) * 0.42;
        wz += (((citizen.look * 7919) % 1) - 0.5) * 0.42;
      }

      const walking = citizen.state === 'walking';
      const yaw = computeYaw(citizen, wx, wz);
      const phase = elapsed * 8.5 + citizen.look * 6.283;
      const stride = walking ? Math.sin(phase) : 0;
      const sway = walking ? stride * 0.05 : Math.sin(elapsed * 1.6 + citizen.look * 5) * 0.012;
      const bob = walking ? Math.abs(Math.sin(phase)) * 0.055 : Math.sin(elapsed * 1.8 + citizen.look * 5) * 0.012;
      const ageScale = citizen.age < 14 ? 0.62 : citizen.age < 17 ? 0.86 : 1;
      const scale = ageScale * (0.92 + citizen.look * 0.16);
      const baseY = ground + bob;
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);

      // 身體（長衫）
      setMatrix(body, i, wx, baseY + 0.44 * scale, wz, walking ? 0.07 : 0, yaw, sway, scale);
      // 腰帶
      setMatrix(sash, i, wx, baseY + 0.3 * scale, wz, 0, yaw, 0, scale);
      // 頭
      setMatrix(head, i, wx, baseY + 0.88 * scale, wz, 0, yaw, 0, scale);
      // 斗笠
      setMatrix(hat, i, wx, baseY + 1.02 * scale, wz, walking ? -0.04 : 0, yaw, 0, scale);

      // 手臂（前後擺動）
      const armSwing = stride * 0.6;
      const shoulderY = baseY + 0.66 * scale;
      const armDrop = 0.14 * scale;
      setMatrix(
        armL,
        i,
        wx + rightX * 0.205 * scale - forwardX * (armSwing * 0.12 * scale),
        shoulderY - armDrop,
        wz + rightZ * 0.205 * scale - forwardZ * (armSwing * 0.12 * scale),
        armSwing,
        yaw,
        -0.16,
        scale,
      );
      setMatrix(
        armR,
        i,
        wx - rightX * 0.205 * scale + forwardX * (armSwing * 0.12 * scale),
        shoulderY - armDrop,
        wz - rightZ * 0.205 * scale + forwardZ * (armSwing * 0.12 * scale),
        -armSwing,
        yaw,
        0.16,
        scale,
      );

      // 雙腳（走路時前後擺）
      const footY = baseY + 0.1 * scale;
      const stepReach = stride * 0.13 * scale;
      setMatrix(
        footL,
        i,
        wx + rightX * 0.11 * scale + forwardX * stepReach,
        footY,
        wz + rightZ * 0.11 * scale + forwardZ * stepReach,
        stride * 0.55,
        yaw,
        0,
        scale,
      );
      setMatrix(
        footR,
        i,
        wx - rightX * 0.11 * scale - forwardX * stepReach,
        footY,
        wz - rightZ * 0.11 * scale - forwardZ * stepReach,
        -stride * 0.55,
        yaw,
        0,
        scale,
      );

      // 顏色（只在 instance 對應的市民改變時更新）
      if (lastIds[i] !== citizen.id) {
        lastIds[i] = citizen.id;
        colorsDirty = true;
        const robeHex = ROBE_COLORS[Math.floor(citizen.look * ROBE_COLORS.length) % ROBE_COLORS.length];
        color.setHex(robeHex).multiplyScalar(0.86 + citizen.look * 0.26);
        body.mesh.setColorAt(i, color);
        const skin = SKIN_COLORS[Math.floor(citizen.look * 97) % SKIN_COLORS.length];
        color.setHex(skin);
        head.mesh.setColorAt(i, color);
        color.setHex(HAT_COLOR).multiplyScalar(0.9 + ((citizen.look * 13) % 1) * 0.2);
        hat.mesh.setColorAt(i, color);
        color.setHex(SASH_COLORS[Math.floor(citizen.look * 31) % SASH_COLORS.length]);
        sash.mesh.setColorAt(i, color);
      }
    }

    body.mesh.count = count;
    head.mesh.count = count;
    hat.mesh.count = count;
    sash.mesh.count = count;
    armL.mesh.count = count;
    armR.mesh.count = count;
    footL.mesh.count = count;
    footR.mesh.count = count;

    if (colorsDirty) {
      for (const set of [body, head, hat, sash]) {
        if (set.mesh.instanceColor) set.mesh.instanceColor.needsUpdate = true;
      }
    }

    // ── 搬運工與馬車 ──
    const cartCount = Math.min(s.carts.length, MAX_CARTS);
    cartBed.mesh.count = cartCount;
    wheels.mesh.count = cartCount * 2;
    cargo.mesh.count = cartCount * 3;
    porterBody.mesh.count = cartCount;
    porterHead.mesh.count = cartCount;
    porterHat.mesh.count = cartCount;

    for (let i = 0; i < cartCount; i++) {
      const cart = s.carts[i];
      const wx = (cart.x + 0.5) * TILE - halfW;
      const wz = (cart.y + 0.5) * TILE - halfH;
      const ground = groundYForTile(s, Math.floor(cart.x), Math.floor(cart.y));
      const yaw = cartYaw(cart, s);
      const forwardX = Math.sin(yaw);
      const forwardZ = Math.cos(yaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const spin = (cart.pathProgress || 0) * 2.4 + elapsed * 0.4;

      setMatrix(cartBed, i, wx, ground + 0.36, wz, 0, yaw, 0, 1);
      setMatrix(wheels, i * 2, wx + rightX * 0.36, ground + 0.18, wz + rightZ * 0.36, spin, yaw, 0, 1);
      setMatrix(wheels, i * 2 + 1, wx - rightX * 0.36, ground + 0.18, wz - rightZ * 0.36, spin, yaw, 0, 1);

      // 貨箱（依 amount 顯示 1~3 箱，顏色隨資源）
      const boxes = Math.max(1, Math.min(3, Math.ceil((cart.amount || 1) / 10)));
      const baseHex = RESOURCES[cart.resource]?.color ? parseInt(RESOURCES[cart.resource].color.slice(1), 16) : 0x8a6a45;
      for (let slot = 0; slot < 3; slot++) {
        const idx = i * 3 + slot;
        if (slot < boxes) {
          const offsets = [
            { x: -0.28, y: 0.56, z: 0 },
            { x: 0.28, y: 0.56, z: 0 },
            { x: 0.0, y: 0.56, z: 0 },
          ];
          const o = offsets[slot];
          setMatrix(
            cargo,
            idx,
            wx + rightX * o.x + forwardX * o.z,
            ground + o.y,
            wz + rightZ * o.x + forwardZ * o.z,
            0,
            yaw,
            0,
            slot === 2 ? 0.8 : 1,
          );
          color.setHex(baseHex).multiplyScalar(0.85 + slot * 0.08);
          cargo.mesh.setColorAt(idx, color);
        } else {
          setMatrix(cargo, idx, 0, -10, 0, 0, 0, 0, 0.0001);
        }
      }
      if (cargo.mesh.instanceColor) cargo.mesh.instanceColor.needsUpdate = true;

      // 拉車人（車前）
      const porterScale = 0.95 + ((cart.id * 37) % 10) * 0.01;
      const porterYaw = yaw;
      setMatrix(porterBody, i, wx + forwardX * 0.82, ground + 0.44 * porterScale, wz + forwardZ * 0.82, 0.08, porterYaw, 0, porterScale);
      setMatrix(porterHead, i, wx + forwardX * 0.82, ground + 0.88 * porterScale, wz + forwardZ * 0.82, 0, porterYaw, 0, porterScale);
      setMatrix(porterHat, i, wx + forwardX * 0.82, ground + 1.02 * porterScale, wz + forwardZ * 0.82, 0, porterYaw, 0, porterScale);
      color.setHex(ROBE_COLORS[(cart.id * 7) % ROBE_COLORS.length]);
      porterBody.mesh.setColorAt(i, color);
      color.setHex(SKIN_COLORS[(cart.id * 3) % SKIN_COLORS.length]);
      porterHead.mesh.setColorAt(i, color);
      color.setHex(HAT_COLOR);
      porterHat.mesh.setColorAt(i, color);
    }
    for (const set of [porterBody, porterHead, porterHat]) {
      if (set.mesh.instanceColor) set.mesh.instanceColor.needsUpdate = true;
    }

    // 上傳矩陣
    for (const set of [body, head, hat, sash, armL, armR, footL, footR, cartBed, cargo, wheels, porterBody, porterHead, porterHat]) {
      set.mesh.instanceMatrix.needsUpdate = true;
    }

    // 偶爾清理朝向暫存
    if (frame % 300 === 0) {
      for (const [id, f] of facing) {
        if (frame - f.touch > 180) facing.delete(id);
      }
    }
  };

  update(state, 0);

  return {
    group,
    update,
    dispose(): void {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      for (const set of [
        body, head, hat, sash, armL, armR, footL, footR,
        porterBody, porterHead, porterHat, cartBed, cargo, wheels,
      ]) {
        geometries.add(set.geometry);
        materials.add(set.material);
        set.mesh.dispose();
      }
      for (const geo of geometries) geo.dispose();
      for (const mat of materials) mat.dispose();
      facing.clear();
      group.clear();
    },
  };
}

/** 馬車朝向：優先看路徑下一段，其次由 pathProgress 進退方向 */
function cartYaw(cart: GameState['carts'][number], state: GameState): number {
  const path = cart.path;
  if (path && path.length >= 2) {
    const raw = Math.floor(cart.pathProgress || 0);
    const index = Math.min(Math.max(0, raw), path.length - 2);
    const a = path[index];
    const b = path[index + 1];
    const ax = a % state.width;
    const ay = Math.floor(a / state.width);
    const bx = b % state.width;
    const by = Math.floor(b / state.width);
    if (ax !== bx || ay !== by) return Math.atan2(bx - ax, by - ay);
  }
  // 由起訖建築位置推方向
  const from = state.buildings.find((b) => b.id === cart.fromId);
  const to = state.buildings.find((b) => b.id === cart.toId);
  if (from && to) {
    const f = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
    const t = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
    if (Math.abs(t.x - f.x) + Math.abs(t.y - f.y) > 0.01) return Math.atan2(t.x - f.x, t.y - f.y);
  }
  void BUILDINGS;
  return 0;
}
