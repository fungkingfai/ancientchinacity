/**
 * 華夏古城 — 全域設定與資料表（Lead 維護）
 *
 * 建築資料表、資源、時間流速、稅率、姓名表等。其他 Agent 可讀取，
 * 但請勿修改本檔；需要新資料請通知 Lead。
 */

import type {
  BuildingCategory,
  BuildingDef,
  LogKind,
  ResourceKey,
  Season,
  SimContext,
  Weather,
} from './types';

// ─────────────────────────── 世界常數 ───────────────────────────

export const GAME_VERSION = 1;
export const GRID_WIDTH = 72;
export const GRID_HEIGHT = 72;
/** 每格世界單位 */
export const TILE_SIZE = 2;

/** 1 倍速時：每真實秒推進的遊戲分鐘（1440 / 48 = 30 秒一日） */
export const GAME_MINUTES_PER_SECOND = 48;
export const DAYS_PER_MONTH = 7;
export const MONTHS_PER_YEAR = 12;
export const MINUTES_PER_DAY = 24 * 60;

export const START_TREASURY = 6000;
export const DEFAULT_TAX_RATE = 0.1;
export const FESTIVAL_COST = 300;
export const FESTIVAL_COOLDOWN_DAYS = 20;

/** 裝飾用「旬日」名稱（甲旬…癸旬），避免依賴真實曆法 */
export const WEEK_NAMES = ['甲旬', '乙旬', '丙旬', '丁旬', '戊旬', '己旬', '庚旬', '辛旬', '壬旬', '癸旬'];

// ─────────────────────────── 時間／季節 ───────────────────────────

export const SEASON_ORDER: Season[] = ['spring', 'summer', 'autumn', 'winter'];

export const SEASON_INFO: Record<Season, { name: string; color: string; emoji: string }> = {
  spring: { name: '春', color: '#8fbf6f', emoji: '🌱' },
  summer: { name: '夏', color: '#d8a743', emoji: '☀' },
  autumn: { name: '秋', color: '#c97a4a', emoji: '🍂' },
  winter: { name: '冬', color: '#9fb6c9', emoji: '❄' },
};

export function seasonOfMonth(month: number): Season {
  if (month <= 3) return 'spring';
  if (month <= 6) return 'summer';
  if (month <= 9) return 'autumn';
  return 'winter';
}

/** 各季基礎氣溫（攝氏） */
export const SEASON_TEMP: Record<Season, number> = {
  spring: 17,
  summer: 30,
  autumn: 19,
  winter: 3,
};

/** 農作季產倍率 */
export const SEASON_FARM_BONUS: Record<Season, number> = {
  spring: 1.15,
  summer: 1.05,
  autumn: 1.25,
  winter: 0.35,
};

export const WEATHER_INFO: Record<Weather, { name: string; emoji: string; color: string; hint: string }> = {
  clear: { name: '晴', emoji: '☀', color: '#f5c96a', hint: '陽光普照，適合農耕' },
  cloudy: { name: '陰', emoji: '☁', color: '#9aa7b5', hint: '陰雲密佈，氣溫微降' },
  rain: { name: '雨', emoji: '🌧', color: '#6f95b8', hint: '雨水滋潤農田，行人腳步放緩' },
  snow: { name: '雪', emoji: '❄', color: '#d9e6f2', hint: '大雪紛飛，農作停擺' },
};

/** 各季天氣轉移權重 */
export const WEATHER_WEIGHTS: Record<Season, Record<Weather, number>> = {
  spring: { clear: 42, cloudy: 30, rain: 28, snow: 0 },
  summer: { clear: 55, cloudy: 25, rain: 20, snow: 0 },
  autumn: { clear: 45, cloudy: 32, rain: 23, snow: 0 },
  winter: { clear: 30, cloudy: 38, rain: 7, snow: 25 },
};

