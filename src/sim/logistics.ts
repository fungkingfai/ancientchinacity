/**
 * 物流系統（logistics-dev）：
 *
 *   生產建築（本地暫存上限 30）──搬運工──▶ 糧倉／貨棧
 *   糧倉／貨棧 ──搬運工──▶ 市集（補貨架：糧食、茶葉、酒、布帛）
 *   糧倉／貨棧 ──搬運工──▶ 茶館（茶葉）／客棧（酒）／生產建築（投入：糧食、鐵礦）
 *   糧倉／貨棧 ──搬運工──▶ 碼頭（每 3 日出口多餘貨物，抵達時換銀兩）
 *
 * 若尚未建設任何倉儲，物流會 fallback 由生產建築直接送貨到市集／茶館／客棧，
 * 讓開局（只有農田＋茅屋）也能運作。
 *
 * 規則：
 *   - 所有移動都是實際庫存加減：派遣時就從來源扣除、抵達時加到目的建築。
 *   - 目的建築容量會扣除「已派車在途」的預留量，避免超收。
 *   - 搬運工（state.carts）沿道路 path 前進，速度受天氣 WEATHER_EFFECT.move 影響；
 *     道路中途被拆會自動重新尋路，無路可走則把貨物退回來源。
 *   - 同時最多 40 台，每 20 遊戲分鐘最多派遣 8 台，避免爆炸。
 *
 * economy-dev 資料約定：
 *   - production 只寫 building.inventory（本系統負責搬走）。
 *   - 茶館／客棧消耗自己 inventory 的茶葉／酒（本系統補貨）。
 *   - 碼頭出口只寫 finance.treasury 與 dock.incomeThisMonth（economy 月結算不再重複入帳）。
 *
 * 保持 `tickLogistics(state, gameMinutes, ctx)` 介面。
 */

import { BUILDINGS, MINUTES_PER_DAY, RESOURCES, WEATHER_EFFECT } from '../core/config';
import type { Building, Cart, GameState, ResourceKey, SimContext } from '../core/types';
import {
  MARKET_GOODS,
  MARKET_SHELF_TARGETS,
  PRODUCER_LOCAL_CAP,
  SERVICE_STOCK_CAP,
  accepts,
  addCargo,
  capacityOf,
  freeCapacityFor,
  isProducer,
  isStorage,
  removeCargo,
  roundQty,
  serviceKindOf,
  stockOf,
} from './logistics-inventory';
import {
  findPathBetweenBuildings,
  findRoadPathToAny,
  nearestRoadTile,
  roadAccessTiles,
  tileXY,
} from './pathfinding';

export { updateConnectedBuildings as updateConnectivity } from './placement';

// ─────────────────────────── 參數 ───────────────────────────

/** 每台搬運工的載貨上限（單位） */
export const CART_CAPACITY = 20;
/** 同時最多幾台搬運工（30~50 之間，取 40） */
export const MAX_CARTS = 40;
/** 一次派車的最少載量；太少不值得派 */
const MIN_LOAD = 3;
/** 搬運工速度：格／遊戲分鐘（會乘上天氣 move 倍率） */
const CART_SPEED = 0.55;
/** 每 20 遊戲分鐘評估一次派遣（1 倍速下約 0.4 真實秒） */
const DISPATCH_INTERVAL = 20;
/** 每次派遣週期最多派出幾台，避免一次爆量 */
const MAX_DISPATCH_PER_CYCLE = 8;
/** 生產建築投入物（酒坊糧食、鐵匠鋪鐵礦）的備料目標 */
const PRODUCER_INPUT_TARGET = Math.min(PRODUCER_LOCAL_CAP - 6, 20);
/** 茶館茶葉／客棧酒的備料目標 */
const SERVICE_STOCK_TARGET = Math.min(SERVICE_STOCK_CAP - 6, 12);
/** 碼頭出口週期：每 3 遊戲日一次 */
const EXPORT_INTERVAL = MINUTES_PER_DAY * 3;
/** 每次出口最多派幾台車 */
const EXPORT_MAX_PER_CYCLE = 4;

// ─────────────────────────── 執行期暫存 ───────────────────────────

