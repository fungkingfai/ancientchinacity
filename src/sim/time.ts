/**
 * 時間系統：推進時鐘、日期換算、四季轉換、天氣轉移、氣溫與天氣強度。
 *
 * 對外契約（見 docs/ARCHITECTURE.md）：
 *   advanceClock(state, gameMinutes, ctx): TickFlags
 *   weatherModifiers(state) / daylightFactor(state) / weatherLabel(state)
 *
 * 設計重點
 * - 天氣依 `WEATHER_WEIGHTS` 做加權轉移，且帶有「持續性」偏向（不容易立刻變天）；
 *   非冬季永遠不會下雪（冬季外雪權重強制歸零，並有保險絲）。
 * - 天氣持續時間依 docs/GAME_DESIGN.md §7.4：300 + random×420 遊戲分鐘
 *   （約 6.3~15 真實秒 @1 倍速），冬季再 ×0.8；避免每 2~7 秒變天與粒子閃爍。
 * - 氣溫 = 季節基準 + 日夜正弦曲線（14 時最暖、02 時最冷）+ 天氣修正，指數平滑；
 *   weatherIntensity 亦以指數平滑趨近目標，供環境渲染做雨雪粒子與霧的淡入淡出。
 * - 重要事件（立春／初雪／暴雨／新年）只以單一訊息通知，避免 ctx.log 與
 *   ctx.toast 重複（目前 main.ts 的 createSimContext 會把 log 也轉成 toast）。
 */

import { deriveClockFields } from '../core/new-game';
import {
  SEASON_INFO,
  SEASON_TEMP,
  WEATHER_EFFECT,
  WEATHER_INFO,
  WEATHER_WEIGHTS,
} from '../core/config';
import { mulberry32, type Rng } from '../core/rng';
import type { GameState, LogKind, Season, SimContext, Weather } from '../core/types';

export interface TickFlags {
  newDay: boolean;
  newMonth: boolean;
  newYear: boolean;
  /** 季節轉換（春→夏→秋→冬），本幀剛跨過季界 */
  newSeason: boolean;
}

/** 雨／雪粒子的目標強度（cloudy 保留少量，供陰天霧氣使用） */
const WEATHER_TARGET_INTENSITY: Record<Weather, number> = {
  clear: 0,
  cloudy: 0.12,
  rain: 0.78,
  snow: 0.9,
};

/** 天氣持續時間（遊戲分鐘）：300 + random×420；冬季 ×0.8（GAME_DESIGN §7.4） */
const WEATHER_MIN_MINUTES = 300;
const WEATHER_VARIANCE_MINUTES = 420;
/** 冬季天氣持續時間倍率 */
const WINTER_DURATION_MULT = 0.8;

/** 天氣對氣溫的修正（攝氏，GAME_DESIGN §7.5：晴 +1、陰 −2、雨 −2、雪 −8） */
const WEATHER_TEMP_OFFSET: Record<Weather, number> = {
  clear: 1,
  cloudy: -2,
  rain: -2,
  snow: -8,
};

/** 日夜溫差振幅（攝氏，GAME_DESIGN §7.5：±5°C、以 9 時為基準） */
const DIURNAL_AMPLITUDE = 5;

/** 有效的天氣（權重 > 0 且符合季節限制）清單 */
function weatherEntries(season: Season): [Weather, number][] {
  const weights = WEATHER_WEIGHTS[season];
  const entries: [Weather, number][] = [];
  for (const weather of ['clear', 'cloudy', 'rain', 'snow'] as Weather[]) {
    const weight = weights[weather] ?? 0;
    // 硬規則：只有冬季可能下雪
    if (weather === 'snow' && season !== 'winter') continue;
    if (weight > 0) entries.push([weather, weight]);
  }
  if (!entries.length) entries.push(['clear', 1]);
  return entries;
}

/**
 * 以目前時間與種子產生一次性亂數源（不影響世界生成的 seed 流），
 * 讓天氣轉移在相同存檔下儘量可重現，同時保有變化。
 */
function weatherRng(state: GameState): Rng {
  const { clock } = state;
  const salt =
    Math.floor(clock.minutes) * 2654435761 +
    clock.totalDays * 40503 +
    Math.floor(clock.weatherMinutesLeft * 977);
  return mulberry32((state.seed ^ salt) >>> 0);
}

