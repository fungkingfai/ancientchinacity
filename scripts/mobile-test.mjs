/**
 * 手機版 UI 驗收（Playwright iPhone 模擬）
 *
 * 驗證：
 *  1. 手機裝置自動偵測 → 手機版 UI（html[data-ui-mode=mobile]、底部導覽、精簡頂欄）
 *  2. 底部「營造」面板開關、選擇工具後自動收起
 *  3. 觸控點擊地圖放置建築
 *  4. 點選建築 → 城事面板自動打開；雙擊（或面板按鈕）進入室內；返回城市
 *  5. 單指拖曳平移、雙指捏合縮放相機（不誤放建築）
 *  6. 底部導覽開財政／存檔／說明
 *  7. 桌面環境仍使用原本電腦版 UI（無手機導覽）
 *  8. 產出手機截圖到 docs/screenshots/
 *
 * 用法：node scripts/mobile-test.mjs [url]
 */

import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const outDir = 'docs/screenshots';
fs.mkdirSync(outDir, { recursive: true });

const checks = {};
const errors = [];
const check = (name, pass, detail) => {
  checks[name] = { pass: Boolean(pass), detail };
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

const context = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1, locale: 'zh-TW' });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

const wait = (ms) => page.waitForTimeout(ms);
const waitFn = (fn, timeout = 30000) => page.waitForFunction(fn, { timeout });
const ev = (fn, arg) => page.evaluate(fn, arg);

let cdp;
const snap = async (name, waitMs = 3200) => {
  if (!cdp) cdp = await context.newCDPSession(page);
  await wait(waitMs);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64'));
  process.stderr.write(`saved ${outDir}/${name}.png\n`);
};
const noTransitions = () =>
  page.addStyleTag({
    content: '*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;}',
  });