interface LogisticsRuntime {
  dispatchTimer: number;
  exportTimer: number;
  /** destinationId → resource → 已在途、尚未抵達的入庫量（容量預留） */
  reserved: Map<number, Partial<Record<ResourceKey, number>>>;
  /** 上次碼頭出口訊息（每日最多一則，避免洗頻） */
  lastExportLogDay: number;
}

/** 以 GameState 為 key：換局／讀檔後自動重建，不污染存檔 */
const runtimes = new WeakMap<GameState, LogisticsRuntime>();

function runtimeOf(state: GameState): LogisticsRuntime {
  let rt = runtimes.get(state);
  if (!rt) {
    rt = {
      dispatchTimer: 0,
      exportTimer: 0,
      reserved: new Map(),
      lastExportLogDay: -999,
    };
    runtimes.set(state, rt);
  }
  return rt;
}

function reservedIn(rt: LogisticsRuntime, buildingId: number, resource: ResourceKey): number {
  return rt.reserved.get(buildingId)?.[resource] ?? 0;
}

function reservedTotalFor(rt: LogisticsRuntime, buildingId: number): number {
  const map = rt.reserved.get(buildingId);
  if (!map) return 0;
  let total = 0;
  for (const key in map) total += map[key as ResourceKey] ?? 0;
  return total;
}

function addReserved(rt: LogisticsRuntime, buildingId: number, resource: ResourceKey, amount: number): void {
  if (!(amount > 0)) return;
  let map = rt.reserved.get(buildingId);
  if (!map) {
    map = {};
    rt.reserved.set(buildingId, map);
  }
  map[resource] = roundQty((map[resource] ?? 0) + amount);
}

function releaseReserved(rt: LogisticsRuntime, buildingId: number, resource: ResourceKey, amount: number): void {
  const map = rt.reserved.get(buildingId);
  if (!map) return;
  const left = roundQty((map[resource] ?? 0) - amount);
  if (left > 0.05) map[resource] = left;
  else delete map[resource];
  let empty = true;
  for (const key in map) {
    empty = false;
    break;
  }
  if (empty) rt.reserved.delete(buildingId);
}

// ─────────────────────────── 小工具 ───────────────────────────

function findBuilding(state: GameState, id: number): Building | undefined {
  return state.buildings.find((b) => b.id === id);
}

/** 建築是否正常營運（active 且連路；placement 會維護這兩個旗標） */
function isOperating(building: Building): boolean {
  return building.active && building.connected;
}

/**
 * 目的建築對某資源還可收多少（已扣在途預留）。
 * 倉儲／市集以總容量計算；生產／服務建築以單一資源上限計算（見 logistics-inventory）。
 */
function roomFor(rt: LogisticsRuntime, building: Building, resource: ResourceKey): number {
  if (isStorage(building)) {
    return freeCapacityFor(building, resource, reservedTotalFor(rt, building.id));
  }
  return freeCapacityFor(building, resource, reservedIn(rt, building.id, resource));
}

function isMarket(building: Building): boolean {
  return serviceKindOf(building) === 'market';
}

function isDock(building: Building): boolean {
  return serviceKindOf(building) === 'dock';
}

/** 由 source 前往候選建築中「道路距離最近」的一棟；找不到回傳 null */
function nearestReachable(
  state: GameState,
  source: Building,
  candidates: Building[],
): { building: Building; path: number[] } | null {
  let best: { building: Building; path: number[] } | null = null;
  for (const candidate of candidates) {
    if (candidate.id === source.id) continue;
    const path = findPathBetweenBuildings(state, source.id, candidate.id);
    if (!path || !path.length) continue;
    if (!best || path.length < best.path.length) best = { building: candidate, path };
  }
  return best;
}

/** 可作為某資源來源的建築（倉儲有存貨，或生產該資源的生產建築有本地暫存） */
function sourceCandidates(state: GameState, resource: ResourceKey): Building[] {
  const result: Building[] = [];
  for (const building of state.buildings) {
    if (!isOperating(building)) continue;
    if (stockOf(building, resource) < MIN_LOAD) continue;
    // 市集是消費端貨架，不作為物流來源（避免貨架貨物被搬來搬去）
    if (isMarket(building)) continue;
    if (isStorage(building)) {
      if (accepts(building, resource)) result.push(building);
      continue;
    }
    const def = BUILDINGS[building.key];
    if (def?.production?.output === resource) result.push(building);
  }
  return result;
}

