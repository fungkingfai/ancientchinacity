/**
 * 市民行為：每幀狀態機、路徑移動、每日需求與幸福度、市集交易。
 *
 * 規格對齊 docs/GAME_DESIGN.md §4（game-designer 的設計文件）：
 *   作息：06:00 起床、07:00 出門、08:00–17:00 工作、17:00–19:00 下班購物／回家、
 *         22:00–06:00 睡眠（不移動，只讓走路中的人慢慢回家）。
 *   狀態：home → walking → working → walking → shopping → walking → home；
 *         無家可歸者 idle／wander（人口系統每日分配住宅與工作）。
 *   需求（每日 05:00 結算一次，0..100）：
 *     food    住宅在市集半徑內且市集有糧 → 消耗 1 糧（孩童 0.5）→ +12；
 *             否則全城有存糧 → 消耗少量 → 部分滿足 +6；否則 −18。
 *     goods   住宅在市集半徑內且市集有茶／酒／布 → 消耗 0.15 → +9；否則 −12。
 *     culture 住宅在寺廟或學堂半徑內（不疊加）→ +6；否則 −7。
 *   幸福度（§4.3）：base 45 + 需求分數 + 服務加成（同類取最近、上限 20）
 *     − 稅率懲罰 − 失業 − 無家 + 天氣 + 節慶（12 日線性衰減）− 破產；
 *     每日平滑：下降最多 6、上升最多 4。
 *
 * 與物流／經濟約定：
 *   - 只扣 market.inventory 的 grain／cloth／tea／wine；不生成貨物、不寫 state.carts、
 *     不寫倉儲／生產建築 inventory。
 *   - 購物金額寫入該建築 incomeThisMonth（economy 月結當商稅稅基；物流只讀市集庫存）。
 *
 * 保持 `tickCitizens(state, gameMinutes, ctx)` 對外介面。
 */

import { BUILDINGS, WEATHER_EFFECT } from '../core/config';
import type { Building, Citizen, GameState, ResourceKey, ServiceKind, SimContext } from '../core/types';
import { findRoadPath } from './pathfinding';
import {
  CITIZEN_SPEED,
  DAWN_HOUR,
  DEPART_HOUR,
  SLEEP_HOUR,
  WAKE_HOUR,
  WORK_END_HOUR,
  type CitizenActivity,
  type CitizenCache,
  type CitizenExtras,
  buildingCenter,
  buildingGoalTile,
  cachedBuilding,
  citizenStartTile,
  clamp,
  cityCenterAnchor,
  cityGrainReserve,
  consumeCityGrain,
  ensureInitialPopulation,
  getCitizenCache,
  getExtras,
  insideService,
  inventoryOf,
  markRoadsDirty,
  marketHasGoods,
  marketPurchase,
  randInt,
  randRange,
  refreshBuildingIndex,
  roadsList,
  servicePoints,
  takeInventory,
} from './citizen-common';
import { assignEmployment, assignHousing } from './population';

// ─────────────────────────── 主進入點 ───────────────────────────

