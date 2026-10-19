/**
 * 市民系統共用模組（citizen-dev 專用新檔）
 *
 * 提供 citizens.ts 與 population.ts 共用的：
 *   - 跨影格暫存（WeakMap<GameState, CitizenCache>，換局／讀檔自動失效）
 *   - 市民建立／移除、姓名產生
 *   - 建築索引、道路／服務查詢、通勤可達性
 *
 * 座標慣例：citizen.x / citizen.y 為「格座標」，格 (tx,ty) 的中心 = (tx+0.5, ty+0.5)；
 * render 端世界座標 = citizen.x * TILE - width*TILE/2（見 render/citizens.ts）。
 * 物流的 Cart.x/y 仍是「格索引浮點」（沿用基準版 render 公式），本模組不碰 carts。
 */

import { BUILDINGS, GIVEN_NAMES, RESOURCES, SURNAMES } from '../core/config';
import type { Building, Citizen, CitizenNeeds, CitizenState, GameState, ResourceKey, ServiceKind, SimContext } from '../core/types';
import { findRoadPath, roadAccessTiles } from './pathfinding';

// ─────────────────────────── 常數 ───────────────────────────

/** 人口上限（效能考量） */
export const MAX_POPULATION = 800;

/**
 * 市民移動速度（格／遊戲分鐘）：依 docs/GAME_DESIGN.md §4.5 修正為 0.06
 * （1× 約 2.9 格／真實秒；跨 72 格約 25 秒）。ARCHITECTURE.md 舊值 1.2 格/遊戲分鐘
 * 等於 57 格/真實秒，會變成殘影，已與 game-designer 的規格對齊。
 * 天氣再乘 WEATHER_EFFECT.move；22:00–06:00 再乘 0.9。
 */
export const CITIZEN_SPEED = 0.06;

/** 作息（時）：06:00 起床、07:00 出門、08:00–17:00 工作、19:00 後回家、22:00 睡眠 */
export const WAKE_HOUR = 6;
export const DEPART_HOUR = 7;
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 17;
export const SLEEP_HOUR = 22;
/** 每日需求結算時刻（時） */
export const DAWN_HOUR = 5;

/** 走路時每格路徑的動畫振幅等由 render 處理，sim 不關心 */

// ─────────────────────────── 暫存結構 ───────────────────────────

export type CitizenActivity = 'home' | 'work' | 'shop' | 'culture' | 'wander' | 'idle';

/** 不屬於 core/types 的市民暫存資料（存檔不保存，讀檔後以預設值重建） */
export interface CitizenExtras {
  /** 目前「在建築內」狀態結束的絕對遊戲分鐘 */
  busyUntil: number;
  /** 需要重新規劃下一個目的地 */
  pendingPlan: boolean;
  /** 規劃中的活動種類（供抵達時判斷） */
  activity: CitizenActivity;
  /** 今日是否已用餐 */
  ateToday: boolean;
  /** 連續無家可歸天數 */
  homelessDays: number;
  /** 連續低幸福天數 */
  lowHappinessDays: number;
  /** 連續飢餓天數 */
  starveDays: number;
  /** 上次規劃失敗時間（避免同幀重試） */
  retryAt: number;
}

export interface ServicePoint {
  building: Building;
  kind: ServiceKind;
  /** 建築中心格座標（格座標，中心為整數 +0.5） */
  x: number;
  y: number;
  radius: number;
  happiness: number;
}

export interface CitizenCache {
  extras: Map<number, CitizenExtras>;
  /** 是否已做過開局流民初始化 */
  initialized: boolean;
  /** 建築索引（每幀刷新，避免 O(n) find） */
  byId: Map<number, Building>;
  /** 服務建築清單（每日／建築變動時重建） */
  services: ServicePoint[];
  servicesBuiltAt: number;
  servicesBuildingCount: number;
  /** 道路格清單（每隔數十遊戲分鐘重建） */
  roads: number[] | null;
  roadsAt: number;
  /** 城中心可通行錨點 */
  centerAnchor: { x: number; y: number } | null;
  /** 上次執行人口配置／移民的遊戲分鐘 */
  lastAssignMinute: number;
  lastImmigrationMinute: number;
  /** 公平輪轉游標 */
  planCursor: number;
  /** 建築數量變動偵測 */
  lastBuildingCount: number;
  /** 每日需求結算日期 */
  needsDay: number;
  /** 通知去重 */
  lastHungerToastDay: number;
  lastJobToastDay: number;
  lastImmigrationToastDay: number;
  populationMilestone: number;
}

