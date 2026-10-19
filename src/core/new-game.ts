/**
 * 開新局：建立完整 GameState。
 */

import {
  DEFAULT_TAX_RATE,
  GAME_MINUTES_PER_SECOND,
  GAME_VERSION,
  MINUTES_PER_DAY,
  SEASON_TEMP,
  START_TREASURY,
  DAYS_PER_MONTH,
  MONTHS_PER_YEAR,
  pickWeather,
  seasonOfMonth,
} from './config';
import { mulberry32 } from './rng';
import type { GameClock, GameState, UIState } from './types';
import { generateWorld } from '../world/worldgen';

export function createClock(seed: number): GameClock {
  const rng = mulberry32(seed + 99);
  const season = seasonOfMonth(1);
  return {
    minutes: 6 * 60,
    totalDays: 1,
    day: 1,
    month: 1,
    year: 1,
    hour: 6,
    minute: 0,
    season,
    weather: pickWeather(season, rng),
    weatherMinutesLeft: 120 + Math.floor(rng() * 240),
    tempC: SEASON_TEMP[season],
    weatherIntensity: 0,
    paused: false,
    speed: 1,
  };
}

export function createUIState(): UIState {
  return {
    tool: null,
    selectedId: null,
    hover: -1,
    speed: 1,
    paused: false,
    mode: 'city',
    interiorId: null,
    buildCategory: 'residential',
    showFinance: false,
    showHelp: false,
    showSave: false,
    showTutorial: true,
    revision: 0,
  };
}

export function createGameState(seed = Math.floor(Math.random() * 1e9), cityName = '華夏古城'): GameState {
  const world = generateWorld(seed);
  const clock = createClock(seed);
  const state: GameState = {
    version: GAME_VERSION,
    seed,
    cityName,
    width: world.width,
    height: world.height,
    tiles: world.tiles,
    buildings: [],
    citizens: [],
    carts: [],
    clock,
    finance: {
      treasury: START_TREASURY,
      taxRate: DEFAULT_TAX_RATE,
      incomeThisMonth: 0,
      expenseThisMonth: 0,
      lastMonthIncome: 0,
      lastMonthExpense: 0,
      history: [],
      totalIncome: 0,
      totalExpense: 0,
      lastFestivalDay: -999,
    },
    stats: {
      population: 0,
      households: 0,
      jobs: 0,
      employed: 0,
      unemployed: 0,
      homeless: 0,
      happiness: 70,
      foodStored: 0,
      foodPerDay: 0,
      netIncome: 0,
      goodsInTransit: 0,
    },
    ui: createUIState(),
    log: [],
    nextBuildingId: 1,
    nextCitizenId: 1,
    nextCartId: 1,
    nextLogId: 1,
    createdAt: Date.now(),
    savedAt: Date.now(),
  };

  state.log.push({
    id: state.nextLogId++,
    year: 1,
    month: 1,
    day: 1,
    text: `歡迎來到${cityName}！先鋪設道路，再建造茅屋與農田，吸引百姓定居。`,
    kind: 'info',
  });
  return state;
}

/** 由分鐘數推算日期欄位（time.ts 亦使用，集中避免重複） */
export function deriveClockFields(clock: GameClock): void {
  const totalMinutes = Math.max(0, clock.minutes);
  const totalDays = Math.floor(totalMinutes / MINUTES_PER_DAY) + 1;
  const minutesOfDay = totalMinutes % MINUTES_PER_DAY;
  clock.totalDays = totalDays;
  clock.hour = Math.floor(minutesOfDay / 60);
  clock.minute = Math.floor(minutesOfDay % 60);
  const monthIndex = (totalDays - 1) % (DAYS_PER_MONTH * MONTHS_PER_YEAR);
  clock.month = Math.floor(monthIndex / DAYS_PER_MONTH) + 1;
  clock.day = (monthIndex % DAYS_PER_MONTH) + 1;
  clock.year = Math.floor((totalDays - 1) / (DAYS_PER_MONTH * MONTHS_PER_YEAR)) + 1;
  clock.season = seasonOfMonth(clock.month);
}

/** 遊戲分鐘 → 倍速換算 */
export function gameMinutesForRealDelta(realDt: number, speed: number): number {
  return realDt * GAME_MINUTES_PER_SECOND * Math.max(0, speed);
}
