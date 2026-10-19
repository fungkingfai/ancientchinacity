/**
 * 介面圖示：全部以內嵌 SVG 或文字自繪，不依賴任何外部圖片／字型。
 */

import { RESOURCES, RESOURCE_KEYS, SEASON_INFO, WEATHER_INFO } from '../core/config';
import type { ResourceKey, Season, Weather } from '../core/types';
import { esc, fmtAmount } from './dom';

const wrap = (body: string): string =>
  `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  coin: wrap('<circle cx="8" cy="8" r="6.1"/><rect x="6.1" y="6.1" width="3.8" height="3.8" rx="0.4"/>'),
  people: wrap(
    '<circle cx="5.6" cy="5.8" r="2.3"/><path d="M1.9 13.1c.5-2.7 2.1-4 3.7-4s3.2 1.3 3.7 4"/>' +
      '<circle cx="11.6" cy="6.6" r="1.8"/><path d="M10.6 9.6c1.7 0 3 1.1 3.4 3.3"/>',
  ),
  heart: wrap('<path d="M8 13.4S2.2 10 2.2 5.9A3.1 3.1 0 0 1 8 3.6a3.1 3.1 0 0 1 5.8 2.3c0 4.1-5.8 7.5-5.8 7.5Z"/>'),
  grain: wrap(
    '<path d="M8 14V4.2"/><path d="M8 7.6C6.2 7.6 4.9 6.3 4.9 4.5 6.7 4.5 8 5.8 8 7.6Z"/>' +
      '<path d="M8 7.6c1.8 0 3.1-1.3 3.1-3.1C9.3 4.5 8 5.8 8 7.6Z"/>' +
      '<path d="M8 11c-1.8 0-3.1-1.3-3.1-3.1 1.8 0 3.1 1.3 3.1 3.1Z"/>' +
      '<path d="M8 11c1.8 0 3.1-1.3 3.1-3.1C9.3 7.9 8 9.2 8 11Z"/>',
  ),
  clock: wrap('<circle cx="8" cy="8" r="6.1"/><path d="M8 4.6V8l2.4 1.5"/>'),
  sun: wrap(
    '<circle cx="8" cy="8" r="3.1"/><path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7' +
      'M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2"/>',
  ),
  cloud: wrap('<path d="M4.6 12.3h7a2.6 2.6 0 0 0 .2-5.2A3.7 3.7 0 0 0 5 6.2a3 3 0 0 0-.4 6.1Z"/>'),
  rain: wrap(
    '<path d="M4.6 10.2h7a2.6 2.6 0 0 0 .2-5.2A3.7 3.7 0 0 0 5 4.1a3 3 0 0 0-.4 6.1Z"/>' +
      '<path d="m5.6 12.4-.6 1.8M8.4 12.4l-.6 1.8M11.2 12.4l-.6 1.8"/>',
  ),
  snow: wrap(
    '<path d="M8 2v12M3 5l10 6M13 5 3 11"/><path d="m6.4 3.2 1.6 1.4 1.6-1.4M6.4 12.8 8 11.4l1.6 1.4"/>',
  ),
  pause: wrap('<rect x="5" y="3.6" width="2.2" height="8.8" rx="0.5"/><rect x="8.8" y="3.6" width="2.2" height="8.8" rx="0.5"/>'),
  play1: wrap('<path d="M5.4 3.8 12 8l-6.6 4.2Z"/>'),
  play2: wrap('<path d="M3.4 3.8 9 8l-5.6 4.2Z"/><path d="M9.4 3.8 15 8l-5.6 4.2Z"/>'),
  play3: wrap('<path d="M1.6 3.8 6 8l-4.4 4.2Z"/><path d="M6.6 3.8 11 8l-4.4 4.2Z"/><path d="M11.6 3.8 16 8l-4.4 4.2Z"/>'),
  close: wrap('<path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/>'),
  chevronLeft: wrap('<path d="M9.8 3.6 5.4 8l4.4 4.4"/>'),
  chevronRight: wrap('<path d="M6.2 3.6 10.6 8l-4.4 4.4"/>'),
  lock: wrap('<rect x="3.6" y="7" width="8.8" height="6.2" rx="1"/><path d="M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7"/>'),
  road: wrap('<path d="M5.2 2.2 3.4 13.8M10.8 2.2l1.8 11.6"/><path d="M8 3.2v1.8M8 7.4v1.8M8 11.6v1.8" stroke-dasharray="1 2"/>'),
  hammer: wrap(
    '<path d="m3.2 13 4.9-4.9"/><path d="M7.2 2.9 12.9 8.6l-1.7 1.7L5.5 4.6Z"/><path d="M6.6 2.1 9 4.5"/>',
  ),
  door: wrap(
    '<path d="M4.2 13.4V3.2h6.2l2.2 1.6v8.6"/><path d="M2.6 13.4h10.8"/><path d="M8.4 8.2h.1"/>',
  ),
  back: wrap('<path d="M13.2 8H3.4"/><path d="M7.4 4 3.4 8l4 4"/>'),
  book: wrap(
    '<path d="M8 3.4C6.4 2.2 4.2 2.1 2.4 2.6v10c1.8-.5 4-.4 5.6.8 1.6-1.2 3.8-1.3 5.6-.8v-10c-1.8-.5-4-.4-5.6.8Z"/>' +
      '<path d="M8 3.4v10"/>',
  ),
  warn: wrap('<path d="M8 2.2 14.2 13H1.8Z"/><path d="M8 6.4v3.4M8 11.6h.1"/>'),
  check: wrap('<path d="m2.8 8.4 3.4 3.4 7-8"/>'),
  info: wrap('<circle cx="8" cy="8" r="6.1"/><path d="M8 7.2v4M8 4.9h.1"/>'),
  lantern: wrap(
    '<path d="M5.2 3.2h5.6M5.2 12.8h5.6"/>' +
      '<path d="M4.4 4.4c-1.1 1.2-1.1 6 0 7.2.8.9 6.4.9 7.2 0 1.1-1.2 1.1-6 0-7.2-.8-.9-6.4-.9-7.2 0Z"/>' +
      '<path d="M8 2v1.2M8 12.8V14"/>',
  ),
  scroll: wrap(
    '<path d="M4 3.2h8.4a1.4 1.4 0 0 1 0 2.8H5.4V12a1.4 1.4 0 0 1-2.8 0V4.6a1.4 1.4 0 0 1 1.4-1.4Z"/>' +
      '<path d="M8 6.6h3.6M8 9h3.6"/>',
  ),
  ingot: wrap(
    '<path d="M2.2 10.8h11.6l-1.4-3.2c-.2-.5-.7-.8-1.2-.8H4.8c-.5 0-1 .3-1.2.8Z"/>' +
      '<path d="M4 3.4c1.2.9 2.4 1.3 4 1.3s2.8-.4 4-1.3"/>',
  ),
  seal: wrap('<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1"/><path d="M5 8h6M8 5v6"/>'),
  temple: wrap(
    '<path d="M2.4 6.4 8 2.6l5.6 3.8"/><path d="M3.4 6.4h9.2v6.8H3.4Z"/><path d="M6.6 13.2V9.4h2.8v3.8"/>',
  ),
  cart: wrap(
    '<path d="M2 3.4h2l1.4 6.2h6.2l1.2-4.6H5"/><circle cx="6.4" cy="12.2" r="1.1"/><circle cx="11.2" cy="12.2" r="1.1"/>',
  ),
  compass: wrap('<circle cx="8" cy="8" r="6.1"/><path d="m5.4 10.6 2-3.2 3.2-2-2 3.2Z"/>'),
} as const;

export type IconName = keyof typeof ICON;

export const ico = (name: IconName): string => ICON[name];

/** 天氣對應圖示 */
export function weatherIcon(weather: Weather): string {
  switch (weather) {
    case 'clear':
      return ICON.sun;
    case 'cloudy':
      return ICON.cloud;
    case 'rain':
      return ICON.rain;
    default:
      return ICON.snow;
  }
}

export function weatherName(weather: Weather): string {
  return WEATHER_INFO[weather]?.name ?? weather;
}

export function weatherHint(weather: Weather): string {
  return WEATHER_INFO[weather]?.hint ?? '';
}

export function seasonGlyph(season: Season): string {
  return SEASON_INFO[season]?.name ?? '';
}

/** 朱紅印章（文字） */
export function sealHtml(text: string, extra = ''): string {
  return `<span class="seal${extra ? ` ${extra}` : ''}">${esc(text)}</span>`;
}

/** 資源小章（顏色方塊 + 名稱 + 數量） */
export function resourceChip(key: ResourceKey, amount: number): string {
  const def = RESOURCES[key];
  if (!def) return '';
  return (
    `<span class="res-chip" style="--res:${def.color}" title="${esc(def.name)}">` +
    `<i class="res-sq">${esc(def.short)}</i><b>${fmtAmount(amount)}</b><em>${esc(def.name)}</em></span>`
  );
}

/** 一組庫存 → 資源章列表 */
export function resourceChips(
  inventory: Partial<Record<ResourceKey, number>>,
  emptyText = '空空如也',
): string {
  const entries = (Object.entries(inventory) as [ResourceKey, number][]).filter(
    ([key, value]) => RESOURCES[key] && value > 0.01,
  );
  if (!entries.length) return `<span class="muted">${esc(emptyText)}</span>`;
  entries.sort((a, b) => RESOURCE_KEYS.indexOf(a[0]) - RESOURCE_KEYS.indexOf(b[0]));
  return entries.map(([key, value]) => resourceChip(key, value)).join('');
}

/** 市民名牌 */
export function personPill(name: string, sub = ''): string {
  return `<span class="person" title="${esc(name)}${sub ? ` · ${esc(sub)}` : ''}">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
}