/** 天氣對產量、移動、幸福的影響 */
export const WEATHER_EFFECT: Record<Weather, { farm: number; move: number; happiness: number }> = {
  clear: { farm: 1.05, move: 1, happiness: 2 },
  cloudy: { farm: 1, move: 1, happiness: 0 },
  rain: { farm: 1.25, move: 0.72, happiness: -2 },
  snow: { farm: 0.5, move: 0.6, happiness: -4 },
};

// ─────────────────────────── 資源 ───────────────────────────

export interface ResourceDef {
  key: ResourceKey;
  name: string;
  short: string;
  color: string;
  /** 參考市價（兩／單位） */
  price: number;
  /** 是否為民生消費品 */
  consumer: boolean;
}

export const RESOURCES: Record<ResourceKey, ResourceDef> = {
  grain: { key: 'grain', name: '糧食', short: '糧', color: '#d7b25a', price: 1.2, consumer: true },
  wood: { key: 'wood', name: '木材', short: '木', color: '#8a6a45', price: 2.0, consumer: false },
  stone: { key: 'stone', name: '石料', short: '石', color: '#9a9a92', price: 2.6, consumer: false },
  iron: { key: 'iron', name: '鐵礦', short: '鐵', color: '#7b8794', price: 4.0, consumer: false },
  tools: { key: 'tools', name: '工具', short: '具', color: '#c08d4f', price: 8.0, consumer: false },
  tea: { key: 'tea', name: '茶葉', short: '茶', color: '#6f9a5f', price: 4.5, consumer: true },
  wine: { key: 'wine', name: '酒', short: '酒', color: '#a9553f', price: 5.0, consumer: true },
  cloth: { key: 'cloth', name: '布帛', short: '布', color: '#b98aa0', price: 4.0, consumer: true },
};

export const RESOURCE_KEYS = Object.keys(RESOURCES) as ResourceKey[];

// ─────────────────────────── 地形 ───────────────────────────

export interface TerrainDef {
  key: string;
  name: string;
  color: number;
  buildable: boolean;
  /** 採集加成描述 */
  note: string;
}

export const TERRAIN_INFO: Record<string, TerrainDef> = {
  grass: { key: 'grass', name: '平原', color: 0x86a85c, buildable: true, note: '一般建築皆可' },
  fertile: { key: 'fertile', name: '沃土', color: 0x9db85e, buildable: true, note: '農田首選，產量 +30%' },
  forest: { key: 'forest', name: '林地', color: 0x4f7a44, buildable: true, note: '伐木場首選' },
  hill: { key: 'hill', name: '丘陵', color: 0x8c8a63, buildable: true, note: '可建採石場、茶園' },
  mountain: { key: 'mountain', name: '山地', color: 0x6d6a63, buildable: false, note: '不可建造，可採鐵' },
  water: { key: 'water', name: '水域', color: 0x4d7f9e, buildable: false, note: '不可建造，可設碼頭' },
  sand: { key: 'sand', name: '沙岸', color: 0xc9b98c, buildable: true, note: '臨水而建' },
};

// ─────────────────────────── 建築資料表 ───────────────────────────

const B = (def: BuildingDef): BuildingDef => def;

