/**
 * 低多邊形世界道具幾何與程序化貼圖（world-renderer 私有模組）。
 *
 * 所有幾何皆為共用（每種道具僅建立一次，交給 InstancedMesh 重複使用），
 * 貼圖以 canvas 程序化生成（不依賴外部資源、離線可用）。
 * 幾何使用頂點色 + instanceColor 相乘，可在 InstancedMesh 中做出色彩變化。
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

// ─────────────────────────── 幾何工具 ───────────────────────────

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

function trs(
  px: number,
  py: number,
  pz: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  _v.set(px, py, pz);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v, _q, _s);
}

/** 把幾何轉為非索引、寫入頂點色，並套用變換 */
function paint(
  geo: THREE.BufferGeometry,
  color: number,
  matrix?: THREE.Matrix4,
  jitter = 0.07,
): THREE.BufferGeometry {
  if (matrix) geo.applyMatrix4(matrix);
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const pos = g.getAttribute('position');
  const count = pos.count;
  const base = new THREE.Color(color);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // 以頂點序號做穩定的細微明暗抖動，避免死板色塊
    const n = Math.sin((i + 1) * 12.9898 + color * 0.000013) * 43758.5453;
    const f = 1 + ((n - Math.floor(n)) * 2 - 1) * jitter;
    colors[i * 3] = base.r * f;
    colors[i * 3 + 1] = base.g * f;
    colors[i * 3 + 2] = base.b * f;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** 合併多個（已含 position/normal/color 的）幾何 */
export function mergeColoredGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const p of parts) total += p.getAttribute('position').count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let offset = 0;
  for (const p of parts) {
    const pPos = p.getAttribute('position') as THREE.BufferAttribute;
    const pNor = p.getAttribute('normal') as THREE.BufferAttribute;
    const pCol = p.getAttribute('color') as THREE.BufferAttribute;
    position.set(pPos.array as Float32Array, offset * 3);
    normal.set(pNor.array as Float32Array, offset * 3);
    color.set(pCol.array as Float32Array, offset * 3);
    offset += pPos.count;
    p.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** 依幾何高度寫入 aSway（0=根部不動、1=頂端最大），供風吹頂點動畫 */
export function addSwayAttribute(geo: THREE.BufferGeometry, power = 1.6): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  let maxY = 0.0001;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > maxY) maxY = pos.getY(i);
  const sway = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const v = Math.min(1, Math.max(0, pos.getY(i) / maxY));
    sway[i] = Math.pow(v, power);
  }
  geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  return geo;
}

// ─────────────────────────── 風吹葉動材質 ───────────────────────────

export interface WindMaterial {
  material: THREE.MeshLambertMaterial;
  time: { value: number };
  wind: { value: number };
}