const caches = new WeakMap<GameState, CitizenCache>();

function createCache(): CitizenCache {
  return {
    extras: new Map(),
    initialized: false,
    byId: new Map(),
    services: [],
    servicesBuiltAt: -99999,
    servicesBuildingCount: -1,
    roads: null,
    roadsAt: -99999,
    centerAnchor: null,
    lastAssignMinute: -99999,
    lastImmigrationMinute: -99999,
    planCursor: 0,
    lastBuildingCount: -1,
    needsDay: -1,
    lastHungerToastDay: -99999,
    lastJobToastDay: -99999,
    lastImmigrationToastDay: -99999,
    populationMilestone: 0,
  };
}

/** 取得（必要時建立）此局的市民暫存；換局／讀檔因 state 物件不同而自動重建 */
export function getCitizenCache(state: GameState): CitizenCache {
  let cache = caches.get(state);
  if (!cache) {
    cache = createCache();
    caches.set(state, cache);
  }
  return cache;
}

export function createExtras(now: number): CitizenExtras {
  return {
    busyUntil: now + 20 + Math.random() * 100,
    pendingPlan: true,
    activity: 'idle',
    ateToday: false,
    homelessDays: 0,
    lowHappinessDays: 0,
    starveDays: 0,
    retryAt: -99999,
  };
}

export function getExtras(cache: CitizenCache, citizen: Citizen, now: number): CitizenExtras {
  let extras = cache.extras.get(citizen.id);
  if (!extras) {
    extras = createExtras(now);
    cache.extras.set(citizen.id, extras);
  }
  return extras;
}

// ─────────────────────────── 小工具 ───────────────────────────

