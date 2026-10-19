/**
 * 《華夏古城》DOM 介面入口。
 *
 * 對外介面固定（Lead 的 main.ts 依賴）：
 *   createUI(root, store, actions): GameUI
 *   GameUI.update(state)   —— 每幀由主迴圈呼叫
 *   GameUI.destroy()
 *
 * 各子面板以「上次值比對 / 簽章比對」做差異更新，不會每幀重建 DOM。
 * 視覺樣式全部是純 CSS／SVG；字型使用系統宋體優先，離線可玩。
 */

import './css/topbar.css';
import './css/build.css';
import './css/info.css';
import './css/modals.css';
import './css/interior.css';
import './css/toasts.css';
import './css/responsive.css';

import { BUILDINGS } from '../core/config';
import type { GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, qs, setClass, setHidden } from './dom';
import { ico } from './icons';
import { createTopbar } from './topbar';
import { createBuildPanel } from './build-panel';
import { createInfoPanel } from './info-panel';
import { createInteriorPanel } from './interior-panel';
import { createModals } from './modals';
import { createToasts } from './toasts';

export interface GameUI {
  update(state: GameState): void;
  destroy(): void;
}

export function createUI(root: HTMLElement, store: GameStore, actions: GameActions): GameUI {
  root.innerHTML = `
    <div class="hud" id="hud">
      <div class="hud-vignette" aria-hidden="true"></div>
      <button type="button" class="panel-handle handle-build" data-act="expand" data-panel="build" title="展開營造面板">
        ${ico('chevronRight')}<span>營造</span>
      </button>
      <button type="button" class="panel-handle handle-info" data-act="expand" data-panel="info" title="展開城事面板">
        <span>城事</span>${ico('chevronLeft')}
      </button>
      <div class="mode-hint" data-k="modeHint" aria-live="polite">
        <span class="mode-hint-ico" data-k="hintIcon"></span>
        <span class="mode-hint-text" data-k="hintText"></span>
        <button type="button" class="mode-hint-cancel" data-act="cancel-tool" title="取消（Esc）">${ico('close')}</button>
      </div>
    </div>
  `;

  const hud = qs<HTMLElement>(root, '#hud')!;
  const topbar = createTopbar(hud, store, actions);
  const buildPanel = createBuildPanel(hud, store, actions);
  const infoPanel = createInfoPanel(hud, store, actions);
  const interiorPanel = createInteriorPanel(hud, store, actions);
  const modals = createModals(hud, store, actions);
  const toasts = createToasts(hud, store);

  const modeHint = qs<HTMLElement>(hud, '[data-k="modeHint"]')!;
  const hintText = qs<HTMLElement>(hud, '[data-k="hintText"]')!;
  const hintIcon = qs<HTMLElement>(hud, '[data-k="hintIcon"]')!;
  const hintCancel = qs<HTMLElement>(hud, '.mode-hint-cancel')!;

  // ── 面板收合（寬螢幕）／抽屜（窄螢幕） ──
  const isNarrow = (): boolean => window.innerWidth <= 980;
  const setPanelOpen = (panel: 'build' | 'info', open: boolean): void => {
    if (isNarrow()) hud.classList.toggle(`is-${panel}-open`, open);
    else hud.classList.toggle(`is-${panel}-collapsed`, !open);
  };

  const offActions = delegate(root, 'click', '[data-act]', (node) => {
    const act = node.dataset.act;
    if (act === 'collapse' || act === 'expand') {
      const panel = node.dataset.panel === 'info' ? 'info' : 'build';
      const open = isNarrow()
        ? hud.classList.contains(`is-${panel}-open`)
        : !hud.classList.contains(`is-${panel}-collapsed`);
      setPanelOpen(panel, !open);
      return;
    }
    if (act === 'cancel-tool') actions.setTool(null);
  });

  const onResize = (): void => {
    if (!isNarrow()) hud.classList.remove('is-build-open', 'is-info-open');
  };
  window.addEventListener('resize', onResize);

  // ── 模式提示（建造中／室內） ──
  let lastHintKey = '';
  const updateHint = (state: GameState): void => {
    const ui = state.ui;
    const tool = ui.tool;
    const key = `${ui.mode}|${tool ?? ''}`;
    if (key === lastHintKey) return;
    lastHintKey = key;

    if (ui.mode === 'interior') {
      const building = ui.interiorId != null ? state.buildings.find((b) => b.id === ui.interiorId) : undefined;
      const name = building ? BUILDINGS[building.key]?.name ?? '' : '';
      hintIcon.innerHTML = ico('door');
      hintText.textContent = `${name} · 室內 — 雙擊戶外或按 Esc 返回城市`;
      setClass(modeHint, 'show', true);
      setClass(modeHint, 'interior', true);
      setHidden(hintCancel, true);
      return;
    }

    setClass(modeHint, 'interior', false);
    if (!tool) {
      setClass(modeHint, 'show', false);
      return;
    }
    if (tool === 'road') {
      hintIcon.innerHTML = ico('road');
      hintText.textContent = '鋪設道路：按住左鍵拖曳連續鋪設 · 右鍵取消';
    } else if (tool === 'demolish') {
      hintIcon.innerHTML = ico('hammer');
      hintText.textContent = '拆除模式：點擊要拆去的建築或道路 · 右鍵取消';
    } else {
      const def = BUILDINGS[tool];
      if (!def) {
        setClass(modeHint, 'show', false);
        return;
      }
      hintIcon.innerHTML = ico('seal');
      hintText.textContent = `放置「${def.name}」：${def.size[0]}×${def.size[1]} 格 · 左鍵放置 · 右鍵取消`;
    }
    setClass(modeHint, 'show', true);
    setHidden(hintCancel, false);
  };

  const update = (state: GameState): void => {
    setClass(hud, 'is-interior', state.ui.mode === 'interior');
    topbar.update(state);
    buildPanel.update(state);
    infoPanel.update(state);
    interiorPanel.update(state);
    modals.update(state);
    updateHint(state);
  };

  update(store.state);

  return {
    update,
    destroy(): void {
      offActions();
      window.removeEventListener('resize', onResize);
      topbar.destroy();
      buildPanel.destroy();
      infoPanel.destroy();
      interiorPanel.destroy();
      modals.destroy();
      toasts.destroy();
      root.innerHTML = '';
    },
  };
}