export function tickCitizens(state: GameState, gameMinutes: number, ctx: SimContext): void {
  const cache = getCitizenCache(state);
  refreshBuildingIndex(state, cache);

  // 開局流民（僅新局第一次呼叫時）
  ensureInitialPopulation(state, cache, ctx);

  // 建築變動 → 立即重分配住宅／工作（玩家蓋房後流民馬上搬進去）
  if (state.buildings.length !== cache.lastBuildingCount) {
    cache.lastBuildingCount = state.buildings.length;
    markRoadsDirty(cache);
    assignHousing(state, cache);
    assignEmployment(state, cache);
  }

  // 每日黎明需求結算
  maybeSettleDailyNeeds(state, cache, ctx);

  // ── 移動與行為 ──
  const clock = state.clock;
  const hour = clock.hour;
  const isNight = hour >= SLEEP_HOUR || hour < WAKE_HOUR;
  const weatherMove = WEATHER_EFFECT[clock.weather]?.move ?? 1;
  const speed = CITIZEN_SPEED * weatherMove * (isNight ? 0.9 : 1);
  const step = speed * Math.max(0, gameMinutes);

  const total = state.citizens.length;
  if (total === 0) return;
  // 規劃預算：跟隨影格推進的遊戲時間放大，避免低 FPS（dt 大）時市民排不到行程而站著發呆
  let planBudget = clamp(Math.ceil((total * Math.max(0, gameMinutes)) / 320) + 18, 18, 64);
  const cursor = cache.planCursor;

  for (let k = 0; k < total; k++) {
    const citizen = state.citizens[(cursor + k) % total];
    const extras = getExtras(cache, citizen, clock.minutes);
    if (citizen.state === 'walking') {
      advanceWalker(state, cache, citizen, extras, step, ctx);
      continue;
    }
    if (!extras.pendingPlan && clock.minutes >= extras.busyUntil) extras.pendingPlan = true;
    if (extras.pendingPlan && clock.minutes >= extras.retryAt) {
      if (planBudget <= 0) continue;
      planBudget--;
      planCitizen(state, cache, citizen, extras);
    }
  }
  cache.planCursor = (cursor + 13) % total;
}

// ─────────────────────────── 每日需求結算 ───────────────────────────

function maybeSettleDailyNeeds(state: GameState, cache: CitizenCache, ctx: SimContext): void {
  const clock = state.clock;
  if (clock.hour < DAWN_HOUR) return;
  if (cache.needsDay === clock.totalDays) return;
  cache.needsDay = clock.totalDays;
  settleDailyNeeds(state, cache, ctx);
}

function settleDailyNeeds(state: GameState, cache: CitizenCache, ctx: SimContext): void {
  const clock = state.clock;
  const now = clock.minutes;
  const services = servicePoints(state, cache);
  const pop = state.citizens.length;
  if (pop === 0) return;

  const taxPenalty = state.finance.taxRate * 100 * 0.35;
  const weatherBonus = WEATHER_EFFECT[clock.weather]?.happiness ?? 0;
  const festivalBoost = Math.max(0, 12 - (clock.totalDays - state.finance.lastFestivalDay));
  const bankruptcyPen = state.finance.treasury < 0 ? 5 : 0;
  let hungry = 0;

  for (const citizen of state.citizens) {
    const extras = getExtras(cache, citizen, now);
    extras.ateToday = false;
    const home = cachedBuilding(cache, citizen.homeId);
    const pos = home ? buildingCenter(home) : { x: citizen.x, y: citizen.y };
    const nearby = scanNearbyServices(state, cache, services, pos.x, pos.y);

    // ── 糧食 ──
    const foodNeed = citizen.age < 12 ? 0.5 : 1;
    if (nearby.foodMarket && takeInventory(nearby.foodMarket, 'grain', foodNeed)) {
      citizen.needs.food = clamp(citizen.needs.food + 12, 0, 100);
      extras.ateToday = true;
    } else if (cityGrainReserve(state) >= 0.2 && consumeCityGrain(state, 0.4)) {
      // 住宅不在市集半徑內，但全城有存糧 → 自家囤糧，部分滿足
      citizen.needs.food = clamp(citizen.needs.food + 6, 0, 100);
      extras.ateToday = true;
    } else {
      citizen.needs.food = clamp(citizen.needs.food - 18, 0, 100);
    }

    // ── 日用品 ──
    let goodsConsumed = false;
    if (nearby.goodsMarket) {
      for (const resource of ['cloth', 'tea', 'wine'] as ResourceKey[]) {
        if (inventoryOf(nearby.goodsMarket, resource) >= 0.15) {
          takeInventory(nearby.goodsMarket, resource, 0.15);
          goodsConsumed = true;
          break;
        }
      }
    }
    citizen.needs.goods = clamp(citizen.needs.goods + (goodsConsumed ? 9 : -12), 0, 100);

    // ── 文化（寺廟或學堂，兩者不疊加）──
    citizen.needs.culture = clamp(citizen.needs.culture + (nearby.culture ? 6 : -7), 0, 100);

    // ── 私人錢財：就業者每日象徵性 +2 兩（不由國庫扣）──
    if (citizen.age >= 16 && citizen.age <= 60 && citizen.workId >= 0) citizen.money += 2;

    // ── 幸福度（docs/GAME_DESIGN.md §4.3）──
    const unemploymentPen = citizen.workId < 0 && citizen.age >= 16 && citizen.age <= 60 ? 8 : 0;
    const homelessPen = citizen.homeId < 0 ? 15 : 0;
    let target =
      45 +
      citizen.needs.food * 0.25 +
      citizen.needs.goods * 0.15 +
      citizen.needs.culture * 0.1 +
      Math.min(20, nearby.serviceHappiness) -
      taxPenalty -
      unemploymentPen -
      homelessPen +
      weatherBonus +
      festivalBoost -
      bankruptcyPen;
    target = clamp(target, 0, 100);
    // 下降快、上升慢，讓危機有感覺
    citizen.happiness = clamp(citizen.happiness + clamp(target - citizen.happiness, -6, 4), 0, 100);

    // 連續飢餓／低幸福天數（供人口系統判斷死亡、遷出）
    if (citizen.needs.food < 15) extras.starveDays = Math.min(30, extras.starveDays + 1);
    else extras.starveDays = 0;
    if (citizen.happiness < 25) extras.lowHappinessDays = Math.min(30, extras.lowHappinessDays + 1);
    else extras.lowHappinessDays = 0;

    if (citizen.needs.food < 20) hungry++;
  }

  // 糧食短缺警示（避免洗版）
  if (pop >= 6 && hungry / pop > 0.4 && clock.totalDays - cache.lastHungerToastDay >= 4) {
    cache.lastHungerToastDay = clock.totalDays;
    ctx.log('城中糧食短缺，百姓面有飢色——多加蓋農田、糧倉，並讓市集維持糧食庫存。', 'warn');
  }
}