/** 依季節權重挑選下一段天氣（目前天氣有持續性加成） */
function chooseWeather(season: Season, current: Weather, rng: Rng): Weather {
  const entries = weatherEntries(season);
  let total = 0;
  for (const [weather, weight] of entries) {
    total += weather === current ? weight * 1.25 : weight;
  }
  let roll = rng() * total;
  for (const [weather, weight] of entries) {
    roll -= weather === current ? weight * 1.25 : weight;
    if (roll <= 0) return weather;
  }
  return entries[entries.length - 1][0];
}

function monthSeasonName(season: Season): string {
  switch (season) {
    case 'spring':
      return '立春';
    case 'summer':
      return '立夏';
    case 'autumn':
      return '立秋';
    default:
      return '立冬';
  }
}

function seasonToast(season: Season): string {
  switch (season) {
    case 'spring':
      return '萬物復甦，正是春耕時節。';
    case 'summer':
      return '夏日炎炎，注意農田灌溉。';
    case 'autumn':
      return '秋收在望，糧食增產。';
    case 'winter':
      return '冬雪將至，注意糧食儲備。';
  }
}

function weatherOnsetText(weather: Weather, season: Season): string {
  switch (weather) {
    case 'snow':
      return '瑞雪紛飛，天寒地凍；行人稀少，農作停歇。';
    case 'rain':
      return season === 'summer'
        ? '夏日暴雨傾盆，河水暴漲，行人腳步放緩。'
        : '細雨綿綿，滋潤農田，行人腳步放緩。';
    case 'clear':
      return '雲開見日，天氣轉晴，適合外出耕作。';
    default:
      return '陰雲密佈，日光黯淡。';
  }
}

/** 抽下一段天氣並寫回 clock；回傳是否有變化 */
function rollWeather(state: GameState, ctx: SimContext): boolean {
  const clock = state.clock;
  const rng = weatherRng(state);
  const prev = clock.weather;
  let next = chooseWeather(clock.season, prev, rng);

  // 保險絲：非冬季不可下雪（權重已排除，這裡防存檔／外力造成的不一致）
  if (next === 'snow' && clock.season !== 'winter') next = 'rain';
  if (next === 'rain' && clock.season === 'winter' && rng() < 0.35) next = 'cloudy';

  const winterMult = clock.season === 'winter' ? WINTER_DURATION_MULT : 1;
  const duration = (WEATHER_MIN_MINUTES + rng() * WEATHER_VARIANCE_MINUTES) * winterMult;
  clock.weatherMinutesLeft = Math.max(60, Math.round(duration));
  clock.weather = next;

  if (next !== prev) {
    // 只通知「有感覺」的天氣事件，避免每段天氣都跳 toast：
    //   雪 → 一定通知；雨 → 只在由晴轉雨時（六成機率）；轉晴 → 只在雨雪之後（五成機率）；陰天不通知
    const announce =
      next === 'snow'
        ? true
        : next === 'rain'
          ? prev === 'clear' && rng() < 0.6
          : next === 'clear'
            ? (prev === 'rain' || prev === 'snow') && rng() < 0.5
            : false;
    if (announce) ctx.toast(weatherOnsetText(next, clock.season), weatherTone(next));
  }
  return next !== prev;
}

function weatherTone(weather: Weather): LogKind {
  switch (weather) {
    case 'clear':
      return 'good';
    case 'rain':
      return 'info';
    case 'snow':
      return 'warn';
    default:
      return 'info';
  }
}

/** 季節轉換通知（與新年合併成一句，避免 toast 連發） */
function announceSeason(state: GameState, isNewYear: boolean, ctx: SimContext): void {
  const clock = state.clock;
  const info = SEASON_INFO[clock.season];
  const label = monthSeasonName(clock.season);
  const yearNote = isNewYear ? `，第 ${clock.year} 年開始` : '';
  ctx.log(`${label}：時序入${info.name}${yearNote}。${seasonToast(clock.season)}`, isNewYear ? 'good' : 'info');
}

