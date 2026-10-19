#!/usr/bin/env node
/**
 * UI 互動驗收（Lead／QA 用）：以真實滑鼠／鍵盤操作 DOM 與 canvas。
 *
 * 注意：無頭 SwiftShader 的 WebGL 幀率極低（<1 FPS），UI 由 rAF 驅動，
 * 因此本測試以「等待 DOM／狀態條件」而非固定延遲，避免誤判。
 *
 * 用法：node scripts/ui-click-test.mjs [url]
 */

import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const errors = [];
const checks = {};
const check = (name, pass, detail) => {
  checks[name] = { pass: Boolean(pass), detail };
};
const note = (name, detail) => {
  checks[name] = { pass: true, detail, info: true };
};

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const stateEval = (fn) => page.evaluate(fn);
const waitFor = async (fn, timeout = 25000) => {
  await page.waitForFunction(fn, { timeout });
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(() => Boolean(window.__HUAXIA__), 30000);
  await page.waitForTimeout(2500);

  // 固定 seed 開新局，避免舊存檔干擾
  await stateEval(() => {
    const { store, actions } = window.__HUAXIA__;
    actions.newGame(20261018);
    store.state.ui.showTutorial = false;
    store.bumpUI();
  });
  await waitFor(() => window.__HUAXIA__.store.state.buildings.length === 0);

  // 1. 新手引導已關閉（等待 DOM 上的引導視窗真正移除，避免後續點擊被遮擋）
  await waitFor(() => !document.querySelector('.modal-backdrop'), 30000);
  const tutorialClosed = await stateEval(() => !window.__HUAXIA__.store.state.ui.showTutorial);
  const tutorialDomClosed = await stateEval(() => document.querySelectorAll('.modal-backdrop').length === 0);
  check('關閉新手引導', tutorialClosed && tutorialDomClosed, { tutorialClosed, tutorialDomClosed });

  // 2. 選取茅屋工具（UI 列表會隨狀態重建，使用 DOM click 避免 actionability 競態）
  await page.evaluate(() => {
    const tab = document.querySelector('[data-act="category"][data-cat="residential"]');
    if (tab) tab.click();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const card = document.querySelector('[data-act="build"][data-key="hut"]');
    if (card) card.click();
  });
  await waitFor(() => window.__HUAXIA__.store.state.ui.tool === 'hut', 15000);
  const toolSelected = await stateEval(() => window.__HUAXIA__.store.state.ui.tool);
  check('選取建造工具', toolSelected === 'hut', { toolSelected });

  // 3. 點擊 3D 場景放置建築：把一格地圖座標投影到螢幕再點擊
  const target = await stateEval(() => {
    const { store, view } = window.__HUAXIA__;
    const st = store.state;
    const TILE = 2;
    const idxToScreen = (tx, ty) => {
      const wx = (tx + 0.5) * TILE - (st.width * TILE) / 2;
      const wz = (ty + 0.5) * TILE - (st.height * TILE) / 2;
      const v = view.cityCamera.position.clone();
      v.set(wx, 0.6, wz);
      v.project(view.cityCamera);
      return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
    };
    // 找畫面內、地圖中心附近的可建地
    for (let r = 0; r < 20; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = Math.floor(st.width / 2) + dx;
          const ty = Math.floor(st.height / 2) + dy;
          if (tx < 2 || ty < 2 || tx >= st.width - 2 || ty >= st.height - 2) continue;
          const tile = st.tiles[ty * st.width + tx];
          if (!['grass', 'fertile', 'sand', 'forest', 'hill'].includes(tile.terrain)) continue;
          if (tile.buildingId >= 0 || tile.road) continue;
          const p = idxToScreen(tx, ty);
          if (p.x > 40 && p.x < window.innerWidth - 40 && p.y > 80 && p.y < window.innerHeight - 40) {
            const el = document.elementFromPoint(p.x, p.y);
            if (el && el.tagName === 'CANVAS') {
              return { ...p, tile: ty * st.width + tx, tx, ty };
            }
          }
        }
      }
    }
    return null;
  });
  let placed = null;
  if (target) {
    await page.mouse.click(target.x, target.y);
    await waitFor(() => window.__HUAXIA__.store.state.buildings.length > 0, 15000);
    placed = await stateEval(() => {
      const st = window.__HUAXIA__.store.state;
      return { buildings: st.buildings.length, key: st.buildings[0]?.key, tile: st.buildings[0] ? st.buildings[0].x + ',' + st.buildings[0].y : null };
    });
  }
  check('點擊 3D 場景放置建築', Boolean(placed && placed.buildings > 0 && placed.key === 'hut'), { target, placed });

  // 4. 取消工具 → 雙擊建築進入室內
  await stateEval(() => window.__HUAXIA__.actions.setTool(null));
  await page.waitForTimeout(600);
  let dblclickMode = null;
  if (placed) {
    const pos = await stateEval(() => {
      const { store, view } = window.__HUAXIA__;
      const st = store.state;
      const b = st.buildings[0];
      const TILE = 2;
      const wx = (b.x + b.w / 2) * TILE - (st.width * TILE) / 2;
      const wz = (b.y + b.h / 2) * TILE - (st.height * TILE) / 2;
      const v = view.cityCamera.position.clone();
      v.set(wx, 0.8, wz);
      v.project(view.cityCamera);
      return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, id: b.id };
    });
    await page.mouse.dblclick(pos.x, pos.y);
    await waitFor(() => window.__HUAXIA__.store.state.ui.mode === 'interior', 20000);
    // 等待室內 DOM 面板內容出現
    await waitFor(() => Boolean(document.querySelector('.interior-layer') && document.querySelector('.interior-layer').textContent.trim().length > 10), 25000);
    dblclickMode = await stateEval(() => ({
      mode: window.__HUAXIA__.store.state.ui.mode,
      interiorId: window.__HUAXIA__.store.state.ui.interiorId,
      dom: document.querySelector('.interior-layer')?.textContent.trim().slice(0, 60),
    }));
  }
  check('雙擊進入建築室內', dblclickMode?.mode === 'interior' && dblclickMode?.dom, dblclickMode);

  // 5. UI「返回城市」按鈕
  const backCount = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.interior-layer button')];
    const btn = btns.find((b) => (b.textContent ?? '').includes('返回城市'));
    if (btn) btn.click();
    return btns.length;
  });
  await waitFor(() => window.__HUAXIA__.store.state.ui.mode === 'city', 20000);
  const backToCity = await stateEval(() => window.__HUAXIA__.store.state.ui.mode);
  check('室內返回城市', backCount > 0 && backToCity === 'city', { backCount, backToCity });

  // 6. 財政視窗＋稅率滑桿
  await page.evaluate(() => document.querySelector('[data-act="finance"]')?.click());
  await waitFor(() => window.__HUAXIA__.store.state.ui.showFinance === true, 15000);
  await waitFor(() => document.querySelectorAll('.modal-backdrop').length > 0, 25000);
  const financeOpen = await stateEval(() => ({
    show: window.__HUAXIA__.store.state.ui.showFinance,
    modal: document.querySelectorAll('.modal-backdrop').length,
    isFinance: Boolean(document.querySelector('.modal-finance')),
  }));
  let taxAfter = null;
  if (financeOpen.isFinance) {
    await page.evaluate(() => {
      const slider = document.querySelector('.modal-finance input[type="range"]');
      if (!slider) return;
      slider.value = '15';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => Math.abs(window.__HUAXIA__.store.state.finance.taxRate * 100 - 15) < 0.1, 15000);
    taxAfter = await stateEval(() => Number((window.__HUAXIA__.store.state.finance.taxRate * 100).toFixed(1)));
  }
  check('財政視窗與稅率滑桿', financeOpen.show && financeOpen.isFinance && taxAfter === 15, { ...financeOpen, taxAfter });
  await page.keyboard.press('Escape');
  await waitFor(() => document.querySelectorAll('.modal-backdrop').length === 0, 25000);

  // 7. 存檔視窗
  await page.evaluate(() => document.querySelector('[data-act="save"]')?.click());
  await waitFor(() => window.__HUAXIA__.store.state.ui.showSave === true, 15000);
  await waitFor(() => document.querySelectorAll('.modal-backdrop').length > 0, 25000);
  const saveOpen = await stateEval(() => ({
    show: window.__HUAXIA__.store.state.ui.showSave,
    isSave: Boolean(document.querySelector('.modal-save')),
    hasAuto: document.body.innerText.includes('自動存檔'),
  }));
  check('存檔視窗', saveOpen.show && saveOpen.isSave && saveOpen.hasAuto, saveOpen);
  await page.keyboard.press('Escape');
  await waitFor(() => document.querySelectorAll('.modal-backdrop').length === 0, 25000);

  // 8. 說明視窗（快捷鍵 H）
  await page.keyboard.press('h');
  await waitFor(() => window.__HUAXIA__.store.state.ui.showHelp === true, 15000);
  await waitFor(() => Boolean(document.querySelector('.modal-help')), 25000);
  const helpOpen = await stateEval(() => ({
    show: window.__HUAXIA__.store.state.ui.showHelp,
    isHelp: Boolean(document.querySelector('.modal-help')),
  }));
  check('說明視窗快捷鍵 H', helpOpen.show && helpOpen.isHelp, helpOpen);
  await page.keyboard.press('Escape');
  await waitFor(() => window.__HUAXIA__.store.state.ui.showHelp === false, 20000);

  // 9. 空白鍵暫停／繼續
  await page.keyboard.press('Space');
  await waitFor(() => window.__HUAXIA__.store.state.clock.paused === true, 15000);
  const paused = await stateEval(() => window.__HUAXIA__.store.state.clock.paused);
  await page.keyboard.press('Space');
  await waitFor(() => window.__HUAXIA__.store.state.clock.paused === false, 15000);
  check('空白鍵暫停／繼續', paused === true, { paused });

  // 10. 數字鍵 3 倍速
  await page.keyboard.press('3');
  await waitFor(() => window.__HUAXIA__.store.state.clock.speed === 3, 15000);
  const speed = await stateEval(() => window.__HUAXIA__.store.state.clock.speed);
  check('數字鍵 3 倍速', speed === 3, { speed });

  note('備註：無頭 SwiftShader 幀率', { note: '軟體 WebGL 幀率極低，UI 更新以條件等待驗證；真實 GPU 不受影響' });
} catch (err) {
  checks['例外'] = { pass: false, detail: String(err) };
  errors.push(String(err));
} finally {
  await browser.close();
}

const ok = Object.values(checks).every((c) => c.pass) && errors.length === 0;
console.log(JSON.stringify({ ok, checks, errors }, null, 2));
if (!ok) process.exitCode = 1;
