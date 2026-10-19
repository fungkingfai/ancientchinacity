/**
 * 建築／道路的擺放與拆除規則（logistics-dev 擁有本檔）。
 *
 * main.ts 的 actions 與 city-view 的幽靈預覽直接呼叫這裡的函式，
 * 因此以下介面必須保持不變：
 *   canPlaceBuilding(state, key, x, y): PlaceResult
 *   placeBuilding(state, key, x, y): PlaceResult
 *   placeRoad(state, x, y): PlaceResult
 *   demolishAt(state, x, y): { ok, reason?, refund }
 *   demolishBuildingById(state, id): number
 *   updateConnectedBuildings(state): void
 *
 * 擺放規則（本檔集中管理，不改 core/config.ts）：
 *   1. 不可超出地圖、需在可建地形、格上不能已有建築或道路。
 *   2. 生產建築只能蓋在其 BuildingDef.production.allowedTerrain（例如農田＝沃土／平原、
 *      採石場＝丘陵、鐵礦場可蓋丘陵或山地）。鐵礦場是唯一允許佔用山地的建築。
 *   3. 需水建築（碼頭）必須臨水；需路建築（生產／商業／民生／倉儲／瓦房以上民居）
 *      必須至少有一側臨路才能擺放。茅屋、水井、涼亭與裝飾建築免臨路。
 *   4. 需人口解鎖（unlockPop）、需足夠銀兩；拆除退還 30% 造價（見 config）。
 *   5. 連通狀態：任一外側格有道路即 connected。道路連通是營運前提，
 *      因此需路建築未連路時 active=false（生產、市民就業等子系統會跳過）。
 */

import { BUILDINGS, DEMOLISH_REFUND_RATE, ROAD_COST, TERRAIN_INFO } from '../core/config';
import type { Building, GameState, PlaceResult, TerrainType } from '../core/types';
import { addCargo } from './logistics-inventory';
import {
  invalidatePathCache,
  isBuildingConnected,
  roadTilesAroundFootprint,
} from './pathfinding';

/** 一般地形是否可建造（與 TERRAIN_INFO.buildable 一致；山地／水域不可） */
const TERRAIN_BUILDABLE: Record<TerrainType, boolean> = {
  grass: true,
  fertile: true,
  forest: true,
  hill: true,
  mountain: false,
  water: false,
  sand: true,
};

/**
 * 免臨路建築：茅屋是開局起點、水井與涼亭屬民生小景。
 * 其餘未在 config 明示 needsRoad=false 的建築，預設都需臨路
 * （生產、商業、民生、倉儲、瓦房／宅院）。
 */
const ROAD_EXEMPT_KEYS = new Set(['hut', 'well', 'pavilion']);

/** 某建築種類是否需要臨路才能擺放／營運（含 config 明示值優先） */
export function buildingNeedsRoad(key: string): boolean {
  const def = BUILDINGS[key];
  if (!def) return false;
  if (typeof def.needsRoad === 'boolean') return def.needsRoad;
  if (def.category === 'decoration') return false;
  if (ROAD_EXEMPT_KEYS.has(key)) return false;
  return true;
}

/** 建築是否可營運（連路且非停擺）。物流／生產／人口子系統可共用。 */
export function isBuildingOperational(building: Building): boolean {
  return building.active && building.connected;
}

export function getBuildingAt(state: GameState, x: number, y: number): Building | null {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
  const id = state.tiles[y * state.width + x].buildingId;
  if (id < 0) return null;
  return state.buildings.find((b) => b.id === id) ?? null;
}

export function buildingFootprintTiles(state: GameState, x: number, y: number, w: number, h: number): number[] {
  const tiles: number[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return [];
      tiles.push(ty * state.width + tx);
    }
  }
  return tiles;
}

/** 建築四周（含斜角？否，正交）是否有水 */
function hasAdjacentWater(state: GameState, x: number, y: number, w: number, h: number): boolean {
  for (let dx = -1; dx <= w; dx++) {
    for (const ty of [y - 1, y + h]) {
      const tx = x + dx;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
      if (state.tiles[ty * state.width + tx].terrain === 'water') return true;
    }
  }
  for (let dy = -1; dy <= h; dy++) {
    for (const tx of [x - 1, x + w]) {
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
      if (state.tiles[ty * state.width + tx].terrain === 'water') return true;
    }
  }
  return false;
}

