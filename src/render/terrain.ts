/**
 * 地形渲染：低多邊形中式田園山水。
 *
 * 分層：
 *  1. 地基（泥土側面）＋ 地表（逐格顏色）——兩個 InstancedMesh 畫滿 72x72。
 *  2. 斷崖／土坎：相鄰地塊高差處自動生成岩壁，形成梯田與山谷層次。
 *  3. 水面：合併幾何 + 自訂 ShaderMaterial（波紋、日光／月光反射、雨漣漪、結冰、霧）。
 *  4. 植被：松、闊葉、柳、竹、花樹（吹風擺動）、灌木、草叢、野花、蘆葦、荷葉。
 *  5. 山石：丘陵碎石、山地岩峰；外圍遠山剪影。
 *  6. 田園細節：水田埂、水田反光、稻草堆、烏篷船。
 *
 * 效能：全部物件共用幾何／材質並以 InstancedMesh 繪製（總 draw call ~25），
 * 每幀只更新 shader uniform；季節／積雪／佔用（道路與建築）變更時才重寫實例顏色／矩陣。
 */

import * as THREE from 'three';
import { hash2d } from '../core/rng';
import type { GameState, Season, TerrainType, Tile } from '../core/types';
import { TILE, tileWorld } from './coords';
import {
  addInstancePhase,
  addSwayAttribute,
  createBambooGeometry,
  createBlossomGeometry,
  createBoatGeometry,
  createCragGeometry,
  createBroadleafGeometry,
  createFlowerGeometry,
  createGrassTuftGeometry,
  createGroundSpeckleTexture,
  createHaystackGeometry,
  createLotusPadGeometry,
  createMountainSilhouetteGeometry,
  createPaddyRidgeGeometry,
  createPebblesGeometry,
  createPineGeometry,
  createReedGeometry,
  createRockGeometry,
  createShrubGeometry,
  createWillowGeometry,
  type WindMaterial,
  createWindMaterial,
} from './world-geometry';
import {
  computeMoonDir,
  computeSun,
  createSeasonColors,
  createSkyPalette,
  createSunState,
  fogRange,
  sampleSkyPalette,
  seasonColors,
  snowCover,
  tileTopY,
  WATER_SURFACE_Y,
  windStrength,
  type SeasonColors,
  type SunState,
} from './world-utils';

export interface TerrainView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

// ─────────────────────────── 小工具 ───────────────────────────

const WHITE = new THREE.Color(0xffffff);
const SNOW_TINT = new THREE.Color(1.62, 1.66, 1.7);
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _sunDir = new THREE.Vector3();
const _moonDir = new THREE.Vector3();

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hash(x: number, y: number, salt: number): number {
  return hash2d(x, y, salt);
}

/** 單一實例的擺放資料 */
interface Placement {
  tile: number;
  x: number;
  y: number;
  z: number;
  rot: number;
  sx: number;
  sy: number;
  sz: number;
  hash: number;
  /** 選用的固定色（岩壁等依地形上色） */
  tint?: number;
}

function place(tile: number, x: number, y: number, z: number, rot: number, s: number, hashValue: number, sy = s): Placement {
  return { tile, x, y, z, rot, sx: s, sy, sz: s, hash: hashValue };
}

type TintKind =
  | 'evergreen'
  | 'deciduous'
  | 'willow'
  | 'blossom'
  | 'shrub'
  | 'grass'
  | 'flower'
  | 'reed'
  | 'lotus'
  | 'rock'
  | 'ridge'
  | 'haystack'
  | 'distant'
  | 'crag';

interface TintableLayer {
  mesh: THREE.InstancedMesh;
  list: Placement[];
  kind: TintKind;
  /** 是否受道路／建築佔用影響（藏起被覆蓋的道具） */
  occupancy: boolean;
  /** 原始矩陣（用於佔用還原） */
  matrixBase: Float32Array | null;
}

// ─────────────────────────── 水面色階 ───────────────────────────

const WATER_DEEP: Record<Season, number> = {
  spring: 0x245d7c,
  summer: 0x215876,
  autumn: 0x285a72,
  winter: 0x36546c,
};
const WATER_SHALLOW: Record<Season, number> = {
  spring: 0x5e9aa2,
  summer: 0x659f9c,
  autumn: 0x6d9a92,
  winter: 0x86a4b0,
};

// ─────────────────────────── 主體 ───────────────────────────

