/**
 * 頂欄：城名、年月日／時辰、季節天氣溫度、國庫、人口、民心、
 * 暫停與 1／2／3 倍速、財政／存檔／說明／指引按鈕。
 *
 * update() 每幀呼叫；所有欄位都以「上次值」比對後才寫入 DOM。
 */

import { SEASON_INFO, WEATHER_INFO, formatMoney } from '../core/config';
import { formatClock, shichenName } from '../core/format';
import type { GameActions, GameState } from '../core/types';
import type { GameStore } from '../core/store';
import { delegate, happinessTone, num, qs, setClass, setText } from './dom';
import { ico, weatherIcon } from './icons';

export interface TopbarView {
  update(state: GameState): void;
  destroy(): void;
}

export function createTopbar(container: HTMLElement, store: GameStore, actions: GameActions): TopbarView {
  const root = document.createElement('header');
  root.className = 'topbar';
  root.innerHTML = `
    <div class="topbar-inner">
      <div class="tb-brand">
        <span class="brand-seal" aria-hidden="true"><i>華</i><i>夏</i></span>
        <div class="brand-text">
          <b class="city-name" data-k="cityName">華夏古城</b>
          <span class="brand-tag">營造志 · 古城建設</span>
        </div>
      </div>

      <div class="tb-clock">
        <div class="tb-date" data-k="date"><span class="season-chip" data-k="season">春</span><span data-k="dateText">第1年 1月1日</span></div>
        <div class="tb-time">
          <span class="chip-time" title="時辰">${ico('clock')}<b data-k="time">06:00</b><em data-k="shichen">卯時</em></span>
          <span class="chip-weather wx-clear" data-k="weather">
            <span class="wx-ico" data-k="wxIcon"></span>
            <b data-k="wxName">晴</b><em data-k="temp">17°C</em>
          </span>
        </div>
      </div>

      <div class="tb-stats">
        <div class="stat-pill treasury" data-k="moneyPill" title="國庫銀兩">
          <span class="pill-ico">${ico('coin')}</span>
          <span class="pill-body"><span class="pill-label">國庫</span><b class="pill-value" data-k="money">0 兩</b></span>
        </div>
        <div class="stat-pill" title="城市人口">
          <span class="pill-ico">${ico('people')}</span>
          <span class="pill-body"><span class="pill-label">人口</span><b class="pill-value" data-k="pop">0</b></span>
        </div>
        <div class="stat-pill happiness" data-k="happyPill" title="民心（0–100）">
          <span class="pill-ico">${ico('heart')}</span>
          <span class="pill-body"><span class="pill-label">民心</span><b class="pill-value" data-k="happy">70</b></span>
          <span class="happy-meter"><i data-k="happyBar"></i></span>
        </div>
      </div>

      <div class="tb-controls">
        <div class="speed-group" role="group" aria-label="遊戲速度">
          <button type="button" data-act="speed" data-speed="0" title="暫停（空白鍵）">${ico('pause')}</button>
          <button type="button" data-act="speed" data-speed="1" title="正常速度（1）">${ico('play1')}</button>
          <button type="button" data-act="speed" data-speed="2" title="二倍速（2）">${ico('play2')}</button>
          <button type="button" data-act="speed" data-speed="3" title="三倍速（3）">${ico('play3')}</button>
        </div>
        <span class="pause-flag" data-k="pauseFlag">暫停</span>
      </div>

      <div class="tb-actions">
        <button type="button" class="top-btn" data-act="finance" title="財政（F）">${ico('ingot')}<span>財政</span></button>
        <button type="button" class="top-btn" data-act="save" title="存檔">${ico('scroll')}<span>存檔</span></button>
        <button type="button" class="top-btn" data-act="help" title="說明（H）">${ico('book')}<span>說明</span></button>
        <button type="button" class="top-btn ghost" data-act="tutorial" title="新手指引">${ico('info')}<span>指引</span></button>
      </div>
    </div>
    <div class="topbar-trim" aria-hidden="true"></div>
  `;
  container.appendChild(root);

  const cityNameEl = qs<HTMLElement>(root, '[data-k="cityName"]')!;
  const seasonEl = qs<HTMLElement>(root, '[data-k="season"]')!;
  const dateTextEl = qs<HTMLElement>(root, '[data-k="dateText"]')!;
  const dateWrap = qs<HTMLElement>(root, '[data-k="date"]')!;
  const timeEl = qs<HTMLElement>(root, '[data-k="time"]')!;
  const shichenEl = qs<HTMLElement>(root, '[data-k="shichen"]')!;
  const weatherWrap = qs<HTMLElement>(root, '[data-k="weather"]')!;
  const wxIconEl = qs<HTMLElement>(root, '[data-k="wxIcon"]')!;
  const wxNameEl = qs<HTMLElement>(root, '[data-k="wxName"]')!;
  const tempEl = qs<HTMLElement>(root, '[data-k="temp"]')!;
  const moneyPill = qs<HTMLElement>(root, '[data-k="moneyPill"]')!;
  const moneyEl = qs<HTMLElement>(root, '[data-k="money"]')!;
  const popEl = qs<HTMLElement>(root, '[data-k="pop"]')!;
  const happyPill = qs<HTMLElement>(root, '[data-k="happyPill"]')!;
  const happyEl = qs<HTMLElement>(root, '[data-k="happy"]')!;
  const happyBar = qs<HTMLElement>(root, '[data-k="happyBar"]')!;
  const pauseFlag = qs<HTMLElement>(root, '[data-k="pauseFlag"]')!;
  const speedButtons = Array.from(root.querySelectorAll<HTMLElement>('[data-act="speed"]'));

  const offClick = delegate(root, 'click', '[data-act]', (node) => {
    switch (node.dataset.act) {
      case 'speed':
        actions.setSpeed(Number(node.dataset.speed ?? 1));
        break;
      case 'finance':
        actions.toggleFinance();
        break;
      case 'save':
        actions.toggleSavePanel();
        break;
      case 'help':
        actions.toggleHelp();
        break;
      case 'tutorial': {
        const ui = store.state.ui;
        ui.showTutorial = true;
        ui.showFinance = false;
        ui.showHelp = false;
        ui.showSave = false;
        store.bumpUI();
        break;
      }
      default:
        break;
    }
  });

  // ── 快取上次值，避免每幀寫 DOM ──
  let lastCity = '';
  let lastDateKey = '';
  let lastTimeKey = '';
  let lastWeatherKey = '';
  let lastMoney = Number.NaN;
  let lastPop = Number.NaN;
  let lastHappy = Number.NaN;
  let lastTone = '';
  let lastSpeed = -1;
  let lastPaused: boolean | null = null;

  const update = (state: GameState): void => {
    const clock = state.clock;
    const season = SEASON_INFO[clock.season];
    const weather = WEATHER_INFO[clock.weather];

    if (state.cityName !== lastCity) {
      lastCity = state.cityName;
      setText(cityNameEl, state.cityName);
    }

    const dateKey = `${clock.year}|${clock.month}|${clock.day}|${clock.season}`;
    if (dateKey !== lastDateKey) {
      lastDateKey = dateKey;
      setText(seasonEl, season?.name ?? '');
      setText(dateTextEl, `第${clock.year}年 ${clock.month}月${clock.day}日`);
      dateWrap.dataset.season = clock.season;
    }

    const timeKey = `${clock.hour}|${clock.minute}`;
    if (timeKey !== lastTimeKey) {
      lastTimeKey = timeKey;
      setText(timeEl, formatClock(clock.hour, clock.minute));
      setText(shichenEl, shichenName(clock.hour));
    }

    const temp = Math.round(clock.tempC);
    const weatherKey = `${clock.season}|${clock.weather}|${temp}`;
    if (weatherKey !== lastWeatherKey) {
      lastWeatherKey = weatherKey;
      wxIconEl.innerHTML = weatherIcon(clock.weather);
      setText(wxNameEl, weather?.name ?? '');
      setText(tempEl, `${temp}°C`);
      weatherWrap.className = `chip-weather wx-${clock.weather}`;
      weatherWrap.title = weather?.hint ?? '';
    }

    const money = Math.round(state.finance.treasury);
    if (money !== lastMoney) {
      lastMoney = money;
      setText(moneyEl, formatMoney(state.finance.treasury));
      setClass(moneyPill, 'negative', state.finance.treasury < 0);
    }

    const pop = state.stats.population;
    if (pop !== lastPop) {
      lastPop = pop;
      setText(popEl, num(pop));
    }

    const happy = Math.round(state.stats.happiness);
    const tone = happinessTone(happy);
    if (happy !== lastHappy || tone !== lastTone) {
      lastHappy = happy;
      lastTone = tone;
      setText(happyEl, String(happy));
      setClass(happyPill, 'good', tone === 'good');
      setClass(happyPill, 'bad', tone === 'bad');
      happyBar.style.width = `${Math.max(2, Math.min(100, happy))}%`;
    }

    const activeSpeed = clock.paused ? 0 : clock.speed;
    if (activeSpeed !== lastSpeed) {
      lastSpeed = activeSpeed;
      for (const btn of speedButtons) {
        setClass(btn, 'active', Number(btn.dataset.speed) === activeSpeed);
      }
    }
    if (clock.paused !== lastPaused) {
      lastPaused = clock.paused;
      setClass(root, 'is-paused', clock.paused);
      pauseFlag.classList.toggle('show', clock.paused);
    }
  };

  return {
    update,
    destroy(): void {
      offClick();
      root.remove();
    },
  };
}
