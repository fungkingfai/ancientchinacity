/**
 * 世界渲染共用工具（world-renderer 私有模組）。
 *
 * terrain.ts / roads.ts / environment.ts 共用同一套「地形高度、太陽方位、
 * 天空配色、天氣係數」，確保光影、水面反光與地形起伏一致。
 */

import * as THREE from 'three';
import { TERRAIN_INFO } from '../core/config';
import type { Season, TerrainType, Tile, Weather } from '../core/types';

// ─────────────────────────── 高度常數 ───────────────────────────

/** 水面高度（世界 y） */
export const WATER_SURFACE_Y = 0.14;
/** 一般可建平地的基準地面高度（建築底部約 y=0.28，剛好略埋入基座） */
export const GROUND_Y = 0.30;
/** 道路石板最低頂面高度 */
export const ROAD_BASE_Y = 0.345;

const GRASS_LIFT = 0.022;
const FERTILE_LIFT = 0.012;
const FOREST_LIFT = 0.02;
const SAND_LIFT = 0.012;
const HILL_LIFT = 0.055;
const MOUNTAIN_LIFT = 1.7;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 0..1 的平滑插值 */
function smooth01(v: number): number {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

/** 地塊頂面高度：可建地維持在 0.28~0.39（與建築 y≈0.28 相容），山地則大幅抬高。 */
export function tileTopY(tile: Tile): number {
  const e = tile.elevation;
  switch (tile.terrain) {
    case 'water':
      return 0.01;
    case 'sand':
      return GROUND_Y - 0.025 + smooth01((e - 0.28) / 0.08) * SAND_LIFT;
    case 'fertile':
      return GROUND_Y - 0.008 + smooth01((e - 0.30) / 0.1) * FERTILE_LIFT;
    case 'grass':
      return GROUND_Y + smooth01((e - 0.30) / 0.1) * GRASS_LIFT;
    case 'forest':
      return GROUND_Y + smooth01((e - 0.30) / 0.1) * FOREST_LIFT;
    case 'hill':
      return 0.335 + smooth01((e - 0.55) / 0.25) * HILL_LIFT;
    case 'mountain':
      return 0.95 + smooth01((e - 0.7) / 0.3) * MOUNTAIN_LIFT;
    default:
      return GROUND_Y;
  }
}

/** 道路石板頂面高度（跟隨地形，略高於地面） */
export function roadSurfaceY(tile: Tile): number {
  return Math.max(ROAD_BASE_Y, tileTopY(tile) + 0.03);
}

/** 地形顏色（不含每格 variant 的明暗），供基礎渲染與小地圖參考 */
export function terrainBaseColor(terrain: TerrainType, out: THREE.Color): THREE.Color {
  return out.setHex(TERRAIN_INFO[terrain]?.color ?? 0x86a85c);
}

// ─────────────────────────── 季節配色 ───────────────────────────

interface SeasonPalette {
  /** 平地草色 */
  grass: number;
  /** 沃土／水田 */
  fertile: number;
  /** 林地 */
  forest: number;
  /** 丘陵 */
  hill: number;
  /** 山岩 */
  mountain: number;
  /** 沙岸 */
  sand: number;
  /** 樹葉主色（松柏常綠另計） */
  leaf: number;
  /** 落葉樹秋色 */
  leafWarm: number;
  /** 山頂積雪混合量 0..1 */
  snow: number;
  /** 整體濕潤亮度 */
  vivid: number;
}

const SEASON_PALETTES: Record<Season, SeasonPalette> = {
  spring: {
    grass: 0x7cab4d,
    fertile: 0x94b356,
    forest: 0x46703c,
    hill: 0x8a8f60,
    mountain: 0x838073,
    sand: 0xc9b98c,
    leaf: 0x6f9e52,
    leafWarm: 0xc48a9a,
    snow: 0,
    vivid: 1.0,
  },
  summer: {
    grass: 0x5f8c3d,
    fertile: 0x7a9f44,
    forest: 0x315c31,
    hill: 0x757850,
    mountain: 0x7a776d,
    sand: 0xc6b288,
    leaf: 0x4f8040,
    leafWarm: 0x8a9a4a,
    snow: 0,
    vivid: 1.0,
  },
  autumn: {
    grass: 0x9c8f48,
    fertile: 0xa89a50,
    forest: 0x6f5a2f,
    hill: 0x8d835a,
    mountain: 0x7c766c,
    sand: 0xc2af84,
    leaf: 0xb07b3c,
    leafWarm: 0xc4683f,
    snow: 0,
    vivid: 1.0,
  },
  winter: {
    grass: 0x9ea392,
    fertile: 0xa6a68c,
    forest: 0x606a58,
    hill: 0x9c9c94,
    mountain: 0xbfc7cc,
    sand: 0xd2cab6,
    leaf: 0x6b7b60,
    leafWarm: 0x8a7a68,
    snow: 0.75,
    vivid: 0.96,
  },
};

export interface SeasonColors {
  grass: THREE.Color;
  fertile: THREE.Color;
  forest: THREE.Color;
  hill: THREE.Color;
  mountain: THREE.Color;
  sand: THREE.Color;
  leaf: THREE.Color;
  leafWarm: THREE.Color;
  snow: number;
  vivid: number;
}

export function seasonColors(season: Season, out: SeasonColors): SeasonColors {
  const p = SEASON_PALETTES[season];
  out.grass.setHex(p.grass);
  out.fertile.setHex(p.fertile);
  out.forest.setHex(p.forest);
  out.hill.setHex(p.hill);
  out.mountain.setHex(p.mountain);
  out.sand.setHex(p.sand);
  out.leaf.setHex(p.leaf);
  out.leafWarm.setHex(p.leafWarm);
  out.snow = p.snow;
  out.vivid = p.vivid;
  return out;
}

export function createSeasonColors(): SeasonColors {
  return {
    grass: new THREE.Color(),
    fertile: new THREE.Color(),
    forest: new THREE.Color(),
    hill: new THREE.Color(),
    mountain: new THREE.Color(),
    sand: new THREE.Color(),
    leaf: new THREE.Color(),
    leafWarm: new THREE.Color(),
    snow: 0,
    vivid: 1,
  };
}

// ─────────────────────────── 太陽／月亮 ───────────────────────────

export interface SunState {
  /** 太陽方向（單位向量，由地面指向太陽） */
  dir: THREE.Vector3;
  /** 太陽高度（-1..1，y 分量） */
  elevation: number;
  /** 0=夜、1=正午 */
  daylight: number;
}

export function createSunState(): SunState {
  return { dir: new THREE.Vector3(0.4, 0.8, 0.3).normalize(), elevation: 0.8, daylight: 1 };
}

/** 各季日出／日落時刻（小時） */
function sunTimes(season: Season): { sunrise: number; sunset: number; maxElev: number } {
  switch (season) {
    case 'spring':
      return { sunrise: 6.1, sunset: 18.2, maxElev: 0.78 };
    case 'summer':
      return { sunrise: 5.2, sunset: 19.1, maxElev: 0.92 };
    case 'autumn':
      return { sunrise: 6.2, sunset: 17.9, maxElev: 0.68 };
    case 'winter':
      return { sunrise: 7.1, sunset: 17.0, maxElev: 0.52 };
    default:
      return { sunrise: 6, sunset: 18, maxElev: 0.8 };
  }
}

function sunPath(hour: number, minute: number, season: Season, out: THREE.Vector3): { elevation: number; daylight: number } {
  const { sunrise, sunset, maxElev } = sunTimes(season);
  const h = hour + minute / 60;
  const dayLen = sunset - sunrise;
  const t = (h - sunrise) / dayLen;
  const az = Math.PI * t; // 0 = 東升, PI = 西落
  const sinAz = Math.sin(az);
  const along = Math.cos(az); // 東 → 西
  // 正午太陽偏南（世界 +z 為南），讓陰影略往北落
  out.set(along, sinAz * Math.sin(maxElev), 0.42 * sinAz + 0.12).normalize();
  const elevation = out.y;
  const daylight = smooth01((elevation + 0.08) / 0.34);
  return { elevation, daylight };
}

/** 計算太陽狀態；回傳物件由呼叫端持有，避免每幀配置 */
export function computeSun(hour: number, minute: number, season: Season, out: SunState): SunState {
  const r = sunPath(hour, minute, season, out.dir);
  out.elevation = r.elevation;
  out.daylight = r.daylight;
  return out;
}

/** 月亮方向（與太陽大致相反，夜晚高掛） */
export function computeMoonDir(hour: number, minute: number, season: Season, out: THREE.Vector3): THREE.Vector3 {
  const h = (hour + 12) % 24;
  sunPath(h, minute, season, out);
  out.y = Math.max(-0.2, out.y * 0.85);
  out.normalize();
  return out;
}

// ─────────────────────────── 天空配色 ───────────────────────────

export interface SkyPalette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  sun: THREE.Color;
  moon: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  ambient: THREE.Color;
}

