/**
 * 華夏古城 — 進入點：組裝 State、Actions、渲染器、UI 與模擬主迴圈。
 */

import './styles.css';
import { BUILDINGS, FESTIVAL_COOLDOWN_DAYS, FESTIVAL_COST } from './core/config';
import { createGameState } from './core/new-game';
import { GameStore } from './core/store';
import * as saves from './core/save';
import type { GameActions, GameState, LogKind, SimContext } from './core/types';
import { CityView } from './render/city-view';
import { buildingAnchor } from './render/coords';
import { createUI } from './ui/ui';
import { createSimulation } from './sim/simulation';
import { demolishAt, demolishBuildingById, placeBuilding, placeRoad } from './sim/placement';
import { updateStats } from './sim/stats';

/** 讀檔後把暫時性 UI 狀態歸零 */
function sanitizeLoadedState(state: GameState): GameState {
  state.ui.mode = 'city';
  state.ui.interiorId = null;
  state.ui.tool = null;
  state.ui.showFinance = false;
  state.ui.showHelp = false;
  state.ui.showSave = false;
  state.clock.paused = state.ui.paused;
  return state;
}

function createActions(store: GameStore): GameActions {
  const s = (): GameState => store.state;
  const refresh = (): void => {
    updateStats(store.state);
    store.bumpUI();
  };

  const actions: GameActions = {
    setTool(tool: string | null): void {
      const state = s();
      state.ui.tool = tool;
      if (tool) state.ui.selectedId = null;
      store.bumpUI();
    },

    applyToolAt(tileIndex: number): void {
      const state = s();
      if (tileIndex < 0 || tileIndex >= state.tiles.length) return;
      const tool = state.ui.tool;
      if (!tool) return;
      const tx = tileIndex % state.width;
      const ty = Math.floor(tileIndex / state.width);

      if (tool === 'road') {
        const result = placeRoad(state, tx, ty);
        if (result.ok) refresh();
        return;
      }
      if (tool === 'demolish') {
        const result = demolishAt(state, tx, ty);
        if (result.ok) {
          if (result.refund > 0) store.toast(`已拆除，退還 ${result.refund} 兩`, 'info');
          if (state.ui.mode === 'interior') actions.exitInterior();
          refresh();
        }
        return;
      }

      const def = BUILDINGS[tool];
      if (!def) return;
      const anchor = buildingAnchor(state, tool, def.size[0], def.size[1], tx, ty);
      const result = placeBuilding(state, tool, anchor.x, anchor.y);
      if (result.ok) {
        const placed = state.buildings[state.buildings.length - 1];
        state.ui.selectedId = placed?.id ?? null;
        store.toast(`已建造「${def.name}」，花費 ${def.cost} 兩`, 'good');
        refresh();
      } else if (result.reason) {
        store.toast(result.reason, 'warn');
      }
    },

    select(tileIndex: number): void {
      const state = s();
      if (tileIndex < 0 || tileIndex >= state.tiles.length) return;
      const id = state.tiles[tileIndex].buildingId;
      state.ui.selectedId = id >= 0 ? id : null;
      store.emit('select', id >= 0 ? id : null);
      store.bumpUI();
    },

    selectBuilding(id: number | null): void {
      s().ui.selectedId = id;
      store.emit('select', id);
      store.bumpUI();
    },

    enterBuilding(id: number): void {
      const state = s();
      const building = state.buildings.find((b) => b.id === id);
      if (!building) return;
      state.ui.mode = 'interior';
      state.ui.interiorId = id;
      state.ui.selectedId = id;
      state.ui.showFinance = false;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      store.emit('enter', id);
      store.bumpUI();
    },

    exitInterior(): void {
      const state = s();
      if (state.ui.mode === 'city') return;
      state.ui.mode = 'city';
      state.ui.interiorId = null;
      store.emit('exit');
      store.bumpUI();
    },

    setSpeed(speed: number): void {
      const state = s();
      const clamped = Math.max(0, Math.min(3, Math.round(speed)));
      state.ui.speed = clamped;
      state.clock.speed = clamped;
      state.ui.paused = clamped === 0;
      state.clock.paused = clamped === 0;
      store.bumpUI();
    },

    togglePause(): void {
      const state = s();
      if (state.clock.paused) {
        const speed = state.clock.speed > 0 ? state.clock.speed : state.ui.speed > 0 ? state.ui.speed : 1;
        state.ui.speed = speed;
        state.clock.speed = speed;
        state.clock.paused = false;
        state.ui.paused = false;
      } else {
        state.clock.paused = true;
        state.ui.paused = true;
      }
      store.bumpUI();
    },

    setTaxRate(rate: number): void {
      s().finance.taxRate = Math.max(0, Math.min(0.2, rate));
      store.bumpUI();
    },

    holdFestival(): void {
      const state = s();
      const finance = state.finance;
      if (state.clock.totalDays - finance.lastFestivalDay < FESTIVAL_COOLDOWN_DAYS) {
        store.toast(`節慶需間隔 ${FESTIVAL_COOLDOWN_DAYS} 日，再等等吧。`, 'warn');
        return;
      }
      if (finance.treasury < FESTIVAL_COST) {
        store.toast('國庫銀兩不足，無法舉辦節慶。', 'bad');
        return;
      }
      finance.treasury -= FESTIVAL_COST;
      finance.expenseThisMonth += FESTIVAL_COST;
      finance.lastFestivalDay = state.clock.totalDays;
      for (const citizen of state.citizens) citizen.happiness = Math.min(100, citizen.happiness + 12);
      store.log('舉辦節慶，百姓歡騰，民心大振。', 'good');
      store.toast('節慶盛大舉行，百姓歡騰！', 'good');
      refresh();
    },

    demolishBuilding(id: number): void {
      const state = s();
      const building = state.buildings.find((b) => b.id === id);
      if (!building) return;
      const def = BUILDINGS[building.key];
      const refund = demolishBuildingById(state, id);
      if (state.ui.selectedId === id) state.ui.selectedId = null;
      if (state.ui.interiorId === id) actions.exitInterior();
      store.toast(`已拆除「${def?.name ?? '建築'}」，退還 ${refund} 兩`, 'info');
      refresh();
    },

    saveGame(slot: number): boolean {
      const ok = saves.saveToSlot(store.state, slot);
      store.toast(ok ? `已保存至存檔 ${slot}` : '存檔失敗', ok ? 'good' : 'bad');
      store.bumpUI();
      return ok;
    },

    loadGame(slot: number): boolean {
      const loaded = saves.loadFromSlot(slot);
      if (!loaded) {
        store.toast('此存檔格是空的或損毀。', 'warn');
        return false;
      }
      store.setState(sanitizeLoadedState(loaded));
      store.toast('存檔已載入。', 'good');
      return true;
    },

    deleteSave(slot: number): void {
      saves.deleteSlot(slot);
      store.toast(`已刪除存檔 ${slot}`, 'info');
      store.bumpUI();
    },

    getSaves: () => saves.listSaves(),

    exportSave(): void {
      saves.exportSave(store.state);
      store.toast('已匯出存檔檔案。', 'good');
    },

    async importSave(file: File): Promise<boolean> {
      const loaded = await saves.importSaveFile(file);
      if (!loaded) {
        store.toast('匯入失敗：檔案格式不正確。', 'bad');
        return false;
      }
      store.setState(sanitizeLoadedState(loaded));
      store.toast('存檔已成功匯入。', 'good');
      return true;
    },

    newGame(seed?: number): void {
      const state = createGameState(seed);
      store.setState(state);
      store.toast('新的古城在此奠基，開始營造吧！', 'good');
    },

    toggleFinance(): void {
      const state = s();
      state.ui.showFinance = !state.ui.showFinance;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      store.bumpUI();
    },

    toggleHelp(): void {
      const state = s();
      state.ui.showHelp = !state.ui.showHelp;
      state.ui.showFinance = false;
      state.ui.showSave = false;
      store.bumpUI();
    },

    toggleSavePanel(): void {
      const state = s();
      state.ui.showSave = !state.ui.showSave;
      state.ui.showFinance = false;
      state.ui.showHelp = false;
      store.bumpUI();
    },

    closeOverlays(): void {
      const state = s();
      state.ui.showFinance = false;
      state.ui.showHelp = false;
      state.ui.showSave = false;
      store.bumpUI();
    },
  };
  return actions;
}