/** 目前總人口（用於解鎖判斷；stats 每幀更新，citizens 為權威資料） */
function populationOf(state: GameState): number {
  return Math.max(state.stats.population, state.citizens.length);
}

/** 生產建築的地形限制說明文字 */
function allowedTerrainLabel(def: { production?: { allowedTerrain?: TerrainType[] } }): string {
  const allowed = def.production?.allowedTerrain;
  if (!allowed || !allowed.length) return '';
  return allowed.map((t) => TERRAIN_INFO[t]?.name ?? t).join('／');
}

export function canPlaceBuilding(state: GameState, key: string, x: number, y: number): PlaceResult {
  const def = BUILDINGS[key];
  if (!def) return { ok: false, reason: '未知建築', cost: 0 };
  const [w, h] = def.size;
  if (x < 0 || y < 0 || x + w > state.width || y + h > state.height) {
    return { ok: false, reason: '超出地圖範圍', cost: def.cost };
  }
  if (state.finance.treasury < def.cost) {
    return { ok: false, reason: '銀兩不足', cost: def.cost };
  }
  if (populationOf(state) < def.unlockPop) {
    return { ok: false, reason: `人口達 ${def.unlockPop} 後解鎖`, cost: def.cost };
  }
  const tiles = buildingFootprintTiles(state, x, y, w, h);
  if (!tiles.length) return { ok: false, reason: '超出地圖範圍', cost: def.cost };

  const allowed = def.production?.allowedTerrain;
  const allowedSet = allowed && allowed.length ? new Set<TerrainType>(allowed) : null;
  for (const idx of tiles) {
    const tile = state.tiles[idx];
    // 生產建築可佔用其 allowedTerrain（鐵礦場因此能蓋在山地）；
    // 其餘地形仍需為一般可建地。
    const buildable = TERRAIN_BUILDABLE[tile.terrain] || (allowedSet?.has(tile.terrain) ?? false);
    if (!buildable) {
      return { ok: false, reason: `${def.name}不可建於${TERRAIN_INFO[tile.terrain]?.name ?? tile.terrain}`, cost: def.cost };
    }
    if (tile.buildingId >= 0) return { ok: false, reason: '此地已有建築', cost: def.cost };
    if (tile.road) return { ok: false, reason: '此處是道路', cost: def.cost };
    if (allowedSet && !allowedSet.has(tile.terrain)) {
      return {
        ok: false,
        reason: `${def.name}需建於${allowedTerrainLabel(def)}`,
        cost: def.cost,
      };
    }
  }
  if (def.needsWater && !hasAdjacentWater(state, x, y, w, h)) {
    return { ok: false, reason: '必須臨水建造', cost: def.cost };
  }
  if (buildingNeedsRoad(key) && roadTilesAroundFootprint(state, x, y, w, h).length === 0) {
    return { ok: false, reason: '需臨路而建（請先鋪設道路）', cost: def.cost };
  }
  return { ok: true, cost: def.cost };
}

export function placeBuilding(state: GameState, key: string, x: number, y: number): PlaceResult {
  const check = canPlaceBuilding(state, key, x, y);
  if (!check.ok) return check;
  const def = BUILDINGS[key];
  const [w, h] = def.size;
  const footprint = buildingFootprintTiles(state, x, y, w, h);
  const building: Building = {
    id: state.nextBuildingId++,
    key,
    x,
    y,
    w,
    h,
    active: true,
    connected: false,
    workers: [],
    residents: [],
    inventory: {},
    productionProgress: 0,
    level: 1,
    builtOnDay: state.clock.totalDays,
    incomeThisMonth: 0,
    expenseThisMonth: 0,
  };
  for (const idx of footprint) state.tiles[idx].buildingId = building.id;
  state.buildings.push(building);
  building.connected = isBuildingConnected(state, building);
  building.active = building.connected || !buildingNeedsRoad(key);
  state.finance.treasury -= def.cost;
  state.finance.expenseThisMonth += def.cost;
  return { ok: true, cost: def.cost };
}

