/**
 * 華夏古城 — 核心型別定義（全體 Agent 的共同契約）
 *
 * 任何模組都只可透過本檔的型別溝通世界狀態。
 * 修改此檔（或 core/config.ts）屬 Lead 權限；其他 Agent 如需新欄位請透過
 * src/sim 的暫存資料或向 Lead 提出，不要自行改動共用型別。
 */

// ─────────────────────────── 基礎列舉 ───────────────────────────

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** 天氣：晴／陰／雨／雪 */
export type Weather = 'clear' | 'cloudy' | 'rain' | 'snow';

export type TerrainType = 'grass' | 'fertile' | 'forest' | 'hill' | 'mountain' | 'water' | 'sand';

export type ResourceKey =
  | 'grain' // 糧食
  | 'wood' // 木材
  | 'stone' // 石料
  | 'iron' // 鐵礦
  | 'tools' // 工具
  | 'tea' // 茶葉
  | 'wine' // 酒
  | 'cloth'; // 布帛

export type BuildingCategory =
  | 'residential' // 民居
  | 'production' // 生產
  | 'commerce' // 商業
  | 'storage' // 倉儲
  | 'civic' // 民生／政務
  | 'decoration'; // 裝飾

export type LogKind = 'info' | 'good' | 'warn' | 'bad';

export type ServiceKind =
  | 'market'
  | 'granary'
  | 'warehouse'
  | 'temple'
  | 'school'
  | 'teahouse'
  | 'inn'
  | 'yamen'
  | 'dock'
  | 'well'
  | 'pavilion';

export type BuildMode = 'city' | 'interior';

// ─────────────────────────── 地圖 ───────────────────────────

export interface Tile {
  terrain: TerrainType;
  /** 0..1 視覺／邏輯高度 */
  elevation: number;
  /** 每格固定視覺變化種子 0..1 */
  variant: number;
  /** 佔用此格的建築 id，-1 表示無 */
  buildingId: number;
  /** 是否有道路 */
  road: boolean;
}

// ─────────────────────────── 建築 ───────────────────────────

export interface BuildingProduction {
  output: ResourceKey;
  /** 每「日」產量（滿工人時） */
  amountPerDay: number;
  input?: { resource: ResourceKey; amountPerDay: number };
  /** 可蓋的地形；不填代表只能蓋在一般可建地 */
  allowedTerrain?: TerrainType[];
  /** 季節產量倍率 */
  seasonBonus?: Partial<Record<Season, number>>;
  /** 天氣產量倍率 */
  weatherBonus?: Partial<Record<Weather, number>>;
}

export interface BuildingService {
  kind: ServiceKind;
  /** 服務半徑（格） */
  radius?: number;
  /** 每日消耗（如茶館消耗茶葉） */
  consumes?: { resource: ResourceKey; amountPerDay: number };
  /** 對周邊幸福度加成（點） */
  happiness?: number;
  /** 每日收入（兩） */
  incomePerDay?: number;
  /** 稅收效率加成 */
  taxBonus?: number;
}

export interface BuildingDef {
  key: string;
  name: string;
  desc: string;
  category: BuildingCategory;
  /** [寬, 高]（格） */
  size: [number, number];
  cost: number;
  /** 每月維護費（兩） */
  upkeep: number;
  /** 需要工人數 */
  workers: number;
  /** 可住人口 */
  housing: number;
  /** 倉儲容量；accepted 為可存資源（'all' = 全部） */
  storage?: { capacity: number; accepted: ResourceKey[] | 'all' };
  production?: BuildingProduction;
  service?: BuildingService;
  /** 解鎖所需人口 */
  unlockPop: number;
  /** UI／燈籠主題色 */
  color: number;
  /** 建造是否需臨水 */
  needsWater?: boolean;
  /** 建造是否需臨路（預設民居／商業／民生為 true） */
  needsRoad?: boolean;
}

export interface Building {
  id: number;
  key: string;
  /** 左上角格座標 */
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
  /** 是否連通道路 */
  connected: boolean;
  /** 工人 citizen id */
  workers: number[];
  /** 居民 citizen id */
  residents: number[];
  /** 本地庫存（生產暫存／倉儲／市集貨架） */
  inventory: Partial<Record<ResourceKey, number>>;
  /** 生產進度 0..1 */
  productionProgress: number;
  /** 建築升級等級（1 起） */
  level: number;
  /** 建造時的遊戲日（絕對日數） */
  builtOnDay: number;
  /** 本月累計收入／支出（市集、茶館等） */
  incomeThisMonth: number;
  expenseThisMonth: number;
}

// ─────────────────────────── 市民 ───────────────────────────

export type CitizenState = 'home' | 'walking' | 'working' | 'shopping' | 'idle';

export interface CitizenNeeds {
  /** 0..100，越高越滿足 */
  food: number;
  goods: number;
  culture: number;
}

export interface Citizen {
  id: number;
  name: string;
  age: number;
  gender: 'male' | 'female';
  /** 家（建築 id） */
  homeId: number;
  /** 工作（建築 id），-1 失業 */
  workId: number;
  /** 0..100 */
  happiness: number;
  /** 私人錢財（兩） */
  money: number;
  state: CitizenState;
  /** 世界格座標（浮點，供渲染，由 sim 更新） */
  x: number;
  y: number;
  /** 正在走的路徑（格 index 陣列） */
  path: number[];
  /** 沿路徑的進度（0..path.length-1） */
  pathProgress: number;
  /** 目前要去的建築 id，-1 無 */
  targetId: number;
  /** 髮色／衣色種子 0..1 */
  look: number;
  needs: CitizenNeeds;
}