// ─────────────────────────── 服務掃描 ───────────────────────────

interface NearbyServices {
  /** 半徑內最近、有糧的市集 */
  foodMarket: Building | null;
  /** 半徑內最近、有民生消費品（茶／酒／布）的市集 */
  goodsMarket: Building | null;
  /** 半徑內最近、有貨的市集（購物目標） */
  market: Building | null;
  /** 半徑內最近的寺廟或學堂（文化） */
  culture: Building | null;
  /** 幸福度服務加成（同類型取最近，上限 20） */
  serviceHappiness: number;
}

function scanNearbyServices(
  state: GameState,
  cache: CitizenCache,
  services: ReturnType<typeof servicePoints>,
  x: number,
  y: number,
): NearbyServices {
  const nearestByKind = new Map<ServiceKind, { building: Building; dist: number }>();
  for (const sp of services) {
    const building = sp.building;
    if (cache.byId.get(building.id) !== building) continue; // 已拆除
    if (!building.active) continue;
    if (!insideService(sp, x, y)) continue;
    const dist = (sp.x - x) ** 2 + (sp.y - y) ** 2;
    const prev = nearestByKind.get(sp.kind);
    if (!prev || dist < prev.dist) nearestByKind.set(sp.kind, { building, dist });
  }

  // 市集
  const marketEntry = nearestByKind.get('market');
  let foodMarket: Building | null = null;
  let goodsMarket: Building | null = null;
  if (marketEntry) {
    const building = marketEntry.building;
    if (inventoryOf(building, 'grain') >= 0.5) foodMarket = building;
    if (marketHasGoods(building)) goodsMarket = building;
  }

  // 文化：寺廟或學堂取最近
  const temple = nearestByKind.get('temple');
  const school = nearestByKind.get('school');
  let culture: Building | null = null;
  if (temple && school) culture = temple.dist <= school.dist ? temple.building : school.building;
  else if (temple) culture = temple.building;
  else if (school) culture = school.building;

  // 幸福度服務加成（茶館／客棧需有貨源才算）
  let serviceHappiness = 0;
  for (const [kind, entry] of nearestByKind) {
    const building = entry.building;
    if (kind === 'teahouse' && inventoryOf(building, 'tea') <= 0.2) continue;
    if (kind === 'inn' && inventoryOf(building, 'wine') <= 0.2) continue;
    serviceHappiness += BUILDINGS[building.key]?.service?.happiness ?? 0;
  }

  return {
    foodMarket,
    goodsMarket,
    market: foodMarket ?? goodsMarket,
    culture,
    serviceHappiness: Math.min(20, serviceHappiness),
  };
}