export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randInt(min: number, maxInclusive: number): number {
  return min + Math.floor(Math.random() * (maxInclusive - min + 1));
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 建築中心（格座標，中心 = 整數 + 0.5 的格中心座標系） */
export function buildingCenter(b: Building): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function buildingDef(key: string) {
  return BUILDINGS[key];
}

export function inventoryOf(b: Building, resource: ResourceKey): number {
  return b.inventory[resource] ?? 0;
}

export function addInventory(b: Building, resource: ResourceKey, amount: number): void {
  b.inventory[resource] = Math.max(0, inventoryOf(b, resource) + amount);
}

/** 從建築扣貨（扣不到回傳 false，不做部分扣除） */
export function takeInventory(b: Building, resource: ResourceKey, amount: number): boolean {
  if (amount <= 0) return true;
  const have = inventoryOf(b, resource);
  if (have + 1e-6 < amount) return false;
  const left = have - amount;
  if (left < 1e-3) delete b.inventory[resource];
  else b.inventory[resource] = left;
  return true;
}

/**
 * 市民向建築付費購買貨物：扣庫存、扣市民錢、記入該建築本月收入。
 * 回傳是否成功（買不起或沒貨則 false）。
 */
export function buyResource(citizen: Citizen, building: Building, resource: ResourceKey, amount: number): boolean {
  const price = RESOURCES[resource]?.price ?? 1;
  const cost = price * amount;
  if (citizen.money + 1e-6 < cost) return false;
  if (!takeInventory(building, resource, amount)) return false;
  citizen.money = Math.max(0, citizen.money - cost);
  building.incomeThisMonth += cost;
  return true;
}

// ─────────────────────────── 建築索引與服務查詢 ───────────────────────────

/** 每幀刷新建築索引（n 很小，Map 重建成本可忽略） */
export function refreshBuildingIndex(state: GameState, cache: CitizenCache): void {
  cache.byId.clear();
  for (const b of state.buildings) cache.byId.set(b.id, b);
}

export function cachedBuilding(cache: CitizenCache, id: number): Building | null {
  if (id < 0) return null;
  return cache.byId.get(id) ?? null;
}

/** 住宅容量（0 = 非住宅） */
export function housingCapacity(b: Building): number {
  const def = BUILDINGS[b.key];
  if (!def || def.housing <= 0) return 0;
  return def.housing;
}

export function isResidentialActive(b: Building): boolean {
  return housingCapacity(b) > 0 && b.active;
}

/** 重新建立服務建築清單（建築數量變動或隔日時呼叫） */
export function refreshServices(state: GameState, cache: CitizenCache): void {
  const points: ServicePoint[] = [];
  for (const b of state.buildings) {
    const def = BUILDINGS[b.key];
    const service = def?.service;
    if (!service) continue;
    const center = buildingCenter(b);
    points.push({
      building: b,
      kind: service.kind,
      x: center.x,
      y: center.y,
      radius: service.radius ?? 5,
      happiness: service.happiness ?? 0,
    });
  }
  cache.services = points;
  cache.servicesBuiltAt = state.clock.minutes;
  cache.servicesBuildingCount = state.buildings.length;
}

/** 取得最新服務清單（建築數量改變或超過 1 日就重建） */
export function servicePoints(state: GameState, cache: CitizenCache): ServicePoint[] {
  const now = state.clock.minutes;
  if (cache.servicesBuildingCount !== state.buildings.length || now - cache.servicesBuiltAt > 1440) {
    refreshServices(state, cache);
  }
  return cache.services;
}

export function insideService(sp: ServicePoint, x: number, y: number): boolean {
  const dx = sp.x - x;
  const dy = sp.y - y;
  return dx * dx + dy * dy <= sp.radius * sp.radius;
}

// ─────────────────────────── 道路與可達性 ───────────────────────────

export function isPassableTile(state: GameState, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false;
  const terrain = state.tiles[ty * state.width + tx].terrain;
  return terrain !== 'water' && terrain !== 'mountain';
}

/** 道路格清單（暫存，每 30 遊戲分鐘或手動 markRoadsDirty 後重建） */
export function roadsList(state: GameState, cache: CitizenCache): number[] {
  const now = state.clock.minutes;
  if (cache.roads && now - cache.roadsAt < 30) return cache.roads;
  const list: number[] = [];
  for (let i = 0; i < state.tiles.length; i++) if (state.tiles[i].road) list.push(i);
  cache.roads = list;
  cache.roadsAt = now;
  return list;
}

/** 道路變動後呼叫，強制下次重掃 */
export function markRoadsDirty(cache: CitizenCache): void {
  cache.roads = null;
  cache.roadsAt = -99999;
}

/** 城中心附近可通行錨點（流民徘徊、無家者移動用） */
export function cityCenterAnchor(state: GameState, cache: CitizenCache): { x: number; y: number } {
  if (cache.centerAnchor) return cache.centerAnchor;
  const cx = Math.floor(state.width / 2);
  const cy = Math.floor(state.height / 2);
  for (let r = 0; r <= 18; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (!isPassableTile(state, tx, ty)) continue;
        cache.centerAnchor = { x: tx + 0.5, y: ty + 0.5 };
        return cache.centerAnchor;
      }
    }
  }
  cache.centerAnchor = { x: cx + 0.5, y: cy + 0.5 };
  return cache.centerAnchor;
}

/** 找離 (tx,ty) 最近的道路格；找不到回傳 -1 */
export function nearestRoadTile(state: GameState, cache: CitizenCache, tx: number, ty: number, maxRadius = 16): number {
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) {
    tx = clamp(tx, 0, state.width - 1);
    ty = clamp(ty, 0, state.height - 1);
  }
  if (state.tiles[ty * state.width + tx].road) return ty * state.width + tx;
  for (let r = 1; r <= maxRadius; r++) {
    for (let d = -r; d <= r; d++) {
      const candidates: [number, number][] = [
        [tx + d, ty - r],
        [tx + d, ty + r],
        [tx - r, ty + d],
        [tx + r, ty + d],
      ];
      for (const [x, y] of candidates) {
        if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
        const idx = y * state.width + x;
        if (state.tiles[idx].road) return idx;
      }
    }
  }
  // 全城最近道路 fallback
  let best = -1;
  let bestDist = Infinity;
  for (const idx of roadsList(state, cache)) {
    const x = idx % state.width;
    const y = Math.floor(idx / state.width);
    const dist = (x - tx) * (x - tx) + (y - ty) * (y - ty);
    if (dist < bestDist) {
      bestDist = dist;
      best = idx;
    }
  }
  return best;
}