function boot(): void {
  const gameRoot = document.getElementById('game-root');
  const uiRoot = document.getElementById('ui-root');
  if (!gameRoot || !uiRoot) throw new Error('找不到遊戲容器');

  const autosaved = saves.loadAutosave();
  const initialState = autosaved ? sanitizeLoadedState(autosaved) : createGameState();
  const store = new GameStore(initialState);
  const actions = createActions(store);
  const view = new CityView({ container: gameRoot, store, actions });
  const ui = createUI(uiRoot, store, actions);
  const simulation = createSimulation();
  const ctx: SimContext = {
    toast: (text: string, kind: LogKind = 'info') => store.toast(text, kind),
    log: (text: string, kind: LogKind = 'info') => store.log(text, kind),
  };

  let last = performance.now();
  let autosaveTimer = 0;
  let bootHidden = false;

  const loop = (now: number): void => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    try {
      simulation.update(store.state, dt, ctx);
      view.frame();
      ui.update(store.state);
    } catch (err) {
      console.error('[遊戲迴圈錯誤]', err);
    }
    autosaveTimer += dt;
    if (autosaveTimer >= 60) {
      autosaveTimer = 0;
      saves.autosave(store.state);
    }
    if (!bootHidden) {
      bootHidden = true;
      setTimeout(() => {
        const bootScreen = document.getElementById('boot-screen');
        bootScreen?.classList.add('hidden');
        setTimeout(() => bootScreen?.remove(), 700);
      }, 450);
    }
    requestAnimationFrame(loop);
  };

  requestAnimationFrame((t) => {
    last = t;
    loop(t);
  });

  const persist = (): void => {
    saves.autosave(store.state);
  };
  window.addEventListener('beforeunload', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });

  // 除錯用
  (window as unknown as Record<string, unknown>).__HUAXIA__ = { store, actions, view, ui, simulation, ctx };
  console.info('《華夏古城》已啟動 — 按 H 查看操作說明');
}

try {
  boot();
} catch (err) {
  console.error(err);
  const bootScreen = document.getElementById('boot-screen');
  if (bootScreen) {
    bootScreen.innerHTML = `<div class="boot-inner"><h1>載入失敗</h1><p class="boot-sub">${String(err)}</p></div>`;
  }
}
