/**
 * 視窗層：新手指引、說明手冊、財政、存檔。
 *
 * 只在「開啟的視窗種類改變」或「視窗內關鍵數據改變」時重建 DOM；
 * 滑桿拖曳與輸入框打字不會觸發重建。
 */

import {
  BUILDINGS,
  FESTIVAL_COOLDOWN_DAYS,
  FESTIVAL_COST,
  SEASON_FARM_BONUS,
  SEASON_INFO,
  SEASON_TEMP,
  WEATHER_EFFECT,
  WEATHER_INFO,
  formatMoney,
} from '../core/config';
import type { GameActions, GameState, SaveSlotInfo } from '../core/types';
import type { GameStore } from '../core/store';
import { clamp, delegate, esc, num, timestampLabel } from './dom';
import { ico, sealHtml } from './icons';

type ModalKey = 'tutorial' | 'help' | 'finance' | 'save';

interface ConfirmState {
  kind: 'delete' | 'new';
  slot: number;
}

export interface ModalsView {
  update(state: GameState): void;
  destroy(): void;
}

const SLOT_NAMES = ['自動存檔', '存檔一', '存檔二', '存檔三'];

function signedMoney(value: number): string {
  if (value > 0) return `+${formatMoney(value)}`;
  return formatMoney(value);
}

function upkeepOf(state: GameState): number {
  let total = 0;
  for (const building of state.buildings) total += BUILDINGS[building.key]?.upkeep ?? 0;
  return total;
}

function modalShell(key: ModalKey, seal: string, title: string, subtitle: string, body: string, footer = ''): string {
  return `
    <div class="modal-backdrop" data-modal="${key}">
      <div class="modal modal-${key}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-frame">
          <header class="modal-head">
            <div class="modal-heading">
              ${sealHtml(seal, 'modal-seal')}
              <div class="modal-heading-text">
                <h2>${esc(title)}</h2>
                <small>${subtitle}</small>
              </div>
            </div>
            <button type="button" class="modal-close" data-act="close" title="關閉（Esc）">${ico('close')}</button>
          </header>
          <div class="modal-body">${body}</div>
          ${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}
        </div>
      </div>
    </div>
  `;
}

function keyRow(key: string, desc: string): string {
  return `<div class="ctrl"><kbd>${esc(key)}</kbd><span>${esc(desc)}</span></div>`;
}