/** 樹木花草共用材質：頂點色 + 逐實例色 + 風吹擺動（頂點 shader 注入）。 */
export function createWindMaterial(flatShading = true): WindMaterial {
  const time = { value: 0 };
  const wind = { value: 0.5 };
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uWind = wind;
    shader.vertexShader =
      'attribute float aSway;\nattribute float aPhase;\nuniform float uTime;\nuniform float uWind;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float swayK = aSway * aSway;
        float ph = aPhase * 6.2831853;
        transformed.x += sin(uTime * 1.6 + ph) * swayK * uWind * 0.13;
        transformed.z += cos(uTime * 1.25 + ph * 1.37) * swayK * uWind * 0.1;`,
      );
  };
  material.customProgramCacheKey = () => 'huaxia-wind-v1';
  return { material, time, wind };
}

/** 給 InstancedMesh 幾何加上逐實例的相位屬性（配合風吹材質） */
export function addInstancePhase(geo: THREE.BufferGeometry, count: number, seed = 1): void {
  const rng = mulberry32(seed);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) phases[i] = rng() * 6.283;
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
}

// ─────────────────────────── 樹木幾何 ───────────────────────────

const TRUNK_DARK = 0x5a452f;
const TRUNK_LIGHT = 0x6d5538;

/** 松樹：圓錐塔狀，適合丘陵與山地 */
export function createPineGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.07, 0.13, 1.1, 5), TRUNK_DARK, trs(0, 0.55, 0)));
  const cones: [number, number, number, number][] = [
    [0.98, 1.05, 0.95, 0x37603c],
    [0.76, 0.95, 1.45, 0x3f6b42],
    [0.52, 0.85, 1.95, 0x4a7a49],
    [0.3, 0.65, 2.36, 0x568a50],
  ];
  for (const [r, h, y, c] of cones) {
    parts.push(paint(new THREE.ConeGeometry(r, h, 7), c, trs(0, y, 0, 0, 0.4, 0), 0.09));
  }
  return mergeColoredGeometries(parts);
}

/** 闊葉樹：樹冠由數個低多邊形球體組成 */
export function createBroadleafGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.09, 0.17, 1.2, 5), TRUNK_LIGHT, trs(0, 0.6, 0, 0, 0.3, 0.04)));
  const blobs: [number, number, number, number, number][] = [
    [0, 1.65, 0, 0.72, 0x4d7a42],
    [0.42, 1.42, 0.12, 0.52, 0x5d8a4a],
    [-0.38, 1.5, -0.18, 0.5, 0x3f6b3c],
    [0.05, 1.95, -0.05, 0.46, 0x669a52],
  ];
  for (const [x, y, z, r, c] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    parts.push(paint(g, c, trs(x, y, z, x, y * 3, z, 1, 0.86, 1), 0.1));
  }
  return mergeColoredGeometries(parts);
}

/** 花樹（春櫻／桃李）：樹冠偏粉白，春天最醒目 */
export function createBlossomGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.08, 0.15, 1.15, 5), 0x6a5140, trs(0, 0.58, 0, 0, 0.5, 0.05)));
  const blobs: [number, number, number, number, number][] = [
    [0, 1.55, 0, 0.66, 0xf2d8dc],
    [0.4, 1.34, 0.1, 0.46, 0xe8c2cc],
    [-0.34, 1.42, -0.14, 0.44, 0xf6e2e2],
    [0.04, 1.82, -0.04, 0.4, 0xfaeaea],
  ];
  for (const [x, y, z, r, c] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    parts.push(paint(g, c, trs(x, y, z, x, y * 3, z, 1, 0.8, 1), 0.08));
  }
  return mergeColoredGeometries(parts);
}

/** 柳樹：垂枝，適合水岸 */
export function createWillowGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.085, 0.15, 1.0, 5), 0x6a563c, trs(0, 0.5, 0, 0, 0.2, 0.06)));
  parts.push(paint(new THREE.IcosahedronGeometry(0.55, 0), 0x7fa653, trs(0, 1.35, 0, 0.1, 0.4, 0), 0.09));
  parts.push(paint(new THREE.IcosahedronGeometry(0.36, 0), 0x8fb45c, trs(0.3, 1.6, 0.08, 0.2, 1.1, 0), 0.09));
  parts.push(paint(new THREE.IcosahedronGeometry(0.32, 0), 0x76a04c, trs(-0.28, 1.55, -0.1, 0, 2.3, 0.1), 0.09));
  const fronds = 9;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2;
    const r = 0.42 + (i % 3) * 0.1;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const len = 0.6 + (i % 4) * 0.12;
    // 細而下垂的枝條
    parts.push(
      paint(
        new THREE.ConeGeometry(0.075, len, 4),
        i % 2 === 0 ? 0x94b45a : 0x86a64e,
        trs(x, 1.42 - len * 0.42, z, Math.PI, a, 0),
        0.1,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 竹叢 */
export function createBambooGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const stalks = 5;
  for (let i = 0; i < stalks; i++) {
    const a = (i / stalks) * Math.PI * 2 + 0.4;
    const r = 0.16 + (i % 2) * 0.14;
    const h = 2.1 + (i % 3) * 0.42;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    parts.push(
      paint(
        new THREE.CylinderGeometry(0.035, 0.05, h, 4),
        i % 2 === 0 ? 0x7d9848 : 0x8fa458,
        trs(x, h / 2, z, Math.sin(a) * 0.06, a, Math.cos(a) * 0.05),
        0.08,
      ),
    );
    // 竹葉：頂端小錐體
    parts.push(paint(new THREE.ConeGeometry(0.3, 0.5, 4), 0x6f8f3f, trs(x * 1.1, h - 0.1, z * 1.1, 0.2, a, 0)));
  }
  return mergeColoredGeometries(parts);
}

/** 低矮灌木 */
export function createShrubGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number, number][] = [
    [0, 0.22, 0, 0.3, 0x547a42],
    [0.22, 0.18, 0.1, 0.22, 0x628a4a],
    [-0.2, 0.16, -0.12, 0.2, 0x4a6e3c],
  ];
  for (const [x, y, z, r, c] of blobs) {
    parts.push(paint(new THREE.IcosahedronGeometry(r, 0), c, trs(x, y, z, x * 3, y * 5, z * 3, 1, 0.72, 1), 0.1));
  }
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 岩石／花草 ───────────────────────────

/** 山石：不規則多面體 */
export function createRockGeometry(seed = 7): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(0.6, 0);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const f = 0.72 + rng() * 0.5;
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.72, pos.getZ(i) * f);
  }
  geo.computeVertexNormals();
  const g = paint(geo, 0x7d7d74, trs(0, 0.22, 0, 0, 0.6, 0), 0.12);
  return g;
}

/** 小石堆 */
export function createPebblesGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.IcosahedronGeometry(0.2, 0), 0x8a8a80, trs(0, 0.08, 0, 0, 0.3, 0), 0.1));
  parts.push(paint(new THREE.IcosahedronGeometry(0.14, 0), 0x77776e, trs(0.26, 0.06, 0.1, 0, 1.3, 0), 0.1));
  parts.push(paint(new THREE.IcosahedronGeometry(0.11, 0), 0x9a988c, trs(-0.2, 0.05, 0.16, 0, 2.1, 0), 0.1));
  return mergeColoredGeometries(parts);
}

/** 草叢 */
export function createGrassTuftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blades = 4;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + 0.7;
    const tilt = 0.22 + (i % 2) * 0.14;
    parts.push(
      paint(
        new THREE.ConeGeometry(0.05, 0.42 + (i % 3) * 0.1, 3),
        i % 2 === 0 ? 0x6f9548 : 0x7fa452,
        trs(Math.cos(a) * 0.09, 0.2, Math.sin(a) * 0.09, Math.cos(a) * tilt, a, Math.sin(a) * tilt),
        0.1,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 野花（花頭接近白色，交給 instanceColor 上色） */
export function createFlowerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.014, 0.02, 0.28, 3), 0x5f8640, trs(0, 0.14, 0), 0.06));
  parts.push(paint(new THREE.IcosahedronGeometry(0.07, 0), 0xf0e6d0, trs(0, 0.31, 0), 0.12));
  parts.push(paint(new THREE.ConeGeometry(0.045, 0.09, 4), 0xd8c8a0, trs(0, 0.24, 0, 0.3, 0.6, 0), 0.1));
  return mergeColoredGeometries(parts);
}

/** 水邊蘆葦 */
export function createReedGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const h = 0.85 + (i % 3) * 0.22;
    parts.push(
      paint(
        new THREE.ConeGeometry(0.028, h, 3),
        i % 2 === 0 ? 0x9aa05a : 0x868f4a,
        trs(Math.cos(a) * 0.1, h / 2, Math.sin(a) * 0.1, Math.cos(a) * 0.16, a, Math.sin(a) * 0.16),
        0.08,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 荷葉（水面裝飾） */
export function createLotusPadGeometry(): THREE.BufferGeometry {
  const geo = new THREE.CircleGeometry(0.3, 6);
  const g = paint(geo, 0x5f8a4a, trs(0, 0.02, 0, -Math.PI / 2, 0.3, 0), 0.12);
  return g;
}

/** 田埂（梯田／水田邊界） */
export function createPaddyRidgeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(1, 0.06, 0.1), 0xa08c62, trs(0, 0.03, 0), 0.08));
  parts.push(paint(new THREE.BoxGeometry(1, 0.022, 0.14), 0x8a9a58, trs(0, 0.066, 0), 0.1));
  return mergeColoredGeometries(parts);
}

/** 稻草堆 */
export function createHaystackGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.34, 0.42, 0.3, 6), 0x9c8044, trs(0, 0.15, 0), 0.08));
  parts.push(paint(new THREE.ConeGeometry(0.42, 0.55, 6), 0xb5924e, trs(0, 0.55, 0, 0, 0.3, 0), 0.1));
  return mergeColoredGeometries(parts);
}

/** 烏篷船 */
export function createBoatGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // 船身
  parts.push(paint(new THREE.CylinderGeometry(0.16, 0.22, 1.9, 4), 0x5f4a33, trs(0, 0.1, 0, 0, Math.PI / 4, Math.PI / 2), 0.08));
  // 船篷
  parts.push(paint(new THREE.CylinderGeometry(0.24, 0.24, 0.8, 6, 1, false, 0, Math.PI), 0x2e2e2c, trs(0, 0.24, 0, 0, 0, Math.PI / 2), 0.06));
  // 艙板
  parts.push(paint(new THREE.BoxGeometry(1.5, 0.05, 0.3), 0x7a6244, trs(0, 0.16, 0), 0.05));
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 道路配件 ───────────────────────────

/** 河岸／橋樑欄杆（沿格邊的整段欄杆，木質） */
export function createRailingGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wood = 0x5c4530;
  const woodLight = 0x74583c;
  // 立柱
  parts.push(paint(new THREE.BoxGeometry(0.1, 0.42, 0.1), wood, trs(-0.88, 0.21, 0), 0.06));
  parts.push(paint(new THREE.BoxGeometry(0.1, 0.42, 0.1), wood, trs(0.88, 0.21, 0), 0.06));
  parts.push(paint(new THREE.BoxGeometry(0.08, 0.3, 0.08), woodLight, trs(0, 0.15, 0), 0.06));
  // 橫杆
  parts.push(paint(new THREE.BoxGeometry(1.9, 0.07, 0.09), woodLight, trs(0, 0.4, 0), 0.05));
  parts.push(paint(new THREE.BoxGeometry(1.86, 0.05, 0.06), wood, trs(0, 0.24, 0), 0.05));
  return mergeColoredGeometries(parts);
}

/** 交叉口中央的鋪石（八角石板） */
export function createIntersectionStoneGeometry(): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(0.36, 0.4, 0.03, 8), 0x767e84, trs(0, 0.016, 0, 0, Math.PI / 8, 0), 0.1);
}

/** 路緣石（一小段，由 InstancedMesh 沿邊排） */
export function createCurbGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(2.02, 0.07, 0.15), 0x8f948f, trs(0, 0.035, 0), 0.07));
  parts.push(paint(new THREE.BoxGeometry(2.02, 0.02, 0.17), 0xa4a8a2, trs(0, 0.075, 0), 0.05));
  return mergeColoredGeometries(parts);
}

/** 橋頭石墩 */
export function createBridgePostGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.BoxGeometry(0.22, 0.34, 0.22), 0x8a8f92, trs(0, 0.17, 0), 0.08));
  parts.push(paint(new THREE.BoxGeometry(0.3, 0.07, 0.3), 0x9aa0a2, trs(0, 0.36, 0), 0.06));
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 遠山剪影 ───────────────────────────

/** 近景岩峰：低矮不規則岩塊群（山地用，無雪冠；冬季由 instanceColor 提亮） */
export function createCragGeometry(seed = 21): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const rocks = 3;
  const colors = [0x8b887c, 0x817e72, 0x959287, 0x7d8169];
  for (let p = 0; p < rocks; p++) {
    const h = 0.75 + rng() * 0.55;
    const r = 0.85 + rng() * 0.45;
    const cone = new THREE.ConeGeometry(r, h, 6);
    const pos = cone.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const f = 0.72 + rng() * 0.52;
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i), pos.getZ(i) * f);
    }
    cone.computeVertexNormals();
    const ang = (p / rocks) * Math.PI * 2 + rng() * 0.8;
    const off = p === 0 ? 0 : 0.55 + rng() * 0.5;
    parts.push(
      paint(
        cone,
        colors[p % colors.length],
        trs(Math.cos(ang) * off, h * 0.5 - 0.05, Math.sin(ang) * off * 0.7, 0, rng() * Math.PI, 0, 1, 0.85 + rng() * 0.35, 1),
        0.1,
      ),
    );
  }
  return mergeColoredGeometries(parts);
}

/** 遠山／岩峰剪影：多個不規則錐體，山頂帶淡色雪冠 */
export function createMountainSilhouetteGeometry(seed = 3): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const peaks = 3;
  for (let p = 0; p < peaks; p++) {
    const h = 0.8 + rng() * 0.5;
    const cone = new THREE.ConeGeometry(1, h, 7);
    const pos = cone.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const f = 0.76 + rng() * 0.46;
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i), pos.getZ(i) * f);
    }
    cone.computeVertexNormals();
    const ang = rng() * Math.PI * 2;
    const off = p === 0 ? 0 : 0.75 + rng() * 0.5;
    const rock = p === 0 ? 0x93948a : p % 2 === 0 ? 0x888a80 : 0x9c9d92;
    const baseY = 0.5 + rng() * 0.1;
    const px = Math.cos(ang) * off;
    const pz = Math.sin(ang) * off * 0.4;
    parts.push(paint(cone, rock, trs(px, baseY, pz, 0, rng() * Math.PI, 0, 1, 0.95 + rng() * 0.25, 1), 0.1));
    // 雪冠：疊在山頂的小錐
    const cap = new THREE.ConeGeometry(0.42 * (0.9 + rng() * 0.2), h * 0.34, 7);
    parts.push(
      paint(cap, 0xdfe4e2, trs(px, baseY + h * 0.33, pz, 0, rng() * Math.PI, 0, 1, 0.9, 1), 0.06),
    );
  }
  return mergeColoredGeometries(parts);
}

// ─────────────────────────── 程序化貼圖 ───────────────────────────

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** 青石板路面貼圖（一張 = 一格，3x3 大塊不規則青石板） */
export function createStoneTexture(): THREE.Texture | null {
  const c = makeCanvas(192, 192);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(20261018);
  ctx.fillStyle = '#5c666e';
  ctx.fillRect(0, 0, 192, 192);
  const n = 3;
  const cell = 192 / n;
  const shades = ['#8e99a2', '#848f98', '#98a3ab', '#8a959e', '#7f8a93', '#929da5'];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const pad = 3 + rng() * 2;
      const bx = x * cell + pad + (rng() - 0.5) * 2;
      const by = y * cell + pad + (rng() - 0.5) * 2;
      const bw = cell - pad * 2 - 1;
      const bh = cell - pad * 2 - 1;
      ctx.fillStyle = shades[Math.floor(rng() * shades.length)];
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 4 + rng() * 3);
      ctx.fill();
      // 石面亮邊（左上）與暗邊（右下）製造淺浮雕感
      ctx.strokeStyle = 'rgba(228,236,240,0.4)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(bx + 3, by + bh - 3);
      ctx.lineTo(bx + 3, by + 3);
      ctx.lineTo(bx + bw - 3, by + 3);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(52,60,66,0.35)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(bx + bw - 3, by + 3);
      ctx.lineTo(bx + bw - 3, by + bh - 3);
      ctx.lineTo(bx + 3, by + bh - 3);
      ctx.stroke();
      // 斑點與風化
      for (let sd = 0; sd < 6; sd++) {
        ctx.fillStyle = rng() < 0.5 ? 'rgba(58,66,72,0.2)' : 'rgba(232,238,240,0.16)';
        ctx.fillRect(bx + 4 + rng() * (bw - 8), by + 4 + rng() * (bh - 8), 1.5 + rng() * 2.5, 1.5 + rng() * 2.5);
      }
      if (rng() < 0.18) {
        ctx.fillStyle = 'rgba(118,138,100,0.14)';
        ctx.beginPath();
        ctx.arc(bx + rng() * bw, by + rng() * bh, 3 + rng() * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return toTexture(c.canvas);
}

/** 木板橋面貼圖 */
export function createPlankTexture(): THREE.Texture | null {
  const c = makeCanvas(128, 128);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(7788);
  const planks = 6;
  const ph = 128 / planks;
  ctx.fillStyle = '#4a3826';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < planks; i++) {
    // 以褐色為基底，逐塊微調明暗（分量各自抖動，避免色相跳動）
    const base = 0.82 + rng() * 0.26;
    const r = Math.min(255, Math.round(0x8a * base));
    const g = Math.min(255, Math.round(0x66 * base));
    const b = Math.min(255, Math.round(0x42 * base));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, i * ph + 1, 128, ph - 2);
    // 板縫亮邊
    ctx.fillStyle = 'rgba(210,190,160,0.12)';
    ctx.fillRect(0, i * ph + 1, 128, 1);
    ctx.strokeStyle = 'rgba(30,22,14,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, i * ph);
    ctx.lineTo(128, i * ph);
    ctx.stroke();
    // 木紋
    for (let k = 0; k < 3; k++) {
      ctx.strokeStyle = 'rgba(40,30,18,0.22)';
      ctx.lineWidth = 1;
      const yy = i * ph + 3 + rng() * (ph - 6);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.bezierCurveTo(40, yy + (rng() - 0.5) * 4, 80, yy + (rng() - 0.5) * 4, 128, yy);
      ctx.stroke();
    }
  }
  return toTexture(c.canvas);
}

/** 地面細碎噪點（乘在 instanceColor 上，增加草地細節） */
export function createGroundSpeckleTexture(): THREE.Texture | null {
  const c = makeCanvas(64, 64);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(4242);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 520; i++) {
    const v = 200 + Math.floor(rng() * 45);
    ctx.fillStyle = `rgba(${v},${v + 6},${v - 6},${0.25 + rng() * 0.5})`;
    ctx.fillRect(Math.floor(rng() * 64), Math.floor(rng() * 64), 1 + rng() * 2, 1 + rng() * 2);
  }
  return toTexture(c.canvas);
}

/** 雲朵貼圖（用於遠景 Sprite） */
export function createCloudTexture(seed = 5): THREE.Texture | null {
  const c = makeCanvas(256, 128);
  if (!c) return null;
  const { ctx } = c;
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, 256, 128);
  for (let i = 0; i < 16; i++) {
    const x = 40 + rng() * 176;
    const y = 48 + (rng() - 0.5) * 34;
    const r = 18 + rng() * 34;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${0.22 + rng() * 0.2})`);
    grad.addColorStop(0.6, `rgba(250,252,255,${0.12 + rng() * 0.1})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