/** 找最近的可供貨來源（倉儲優先級與生產者一起比較距離） */
function findSourceFor(
  state: GameState,
  target: Building,
  resource: ResourceKey,
): { building: Building; path: number[] } | null {
  if (!accepts(target, resource)) return null;
  return nearestReachable(state, target, sourceCandidates(state, resource));
}

// ─────────────────────────── 派車 ───────────────────────────

/**
 * 建立一台搬運工：先確認有路、再從來源扣貨，抵達時才入庫。
 * phase：'deliver' = 生產者送往倉儲；'pickup' = 由倉儲／生產者提貨送往市集等。
 */
function spawnCart(
  state: GameState,
  rt: LogisticsRuntime,
  from: Building,
  to: Building,
  resource: ResourceKey,
  amount: number,
  phase: Cart['phase'],
): Cart | null {
  if (state.carts.length >= MAX_CARTS) return null;
  const take = Math.min(amount, stockOf(from, resource));
  if (take < MIN_LOAD) return null;
  const path = findPathBetweenBuildings(state, from.id, to.id);
  if (!path || !path.length) return null;
  const removed = removeCargo(from, resource, take);
  if (removed < MIN_LOAD) {
    // 理論上不會發生（上面已檢查庫存），防禦性退回
    if (removed > 0) addCargo(from, resource, removed);
    return null;
  }
  // 目的地有容量者預留空間，避免多台車同時送達造成超收
  if (capacityOf(to) > 0) addReserved(rt, to.id, resource, removed);
  const start = tileXY(state, path[0]);
  const cart: Cart = {
    id: state.nextCartId++,
    resource,
    amount: roundQty(removed),
    capacity: CART_CAPACITY,
    fromId: from.id,
    toId: to.id,
    x: start.x,
    y: start.y,
    path,
    pathProgress: 0,
    phase,
    done: false,
  };
  state.carts.push(cart);
  return cart;
}

/** 搬運工完成：把貨物交給目的建築（碼頭則直接出口換銀兩） */
function completeCart(state: GameState, rt: LogisticsRuntime, cart: Cart, ctx: SimContext): void {
  const to = findBuilding(state, cart.toId);
  const from = findBuilding(state, cart.fromId);
  if (!to) {
    // 目的地被拆除：貨物退回來源（有空間的話）
    if (from) addCargo(from, cart.resource, cart.amount);
    releaseReserved(rt, cart.toId, cart.resource, cart.amount);
    return;
  }
  if (isDock(to)) {
    // 碼頭出口：以 RESOURCES 參考市價換銀兩（不經過庫存）
    const revenue = Math.round(cart.amount * RESOURCES[cart.resource].price);
    if (revenue > 0) {
      state.finance.treasury += revenue;
      to.incomeThisMonth = roundQty(to.incomeThisMonth + revenue);
      if (state.clock.totalDays - rt.lastExportLogDay >= 1) {
        rt.lastExportLogDay = state.clock.totalDays;
        ctx.log(
          `碼頭出口${RESOURCES[cart.resource].name} ${cart.amount} 單位，入帳 ${revenue} 兩。`,
          'good',
        );
      }
    }
    return;
  }
  releaseReserved(rt, to.id, cart.resource, cart.amount);
  const accepted = addCargo(to, cart.resource, cart.amount);
  if (accepted + 0.01 < cart.amount) {
    // 目的地臨時滿了：剩餘退回來源（再不行就損耗）
    const leftover = roundQty(cart.amount - accepted);
    if (from) addCargo(from, cart.resource, leftover);
  }
}

/** 取消搬運工：貨物退回來源 */
function cancelCart(state: GameState, rt: LogisticsRuntime, cart: Cart): void {
  const from = findBuilding(state, cart.fromId);
  if (from) addCargo(from, cart.resource, cart.amount);
  releaseReserved(rt, cart.toId, cart.resource, cart.amount);
  cart.done = true;
}

