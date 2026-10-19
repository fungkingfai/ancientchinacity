/**
 * 左側「營造司」面板：分類頁籤、建築卡、道路／拆除工具、hover 說明。
 */

import {
  BUILDING_LIST,
  BUILDINGS,
  CATEGORY_INFO,
  DEMOLISH_REFUND_RATE,
  RESOURCES,
  ROAD_COST,
  TERRAIN_INFO,
  formatMoney,
} from '../core/config';
import type { BuildingCategory, BuildingDef, GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { clamp, delegate, esc, hexColor, qs, qsa, setClass, setHidden, setText } from './dom';
import { ico, sealHtml } from './icons';

export interface BuildPanelView {
  update(state: GameState): void;
  destroy(): void;
}

type CategoryEntry = [BuildingCategory, { name: string; order: number }];

const CATEGORIES = (Object.entries(CATEGORY_INFO) as CategoryEntry[]).sort((a, b) => a[1].order - b[1].order);

function buildingsOf(category: BuildingCategory): BuildingDef[] {
  return BUILDING_LIST.filter((def) => def.category === category).sort(
    (a, b) => a.unlockPop - b.unlockPop || a.cost - b.cost,
  );
}

/** 卡片副標：一眼看出用途 */
function cardSubtitle(def: BuildingDef): string {
  if (def.production) {
    const out = RESOURCES[def.production.output]?.name ?? def.production.output;
    return `${out} ${def.production.amountPerDay}/日`;
  }
  if (def.housing > 0) return `可住 ${def.housing} 人`;
  if (def.storage) return `容量 ${def.storage.capacity}`;
  if (def.service?.kind) return `服務半徑 ${def.service.radius ?? '—'}`;
  return def.upkeep > 0 ? `維護 ${def.upkeep} 兩/月` : '小型設施';
}

function acceptedLabel(def: BuildingDef): string {
  if (!def.storage) return '';
  if (def.storage.accepted === 'all') return '所有貨物';
  return def.storage.accepted.map((key) => RESOURCES[key]?.name ?? key).join('、');
}

/** hover 說明：建築詳細資料 */
function buildTip(def: BuildingDef): string {
  const rows: string[] = [];
  rows.push(`<div><dt>造價</dt><dd>${formatMoney(def.cost)}</dd></div>`);
  rows.push(`<div><dt>維護</dt><dd>每月 ${formatMoney(def.upkeep)}</dd></div>`);
  rows.push(`<div><dt>佔地</dt><dd>${def.size[0]} × ${def.size[1]} 格</dd></div>`);
  if (def.workers > 0) rows.push(`<div><dt>工人</dt><dd>需要 ${def.workers} 人</dd></div>`);
  if (def.housing > 0) rows.push(`<div><dt>居民</dt><dd>可住 ${def.housing} 人</dd></div>`);
  if (def.storage) rows.push(`<div><dt>庫存</dt><dd>容量 ${def.storage.capacity}（${acceptedLabel(def)}）</dd></div>`);
  if (def.production) {
    const prod = def.production;
    const out = `${RESOURCES[prod.output]?.name ?? prod.output} ${prod.amountPerDay}/日`;
    if (prod.input) {
      const inp = `${RESOURCES[prod.input.resource]?.name ?? prod.input.resource} ${prod.input.amountPerDay}/日`;
      rows.push(`<div><dt>產出</dt><dd>${out}（耗 ${inp}）</dd></div>`);
    } else {
      rows.push(`<div><dt>產出</dt><dd>${out}</dd></div>`);
    }
    if (prod.allowedTerrain?.length) {
      const names = prod.allowedTerrain.map((t) => TERRAIN_INFO[t]?.name ?? t).join('、');
      rows.push(`<div><dt>地勢</dt><dd>限 ${names}</dd></div>`);
    }
    if (prod.seasonBonus) {
      const best = Object.entries(prod.seasonBonus).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      if (best) {
        const seasonNames: Record<string, string> = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
        rows.push(`<div><dt>時令</dt><dd>${seasonNames[best[0]] ?? best[0]}日產量最高</dd></div>`);
      }
    }
  }
  if (def.service) {
    const svc = def.service;
    if (svc.radius) rows.push(`<div><dt>服務</dt><dd>半徑 ${svc.radius} 格</dd></div>`);
    if (svc.happiness) rows.push(`<div><dt>民心</dt><dd>+${svc.happiness}</dd></div>`);
    if (svc.incomePerDay) rows.push(`<div><dt>進帳</dt><dd>約 ${svc.incomePerDay} 兩/日</dd></div>`);
    if (svc.consumes) {
      const c = svc.consumes;
      rows.push(`<div><dt>耗用</dt><dd>${RESOURCES[c.resource]?.name ?? c.resource} ${c.amountPerDay}/日</dd></div>`);
    }
  }
  if (def.needsWater) rows.push(`<div><dt>選址</dt><dd>需臨水而建</dd></div>`);
  if (def.needsRoad === false) rows.push(`<div><dt>道路</dt><dd>不需臨路</dd></div>`);
  if (def.unlockPop > 0) rows.push(`<div><dt>解鎖</dt><dd>人口達 ${def.unlockPop}</dd></div>`);

  return `
    <div class="tip-head">
      <span class="tip-icon" style="--c:${hexColor(def.color)}">${esc(def.name.slice(0, 1))}</span>
      <div><b>${esc(def.name)}</b><em>${esc(CATEGORY_INFO[def.category].name)} · ${def.size[0]}×${def.size[1]}</em></div>
    </div>
    <p class="tip-desc">${esc(def.desc)}</p>
    <dl class="tip-rows">${rows.join('')}</dl>
  `;
}

function toolTip(tool: string): string {
  if (tool === 'road') {
    return `
      <div class="tip-head">
        <span class="tip-icon tool">道</span>
        <div><b>道路</b><em>工事 · 每格 ${ROAD_COST} 兩</em></div>
      </div>
      <p class="tip-desc">以青石板鋪設街道。多數建築需臨路才能營運；市政廳與倉儲更依賴道路物流。</p>
      <dl class="tip-rows"><div><dt>操作</dt><dd>按住左鍵拖曳可連續鋪設</dd></div><div><dt>取消</dt><dd>右鍵或 Esc</dd></div></dl>
    `;
  }
  return `
    <div class="tip-head">
      <span class="tip-icon tool danger">拆</span>
      <div><b>拆除</b><em>工事 · 退還 ${Math.round(DEMOLISH_REFUND_RATE * 100)}%</em></div>
    </div>
    <p class="tip-desc">拆去建築或道路。建築拆除後退還三成造價；道路拆除不予退還。</p>
    <dl class="tip-rows"><div><dt>操作</dt><dd>點擊要拆除的建築或道路</dd></div><div><dt>取消</dt><dd>右鍵或 Esc</dd></div></dl>
  `;
}

export function createBuildPanel(container: HTMLElement, store: GameStore, actions: GameActions): BuildPanelView {
  const root = document.createElement('aside');
  root.className = 'build-panel';
  root.id = 'build-panel';
  root.innerHTML = `
    <div class="panel-corner tl"></div><div class="panel-corner tr"></div>
    <div class="panel-corner bl"></div><div class="panel-corner br"></div>
    <header class="panel-head">
      <h2 class="panel-title">營造司</h2>
      ${sealHtml('匠', 'panel-seal')}
      <button type="button" class="collapse-btn" data-act="collapse" data-panel="build" title="收合面板">${ico('chevronLeft')}</button>
    </header>
    <div class="category-tabs" role="tablist" aria-label="建築分類">
      ${CATEGORIES.map(
        ([key, info]) =>
          `<button type="button" role="tab" data-act="category" data-cat="${key}" data-tab="${key}">${esc(info.name)}</button>`,
      ).join('')}
    </div>
    <div class="build-scroll">
      <div class="build-list" data-k="list"></div>
    </div>
    <div class="build-tools">
      <div class="tools-label"><span>工事</span></div>
      <div class="tool-row">
        <button type="button" class="tool-card" data-act="tool" data-tool="road" data-tip="tool:road">
          <span class="tool-ico">${ico('road')}</span>
          <span class="tool-meta"><b>道路</b><small>每格 ${ROAD_COST} 兩</small></span>
        </button>
        <button type="button" class="tool-card tool-danger" data-act="tool" data-tool="demolish" data-tip="tool:demolish">
          <span class="tool-ico">${ico('hammer')}</span>
          <span class="tool-meta"><b>拆除</b><small>退還 ${Math.round(DEMOLISH_REFUND_RATE * 100)}%</small></span>
        </button>
      </div>
      <button type="button" class="cancel-tool" data-act="tool" data-tool="none" hidden>
        ${ico('close')}<span>取消營造</span><kbd>Esc</kbd>
      </button>
      <p class="tools-hint">選好工具後，在城中點擊放置</p>
    </div>
  `;
  container.appendChild(root);

  const listEl = qs<HTMLElement>(root, '[data-k="list"]')!;
  const cancelBtn = qs<HTMLElement>(root, '.cancel-tool')!;
  const tabButtons = qsa<HTMLElement>(root, '[data-tab]');
  const roadBtn = qs<HTMLElement>(root, '[data-tool="road"]')!;
  const demolishBtn = qs<HTMLElement>(root, '[data-tool="demolish"]')!;

  // ── hover 說明框 ──
  const tip = document.createElement('div');
  tip.className = 'build-tooltip';
  tip.setAttribute('aria-hidden', 'true');
  container.appendChild(tip);
  const tipCache = new Map<string, string>();
  let tipKey = '';
  let tipCard: HTMLElement | null = null;

  const positionTip = (card: HTMLElement): void => {
    const rect = card.getBoundingClientRect();
    const height = tip.offsetHeight || 240;
    const top = clamp(rect.top - 10, 74, Math.max(74, window.innerHeight - height - 14));
    tip.style.top = `${top}px`;
    tip.style.left = `${rect.right + 12}px`;
  };

  const showTip = (card: HTMLElement, key: string): void => {
    if (!key) return;
    let html = tipCache.get(key);
    if (!html) {
      html = key.startsWith('tool:') ? toolTip(key.slice(5)) : buildTip(BUILDINGS[key.slice(2)]);
      tipCache.set(key, html);
    }
    tip.innerHTML = html;
    tip.classList.add('show');
    positionTip(card);
  };

  const hideTip = (): void => {
    if (!tipKey) return;
    tipKey = '';
    tipCard = null;
    tip.classList.remove('show');
  };

  const offMove = delegate(root, 'pointermove', '[data-tip]', (card) => {
    const key = card.dataset.tip ?? '';
    if (key === tipKey) return;
    tipKey = key;
    tipCard = card;
    showTip(card, key);
    // 內容置入後高度才有值，再校正一次位置
    if (tipCard) positionTip(tipCard);
  });
  const offLeave = delegate(root, 'pointerleave', '[data-tip]', () => hideTip());
  root.addEventListener('pointerleave', hideTip);
  const onListScroll = (): void => hideTip();
  listEl.addEventListener('scroll', onListScroll, { passive: true });

  // ── 點擊 ──
  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    const act = node.dataset.act;
    if (act === 'category') {
      const cat = node.dataset.cat as BuildingCategory | undefined;
      if (!cat) return;
      store.state.ui.buildCategory = cat;
      store.bumpUI();
      hideTip();
      return;
    }
    if (act === 'build') {
      const key = node.dataset.key;
      if (!key) return;
      const def = BUILDINGS[key];
      if (!def) return;
      if (store.state.stats.population < def.unlockPop) {
        store.toast(`人口達到 ${def.unlockPop} 後解鎖「${def.name}」`, 'warn');
        return;
      }
      actions.setTool(store.state.ui.tool === key ? null : key);
      return;
    }
    if (act === 'tool') {
      const tool = node.dataset.tool ?? '';
      if (tool === 'none') {
        actions.setTool(null);
        return;
      }
      actions.setTool(store.state.ui.tool === tool ? null : tool);
    }
  });

  // ── 更新（差異比對） ──
  const cardMap = new Map<string, HTMLElement>();
  let lastCategory: BuildingCategory | null = null;
  let lastUnlockSig = '';
  let lastRenderedCategory: BuildingCategory | null = null;
  let lastTool = '';

  const popUnlockSig = (state: GameState): string => {
    let sig = '';
    for (const def of BUILDING_LIST) sig += state.stats.population >= def.unlockPop ? '1' : '0';
    return sig;
  };

  const renderList = (state: GameState): void => {
    const category = state.ui.buildCategory;
    const population = state.stats.population;
    const defs = buildingsOf(category);
    cardMap.clear();
    listEl.innerHTML = defs
      .map((def) => {
        const locked = population < def.unlockPop;
        const active = store.state.ui.tool === def.key;
        const side = locked
          ? `<span class="b-lock" title="人口 ${def.unlockPop} 解鎖">${ico('lock')}${def.unlockPop}</span>`
          : `<span class="b-cost">${ico('coin')}${def.cost}</span>`;
        return `
          <button type="button" class="build-card${locked ? ' locked' : ''}${active ? ' active' : ''}"
            data-act="build" data-key="${def.key}" data-tip="b:${def.key}"
            aria-pressed="${active}" ${locked ? 'aria-disabled="true"' : ''}>
            <span class="b-icon" style="--c:${hexColor(def.color)}">${esc(def.name.slice(0, 1))}</span>
            <span class="b-main"><b>${esc(def.name)}</b><small>${esc(cardSubtitle(def))}</small></span>
            <span class="b-side">${side}</span>
          </button>`;
      })
      .join('');
    for (const card of qsa<HTMLElement>(listEl, '.build-card')) {
      const key = card.dataset.key;
      if (key) cardMap.set(key, card);
    }
    lastRenderedCategory = category;
  };

  const update = (state: GameState): void => {
    const ui = state.ui;

    if (ui.buildCategory !== lastCategory) {
      lastCategory = ui.buildCategory;
      for (const tab of tabButtons) setClass(tab, 'active', tab.dataset.tab === ui.buildCategory);
    }

    const unlockSig = popUnlockSig(state);
    if (lastRenderedCategory !== ui.buildCategory || unlockSig !== lastUnlockSig) {
      lastUnlockSig = unlockSig;
      renderList(state);
    } else {
      for (const [key, card] of cardMap) setClass(card, 'active', ui.tool === key);
    }

    setClass(roadBtn, 'active', ui.tool === 'road');
    setClass(demolishBtn, 'active', ui.tool === 'demolish');
    setHidden(cancelBtn, !ui.tool);
    setText(qs<HTMLElement>(root, '.tools-hint'), ui.tool ? '' : '選好工具後，在城中點擊放置');
    const tool = ui.tool ?? '';
    if (tool !== lastTool) {
      lastTool = tool;
      hideTip();
    }
  };

  return {
    update,
    destroy(): void {
      offClick();
      offMove();
      offLeave();
      listEl.removeEventListener('scroll', onListScroll);
      root.remove();
      tip.remove();
    },
  };
}
