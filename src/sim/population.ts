/**
 * 人口系統：每日結算（由 simulation.ts 於跨日時呼叫）
 *
 * 規格對齊 docs/GAME_DESIGN.md §4.1：
 *   - 開局 5 名流民（在 citizens.ts 首次 tick 建立）
 *   - 遷入：平均民心 ≥ 50 時，每個住宅空位有 p = clamp((民心−45)/100, 0, 0.4)
 *           機率遷入；每日上限 3 + floor(人口/50) 人；無家流民優先入住
 *   - 出生：民心 ≥ 65 且住宅有空位；每日每 100 居民約 0.4 名新生，
 *           新生兒直接以 16 歲青年出現（遊戲年僅 84 日）
 *   - 死亡：每日機率 0.0004 + max(0, age−55) × 0.00015；飢荒與低幸福加成
 *   - 遷出：民心 < 25 連續 3 日 → 每日 10% 機率搬走；無家者 5 日後離開
 *   - 上限 800 人；勞動年齡 16~60 歲
 *
 * 市民需求／通勤由 citizens.ts 處理；本檔只做人口與配置。
 * 保持 `tickPopulation(state, ctx)` 對外介面。
 */

import { BUILDINGS } from '../core/config';
import type { Building, Citizen, GameState, SimContext } from '../core/types';
import {
  MAX_POPULATION,
  averageHappiness,
  buildingCenter,
  canCommute,
  cachedBuilding,
  clamp,
  createCitizen,
  getCitizenCache,
  getExtras,
  housingCapacity,
  housingVacancies,
  randInt,
  randRange,
  refreshBuildingIndex,
  removeCitizen,
} from './citizen-common';

// ─────────────────────────── 每日人口結算 ───────────────────────────

export function tickPopulation(state: GameState, ctx: SimContext): void {
  const cache = getCitizenCache(state);
  refreshBuildingIndex(state, cache);

  reconcileAssignments(state, cache);

  // 每年 1 月 1 日全體長一歲（遊戲一年 = 84 日）
  if (state.clock.month === 1 && state.clock.day === 1) {
    for (const citizen of state.citizens) citizen.age = Math.min(110, citizen.age + 1);
  }

  assignHousing(state, cache);
  assignEmployment(state, cache);

  const deaths = processDeaths(state, cache);
  const births = processBirths(state, cache);
  const leavers = processEmigration(state, cache);
  const migrants = tryImmigration(state, cache);

  reportPopulationEvents(state, cache, ctx, { births, deaths, leavers, migrants });
}

// ─────────────────────────── 名單一致性 ───────────────────────────

/** 重建 residents／workers 與 citizen.homeId/workId 對應，去除無效與超額參照 */
function reconcileAssignments(state: GameState, cache: ReturnType<typeof getCitizenCache>): void {
  const citizenById = new Map<number, Citizen>();
  for (const c of state.citizens) citizenById.set(c.id, c);
  const buildingIds = new Set<number>();
  for (const b of state.buildings) buildingIds.add(b.id);

  for (const c of state.citizens) {
    if (c.homeId >= 0 && !buildingIds.has(c.homeId)) {
      c.homeId = -1;
      c.targetId = c.targetId === c.homeId ? -1 : c.targetId;
      if (c.state === 'home') c.state = 'idle';
    }
    if (c.workId >= 0 && !buildingIds.has(c.workId)) {
      c.workId = -1;
      if (c.state === 'working') c.state = 'idle';
    }
  }

  const homeLists = new Map<number, number[]>();
  const workLists = new Map<number, number[]>();
  for (const c of state.citizens) {
    if (c.homeId >= 0) {
      const list = homeLists.get(c.homeId) ?? [];
      list.push(c.id);
      homeLists.set(c.homeId, list);
    }
    if (c.workId >= 0) {
      const list = workLists.get(c.workId) ?? [];
      list.push(c.id);
      workLists.set(c.workId, list);
    }
  }

  for (const b of state.buildings) {
    const cap = housingCapacity(b);
    if (cap > 0) {
      const ids = (homeLists.get(b.id) ?? []).slice();
      while (ids.length > cap) {
        const id = ids.pop() as number;
        const c = citizenById.get(id);
        if (c) {
          c.homeId = -1;
          if (c.state === 'home') c.state = 'idle';
          if (c.targetId === b.id) c.targetId = -1;
        }
      }
      b.residents = ids;
    } else {
      for (const id of b.residents) {
        const c = citizenById.get(id);
        if (c && c.homeId === b.id) c.homeId = -1;
      }
      b.residents = [];
    }

    const wcap = BUILDINGS[b.key]?.workers ?? 0;
    if (wcap > 0) {
      const ids = (workLists.get(b.id) ?? []).slice();
      while (ids.length > wcap) {
        const id = ids.pop() as number;
        const c = citizenById.get(id);
        if (c) {
          c.workId = -1;
          if (c.state === 'working') c.state = 'idle';
          if (c.targetId === b.id) c.targetId = -1;
        }
      }
      b.workers = ids;
    } else {
      for (const id of b.workers) {
        const c = citizenById.get(id);
        if (c && c.workId === b.id) c.workId = -1;
      }
      b.workers = [];
    }
  }
}