export function createModals(container: HTMLElement, store: GameStore, actions: GameActions): ModalsView {
  const layer = document.createElement('div');
  layer.className = 'modal-root';
  layer.setAttribute('aria-hidden', 'true');
  container.appendChild(layer);

  let current: ModalKey | null = null;
  let financeSig = '';
  let saveSig = '';
  let saves: SaveSlotInfo[] = [];
  let savesAt = 0;
  let savesDirty = true;
  let confirm: ConfirmState | null = null;
  let seedInput = '';

  // ─────────────────────────── 事件 ───────────────────────────

  const closeTutorial = (): void => {
    if (store.state.ui.showTutorial) {
      store.state.ui.showTutorial = false;
      store.bumpUI();
    }
  };

  const closeAll = (): void => {
    if (store.state.ui.showTutorial) {
      store.state.ui.showTutorial = false;
      store.bumpUI();
    }
    actions.closeOverlays();
  };

  const markSavesDirty = (): void => {
    savesDirty = true;
  };

  const offClick = delegate(layer, 'click', '[data-act]', (node) => {
    const act = node.dataset.act;
    switch (act) {
      case 'close':
        closeAll();
        return;
      case 'open-help':
        closeTutorial();
        if (!store.state.ui.showHelp) actions.toggleHelp();
        return;
      case 'festival':
        actions.holdFestival();
        return;
      case 'save-slot': {
        const slot = Number(node.dataset.slot);
        if (!Number.isFinite(slot)) return;
        actions.saveGame(slot);
        markSavesDirty();
        return;
      }
      case 'load-slot': {
        const slot = Number(node.dataset.slot);
        if (!Number.isFinite(slot)) return;
        if (actions.loadGame(slot)) markSavesDirty();
        return;
      }
      case 'delete-slot': {
        const slot = Number(node.dataset.slot);
        if (!Number.isFinite(slot)) return;
        confirm = { kind: 'delete', slot };
        return;
      }
      case 'confirm-delete': {
        if (confirm?.kind === 'delete') actions.deleteSave(confirm.slot);
        confirm = null;
        markSavesDirty();
        return;
      }
      case 'new-game':
        confirm = { kind: 'new', slot: 0 };
        return;
      case 'confirm-new-game': {
        const parsed = Number.parseInt(seedInput.trim(), 10);
        const seed = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        confirm = null;
        seedInput = '';
        actions.newGame(seed);
        return;
      }
      case 'cancel-confirm':
        confirm = null;
        return;
      case 'export':
        actions.exportSave();
        return;
      default:
        return;
    }
  });

  const offInput = delegate(layer, 'input', '[data-act]', (node) => {
    if (node.dataset.act === 'tax') {
      const raw = Number((node as HTMLInputElement).value);
      const pct = clamp(Math.round(raw), 0, 20);
      actions.setTaxRate(pct / 100);
      (node as HTMLInputElement).style.setProperty('--fill', `${(pct / 20) * 100}%`);
      const label = layer.querySelector<HTMLElement>('[data-k="taxLabel"]');
      if (label) label.textContent = `${pct}%`;
      return;
    }
    if (node.dataset.act === 'seed-input') {
      seedInput = (node as HTMLInputElement).value;
    }
  });

  const offChange = delegate(layer, 'change', '[data-act="import"]', async (node) => {
    const input = node as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const ok = await actions.importSave(file);
    input.value = '';
    if (ok) markSavesDirty();
  });

  const backdropClick = (event: Event): void => {
    const target = event.target;
    if (target instanceof Element && target.classList.contains('modal-backdrop')) closeAll();
  };
  layer.addEventListener('click', backdropClick);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Escape' || !current) return;
    if (current === 'tutorial') closeTutorial();
    // 其餘視窗由 city-view 的全域 Esc 關閉；此處再保險一次。
    else actions.closeOverlays();
  };
  window.addEventListener('keydown', onKeyDown);

  // ─────────────────────────── 各視窗內容 ───────────────────────────

  const renderTutorial = (state: GameState): void => {
    const steps = [
      { no: '一', title: '鋪路為先', text: '先在平地鋪設青石板路；道路是城市的血脈，建築臨路才能營運。' },
      { no: '二', title: '民居安民', text: '在路旁建造茅屋，百姓便會遷入；人口是解鎖新建築的關鍵。' },
      { no: '三', title: '農田足食', text: '沃土之上開闢農田，糧食是民生之本；記得把工人補齊。' },
      { no: '四', title: '市集供需', text: '以糧倉、貨棧儲存貨物，再建市集向周邊民居供貨，商稅自來。' },
      { no: '五', title: '稅收興城', text: '每月徵稅並支付維護費；在「財政」調節稅率，節慶可安撫民心。' },
    ];
    const body = `
      <div class="tutorial-hero">
        <span class="tutorial-seal" aria-hidden="true">營</span>
        <div class="tutorial-lead">
          <h3>歡迎來到${esc(state.cityName)}</h3>
          <p>你受命治理這片山河。先從一條路、一間屋、一畝田開始，讓這座古城在四季更迭中慢慢繁榮起來。</p>
        </div>
      </div>

      <ol class="tutorial-steps">
        ${steps
          .map(
            (step) => `
          <li>
            <span class="step-no">${step.no}</span>
            <div class="step-text"><b>${step.title}</b><p>${step.text}</p></div>
          </li>`,
          )
          .join('')}
      </ol>

      <h3 class="section-title">操作要訣</h3>
      <div class="ctrl-grid">
        ${keyRow('左鍵', '建造／選取')}
        ${keyRow('雙擊', '進入建築室內')}
        ${keyRow('右鍵拖曳', '旋轉視角')}
        ${keyRow('Shift／中鍵拖曳', '平移視角')}
        ${keyRow('滾輪', '縮放遠近')}
        ${keyRow('WASD／方向鍵', '平移視角')}
        ${keyRow('空白鍵', '暫停／繼續')}
        ${keyRow('1 / 2 / 3', '調整遊戲速度')}
      </div>

      <div class="tutorial-tip">
        ${ico('lantern')}
        <span>切記：先求溫飽，再求繁華。糧食、民心、庫銀三者平衡，古城方能長治久安。</span>
      </div>

    `;
    const footer = `
      <button type="button" class="link" data-act="open-help">查看完整說明</button>
      <button type="button" class="primary" data-act="close">開始營造</button>
    `;
    layer.innerHTML = modalShell('tutorial', '引', '初入古城', '新手指引 · 一步一步營造你的城池', body, footer);
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
  };

  const renderHelp = (state: GameState): void => {
    const seasonRows = (Object.keys(SEASON_INFO) as (keyof typeof SEASON_INFO)[])
      .map(
        (season) =>
          `<tr><td>${esc(SEASON_INFO[season].name)}</td>` +
          `<td>${Math.round(SEASON_FARM_BONUS[season] * 100)}%</td>` +
          `<td>${SEASON_TEMP[season]}°C</td></tr>`,
      )
      .join('');

    const weatherRows = (Object.keys(WEATHER_INFO) as (keyof typeof WEATHER_INFO)[])
      .map((weather) => {
        const effect = WEATHER_EFFECT[weather as keyof typeof WEATHER_EFFECT];
        const farm = Math.round(effect.farm * 100);
        const move = Math.round(effect.move * 100);
        const happy = effect.happiness > 0 ? `+${effect.happiness}` : String(effect.happiness);
        return `<tr><td>${esc(WEATHER_INFO[weather].name)}</td><td>${farm}%</td><td>${move}%</td><td>${happy}</td><td>${esc(WEATHER_INFO[weather].hint)}</td></tr>`;
      })
      .join('');

    const body = `
      <div class="help-intro">
        <p>《華夏古城》是一座中國古代城市建造模擬。你將以道路串連街坊，以農田與作坊養活百姓，以市集與倉儲運轉物流，並在四時晴雨中維持民心與庫銀。</p>
      </div>
      <div class="help-grid">
        <section class="help-block">
          <h3>${ico('road')}城市建設</h3>
          <ul>
            <li>先在平地鋪設<b>道路</b>，多數建築需臨路才能營運。</li>
            <li><b>民居</b>吸引百姓遷入並提供勞力；人口達標會解鎖新建築。</li>
            <li><b>生產</b>建築（農田、伐木場、採石場、鐵礦場……）依地形與季節產出。</li>
            <li><b>倉儲</b>（糧倉、貨棧）是物流樞紐，容量有限，需平衡生產與需求。</li>
            <li><b>商業</b>與<b>民生</b>建築提供服務、收入與幸福度加成。</li>
          </ul>
        </section>
        <section class="help-block">
          <h3>${ico('cart')}物流與民生</h3>
          <ul>
            <li>生產建築先將貨物暫存本地，再由搬運工沿道路送往倉庫。</li>
            <li>市集向倉庫提貨，為半徑內的民居供應糧食與日用品。</li>
            <li>茶館消耗茶葉、客棧消耗酒，帶來收入並提升民心。</li>
            <li>寺廟、學堂、水井、涼亭提升周邊幸福度。</li>
            <li>碼頭臨水而建，可將多餘貨物出口換取白銀。</li>
          </ul>
        </section>
        <section class="help-block">
          <h3>${ico('ingot')}財政與稅收</h3>
          <ul>
            <li>每月結算：人頭稅、田賦、商稅與服務收入，扣除全部建築維護費。</li>
            <li>稅率 0–20%：越高收入越多，但百姓幸福度下降。</li>
            <li>舉辦<b>節慶</b>花費 ${FESTIVAL_COST} 兩，全城幸福度 +12，每 ${FESTIVAL_COOLDOWN_DAYS} 日一次。</li>
            <li>國庫虧空會拖累民心，應及早調整稅率或削減開支。</li>
            <li>遊戲每 60 秒自動存檔；亦可手動保存三格或匯出 JSON。</li>
          </ul>
        </section>
        <section class="help-block">
          <h3>${ico('sun')}時令與天氣</h3>
          <table class="mini-table">
            <thead><tr><th>季節</th><th>農作</th><th>氣溫</th></tr></thead>
            <tbody>${seasonRows}</tbody>
          </table>
          <table class="mini-table">
            <thead><tr><th>天氣</th><th>農作</th><th>移動</th><th>民心</th><th>說明</th></tr></thead>
            <tbody>${weatherRows}</tbody>
          </table>
        </section>
        <section class="help-block">
          <h3>${ico('compass')}操作方式</h3>
          <div class="ctrl-grid">
            ${keyRow('左鍵', '建造／選取')}
            ${keyRow('雙擊', '進入建築室內')}
            ${keyRow('右鍵點擊', '取消目前工具')}
            ${keyRow('右鍵拖曳', '旋轉視角')}
            ${keyRow('Shift／中鍵拖曳', '平移視角')}
            ${keyRow('滾輪', '縮放')}
            ${keyRow('WASD／方向鍵', '平移')}
            ${keyRow('Q／E', '旋轉')}
          </div>
        </section>
        <section class="help-block">
          <h3>${ico('book')}快捷鍵</h3>
          <table class="mini-table key-table">
            <tbody>
              <tr><td><kbd>空白鍵</kbd></td><td>暫停／繼續</td></tr>
              <tr><td><kbd>0</kbd></td><td>暫停</td></tr>
              <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></td><td>一倍／二倍／三倍速</td></tr>
              <tr><td><kbd>F</kbd></td><td>財政面板</td></tr>
              <tr><td><kbd>H</kbd></td><td>說明手冊</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>關閉視窗／取消工具／離開室內</td></tr>
            </tbody>
          </table>
        </section>
      </div>
      <div class="help-note">${ico('info')}<span>存檔資料保存在瀏覽器本機；匯出 JSON 可備份或轉移到其他裝置。本作所有圖像皆由程式即時繪製，離線亦可遊玩。</span></div>
    `;
    const footer = `<button type="button" class="primary" data-act="close">閱畢，返回古城</button>`;
    layer.innerHTML = modalShell('help', '書', '營造手冊', '操作、物流、財政與時令', body, footer);
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
    void state;
  };

  const financeSignature = (state: GameState): string => {
    const f = state.finance;
    const last = f.history[f.history.length - 1];
    return [
      Math.round(f.treasury),
      Math.round(f.lastMonthIncome),
      Math.round(f.lastMonthExpense),
      Math.round(f.incomeThisMonth),
      Math.round(f.expenseThisMonth),
      f.history.length,
      last ? `${last.year}/${last.month}/${Math.round(last.balance)}` : '',
      f.lastFestivalDay,
      state.clock.totalDays,
      state.buildings.length,
      upkeepOf(state),
      state.stats.population,
    ].join('|');
  };

  const renderFinance = (state: GameState): void => {
    const f = state.finance;
    const upkeep = upkeepOf(state);
    const treasury = f.treasury;
    const balance = f.lastMonthIncome - f.lastMonthExpense;
    const pct = Math.round(f.taxRate * 100);
    const remaining = Math.max(0, FESTIVAL_COOLDOWN_DAYS - (state.clock.totalDays - f.lastFestivalDay));
    const canFestival = remaining <= 0 && treasury >= FESTIVAL_COST;
    const monthsOfRunway = upkeep > 0 ? treasury / upkeep : Infinity;

    const history = f.history.slice(-8).reverse();
    const historyRows = history.length
      ? history
          .map(
            (record) =>
              `<tr><td>第${record.year}年 ${record.month}月</td>` +
              `<td class="positive">${formatMoney(record.income)}</td>` +
              `<td class="negative">${formatMoney(record.expense)}</td>` +
              `<td class="${record.balance >= 0 ? 'positive' : 'negative'}">${formatMoney(record.balance)}</td>` +
              `<td>${num(record.population)}</td><td>${Math.round(record.happiness)}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="6" class="muted center">尚未結算——遊戲中每過一個月便會記下一筆。</td></tr>';

    const warnings: string[] = [];
    if (treasury < 0) {
      warnings.push(
        `<div class="fin-warning bad">${ico('warn')}<span><b>國庫虧空！</b> 庫銀為負，百姓惶惶。請調高稅率、舉辦節慶安撫民心，或拆除高維護建築。</span></div>`,
      );
    } else if (upkeep > 0 && treasury < upkeep) {
      warnings.push(
        `<div class="fin-warning warn">${ico('warn')}<span>庫銀不足以支付一個月的維護費（約 ${formatMoney(upkeep)}），恐怕撐不到下次徵稅。</span></div>`,
      );
    } else if (Number.isFinite(monthsOfRunway) && monthsOfRunway < 3) {
      warnings.push(
        `<div class="fin-warning info">${ico('info')}<span>庫銀約可支撐 ${Math.max(1, Math.floor(monthsOfRunway))} 個月的維護費，宜開源節流。</span></div>`,
      );
    }

    const body = `
      <div class="finance-hero">
        <div class="fin-treasury${treasury < 0 ? ' negative' : ''}">
          <span class="fin-label">國庫存銀</span>
          <b class="fin-amount">${formatMoney(treasury)}</b>
          <span class="fin-sub">${treasury < 0 ? '入不敷出，亟需開源' : '庫銀尚足，穩中求進'}</span>
        </div>
        <div class="fin-cards">
          <div class="fin-card"><span>上月收入</span><b class="positive">${signedMoney(f.lastMonthIncome)}</b></div>
          <div class="fin-card"><span>上月支出</span><b class="negative">${formatMoney(-Math.abs(f.lastMonthExpense))}</b></div>
          <div class="fin-card"><span>上月盈餘</span><b class="${balance >= 0 ? 'positive' : 'negative'}">${signedMoney(balance)}</b></div>
        </div>
      </div>
      ${warnings.join('')}

      <div class="fin-block">
        <div class="block-head"><h3>${ico('coin')}稅率</h3><span class="tax-big" data-k="taxLabel">${pct}%</span></div>
        <input class="tax-slider" type="range" min="0" max="20" step="1" value="${pct}" data-act="tax" style="--fill:${(pct / 20) * 100}%" aria-label="稅率" />
        <div class="tax-scale"><span>0% 輕徭</span><span>10% 常賦</span><span>20% 重稅</span></div>
        <p class="hint">稅率越高，人頭稅與商稅收入越多，但百姓幸福度下降。建議維持在 8–12% 之間。</p>
      </div>

      <div class="fin-grid">
        <div class="fin-block">
          <div class="block-head"><h3>本月收支</h3></div>
          <div class="fin-kv"><span>本月累計收入</span><b class="positive">${formatMoney(f.incomeThisMonth)}</b></div>
          <div class="fin-kv"><span>本月累計支出</span><b class="negative">${formatMoney(f.expenseThisMonth)}</b></div>
          <div class="fin-kv"><span>建築維護（預估／月）</span><b>${formatMoney(upkeep)}</b></div>
          <div class="fin-kv"><span>城中建築</span><b>${state.buildings.length} 座</b></div>
        </div>
        <div class="fin-block">
          <div class="block-head"><h3>${ico('lantern')}節慶</h3></div>
          <p class="hint">舉辦節慶可令全城百姓幸福度 +12，花費 ${FESTIVAL_COST} 兩，每 ${FESTIVAL_COOLDOWN_DAYS} 日可辦一次。</p>
          <button type="button" class="festival-btn" data-act="festival" ${canFestival ? '' : 'disabled'}>
            ${remaining > 0 ? `冷卻中 · 尚需 ${remaining} 日` : `舉辦節慶（${FESTIVAL_COST} 兩）`}
          </button>
          <div class="fin-kv"><span>上次節慶</span><b>${f.lastFestivalDay < 0 ? '從未舉辦' : `第 ${f.lastFestivalDay} 日`}</b></div>
        </div>
      </div>

      <div class="fin-block">
        <div class="block-head"><h3>月報表</h3><span class="mini">最近 ${history.length} 個月</span></div>
        <div class="table-scroll">
          <table class="history-table">
            <thead><tr><th>年月</th><th>收入</th><th>支出</th><th>盈餘</th><th>人口</th><th>民心</th></tr></thead>
            <tbody>${historyRows}</tbody>
          </table>
        </div>
      </div>
      <p class="modal-foot-note">${ico('info')}每月自動結算；國庫不足時將影響民心與城市發展。</p>
    `;
    layer.innerHTML = modalShell('finance', '財', '古城財政', '稅賦、開支與月報', body);
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
  };

  const saveSignature = (): string => {
    const slots = saves
      .map((slot) => `${slot.slot}:${slot.empty ? 0 : 1}:${slot.savedAt}:${slot.population}:${Math.round(slot.treasury)}:${slot.cityName}`)
      .join('|');
    return `${slots}|${confirm ? `${confirm.kind}:${confirm.slot}` : ''}`;
  };

  const renderSave = (): void => {
    const cards = saves
      .map((slot) => {
        const empty = slot.empty;
        const auto = slot.slot === 0;
        const isDeleteConfirm = confirm?.kind === 'delete' && confirm.slot === slot.slot;
        const body = empty
          ? '<div class="slot-body slot-empty"><span class="muted">此格尚未使用</span></div>'
          : `<div class="slot-body">
              <b class="slot-city">${esc(slot.cityName)}</b>
              <div class="slot-meta">
                <span>人口 ${num(slot.population)}</span>
                <span>${formatMoney(slot.treasury)}</span>
                <span>${esc(slot.dateLabel)}</span>
              </div>
            </div>`;
        const actionsHtml = `
          <div class="slot-actions">
            ${
              auto
                ? ''
                : `<button type="button" class="mini-btn" data-act="save-slot" data-slot="${slot.slot}">${
                    empty ? '保存至此' : '覆蓋存檔'
                  }</button>`
            }
            <button type="button" class="mini-btn" data-act="load-slot" data-slot="${slot.slot}" ${empty ? 'disabled' : ''}>讀取</button>
            ${
              !auto && !empty
                ? `<button type="button" class="mini-btn danger" data-act="delete-slot" data-slot="${slot.slot}">刪除</button>`
                : ''
            }
          </div>
          ${
            isDeleteConfirm
              ? `<div class="confirm-inline"><span>確定刪除「${esc(slot.cityName)}」的存檔？</span>
                  <button type="button" class="danger" data-act="confirm-delete" data-slot="${slot.slot}">確定刪除</button>
                  <button type="button" data-act="cancel-confirm">取消</button></div>`
              : ''
          }`;
        return `
          <article class="save-slot${auto ? ' autosave' : ''}${empty ? ' empty' : ''}">
            <header class="slot-head">
              <span class="slot-name">${auto ? ico('clock') : ico('scroll')}${SLOT_NAMES[slot.slot] ?? `存檔 ${slot.slot}`}</span>
              <span class="slot-time">${empty ? '—' : timestampLabel(slot.savedAt)}</span>
            </header>
            ${body}
            ${actionsHtml}
          </article>`;
      })
      .join('');

    const newGameConfirm =
      confirm?.kind === 'new'
        ? `<div class="new-game-box">
            <p><b>確定另起新局？</b>目前未手動保存的進度將會遺失。</p>
            <label class="seed-label">山河種子（可留空隨機）
              <input type="text" inputmode="numeric" data-act="seed-input" value="${esc(seedInput)}" placeholder="例如 20261018" />
            </label>
            <div class="confirm-btns">
              <button type="button" class="danger" data-act="confirm-new-game">確定奠基</button>
              <button type="button" data-act="cancel-confirm">取消</button>
            </div>
          </div>`
        : '';

    const body = `
      <p class="save-lead">${ico('scroll')}存檔保存在瀏覽器本機，每 60 秒自動存檔一次。也可手動保存三格、匯出 JSON 備份。</p>
      <div class="save-list">${cards}</div>
      <div class="save-tools">
        <button type="button" class="save-tool" data-act="export">${ico('scroll')}匯出 JSON</button>
        <label class="save-tool file">
          ${ico('book')}匯入 JSON
          <input type="file" accept=".json,application/json" data-act="import" hidden />
        </label>
        <button type="button" class="save-tool danger-outline" data-act="new-game">${ico('warn')}另起新局</button>
      </div>
      ${newGameConfirm}
      <p class="modal-foot-note">${ico('info')}讀檔後世界狀態將完整還原；匯入的存檔會立即取代目前進度。</p>
    `;
    layer.innerHTML = modalShell('save', '檔', '存檔竹簡', '自動存檔 · 手動三格 · 匯出匯入', body);
    if (confirm) layer.querySelector('.new-game-box, .confirm-inline')?.scrollIntoView({ block: 'nearest' });
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
  };

  // ─────────────────────────── 更新 ───────────────────────────

  const open = (key: ModalKey, state: GameState): void => {
    current = key;
    confirm = null;
    seedInput = '';
    if (key === 'tutorial') renderTutorial(state);
    else if (key === 'help') renderHelp(state);
    else if (key === 'finance') {
      financeSig = financeSignature(state);
      renderFinance(state);
    } else {
      saves = actions.getSaves();
      savesAt = performance.now();
      savesDirty = false;
      saveSig = saveSignature();
      renderSave();
    }
  };

  const close = (): void => {
    if (!current) return;
    current = null;
    confirm = null;
    seedInput = '';
    layer.classList.remove('open');
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = '';
  };

  const update = (state: GameState): void => {
    const next: ModalKey | null = state.ui.showTutorial
      ? 'tutorial'
      : state.ui.showHelp
        ? 'help'
        : state.ui.showFinance
          ? 'finance'
          : state.ui.showSave
            ? 'save'
            : null;

    if (!next) {
      if (current) close();
      return;
    }

    if (next !== current) {
      open(next, state);
      return;
    }

    if (next === 'finance') {
      const sig = financeSignature(state);
      if (sig !== financeSig) {
        financeSig = sig;
        renderFinance(state);
      }
      return;
    }

    if (next === 'save') {
      const now = performance.now();
      if (savesDirty || now - savesAt > 3000) {
        saves = actions.getSaves();
        savesAt = now;
        savesDirty = false;
      }
      const sig = saveSignature();
      if (sig !== saveSig) {
        saveSig = sig;
        renderSave();
      }
    }
  };

  return {
    update,
    destroy(): void {
      offClick();
      offInput();
      offChange();
      layer.removeEventListener('click', backdropClick);
      window.removeEventListener('keydown', onKeyDown);
      layer.remove();
    },
  };
}