// ─────────────────────────── 路徑移動 ───────────────────────────

function advanceWalker(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  step: number,
  ctx: SimContext,
): void {
  const path = citizen.path;
  const last = path.length - 1;

  // 目標被拆除（放置系統通常已清掉，這裡保險處理）
  if (citizen.targetId >= 0 && !cachedBuilding(cache, citizen.targetId)) {
    citizen.path = [];
    citizen.pathProgress = 0;
    citizen.targetId = -1;
    citizen.state = 'idle';
    extras.activity = 'idle';
    extras.pendingPlan = true;
    extras.busyUntil = state.clock.minutes + randRange(10, 30);
    return;
  }

  if (last < 0) {
    arriveCitizen(state, cache, citizen, extras, ctx);
    return;
  }

  citizen.pathProgress += step;
  if (citizen.pathProgress >= last) {
    citizen.pathProgress = last;
    updatePositionOnPath(state, citizen);
    arriveCitizen(state, cache, citizen, extras, ctx);
    return;
  }
  if (citizen.pathProgress < 0) citizen.pathProgress = 0;
  updatePositionOnPath(state, citizen);
}

/** 依 path／pathProgress 更新市民格座標（格中心座標系：格 (tx,ty) 中心 = (tx+0.5,ty+0.5)） */
function updatePositionOnPath(state: GameState, citizen: Citizen): void {
  const path = citizen.path;
  const width = state.width;
  const last = path.length - 1;
  if (last < 0) return;
  const rawIndex = Math.floor(citizen.pathProgress);
  const index = clamp(rawIndex, 0, last);
  const t = clamp(citizen.pathProgress - index, 0, 1);
  const a = path[index];
  const b = path[Math.min(index + 1, last)];
  const ax = (a % width) + 0.5;
  const ay = Math.floor(a / width) + 0.5;
  if (b === a) {
    citizen.x = ax;
    citizen.y = ay;
    return;
  }
  const bx = (b % width) + 0.5;
  const by = Math.floor(b / width) + 0.5;
  citizen.x = ax + (bx - ax) * t;
  citizen.y = ay + (by - ay) * t;
}

// ─────────────────────────── 抵達 ───────────────────────────