// ─────────────────────────── 物流 ───────────────────────────

export interface Cart {
  id: number;
  resource: ResourceKey;
  amount: number;
  capacity: number;
  fromId: number;
  toId: number;
  x: number;
  y: number;
  path: number[];
  pathProgress: number;
  /** 是否由倉庫往市集／由生產者往倉庫 */
  phase: 'pickup' | 'deliver';
  /** 已送達後待移除 */
  done: boolean;
}

// ─────────────────────────── 時間 ───────────────────────────

export interface GameClock {
  /** 自開局起的絕對遊戲分鐘 */
  minutes: number;
  /** 絕對天數（1 起） */
  totalDays: number;
  day: number; // 1..DAYS_PER_MONTH
  month: number; // 1..12
  year: number; // 1 起
  hour: number; // 0..23
  minute: number; // 0..59
  season: Season;
  weather: Weather;
  /** 距離下次天氣變化的遊戲分鐘 */
  weatherMinutesLeft: number;
  /** 氣溫（攝氏） */
  tempC: number;
  /** 天氣強度 0..1（雨／雪） */
  weatherIntensity: number;
  paused: boolean;
  /** 0=暫停, 1,2,3 = 倍速 */
  speed: number;
}

// ─────────────────────────── 財政 ───────────────────────────

export interface MonthRecord {
  year: number;
  month: number;
  income: number;
  expense: number;
  balance: number;
  population: number;
  happiness: number;
}

export interface Finance {
  treasury: number;
  /** 稅率 0..0.2 */
  taxRate: number;
  /** 本月累計 */
  incomeThisMonth: number;
  expenseThisMonth: number;
  lastMonthIncome: number;
  lastMonthExpense: number;
  history: MonthRecord[];
  totalIncome: number;
  totalExpense: number;
  /** 上次節慶舉辦的絕對日 */
  lastFestivalDay: number;
}

// ─────────────────────────── 其他狀態 ───────────────────────────

export interface LogEntry {
  id: number;
  year: number;
  month: number;
  day: number;
  text: string;
  kind: LogKind;
}

export interface GameStats {
  population: number;
  households: number;
  jobs: number;
  employed: number;
  unemployed: number;
  homeless: number;
  /** 平均幸福度 0..100 */
  happiness: number;
  /** 糧食庫存與每日需求 */
  foodStored: number;
  foodPerDay: number;
  /** 上月淨收益（兩） */
  netIncome: number;
  /** 物流中的貨物量 */
  goodsInTransit: number;
}

export interface UIState {
  /** 目前建造工具：建築 key / 'road' / 'demolish' / null */
  tool: string | null;
  selectedId: number | null;
  hover: number;
  speed: number;
  paused: boolean;
  mode: BuildMode;
  interiorId: number | null;
  buildCategory: BuildingCategory;
  showFinance: boolean;
  showHelp: boolean;
  showSave: boolean;
  showTutorial: boolean;
  /** 遞增，方便 UI 偵測變更 */
  revision: number;
}

export interface GameState {
  version: number;
  seed: number;
  cityName: string;
  width: number;
  height: number;
  tiles: Tile[];
  buildings: Building[];
  citizens: Citizen[];
  carts: Cart[];
  clock: GameClock;
  finance: Finance;
  stats: GameStats;
  ui: UIState;
  log: LogEntry[];
  nextBuildingId: number;
  nextCitizenId: number;
  nextCartId: number;
  nextLogId: number;
  /** 建立時間／存檔時間（ms epoch） */
  createdAt: number;
  savedAt: number;
}

// ─────────────────────────── 擺放結果 ───────────────────────────

export interface PlaceResult {
  ok: boolean;
  reason?: string;
  cost: number;
}

// ─────────────────────────── 模擬 Context ───────────────────────────

export interface SimContext {
  toast(text: string, kind?: LogKind): void;
  log(text: string, kind?: LogKind): void;
}

// ─────────────────────────── 主程式 Actions（UI → 遊戲） ───────────────────────────

export interface GameActions {
  setTool(tool: string | null): void;
  /** 對指定格執行目前工具（道路／建築／拆除） */
  applyToolAt(tileIndex: number): void;
  select(tileIndex: number): void;
  selectBuilding(id: number | null): void;
  enterBuilding(id: number): void;
  exitInterior(): void;
  setSpeed(speed: number): void;
  togglePause(): void;
  setTaxRate(rate: number): void;
  holdFestival(): void;
  demolishBuilding(id: number): void;
  saveGame(slot: number): boolean;
  loadGame(slot: number): boolean;
  deleteSave(slot: number): void;
  getSaves(): SaveSlotInfo[];
  exportSave(): void;
  importSave(file: File): Promise<boolean>;
  newGame(seed?: number): void;
  toggleFinance(): void;
  toggleHelp(): void;
  toggleSavePanel(): void;
  closeOverlays(): void;
}

// ─────────────────────────── 存檔 ───────────────────────────

export interface SaveSlotInfo {
  slot: number;
  empty: boolean;
  cityName: string;
  population: number;
  treasury: number;
  dateLabel: string;
  savedAt: number;
}