try {
  // ── 0. 載入與自動偵測 ──
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFn(() => Boolean(window.__HUAXIA__), 40000);
  await noTransitions();
  await wait(2500);

  const detect = await ev(() => ({
    uiMode: document.documentElement.dataset.uiMode,
    htmlClass: document.documentElement.className,
    hudClass: document.querySelector('.hud')?.className,
    mobileNav: document.querySelectorAll('.mobile-nav-btn').length,
    desktopActionsVisible: (() => {
      const el = document.querySelector('.tb-actions');
      return el ? getComputedStyle(el).display !== 'none' : false;
    })(),
    weatherVisible: (() => {
      const el = document.querySelector('.chip-weather');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return getComputedStyle(el).display !== 'none' && r.width > 0;
    })(),
    navLabels: [...document.querySelectorAll('.mobile-nav-btn span')].map((e) => e.textContent?.trim()),
  }));
  check(
    '手機自動偵測與手機版 UI',
    detect.uiMode === 'mobile' && detect.hudClass.includes('is-mobile-ui') && detect.mobileNav === 6 && !detect.desktopActionsVisible,
    detect,
  );
  check('手機頂欄顯示天氣', detect.weatherVisible, detect);

  // 關閉新手引導
  if (await page.locator('.modal-close').count()) {
    await page.locator('.modal-close').first().tap();
    await waitFn(() => !document.querySelector('.modal-backdrop'), 30000);
  }

  // ── 1. 營造面板開關 ──
  await page.locator('[data-m-act="build"]').tap();
  await waitFn(() => document.querySelector('.hud')?.classList.contains('is-build-open'), 20000);
  const buildOpen = await ev(() => ({
    open: document.querySelector('.hud')?.classList.contains('is-build-open'),
    transform: getComputedStyle(document.querySelector('.build-panel')).transform,
    backdrop: !document.querySelector('.mobile-sheet-backdrop')?.hasAttribute('hidden'),
    cards: document.querySelectorAll('.build-card').length,
  }));
  check('底部營造面板開啟', buildOpen.open && buildOpen.backdrop && buildOpen.cards > 0, buildOpen);

  // ── 2. 選擇茅屋工具 → 面板自動收起 ──
  await page.locator('[data-act="build"][data-key="hut"]').first().tap();
  await waitFn(() => window.__HUAXIA__.store.state.ui.tool === 'hut', 20000);
  await waitFn(() => !document.querySelector('.hud')?.classList.contains('is-build-open'), 25000);
  const toolState = await ev(() => ({
    tool: window.__HUAXIA__.store.state.ui.tool,
    sheetOpen: document.querySelector('.hud')?.classList.contains('is-build-open'),
    hint: document.querySelector('.mode-hint')?.classList.contains('show'),
  }));
  check('選取工具後自動收起面板', toolState.tool === 'hut' && !toolState.sheetOpen, toolState);

  // ── 3. 觸控點擊地圖放置建築 ──
  const target = await ev(() => {
    const { store, view } = window.__HUAXIA__;
    const st = store.state;
    const TILE = 2;
    const toScreen = (tx, ty) => {
      const wx = (tx + 0.5) * TILE - (st.width * TILE) / 2;
      const wz = (ty + 0.5) * TILE - (st.height * TILE) / 2;
      const v = view.cityCamera.position.clone();
      v.set(wx, 0.8, wz);
      v.project(view.cityCamera);
      return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
    };
    const top = 70;
    const bottom = window.innerHeight - 90;
    for (let r = 0; r < 24; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = Math.floor(st.width / 2) + dx;
          const ty = Math.floor(st.height / 2) + dy;
          if (tx < 2 || ty < 2 || tx >= st.width - 2 || ty >= st.height - 2) continue;
          const tile = st.tiles[ty * st.width + tx];
          if (!['grass', 'fertile', 'sand', 'forest', 'hill'].includes(tile.terrain)) continue;
          if (tile.buildingId >= 0 || tile.road) continue;
          const p = toScreen(tx, ty);
          if (p.x < 24 || p.x > window.innerWidth - 24 || p.y < top || p.y > bottom) continue;
          const el = document.elementFromPoint(p.x, p.y);
          if (el && el.tagName === 'CANVAS') return { ...p, tx, ty };
        }
      }
    }
    return null;
  });
  if (target) {
    await page.touchscreen.tap(target.x, target.y);
    await waitFn(() => window.__HUAXIA__.store.state.buildings.length > 0, 25000);
  }
  const placed = await ev(() => {
    const st = window.__HUAXIA__.store.state;
    return { buildings: st.buildings.length, key: st.buildings[0]?.key, x: st.buildings[0]?.x, y: st.buildings[0]?.y };
  });
  check('觸控點擊放置建築', Boolean(target) && placed.buildings > 0 && placed.key === 'hut', { target, placed });

  // ── 4. 點選建築 → 城事面板自動打開 ──
  await ev(() => window.__HUAXIA__.actions.setTool(null));
  await wait(600);
  const buildingPos = await ev(() => {
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
  await page.touchscreen.tap(buildingPos.x, buildingPos.y);
  await waitFn(() => window.__HUAXIA__.store.state.ui.selectedId != null, 25000);
  await waitFn(() => document.querySelector('.hud')?.classList.contains('is-info-open'), 30000);
  const infoState = await ev(() => ({
    selectedId: window.__HUAXIA__.store.state.ui.selectedId,
    open: document.querySelector('.hud')?.classList.contains('is-info-open'),
    hasEnter: !!document.querySelector('[data-act="enter"]'),
  }));
  check('點選建築自動打開城事面板', infoState.selectedId != null && infoState.open && infoState.hasEnter, infoState);
  await snap('mobile-info', 2200);

  // ── 5. 進入室內（優先測試雙擊手勢，失敗則用面板按鈕） ──
  // 先收起面板再雙擊
  await page.locator('#info-panel .mobile-sheet-close').first().tap();
  await waitFn(() => !document.querySelector('.hud')?.classList.contains('is-info-open'), 25000);
  await wait(600);
  await page.touchscreen.tap(buildingPos.x, buildingPos.y);
  await page.touchscreen.tap(buildingPos.x, buildingPos.y);
  let enteredByDoubleTap = false;
  try {
    await waitFn(() => window.__HUAXIA__.store.state.ui.mode === 'interior', 12000);
    enteredByDoubleTap = true;
  } catch {
    // fallback：打開城事面板，按「進入建築」
    await waitFn(() => document.querySelector('.hud')?.classList.contains('is-info-open'), 30000);
    await page.locator('[data-act="enter"]').first().tap();
    await waitFn(() => window.__HUAXIA__.store.state.ui.mode === 'interior', 25000);
  }
  await waitFn(
    () => Boolean(document.querySelector('.interior-layer.show') && document.querySelector('.interior-layer').textContent.trim().length > 10),
    30000,
  );
  const interiorState = await ev(() => ({
    mode: window.__HUAXIA__.store.state.ui.mode,
    uiLayer: !!document.querySelector('.interior-layer.show'),
    navHidden: getComputedStyle(document.querySelector('.mobile-nav')).display === 'none',
  }));
  check('進入建築室內', interiorState.mode === 'interior' && interiorState.uiLayer, {
    ...interiorState,
    enteredByDoubleTap,
  });
  await snap('mobile-interior', 2400);

  // 返回城市
  await page.locator('[data-act="exit-interior"]').first().tap();
  await waitFn(() => window.__HUAXIA__.store.state.ui.mode === 'city', 25000);
  await waitFn(() => getComputedStyle(document.querySelector('.mobile-nav')).display !== 'none', 30000);
  const backCity = await ev(() => ({
    mode: window.__HUAXIA__.store.state.ui.mode,
    navVisible: getComputedStyle(document.querySelector('.mobile-nav')).display !== 'none',
  }));
  check('室內返回城市', backCity.mode === 'city' && backCity.navVisible, backCity);

  // ── 6. 觸控手勢：單指平移、雙指縮放 ──
  if (!cdp) cdp = await context.newCDPSession(page);
  await ev(() => window.__HUAXIA__.actions.closeOverlays());
  await wait(600);
  const camBefore = await ev(() => ({
    x: window.__HUAXIA__.view.target.x,
    z: window.__HUAXIA__.view.target.z,
    distance: window.__HUAXIA__.view.distance,
    buildings: window.__HUAXIA__.store.state.buildings.length,
  }));
  // 單指拖曳（避開頂欄與底部導覽）
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 250, y: 300, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
  });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 250 - i * 12, y: 300 + i * 5, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(1800);
  const camAfterPan = await ev(() => ({
    x: window.__HUAXIA__.view.target.x,
    z: window.__HUAXIA__.view.target.z,
    buildings: window.__HUAXIA__.store.state.buildings.length,
  }));
  const panMoved = Math.hypot(camAfterPan.x - camBefore.x, camAfterPan.z - camBefore.z) > 0.2;
  check('單指拖曳平移視角（不誤放建築）', panMoved && camAfterPan.buildings === camBefore.buildings, {
    before: camBefore,
    after: camAfterPan,
  });

  // 雙指捏合縮放
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 140, y: 300, id: 1, radiusX: 2, radiusY: 2, force: 1 },
      { x: 250, y: 300, id: 2, radiusX: 2, radiusY: 2, force: 1 },
    ],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: 140 - i * 6, y: 300, id: 1, radiusX: 2, radiusY: 2, force: 1 },
        { x: 250 + i * 6, y: 300, id: 2, radiusX: 2, radiusY: 2, force: 1 },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(1800);
  const camAfterPinch = await ev(() => window.__HUAXIA__.view.distance);
  check('雙指捏合縮放視角', camAfterPinch < camBefore.distance - 1, {
    before: camBefore.distance,
    after: camAfterPinch,
  });

  // ── 7. 底部導覽：財政 ──
  await page.locator('[data-m-act="finance"]').tap();
  await waitFn(() => window.__HUAXIA__.store.state.ui.showFinance === true, 25000);
  await waitFn(() => document.querySelectorAll('.modal-backdrop').length > 0, 30000);
  const financeState = await ev(() => ({
    show: window.__HUAXIA__.store.state.ui.showFinance,
    modal: !!document.querySelector('.modal-finance'),
  }));
  check('底部導覽開啟財政', financeState.show && financeState.modal, financeState);
  await ev(() => window.__HUAXIA__.actions.closeOverlays());
  await wait(800);

  // ── 8. 建立示範村落並截圖 ──
  await ev(async () => {
    const { deriveClockFields } = await import('/src/core/new-game.ts');
    const { store, actions, simulation, ctx, view } = window.__HUAXIA__;
    actions.newGame(20261018);
    const st = store.state;
    st.ui.showTutorial = false;
    store.bumpUI();
    const W = st.width;
    const idx = (x, y) => y * W + x;
    const buildable = new Set(['grass', 'fertile', 'sand', 'forest', 'hill']);
    const farmable = new Set(['grass', 'fertile']);
    let base = null;
    let best = Infinity;
    for (let y = 12; y + 18 < st.height - 12; y++) {
      for (let x = 12; x + 18 < W - 12; x++) {
        let ok = true;
        for (let dy = 0; dy < 16 && ok; dy++) for (let dx = 0; dx < 16; dx++) {
          if (!buildable.has(st.tiles[(y + dy) * W + x + dx].terrain)) { ok = false; break; }
        }
        if (!ok) continue;
        let farmOk = true;
        for (const [fx, fy] of [[x + 1, y + 3], [x + 10, y + 3]]) {
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            if (!farmable.has(st.tiles[(fy + dy) * W + fx + dx].terrain)) farmOk = false;
          }
        }
        if (!farmOk) continue;
        const d = (x + 8 - W / 2) ** 2 + (y + 8 - st.height / 2) ** 2;
        if (d < best) { best = d; base = { x, y }; }
      }
    }
    if (!base) return;
    const bx = base.x;
    const by = base.y;
    const place = (tool, x, y) => { actions.setTool(tool); const b = st.buildings.length; actions.applyToolAt(idx(x, y)); return st.buildings.length > b; };
    const ff = (days) => { st.clock.paused = false; st.clock.speed = 3; st.ui.speed = 3; for (let i = 0; i < days; i++) simulation.update(st, 10, ctx); st.clock.speed = 1; st.ui.speed = 1; };
    actions.setTool('road');
    for (let x = bx + 1; x <= bx + 14; x++) actions.applyToolAt(idx(x, by + 5));
    for (let y = bx ? by + 1 : by + 1; y <= by + 13; y++) actions.applyToolAt(idx(bx + 8, y));
    // 茅屋全部臨路，人口才會成長
    const huts = [[4, 4], [5, 4], [6, 4], [13, 4], [1, 6], [2, 6], [3, 6], [10, 6], [11, 6], [12, 6], [7, 9], [9, 9]];
    for (const [dx, dy] of huts) place('hut', bx + dx, by + dy);
    place('farm', bx + 1, by + 3);
    place('farm', bx + 10, by + 3);
    place('well', bx + 14, by + 6);
    ff(22);
    // 展示用：暫時提高人口解鎖公共建築（只影響截圖，不影響遊戲邏輯）
    st.stats.population = Math.max(st.stats.population, 60);
    place('market', bx + 6, by + 8);
    place('granary', bx + 9, by + 8);
    place('teahouse', bx + 13, by + 6);
    place('warehouse', bx + 4, by + 6);
    ff(8);
    // 晴朗上午 + 鏡頭對準村落
    const heroDay = (5 - 1) * 7 + 2;
    st.clock.minutes = (heroDay - 1) * 1440 + 9 * 60 + 30;
    deriveClockFields(st.clock);
    st.clock.weather = 'clear';
    st.clock.weatherIntensity = 0;
    st.clock.weatherMinutesLeft = 100000;
    st.clock.paused = false;
    actions.setSpeed(1);
    actions.setTool(null);
    actions.selectBuilding(null);
    const TILE = 2;
    view.target.set((bx + 7.5) * TILE - (st.width * TILE) / 2, 0, (by + 6) * TILE - (st.height * TILE) / 2);
    view.distance = 44;
    view.pitch = 0.94;
    view.yaw = -0.72;
    document.querySelectorAll('.toast').forEach((n) => n.remove());
  });
  await wait(3000);
  await ev(() => window.__HUAXIA__.ui.update(window.__HUAXIA__.store.state));
  await snap('mobile-city', 3200);

  // 營造面板截圖
  await page.locator('[data-m-act="build"]').tap();
  await waitFn(() => document.querySelector('.hud')?.classList.contains('is-build-open'), 25000);
  await ev(() => window.__HUAXIA__.ui.update(window.__HUAXIA__.store.state));
  await snap('mobile-build', 2400);
  // 選擇市集分類到商業，展示不同卡片
  await ev(() => { window.__HUAXIA__.store.state.ui.buildCategory = 'commerce'; window.__HUAXIA__.store.bumpUI(); });
  await wait(800);
  await page.locator('#build-panel .mobile-sheet-close').first().tap();

  // 城事面板截圖（選取市集）
  await ev(() => {
    const { store, actions } = window.__HUAXIA__;
    const st = store.state;
    const pick =
      st.buildings.find((b) => b.key === 'market') ??
      st.buildings.find((b) => b.key === 'teahouse') ??
      st.buildings.find((b) => b.key === 'granary') ??
      st.buildings.find((b) => b.key === 'hut');
    if (pick) actions.select((pick.y + pick.h - 1) * st.width + pick.x);
    window.__HUAXIA__.ui.update(st);
  });
  await waitFn(() => document.querySelector('.hud')?.classList.contains('is-info-open'), 25000);
  await snap('mobile-info', 2400);
  await page.locator('#info-panel .mobile-sheet-close').first().tap();

  // 室內截圖
  await ev(() => {
    const { store, actions } = window.__HUAXIA__;
    const st = store.state;
    const m =
      st.buildings.find((b) => b.key === 'market') ??
      st.buildings.find((b) => b.key === 'teahouse') ??
      st.buildings.find((b) => b.key === 'granary') ??
      st.buildings[0];
    if (m) actions.enterBuilding(m.id);
  });
  await waitFn(() => window.__HUAXIA__.store.state.ui.mode === 'interior', 25000);
  await waitFn(() => Boolean(document.querySelector('.interior-layer.show')), 30000);
  await ev(() => window.__HUAXIA__.ui.update(window.__HUAXIA__.store.state));
  await snap('mobile-interior', 2600);
  await ev(() => window.__HUAXIA__.actions.exitInterior());
  await wait(1200);

  // 橫向手機截圖
  await page.setViewportSize({ width: 844, height: 390 });
  await wait(2500);
  await ev(() => window.__HUAXIA__.ui.update(window.__HUAXIA__.store.state));
  await snap('mobile-landscape', 3000);

  check('手機版截圖與流程完成', errors.length === 0, { errorsCount: errors.length });
} catch (err) {
  checks['例外'] = { pass: false, detail: String(err) };
  errors.push(String(err));
}