function arriveCitizen(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  _ctx: SimContext,
): void {
  const now = state.clock.minutes;
  const target = cachedBuilding(cache, citizen.targetId);
  const activity = extras.activity;

  citizen.path = [];
  citizen.pathProgress = 0;

  if (activity === 'wander' || citizen.targetId < 0) {
    citizen.targetId = -1;
    citizen.state = 'idle';
    extras.activity = 'idle';
    extras.busyUntil = now + randRange(70, 170);
    return;
  }

  if (!target) {
    citizen.targetId = -1;
    citizen.state = 'idle';
    extras.activity = 'idle';
    extras.pendingPlan = true;
    extras.busyUntil = now + randRange(15, 40);
    return;
  }

  // 抵達建築：站到建築中心附近
  const center = buildingCenter(target);
  citizen.x = center.x + randRange(-0.25, 0.25);
  citizen.y = center.y + randRange(-0.25, 0.25);

  // 回到家
  if (target.id === citizen.homeId) {
    citizen.state = 'home';
    extras.activity = 'home';
    extras.busyUntil = homeDwellUntil(state, citizen);
    return;
  }

  // 抵達工作地
  if (target.id === citizen.workId) {
    citizen.state = 'working';
    extras.activity = 'work';
    extras.busyUntil = workEndMinute(state, citizen);
    return;
  }

  // 服務建築：市集／茶館／客棧購物
  const serviceKind = BUILDINGS[target.key]?.service?.kind;
  if (serviceKind === 'market') {
    performMarketShopping(citizen, target);
    citizen.state = 'shopping';
    extras.activity = 'shop';
    extras.busyUntil = now + randRange(18, 42);
    return;
  }
  if (serviceKind === 'teahouse' || serviceKind === 'inn') {
    performLeisureSpending(citizen, target, serviceKind);
    citizen.state = 'shopping';
    extras.activity = 'shop';
    extras.busyUntil = now + randRange(25, 55);
    return;
  }
  if (serviceKind === 'temple' || serviceKind === 'school' || serviceKind === 'pavilion' || serviceKind === 'well') {
    const gain = serviceKind === 'school' ? 12 : serviceKind === 'temple' ? 10 : 4;
    citizen.needs.culture = clamp(citizen.needs.culture + gain, 0, 100);
    citizen.happiness = clamp(citizen.happiness + 1, 0, 100);
    citizen.state = 'shopping';
    extras.activity = 'culture';
    extras.busyUntil = now + randRange(25, 55);
    return;
  }

  citizen.state = 'idle';
  extras.activity = 'idle';
  extras.busyUntil = now + randRange(30, 80);
}

/** 到市集購物：扣庫存、付 1.5 兩、記入市集本月收入（docs §4.4） */
function performMarketShopping(citizen: Citizen, market: Building): void {
  marketPurchase(citizen, market);
}

/** 到茶館／客棧消費：先確認店內有貨源，再收茶／酒資（§4.3 服務加成條件） */
function performLeisureSpending(citizen: Citizen, building: Building, kind: 'teahouse' | 'inn'): void {
  const resource: ResourceKey = kind === 'teahouse' ? 'tea' : 'wine';
  if (inventoryOf(building, resource) <= 0.2) return;
  if (citizen.money < 1.5 || citizen.needs.goods >= 92) return;
  citizen.money -= 1.5;
  building.incomeThisMonth += 1.5;
  citizen.needs.goods = clamp(citizen.needs.goods + (kind === 'inn' ? 12 : 8), 0, 100);
}

// ─────────────────────────── 行為規劃 ───────────────────────────

function atBuilding(citizen: Citizen, id: number): boolean {
  return citizen.state !== 'walking' && citizen.targetId === id;
}