export function createSkyPalette(): SkyPalette {
  return {
    zenith: new THREE.Color(0x5f9fd0),
    horizon: new THREE.Color(0xd8e6d8),
    fog: new THREE.Color(0xc8dce8),
    sun: new THREE.Color(0xfff0cf),
    moon: new THREE.Color(0xd8e2ff),
    hemiSky: new THREE.Color(0xdfefff),
    hemiGround: new THREE.Color(0x5d6b4a),
    ambient: new THREE.Color(0x9fb0c0),
  };
}

interface SkyScheme {
  nightZenith: number;
  nightHorizon: number;
  dayZenith: number;
  dayHorizon: number;
  duskZenith: number;
  duskHorizon: number;
  ground: number;
}

const SKY_SCHEMES: Record<Season, SkyScheme> = {
  spring: {
    nightZenith: 0x0b1428,
    nightHorizon: 0x243756,
    dayZenith: 0x6fb0d8,
    dayHorizon: 0xd6e6dc,
    duskZenith: 0x6b6a9e,
    duskHorizon: 0xf0a86a,
    ground: 0x5f6b44,
  },
  summer: {
    nightZenith: 0x0a1226,
    nightHorizon: 0x22344f,
    dayZenith: 0x589aca,
    dayHorizon: 0xd8e8da,
    duskZenith: 0x77658e,
    duskHorizon: 0xf59a56,
    ground: 0x4e613c,
  },
  autumn: {
    nightZenith: 0x0b1426,
    nightHorizon: 0x263750,
    dayZenith: 0x73a4c8,
    dayHorizon: 0xe8d8b8,
    duskZenith: 0x6f5f8c,
    duskHorizon: 0xf0a25e,
    ground: 0x6b634a,
  },
  winter: {
    nightZenith: 0x0b1429,
    nightHorizon: 0x2a3c58,
    dayZenith: 0x8aa8c2,
    dayHorizon: 0xdde6ec,
    duskZenith: 0x5f6a92,
    duskHorizon: 0xe8a878,
    ground: 0x7b7f80,
  },
};

