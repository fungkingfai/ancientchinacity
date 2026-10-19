/**
 * 世界生成（地形）：蜿蜒河流、湖泊、山地丘陵、林地、沃土、沙岸與中央可建平地。
 *
 * 設計目標（world-renderer）：
 *  - 河流由北向南蜿蜒貫穿全圖，河面寬窄有致；湖畔、河灣形成濕地沙洲。
 *  - 山地／丘陵集中在邊緣形成屏障，中央保留大片可建平地；spawn 附近平整開闊。
 *  - 河岸沿線是沙岸與沃土（農田首選），林地成片分佈於丘陵與平原交界。
 *  - 在河面較窄處設置 2 個「渡口」（沙質淺灘橫渡），讓道路可以跨河連通兩岸。
 *  - 保證可建面積比例，且地形與 placement.ts 的可建規則一致
 *    （mountain / water 不可建，其餘皆可；生產建築另有 allowedTerrain 限制）。
 *  - `generateWorld(seed)` 回傳介面保持不變：{ width, height, tiles, spawn }。
 */

import { GRID_HEIGHT, GRID_WIDTH } from '../core/config';
import { clamp, hash2d, mulberry32, ValueNoise } from '../core/rng';
import type { TerrainType, Tile } from '../core/types';

export interface WorldGenResult {
  width: number;
  height: number;
  tiles: Tile[];
  /** 建議的開局鏡頭中心（格座標） */
  spawn: { x: number; y: number };
}

/** 與 placement.ts 的可建規則一致：只有山地與水域不可建造。 */
const BUILDABLE: Record<TerrainType, boolean> = {
  grass: true,
  fertile: true,
  forest: true,
  hill: true,
  mountain: false,
  water: false,
  sand: true,
};

/** 水面最深處水深（格） */
const MAX_WATER_DEPTH = 4;

interface Ford {
  /** 渡口起始列（佔 y0, y0+1 兩列） */
  y: number;
  x0: number;
  x1: number;
}