/** 道路被拆後重新接路；失敗則取消搬運工（貨物退回來源） */
function rerouteCart(state: GameState, rt: LogisticsRuntime, cart: Cart): void {
  const last = cart.path.length - 1;
  const currentIndex = cart.path[Math.max(0, Math.min(last, Math.floor(cart.pathProgress)))];
  const current = tileXY(state, currentIndex);
  const start = state.tiles[currentIndex]?.road
    ? currentIndex
    : nearestRoadTile(state, current.x, current.y, 6);
  if (start >= 0) {
    const to = findBuilding(state, cart.toId);
    const goals = to ? roadAccessTiles(state, to) : [];
    const hit = goals.length ? findRoadPathToAny(state, start, goals) : null;
    if (hit && hit.path.length) {
      cart.path = hit.path;
      cart.pathProgress = 0;
      const startXY = tileXY(state, hit.path[0]);
      cart.x = startXY.x;
      cart.y = startXY.y;
      return;
    }
  }
  cancelCart(state, rt, cart);
}

// ─────────────────────────── 移動 ───────────────────────────

function moveCarts(state: GameState, gameMinutes: number, rt: LogisticsRuntime, ctx: SimContext): void {
  if (!state.carts.length) return;
  const moveMultiplier = WEATHER_EFFECT[state.clock.weather]?.move ?? 1;
  const step = CART_SPEED * moveMultiplier * gameMinutes;
  const survivors: Cart[] = [];

  for (const cart of state.carts) {
    if (cart.done) continue;
    if (!cart.path.length) {
      completeCart(state, rt, cart, ctx);
      continue;
    }
    const last = cart.path.length - 1;
    const currentIndex = cart.path[Math.max(0, Math.min(last, Math.floor(cart.pathProgress)))];
    const nextIndex = Math.min(last, Math.floor(cart.pathProgress + step + 1e-6));
    const nextTile = state.tiles[cart.path[nextIndex]];

    // 前方道路被拆：重新尋路
    if (nextIndex !== currentIndex && !nextTile?.road) {
      rerouteCart(state, rt, cart);
      if (!cart.done) survivors.push(cart);
      continue;
    }

    cart.pathProgress += step;
    if (cart.pathProgress >= last) {
      const end = tileXY(state, cart.path[last]);
      cart.x = end.x;
      cart.y = end.y;
      completeCart(state, rt, cart, ctx);
      continue;
    }

    const i = Math.floor(cart.pathProgress);
    const t = cart.pathProgress - i;
    const a = tileXY(state, cart.path[i]);
    const b = tileXY(state, cart.path[i + 1]);
    cart.x = a.x + (b.x - a.x) * t;
    cart.y = a.y + (b.y - a.y) * t;
    survivors.push(cart);
  }
  state.carts = survivors;
}

// ─────────────────────────── 派遣：生產 → 倉儲 ───────────────────────────

function dispatchProducerOutput(
  state: GameState,
  rt: LogisticsRuntime,
  budget: number,
): number {
  let dispatched = 0;
  for (const producer of state.buildings) {
    if (dispatched >= budget || state.carts.length >= MAX_CARTS) break;
    if (!isOperating(producer) || !isProducer(producer)) continue;
    const def = BUILDINGS[producer.key];
    const production = def?.production;
    if (!production) continue;
    const resource = production.output;
    const available = stockOf(producer, resource);
    if (available < MIN_LOAD) continue;

    // 1) 送往有容量的倉儲（糧食可進糧倉或貨棧；其他只進貨棧）
    const storageCandidates: Building[] = [];
    for (const building of state.buildings) {
      if (building.id === producer.id) continue;
      if (!isStorage(building) || !isOperating(building)) continue;
      // 市集是貨架不是倉庫：只透過下面的「直接送市集」規則補民生資源
      if (isMarket(building)) continue;
      if (!accepts(building, resource)) continue;
      if (roomFor(rt, building, resource) < MIN_LOAD) continue;
      storageCandidates.push(building);
    }
    const storageHit = nearestReachable(state, producer, storageCandidates);
    if (storageHit) {
      const dest = storageHit.building;
      const space = roomFor(rt, dest, resource);
      const amount = Math.min(available, CART_CAPACITY, space);
      if (amount >= MIN_LOAD && spawnCart(state, rt, producer, dest, resource, amount, 'deliver')) {
        dispatched++;
        continue;
      }
    }

    // 2) 尚無倉儲（或倉儲已滿）時，民生資源直接送市集，讓開局物流不致中斷
    if (!MARKET_GOODS.includes(resource)) continue;
    const marketCandidates: Building[] = [];
    for (const building of state.buildings) {
      if (!isOperating(building) || !isMarket(building)) continue;
      const target = MARKET_SHELF_TARGETS[resource] ?? 0;
      const need =
        target - stockOf(building, resource) - reservedIn(rt, building.id, resource);
      if (need < MIN_LOAD) continue;
      if (roomFor(rt, building, resource) < MIN_LOAD) continue;
      marketCandidates.push(building);
    }
    const marketHit = nearestReachable(state, producer, marketCandidates);
    if (!marketHit) continue;
    const market = marketHit.building;
    const target = MARKET_SHELF_TARGETS[resource] ?? 0;
    const need = target - stockOf(market, resource) - reservedIn(rt, market.id, resource);
    const amount = Math.min(available, CART_CAPACITY, need, roomFor(rt, market, resource));
    if (amount >= MIN_LOAD && spawnCart(state, rt, producer, market, resource, amount, 'deliver')) {
      dispatched++;
    }
  }
  return dispatched;
}

