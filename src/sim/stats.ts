/**
 * 城市統計：每幀更新 state.stats，供 UI、財政與事件判斷使用。
 *
 * 統計欄位受 core/types.ts 的 GameStats 契約限制（不可自行新增欄位），
 * 因此另外提供幾個純查詢函式供 UI／事件使用（不寫入 state）。
 *
 * 效能：O(建築數 + 市民數 + 搬運工數)，每幀一次，皆為簡單加總；
 * 不做排序、不建立大型暫存陣列。
 */

import { BUILDINGS } from '../core/config';
import type { GameState, ResourceKey } from '../core/types';

/** 每人每日糧食需求（單位） */
export const FOOD_PER_CITIZEN_PER_DAY = 1;
/** 勞動年齡（GAME_DESIGN §4.1）：16～60 歲；兒童與老人不計失業 */
export const WORKING_AGE = 16;
export const RETIREMENT_AGE = 60;

/** 全城建築庫存中某資源的總量（不含搬運中的貨物） */
export function totalStored(state: GameState, resource: ResourceKey): number {
  let total = 0;
  for (const building of state.buildings) total += building.inventory[resource] ?? 0;
  return total;
}

/** 糧食安全天數：目前存糧可支撐幾日（無人口時回傳 Infinity） */
export function foodDaysLeft(state: GameState): number {
  const perDay = state.citizens.length * FOOD_PER_CITIZEN_PER_DAY;
  if (perDay <= 0) return Infinity;
  return state.stats.foodStored / perDay;
}

/** 就業率 0..1（就業 / 可就業人口） */
export function employmentRate(state: GameState): number {
  const labor = state.stats.employed + state.stats.unemployed;
  return labor > 0 ? state.stats.employed / labor : 0;
}

/** 更新每幀統計 */
export function updateStats(state: GameState): void {
  const { citizens, buildings, carts, stats, finance } = state;

  let households = 0;
  let jobs = 0;
  let foodStored = 0;
  for (const building of buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    if (def.housing > 0 && building.residents.length > 0) households++;
    // 職缺數：營運中工作建築的總容量（未連通路仍算職缺，只是無法營運）
    if (def.workers > 0 && building.active) jobs += def.workers;
    foodStored += building.inventory.grain ?? 0;
  }

  let employed = 0;
  let unemployed = 0;
  let homeless = 0;
  let happinessSum = 0;
  for (const citizen of citizens) {
    if (citizen.workId >= 0) employed++;
    else if (citizen.age >= WORKING_AGE && citizen.age <= RETIREMENT_AGE) unemployed++;
    if (citizen.homeId < 0) homeless++;
    happinessSum += citizen.happiness;
  }

  // 物流中的貨物（搬運工手上）
  let goodsInTransit = 0;
  for (const cart of carts) goodsInTransit += cart.amount;

  stats.population = citizens.length;
  stats.households = households;
  stats.jobs = jobs;
  stats.employed = employed;
  stats.unemployed = unemployed;
  stats.homeless = homeless;
  stats.happiness = citizens.length ? happinessSum / citizens.length : 70;
  stats.foodStored = Math.round(foodStored);
  stats.foodPerDay = Math.round(citizens.length * FOOD_PER_CITIZEN_PER_DAY * 10) / 10;
  stats.goodsInTransit = Math.round(goodsInTransit);
  stats.netIncome = finance.lastMonthIncome - finance.lastMonthExpense;
}