const tmpColorA = new THREE.Color();
const tmpColorB = new THREE.Color();

const WEATHER_SKY: Record<Weather, { color: number; amount: number; fog: number }> = {
  clear: { color: 0xffffff, amount: 0, fog: 0 },
  cloudy: { color: 0x9aa6b2, amount: 0.55, fog: 0.25 },
  rain: { color: 0x66727e, amount: 0.68, fog: 0.45 },
  snow: { color: 0xc2ccd6, amount: 0.55, fog: 0.35 },
};

/**
 * 依季節、天氣、日照取樣天空／霧／光照配色（寫入 out，可每幀呼叫）。
 */
export function sampleSkyPalette(
  season: Season,
  weather: Weather,
  daylight: number,
  out: SkyPalette,
): SkyPalette {
  const scheme = SKY_SCHEMES[season];
  const dayMix = smooth01(daylight);
  const nightMix = 1 - dayMix;
  // 晨昏暖色：只在太陽貼近地平線時出現，深夜與正午皆為 0
  const duskWindow = clamp01(1 - Math.abs(daylight - 0.24) / 0.2);
  const duskMix = duskWindow * clamp01((daylight - 0.03) / 0.09) * 0.85;

  out.zenith
    .setHex(scheme.nightZenith)
    .lerp(tmpColorA.setHex(scheme.dayZenith), dayMix)
    .lerp(tmpColorB.setHex(scheme.duskZenith), duskMix * 0.5);
  out.horizon
    .setHex(scheme.nightHorizon)
    .lerp(tmpColorA.setHex(scheme.dayHorizon), dayMix)
    .lerp(tmpColorB.setHex(scheme.duskHorizon), duskMix);

  // 天氣：陰雨雪時天空轉灰、飽和度降低
  const w = WEATHER_SKY[weather];
  if (w.amount > 0) {
    tmpColorA.setHex(w.color);
    // 夜晚的陰天灰要更暗
    tmpColorA.multiplyScalar(0.25 + dayMix * 0.75);
    out.zenith.lerp(tmpColorA, w.amount * 0.85);
    out.horizon.lerp(tmpColorA, w.amount);
  }

  // 太陽色：晨昏偏橘，正午偏暖白
  tmpColorA.setHex(0xff6f38);
  tmpColorB.setHex(0xfff2d6);
  out.sun.copy(tmpColorA).lerp(tmpColorB, smooth01((daylight - 0.1) / 0.5));

  // 月亮：淡藍白
  out.moon.setHex(0xd4e0ff).multiplyScalar(0.9);

  // 半球光與環境光
  out.hemiSky.copy(out.horizon).lerp(out.zenith, 0.55);
  out.hemiGround.setHex(scheme.ground).multiplyScalar(0.5 + 0.6 * dayMix);
  out.ambient.copy(out.hemiSky).multiplyScalar(0.55 + nightMix * 0.28);

  // 霧：以地平線色為底，但降低飽和度（避免晨昏時整個世界變成橘褐色）
  out.fog.copy(out.horizon);
  {
    const lum = out.fog.r * 0.3 + out.fog.g * 0.55 + out.fog.b * 0.15;
    out.fog.lerp(tmpColorA.setRGB(lum, lum, lum * 1.04), 0.42);
    // 夜間霧色提亮一點點，避免遠景整片死黑
    if (nightMix > 0.5) out.fog.lerp(tmpColorA.setRGB(0.055, 0.075, 0.115), (nightMix - 0.5) * 0.5);
  }
  if (w.fog > 0) {
    out.fog.lerp(tmpColorA.setHex(weather === 'snow' ? 0xdfe6ec : 0x8c98a4), w.fog * 0.75);
  }
  // 晨昏時霧氣帶一點暖色
  if (duskMix > 0) out.fog.lerp(tmpColorA.setHex(0xe8b088), duskMix * 0.14);
  return out;
}