// ─────────────────────────── 派遣：倉儲 → 市集 ───────────────────────────

function dispatchMarketRestock(state: GameState, rt: LogisticsRuntime, budget: number): number {
  let dispatched = 0;
  for (const market of state.buildings) {
    if (dispatched >= budget || state.carts.length >= MAX_CARTS) break;
    if (!isOperating(market) || !isMarket(market)) continue;
    for (const resource of MARKET_GOODS) {
      if (dispatched >= budget || state.carts.length >= MAX_CARTS) break;
      const target = MARKET_SHELF_TARGETS[resource] ?? 0;
      const need = target - stockOf(market, resource) - reservedIn(rt, market.id, resource);
      if (need < MIN_LOAD) continue;
      const source = findSourceFor(state, market, resource);
      if (!source) continue;
      const amount = Math.min(
        need,
        stockOf(source.building, resource),
        CART_CAPACITY,
        roomFor(rt, market, resource),
      );
      if (amount < MIN_LOAD) continue;
      if (spawnCart(state, rt, source.building, market, resource, amount, 'pickup')) dispatched++;
    }
  }
  return dispatched;
}

// ─────────────────────────── 派遣：倉儲 → 茶館／客棧／生產投入 ───────────────────────────

function dispatchServiceAndInputStock(
  state: GameState,
  rt: LogisticsRuntime,
  budget: number,
): number {
  let dispatched = 0;
  for (const building of state.buildings) {
    if (dispatched >= budget || state.carts.length >= MAX_CARTS) break;
    if (!isOperating(building)) continue;
    const def = BUILDINGS[building.key];
    if (!def) continue;

    // 茶館／客棧：補營運備料（茶葉／酒）
    const consumed = def.service?.consumes;
    if (consumed) {
      const need =
        SERVICE_STOCK_TARGET -
        stockOf(building, consumed.resource) -
        reservedIn(rt, building.id, consumed.resource);
      if (need >= MIN_LOAD) {
        const source = findSourceFor(state, building, consumed.resource);
        if (source) {
          const amount = Math.min(
            need,
            stockOf(source.building, consumed.resource),
            CART_CAPACITY,
            roomFor(rt, building, consumed.resource),
          );
          if (
            amount >= MIN_LOAD &&
            spawnCart(state, rt, source.building, building, consumed.resource, amount, 'pickup')
          ) {
            dispatched++;
            continue;
          }
        }
      }
    }

    // 生產建築：補投入物（酒坊糧食、鐵匠鋪鐵礦）
    const production = def.production;
    const input = production?.input;
    if (!input) continue;
    const resource = input.resource;
    const need =
      PRODUCER_INPUT_TARGET -
      stockOf(building, resource) -
      reservedIn(rt, building.id, resource);
    if (need < MIN_LOAD) continue;
    const source = findSourceFor(state, building, resource);
    if (!source) continue;
    const amount = Math.min(
      need,
      stockOf(source.building, resource),
      CART_CAPACITY,
      roomFor(rt, building, resource),
    );
    if (amount < MIN_LOAD) continue;
    if (spawnCart(state, rt, source.building, building, resource, amount, 'pickup')) dispatched++;
  }
  return dispatched;
}