// ── 9. 桌面版不受影響（先關掉手機頁面釋放 WebGL context） ──
await context.close();
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const dpage = await desktop.newPage();
  await dpage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await dpage.waitForFunction(() => Boolean(window.__HUAXIA__), { timeout: 40000 });
  await dpage.waitForTimeout(2500);
  const desktopState = await dpage.evaluate(() => ({
    uiMode: document.documentElement.dataset.uiMode,
    hudClass: document.querySelector('.hud')?.className,
    mobileNav: !!document.querySelector('.mobile-nav'),
    desktopActions: (() => {
      const el = document.querySelector('.tb-actions');
      return el ? getComputedStyle(el).display !== 'none' : false;
    })(),
    buildPanelVisible: (() => {
      const el = document.querySelector('.build-panel');
      const r = el?.getBoundingClientRect();
      return !!r && r.width > 100 && getComputedStyle(el).pointerEvents !== 'none';
    })(),
  }));
  check(
    '桌面版維持原本介面',
    desktopState.uiMode === 'desktop' &&
      desktopState.hudClass.includes('is-desktop-ui') &&
      !desktopState.mobileNav &&
      desktopState.desktopActions &&
      desktopState.buildPanelVisible,
    desktopState,
  );
  await dpage.screenshot({ path: '/tmp/huaxia-desktop-check.png' }).catch(() => {});
  await desktop.close();
} catch (err) {
  checks['桌面回歸'] = { pass: false, detail: String(err) };
  errors.push(`desktop: ${String(err)}`);
}

await browser.close();
const ok = Object.values(checks).every((c) => c.pass) && errors.length === 0;
console.log(JSON.stringify({ ok, checks, errors }, null, 2));
if (!ok) process.exitCode = 1;