/** 建築臨路格（優先回傳第一格），沒有回傳 -1 */
export function buildingAccessTile(state: GameState, building: Building): number {
  const access = roadAccessTiles(state, building);
  return access.length ? access[0] : -1;
}

/** 建築的移動目標格：臨路格，否則附近最近道路；找不到回傳 -1 */
export function buildingGoalTile(state: GameState, cache: CitizenCache, building: Building): number {
  const access = buildingAccessTile(state, building);
  if (access >= 0) return access;
  const center = buildingCenter(building);
  return nearestRoadTile(state, cache, Math.floor(center.x), Math.floor(center.y), 10);
}

/** 市民出發的道路格：目前所在建築的臨路格，否則座標附近最近道路 */
export function citizenStartTile(state: GameState, cache: CitizenCache, citizen: Citizen): number {
  const occupant = cachedBuilding(cache, citizen.targetId);
  if (occupant) {
    const access = buildingAccessTile(state, occupant);
    if (access >= 0) return access;
  }
  const tx = clamp(Math.floor(citizen.x), 0, state.width - 1);
  const ty = clamp(Math.floor(citizen.y), 0, state.height - 1);
  let tile = nearestRoadTile(state, cache, tx, ty, 16);
  if (tile >= 0) return tile;
  const anchor = cityCenterAnchor(state, cache);
  return nearestRoadTile(state, cache, Math.floor(anchor.x), Math.floor(anchor.y), 20);
}

/**
 * 判斷住宅→工作地是否可經道路通勤。
 * 工作建築必須 active（物流端會在缺路時設 false）。
 */
export function canCommute(state: GameState, cache: CitizenCache, home: Building | null, work: Building): boolean {
  if (!work.active) return false;
  const goal = buildingGoalTile(state, cache, work);
  if (goal < 0) return false;
  let start = home ? buildingAccessTile(state, home) : -1;
  if (start < 0) {
    const anchor = home ? buildingCenter(home) : cityCenterAnchor(state, cache);
    start = nearestRoadTile(state, cache, Math.floor(anchor.x), Math.floor(anchor.y), 14);
  }
  if (start < 0) return false;
  return findRoadPath(state, start, goal) !== null;
}

// ─────────────────────────── 市民建立／移除 ───────────────────────────

export interface NewCitizenOptions {
  age?: number;
  gender?: 'male' | 'female';
  homeId?: number;
  workId?: number;
  x?: number;
  y?: number;
  happiness?: number;
  money?: number;
  food?: number;
  goods?: number;
  culture?: number;
  state?: CitizenState;
}

const FEMALE_GIVEN = ['花', '月', '玉', '蘭', '梅', '美', '春', '雪', '晴', '竹', '小', '和', '雲', '星', '樂'];
const MALE_GIVEN = ['安', '福', '德', '仁', '義', '禮', '智', '信', '文', '武', '成', '大', '山', '河', '海', '天', '光', '寶', '貴', '榮', '華', '興', '平', '旺', '達'];

/** 以 config 姓名表產生姓名（姓 + 1~2 字名，依性別偏向選字） */
export function generateCitizenName(gender: 'male' | 'female'): string {
  const surname = SURNAMES[randInt(0, SURNAMES.length - 1)];
  const pool = gender === 'female' && Math.random() < 0.65 ? FEMALE_GIVEN : gender === 'male' && Math.random() < 0.65 ? MALE_GIVEN : GIVEN_NAMES;
  const pieces = Math.random() < 0.32 ? 2 : 1;
  let given = '';
  for (let i = 0; i < pieces; i++) given += pool[randInt(0, pool.length - 1)];
  return surname + given;
}

