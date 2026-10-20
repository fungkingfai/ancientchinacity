/**
 * 手機版 UI 外殼：底部導覽列＋底部面板（sheet）控制＋遮罩。
 *
 * 只在手機模式建立（由 core/device.ts 偵測）。
 * 電腦版 UI 完全不使用此模組。
 *
 * 行為：
 *   - 底部導覽：營造 / 城事 / 財政 / 存檔 / 說明 / 指引
 *   - 營造、城事以底部 sheet 呈現（沿用原本桌面面板元件）
 *   - 選擇建造工具後自動收起 sheet，露出地圖
 *   - 點選建築自動打開「城事」sheet；點空白處收起
 *   - 開啟 modal、進入室內時自動收起 sheet
 */

import type { GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { ico, type IconName } from './icons';

export interface MobileBarView {
  update(state: GameState): void;
  destroy(): void;
}

interface NavItem {
  act: 'build' | 'info' | 'finance' | 'save' | 'help' | 'tutorial';
  label: string;
  icon: IconName;
}

const NAV_ITEMS: NavItem[] = [
  { act: 'build', label: '營造', icon: 'hammer' },
  { act: 'info', label: '城事', icon: 'temple' },
  { act: 'finance', label: '財政', icon: 'ingot' },
  { act: 'save', label: '存檔', icon: 'scroll' },
  { act: 'help', label: '說明', icon: 'book' },
  { act: 'tutorial', label: '指引', icon: 'compass' },
];

export function createMobileBar(hud: HTMLElement, store: GameStore, actions: GameActions): MobileBarView {
  // ── 遮罩（點擊收起 sheet） ──
  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'mobile-sheet-backdrop';
  backdrop.setAttribute('aria-label', '關閉面板');
  backdrop.hidden = true;

  // ── 底部導覽列 ──
  const nav = document.createElement('nav');
  nav.className = 'mobile-nav';
  nav.setAttribute('aria-label', '手機操作列');
  nav.innerHTML = NAV_ITEMS.map(
    (item) => `<button type="button" class="mobile-nav-btn" data-m-act="${item.act}" aria-label="${item.label}">
      ${ico(item.icon)}<span>${item.label}</span>
    </button>`,
  ).join('');

  hud.append(backdrop, nav);

  const buildBtn = nav.querySelector<HTMLElement>('[data-m-act="build"]')!;
  const infoBtn = nav.querySelector<HTMLElement>('[data-m-act="info"]')!;

  // ── 在既有面板標題列加上「收起」按鈕（僅手機模式顯示） ──
  const closeButtons: HTMLElement[] = [];
  for (const selector of ['#build-panel', '#info-panel']) {
    const panel = hud.querySelector<HTMLElement>(selector);
    const head = panel?.querySelector<HTMLElement>('.panel-head');
    if (!head) continue;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mobile-sheet-close';
    close.setAttribute('aria-label', '收起面板');
    close.innerHTML = ico('close');
    close.addEventListener('click', () => setSheet(null));
    head.appendChild(close);
    closeButtons.push(close);
  }

  const setSheet = (which: 'build' | 'info' | null): void => {
    hud.classList.toggle('is-build-open', which === 'build');
    hud.classList.toggle('is-info-open', which === 'info');
    const open = which !== null;
    hud.classList.toggle('is-sheet-open', open);
    backdrop.hidden = !open;
  };

  const closeSheets = (): void => setSheet(null);

  backdrop.addEventListener('click', closeSheets);

  nav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-m-act]');
    if (!btn) return;
    const act = btn.dataset.mAct as NavItem['act'];
    switch (act) {
      case 'build':
        setSheet(hud.classList.contains('is-build-open') ? null : 'build');
        break;
      case 'info':
        setSheet(hud.classList.contains('is-info-open') ? null : 'info');
        break;
      case 'finance':
        closeSheets();
        actions.toggleFinance();
        break;
      case 'save':
        closeSheets();
        actions.toggleSavePanel();
        break;
      case 'help':
        closeSheets();
        actions.toggleHelp();
        break;
      case 'tutorial': {
        closeSheets();
        const ui = store.state.ui;
        ui.showTutorial = true;
        ui.showFinance = false;
        ui.showHelp = false;
        ui.showSave = false;
        store.bumpUI();
        break;
      }
    }
  });

  // 點選建築 → 自動打開城事 sheet；點空白 → 收起。
  // 延遲 240ms 再開，讓「雙擊進入建築」有機會在面板打開前完成。
  let selectTimer = 0;
  const clearSelectTimer = (): void => {
    if (selectTimer) {
      window.clearTimeout(selectTimer);
      selectTimer = 0;
    }
  };
  const offSelect = store.on('select', (payload) => {
    const id = typeof payload === 'number' ? payload : null;
    const state = store.state;
    if (state.ui.mode !== 'city') return;
    clearSelectTimer();
    if (id != null && !state.ui.tool) {
      selectTimer = window.setTimeout(() => {
        selectTimer = 0;
        const s = store.state;
        if (s.ui.mode === 'city' && s.ui.selectedId === id && !s.ui.tool) setSheet('info');
      }, 240);
    } else if (id == null && hud.classList.contains('is-info-open')) {
      setSheet(null);
    }
  });

  // ── 每幀更新：自動收合、導覽高亮 ──
  let lastTool: string | null = null;
  let lastMode = '';

  const update = (state: GameState): void => {
    const ui = state.ui;

    if (ui.mode !== lastMode) {
      lastMode = ui.mode;
      if (ui.mode === 'interior') {
        clearSelectTimer();
        closeSheets();
      }
    }

    if (ui.showTutorial || ui.showFinance || ui.showHelp || ui.showSave) {
      if (hud.classList.contains('is-sheet-open')) closeSheets();
    }

    if (ui.tool !== lastTool) {
      lastTool = ui.tool;
      // 選好建造工具後收起營造面板，讓玩家直接在地圖上放置
      if (ui.tool) clearSelectTimer();
      if (ui.tool && hud.classList.contains('is-sheet-open')) closeSheets();
    }

    buildBtn.classList.toggle('is-active', ui.tool != null || hud.classList.contains('is-build-open'));
    infoBtn.classList.toggle('is-active', ui.selectedId != null || hud.classList.contains('is-info-open'));
    nav.classList.toggle('is-paused', ui.paused);
  };

  return {
    update,
    destroy(): void {
      offSelect();
      clearSelectTimer();
      backdrop.remove();
      nav.remove();
      for (const btn of closeButtons) btn.remove();
    },
  };
}
