/**
 * 右側「城事」面板：
 *  - 未選取建築：城市概況（人口、就業、糧食、幸福度、庫存、紀要、建言）
 *  - 選取建築：名稱、描述、狀態（道路／工人／居民）、庫存、進入、拆除
 *
 * 結構只在選取對象或關鍵數據變更時重建；進度條等逐幀數值只改 style。
 */

import {
  BUILDINGS,
  CATEGORY_INFO,
  RESOURCES,
  TERRAIN_INFO,
  formatMoney,
} from '../core/config';
import { formatShortDate } from '../core/format';
import type { Building, BuildingDef, GameActions, GameState, ResourceKey } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, esc, hexColor, happinessTone, num, qs, setCssVar, setHidden, setHtml, setText } from './dom';
import { ico, personPill, resourceChips, sealHtml } from './icons';

export interface InfoPanelView {
  update(state: GameState): void;
  destroy(): void;
}

const MAX_NAMES = 8;

function inventoryTotals(state: GameState): Partial<Record<ResourceKey, number>> {
  const totals: Partial<Record<ResourceKey, number>> = {};
  for (const building of state.buildings) {
    for (const [key, value] of Object.entries(building.inventory) as [ResourceKey, number][]) {
      if (!value) continue;
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

function citizenName(state: GameState, id: number): string {
  return state.citizens.find((c) => c.id === id)?.name ?? '無名氏';
}

interface NoteRow {
  label: string;
  value: string;
}

function productionRows(def: BuildingDef): NoteRow[] {
  const rows: NoteRow[] = [];
  const prod = def.production;
  if (!prod) return rows;
  rows.push({ label: '產出', value: `${RESOURCES[prod.output]?.name ?? prod.output} ${prod.amountPerDay}/日` });
  if (prod.input) {
    rows.push({
      label: '投入',
      value: `${RESOURCES[prod.input.resource]?.name ?? prod.input.resource} ${prod.input.amountPerDay}/日`,
    });
  }
  const terrain = terrainLine(def);
  if (terrain) rows.push({ label: '適地', value: terrain });
  return rows;
}

function serviceRows(def: BuildingDef): NoteRow[] {
  const rows: NoteRow[] = [];
  const svc = def.service;
  if (!svc) return rows;
  if (svc.radius) rows.push({ label: '半徑', value: `${svc.radius} 格` });
  if (svc.happiness) rows.push({ label: '民心', value: `周邊 +${svc.happiness}` });
  if (svc.incomePerDay) rows.push({ label: '進帳', value: `約 ${svc.incomePerDay} 兩/日` });
  if (svc.consumes) {
    const c = svc.consumes;
    rows.push({ label: '耗用', value: `${RESOURCES[c.resource]?.name ?? c.resource} ${c.amountPerDay}/日` });
  }
  if (svc.taxBonus) rows.push({ label: '稅收', value: `效率 +${Math.round(svc.taxBonus * 100)}%` });
  return rows;
}

function terrainLine(def: BuildingDef): string {
  if (!def.production?.allowedTerrain?.length) return '';
  return def.production.allowedTerrain.map((t) => TERRAIN_INFO[t]?.name ?? t).join('、');
}

export function createInfoPanel(container: HTMLElement, store: GameStore, actions: GameActions): InfoPanelView {
  const root = document.createElement('aside');
  root.className = 'info-panel';
  root.id = 'info-panel';
  root.innerHTML = `
    <div class="panel-corner tl"></div><div class="panel-corner tr"></div>
    <div class="panel-corner bl"></div><div class="panel-corner br"></div>
    <header class="panel-head">
      <h2 class="panel-title">城事</h2>
      ${sealHtml('城', 'panel-seal')}
      <button type="button" class="collapse-btn" data-act="collapse" data-panel="info" title="收合面板">${ico('chevronRight')}</button>
    </header>
    <div class="info-scroll">
      <section class="info-view" data-view="overview">
        <div class="city-hero">
          <div class="hero-text">
            <span class="hero-label">治所</span>
            <b class="hero-city" data-k="cityName">華夏古城</b>
            <span class="hero-date" data-k="date"></span>
          </div>
          <div class="happy-dial tone-ok" data-k="dial" role="img" aria-label="民心">
            <div class="dial-face"><b data-k="happyBig">70</b><span>民心</span></div>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-card"><span>人口</span><b data-k="pop">0</b><small data-k="households">住戶 0</small></div>
          <div class="stat-card"><span>就業</span><b data-k="employed">0</b><small data-k="jobs">職位 0</small></div>
          <div class="stat-card"><span>失業</span><b data-k="unemployed">0</b><small>待業市民</small></div>
          <div class="stat-card"><span>無家</span><b data-k="homeless">0</b><small>流離市民</small></div>
          <div class="stat-card wide"><span>糧食</span><b data-k="food">0</b><small data-k="foodRate">日耗 0</small></div>
          <div class="stat-card"><span>物流</span><b data-k="transit">0</b><small>搬運中</small></div>
        </div>

        <div class="section-label">庫存總覽</div>
        <div class="res-wrap" data-k="resWrap"></div>

        <div class="section-label">城事紀要 <span class="mini" data-k="logCount"></span></div>
        <ul class="log-feed" data-k="logFeed"></ul>

        <div class="tip-card">
          <div class="tips-head"><span class="seal seal-gold">諫</span><b>營造建言</b></div>
          <ul class="tips" data-k="tips"></ul>
        </div>
      </section>

      <section class="info-view info-selected" data-view="building" hidden></section>
    </div>
  `;
  container.appendChild(root);

  const overview = qs<HTMLElement>(root, '[data-view="overview"]')!;
  const selected = qs<HTMLElement>(root, '[data-view="building"]')!;

  const cityNameEl = qs<HTMLElement>(root, '[data-k="cityName"]')!;
  const dateEl = qs<HTMLElement>(root, '[data-k="date"]')!;
  const dialEl = qs<HTMLElement>(root, '[data-k="dial"]')!;
  const happyBigEl = qs<HTMLElement>(root, '[data-k="happyBig"]')!;
  const popEl = qs<HTMLElement>(root, '[data-k="pop"]')!;
  const householdsEl = qs<HTMLElement>(root, '[data-k="households"]')!;
  const employedEl = qs<HTMLElement>(root, '[data-k="employed"]')!;
  const jobsEl = qs<HTMLElement>(root, '[data-k="jobs"]')!;
  const unemployedEl = qs<HTMLElement>(root, '[data-k="unemployed"]')!;
  const homelessEl = qs<HTMLElement>(root, '[data-k="homeless"]')!;
  const foodEl = qs<HTMLElement>(root, '[data-k="food"]')!;
  const foodRateEl = qs<HTMLElement>(root, '[data-k="foodRate"]')!;
  const transitEl = qs<HTMLElement>(root, '[data-k="transit"]')!;
  const resWrap = qs<HTMLElement>(root, '[data-k="resWrap"]')!;
  const logCountEl = qs<HTMLElement>(root, '[data-k="logCount"]')!;
  const logFeed = qs<HTMLElement>(root, '[data-k="logFeed"]')!;
  const tipsEl = qs<HTMLElement>(root, '[data-k="tips"]')!;

  // ── 拆除二次確認 ──
  let pendingDemolish: number | null = null;
  let pendingTimer = 0;
  const clearPending = (): void => {
    pendingDemolish = null;
    if (pendingTimer) window.clearTimeout(pendingTimer);
    pendingTimer = 0;
  };
  const armPending = (id: number): void => {
    pendingDemolish = id;
    if (pendingTimer) window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => {
      pendingDemolish = null;
      pendingTimer = 0;
    }, 4500);
  };

  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'enter': {
        const id = Number(node.dataset.id);
        if (Number.isFinite(id)) actions.enterBuilding(id);
        break;
      }
      case 'demolish': {
        const id = Number(node.dataset.id);
        if (Number.isFinite(id)) armPending(id);
        break;
      }
      case 'demolish-confirm': {
        const id = Number(node.dataset.id);
        clearPending();
        if (Number.isFinite(id)) actions.demolishBuilding(id);
        break;
      }
      case 'demolish-cancel':
        clearPending();
        break;
      case 'deselect':
        actions.selectBuilding(null);
        break;
      default:
        break;
    }
  });

  // ── 概況（逐幀更新，全部先比對） ──
  let lastCity = '';
  let lastDate = '';
  let lastHappy = Number.NaN;
  let lastTone = '';
  let lastResSig = '';
  let lastLogSig = '';
  let lastTipsSig = '';

  const buildTips = (state: GameState): string[] => {
    const { stats, finance, clock } = state;
    const tips: string[] = [];
    if (stats.population === 0) tips.push('先鋪設道路，再建造茅屋與農田，吸引第一批百姓定居。');
    if (state.buildings.length === 0) tips.push('點選左側營造司的建築卡，在中央平地放置第一座建築。');
    if (stats.population > 0 && !state.buildings.some((b) => b.key === 'granary' || b.key === 'warehouse')) {
      tips.push('糧倉與貨棧是物流樞紐，能讓生產與市集之間順暢運轉。');
    }
    if (stats.population > 0 && stats.foodStored <= stats.foodPerDay * 2) {
      tips.push('糧食存量偏低，多闢農田並確認工人充足。');
    }
    if (stats.unemployed > 2) tips.push('尚有市民失業，可增建生產或商業建築吸納人力。');
    if (stats.homeless > 0) tips.push('有人無家可歸，增建民居可提升人口與民心。');
    if (finance.treasury < 0) tips.push('國庫虧空！可在財政面板調高稅率，或暫緩新建工程。');
    else if (finance.treasury < 300) tips.push('國庫告急，留意每月維護費與稅收平衡。');
    if (clock.season === 'winter') tips.push('冬日農作歉收，宜多備糧食並發展茶館、客棧等收入。');
    if (clock.weather === 'rain' || clock.weather === 'snow') tips.push('雨雪使行人腳步放緩，物流與通勤都會變慢。');
    if (!state.buildings.some((b) => b.key === 'well')) tips.push('水井可提升周邊民心，是便宜有效的民生建設。');
    if (tips.length === 0) tips.push('城池運轉順暢，穩步擴張並維持民心即可。');
    return tips.slice(0, 4);
  };

  const updateOverview = (state: GameState): void => {
    const { clock, stats, finance } = state;
    if (state.cityName !== lastCity) {
      lastCity = state.cityName;
      setText(cityNameEl, state.cityName);
    }
    const date = `${formatShortDate(clock)} · ${formatMoney(finance.treasury)}`;
    if (date !== lastDate) {
      lastDate = date;
      setText(dateEl, date);
    }

    const happiness = Math.round(stats.happiness);
    const tone = happinessTone(happiness);
    if (happiness !== lastHappy || tone !== lastTone) {
      lastHappy = happiness;
      lastTone = tone;
      setText(happyBigEl, String(happiness));
      dialEl.classList.remove('tone-bad', 'tone-ok', 'tone-good');
      dialEl.classList.add(`tone-${tone}`);
      setCssVar(dialEl, '--p', `${Math.max(0, Math.min(100, happiness))}`);
    }

    setText(popEl, num(stats.population));
    setText(householdsEl, `住戶 ${num(stats.households)}`);
    setText(employedEl, num(stats.employed));
    setText(jobsEl, `職位 ${num(stats.jobs)}`);
    setText(unemployedEl, num(stats.unemployed));
    setText(homelessEl, num(stats.homeless));
    setText(foodEl, `${num(stats.foodStored)}`);
    setText(foodRateEl, `日耗 ${num(stats.foodPerDay)}`);
    setText(transitEl, num(stats.goodsInTransit));

    // 庫存總覽
    const totals = inventoryTotals(state);
    const resEntries = (Object.entries(totals) as [ResourceKey, number][])
      .filter(([key, value]) => RESOURCES[key] && value > 0.5)
      .sort((a, b) => (RESOURCES[a[0]]?.price ?? 0) * b[1] - (RESOURCES[b[0]]?.price ?? 0) * a[1])
      .slice(0, 8);
    const resSig = resEntries.map(([k, v]) => `${k}:${Math.round(v)}`).join(',');
    if (resSig !== lastResSig) {
      lastResSig = resSig;
      setHtml(
        resWrap,
        resEntries.length
          ? resourceChips(Object.fromEntries(resEntries) as Partial<Record<ResourceKey, number>>)
          : '<span class="muted">倉中無貨，待生產與物流運轉</span>',
      );
    }

    // 城事紀要（最近 6 條）
    const recent = state.log.slice(-6).reverse();
    const logSig = recent.map((entry) => entry.id).join(',');
    if (logSig !== lastLogSig) {
      lastLogSig = logSig;
      setText(logCountEl, `${state.log.length} 則`);
      setHtml(
        logFeed,
        recent.length
          ? recent
              .map(
                (entry) =>
                  `<li class="log-item ${entry.kind}"><span class="log-date">${entry.year}/${entry.month}/${entry.day}</span>` +
                  `<span class="log-text">${esc(entry.text)}</span></li>`,
              )
              .join('')
          : '<li class="log-item info"><span class="log-text muted">尚無大事記載</span></li>',
      );
    }

    // 建言
    const tips = buildTips(state);
    const tipsSig = tips.join('|');
    if (tipsSig !== lastTipsSig) {
      lastTipsSig = tipsSig;
      setHtml(tipsEl, tips.map((tip) => `<li>${esc(tip)}</li>`).join(''));
    }
  };

  // ── 選取建築 ──
  let lastSelectedId = -2;
  let lastSelSig = '';
  let lastProgWidth = -1;

  const selectionSig = (state: GameState, b: Building, def: BuildingDef): string => {
    const inv = Object.entries(b.inventory)
      .filter(([, value]) => (value ?? 0) > 0.05)
      .map(([key, value]) => `${key}:${Math.round((value ?? 0) * 10)}`)
      .join(',');
    return [
      b.id,
      def.key,
      b.connected ? 1 : 0,
      b.active ? 1 : 0,
      b.level,
      b.workers.length,
      b.residents.length,
      b.workers.slice(0, MAX_NAMES).join('.'),
      b.residents.slice(0, MAX_NAMES).join('.'),
      inv,
      Math.round(b.incomeThisMonth),
      Math.round(b.expenseThisMonth),
      pendingDemolish === b.id ? 1 : 0,
      state.finance.treasury < 0 ? 1 : 0,
    ].join('|');
  };

  const renderSelected = (state: GameState, b: Building, def: BuildingDef): void => {
    const status: string[] = [];
    if (b.connected) status.push('<span class="pill ok">道路連通</span>');
    else if (def.needsRoad === false) status.push('<span class="pill">無需臨路</span>');
    else status.push('<span class="pill warn">未連道路</span>');
    if (def.workers > 0) {
      status.push(
        `<span class="pill${b.workers.length >= def.workers ? ' ok' : b.workers.length > 0 ? '' : ' warn'}">工人 ${b.workers.length}/${def.workers}</span>`,
      );
    }
    if (def.housing > 0) {
      status.push(`<span class="pill">居民 ${b.residents.length}/${def.housing}</span>`);
    }
    if (def.production || def.service || def.storage) {
      status.push(`<span class="pill ${b.active ? 'ok' : 'warn'}">${b.active ? '營運中' : '停擺'}</span>`);
    }
    if (b.level > 1) status.push(`<span class="pill">第 ${b.level} 級</span>`);

    const noteRows: NoteRow[] = [...productionRows(def), ...serviceRows(def)];
    if (def.storage) {
      const accepted =
        def.storage.accepted === 'all'
          ? '所有貨物'
          : def.storage.accepted.map((key) => RESOURCES[key]?.name ?? key).join('、');
      noteRows.push({ label: '容量', value: `${def.storage.capacity}（${accepted}）` });
    }
    if (def.housing > 0) noteRows.push({ label: '居住', value: `可住 ${def.housing} 人` });
    noteRows.push({ label: '維護', value: `每月 ${formatMoney(def.upkeep)}` });
    const notes: string[] = noteRows.map(
      (row) => `<div class="note-row"><span>${esc(row.label)}</span><b>${esc(row.value)}</b></div>`,
    );

    const residents =
      b.residents.length > 0
        ? b.residents
            .slice(0, MAX_NAMES)
            .map((id) => personPill(citizenName(state, id)))
            .join('')
        : '';
    const workers =
      b.workers.length > 0
        ? b.workers
            .slice(0, MAX_NAMES)
            .map((id) => personPill(citizenName(state, id)))
            .join('')
        : '';

    const progress =
      def.production && b.productionProgress > 0
        ? `<div class="prog-row"><span>生產進度</span><div class="prog-bar"><i data-k="prog"></i></div></div>`
        : '';

    const demolishArea =
      pendingDemolish === b.id
        ? `<div class="confirm-inline"><span>確定拆除此建築？</span>` +
          `<button type="button" class="danger" data-act="demolish-confirm" data-id="${b.id}">確定拆除</button>` +
          `<button type="button" data-act="demolish-cancel">取消</button></div>`
        : `<button type="button" class="danger" data-act="demolish" data-id="${b.id}">${ico('hammer')}拆除</button>`;

    setHtml(
      selected,
      `
      <div class="sel-head">
        <span class="sel-icon" style="--c:${hexColor(def.color)}">${esc(def.name.slice(0, 1))}</span>
        <div class="sel-title">
          <b>${esc(def.name)}</b>
          <div class="sel-meta">
            <span class="badge">${esc(CATEGORY_INFO[def.category].name)}</span>
            <small>${def.size[0]}×${def.size[1]} 格 · 座落 (${b.x + 1}, ${b.y + 1})</small>
          </div>
        </div>
      </div>
      <p class="sel-desc">${esc(def.desc)}</p>
      <div class="status-row">${status.join('')}</div>
      ${progress}
      <div class="section-label">庫存</div>
      <div class="res-wrap">${resourceChips(b.inventory)}</div>
      <div class="finance-line">
        <span>本月進帳 <b>${formatMoney(b.incomeThisMonth)}</b></span>
        <span>本月支出 <b>${formatMoney(b.expenseThisMonth)}</b></span>
      </div>
      <div class="def-notes">${notes.join('')}</div>
      ${
        residents
          ? `<div class="section-label">居民 <span class="mini">${b.residents.length}/${def.housing}</span></div><div class="people">${residents}</div>`
          : ''
      }
      ${
        workers
          ? `<div class="section-label">工人 <span class="mini">${b.workers.length}/${def.workers}</span></div><div class="people">${workers}</div>`
          : ''
      }
      <div class="sel-actions">
        <button type="button" class="primary" data-act="enter" data-id="${b.id}">${ico('door')}進入建築</button>
        ${demolishArea}
      </div>
      <div class="sel-foot"><button type="button" class="link" data-act="deselect">取消選取</button></div>
    `,
    );
    lastProgWidth = -1;
  };

  const updateSelected = (state: GameState): void => {
    const id = state.ui.selectedId;
    const building = id != null ? state.buildings.find((b) => b.id === id) : undefined;
    if (!building) {
      if (lastSelectedId !== -1) {
        lastSelectedId = -1;
        lastSelSig = '';
        setHidden(selected, true);
        setHidden(overview, false);
      }
      return;
    }
    const def = BUILDINGS[building.key];
    if (!def) return;
    setHidden(overview, true);
    setHidden(selected, false);
    const sig = selectionSig(state, building, def);
    if (sig !== lastSelSig) {
      lastSelSig = sig;
      lastSelectedId = building.id;
      renderSelected(state, building, def);
    }
    if (def.production) {
      const bar = selected.querySelector<HTMLElement>('[data-k="prog"]');
      if (bar) {
        const width = Math.round(Math.max(0, Math.min(1, building.productionProgress)) * 100);
        if (width !== lastProgWidth) {
          lastProgWidth = width;
          bar.style.width = `${width}%`;
        }
      }
    }
  };

  const update = (state: GameState): void => {
    updateOverview(state);
    updateSelected(state);
  };

  return {
    update,
    destroy(): void {
      offClick();
      clearPending();
      root.remove();
    },
  };
}