export const BUILDINGS: Record<string, BuildingDef> = {
  hut: B({
    key: 'hut',
    name: '茅屋',
    desc: '平民居所，可容納 4 人。城市發展的起點。',
    category: 'residential',
    size: [1, 1],
    cost: 60,
    upkeep: 0,
    workers: 0,
    housing: 4,
    unlockPop: 0,
    color: 0x9c7b4f,
    needsRoad: false,
  }),
  house: B({
    key: 'house',
    name: '瓦房',
    desc: '青瓦白牆的民居，可容納 8 人，需臨路。',
    category: 'residential',
    size: [1, 1],
    cost: 180,
    upkeep: 1,
    workers: 0,
    housing: 8,
    unlockPop: 30,
    color: 0xc9c2b0,
  }),
  manor: B({
    key: 'manor',
    name: '宅院',
    desc: '大戶人家的宅院，可容納 20 人，附帶庭院。',
    category: 'residential',
    size: [2, 2],
    cost: 720,
    upkeep: 3,
    workers: 0,
    housing: 20,
    unlockPop: 160,
    color: 0xb9a583,
  }),

  // ── 生產 ──
  farm: B({
    key: 'farm',
    name: '農田',
    desc: '種植稻麥，產出糧食。沃土可增產。',
    category: 'production',
    size: [2, 2],
    cost: 120,
    upkeep: 1,
    workers: 4,
    housing: 0,
    unlockPop: 0,
    color: 0xd9c06a,
    production: {
      output: 'grain',
      amountPerDay: 14,
      allowedTerrain: ['fertile', 'grass'],
      seasonBonus: { spring: 1.2, summer: 1.1, autumn: 1.35, winter: 0.3 },
      weatherBonus: { rain: 1.2, snow: 0.3, clear: 1.05 },
    },
  }),
  teaFarm: B({
    key: 'teaFarm',
    name: '茶園',
    desc: '丘陵上的茶園，採摘茶葉。',
    category: 'production',
    size: [2, 2],
    cost: 170,
    upkeep: 1,
    workers: 4,
    housing: 0,
    unlockPop: 45,
    color: 0x7aa363,
    production: {
      output: 'tea',
      amountPerDay: 7,
      allowedTerrain: ['hill', 'grass', 'fertile'],
      seasonBonus: { spring: 1.3, summer: 1.1, autumn: 1.0, winter: 0.3 },
    },
  }),
  lumber: B({
    key: 'lumber',
    name: '伐木場',
    desc: '砍伐林木，產出木材。建於林地效果最佳。',
    category: 'production',
    size: [2, 2],
    cost: 130,
    upkeep: 1,
    workers: 3,
    housing: 0,
    unlockPop: 0,
    color: 0x8a6a45,
    production: {
      output: 'wood',
      amountPerDay: 10,
      allowedTerrain: ['forest', 'grass', 'hill'],
    },
  }),
  quarry: B({
    key: 'quarry',
    name: '採石場',
    desc: '開採石料，需建於丘陵。',
    category: 'production',
    size: [2, 2],
    cost: 180,
    upkeep: 2,
    workers: 4,
    housing: 0,
    unlockPop: 40,
    color: 0x9a9a92,
    production: {
      output: 'stone',
      amountPerDay: 8,
      allowedTerrain: ['hill', 'grass'],
    },
  }),
  ironMine: B({
    key: 'ironMine',
    name: '鐵礦場',
    desc: '開採鐵礦，需建於丘陵或山地邊緣。',
    category: 'production',
    size: [2, 2],
    cost: 240,
    upkeep: 2,
    workers: 5,
    housing: 0,
    unlockPop: 150,
    color: 0x777f88,
    production: {
      output: 'iron',
      amountPerDay: 6,
      allowedTerrain: ['hill', 'mountain'],
    },
  }),
  brewery: B({
    key: 'brewery',
    name: '酒坊',
    desc: '以糧食釀酒，供應客棧與市集。',
    category: 'production',
    size: [2, 2],
    cost: 210,
    upkeep: 2,
    workers: 4,
    housing: 0,
    unlockPop: 90,
    color: 0xa9553f,
    production: {
      output: 'wine',
      amountPerDay: 4,
      input: { resource: 'grain', amountPerDay: 5 },
    },
  }),
  weaver: B({
    key: 'weaver',
    name: '織坊',
    desc: '紡紗織布，產出布帛。',
    category: 'production',
    size: [2, 2],
    cost: 190,
    upkeep: 1,
    workers: 5,
    housing: 0,
    unlockPop: 120,
    color: 0xb98aa0,
    production: {
      output: 'cloth',
      amountPerDay: 6,
    },
  }),
  blacksmith: B({
    key: 'blacksmith',
    name: '鐵匠鋪',
    desc: '將鐵礦鍛造成工具。',
    category: 'production',
    size: [2, 2],
    cost: 240,
    upkeep: 2,
    workers: 4,
    housing: 0,
    unlockPop: 180,
    color: 0xc08d4f,
    production: {
      output: 'tools',
      amountPerDay: 3,
      input: { resource: 'iron', amountPerDay: 2.5 },
    },
  }),

  // ── 倉儲 ──
  granary: B({
    key: 'granary',
    name: '糧倉',
    desc: '儲存糧食，容量 500。物流的樞紐。',
    category: 'storage',
    size: [2, 2],
    cost: 160,
    upkeep: 1,
    workers: 2,
    housing: 0,
    unlockPop: 15,
    color: 0xc7a45c,
    storage: { capacity: 500, accepted: ['grain'] },
  }),
  warehouse: B({
    key: 'warehouse',
    name: '貨棧',
    desc: '儲存各類貨物，容量 400。',
    category: 'storage',
    size: [2, 2],
    cost: 200,
    upkeep: 2,
    workers: 3,
    housing: 0,
    unlockPop: 60,
    color: 0x9b8563,
    storage: { capacity: 400, accepted: 'all' },
  }),

  // ── 商業 ──
  market: B({
    key: 'market',
    name: '市集',
    desc: '向倉庫進貨、向周邊民居供貨，並帶來商稅。',
    category: 'commerce',
    size: [2, 2],
    cost: 260,
    upkeep: 2,
    workers: 6,
    housing: 0,
    unlockPop: 20,
    color: 0xc76b4a,
    storage: { capacity: 250, accepted: 'all' },
    service: { kind: 'market', radius: 9, incomePerDay: 2 },
  }),
  teahouse: B({
    key: 'teahouse',
    name: '茶館',
    desc: '供人品茗休憩，消耗茶葉，帶來收入與幸福。',
    category: 'commerce',
    size: [2, 2],
    cost: 230,
    upkeep: 2,
    workers: 4,
    housing: 0,
    unlockPop: 50,
    color: 0x9c7f3f,
    service: {
      kind: 'teahouse',
      radius: 7,
      consumes: { resource: 'tea', amountPerDay: 1.2 },
      happiness: 6,
      incomePerDay: 6,
    },
  }),
  inn: B({
    key: 'inn',
    name: '客棧',
    desc: '供旅人歇腳，消耗酒，帶來可觀收入。',
    category: 'commerce',
    size: [2, 2],
    cost: 280,
    upkeep: 2,
    workers: 5,
    housing: 0,
    unlockPop: 140,
    color: 0x8e5b3d,
    service: {
      kind: 'inn',
      radius: 6,
      consumes: { resource: 'wine', amountPerDay: 1.2 },
      happiness: 3,
      incomePerDay: 12,
    },
  }),

  // ── 民生／政務 ──
  well: B({
    key: 'well',
    name: '水井',
    desc: '提供乾淨水源，提升周邊幸福度。',
    category: 'civic',
    size: [1, 1],
    cost: 60,
    upkeep: 0,
    workers: 0,
    housing: 0,
    unlockPop: 0,
    color: 0x7f9aa6,
    service: { kind: 'well', radius: 5, happiness: 3 },
  }),
  temple: B({
    key: 'temple',
    name: '寺廟',
    desc: '香火鼎盛，安撫民心，提升周邊幸福度。',
    category: 'civic',
    size: [2, 2],
    cost: 320,
    upkeep: 2,
    workers: 3,
    housing: 0,
    unlockPop: 60,
    color: 0xb0453c,
    service: { kind: 'temple', radius: 10, happiness: 8 },
  }),
  school: B({
    key: 'school',
    name: '學堂',
    desc: '教書育人，提升文化需求滿足度。',
    category: 'civic',
    size: [2, 2],
    cost: 300,
    upkeep: 2,
    workers: 4,
    housing: 0,
    unlockPop: 80,
    color: 0x6f7f5a,
    service: { kind: 'school', radius: 8, happiness: 5 },
  }),
  yamen: B({
    key: 'yamen',
    name: '衙門',
    desc: '官府治所，提升稅收效率與治安。',
    category: 'civic',
    size: [3, 3],
    cost: 560,
    upkeep: 5,
    workers: 8,
    housing: 0,
    unlockPop: 100,
    color: 0xa53f37,
    service: { kind: 'yamen', radius: 14, happiness: 4, taxBonus: 0.15 },
  }),
  pavilion: B({
    key: 'pavilion',
    name: '涼亭',
    desc: '園林小景，為周邊增添雅趣。',
    category: 'decoration',
    size: [1, 1],
    cost: 80,
    upkeep: 0,
    workers: 0,
    housing: 0,
    unlockPop: 0,
    color: 0x9a6a4a,
    service: { kind: 'pavilion', radius: 4, happiness: 2 },
  }),
  dock: B({
    key: 'dock',
    name: '碼頭',
    desc: '臨水而建，出口多餘貨物換取白銀。',
    category: 'commerce',
    size: [3, 2],
    cost: 380,
    upkeep: 3,
    workers: 5,
    housing: 0,
    unlockPop: 200,
    color: 0x6b7f8a,
    needsWater: true,
    service: { kind: 'dock', radius: 3, incomePerDay: 4 },
  }),
};

