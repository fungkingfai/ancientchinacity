/**
 * 生產系統：每日結算生產建築的產出、投入與本地暫存。
 *
 * 對外契約：tickProduction(state, ctx): void（每日一次，由 simulation.ts 呼叫）
 *
 * 規則（與 docs/ARCHITECTURE.md、logistics-dev 的約定一致）
 * 1. 只有 `active && connected` 的生產建築才會營運。
 * 2. 效率 = 工人比例（workers.length / def.workers）；無工人即停工。
 * 3. 倍率：季節（production.seasonBonus，未設定時糧食沿用 SEASON_FARM_BONUS）
 *    × 天氣（production.weatherBonus，未設定時用 WEATHER_EFFECT.farm；室內作坊減半）
 *    × 地形（沃土種糧 +30%、林地伐木 +25%、丘陵採石／採茶 +20%、丘陵山地採鐵 +20~30%，
 *      以建築覆蓋格比例加權）。
 * 4. 需要 input 的作坊先從「自己的」building.inventory 扣料；不足則當日停產
 *    （物流會負責把原料補進生產建築，production 不主動向倉儲／市集領料）。
 * 5. 產出只寫入 building.inventory（本地暫存上限 30），不直接進倉儲、市集或國庫；
 *    搬運與銷售交由 logistics／finance 處理。
 */

import {
  BUILDINGS,
  SEASON_FARM_BONUS,
  WEATHER_EFFECT,
} from '../core/config';
import { hash2d } from '../core/rng';
import type { Building, GameState, ResourceKey, SimContext, TerrainType } from '../core/types';

/** 生產建築本地暫存上限（物流前來搬走前最多堆這麼多） */
export const PRODUCTION_LOCAL_CAP = 30;

/** 各類產出受地形加成的表：地形 → 加成比例 */
const TERRAIN_BONUS: Partial<Record<ResourceKey, Partial<Record<TerrainType, number>>>> = {
  grain: { fertile: 0.3 },
  wood: { forest: 0.25 },
  stone: { hill: 0.2 },
  iron: { hill: 0.2, mountain: 0.3 },
  tea: { hill: 0.2 },
};

/** 露天生產：天氣影響明顯；其餘（酒坊／織坊／鐵匠鋪）視為室內作坊，影響減弱 */
const OUTDOOR_OUTPUTS: ReadonlySet<ResourceKey> = new Set<ResourceKey>(['grain', 'wood', 'stone', 'iron', 'tea']);

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 工人比例 0..1 */
function workerRatio(building: Building, required: number): number {
  if (required <= 0) return 1;
  return Math.max(0, Math.min(1, building.workers.length / required));
}

/** 建築覆蓋範圍內的地形加成（以格數比例加權），回傳 ≥1 的乘數 */
function terrainMultiplier(state: GameState, building: Building, output: ResourceKey): number {
  const table = TERRAIN_BONUS[output];
  if (!table) return 1;
  let bonus = 0;
  let tiles = 0;
  for (let dy = 0; dy < building.h; dy++) {
    for (let dx = 0; dx < building.w; dx++) {
      const tx = building.x + dx;
      const ty = building.y + dy;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
      const tile = state.tiles[ty * state.width + tx];
      tiles++;
      bonus += table[tile.terrain] ?? 0;
    }
  }
  if (tiles === 0) return 1;
  return 1 + bonus / tiles;
}

/** 季節倍率 */
function seasonMultiplier(state: GameState, building: Building, output: ResourceKey): number {
  const production = BUILDINGS[building.key]?.production;
  if (!production) return 1;
  const explicit = production.seasonBonus?.[state.clock.season];
  if (typeof explicit === 'number') return explicit;
  // 未特別設定的糧食作物沿用全域農作倍率；其他產業不受季節影響
  if (output === 'grain') return SEASON_FARM_BONUS[state.clock.season];
  return 1;
}

/** 天氣倍率 */
function weatherMultiplier(state: GameState, building: Building, output: ResourceKey): number {
  const production = BUILDINGS[building.key]?.production;
  if (!production) return 1;
  const weather = state.clock.weather;
  const explicit = production.weatherBonus?.[weather];
  if (typeof explicit === 'number') return explicit;
  const farmEffect = WEATHER_EFFECT[weather].farm;
  if (OUTDOOR_OUTPUTS.has(output)) return farmEffect;
  // 室內作坊：天氣只透過原料／物流間接影響，數值影響減弱
  return 1 + (farmEffect - 1) * 0.25;
}