/** 霧的遠近距離（相機距離尺度） */
export function fogRange(weather: Weather, daylight: number): { near: number; far: number } {
  const base = 95 + daylight * 90;
  // 夜間稍微放寬霧距，讓城市與遠山在月色下仍可辨識
  const nightK = 1 - clamp01(daylight * 3);
  const nearK = 1 + nightK * 0.55;
  const farK = 1 + nightK * 0.85;
  switch (weather) {
    case 'rain':
      return { near: base * 0.28 * nearK, far: base * 1.5 * farK };
    case 'snow':
      return { near: base * 0.2 * nearK, far: base * 1.15 * farK };
    case 'cloudy':
      return { near: base * 0.4 * nearK, far: base * 1.8 * farK };
    default:
      return { near: base * 0.45 * nearK, far: base * 2.05 * farK };
  }
}

/** 風力（影響樹搖曳、粒子橫向漂移） */
export function windStrength(weather: Weather, intensity: number): number {
  switch (weather) {
    case 'rain':
      return 1.6 + intensity * 1.4;
    case 'snow':
      return 1.1 + intensity * 0.8;
    case 'cloudy':
      return 0.9 + intensity * 0.3;
    default:
      return 0.45 + intensity * 0.2;
  }
}

/** 降水種類；晴／陰回傳 null */
export function precipitationKind(weather: Weather): 'rain' | 'snow' | null {
  if (weather === 'rain') return 'rain';
  if (weather === 'snow') return 'snow';
  return null;
}

/** 天氣對日照亮度的乘數（陰雨雪天變暗） */
export function weatherLightFactor(weather: Weather): number {
  switch (weather) {
    case 'cloudy':
      return 0.78;
    case 'rain':
      return 0.52;
    case 'snow':
      return 0.62;
    default:
      return 1;
  }
}

/** 雪覆蓋量（0..1）：冬季 + 下雪時最高 */
export function snowCover(season: Season, weather: Weather, tempC: number): number {
  const cold = clamp01((1 - tempC) / 6);
  if (season !== 'winter') {
    return weather === 'snow' ? clamp01(cold) : 0;
  }
  const base = 0.45 + cold * 0.3;
  return clamp01(weather === 'snow' ? base + 0.25 : base);
}
