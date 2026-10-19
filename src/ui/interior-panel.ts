/**
 * 室內模式面板：建築名稱、描述、庫存、居民與工人名單、返回城市、拆除。
 *
 * CSS 以 .hud.is-interior 隱藏營造與城事面板、保留頂欄。
 */

import {
  BUILDINGS,
  CATEGORY_INFO,
  RESOURCES,
  formatMoney,
} from '../core/config';
import { formatShortDate } from '../core/format';
import type { Building, BuildingDef, GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, hexColor, setHtml } from './dom';
import { ico, personPill, resourceChips, sealHtml } from './icons';

export interface InteriorPanelView {
  update(state: GameState): void;
  destroy(): void;
}

const MAX_NAMES = 10;

function citizenLabel(state: GameState, id: number): { name: string; sub: string } {
  const citizen = state.citizens.find((c) => c.id === id);
  if (!citizen) return { name: '無名氏', sub: '' };
  return { name: citizen.name, sub: `${citizen.age} 歲` };
}

function statusPills(building: Building, def: BuildingDef): string {
  const pills: string[] = [];
  if (building.connected) pills.push('<span class="pill ok">道路連通</span>');
  else if (def.needsRoad === false) pills.push('<span class="pill">無需臨路</span>');
  else pills.push('<span class="pill warn">未連道路</span>');
  if (def.workers > 0) {
    pills.push(
      `<span class="pill${building.workers.length >= def.workers ? ' ok' : building.workers.length > 0 ? '' : ' warn'}">工人 ${building.workers.length}/${def.workers}</span>`,
    );
  }
  if (def.housing > 0) pills.push(`<span class="pill">居民 ${building.residents.length}/${def.housing}</span>`);
  if (def.production || def.service || def.storage) {
    pills.push(`<span class="pill ${building.active ? 'ok' : 'warn'}">${building.active ? '營運中' : '停擺'}</span>`);
  }
  return pills.join('');
}

function metaRows(def: BuildingDef): string {
  const rows: string[] = [];
  rows.push(`<div class="note-row"><span>用途</span><b>${esc(CATEGORY_INFO[def.category].name)} · ${def.size[0]}×${def.size[1]} 格</b></div>`);
  rows.push(`<div class="note-row"><span>維護</span><b>每月 ${formatMoney(def.upkeep)}</b></div>`);
  if (def.production) {
    const prod = def.production;
    const out = `${RESOURCES[prod.output]?.name ?? prod.output} ${prod.amountPerDay}/日`;
    rows.push(`<div class="note-row"><span>產出</span><b>${esc(out)}</b></div>`);
    if (prod.input) {
      const inp = `${RESOURCES[prod.input.resource]?.name ?? prod.input.resource} ${prod.input.amountPerDay}/日`;
      rows.push(`<div class="note-row"><span>投入</span><b>${esc(inp)}</b></div>`);
    }
  }
  if (def.service?.happiness) rows.push(`<div class="note-row"><span>民心</span><b>周邊 +${def.service.happiness}</b></div>`);
  if (def.storage) rows.push(`<div class="note-row"><span>容量</span><b>${def.storage.capacity}</b></div>`);
  if (def.housing > 0) rows.push(`<div class="note-row"><span>居住</span><b>可住 ${def.housing} 人</b></div>`);
  return rows.join('');
}