export const BUILDING_LIST = Object.values(BUILDINGS);

export const CATEGORY_INFO: Record<BuildingCategory, { name: string; order: number }> = {
  residential: { name: '民居', order: 1 },
  production: { name: '生產', order: 2 },
  storage: { name: '倉儲', order: 3 },
  commerce: { name: '商業', order: 4 },
  civic: { name: '民生', order: 5 },
  decoration: { name: '裝飾', order: 6 },
};

export const ROAD_COST = 4;
export const ROAD_UPKEEP = 0;
export const DEMOLISH_REFUND_RATE = 0.3;

/** 建築總維護費（每月） */
export function totalUpkeep(buildings: { key: string }[]): number {
  return buildings.reduce((sum, b) => sum + (BUILDINGS[b.key]?.upkeep ?? 0), 0);
}

// ─────────────────────────── 市民姓名 ───────────────────────────

export const SURNAMES = [
  '王', '李', '張', '劉', '陳', '楊', '趙', '黃', '周', '吳',
  '徐', '孫', '胡', '朱', '高', '林', '何', '郭', '馬', '羅',
  '梁', '宋', '鄭', '謝', '韓', '唐', '馮', '于', '董', '蕭',
  '程', '曹', '袁', '鄧', '許', '傅', '沈', '曾', '彭', '呂',
];

