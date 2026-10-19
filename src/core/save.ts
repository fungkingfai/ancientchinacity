/**
 * 存檔系統：localStorage 自動存檔 + 3 個手動存檔格 + JSON 匯出／匯入。
 *
 * 存檔格式：GameState 的完整 JSON（version 欄位用於升級）。
 * 測試／SSR 環境沒有 localStorage 時，所有函式安全地回傳失敗。
 */

import { GAME_VERSION } from './config';
import type { GameState, SaveSlotInfo } from './types';

const PREFIX = 'huaxia-city.save.';
export const AUTOSAVE_SLOT = 0;
export const MANUAL_SLOTS = [1, 2, 3] as const;
export const MAX_SLOTS = 4;

function storageKey(slot: number): string {
  return `${PREFIX}slot${slot}`;
}

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function dateLabel(state: GameState): string {
  const { clock } = state;
  const seasons: Record<string, string> = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
  return `第${clock.year}年 ${seasons[clock.season] ?? ''} ${clock.month}月${clock.day}日`;
}

/** 驗證／升級讀入的存檔物件，失敗回傳 null */
export function normalizeState(raw: unknown): GameState | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<GameState>;
  if (typeof data.width !== 'number' || typeof data.height !== 'number') return null;
  if (!Array.isArray(data.tiles) || !Array.isArray(data.buildings)) return null;
  if (!data.tiles.length) return null;
  if (!data.clock || !data.finance || !data.ui) return null;

  // 版本升級（目前 v1）
  const version = typeof data.version === 'number' ? data.version : 1;
  if (version > GAME_VERSION) {
    console.warn(`[save] 存檔版本 ${version} 高於遊戲版本 ${GAME_VERSION}，嘗試載入`);
  }
  data.version = GAME_VERSION;

  // 補齊可能缺失的欄位（舊存檔相容）
  data.citizens ??= [];
  data.carts ??= [];
  data.log ??= [];
  data.nextBuildingId ??= data.buildings.reduce((m, b) => Math.max(m, b.id + 1), 1);
  data.nextCitizenId ??= data.citizens.reduce((m, c) => Math.max(m, c.id + 1), 1);
  data.nextCartId ??= data.carts.reduce((m, c) => Math.max(m, c.id + 1), 1);
  data.nextLogId ??= data.log.reduce((m, l) => Math.max(m, l.id + 1), 1);
  data.cityName ??= '華夏古城';
  data.createdAt ??= Date.now();
  data.savedAt ??= Date.now();
  data.stats ??= {
    population: data.citizens.length,
    households: 0,
    jobs: 0,
    employed: 0,
    unemployed: 0,
    homeless: 0,
    happiness: 50,
    foodStored: 0,
    foodPerDay: 0,
    netIncome: 0,
    goodsInTransit: 0,
  };
  return data as GameState;
}

export function saveToSlot(state: GameState, slot: number): boolean {
  if (!hasStorage()) return false;
  if (slot < 0 || slot >= MAX_SLOTS) return false;
  try {
    state.savedAt = Date.now();
    state.version = GAME_VERSION;
    localStorage.setItem(storageKey(slot), JSON.stringify(state));
    return true;
  } catch (err) {
    console.error('[save] 寫入失敗', err);
    return false;
  }
}

export function loadFromSlot(slot: number): GameState | null {
  if (!hasStorage()) return null;
  try {
    const text = localStorage.getItem(storageKey(slot));
    if (!text) return null;
    return normalizeState(JSON.parse(text));
  } catch (err) {
    console.error('[save] 讀取失敗', err);
    return null;
  }
}

export function deleteSlot(slot: number): void {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(storageKey(slot));
  } catch {
    /* ignore */
  }
}

export function getSaveSlotInfo(slot: number): SaveSlotInfo {
  const base: SaveSlotInfo = {
    slot,
    empty: true,
    cityName: '',
    population: 0,
    treasury: 0,
    dateLabel: '',
    savedAt: 0,
  };
  if (!hasStorage()) return base;
  try {
    const text = localStorage.getItem(storageKey(slot));
    if (!text) return base;
    const state = normalizeState(JSON.parse(text));
    if (!state) return base;
    return {
      slot,
      empty: false,
      cityName: state.cityName,
      population: state.stats.population,
      treasury: state.finance.treasury,
      dateLabel: dateLabel(state),
      savedAt: state.savedAt,
    };
  } catch {
    return base;
  }
}

export function listSaves(): SaveSlotInfo[] {
  const result: SaveSlotInfo[] = [];
  for (let slot = 0; slot < MAX_SLOTS; slot++) result.push(getSaveSlotInfo(slot));
  return result;
}

export function autosave(state: GameState): boolean {
  return saveToSlot(state, AUTOSAVE_SLOT);
}

export function loadAutosave(): GameState | null {
  return loadFromSlot(AUTOSAVE_SLOT);
}

/** 觸發瀏覽器下載 JSON 存檔 */
export function exportSave(state: GameState): void {
  if (typeof document === 'undefined') return;
  const safeName = state.cityName.replace(/[\\/:*?"<>|]/g, '_');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `huaxia-city-${safeName}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 讀取使用者選擇的 JSON 存檔 */
export async function importSaveFile(file: File): Promise<GameState | null> {
  try {
    const text = await file.text();
    return normalizeState(JSON.parse(text));
  } catch (err) {
    console.error('[save] 匯入失敗', err);
    return null;
  }
}