export function createInteriorPanel(container: HTMLElement, store: GameStore, actions: GameActions): InteriorPanelView {
  const layer = document.createElement('div');
  layer.className = 'interior-layer';
  container.appendChild(layer);

  let currentId: number | null = null;
  let lastSig = '';
  let pendingDemolish: number | null = null;
  let pendingTimer = 0;
  let lastProgWidth = -1;

  const clearPending = (): void => {
    pendingDemolish = null;
    if (pendingTimer) window.clearTimeout(pendingTimer);
    pendingTimer = 0;
  };

  const offClick = delegate(layer, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'exit-interior':
        actions.exitInterior();
        break;
      case 'demolish-interior': {
        const id = Number(node.dataset.id);
        if (!Number.isFinite(id)) return;
        pendingDemolish = id;
        if (pendingTimer) window.clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(() => {
          pendingDemolish = null;
          pendingTimer = 0;
        }, 4500);
        break;
      }
      case 'demolish-interior-confirm': {
        const id = Number(node.dataset.id);
        clearPending();
        if (Number.isFinite(id)) actions.demolishBuilding(id);
        break;
      }
      case 'demolish-interior-cancel':
        clearPending();
        break;
      default:
        break;
    }
  });

  const hide = (): void => {
    if (currentId === null) return;
    currentId = null;
    lastSig = '';
    layer.classList.remove('show');
    layer.innerHTML = '';
  };

  const signature = (state: GameState, building: Building, def: BuildingDef): string => {
    const inv = Object.entries(building.inventory)
      .filter(([, value]) => (value ?? 0) > 0.05)
      .map(([key, value]) => `${key}:${Math.round((value ?? 0) * 10)}`)
      .join(',');
    return [
      building.id,
      def.key,
      building.connected ? 1 : 0,
      building.active ? 1 : 0,
      building.workers.join('.'),
      building.residents.join('.'),
      inv,
      Math.round(building.incomeThisMonth),
      Math.round(building.expenseThisMonth),
      pendingDemolish === building.id ? 1 : 0,
    ].join('|');
  };

  const render = (state: GameState, building: Building, def: BuildingDef): void => {
    const residents = building.residents
      .slice(0, MAX_NAMES)
      .map((id) => {
        const label = citizenLabel(state, id);
        return personPill(label.name, label.sub);
      })
      .join('');
    const workers = building.workers
      .slice(0, MAX_NAMES)
      .map((id) => {
        const label = citizenLabel(state, id);
        return personPill(label.name, label.sub);
      })
      .join('');

    const progress = def.production
      ? `<div class="prog-row"><span>生產進度</span><div class="prog-bar"><i data-k="prog"></i></div></div>`
      : '';

    const demolishArea =
      pendingDemolish === building.id
        ? `<div class="confirm-inline"><span>確定拆除？</span>` +
          `<button type="button" class="danger" data-act="demolish-interior-confirm" data-id="${building.id}">確定拆除</button>` +
          `<button type="button" data-act="demolish-interior-cancel">取消</button></div>`
        : `<button type="button" class="danger-outline" data-act="demolish-interior" data-id="${building.id}">${ico('hammer')}拆除此建築</button>`;

    setHtml(
      layer,
      `
      <div class="interior-plaque" aria-hidden="true">
        <span>${esc(def.name)}</span>
        <small>${esc(CATEGORY_INFO[def.category].name)} · 室內</small>
      </div>
      <div class="interior-card">
        <header class="interior-head">
          <div class="interior-title">
            <span class="interior-seal" style="--c:${hexColor(def.color)}">${esc(def.name.slice(0, 1))}</span>
            <div class="interior-title-text">
              <b>${esc(def.name)}</b>
              <div class="interior-meta-line">
                <span class="badge">${esc(CATEGORY_INFO[def.category].name)}</span>
                <small>${building.w}×${building.h} · ${esc(formatShortDate(state.clock))}</small>
              </div>
            </div>
          </div>
          <div class="interior-actions">
            <button type="button" class="primary" data-act="exit-interior">${ico('back')}返回城市<kbd>Esc</kbd></button>
          </div>
        </header>

        <div class="interior-body">
          <div class="interior-main">
            <p class="interior-desc">${esc(def.desc)}</p>
            <div class="status-row">${statusPills(building, def)}</div>
            <div class="def-notes">${metaRows(def)}</div>
            ${progress}
          </div>

          <div class="interior-col">
            <div class="section-label">室內庫存</div>
            <div class="res-wrap">${resourceChips(building.inventory)}</div>
            <div class="section-label">本月帳目</div>
            <div class="finance-line finance-line-col">
              <span>進帳 <b>${formatMoney(building.incomeThisMonth)}</b></span>
              <span>支出 <b>${formatMoney(building.expenseThisMonth)}</b></span>
            </div>
          </div>

          <div class="interior-col interior-people-col">
            ${
              def.housing > 0
                ? `<div class="section-label">居民 <span class="mini">${building.residents.length}/${def.housing}</span></div>
                   <div class="people">${residents || '<span class="muted">尚無居民</span>'}</div>`
                : ''
            }
            ${
              def.workers > 0
                ? `<div class="section-label">工人 <span class="mini">${building.workers.length}/${def.workers}</span></div>
                   <div class="people">${workers || '<span class="muted">尚無工人</span>'}</div>`
                : ''
            }
            ${
              def.housing === 0 && def.workers === 0
                ? '<div class="section-label">人煙</div><span class="muted">此處無人常駐</span>'
                : ''
            }
          </div>
        </div>

        <footer class="interior-foot">
          <span class="interior-note">${sealHtml('室', 'seal-gold seal-sm')} 靜觀堂內陳設，按「返回城市」或雙擊戶外可離開</span>
          ${demolishArea}
        </footer>
      </div>
    `,
    );
    lastProgWidth = -1;
    layer.classList.add('show');
  };

  const update = (state: GameState): void => {
    if (state.ui.mode !== 'interior' || state.ui.interiorId == null) {
      hide();
      return;
    }
    const id = state.ui.interiorId;
    const building = state.buildings.find((b) => b.id === id);
    const def = building ? BUILDINGS[building.key] : undefined;
    if (!building || !def) {
      hide();
      return;
    }
    currentId = id;
    const sig = signature(state, building, def);
    if (sig !== lastSig) {
      lastSig = sig;
      render(state, building, def);
    }
    if (def.production) {
      const bar = layer.querySelector<HTMLElement>('[data-k="prog"]');
      if (bar) {
        const width = Math.round(Math.max(0, Math.min(1, building.productionProgress)) * 100);
        if (width !== lastProgWidth) {
          lastProgWidth = width;
          bar.style.width = `${width}%`;
        }
      }
    }
  };

  return {
    update,
    destroy(): void {
      offClick();
      clearPending();
      layer.remove();
    },
  };
}