/** 在本地暫存中扣掉指定數量；不足回傳 false（不改動庫存） */
function tryConsumeLocal(building: Building, resource: ResourceKey, amount: number): boolean {
  if (amount <= 0) return true;
  const current = building.inventory[resource] ?? 0;
  if (current + 1e-6 < amount) return false;
  const left = current - amount;
  if (left <= 0.005) delete building.inventory[resource];
  else building.inventory[resource] = round2(left);
  return true;
}

/** 建築所有庫存（含投入原料）的總量；與物流的「本地暫存容量 30」一致 */
function inventoryTotal(building: Building): number {
  let total = 0;
  for (const key in building.inventory) {
    total += building.inventory[key as ResourceKey] ?? 0;
  }
  return total;
}

/** 寫入本地暫存（總量上限 PRODUCTION_LOCAL_CAP，回傳實際入庫量） */
function addToLocal(building: Building, resource: ResourceKey, amount: number): number {
  if (amount <= 0) return 0;
  const current = building.inventory[resource] ?? 0;
  const other = inventoryTotal(building) - current;
  const room = Math.max(0, PRODUCTION_LOCAL_CAP - other - current);
  const added = Math.min(room, amount);
  if (added <= 0) return 0;
  const next = current + added;
  building.inventory[resource] = next >= PRODUCTION_LOCAL_CAP - 0.005 ? PRODUCTION_LOCAL_CAP : round2(next);
  return added;
}

/** 每日生產結算 */
export function tickProduction(state: GameState, ctx: SimContext): void {
  const clock = state.clock;
  const stalled: string[] = [];

  for (const building of state.buildings) {
    if (!building.active) {
      building.productionProgress = 0;
      continue;
    }
    const def = BUILDINGS[building.key];
    const production = def?.production;
    if (!production) continue;

    // 生產建築必須連通道路，否則原料進不來、貨物出不去的
    if (!building.connected) {
      building.productionProgress = 0;
      stalled.push(def.name);
      continue;
    }

    const ratio = workerRatio(building, def.workers);
    if (ratio <= 0) {
      building.productionProgress = 0;
      stalled.push(def.name);
      continue;
    }

    // 需要原料者：先確認自己的本地庫存足量（不足則整批停產；物流負責補料）
    const inputDef = production.input;
    const inputNeed = inputDef ? inputDef.amountPerDay * ratio : 0;
    if (inputDef) {
      const have = building.inventory[inputDef.resource] ?? 0;
      if (have + 1e-6 < inputNeed) {
        building.productionProgress = 0;
        stalled.push(def.name);
        continue;
      }
    }

    // 本地暫存（含原料）已滿就先停手，避免白白吃掉原料；扣料後騰出的空間要一起算
    const roomAfterInput = PRODUCTION_LOCAL_CAP - (inventoryTotal(building) - inputNeed);
    if (roomAfterInput <= 0.01) {
      building.productionProgress = 0;
      continue;
    }

    // 扣投入原料
    if (inputDef && !tryConsumeLocal(building, inputDef.resource, inputNeed)) {
      building.productionProgress = 0;
      stalled.push(def.name);
      continue;
    }

    const seasonMult = seasonMultiplier(state, building, production.output);
    const weatherMult = weatherMultiplier(state, building, production.output);
    const terrainMult = terrainMultiplier(state, building, production.output);
    // 每日 ±7% 的穩定小波動（依建築與日期雜湊，可重現，讀檔後不變）
    const dailyNoise = 1 + (hash2d(building.id, clock.totalDays, state.seed) - 0.5) * 0.14;
    const potential = production.amountPerDay * ratio * seasonMult * weatherMult * terrainMult;
    const produced = potential * dailyNoise;

    const added = addToLocal(building, production.output, produced);
    building.productionProgress = Math.max(0, Math.min(1, potential / production.amountPerDay));

    // 本地暫存已滿：多餘產出只能浪費（等待搬運工清空）；只偶爾提醒
    if (added < produced - 0.01 && clock.totalDays % 6 === 0 && (building.id + clock.totalDays) % 6 === 0) {
      ctx.log(`「${def.name}」的本地暫存已滿，多餘${production.output === 'grain' ? '糧食' : '貨物'}只能先擱置。`, 'warn');
    }
  }

  // 停工提示：每 3 日彙總一次，避免每棟建築每天洗版
  if (stalled.length > 0 && clock.totalDays % 3 === 0) {
    const names = [...new Set(stalled)];
    const shown = names.slice(0, 3).join('、');
    const more = names.length > 3 ? ` 等 ${names.length} 類` : '';
    ctx.log(`${shown}${more}作坊停工：待補工人、原料或道路連通。`, 'warn');
  }
}