function defaultNeeds(citizen?: Partial<CitizenNeeds>): CitizenNeeds {
  return {
    food: citizen?.food ?? randRange(52, 78),
    goods: citizen?.goods ?? randRange(38, 66),
    culture: citizen?.culture ?? randRange(32, 58),
  };
}

/** 建立市民並掛入住宅／工作建築名單；回傳新市民 */
export function createCitizen(state: GameState, cache: CitizenCache, opts: NewCitizenOptions = {}): Citizen {
  const now = state.clock.minutes;
  const gender = opts.gender ?? (Math.random() < 0.5 ? 'male' : 'female');
  const homeId = opts.homeId ?? -1;
  const workId = opts.workId ?? -1;
  const age = opts.age ?? randInt(16, 46);
  const anchor = cityCenterAnchor(state, cache);
  const citizen: Citizen = {
    id: state.nextCitizenId++,
    name: generateCitizenName(gender),
    age,
    gender,
    homeId,
    workId,
    happiness: clamp(opts.happiness ?? randRange(55, 72), 0, 100),
    money: opts.money ?? randRange(8, 32),
    state: opts.state ?? (homeId >= 0 ? 'home' : 'idle'),
    x: opts.x ?? anchor.x + randRange(-1.2, 1.2),
    y: opts.y ?? anchor.y + randRange(-1.2, 1.2),
    path: [],
    pathProgress: 0,
    targetId: -1,
    look: Math.random(),
    needs: defaultNeeds({ food: opts.food, goods: opts.goods, culture: opts.culture }),
  };

  const home = cachedBuilding(cache, homeId);
  if (home) {
    const center = buildingCenter(home);
    if (opts.x == null) citizen.x = center.x + randRange(-0.3, 0.3);
    if (opts.y == null) citizen.y = center.y + randRange(-0.3, 0.3);
    citizen.targetId = homeId;
    if (!home.residents.includes(citizen.id)) home.residents.push(citizen.id);
  }
  const work = cachedBuilding(cache, workId);
  if (work && !work.workers.includes(citizen.id)) work.workers.push(citizen.id);

  const extras = createExtras(now);
  extras.activity = citizen.state === 'working' ? 'work' : citizen.state === 'shopping' ? 'shop' : 'idle';
  cache.extras.set(citizen.id, extras);
  state.citizens.push(citizen);
  return citizen;
}

/** 移除市民（含建築名單、暫存資料清理） */
export function removeCitizen(state: GameState, cache: CitizenCache, id: number): void {
  const index = state.citizens.findIndex((c) => c.id === id);
  if (index < 0) return;
  state.citizens.splice(index, 1);
  for (const building of state.buildings) {
    if (building.residents.length) {
      const ri = building.residents.indexOf(id);
      if (ri >= 0) building.residents.splice(ri, 1);
    }
    if (building.workers.length) {
      const wi = building.workers.indexOf(id);
      if (wi >= 0) building.workers.splice(wi, 1);
    }
  }
  cache.extras.delete(id);
}

/** 啟動時建立 5 名無家流民（新局或讀到沒有市民的舊存檔時） */
export function ensureInitialPopulation(state: GameState, cache: CitizenCache, ctx: SimContext): void {
  if (cache.initialized) return;
  cache.initialized = true;
  if (state.citizens.length > 0) return;

  // docs/GAME_DESIGN.md §4.1：開局固定 5 名成年人（16~40 歲）流民
  const count = 5;
  const anchor = cityCenterAnchor(state, cache);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.8;
    const dist = randRange(1.5, 4);
    const x = clamp(anchor.x + Math.cos(angle) * dist, 1, state.width - 1);
    const y = clamp(anchor.y + Math.sin(angle) * dist, 1, state.height - 1);
    createCitizen(state, cache, {
      age: randInt(16, 40),
      x,
      y,
      happiness: randRange(42, 60),
      money: randRange(3, 14),
      food: randRange(45, 68),
      goods: randRange(30, 52),
      culture: randRange(20, 42),
      state: 'idle',
    });
  }
  ctx.log('城外來了幾名流民，正在尋找落腳之處。', 'info');
}