export function generateWorld(seed = 20261018, width = GRID_WIDTH, height = GRID_HEIGHT): WorldGenResult {
  const s = seed >>> 0;
  const rng = mulberry32(s);
  const elevNoise = new ValueNoise(s + 11);
  const detailNoise = new ValueNoise(s + 4242);
  const ridgeNoise = new ValueNoise(s + 991);
  const moistureNoise = new ValueNoise(s + 7717);
  const forestNoise = new ValueNoise(s + 5511);
  const patchNoise = new ValueNoise(s + 8821);

  const cx = width / 2;
  const cy = height / 2;
  const idx = (x: number, y: number): number => y * width + x;

  // ─────────────────────────── 河流參數 ───────────────────────────
  const riverBase = width * (0.44 + rng() * 0.12);
  const ampA = width * (0.055 + rng() * 0.05);
  const ampB = width * (0.016 + rng() * 0.024);
  const freqA = 0.055 + rng() * 0.05;
  const freqB = 0.14 + rng() * 0.08;
  const phaseA = rng() * Math.PI * 2;
  const phaseB = rng() * Math.PI * 2;
  const widthPhase = rng() * Math.PI * 2;
  const bumpPhase = rng() * Math.PI * 2;
  const edgeBand = 8 + rng() * 5;
  const centralRadius = 10.5 + rng() * 2.5;

  const riverCenter = (y: number): number => {
    const c = riverBase + Math.sin(y * freqA + phaseA) * ampA + Math.sin(y * freqB + phaseB) * ampB;
    // 軟性夾限，避免河穿出地圖左右邊界
    const margin = 6;
    if (c < margin) return margin + (c - margin) * 0.25;
    if (c > width - margin) return width - margin + (c - (width - margin)) * 0.25;
    return c;
  };
  const riverHalf = (y: number): number => {
    const w =
      1.15 +
      Math.sin(y * 0.055 + widthPhase) * 0.32 +
      Math.sin(y * 0.135 + bumpPhase) * 0.16 +
      (patchNoise.at(3.7, y * 0.22) - 0.5) * 0.45;
    return clamp(w, 0.92, 1.95);
  };

  // ─────────────────────────── 湖泊與水塘 ───────────────────────────
  const lakeSide: 1 | -1 = rng() < 0.5 ? -1 : 1;
  const lakeY = height * (0.58 + rng() * 0.2);
  let lakeX = riverCenter(lakeY) + lakeSide * width * (0.17 + rng() * 0.1);
  lakeX = clamp(lakeX, 8, width - 9);
  // 湖泊不要壓在中央開局平原上
  if (Math.abs(lakeX - cx) < 13 && Math.abs(lakeY - cy) < 13) {
    lakeX = clamp(cx + lakeSide * 20, 8, width - 9);
  }
  const lakeRx = 4.5 + rng() * 2.6;
  const lakeRy = 3.2 + rng() * 1.9;
  const lakePhase = rng() * Math.PI * 2;

  const havePond = rng() < 0.62;
  const pondY = height * (0.25 + rng() * 0.16);
  let pondX = riverCenter(pondY) - lakeSide * width * (0.16 + rng() * 0.08);
  pondX = clamp(pondX, 7, width - 8);
  if (Math.abs(pondX - cx) < 11 && Math.abs(pondY - cy) < 11) {
    pondX = clamp(cx - lakeSide * 18, 7, width - 8);
  }
  const pondRx = 2.6 + rng() * 1.6;
  const pondRy = 1.9 + rng() * 1.2;
  const pondPhase = rng() * Math.PI * 2;

  // ─────────────────────────── 水體遮罩 ───────────────────────────
  const water = new Uint8Array(width * height);
  const elevation = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const rc = riverCenter(y);
    const rhw = riverHalf(y);
    const x0 = Math.max(0, Math.floor(rc - rhw - 2));
    const x1 = Math.min(width - 1, Math.ceil(rc + rhw + 2));
    for (let x = x0; x <= x1; x++) {
      const wobble = (patchNoise.at(x * 0.33, y * 0.19) - 0.5) * 0.62;
      if (Math.abs(x - rc) < rhw + wobble) water[idx(x, y)] = 1;
    }
  }

  const stampLake = (lx: number, ly: number, rx: number, ry: number, ph: number): void => {
    const y0 = Math.max(0, Math.floor(ly - ry - 2));
    const y1 = Math.min(height - 1, Math.ceil(ly + ry + 2));
    const x0 = Math.max(0, Math.floor(lx - rx - 2));
    const x1 = Math.min(width - 1, Math.ceil(lx + rx + 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const wob = 1 + (patchNoise.at(x * 0.27 + ph, y * 0.27 + ph * 1.7) - 0.5) * 0.28;
        const d = ((x - lx) / rx) ** 2 + ((y - ly) / ry) ** 2;
        if (d < wob) water[idx(x, y)] = 1;
      }
    }
  };
  stampLake(lakeX, lakeY, lakeRx, lakeRy, lakePhase);
  if (havePond) stampLake(pondX, pondY, pondRx, pondRy, pondPhase);

  // ─────────────────────────── 渡口（跨河淺灘） ───────────────────────────
  // 在河面較窄、遠離湖泊、且離開局平原不太遠的地方設 2 個可通行渡口，
  // 讓道路能跨河連通兩岸（地形上是沙洲淺灘，不是水面）。
  const fords: Ford[] = [];
  const fordCandidates: number[] = [];
  for (let y = 10; y < height - 10; y++) {
    const rc = riverCenter(y);
    const nearLake = Math.abs(y - lakeY) < lakeRy + 3 && Math.abs(rc - lakeX) < lakeRx + 4;
    const nearPond = havePond && Math.abs(y - pondY) < pondRy + 3 && Math.abs(rc - pondX) < pondRx + 4;
    if (nearLake || nearPond) continue;
    if (Math.abs(y - cy) < 6) continue; // 不要緊貼開局中心，留一點過河路程
    fordCandidates.push(y);
  }
  fordCandidates.sort((a, b) => riverHalf(a) - riverHalf(b));
  const chosenFords: number[] = [];
  for (const y of fordCandidates) {
    if (chosenFords.length >= 2) break;
    let farEnough = true;
    for (const other of chosenFords) {
      if (Math.abs(other - y) < 14) {
        farEnough = false;
        break;
      }
    }
    if (!farEnough) continue;
    // 上、下游各留一格渡口寬度；避免渡口前後仍是窄水
    chosenFords.push(y);
  }
  for (const fy of chosenFords) {
    const rc = riverCenter(fy);
    const rhw = riverHalf(fy);
    const x0 = Math.max(1, Math.floor(rc - rhw - 2));
    const x1 = Math.min(width - 2, Math.ceil(rc + rhw + 2));
    for (let dy = 0; dy < 2; dy++) {
      const y = fy + dy;
      if (y >= height) continue;
      for (let x = x0; x <= x1; x++) water[idx(x, y)] = 0;
    }
    fords.push({ y: fy, x0, x1 });
  }

  // ─────────────────────── 距離場：水深（水）與離水距離（陸） ───────────────────────
  /** 水域格的水深（1 = 近岸），非水域為 255 */
  const waterDepth = new Uint8Array(width * height).fill(255);
  /** 陸地格到最近水域的格距離（1 = 臨水），水域為 0 */
  const distToWater = new Uint8Array(width * height).fill(255);
  const waterQueue: number[] = [];
  const landQueue: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      const atEdge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      let nearWater = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (water[idx(nx, ny)]) nearWater = true;
        }
      }
      if (water[i]) {
        if (nearWater || atEdge) {
          waterDepth[i] = 1;
          waterQueue.push(i);
        }
      } else if (nearWater) {
        distToWater[i] = 1;
        landQueue.push(i);
      }
    }
  }
  // 水深 BFS（只在水域內擴散）
  for (let head = 0; head < waterQueue.length; head++) {
    const i = waterQueue[head];
    const d = waterDepth[i];
    if (d >= MAX_WATER_DEPTH) continue;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = idx(nx, ny);
        if (!water[ni] || waterDepth[ni] !== 255) continue;
        waterDepth[ni] = d + 1;
        waterQueue.push(ni);
      }
    }
  }
  // 離水距離 BFS（只在陸地內擴散）
  for (let head = 0; head < landQueue.length; head++) {
    const i = landQueue[head];
    const d = distToWater[i];
    if (d >= 16) continue;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = idx(nx, ny);
        if (water[ni] || distToWater[ni] !== 255) continue;
        distToWater[ni] = d + 1;
        landQueue.push(ni);
      }
    }
  }

  // ─────────────────────────── 地形分類 ───────────────────────────
  const terrain = new Array<TerrainType>(width * height).fill('grass');

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      const cheb = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      // 中央平原：以 spawn 中心向外平滑過渡
      const central = clamp(1 - Math.max(0, cheb - 5) / (centralRadius - 5), 0, 1);
      const centralSmooth = central * central * (3 - 2 * central);

      const baseElev =
        elevNoise.fbm(x * 0.032 + 2.1, y * 0.032 + 7.7, 4) * 0.62 +
        detailNoise.fbm(x * 0.13, y * 0.13, 2) * 0.12 +
        0.1;
      const ridge = ridgeNoise.fbm(x * 0.05 + 13, y * 0.05 + 5, 3);

      const dEdge = Math.min(x, y, width - 1 - x, height - 1 - y);
      const edgeF = clamp(1 - dEdge / edgeBand, 0, 1);
      const mountainForce = Math.pow(edgeF, 1.7) * (0.34 + ridge * 1.2) +
        Math.max(0, ridge - 0.63) * 0.45 * (1 - centralSmooth);

      let e = baseElev + mountainForce;

      // 河谷略低
      const rc = riverCenter(y);
      const distRiver = Math.abs(x - rc);
      if (distRiver < 8) e -= (1 - distRiver / 8) * 0.06;

      // 中央壓平為平原
      const plainElev = 0.36 + detailNoise.at(x * 0.9, y * 0.9) * 0.05;
      e = e * (1 - centralSmooth) + plainElev * centralSmooth;
      e = clamp(e, 0.05, 1);

      elevation[i] = e;

      if (water[i]) {
        terrain[i] = 'water';
        continue;
      }

      // 渡口：沙洲淺灘
      let isFordTile = false;
      for (const ford of fords) {
        if ((y === ford.y || y === ford.y + 1) && x >= ford.x0 - 1 && x <= ford.x1 + 1) {
          isFordTile = true;
          break;
        }
      }
      if (isFordTile) {
        terrain[i] = 'sand';
        elevation[i] = 0.32;
        continue;
      }

      const hillField = ridgeNoise.fbm(x * 0.045 + 31, y * 0.045 + 17, 2);
      if (e > 0.72 && (1 - centralSmooth) > 0.55) {
        terrain[i] = 'mountain';
      } else if ((e > 0.57 && (1 - centralSmooth) > 0.4) || (hillField > 0.63 && e > 0.49 && (1 - centralSmooth) > 0.25)) {
        terrain[i] = 'hill';
      } else {
        const wd = distToWater[i];
        const moisture = moistureNoise.fbm(x * 0.06 + 4, y * 0.06 + 3, 3);
        const forestField = forestNoise.fbm(x * 0.05 + 7, y * 0.05 + 9, 3) + (moisture - 0.5) * 0.3;
        const r = hash2d(x, y, s + 13);
        if (wd === 1) {
          terrain[i] = r < 0.86 ? 'sand' : 'grass';
        } else if (wd === 2 && r < 0.52) {
          terrain[i] = 'sand';
        } else if (wd <= 4) {
          terrain[i] = 'fertile';
        } else if (wd <= 7 && moisture > 0.5) {
          terrain[i] = 'fertile';
        } else if (forestField > 0.585 && e > 0.33) {
          terrain[i] = 'forest';
        } else if (moisture > 0.52 && r < 0.32) {
          terrain[i] = 'forest';
        } else if (moisture > 0.56 && r < 0.55) {
          terrain[i] = 'fertile';
        } else {
          terrain[i] = 'grass';
        }
      }
    }
  }

  // 沙岸只允許臨水（避免內陸出現突兀沙塊）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (terrain[i] !== 'sand') continue;
      let nearWater = false;
      for (let dy = -2; dy <= 2 && !nearWater; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (water[idx(nx, ny)]) {
            nearWater = true;
            break;
          }
        }
      }
      if (!nearWater) terrain[i] = 'grass';
    }
  }

  // ─────────────────────────── 中央開局平原整理 ───────────────────────────
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      const cheb = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      if (cheb > centralRadius) continue;
      if (water[i]) continue;
      if (terrain[i] === 'mountain' || terrain[i] === 'hill' || terrain[i] === 'forest') {
        terrain[i] = 'grass';
      }
      if (terrain[i] !== 'sand') elevation[i] = 0.34 + hash2d(x, y, s + 31) * 0.02;
    }
  }

  // ─────────────────────────── 保證林地面積 ───────────────────────────
  const area = width * height;
  const countTerrain = (t: TerrainType): number => {
    let n = 0;
    for (let i = 0; i < area; i++) if (terrain[i] === t) n++;
    return n;
  };
  const ensureCluster = (t: TerrainType, targetCount: number, radius: number): void => {
    let guard = 0;
    while (countTerrain(t) < targetCount && guard < 220) {
      guard++;
      const gx = 6 + Math.floor(rng() * (width - 12));
      const gy = 6 + Math.floor(rng() * (height - 12));
      const cheb = Math.max(Math.abs(gx - cx), Math.abs(gy - cy));
      if (cheb < centralRadius + 3) continue;
      for (let y = gy - radius; y <= gy + radius; y++) {
        for (let x = gx - radius; x <= gx + radius; x++) {
          if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
          const i = idx(x, y);
          if (water[i]) continue;
          if (terrain[i] === 'mountain') continue;
          if (terrain[i] === 'sand') continue;
          const dist = Math.hypot(x - gx, y - gy);
          if (dist > radius) continue;
          if (hash2d(x, y, s + 97) < 0.82) {
            terrain[i] = t;
            elevation[i] = 0.36 + hash2d(x, y, s + 61) * 0.03;
          }
        }
      }
    }
  };
  ensureCluster('forest', Math.floor(area * 0.075), 2);
  ensureCluster('fertile', Math.floor(area * 0.1), 2);

  // ─────────────────────────── 保證可建面積 ───────────────────────────
  const countBuildable = (): number => {
    let n = 0;
    for (let i = 0; i < area; i++) if (BUILDABLE[terrain[i]]) n++;
    return n;
  };
  if (countBuildable() < area * 0.62) {
    const mountainTiles: number[] = [];
    for (let i = 0; i < area; i++) if (terrain[i] === 'mountain') mountainTiles.push(i);
    mountainTiles.sort((a, b) => {
      const ax = a % width;
      const ay = (a - ax) / width;
      const bx = b % width;
      const by = (b - bx) / width;
      return Math.max(Math.abs(ax - cx), Math.abs(ay - cy)) - Math.max(Math.abs(bx - cx), Math.abs(by - cy));
    });
    const needed = Math.ceil(area * 0.64) - countBuildable();
    for (let k = 0; k < needed && k < mountainTiles.length; k++) {
      const i = mountainTiles[k];
      terrain[i] = 'hill';
      elevation[i] = 0.6;
    }
  }

  // ─────────────────────────── 選擇出生點 ───────────────────────────
  const isBuildableTile = (x: number, y: number): boolean => BUILDABLE[terrain[idx(x, y)]];
  const findSpawn = (): { x: number; y: number } => {
    for (const half of [4, 3, 2, 1]) {
      let best: { x: number; y: number } | null = null;
      let bestScore = -Infinity;
      for (let y = half + 2; y < height - half - 2; y++) {
        for (let x = half + 2; x < width - half - 2; x++) {
          if (!isBuildableTile(x, y)) continue;
          let ok = true;
          for (let dy = -half; dy <= half && ok; dy++) {
            for (let dx = -half; dx <= half; dx++) {
              if (!isBuildableTile(x + dx, y + dy)) {
                ok = false;
                break;
              }
            }
          }
          if (!ok) continue;
          const cheb = Math.max(Math.abs(x - cx), Math.abs(y - cy));
          const wd = distToWater[idx(x, y)];
          const nearRiver1 = Math.max(0, 3 - Math.min(4, wd)); // 喜歡離水 2~4 格
          const score = cheb * 0.9 + Math.abs(wd - 3) * 1.1 - nearRiver1 * 0.5 + hash2d(x, y, s + 77) * 1.2;
          if (score < bestScore || best === null) {
            bestScore = score;
            best = { x, y };
          }
        }
      }
      if (best) return best;
    }
    return { x: Math.floor(cx), y: Math.floor(cy) };
  };
  const spawn = findSpawn();

  // spawn 周邊 7x7 清成平整草地（保留沃土），保證開局有足夠建地
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = spawn.x + dx;
      const y = spawn.y + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = idx(x, y);
      if (water[i]) continue;
      if (terrain[i] !== 'fertile' && terrain[i] !== 'sand') terrain[i] = 'grass';
      elevation[i] = 0.34;
    }
  }

  // ─────────────────────────── 輸出 Tile[] ───────────────────────────
  const tiles: Tile[] = new Array(area);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      let t = terrain[i];
      // 渡口格最終一律是沙岸（中央清整可能改動過）
      for (const ford of fords) {
        if ((y === ford.y || y === ford.y + 1) && x >= ford.x0 && x <= ford.x1) {
          t = 'sand';
          water[i] = 0;
          break;
        }
      }
      const e = t === 'water' ? 0.2 + Math.min(1, (waterDepth[i] === 255 ? 1 : waterDepth[i]) / MAX_WATER_DEPTH) * 0.12 : elevation[i];
      tiles[i] = {
        terrain: t,
        elevation: Number(clamp(e, 0.02, 1).toFixed(3)),
        variant: hash2d(x, y, s + 53),
        buildingId: -1,
        road: false,
      };
    }
  }

  return { width, height, tiles, spawn };
}

/** 建立一份空白（未遊玩）世界資料，供開新局使用 */
export function createTiles(seed: number): Tile[] {
  return generateWorld(seed).tiles;
}