export function createTerrainView(state: GameState): TerrainView {
  const group = new THREE.Group();
  group.name = 'terrain';

  const { width, height } = state;
  const count = state.tiles.length;
  const halfW = (width * TILE) / 2;
  const halfH = (height * TILE) / 2;
  const seed = state.seed >>> 0;

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  // 季節色
  const seasonC = createSeasonColors();
  let paletteSeason: Season = state.clock.season;
  seasonColors(paletteSeason, seasonC);
  let appliedSnow = -1;

  // 判斷「是否臨水」與水深
  const waterNear = new Uint8Array(count); // 1 = 陸地且 8 鄰域有水
  const waterDepth = new Uint8Array(count); // 1..4，水域離岸距離
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (state.tiles[i].terrain === 'water') continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (state.tiles[ny * width + nx].terrain === 'water') {
            waterNear[i] = 1;
            break;
          }
        }
        if (waterNear[i]) break;
      }
    }
  }
  {
    // 水深：從岸邊往水域內 BFS
    const queue: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (state.tiles[i].terrain !== 'water') continue;
        let shore = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        for (let dy = -1; dy <= 1 && !shore; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (state.tiles[ny * width + nx].terrain !== 'water') {
              shore = true;
              break;
            }
          }
        }
        if (shore) {
          waterDepth[i] = 1;
          queue.push(i);
        }
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const d = waterDepth[i];
      if (d >= 4) continue;
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (state.tiles[ni].terrain !== 'water' || waterDepth[ni] !== 0) continue;
          waterDepth[ni] = d + 1;
          queue.push(ni);
        }
      }
    }
  }

  // ───────────── 1. 地基與地表 ─────────────

  const topY = new Float32Array(count);
  for (let i = 0; i < count; i++) topY[i] = tileTopY(state.tiles[i]);

  const groundTexture = createGroundSpeckleTexture();
  if (groundTexture) track(groundTexture);

  const foundationGeo = track(new THREE.BoxGeometry(TILE * 0.995, 1, TILE * 0.995));
  foundationGeo.translate(0, 0.5, 0);
  const foundationMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const foundationMesh = new THREE.InstancedMesh(foundationGeo, foundationMat, count);
  foundationMesh.name = 'terrain-foundation';
  foundationMesh.receiveShadow = true;
  foundationMesh.frustumCulled = false;
  track(foundationMesh);
  group.add(foundationMesh);

  const topGeo = track(new THREE.PlaneGeometry(TILE * 1.001, TILE * 1.001));
  topGeo.rotateX(-Math.PI / 2);
  const topMat = track(
    new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: groundTexture ?? undefined,
    }),
  );
  const topMesh = new THREE.InstancedMesh(topGeo, topMat, count);
  topMesh.name = 'terrain-top';
  topMesh.receiveShadow = true;
  topMesh.frustumCulled = false;
  track(topMesh);
  group.add(topMesh);

  // ───────────── 2. 斷崖／土坎 ─────────────

  const cliffGeo = track(new THREE.BoxGeometry(1, 1, 1));
  cliffGeo.translate(0, 0.5, 0);
  const cliffMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const cliffPlacements: Placement[] = [];
  const dirs: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0], // 東、西、南
    [0, -1, 0], // 北
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tile = state.tiles[i];
      const myTop = topY[i];
      const { x: wx, z: wz } = tileWorld(x, y, width, height);
      for (const [dx, dz] of dirs.map((d) => [d[0], d[1]] as [number, number])) {
        const nx = x + dx;
        const ny = y + dz;
        const neighborTop =
          nx < 0 || ny < 0 || nx >= width || ny >= height
            ? -0.4
            : topY[ny * width + nx];
        const isWaterNeighbor = nx < 0 || ny < 0 || nx >= width || ny >= height
          ? false
          : state.tiles[ny * width + nx].terrain === 'water';
        const minTop = isWaterNeighbor ? WATER_SURFACE_Y - 0.06 : neighborTop;
        const diff = myTop - minTop;
        if (diff < 0.045) continue;
        const px = wx + dx * (TILE / 2 - 0.02);
        const pz = wz + dz * (TILE / 2 - 0.02);
        const alongX = dz === 0;
        const base = Math.floor(hash(x, y, seed + 411 + (dx + 2) * 7 + (dz + 2) * 13) * 3);
        const wallTint = isWaterNeighbor
          ? tile.terrain === 'sand'
            ? 0xa08c60
            : 0x6f6044
          : tile.terrain === 'mountain'
            ? 0x6e695f
            : tile.terrain === 'hill'
              ? 0x77694d
              : tile.terrain === 'sand'
                ? 0xa08e64
                : tile.terrain === 'forest'
                  ? 0x514a33
                  : tile.terrain === 'fertile'
                    ? 0x5f5038
                    : 0x615634;
        if (alongX) {
          cliffPlacements.push({
            tile: i,
            x: px,
            y: minTop,
            z: pz,
            rot: 0,
            sx: 0.2,
            sy: diff + 0.02,
            sz: TILE,
            hash: base,
            tint: wallTint,
          });
        } else {
          cliffPlacements.push({
            tile: i,
            x: px,
            y: minTop,
            z: pz,
            rot: Math.PI / 2,
            sx: 0.2,
            sy: diff + 0.02,
            sz: TILE,
            hash: base,
            tint: wallTint,
          });
        }
      }
    }
  }

  const cliffMesh = new THREE.InstancedMesh(cliffGeo, cliffMat, Math.max(1, cliffPlacements.length));
  cliffMesh.name = 'terrain-cliffs';
  cliffMesh.castShadow = false;
  cliffMesh.receiveShadow = true;
  cliffMesh.frustumCulled = false;
  cliffMesh.count = cliffPlacements.length;
  cliffMesh.visible = cliffPlacements.length > 0;
  track(cliffMesh);
  group.add(cliffMesh);
  {
    const dummy = new THREE.Object3D();
    const c = new THREE.Color();
    cliffPlacements.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.set(p.sx, p.sy, p.sz);
      dummy.updateMatrix();
      cliffMesh.setMatrixAt(i, dummy.matrix);
      // 岩壁：依地形上色，稍微隨機
      c.setHex(p.tint ?? 0x6e6252).multiplyScalar(0.82 + p.hash * 0.16);
      cliffMesh.setColorAt(i, c);
    });
    cliffMesh.instanceMatrix.needsUpdate = true;
    if (cliffMesh.instanceColor) cliffMesh.instanceColor.needsUpdate = true;
  }

  // ───────────── 3. 水面 ─────────────

  const waterPositions: number[] = [];
  const waterDeep: number[] = [];
  const waterIndices: number[] = [];
  const waterTiles: number[] = [];
  const WATER_SUB = 2;
  const depthAt = (tx: number, ty: number): number => {
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return 0;
    const ti = ty * width + tx;
    return state.tiles[ti].terrain === 'water' ? clamp01(waterDepth[ti] / 3) : 0;
  };
  const sampleDepth = (fx: number, fy: number): number => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const u = fx - x0;
    const v = fy - y0;
    const d00 = depthAt(x0, y0);
    const d10 = depthAt(x0 + 1, y0);
    const d01 = depthAt(x0, y0 + 1);
    const d11 = depthAt(x0 + 1, y0 + 1);
    return clamp01((d00 * (1 - u) + d10 * u) * (1 - v) + (d01 * (1 - u) + d11 * u) * v);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (state.tiles[i].terrain !== 'water') continue;
      waterTiles.push(i);
      const { x: wx, z: wz } = tileWorld(x, y, width, height);
      const base = waterPositions.length / 3;
      for (let gy = 0; gy <= WATER_SUB; gy++) {
        for (let gx = 0; gx <= WATER_SUB; gx++) {
          waterPositions.push(
            wx - TILE / 2 + (gx / WATER_SUB) * TILE,
            WATER_SURFACE_Y,
            wz - TILE / 2 + (gy / WATER_SUB) * TILE,
          );
          waterDeep.push(sampleDepth(x + gx / WATER_SUB, y + gy / WATER_SUB));
        }
      }
      const row = WATER_SUB + 1;
      for (let gy = 0; gy < WATER_SUB; gy++) {
        for (let gx = 0; gx < WATER_SUB; gx++) {
          const a = base + gy * row + gx;
          const b = a + 1;
          const c = a + row;
          const d = c + 1;
          waterIndices.push(a, c, b, b, c, d);
        }
      }
    }
  }

  const waterGeo = track(new THREE.BufferGeometry());
  waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(waterPositions, 3));
  waterGeo.setAttribute('aDeep', new THREE.Float32BufferAttribute(waterDeep, 1));
  waterGeo.setIndex(waterIndices);
  waterGeo.computeBoundingSphere();

  const waterUniforms = {
    uTime: { value: 0 },
    uWave: { value: 0.02 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uSunColor: { value: new THREE.Color(0xfff0cf) },
    uSkyColor: { value: new THREE.Color(0x9ec8e8) },
    uHorizonColor: { value: new THREE.Color(0xd6e6dc) },
    uDeepColor: { value: new THREE.Color(WATER_DEEP.spring) },
    uShallowColor: { value: new THREE.Color(WATER_SHALLOW.spring) },
    uDaylight: { value: 1 },
    uIce: { value: 0 },
    uRain: { value: 0 },
    uFogColor: { value: new THREE.Color(0xc8dce8) },
    uFogNear: { value: 90 },
    uFogFar: { value: 340 },
  };

  const waterMat = track(
    new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uWave;
        attribute float aDeep;
        varying float vDeep;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        void main() {
          vec3 p = position;
          float t = uTime;
          float w1 = sin(p.x * 1.6 + t * 1.3) * cos(p.z * 1.2 - t * 0.9);
          float w2 = sin((p.x + p.z) * 2.9 + t * 2.1);
          float h = (w1 * 0.7 + w2 * 0.3) * uWave;
          p.y += h;
          float dx1 = 1.6 * cos(p.x * 1.6 + t * 1.3) * cos(p.z * 1.2 - t * 0.9);
          float dz1 = -1.2 * sin(p.x * 1.6 + t * 1.3) * sin(p.z * 1.2 - t * 0.9);
          float dx2 = 2.9 * cos((p.x + p.z) * 2.9 + t * 2.1);
          float dhx = (dx1 * 0.7 + dx2 * 0.3) * uWave;
          float dhz = (dz1 * 0.7 + dx2 * 0.3) * uWave;
          vNormalW = normalize(vec3(-dhx, 1.0, -dhz));
          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          vDeep = aDeep;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uSkyColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uDeepColor;
        uniform vec3 uShallowColor;
        uniform float uDaylight;
        uniform float uIce;
        uniform float uRain;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying float vDeep;
        varying vec3 vWorldPos;
        varying vec3 vNormalW;
        void main() {
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 N = normalize(vNormalW);
          float rip = sin(vWorldPos.x * 9.0 + uTime * 6.0) * sin(vWorldPos.z * 8.0 - uTime * 5.0);
          N = normalize(N + vec3(rip * 0.06 * uRain, 0.0, rip * 0.05 * uRain));
          float fres = pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 3.0);
          float lightK = 0.16 + 0.84 * clamp(uDaylight, 0.0, 1.0);
          vec3 base = mix(uShallowColor, uDeepColor, clamp(vDeep, 0.0, 1.0)) * lightK;
          vec3 col = mix(base, uHorizonColor * (0.42 + 0.55 * uDaylight), fres * 0.55);
          col += uSkyColor * 0.06 * fres * lightK;
          vec3 H = normalize(normalize(uSunDir) + V);
          float spec = pow(max(dot(N, H), 0.0), 120.0);
          col += uSunColor * spec * (0.4 + uDaylight * 1.1);
          float glint = pow(max(dot(N, H), 0.0), 16.0) * 0.07 * uDaylight;
          col += uSunColor * glint;
          // 雨天水面灰暗
          col *= 1.0 - uRain * 0.12;
          // 結冰
          col = mix(col, vec3(0.78, 0.85, 0.9), uIce * (0.45 + 0.3 * clamp(vDeep, 0.0, 1.0)));
          float fogF = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorldPos));
          col = mix(col, uFogColor, fogF);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    }),
  );
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.name = 'terrain-water';
  waterMesh.frustumCulled = false;
  track(waterMesh);
  group.add(waterMesh);

  // ───────────── 4. 植披／岩石／道具擺放 ─────────────

  const windMat: WindMaterial = createWindMaterial(true);
  track(windMat.material);
  // 岩石等不受風影響的材質
  const stoneMat = track(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  const plainMat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));

  interface Layers {
    pine: Placement[];
    broadleaf: Placement[];
    blossom: Placement[];
    willow: Placement[];
    bamboo: Placement[];
    shrub: Placement[];
    grass: Placement[];
    flower: Placement[];
    reed: Placement[];
    lotus: Placement[];
    rock: Placement[];
    pebble: Placement[];
    crag: Placement[];
    ridge: Placement[];
    haystack: Placement[];
    distant: Placement[];
  }
  const L: Layers = {
    pine: [],
    broadleaf: [],
    blossom: [],
    willow: [],
    bamboo: [],
    shrub: [],
    grass: [],
    flower: [],
    reed: [],
    lotus: [],
    rock: [],
    pebble: [],
    crag: [],
    ridge: [],
    haystack: [],
    distant: [],
  };

  const isWater = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= width || y >= height ? false : state.tiles[y * width + x].terrain === 'water';

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tile = state.tiles[i];
      const terrain = tile.terrain;
      const { x: wx, z: wz } = tileWorld(x, y, width, height);
      const top = topY[i];
      const nearWater = waterNear[i] === 1;
      const h = (salt: number): number => hash(x, y, seed + salt);
      const jx = (salt: number): number => (h(salt) - 0.5) * 1.15;
      const jz = (salt: number): number => (h(salt) - 0.5) * 1.15;
      const scl = (salt: number): number => 0.82 + h(salt) * 0.4;

      if (terrain === 'forest') {
        const n = 2 + (h(11) > 0.55 ? 1 : 0);
        for (let k = 0; k < n; k++) {
          const roll = h(20 + k);
          const px = wx + jx(30 + k);
          const pz = wz + jz(40 + k);
          const rot = h(50 + k) * Math.PI * 2;
          const s = 0.9 + h(60 + k) * 0.5;
          if (nearWater && roll > 0.86) L.willow.push(place(i, px, top - 0.05, pz, rot, s, h(70 + k)));
          else if (roll > 0.62) L.pine.push(place(i, px, top - 0.05, pz, rot, s, h(70 + k)));
          else if (roll > 0.48) L.bamboo.push(place(i, px, top - 0.05, pz, rot, s, h(70 + k)));
          else L.broadleaf.push(place(i, px, top - 0.05, pz, rot, s * 1.05, h(70 + k)));
        }
        if (h(80) < 0.5) {
          L.shrub.push(place(i, wx + jx(81), top + 0.02, wz + jz(82), h(83) * 6.28, scl(84), h(85)));
        }
        if (h(86) < 0.4) {
          L.grass.push(place(i, wx + jx(87), top + 0.01, wz + jz(88), h(89) * 6.28, scl(90), h(91)));
        }
      } else if (terrain === 'grass') {
        if (h(100) < 0.09) {
          const roll = h(101);
          if (roll < 0.18) L.blossom.push(place(i, wx + jx(102), top - 0.04, wz + jz(103), h(104) * 6.28, scl(105), h(106)));
          else if (roll < 0.5) L.broadleaf.push(place(i, wx + jx(102), top - 0.04, wz + jz(103), h(104) * 6.28, scl(105) * 1.1, h(106)));
          else L.pine.push(place(i, wx + jx(102), top - 0.04, wz + jz(103), h(104) * 6.28, scl(105), h(106)));
        }
        if (h(110) < 0.16) L.grass.push(place(i, wx + jx(111), top + 0.01, wz + jz(112), h(113) * 6.28, scl(114), h(115)));
        if (h(120) < 0.1) L.grass.push(place(i, wx + jx(121), top + 0.01, wz + jz(122), h(123) * 6.28, scl(124) * 0.8, h(125)));
        if (h(130) < 0.055) L.flower.push(place(i, wx + jx(131), top, wz + jz(132), h(133) * 6.28, scl(134) * 0.8, h(135)));
        if (h(140) < 0.05) L.shrub.push(place(i, wx + jx(141), top + 0.02, wz + jz(142), h(143) * 6.28, scl(144) * 0.9, h(145)));
        if (h(150) < 0.025) L.rock.push(place(i, wx + jx(151), top + 0.02, wz + jz(152), h(153) * 6.28, scl(154) * 0.7, h(155)));
        if (h(160) < 0.03) L.pebble.push(place(i, wx + jx(161), top + 0.01, wz + jz(162), h(163) * 6.28, scl(164) * 0.8, h(165)));
        // 稻草堆：靠近農田的草地
        if (h(166) < 0.028) {
          let nearField = false;
          for (let dy = -2; dy <= 2 && !nearField; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              if (state.tiles[ny * width + nx].terrain === 'fertile') {
                nearField = true;
                break;
              }
            }
          }
          if (nearField) L.haystack.push(place(i, wx + jx(167), top + 0.02, wz + jz(168), h(169) * 6.28, scl(170) * 0.9, h(171)));
        }
      } else if (terrain === 'fertile') {
        if (h(180) < 0.08) L.grass.push(place(i, wx + jx(181), top + 0.01, wz + jz(182), h(183) * 6.28, scl(184) * 0.7, h(185)));
        if (h(186) < 0.05) L.flower.push(place(i, wx + jx(187), top, wz + jz(188), h(189) * 6.28, scl(190) * 0.7, h(191)));
        // 田埂：每 3 格形成田塊邊界（部分跳過，避免過於規則）
        if (x % 3 === 0 && h(203) < 0.82 && x + 1 < width && state.tiles[i + 1].terrain === 'fertile') {
          L.ridge.push({
            tile: i,
            x: wx + TILE / 2,
            y: top + 0.01,
            z: wz,
            rot: Math.PI / 2,
            sx: TILE * 0.98,
            sy: 1,
            sz: 1,
            hash: h(210),
          });
        }
        if (y % 3 === 0 && h(204) < 0.82 && y + 1 < height && state.tiles[i + width].terrain === 'fertile') {
          L.ridge.push({
            tile: i,
            x: wx,
            y: top + 0.01,
            z: wz + TILE / 2,
            rot: 0,
            sx: TILE * 0.98,
            sy: 1,
            sz: 1,
            hash: h(211),
          });
        }
        if (h(220) < 0.012) L.haystack.push(place(i, wx, top + 0.02, wz, h(221) * 6.28, scl(222) * 0.9, h(223)));
      } else if (terrain === 'hill') {
        if (h(230) < 0.3) {
          L.pine.push(place(i, wx + jx(231), top - 0.04, wz + jz(232), h(233) * 6.28, 0.85 + h(234) * 0.5, h(235)));
        }
        if (h(240) < 0.22) L.shrub.push(place(i, wx + jx(241), top + 0.02, wz + jz(242), h(243) * 6.28, scl(244), h(245)));
        if (h(250) < 0.2) L.rock.push(place(i, wx + jx(251), top + 0.02, wz + jz(252), h(253) * 6.28, scl(254) * 0.9, h(255)));
        if (h(260) < 0.14) L.grass.push(place(i, wx + jx(261), top + 0.01, wz + jz(262), h(263) * 6.28, scl(264) * 0.8, h(265)));
        if (h(266) < 0.1) L.pebble.push(place(i, wx + jx(267), top + 0.01, wz + jz(268), h(269) * 6.28, scl(270) * 0.9, h(271)));
      } else if (terrain === 'mountain') {
        if (h(280) < 0.68 && tile.elevation > 0.7) {
          L.crag.push(
            place(
              i,
              wx + jx(281) * 0.45,
              top - 0.2,
              wz + jz(282) * 0.45,
              h(283) * 6.28,
              1.2 + h(284) * 1.5,
              h(285),
              0.6 + h(286) * 0.8,
            ),
          );
        }
        if (h(287) < 0.28) {
          L.crag.push(
            place(
              i,
              wx + jx(288) * 0.7,
              top - 0.25,
              wz + jz(289) * 0.7,
              h(290) * 6.28,
              0.7 + h(291) * 0.7,
              h(292),
              0.45 + h(293) * 0.4,
            ),
          );
        }
        if (tile.elevation < 0.86 && h(290) < 0.1) {
          L.pine.push(place(i, wx + jx(291), top - 0.1, wz + jz(292), h(293) * 6.28, 0.8 + h(294) * 0.4, h(295)));
        }
        if (h(296) < 0.08) L.shrub.push(place(i, wx + jx(297), top + 0.02, wz + jz(298), h(299) * 6.28, scl(300), h(301)));
      } else if (terrain === 'sand') {
        if (nearWater && h(310) < 0.42) {
          L.reed.push(place(i, wx + jx(311), top + 0.01, wz + jz(312), h(313) * 6.28, scl(314), h(315)));
        }
        if (h(320) < 0.1) L.pebble.push(place(i, wx + jx(321), top + 0.01, wz + jz(322), h(323) * 6.28, scl(324) * 1.1, h(325)));
        if (nearWater && h(326) < 0.09) {
          L.willow.push(place(i, wx + jx(327), top - 0.04, wz + jz(328), h(329) * 6.28, 0.85 + h(330) * 0.3, h(331)));
        }
        if (h(332) < 0.05) L.grass.push(place(i, wx + jx(333), top + 0.01, wz + jz(334), h(335) * 6.28, scl(336) * 0.7, h(337)));
      }

      // 水岸蘆葦（所有臨水陸地）
      if (nearWater && terrain !== 'sand' && h(340) < 0.3) {
        L.reed.push(place(i, wx + jx(341), top + 0.01, wz + jz(342), h(343) * 6.28, scl(344), h(345)));
      }
      if (nearWater && terrain !== 'sand' && h(350) < 0.07 && terrain !== 'forest') {
        L.willow.push(place(i, wx + jx(351), top - 0.04, wz + jz(352), h(353) * 6.28, 0.9 + h(354) * 0.35, h(355)));
      }
    }
  }

  // 荷葉（近岸淺水）
  for (const wi of waterTiles) {
    const depth = waterDepth[wi];
    if (depth !== 1) continue;
    const x = wi % width;
    const y = (wi - x) / width;
    if (hash(x, y, seed + 360) > 0.3) continue;
    const { x: wx, z: wz } = tileWorld(x, y, width, height);
    L.lotus.push(place(wi, wx + (hash(x, y, seed + 361) - 0.5) * 1.1, WATER_SURFACE_Y + 0.035, wz + (hash(x, y, seed + 362) - 0.5) * 1.1, hash(x, y, seed + 363) * 6.28, 0.8 + hash(x, y, seed + 364) * 0.6, hash(x, y, seed + 365)));
  }

  // 遠處平原：填補地圖外的空無，讓遠山有立足之地、地平線不再懸空
  const farGroundMat = track(new THREE.MeshLambertMaterial({ color: 0x748257 }));
  const farGroundGeo = track(new THREE.CircleGeometry(900, 48));
  farGroundGeo.rotateX(-Math.PI / 2);
  const farGround = new THREE.Mesh(farGroundGeo, farGroundMat);
  farGround.name = 'terrain-far-ground';
  farGround.position.y = -0.45;
  farGround.receiveShadow = false;
  track(farGround);
  group.add(farGround);

  // 遠山剪影（地圖外圈，站在遠處平原上）
  {
    const ringCount = 26;
    for (let k = 0; k < ringCount; k++) {
      const ring = k % 2; // 內外兩圈，做出遠近層次
      const a = (k / ringCount) * Math.PI * 2 + hash(k, 7, seed + 370) * 0.3;
      const baseR = ring === 0 ? halfW + 58 : halfW + 155;
      const radiusX = baseR + hash(k, 11, seed + 371) * (ring === 0 ? 55 : 105);
      const radiusZ = baseR * 0.92 + hash(k, 13, seed + 372) * (ring === 0 ? 55 : 105);
      const px = Math.cos(a) * radiusX;
      const pz = Math.sin(a) * radiusZ;
      const s = (ring === 0 ? 14 : 20) + hash(k, 17, seed + 373) * 18;
      L.distant.push({
        tile: -1,
        x: px,
        y: -1.2,
        z: pz,
        rot: hash(k, 19, seed + 374) * Math.PI * 2,
        sx: s,
        sy: s * (0.42 + hash(k, 23, seed + 375) * 0.4),
        sz: s * (0.85 + hash(k, 29, seed + 376) * 0.5),
        hash: hash(k, 31, seed + 377),
      });
    }
  }

  // ───────────── 建立 InstancedMesh 圖層 ─────────────

  const layers: TintableLayer[] = [];

  interface LayerOpts {
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    list: Placement[];
    kind: TintKind;
    occupancy?: boolean;
    windPhase?: boolean;
    castShadow?: boolean;
    receiveShadow?: boolean;
    sway?: boolean;
  }

  const buildLayer = (opts: LayerOpts): TintableLayer => {
    const geo = track(opts.geometry);
    if (opts.sway) addSwayAttribute(geo);
    const n = opts.list.length;
    const mesh = new THREE.InstancedMesh(geo, opts.material, Math.max(1, n));
    mesh.name = `terrain-${opts.kind}`;
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = opts.receiveShadow ?? false;
    mesh.frustumCulled = false;
    mesh.count = n;
    mesh.visible = n > 0;
    if (opts.windPhase) addInstancePhase(geo, Math.max(1, n), seed + opts.kind.length * 977);
    track(mesh);
    group.add(mesh);
    const layer: TintableLayer = {
      mesh,
      list: opts.list,
      kind: opts.kind,
      occupancy: opts.occupancy ?? false,
      matrixBase: null,
    };
    if (layer.occupancy && n > 0) {
      const base = new Float32Array(n * 16);
      const dummy = new THREE.Object3D();
      opts.list.forEach((p, idx) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.sx, p.sy, p.sz);
        dummy.updateMatrix();
        dummy.matrix.toArray(base, idx * 16);
        mesh.setMatrixAt(idx, dummy.matrix);
      });
      layer.matrixBase = base;
      mesh.instanceMatrix.needsUpdate = true;
    } else {
      const dummy = new THREE.Object3D();
      opts.list.forEach((p, idx) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.set(p.sx, p.sy, p.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    layers.push(layer);
    return layer;
  };

  const pineGeo = createPineGeometry();
  const broadleafGeo = createBroadleafGeometry();
  const blossomGeo = createBlossomGeometry();
  const willowGeo = createWillowGeometry();
  const bambooGeo = createBambooGeometry();
  const shrubGeo = createShrubGeometry();
  const grassGeo = createGrassTuftGeometry();
  const flowerGeo = createFlowerGeometry();
  const reedGeo = createReedGeometry();
  const lotusGeo = createLotusPadGeometry();
  const rockGeo = createRockGeometry(seed + 5);
  const pebbleGeo = createPebblesGeometry();
  const cragGeo = createCragGeometry(seed + 9);
  const ridgeGeo = createPaddyRidgeGeometry();
  const haystackGeo = createHaystackGeometry();
  const distantGeo = createMountainSilhouetteGeometry(seed + 13);

  buildLayer({ geometry: pineGeo, material: windMat.material, list: L.pine, kind: 'evergreen', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: broadleafGeo, material: windMat.material, list: L.broadleaf, kind: 'deciduous', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: blossomGeo, material: windMat.material, list: L.blossom, kind: 'blossom', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: willowGeo, material: windMat.material, list: L.willow, kind: 'willow', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: bambooGeo, material: windMat.material, list: L.bamboo, kind: 'willow', occupancy: true, windPhase: true, sway: true });
  buildLayer({ geometry: shrubGeo, material: windMat.material, list: L.shrub, kind: 'shrub', occupancy: true, windPhase: true, sway: true, castShadow: false });
  buildLayer({ geometry: grassGeo, material: windMat.material, list: L.grass, kind: 'grass', occupancy: true, windPhase: true, sway: true, castShadow: false });
  buildLayer({ geometry: flowerGeo, material: windMat.material, list: L.flower, kind: 'flower', occupancy: true, windPhase: true, sway: true, castShadow: false });
  buildLayer({ geometry: reedGeo, material: windMat.material, list: L.reed, kind: 'reed', occupancy: true, windPhase: true, sway: true, castShadow: false });
  buildLayer({ geometry: lotusGeo, material: stoneMat, list: L.lotus, kind: 'lotus', occupancy: false, castShadow: false });
  buildLayer({ geometry: rockGeo, material: stoneMat, list: L.rock, kind: 'rock', occupancy: true });
  buildLayer({ geometry: pebbleGeo, material: stoneMat, list: L.pebble, kind: 'rock', occupancy: true, castShadow: false });
  buildLayer({ geometry: cragGeo, material: stoneMat, list: L.crag, kind: 'crag', occupancy: true, castShadow: false });
  buildLayer({ geometry: ridgeGeo, material: plainMat, list: L.ridge, kind: 'ridge', occupancy: true, castShadow: false });
  buildLayer({ geometry: haystackGeo, material: plainMat, list: L.haystack, kind: 'haystack', occupancy: true });
  buildLayer({ geometry: distantGeo, material: stoneMat, list: L.distant, kind: 'distant', occupancy: false, castShadow: false, receiveShadow: false });

  // 烏篷船（少量，獨立 Mesh 以便輕微搖擺）
  const boatGeo = track(createBoatGeometry());
  const boatMat = track(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const boats: { mesh: THREE.Mesh; phase: number; baseRot: number }[] = [];
  {
    const candidates: number[] = [];
    for (const wi of waterTiles) if (waterDepth[wi] >= 2) candidates.push(wi);
    const boatCount = Math.min(4, Math.max(1, Math.floor(candidates.length / 30)));
    for (let b = 0; b < boatCount; b++) {
      const ci = Math.floor(hash(b, 3, seed + 380) * candidates.length) % Math.max(1, candidates.length);
      const wi = candidates[ci];
      if (wi == null) break;
      const x = wi % width;
      const y = (wi - x) / width;
      const { x: wx, z: wz } = tileWorld(x, y, width, height);
      const mesh = new THREE.Mesh(boatGeo, boatMat);
      mesh.position.set(wx + (hash(b, 5, seed + 381) - 0.5) * 1.2, WATER_SURFACE_Y + 0.04, wz + (hash(b, 7, seed + 382) - 0.5) * 1.2);
      mesh.rotation.y = hash(b, 9, seed + 383) * Math.PI * 2;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      group.add(mesh);
      boats.push({ mesh, phase: hash(b, 11, seed + 384) * 6.28, baseRot: mesh.rotation.y });
    }
  }

  // ───────────── 5. 逐格地表／地基顏色 ─────────────

  const topColorCache = new Uint8Array(count); // 預留
  void topColorCache;
  const dummyColor = new THREE.Color();

  /** 單格地表色（含季節與積雪） */
  const computeTopColor = (tile: Tile, x: number, y: number, out: THREE.Color): THREE.Color => {
    const snow = clamp01(appliedSnow);
    switch (tile.terrain) {
      case 'grass':
        out.copy(seasonC.grass);
        out.lerp(_c1.setHex(hash(x >> 2, y >> 2, seed + 271) > 0.5 ? 0x9fb264 : 0x7fa452), 0.2);
        break;
      case 'fertile': {
        out.copy(seasonC.fertile);
        const p = hash(x >> 1, y >> 1, seed + 1777);
        out.lerp(_c1.setHex(p > 0.62 ? 0xc2b566 : p < 0.3 ? 0x8fae55 : 0xa9c065), 0.38);
        // 部分 3x3 田塊蓄水：偏青綠／反光
        const patch = hash(Math.floor(x / 3), Math.floor(y / 3), seed + 1891);
        if (patch < 0.4) {
          out.lerp(_c1.setHex(0x7fa8a0), 0.3);
        }
        break;
      }
      case 'forest':
        out.copy(seasonC.forest);
        break;
      case 'hill':
        out.copy(seasonC.hill);
        out.lerp(_c1.setHex(0x9a9070), hash(x, y, seed + 55) * 0.3);
        break;
      case 'mountain':
        out.copy(seasonC.mountain);
        out.lerp(_c1.setHex(0x8a8880), hash(x, y, seed + 56) * 0.35);
        break;
      case 'sand':
        out.copy(seasonC.sand);
        break;
      case 'water':
      default:
        out.setHex(0x4a5a54);
        break;
    }
    // 每格微差異
    const shade = 0.92 + tile.variant * 0.16;
    out.multiplyScalar(shade * seasonC.vivid);
    // 積雪：山地更白
    if (snow > 0.001 && tile.terrain !== 'water') {
      const amount = snow * (tile.terrain === 'mountain' ? 0.86 : tile.terrain === 'hill' ? 0.62 : tile.terrain === 'forest' ? 0.44 : 0.6);
      out.lerp(WHITE, clamp01(amount));
    }
    return out;
  };

  const applyTerrainColors = (): void => {
    const c = new THREE.Color();
    const f = new THREE.Color();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const tile = state.tiles[i];
        computeTopColor(tile, x, y, c);
        topMesh.setColorAt(i, c);
        // 地基側面：泥土／岩壁色
        switch (tile.terrain) {
          case 'water':
            f.setHex(0x33443f);
            break;
          case 'sand':
            f.setHex(0xa08c60);
            break;
          case 'fertile':
            f.setHex(0x5b4c34);
            break;
          case 'forest':
            f.setHex(0x4f4530);
            break;
          case 'hill':
            f.setHex(0x685e48);
            break;
          case 'mountain':
            f.setHex(0x625d56);
            break;
          default:
            f.setHex(0x5f5138);
            break;
        }
        f.multiplyScalar(0.85 + tile.variant * 0.25);
        if (appliedSnow > 0.001) f.lerp(WHITE, clamp01(appliedSnow * 0.35));
        foundationMesh.setColorAt(i, f);
      }
    }
    if (topMesh.instanceColor) topMesh.instanceColor.needsUpdate = true;
    if (foundationMesh.instanceColor) foundationMesh.instanceColor.needsUpdate = true;
  };

  // 設定地基與地表矩陣
  {
    const dummy = new THREE.Object3D();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const tile = state.tiles[i];
        const { x: wx, z: wz } = tileWorld(x, y, width, height);
        const top = topY[i];
        const isWaterTile = tile.terrain === 'water';
        dummy.position.set(wx, isWaterTile ? -0.28 : 0, wz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, isWaterTile ? WATER_SURFACE_Y + 0.2 : top, 1);
        dummy.updateMatrix();
        foundationMesh.setMatrixAt(i, dummy.matrix);
        dummy.position.y = isWaterTile ? -5 : top + 0.006;
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        topMesh.setMatrixAt(i, dummy.matrix);
      }
    }
    foundationMesh.instanceMatrix.needsUpdate = true;
    topMesh.instanceMatrix.needsUpdate = true;
  }

  // ───────────── 6. 著色（季節／積雪） ─────────────

  interface TintSet {
    evergreen: THREE.Color;
    deciduous: THREE.Color;
    willow: THREE.Color;
    blossom: THREE.Color;
    shrub: THREE.Color;
    grass: THREE.Color;
    flower: THREE.Color;
    reed: THREE.Color;
    lotus: THREE.Color;
    rock: THREE.Color;
    ridge: THREE.Color;
    haystack: THREE.Color;
    distant: THREE.Color;
    crag: THREE.Color;
  }
  const tints: TintSet = {
    evergreen: new THREE.Color(1, 1, 1),
    deciduous: new THREE.Color(1, 1, 1),
    willow: new THREE.Color(1, 1, 1),
    blossom: new THREE.Color(1, 1, 1),
    shrub: new THREE.Color(1, 1, 1),
    grass: new THREE.Color(1, 1, 1),
    flower: new THREE.Color(1, 1, 1),
    reed: new THREE.Color(1, 1, 1),
    lotus: new THREE.Color(1, 1, 1),
    rock: new THREE.Color(1, 1, 1),
    ridge: new THREE.Color(1, 1, 1),
    haystack: new THREE.Color(1, 1, 1),
    distant: new THREE.Color(1, 1, 1),
    crag: new THREE.Color(1, 1, 1),
  };

  const computeTints = (snow: number): void => {
    switch (paletteSeason) {
      case 'spring':
        tints.evergreen.setRGB(0.94, 1.06, 0.94);
        tints.deciduous.setRGB(1.0, 1.08, 0.92);
        tints.willow.setRGB(1.02, 1.12, 0.82);
        tints.blossom.setRGB(1.55, 0.86, 0.92);
        tints.shrub.setRGB(0.96, 1.1, 0.9);
        tints.grass.setRGB(1.0, 1.08, 0.9);
        tints.flower.setRGB(1.25, 1.15, 1.2);
        tints.reed.setRGB(1.0, 1.06, 0.88);
        tints.lotus.setRGB(0.92, 1.06, 0.86);
        break;
      case 'summer':
        tints.evergreen.setRGB(0.98, 1.02, 0.98);
        tints.deciduous.setRGB(1, 1, 1);
        tints.willow.setRGB(0.98, 1.04, 0.94);
        tints.blossom.setRGB(1.05, 1.06, 0.96);
        tints.shrub.setRGB(0.96, 1.02, 0.94);
        tints.grass.setRGB(0.84, 0.98, 0.8);
        tints.flower.setRGB(1.15, 1.1, 1.12);
        tints.reed.setRGB(0.94, 1.0, 0.84);
        tints.lotus.setRGB(1, 1.04, 0.94);
        break;
      case 'autumn':
        tints.evergreen.setRGB(0.88, 0.96, 0.82);
        tints.deciduous.setRGB(1.5, 0.92, 0.5);
        tints.willow.setRGB(1.28, 1.02, 0.66);
        tints.blossom.setRGB(1.2, 0.9, 0.66);
        tints.shrub.setRGB(1.25, 0.98, 0.66);
        tints.grass.setRGB(1.32, 1.02, 0.62);
        tints.flower.setRGB(1.25, 1.0, 0.82);
        tints.reed.setRGB(1.3, 1.06, 0.64);
        tints.lotus.setRGB(1.15, 0.96, 0.68);
        break;
      case 'winter':
        tints.evergreen.setRGB(0.7, 0.84, 0.9);
        tints.deciduous.setRGB(0.66, 0.56, 0.46);
        tints.willow.setRGB(0.72, 0.62, 0.48);
        tints.blossom.setRGB(0.7, 0.6, 0.54);
        tints.shrub.setRGB(0.72, 0.68, 0.6);
        tints.grass.setRGB(1.24, 1.12, 0.86);
        tints.flower.setRGB(0.62, 0.6, 0.6);
        tints.reed.setRGB(1.05, 0.98, 0.82);
        tints.lotus.setRGB(0.66, 0.66, 0.7);
        break;
    }
    tints.rock.setRGB(0.98 + snow * 0.3, 0.98 + snow * 0.31, 0.98 + snow * 0.33);
    switch (paletteSeason) {
      case 'spring':
        tints.crag.setRGB(1.0, 0.99, 0.94);
        break;
      case 'summer':
        tints.crag.setRGB(0.94, 0.93, 0.87);
        break;
      case 'autumn':
        tints.crag.setRGB(1.06, 1.0, 0.88);
        break;
      case 'winter':
        tints.crag.setRGB(1.25, 1.3, 1.36);
        break;
    }
    tints.ridge.setRGB(1, 1, 1);
    tints.haystack.setRGB(0.98, 0.98, 0.96);
    tints.distant.setRGB(0.86 + snow * 0.5, 0.9 + snow * 0.5, 0.98 + snow * 0.5);
    // 積雪：樹葉提亮（乘以大於 1 的值在色調映射下偏白）
    if (snow > 0.001) {
      const blend = (c: THREE.Color, amount: number): void => {
        c.lerp(SNOW_TINT, clamp01(snow * amount));
      };
      blend(tints.evergreen, 0.55);
      blend(tints.deciduous, 0.5);
      blend(tints.willow, 0.5);
      blend(tints.blossom, 0.5);
      blend(tints.shrub, 0.6);
      blend(tints.grass, 0.55);
      blend(tints.reed, 0.5);
      blend(tints.ridge, 0.5);
    }
  };

  const applyLayerTints = (): void => {
    const c = new THREE.Color();
    for (const layer of layers) {
      if (layer.mesh.count === 0) continue;
      const tint = tints[layer.kind];
      for (let i = 0; i < layer.list.length; i++) {
        const h = layer.list[i].hash;
        const f = 0.84 + h * 0.32;
        c.setRGB(tint.r * f, tint.g * f, tint.b * f);
        layer.mesh.setColorAt(i, c);
      }
      if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
    }
  };

  // ───────────── 7. 佔用隱藏（道路／建築覆蓋處） ─────────────

  const occupancy = new Uint8Array(count);
  let occupancyBuildings = -1;
  let occupancyRoads = -1;
  let lastRevision = -1;

  const rebuildOccupancy = (s: GameState): void => {
    occupancy.fill(0);
    let roads = 0;
    for (let i = 0; i < count; i++) {
      const t = s.tiles[i];
      if (t.buildingId >= 0) occupancy[i] = 1;
      else if (t.road) {
        occupancy[i] = 1;
        roads++;
      }
    }
    occupancyBuildings = s.buildings.length;
    occupancyRoads = roads;
    lastRevision = s.ui.revision;
    const dummy = new THREE.Object3D();
    for (const layer of layers) {
      if (!layer.occupancy || !layer.matrixBase) continue;
      const base = layer.matrixBase;
      const n = layer.list.length;
      let dirty = false;
      for (let i = 0; i < n; i++) {
        const ti = layer.list[i].tile;
        if (ti >= 0 && occupancy[ti]) {
          dummy.position.set(0, -50, 0);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(0.001, 0.001, 0.001);
          dummy.updateMatrix();
          layer.mesh.setMatrixAt(i, dummy.matrix);
          dirty = true;
        } else {
          const o = i * 16;
          for (let k = 0; k < 16; k++) {
            dummy.matrix.elements[k] = base[o + k];
          }
          layer.mesh.setMatrixAt(i, dummy.matrix);
        }
      }
      if (dirty || layer.matrixBase) layer.mesh.instanceMatrix.needsUpdate = true;
    }
  };

  const checkOccupancy = (s: GameState): void => {
    if (s.ui.revision === lastRevision && s.buildings.length === occupancyBuildings) return;
    if (s.buildings.length === occupancyBuildings && s.ui.revision === lastRevision) return;
    // 只有建築／道路數量或 revision 改變時才重建
    let roads = 0;
    for (let i = 0; i < count; i++) if (s.tiles[i].road) roads++;
    if (s.buildings.length === occupancyBuildings && roads === occupancyRoads) {
      lastRevision = s.ui.revision;
      return;
    }
    rebuildOccupancy(s);
  };

  // ───────────── 8. 初始化 ─────────────

  computeTints(0);
  applyTerrainColors();
  applyLayerTints();
  rebuildOccupancy(state);

  // ───────────── 9. 每幀更新 ─────────────

  const sun: SunState = createSunState();
  const skyPalette = createSkyPalette();
  const moonDir = new THREE.Vector3();
  let time = 0;
  let lastSeason: Season = state.clock.season;
  let lastWeatherSnow = -1;
  let lastPaletteSeason: Season | null = null;

  const applyPalette = (s: GameState): void => {
    const snow = snowCover(s.clock.season, s.clock.weather, s.clock.tempC);
    seasonColors(s.clock.season, seasonC);
    paletteSeason = s.clock.season;
    appliedSnow = snow;
    computeTints(snow);
    applyTerrainColors();
    applyLayerTints();
    // 水色
    const deep = waterUniforms.uDeepColor.value as THREE.Color;
    const shallow = waterUniforms.uShallowColor.value as THREE.Color;
    deep.setHex(WATER_DEEP[s.clock.season]);
    shallow.setHex(WATER_SHALLOW[s.clock.season]);
    // 遠處平原顏色
    farGroundMat.color.copy(seasonC.grass).lerp(_c1.setHex(0x6d7a55), 0.62);
    if (snow > 0.001) farGroundMat.color.lerp(WHITE, clamp01(snow * 0.6));
    lastSeason = s.clock.season;
    lastPaletteSeason = s.clock.season;
    lastWeatherSnow = snow;
  };

  applyPalette(state);

  return {
    group,
    update(s: GameState, dt: number): void {
      time += dt;
      windMat.time.value = time;
      const wind = windStrength(s.clock.weather, s.clock.weatherIntensity);
      windMat.wind.value = wind;
      waterUniforms.uTime.value = time;
      waterUniforms.uWave.value = 0.008 + wind * 0.008;

      const { clock } = s;
      computeSun(clock.hour, clock.minute, clock.season, sun);
      computeMoonDir(clock.hour, clock.minute, clock.season, moonDir);
      sampleSkyPalette(clock.season, clock.weather, sun.daylight, skyPalette);
      const fog = fogRange(clock.weather, sun.daylight);
      (waterUniforms.uSunDir.value as THREE.Vector3).copy(sun.elevation > -0.02 ? sun.dir : moonDir);
      (waterUniforms.uSunColor.value as THREE.Color).copy(sun.elevation > -0.02 ? skyPalette.sun : skyPalette.moon).multiplyScalar(sun.daylight > 0.02 ? 1 : 0.45);
      (waterUniforms.uSkyColor.value as THREE.Color).copy(skyPalette.zenith);
      (waterUniforms.uHorizonColor.value as THREE.Color).copy(skyPalette.horizon);
      (waterUniforms.uFogColor.value as THREE.Color).copy(skyPalette.fog);
      waterUniforms.uFogNear.value = fog.near;
      waterUniforms.uFogFar.value = fog.far;
      waterUniforms.uDaylight.value = 0.12 + sun.daylight * 0.9;
      waterUniforms.uRain.value = clock.weather === 'rain' ? 0.4 + clock.weatherIntensity * 0.6 : 0;
      const ice = clamp01((2.5 - clock.tempC) / 8) * (clock.season === 'winter' ? 1 : 0.35);
      waterUniforms.uIce.value = ice;

      // 季節／積雪變化才重上色
      const snow = snowCover(clock.season, clock.weather, clock.tempC);
      if (clock.season !== lastSeason) {
        applyPalette(s);
      } else if (Math.abs(snow - lastWeatherSnow) > 0.14) {
        applyPalette(s);
      }
      if (lastPaletteSeason === null) lastPaletteSeason = clock.season;

      // 船搖擺
      for (const b of boats) {
        b.mesh.position.y = WATER_SURFACE_Y + 0.04 + Math.sin(time * 0.9 + b.phase) * 0.018;
        b.mesh.rotation.y = b.baseRot + Math.sin(time * 0.35 + b.phase) * 0.06;
        b.mesh.rotation.z = Math.sin(time * 0.8 + b.phase) * 0.02;
      }

      checkOccupancy(s);
    },
    dispose(): void {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      group.clear();
    },
  };
}
