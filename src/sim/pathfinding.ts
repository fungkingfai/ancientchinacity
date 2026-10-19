/**
 * 道路路徑搜尋：A*（四方向）於道路格上。市民、搬運工與物流共用。
 *
 * 對外介面（保持不變，main / citizens / 其他模組依賴）：
 *   findRoadPath(state, start, goal): number[] | null
 *   roadAccessTiles(state, building): number[]
 *   findPathBetweenBuildings(state, fromId, toId): number[] | null
 *   buildingAnchorTile(state, building): number
 *   isBuildingConnected(state, building): boolean
 *
 * 擴充（只新增、不破壞）：
 *   roadTilesAroundFootprint(state, x, y, w, h)  擺放預檢用「任一外側道路格」
 *   findRoadPathToAny(state, start, goals)       多目標最近路徑（物流選最近倉庫／市集）
 *   nearestRoadTile(state, x, y)                 道路被拆後讓搬運工重新接路
 *   invalidatePathCache()                        道路變更時呼叫（擺放／拆除道路）
 *   isRoadTile(state, index)
 *
 * 效能：
 *   - A* + 二元堆，曼哈頓啟發式（四方向可採納）。
 *   - 單起點／單終點查詢有快取（道路變更或換局時失效）。
 *   - 多起點／多終點（建築臨路格通常 1~4 個）用一次搜尋完成，避免 O(n²) 次呼叫。
 */

import type { Building, GameState } from '../core/types';

// ─────────────────────────── 座標工具 ───────────────────────────

export function tileIndex(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

export function tileXY(state: GameState, index: number): { x: number; y: number } {
  return { x: index % state.width, y: Math.floor(index / state.width) };
}

export function inBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.width && y < state.height;
}

export function isRoadTile(state: GameState, index: number): boolean {
  return index >= 0 && index < state.tiles.length && state.tiles[index].road;
}

// ─────────────────────────── 建築臨路格 ───────────────────────────

/**
 * 建築佔地四周（正交、不含斜角）的道路格 index。
 * 供擺放預檢在還沒建立 Building 物件時使用。
 */
export function roadTilesAroundFootprint(
  state: GameState,
  x: number,
  y: number,
  w: number,
  h: number,
): number[] {
  const result: number[] = [];
  const pushIfRoad = (tx: number, ty: number): void => {
    if (!inBounds(state, tx, ty)) return;
    const idx = ty * state.width + tx;
    if (state.tiles[idx]?.road) result.push(idx);
  };
  for (let dx = 0; dx < w; dx++) {
    pushIfRoad(x + dx, y - 1);
    pushIfRoad(x + dx, y + h);
  }
  for (let dy = 0; dy < h; dy++) {
    pushIfRoad(x - 1, y + dy);
    pushIfRoad(x + w, y + dy);
  }
  return result;
}

/** 建築四周（正交）的道路格 */
export function roadAccessTiles(state: GameState, building: Building): number[] {
  return roadTilesAroundFootprint(state, building.x, building.y, building.w, building.h);
}

export function isBuildingConnected(state: GameState, building: Building): boolean {
  return roadAccessTiles(state, building).length > 0;
}

/** 離 (x,y) 最近的道路格；找不到回傳 -1。用於道路被拆後重新接路。 */
export function nearestRoadTile(state: GameState, x: number, y: number, maxRadius = 7): number {
  if (inBounds(state, x, y) && state.tiles[tileIndex(state, x, y)].road) {
    return tileIndex(state, x, y);
  }
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const tx = x + dx;
        const ty = y + dy;
        if (!inBounds(state, tx, ty)) continue;
        if (state.tiles[tileIndex(state, tx, ty)].road) return tileIndex(state, tx, ty);
      }
    }
  }
  return -1;
}

// ─────────────────────────── A* 核心 ───────────────────────────

const INF = 0x3fffffff;
/** 單起點／終點快取上限；超過就整批清空（查詢模式重複率高，成本低） */
const PATH_CACHE_LIMIT = 4096;

let cacheState: GameState | null = null;
const pathCache = new Map<number, number[] | null>();
/** 建築對建築的路徑快取（物流每 20 遊戲分鐘會重複查同一批建築對） */
const linkCache = new Map<string, number[] | null>();

function ensureCacheFor(state: GameState): void {
  if (cacheState !== state) {
    cacheState = state;
    pathCache.clear();
    linkCache.clear();
  }
}

/** 道路變更（鋪路／拆路）後呼叫，讓所有快取路徑失效 */
export function invalidatePathCache(): void {
  pathCache.clear();
  linkCache.clear();
}

export interface RoadPathHit {
  path: number[];
  /** 實際抵達的目標格（多目標時不一定是最後一個） */
  goal: number;
}