export const GIVEN_NAMES = [
  '安', '樂', '福', '順', '德', '仁', '義', '禮', '智', '信',
  '春', '花', '月', '明', '亮', '清', '風', '雨', '雪', '晴',
  '文', '武', '成', '美', '玉', '蘭', '竹', '梅', '松', '柏',
  '小', '大', '山', '河', '海', '天', '雲', '星', '辰', '光',
  '寶', '貴', '榮', '華', '興', '旺', '發', '達', '平', '和',
];

// ─────────────────────────── 工具函式 ───────────────────────────

export function createSimContext(toast: (text: string, kind?: LogKind) => void): SimContext {
  return {
    toast,
    log: (text: string, kind: LogKind = 'info') => toast(text, kind),
  };
}

/** 天氣轉移的隨機挑選（使用傳入的 rng） */
export function pickWeather(season: Season, rng: () => number): Weather {
  const weights = WEATHER_WEIGHTS[season];
  const entries = Object.entries(weights) as [Weather, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [weather, weight] of entries) {
    r -= weight;
    if (r <= 0) return weather;
  }
  return 'clear';
}

export function formatMoney(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(Math.round(amount));
  return `${sign}${abs.toLocaleString('zh-Hant')} 兩`;
}

export const COLOR = {
  ink: '#2b2620',
  paper: '#efe6d3',
  paperDark: '#e2d5bd',
  red: '#a53f37',
  gold: '#c8a04a',
  jade: '#5f7f63',
  textLight: '#f4ead7',
};