export function placeRoad(state: GameState, x: number, y: number): PlaceResult {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return { ok: false, reason: '超出地圖範圍', cost: ROAD_COST };
  }
  const tile = state.tiles[y * state.width + x];
  if (tile.road) return { ok: false, reason: '已有道路', cost: ROAD_COST };
  if (tile.buildingId >= 0) return { ok: false, reason: '此處已有建築', cost: ROAD_COST };
  if (!TERRAIN_BUILDABLE[tile.terrain]) {
    return { ok: false, reason: '此地形不可鋪路', cost: ROAD_COST };
  }
  if (state.finance.treasury < ROAD_COST) return { ok: false, reason: '銀兩不足', cost: ROAD_COST };
  tile.road = true;
  state.finance.treasury -= ROAD_COST;
  state.finance.expenseThisMonth += ROAD_COST;
  invalidatePathCache();
  updateConnectedBuildings(state);
  return { ok: true, cost: ROAD_COST };
}

/** 拆除格上的建築或道路；回傳退還金額 */
export function demolishAt(state: GameState, x: number, y: number): { ok: boolean; reason?: string; refund: number } {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) {
    return { ok: false, reason: '超出地圖範圍', refund: 0 };
  }
  const tile = state.tiles[y * state.width + x];
  if (tile.buildingId >= 0) {
    const refund = demolishBuildingById(state, tile.buildingId);
    return { ok: true, refund };
  }
  if (tile.road) {
    const refund = Math.floor(ROAD_COST * DEMOLISH_REFUND_RATE);
    tile.road = false;
    state.finance.treasury += refund;
    invalidatePathCache();
    updateConnectedBuildings(state);
    return { ok: true, refund };
  }
  return { ok: false, reason: '此處沒有可拆除的建築', refund: 0 };
}

/** 拆除建築後，處理正在前往該建築的搬運工貨物（退回來源，避免貨物憑空消失） */
function reclaimCartsBoundTo(state: GameState, buildingId: number): void {
  if (!state.carts.length) return;
  const carts = state.carts;
  let write = 0;
  for (let i = 0; i < carts.length; i++) {
    const cart = carts[i];
    if (cart.toId !== buildingId) {
      carts[write++] = cart;
      continue;
    }
    // 目的地被拆：貨物退回來源（來源若也同時被拆，最後由清理流程處理）
    const from = state.buildings.find((b) => b.id === cart.fromId && b.id !== buildingId);
    if (from) addCargo(from, cart.resource, cart.amount);
    cart.done = true;
  }
  carts.length = write;
}

export function demolishBuildingById(state: GameState, id: number): number {
  const index = state.buildings.findIndex((b) => b.id === id);
  if (index < 0) return 0;
  const building = state.buildings[index];
  const def = BUILDINGS[building.key];
  const refund = Math.floor((def?.cost ?? 0) * DEMOLISH_REFUND_RATE);

  // 先回收在途貨物（此時建築還在 buildings 陣列中，來源查找要排除自己）
  reclaimCartsBoundTo(state, id);

  for (let yd = 0; yd < building.h; yd++) {
    for (let xd = 0; xd < building.w; xd++) {
      const tx = building.x + xd;
      const ty = building.y + yd;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
      const tile = state.tiles[ty * state.width + tx];
      if (tile.buildingId === building.id) tile.buildingId = -1;
    }
  }
  state.buildings.splice(index, 1);
  state.finance.treasury += refund;

  // 清理市民的住家與工作參照
  for (const citizen of state.citizens) {
    if (citizen.homeId === id) {
      citizen.homeId = -1;
      citizen.state = 'idle';
      citizen.targetId = -1;
      citizen.path = [];
      citizen.pathProgress = 0;
    }
    if (citizen.workId === id) citizen.workId = -1;
  }
  // 來源已被拆的在途搬運工：貨物照樣送往目的地（貨已上車），不強制取消
  invalidatePathCache();
  updateConnectedBuildings(state);
  return refund;
}

/** 重新計算每棟建築的道路連通狀態與營運旗標 */
export function updateConnectedBuildings(state: GameState): void {
  for (const building of state.buildings) {
    const connected = isBuildingConnected(state, building);
    building.connected = connected;
    building.active = connected || !buildingNeedsRoad(building.key);
  }
}