// ─────────────────────────── 全城糧食／市集交易輔助 ───────────────────────────

/** 全城所有建築的糧食庫存總和（不含市民身上的抽象存糧） */
export function cityGrainReserve(state: GameState): number {
  let total = 0;
  for (const building of state.buildings) total += building.inventory.grain ?? 0;
  return total;
}

/**
 * 從全城存糧中取用少量（給「住宅不在市集半徑內，但有全城存糧」的部分滿足用）。
 * 優先順序：倉儲 > 生產（輸出糧食者）> 市集 > 生產建築的「投入糧食」（如酒坊備料）。
 * 最後一項排最低，避免保底吃飯吃掉酒坊的釀酒原料而導致停產（logistics-dev 建議）。
 * 同優先序先扣存貨最多者。
 */
export function consumeCityGrain(state: GameState, amount: number): boolean {
  let best: Building | null = null;
  let bestPriority = -1;
  let bestStock = 0;
  for (const building of state.buildings) {
    const stock = building.inventory.grain ?? 0;
    if (stock <= 1e-6) continue;
    const def = BUILDINGS[building.key];
    const isProducerInput = def?.production?.input?.resource === 'grain';
    const priority = isProducerInput
      ? 0
      : def?.storage
        ? 3
        : def?.production
          ? 2
          : def?.service?.kind === 'market'
            ? 1
            : 0;
    if (priority > bestPriority || (priority === bestPriority && stock > bestStock)) {
      best = building;
      bestPriority = priority;
      bestStock = stock;
    }
  }
  if (!best) return false;
  return takeInventory(best, 'grain', amount);
}

/** 市集是否有任何民生消費品（茶／酒／布）庫存 */
export function marketHasGoods(building: Building): boolean {
  return inventoryOf(building, 'cloth') >= 0.15 || inventoryOf(building, 'tea') >= 0.15 || inventoryOf(building, 'wine') >= 0.15;
}

/**
 * 市民到市集購物（docs/GAME_DESIGN.md §4.4）：
 * 扣市集庫存（糧食 1、日用品 0.15）、市民 money −1.5、market.incomeThisMonth += 1.5。
 * money 不足或完全沒貨 → 不購物（需求由每日結算判定）。
 * 回傳實際購買的種類數（0 = 買不到）。
 */
export function marketPurchase(citizen: Citizen, market: Building): number {
  if (citizen.money < 1.5) return 0;
  // 糧食只在真的需要時才買，避免與每日 1 糧結算重複消耗（經濟平衡見 GAME_DESIGN §5.4）
  const hasGrain = inventoryOf(market, 'grain') >= 1 && citizen.needs.food < 65;
  let goods: ResourceKey | null = null;
  for (const resource of ['cloth', 'tea', 'wine'] as ResourceKey[]) {
    if (inventoryOf(market, resource) >= 0.15) {
      goods = resource;
      break;
    }
  }
  if (!hasGrain && !goods) return 0;
  if (hasGrain) takeInventory(market, 'grain', 1);
  if (goods) takeInventory(market, goods, 0.15);
  citizen.money = Math.max(0, citizen.money - 1.5);
  market.incomeThisMonth += 1.5;
  let count = 0;
  if (hasGrain) {
    citizen.needs.food = clamp(citizen.needs.food + 10, 0, 100);
    count++;
  }
  if (goods) {
    citizen.needs.goods = clamp(citizen.needs.goods + 10, 0, 100);
    count++;
  }
  return count;
}

/** 目前住宅空位總數 */
export function housingVacancies(state: GameState): { total: number; houses: number } {
  let total = 0;
  let houses = 0;
  for (const b of state.buildings) {
    const cap = housingCapacity(b);
    if (cap <= 0 || !b.active) continue;
    houses++;
    total += Math.max(0, cap - b.residents.length);
  }
  return { total, houses };
}

/** 平均幸福度（無市民時回傳 60） */
export function averageHappiness(state: GameState): number {
  if (!state.citizens.length) return 60;
  let sum = 0;
  for (const c of state.citizens) sum += c.happiness;
  return sum / state.citizens.length;
}