function manhattan(state: GameState, a: number, b: number): number {
  const ax = a % state.width;
  const ay = (a / state.width) | 0;
  const bx = b % state.width;
  const by = (b / state.width) | 0;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/**
 * 多起點／多終點的 A* 搜尋（四方向、只走道路格）。
 * - start 本身不強制是道路（市民／搬運工可能從建築錨點出發，下一步才接路）。
 * - goal 必須是道路格。
 * 回傳路徑包含起點與終點格 index。
 */
function searchRoads(state: GameState, starts: number[], goals: number[]): RoadPathHit | null {
  const { width, height, tiles } = state;
  const n = tiles.length;
  if (!n) return null;

  const validGoals: number[] = [];
  for (const g of goals) {
    if (g >= 0 && g < n && tiles[g].road) validGoals.push(g);
  }
  if (!validGoals.length) return null;

  const goalFlag = new Uint8Array(n);
  for (const g of validGoals) goalFlag[g] = 1;
  const singleGoal = validGoals.length === 1 ? validGoals[0] : -1;

  const gScore = new Int32Array(n).fill(INF);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  // 二元堆（惰性刪除：彈出時跳過 closed）
  const heapNode = new Int32Array(n + 1);
  const heapF = new Float64Array(n + 1);
  let heapSize = 0;

  const push = (node: number, f: number): void => {
    let i = heapSize++;
    heapNode[i] = node;
    heapF[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      const tn = heapNode[p];
      heapNode[p] = heapNode[i];
      heapNode[i] = tn;
      const tf = heapF[p];
      heapF[p] = heapF[i];
      heapF[i] = tf;
      i = p;
    }
  };

  const pop = (): number => {
    const top = heapNode[0];
    heapSize--;
    if (heapSize > 0) {
      heapNode[0] = heapNode[heapSize];
      heapF[0] = heapF[heapSize];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapSize && heapF[l] < heapF[m]) m = l;
        if (r < heapSize && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        const tn = heapNode[m];
        heapNode[m] = heapNode[i];
        heapNode[i] = tn;
        const tf = heapF[m];
        heapF[m] = heapF[i];
        heapF[i] = tf;
        i = m;
      }
    }
    return top;
  };

  const heuristic = (node: number): number => {
    if (singleGoal >= 0) return manhattan(state, node, singleGoal);
    let best = INF;
    for (const g of validGoals) {
      const d = manhattan(state, node, g);
      if (d < best) best = d;
    }
    return best;
  };

  for (const s of starts) {
    if (s < 0 || s >= n) continue;
    if (goalFlag[s]) return { path: [s], goal: s };
    if (gScore[s] === INF) {
      gScore[s] = 0;
      push(s, heuristic(s));
    }
  }
  if (heapSize === 0) return null;

  let found = -1;
  while (heapSize > 0) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (goalFlag[cur]) {
      found = cur;
      break;
    }
    const cx = cur % width;
    const cy = (cur / width) | 0;
    const g = gScore[cur] + 1;
    // 四方向：北、南、西、東
    for (let dir = 0; dir < 4; dir++) {
      let nb: number;
      if (dir === 0) {
        if (cy === 0) continue;
        nb = cur - width;
      } else if (dir === 1) {
        if (cy === height - 1) continue;
        nb = cur + width;
      } else if (dir === 2) {
        if (cx === 0) continue;
        nb = cur - 1;
      } else {
        if (cx === width - 1) continue;
        nb = cur + 1;
      }
      if (closed[nb] || !tiles[nb].road) continue;
      if (g < gScore[nb]) {
        gScore[nb] = g;
        prev[nb] = cur;
        push(nb, g + heuristic(nb));
      }
    }
  }

  if (found < 0) return null;
  const path: number[] = [];
  let cur = found;
  while (cur !== -1) {
    path.push(cur);
    cur = prev[cur];
    if (path.length > n) return null; // 防禦：不應發生
  }
  path.reverse();
  return { path, goal: found };
}

// ─────────────────────────── 對外查詢 ───────────────────────────

/**
 * 找最短路徑（回傳包含起點與終點的格 index）。
 * start 可不為道路（例如建築錨點）；goal 必須是道路格。
 */
export function findRoadPath(state: GameState, start: number, goal: number): number[] | null {
  const n = state.tiles.length;
  if (start < 0 || start >= n || goal < 0 || goal >= n) return null;
  if (start === goal) return [start];
  ensureCacheFor(state);
  const key = start * n + goal;
  if (pathCache.has(key)) return pathCache.get(key) ?? null;
  const result = searchRoads(state, [start], [goal]);
  const path = result ? result.path : null;
  if (pathCache.size >= PATH_CACHE_LIMIT) pathCache.clear();
  pathCache.set(key, path);
  return path;
}

/**
 * 從 start 前往 goals 中「最近」的一個（物流找最近倉庫／市集用）。
 * 回傳路徑與實際抵達的目標格；無路可通回傳 null。
 */
export function findRoadPathToAny(state: GameState, start: number, goals: number[]): RoadPathHit | null {
  const n = state.tiles.length;
  if (start < 0 || start >= n || !goals.length) return null;
  return searchRoads(state, [start], goals);
}

/**
 * 兩棟建築之間經由道路的最短路徑（會各自接上最近的臨路格）。
 * 回傳路徑的第一格是 from 的臨路格、最後一格是 to 的臨路格。
 * 結果有快取（建築 id 唯一遞增，道路變更／換局時失效）。
 */
export function findPathBetweenBuildings(state: GameState, fromId: number, toId: number): number[] | null {
  const from = state.buildings.find((b) => b.id === fromId);
  const to = state.buildings.find((b) => b.id === toId);
  if (!from || !to) return null;
  ensureCacheFor(state);
  const key = `${fromId}:${toId}`;
  if (linkCache.has(key)) return linkCache.get(key) ?? null;
  const starts = roadAccessTiles(state, from);
  const goals = roadAccessTiles(state, to);
  if (!starts.length || !goals.length) {
    if (linkCache.size >= PATH_CACHE_LIMIT) linkCache.clear();
    linkCache.set(key, null);
    return null;
  }
  const result = searchRoads(state, starts, goals);
  const path = result?.path ?? null;
  if (linkCache.size >= PATH_CACHE_LIMIT) linkCache.clear();
  linkCache.set(key, path);
  return path;
}

/** 取得一棟建築的「物流錨點」：第一個臨路格，沒有則回傳建築中心格 */
export function buildingAnchorTile(state: GameState, building: Building): number {
  const access = roadAccessTiles(state, building);
  if (access.length) return access[0];
  return tileIndex(
    state,
    Math.min(state.width - 1, building.x + Math.floor(building.w / 2)),
    Math.min(state.height - 1, building.y + Math.floor(building.h / 2)),
  );
}