/** 推進遊戲時間；回傳跨日／跨月／跨年／跨季旗標 */
export function advanceClock(state: GameState, gameMinutes: number, ctx: SimContext): TickFlags {
  const clock = state.clock;
  const prevDay = clock.totalDays;
  const prevMonth = clock.month;
  const prevYear = clock.year;
  const prevSeason = clock.season;

  if (!Number.isFinite(gameMinutes) || gameMinutes <= 0) {
    return {
      newDay: false,
      newMonth: false,
      newYear: false,
      newSeason: false,
    };
  }

  // 1) 推進絕對分鐘並推導日期欄位（new-game.ts 的 deriveClockFields 為唯一來源）
  clock.minutes += gameMinutes;
  deriveClockFields(clock);

  // 2) 天氣計時：正常情況下一幀只會跨 1 段；以 while 容錯大 dt／讀檔後補償
  clock.weatherMinutesLeft -= gameMinutes;
  let guard = 0;
  while (clock.weatherMinutesLeft <= 0 && guard < 12) {
    rollWeather(state, ctx);
    guard++;
  }

  // 3) 季節切換時校正不合理的天氣（例如春天下雪）
  if (clock.season !== 'winter' && clock.weather === 'snow') {
    clock.weather = 'rain';
    clock.weatherMinutesLeft = Math.min(clock.weatherMinutesLeft, 180);
  }

  const flags: TickFlags = {
    newDay: clock.totalDays !== prevDay,
    newMonth: clock.month !== prevMonth,
    newYear: clock.year !== prevYear,
    newSeason: clock.season !== prevSeason,
  };

  // 4) 季節／年份事件（只發一次訊息；跨月由 finance 負責月報表）
  if (flags.newSeason) announceSeason(state, flags.newYear, ctx);

  // 5) 氣溫 = 季節基準 + 日夜正弦（±5°C、9 時為基準）+ 天氣修正，指數平滑避免跳變
  const hourFloat = clock.hour + clock.minute / 60;
  const diurnal = Math.sin(((hourFloat - 9) / 24) * Math.PI * 2) * DIURNAL_AMPLITUDE;
  const targetTemp = SEASON_TEMP[clock.season] + diurnal + WEATHER_TEMP_OFFSET[clock.weather];
  const tempBlend = 1 - Math.exp(-gameMinutes / 60);
  clock.tempC += (targetTemp - clock.tempC) * tempBlend;
  clock.tempC = clampNumber(clock.tempC, -18, 46);

  // 6) 雨雪強度平滑（帶一點強弱起伏，避免恆定值看起來死板）
  let intensityTarget = WEATHER_TARGET_INTENSITY[clock.weather];
  if (clock.weather === 'rain') {
    intensityTarget = clampNumber(0.62 + 0.22 * Math.sin(clock.minutes * 0.011) + 0.1 * Math.sin(clock.minutes * 0.037), 0.35, 1);
  } else if (clock.weather === 'snow') {
    intensityTarget = clampNumber(0.78 + 0.16 * Math.sin(clock.minutes * 0.009), 0.5, 1);
  }
  const intensityBlend = 1 - Math.exp(-gameMinutes / 40);
  clock.weatherIntensity += (intensityTarget - clock.weatherIntensity) * intensityBlend;
  clock.weatherIntensity = clampNumber(clock.weatherIntensity, 0, 1);

  return flags;
}


function clampNumber(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 目前天氣對農業、移動、幸福的乘數 */
export function weatherModifiers(state: GameState): { farm: number; move: number; happiness: number } {
  const effect = WEATHER_EFFECT[state.clock.weather];
  return { farm: effect.farm, move: effect.move, happiness: effect.happiness };
}

/** 日照進度 0..1（0=午夜, 0.5=正午） */
export function daylightFactor(state: GameState): number {
  const clock = state.clock;
  const t = (clock.hour * 60 + clock.minute) / (24 * 60);
  return Math.max(0, Math.sin((t - 0.25) * Math.PI * 2) * 0.5 + 0.5);
}

/** 是否正值夜間（供渲染／市民行為使用） */
export function isNight(state: GameState): boolean {
  const clock = state.clock;
  return clock.hour < 6 || clock.hour >= 19;
}

/** 目前是否正在下雨或下雪 */
export function isPrecipitating(state: GameState): boolean {
  return state.clock.weather === 'rain' || state.clock.weather === 'snow';
}

export function weatherLabel(state: GameState): string {
  const info = WEATHER_INFO[state.clock.weather];
  return `${info.emoji} ${info.name}`;
}
