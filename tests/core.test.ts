/**
 * 核心與世界單元測試（vitest）
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILDINGS,
  BUILDING_LIST,
  CATEGORY_INFO,
  RESOURCE_KEYS,
  RESOURCES,
  ROAD_COST,
  TERRAIN_INFO,
} from '../src/core/config';
import { createGameState } from '../src/core/new-game';
import { generateWorld } from '../src/world/worldgen';
import { formatGameDate, shichenName } from '../src/core/format';
import { normalizeState, loadFromSlot, saveToSlot, listSaves, deleteSlot } from '../src/core/save';
import { placeBuilding, placeRoad, demolishAt, canPlaceBuilding } from '../src/sim/placement';
import { findRoadPath } from '../src/sim/pathfinding';
import type { GameState } from '../src/core/types';

// Node 環境的 localStorage 模擬
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).localStorage = new MemoryStorage();
});

describe('設定資料表', () => {
  it('所有建築資料完整且分類合法', () => {
    expect(BUILDING_LIST.length).toBeGreaterThanOrEqual(15);
    for (const def of BUILDING_LIST) {
      expect(def.size[0]).toBeGreaterThan(0);
      expect(def.size[1]).toBeGreaterThan(0);
      expect(def.cost).toBeGreaterThan(0);
      expect(def.upkeep).toBeGreaterThanOrEqual(0);
      expect(CATEGORY_INFO[def.category]).toBeTruthy();
      if (def.production) {
        expect(RESOURCE_KEYS).toContain(def.production.output);
        if (def.production.input) expect(RESOURCE_KEYS).toContain(def.production.input.resource);
        if (def.production.allowedTerrain) {
          for (const t of def.production.allowedTerrain) expect(TERRAIN_INFO[t]).toBeTruthy();
        }
      }
      if (def.storage) expect(def.storage.capacity).toBeGreaterThan(0);
    }
  });

  it('資源皆有中文名稱與價格', () => {
    for (const key of RESOURCE_KEYS) {
      expect(RESOURCES[key].name.length).toBeGreaterThan(0);
      expect(RESOURCES[key].price).toBeGreaterThan(0);
    }
  });

  it('道路成本為正數', () => {
    expect(ROAD_COST).toBeGreaterThan(0);
  });
});

describe('世界生成', () => {
  it('同一 seed 產生相同地形', () => {
    const a = generateWorld(12345);
    const b = generateWorld(12345);
    expect(a.tiles.length).toBe(b.tiles.length);
    for (let i = 0; i < a.tiles.length; i += 97) {
      expect(a.tiles[i].terrain).toBe(b.tiles[i].terrain);
      expect(a.tiles[i].elevation).toBeCloseTo(b.tiles[i].elevation, 5);
    }
  });

  it('地圖有足夠的可建地、水源與地形多樣性', () => {
    const world = generateWorld(20261018);
    const counts = new Map<string, number>();
    for (const tile of world.tiles) counts.set(tile.terrain, (counts.get(tile.terrain) ?? 0) + 1);
    const buildable =
      (counts.get('grass') ?? 0) + (counts.get('fertile') ?? 0) + (counts.get('forest') ?? 0) + (counts.get('hill') ?? 0) + (counts.get('sand') ?? 0);
    expect(buildable).toBeGreaterThan(world.tiles.length * 0.4);
    expect(counts.get('water') ?? 0).toBeGreaterThan(100);
    expect(counts.size).toBeGreaterThanOrEqual(5);
  });
});

describe('開新局', () => {
  it('初始狀態完整', () => {
    const state = createGameState(777);
    expect(state.tiles.length).toBe(state.width * state.height);
    expect(state.buildings).toEqual([]);
    expect(state.finance.treasury).toBeGreaterThan(0);
    expect(state.clock.year).toBe(1);
    expect(state.clock.month).toBe(1);
    expect(state.clock.day).toBe(1);
    expect(state.nextBuildingId).toBe(1);
    expect(state.log.length).toBeGreaterThan(0);
  });

  it('地圖上的建築佔用格皆為 -1', () => {
    const state = createGameState(888);
    expect(state.tiles.every((t) => t.buildingId === -1 && !t.road)).toBe(true);
  });
});

describe('時間格式', () => {
  it('時辰與日期字串', () => {
    const state = createGameState(1);
    expect(shichenName(6)).toBe('卯時');
    expect(shichenName(0)).toBe('子時');
    expect(formatGameDate(state.clock)).toContain('第1年');
  });
});

describe('存檔系統', () => {
  it('存檔／讀檔／列表／刪除', () => {
    const state = createGameState(4242);
    expect(saveToSlot(state, 1)).toBe(true);
    const saves = listSaves();
    expect(saves[1].empty).toBe(false);
    expect(saves[1].population).toBe(0);
    const loaded = loadFromSlot(1);
    expect(loaded).not.toBeNull();
    expect(loaded!.seed).toBe(4242);
    expect(loaded!.width).toBe(state.width);
    deleteSlot(1);
    expect(listSaves()[1].empty).toBe(true);
  });

  it('拒絕無效存檔資料', () => {
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState({})).toBeNull();
    expect(normalizeState({ width: 10, height: 10, tiles: [] })).toBeNull();
  });

  it('空存檔回傳 null', () => {
    expect(loadFromSlot(3)).toBeNull();
  });
});

// ── 擺放與路徑 ──

function findFlatSpot(state: GameState, size: number): { x: number; y: number } | null {
  for (let y = 6; y < state.height - size - 6; y++) {
    for (let x = 6; x < state.width - size - 6; x++) {
      let ok = true;
      for (let dy = 0; dy < size && ok; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const t = state.tiles[(y + dy) * state.width + x + dx];
          if (t.terrain === 'water' || t.terrain === 'mountain' || t.terrain === 'forest' || t.terrain === 'hill') {
            ok = false;
            break;
          }
        }
      }
      if (ok) return { x, y };
    }
  }
  return null;
}

describe('擺放規則', () => {
  it('建造茅屋扣款、拆除退款', () => {
    const state = createGameState(999);
    const spot = findFlatSpot(state, 2);
    expect(spot).not.toBeNull();
    const before = state.finance.treasury;
    const result = placeBuilding(state, 'hut', spot!.x, spot!.y);
    expect(result.ok).toBe(true);
    expect(state.finance.treasury).toBe(before - BUILDINGS.hut.cost);
    expect(state.buildings.length).toBe(1);
    expect(state.tiles[spot!.y * state.width + spot!.x].buildingId).toBe(state.buildings[0].id);
    const demolish = demolishAt(state, spot!.x, spot!.y);
    expect(demolish.ok).toBe(true);
    expect(demolish.refund).toBeGreaterThan(0);
    expect(state.buildings.length).toBe(0);
  });

  it('不能重複佔用同一格或建在道路上', () => {
    const state = createGameState(1001);
    const spot = findFlatSpot(state, 2)!;
    expect(placeRoad(state, spot.x, spot.y).ok).toBe(true);
    expect(canPlaceBuilding(state, 'hut', spot.x, spot.y).ok).toBe(false);
  });

  it('銀兩不足時拒絕建造', () => {
    const state = createGameState(1002);
    state.finance.treasury = 1;
    const spot = findFlatSpot(state, 2)!;
    const result = placeBuilding(state, 'house', spot.x, spot.y);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('銀兩');
  });
});

describe('道路尋路', () => {
  it('沿直線道路找到路徑', () => {
    const state = createGameState(555);
    const y = 20;
    const startX = 10;
    const endX = 20;
    for (let x = startX; x <= endX; x++) state.tiles[y * state.width + x].road = true;
    const start = y * state.width + startX;
    const goal = y * state.width + endX;
    const path = findRoadPath(state, start, goal);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(endX - startX + 1);
    expect(path![0]).toBe(start);
    expect(path![path!.length - 1]).toBe(goal);
  });

  it('沒有道路連接時回傳 null', () => {
    const state = createGameState(556);
    const path = findRoadPath(state, 0, 100);
    expect(path).toBeNull();
  });
});