// ─────────────────────────── 碼頭出口 ───────────────────────────

/** 出口時保留的戰略庫存：糧食隨人口提高，其他資源保留 40 供城市使用 */
function exportReserve(state: GameState, resource: ResourceKey): number {
  if (resource === 'grain') {
    return Math.min(400, Math.max(120, Math.round(state.stats.population * 2)));
  }
  return 40;
}

function exportCycle(state: GameState, rt: LogisticsRuntime, ctx: SimContext): void {
  const docks = state.buildings.filter((b) => isOperating(b) && isDock(b));
  if (!docks.length || state.carts.length >= MAX_CARTS) return;
  let exports = 0;
  for (const dock of docks) {
    if (exports >= EXPORT_MAX_PER_CYCLE || state.carts.length >= MAX_CARTS) break;
    for (const storage of state.buildings) {
      if (exports >= EXPORT_MAX_PER_CYCLE || state.carts.length >= MAX_CARTS) break;
      if (!isOperating(storage) || !isStorage(storage)) continue;
      // 出口的是倉儲多餘物資，不動市集貨架
      if (isMarket(storage)) continue;
      const resources = Object.keys(storage.inventory) as ResourceKey[];
      for (const resource of resources) {
        if (exports >= EXPORT_MAX_PER_CYCLE || state.carts.length >= MAX_CARTS) break;
        const surplus = stockOf(storage, resource) - exportReserve(state, resource);
        if (surplus < MIN_LOAD) continue;
        const amount = Math.min(surplus, CART_CAPACITY);
        if (
          spawnCart(state, rt, storage, dock, resource, amount, 'pickup')
        ) {
          exports++;
        }
      }
    }
  }
  void ctx;
}

// ─────────────────────────── 清理無效搬運工 ───────────────────────────

function cleanupInvalidCarts(state: GameState, rt: LogisticsRuntime): void {
  if (!state.carts.length) return;
  const ids = new Set<number>();
  for (const building of state.buildings) ids.add(building.id);
  let invalid = false;
  for (const cart of state.carts) {
    if (!ids.has(cart.toId)) {
      invalid = true;
      break;
    }
  }
  if (!invalid) return;
  const survivors: Cart[] = [];
  for (const cart of state.carts) {
    if (ids.has(cart.toId)) {
      survivors.push(cart);
      continue;
    }
    const from = findBuilding(state, cart.fromId);
    if (from) addCargo(from, cart.resource, cart.amount);
    releaseReserved(rt, cart.toId, cart.resource, cart.amount);
    cart.done = true;
  }
  state.carts = survivors;
}

// ─────────────────────────── 主入口 ───────────────────────────

/** 每幀由 simulation 呼叫；gameMinutes 為本影格推進的遊戲分鐘 */
export function tickLogistics(state: GameState, gameMinutes: number, ctx: SimContext): void {
  const rt = runtimeOf(state);

  // 1) 移動已派遣的搬運工
  moveCarts(state, gameMinutes, rt, ctx);

  // 2) 派遣（固定頻率 + 每次上限，避免爆量）
  rt.dispatchTimer += gameMinutes;
  if (rt.dispatchTimer >= DISPATCH_INTERVAL) {
    rt.dispatchTimer = Math.max(0, rt.dispatchTimer - DISPATCH_INTERVAL);
    cleanupInvalidCarts(state, rt);
    if (state.carts.length < MAX_CARTS) {
      let budget = MAX_DISPATCH_PER_CYCLE;
      const usedProducers = dispatchProducerOutput(state, rt, budget);
      budget -= usedProducers;
      if (budget > 0) {
        const usedMarkets = dispatchMarketRestock(state, rt, budget);
        budget -= usedMarkets;
      }
      if (budget > 0) dispatchServiceAndInputStock(state, rt, budget);
    }
  }

  // 3) 碼頭定期出口
  rt.exportTimer += gameMinutes;
  if (rt.exportTimer >= EXPORT_INTERVAL) {
    rt.exportTimer = Math.max(0, rt.exportTimer - EXPORT_INTERVAL);
    exportCycle(state, rt, ctx);
  }
}