/** 規劃下一個目的地（規格見 docs/GAME_DESIGN.md §4.4 行為時段表） */
function planCitizen(state: GameState, cache: CitizenCache, citizen: Citizen, extras: CitizenExtras): void {
  extras.pendingPlan = false;
  extras.retryAt = state.clock.minutes + 10;

  const clock = state.clock;
  const now = clock.minutes;
  const hour = clock.hour;
  const isNight = hour >= SLEEP_HOUR || hour < WAKE_HOUR;
  const home = cachedBuilding(cache, citizen.homeId);
  const work = cachedBuilding(cache, citizen.workId);
  const workOk = !!work && work.active && work.id !== home?.id;
  const inWorkWindow = hour >= DEPART_HOUR && hour < WORK_END_HOUR;

  // 1) 工作時段 → 上班
  if (workOk && inWorkWindow) {
    if (atBuilding(citizen, work.id)) {
      citizen.state = 'working';
      extras.activity = 'work';
      extras.busyUntil = workEndMinute(state, citizen);
      return;
    }
    if (tryGoTo(state, cache, citizen, extras, work, 'work')) return;
  }

  // 2) 有家
  if (home) {
    const atHome = atBuilding(citizen, home.id);

    // 夜間／清晨：在家（或回家準備）
    if (isNight || hour >= WORK_END_HOUR + 2 || hour < DEPART_HOUR) {
      if (!atHome) {
        if (tryGoTo(state, cache, citizen, extras, home, 'home')) return;
        extras.busyUntil = now + randRange(40, 90);
        return;
      }
      citizen.state = 'home';
      extras.activity = 'home';
      extras.busyUntil = homeDwellUntil(state, citizen);
      return;
    }

    // 白天（07:00–19:00）：住宅附近的服務
    const pos = buildingCenter(home);
    const nearby = scanNearbyServices(state, cache, servicePoints(state, cache), pos.x, pos.y);
    const justShopped = extras.activity === 'shop';

    // 17:00–19:00 下班後：30% 購物（需求低則一定去），其次文化行程，然後回家
    if (hour >= WORK_END_HOUR) {
      if (atHome) {
        citizen.state = 'home';
        extras.activity = 'home';
        extras.busyUntil = homeDwellUntil(state, citizen);
        return;
      }
      const canShop = !!nearby.market && citizen.money >= 1.5 && !justShopped;
      const wantShop =
        canShop && (citizen.needs.food < 55 || citizen.needs.goods < 55 || Math.random() < 0.3);
      if (wantShop) {
        if (tryGoTo(state, cache, citizen, extras, nearby.market as Building, 'shop')) return;
      }
      const wantCulture = !justShopped && nearby.culture && (citizen.needs.culture < 50 || Math.random() < 0.15);
      if (wantCulture) {
        if (tryGoTo(state, cache, citizen, extras, nearby.culture as Building, 'culture')) return;
      }
      if (tryGoTo(state, cache, citizen, extras, home, 'home')) return;
      extras.busyUntil = now + randRange(50, 110);
      return;
    }

    // 失業者／未上班時段（07:00–17:00）
    if (atHome) {
      if (citizen.needs.food < 55 && nearby.foodMarket) {
        if (tryGoTo(state, cache, citizen, extras, nearby.foodMarket, 'shop')) return;
      }
      if (citizen.needs.goods < 50 && citizen.money >= 1.5 && nearby.goodsMarket) {
        if (tryGoTo(state, cache, citizen, extras, nearby.goodsMarket, 'shop')) return;
      }
      if (citizen.needs.culture < 50 && nearby.culture) {
        if (tryGoTo(state, cache, citizen, extras, nearby.culture, 'culture')) return;
      }
      if (!workOk && planWander(state, cache, citizen, extras, home)) return;
      citizen.state = 'home';
      extras.activity = 'home';
      extras.busyUntil = now + randRange(60, 140);
      return;
    }

    // 人在外面（例如失業者逛街後）
    if (!workOk) {
      if (planWander(state, cache, citizen, extras, home)) return;
    } else if (tryGoTo(state, cache, citizen, extras, home, 'home')) {
      return;
    }
    extras.busyUntil = now + randRange(50, 120);
    return;
  }

  // 3) 無家可歸
  if (workOk && inWorkWindow) {
    if (tryGoTo(state, cache, citizen, extras, work, 'work')) return;
  }
  if (!isNight && planWander(state, cache, citizen, extras, null)) return;

  // 夜宿街頭（在城中心附近休息）
  const anchor = cityCenterAnchor(state, cache);
  citizen.targetId = -1;
  citizen.path = [];
  citizen.pathProgress = 0;
  citizen.state = 'idle';
  citizen.x = clamp(anchor.x + randRange(-2, 2), 1, state.width - 1);
  citizen.y = clamp(anchor.y + randRange(-2, 2), 1, state.height - 1);
  extras.activity = 'idle';
  extras.busyUntil = now + randRange(200, 420);
}

/** 沿道路走到目標建築 */
function tryGoTo(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  target: Building,
  activity: CitizenActivity,
): boolean {
  const now = state.clock.minutes;
  const start = citizenStartTile(state, cache, citizen);
  const goal = buildingGoalTile(state, cache, target);
  if (start < 0 || goal < 0) {
    extras.retryAt = now + randRange(45, 120);
    return false;
  }
  const path = findRoadPath(state, start, goal);
  if (!path) {
    extras.retryAt = now + randRange(60, 180);
    return false;
  }
  citizen.state = 'walking';
  citizen.path = path;
  citizen.pathProgress = 0;
  citizen.targetId = target.id;
  extras.activity = activity;
  const first = path[0];
  citizen.x = (first % state.width) + 0.5;
  citizen.y = Math.floor(first / state.width) + 0.5;
  return true;
}