// ─────────────────────────── 住宅分配 ───────────────────────────

/** 無家市民遷入最近的住宅空位（開局流民／住宅建成後即時反應） */
export function assignHousing(state: GameState, cache: ReturnType<typeof getCitizenCache>): number {
  const now = state.clock.minutes;
  const vacant: Building[] = [];
  for (const b of state.buildings) {
    const cap = housingCapacity(b);
    if (cap <= 0 || !b.active) continue;
    if (b.residents.length < cap) vacant.push(b);
  }
  if (!vacant.length) return 0;

  const homeless = state.citizens.filter((c) => c.homeId < 0);
  if (!homeless.length) return 0;

  let moved = 0;
  for (const citizen of homeless) {
    let best: Building | null = null;
    let bestDist = Infinity;
    for (const b of vacant) {
      if (b.residents.length >= housingCapacity(b)) continue;
      const center = buildingCenter(b);
      const dx = center.x - citizen.x;
      const dy = center.y - citizen.y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    if (!best) break;
    citizen.homeId = best.id;
    best.residents.push(citizen.id);
    citizen.happiness = clamp(citizen.happiness + 6, 0, 100);
    const extras = getExtras(cache, citizen, now);
    extras.pendingPlan = true;
    extras.busyUntil = now + randRange(30, 120);
    moved++;
  }
  return moved;
}

// ─────────────────────────── 就業分配 ───────────────────────────

/** 讓 16~60 歲無業市民投入可用職缺；優先離家近且道路可達的工作 */
export function assignEmployment(state: GameState, cache: ReturnType<typeof getCitizenCache>): number {
  const jobs: { building: Building; slots: number }[] = [];
  for (const b of state.buildings) {
    const def = BUILDINGS[b.key];
    if (!def || def.workers <= 0 || !b.active) continue;
    const slots = def.workers - b.workers.length;
    if (slots > 0) jobs.push({ building: b, slots });
  }
  if (!jobs.length) return 0;

  const unemployed = state.citizens.filter((c) => c.age >= 16 && c.age <= 60 && c.workId < 0);
  if (!unemployed.length) return 0;

  let hired = 0;
  for (const citizen of unemployed) {
    const home = cachedBuilding(cache, citizen.homeId);
    const homePos = home ? buildingCenter(home) : { x: citizen.x, y: citizen.y };
    const sorted = jobs
      .filter((j) => j.slots > 0)
      .sort((a, b) => {
        const ca = buildingCenter(a.building);
        const cb = buildingCenter(b.building);
        const da = (ca.x - homePos.x) ** 2 + (ca.y - homePos.y) ** 2;
        const db = (cb.x - homePos.x) ** 2 + (cb.y - homePos.y) ** 2;
        return da - db;
      })
      .slice(0, 4);

    for (const job of sorted) {
      if (!canCommute(state, cache, home, job.building)) continue;
      citizen.workId = job.building.id;
      job.building.workers.push(citizen.id);
      job.slots--;
      if (citizen.state === 'idle') citizen.state = 'home';
      const extras = getExtras(cache, citizen, state.clock.minutes);
      extras.pendingPlan = true;
      hired++;
      break;
    }
  }
  return hired;
}

// ─────────────────────────── 死亡 ───────────────────────────

function processDeaths(state: GameState, cache: ReturnType<typeof getCitizenCache>): number {
  const now = state.clock.minutes;
  const harsh = state.clock.season === 'winter' ? 1.15 : 1;
  const dead: Citizen[] = [];

  for (const citizen of state.citizens) {
    let p = 0.0004 + Math.max(0, citizen.age - 55) * 0.00015;
    const extras = getExtras(cache, citizen, now);
    if (extras.starveDays > 6) p += 0.02 * Math.min(5, extras.starveDays - 6);
    if (citizen.happiness < 20) p *= 1.4;
    p *= harsh;
    if (Math.random() < p) dead.push(citizen);
  }

  let count = 0;
  for (const citizen of dead) {
    removeCitizen(state, cache, citizen.id);
    count++;
  }
  return count;
}

// ─────────────────────────── 出生 ───────────────────────────

function processBirths(state: GameState, cache: ReturnType<typeof getCitizenCache>): number {
  const pop = state.citizens.length;
  if (pop >= MAX_POPULATION) return 0;
  const vacancies = housingVacancies(state).total;
  if (vacancies <= 0) return 0;
  if (averageHappiness(state) < 65) return 0;

  // 每 100 居民每日約 0.4 名新生
  const expected = pop * 0.004;
  let count = Math.floor(expected);
  if (Math.random() < expected - count) count++;
  count = Math.min(count, vacancies, MAX_POPULATION - pop, 4);
  if (count <= 0) return 0;

  const avg = averageHappiness(state);
  let born = 0;
  for (let i = 0; i < count; i++) {
    const candidates = state.buildings.filter((b) => {
      const cap = housingCapacity(b);
      return cap > 0 && b.active && b.residents.length < cap;
    });
    if (!candidates.length) break;
    const home = candidates[randInt(0, candidates.length - 1)];
    // 新生兒直接以 16 歲青年出現（象徵二代成年）
    createCitizen(state, cache, {
      age: 16,
      gender: Math.random() < 0.5 ? 'male' : 'female',
      homeId: home.id,
      happiness: clamp(avg + randRange(-5, 5), 40, 92),
      money: randRange(0, 10),
      food: 70,
      goods: 55,
      culture: 35,
      state: 'home',
    });
    born++;
  }
  return born;
}

// ─────────────────────────── 遷出 ───────────────────────────

function processEmigration(state: GameState, cache: ReturnType<typeof getCitizenCache>): number {
  const now = state.clock.minutes;
  const pop = state.citizens.length;
  if (pop === 0) return 0;
  const maxLeavers = Math.max(1, Math.floor(pop / 100));
  const leavers: Citizen[] = [];

  for (const citizen of state.citizens) {
    const extras = getExtras(cache, citizen, now);
    if (citizen.homeId < 0) extras.homelessDays++;
    else extras.homelessDays = 0;
    if (citizen.happiness < 25) extras.lowHappinessDays++;
    else extras.lowHappinessDays = 0;

    const suffers = extras.lowHappinessDays >= 3 || extras.homelessDays >= 5;
    if (!suffers) continue;
    if (leavers.length >= maxLeavers) continue;
    if (Math.random() < 0.1) leavers.push(citizen);
  }

  for (const citizen of leavers) removeCitizen(state, cache, citizen.id);
  return leavers.length;
}

// ─────────────────────────── 移民遷入 ───────────────────────────

/**
 * 每日移民：平均民心 ≥ 50 時，每個住宅空位有機率遷入；
 * 每日上限 3 + floor(人口/50)。回傳遷入人數。
 */
export function tryImmigration(state: GameState, cache: ReturnType<typeof getCitizenCache>): number {
  const pop = state.citizens.length;
  if (pop >= MAX_POPULATION) return 0;

  const { total: vacancies, houses } = housingVacancies(state);
  if (houses === 0 || vacancies <= 0) return 0;

  const happiness = averageHappiness(state);
  if (happiness < 50) return 0;

  const p = clamp((happiness - 45) / 100, 0, 0.4);
  let expected = 0;
  for (let i = 0; i < vacancies; i++) {
    if (Math.random() < p) expected++;
  }
  if (expected <= 0) return 0;

  const dailyCap = 3 + Math.floor(pop / 50);
  const count = Math.min(expected, dailyCap, vacancies, MAX_POPULATION - pop);
  if (count <= 0) return 0;

  const now = state.clock.minutes;
  let moved = 0;
  for (let i = 0; i < count; i++) {
    const candidates = state.buildings.filter((b) => {
      const cap = housingCapacity(b);
      return cap > 0 && b.active && b.residents.length < cap;
    });
    if (!candidates.length) break;
    const home = candidates[randInt(0, candidates.length - 1)];
    const citizen = createCitizen(state, cache, {
      age: randInt(16, 46),
      homeId: home.id,
      happiness: randRange(52, 68),
      money: randRange(8, 30),
      state: 'home',
    });
    const extras = getExtras(cache, citizen, now);
    extras.pendingPlan = false;
    extras.busyUntil = now + randRange(60, 220);
    moved++;
  }
  return moved;
}

// ─────────────────────────── 通知與里程碑 ───────────────────────────

interface PopulationEvents {
  births: number;
  deaths: number;
  leavers: number;
  migrants: number;
}

function reportPopulationEvents(
  state: GameState,
  cache: ReturnType<typeof getCitizenCache>,
  ctx: SimContext,
  events: PopulationEvents,
): void {
  const pop = state.citizens.length;

  if (events.migrants > 0 && state.clock.totalDays - cache.lastImmigrationToastDay >= 12) {
    cache.lastImmigrationToastDay = state.clock.totalDays;
    ctx.log(`聽聞古城安寧，${events.migrants} 名百姓遷入定居。`, 'good');
  }

  // 人口里程碑
  const milestones = [25, 50, 100, 200, 400, 600, 800];
  for (const threshold of milestones) {
    if (pop >= threshold && cache.populationMilestone < threshold) {
      cache.populationMilestone = threshold;
      ctx.log(`城內人口達到 ${threshold} 人，市井漸興。`, 'good');
      break;
    }
  }

  // 失業提醒（偶爾）
  if (pop >= 15) {
    let unemployed = 0;
    for (const c of state.citizens) if (c.age >= 16 && c.age <= 60 && c.workId < 0) unemployed++;
    if (unemployed / pop > 0.3 && state.clock.totalDays - cache.lastJobToastDay > 6) {
      cache.lastJobToastDay = state.clock.totalDays;
      ctx.log(`目前約有 ${unemployed} 名百姓找不到差事，多建生產與服務建築吧。`, 'warn');
    }
  }
}
