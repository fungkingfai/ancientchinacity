/**
 * 時間／日期顯示工具（供 UI 使用）。
 */

import { MONTHS_PER_YEAR, SEASON_INFO, WEEK_NAMES } from './config';
import type { GameClock, Season } from './types';

const SHICHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

/** 時辰名稱，例如 6:30 → 卯時 */
export function shichenName(hour: number): string {
  const idx = Math.floor(((hour + 1) % 24) / 2);
  return `${SHICHEN[idx]}時`;
}

/** 例如：第1年 春 三月初七 · 卯時 */
export function formatGameDate(clock: GameClock): string {
  const season = SEASON_INFO[clock.season];
  return `第${clock.year}年 ${season.name} ${clock.month}月${clock.day}日 · ${shichenName(clock.hour)}`;
}

/** 短日期，例如：1年3月7日 */
export function formatShortDate(clock: GameClock): string {
  return `${clock.year}年${clock.month}月${clock.day}日`;
}

/** 24 小時制時鐘，例如 06:30 */
export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function seasonName(season: Season): string {
  return SEASON_INFO[season].name;
}

/** 一年中的第幾天（1-based），供季節曲線使用 */
export function dayOfYear(clock: GameClock): number {
  return (clock.month - 1) * 7 + clock.day;
}

export function monthName(month: number): string {
  return `${month}月`;
}

export function weekdayName(clock: GameClock): string {
  return WEEK_NAMES[clock.totalDays % WEEK_NAMES.length];
}

export function yearProgress(clock: GameClock): number {
  const totalDays = MONTHS_PER_YEAR * 7;
  return ((clock.month - 1) * 7 + (clock.day - 1)) / totalDays;
}