/** 在附近道路隨機漫步（失業者、無家者） */
function planWander(
  state: GameState,
  cache: CitizenCache,
  citizen: Citizen,
  extras: CitizenExtras,
  around: Building | null,
): boolean {
  const now = state.clock.minutes;
  const roads = roadsList(state, cache);

  if (!roads.length) {
    // 尚無道路：在城中心空地上踱步
    const anchor = cityCenterAnchor(state, cache);
    citizen.targetId = -1;
    citizen.path = [];
    citizen.pathProgress = 0;
    citizen.state = 'idle';
    citizen.x = clamp(anchor.x + randRange(-3, 3), 1, state.width - 1);
    citizen.y = clamp(anchor.y + randRange(-3, 3), 1, state.height - 1);
    extras.activity = 'wander';
    extras.busyUntil = now + randRange(80, 200);
    return true;
  }

  const start = citizenStartTile(state, cache, citizen);
  if (start < 0) return false;

  const center = around ? buildingCenter(around) : cityCenterAnchor(state, cache);
  let goal = -1;
  for (let attempt = 0; attempt < 12; attempt++) {
    const idx = roads[randInt(0, roads.length - 1)];
    const tx = (idx % state.width) + 0.5;
    const ty = Math.floor(idx / state.width) + 0.5;
    if ((tx - center.x) ** 2 + (ty - center.y) ** 2 > 13 * 13) continue;
    goal = idx;
    break;
  }
  if (goal < 0) goal = roads[randInt(0, roads.length - 1)];

  const path = findRoadPath(state, start, goal);
  if (!path) {
    extras.retryAt = now + randRange(60, 150);
    return false;
  }
  citizen.state = 'walking';
  citizen.path = path;
  citizen.pathProgress = 0;
  citizen.targetId = -1;
  extras.activity = 'wander';
  const first = path[0];
  citizen.x = (first % state.width) + 0.5;
  citizen.y = Math.floor(first / state.width) + 0.5;
  return true;
}

// ─────────────────────────── 作息時間 ───────────────────────────

/** 下班時間（絕對遊戲分鐘，17:00 + 每家一點隨機） */
function workEndMinute(state: GameState, citizen: Citizen): number {
  const clock = state.clock;
  const dayStart = (clock.totalDays - 1) * 1440;
  const end = dayStart + WORK_END_HOUR * 60 + citizen.look * 25;
  return Math.max(end, clock.minutes + 15);
}

/**
 * 待在家裡要待到什麼時候（絕對遊戲分鐘）：
 *   清晨 → 起床 06:00~06:40，有工作的人 07:00~07:50 出門
 *   晚上（17:00 後）→ 明晨起床
 *   失業者白天待在家一小時左右再出門
 */
function homeDwellUntil(state: GameState, citizen: Citizen): number {
  const clock = state.clock;
  const now = clock.minutes;
  const hour = clock.hour;
  const dayStart = (clock.totalDays - 1) * 1440;
  const hasWork = citizen.workId >= 0;
  const wake = dayStart + WAKE_HOUR * 60 + citizen.look * 40;
  const leave = dayStart + DEPART_HOUR * 60 + citizen.look * 50;

  if (hour < DEPART_HOUR) {
    if (now < wake) return wake;
    if (hasWork && now < leave) return leave;
    if (!hasWork) return now + randRange(60, 140);
    return now + 15;
  }
  if (hour >= WORK_END_HOUR) {
    return dayStart + 1440 + WAKE_HOUR * 60 + citizen.look * 40;
  }
  if (!hasWork) return now + randRange(60, 140);
  return now + 20;
}
