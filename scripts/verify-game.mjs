/**
 * 全流程驗收腳本（Lead／QA 用）
 *
 * 用 Playwright Chromium 載入遊戲，透過真實 actions 建村、快轉模擬、驗證
 * 人口／生產／物流／財政／天氣／室內／存檔，並在重點階段截圖。
 *
 * 用法：
 *   node scripts/verify-game.mjs [url]
 *
 * 截圖輸出：/tmp/huaxia-verify-*.png
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const shots = {
  city: '/tmp/huaxia-verify-01-city.png',
  village: '/tmp/huaxia-verify-02-village.png',
  night: '/tmp/huaxia-verify-03-night.png',
  weather: '/tmp/huaxia-verify-04-weather.png',
  interior: '/tmp/huaxia-verify-05-interior.png',
  finance: '/tmp/huaxia-verify-06-finance.png',
  savePanel: '/tmp/huaxia-verify-07-save.png',
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
let cdp;
const snap = async (path) => {
  if (!cdp) return;
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
};
page.on('console', (msg) => {
  if (msg.type() === 'error') logs.push(`[console.error] ${msg.text()}`);
});
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

const result = { ok: false, checks: {}, errors: logs, shots };

function check(name, value, detail) {
  result.checks[name] = { pass: Boolean(value), detail };
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__HUAXIA__), { timeout: 30000 });
  cdp = await page.context().newCDPSession(page);
  // 以固定 seed 開新局，確保驗收可重現（避免讀到上一次測試的存檔）
  await page.evaluate(() => {
    const { store, actions } = window.__HUAXIA__;
    actions.newGame(20261018);
    store.state.ui.showTutorial = false;
    store.bumpUI();
  });
  await page.waitForTimeout(3000);
  await snap(shots.city);

  // ── 1. 建立起始村落（透過真實 actions） ──
  const setup = await page.evaluate(() => {
    const { store, actions } = window.__HUAXIA__;
    const state = store.state;
    const idx = (x, y) => y * state.width + x;
    const W = state.width;
    const H = state.height;
    const buildableTerrains = new Set(['grass', 'fertile', 'sand', 'forest', 'hill']);
    const farmTerrains = new Set(['grass', 'fertile']);

    // 找 14x14 的可建地；農田 2x2 區塊需為 grass/fertile。優先選最靠近地圖中心的區塊。
    let base = null;
    let bestDist = Infinity;
    const cx = W / 2;
    const cy = H / 2;
    for (let y = 6; y + 14 < H - 6; y++) {
      for (let x = 6; x + 14 < W - 6; x++) {
        let ok = true;
        for (let dy = 0; dy < 14 && ok; dy++) {
          for (let dx = 0; dx < 14; dx++) {
            if (!buildableTerrains.has(state.tiles[(y + dy) * W + x + dx].terrain)) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) continue;
        let farmOk = true;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          if (!farmTerrains.has(state.tiles[(y + 1 + dy) * W + x + 8 + dx].terrain)) farmOk = false;
        }
        if (!farmOk) continue;
        const d = (x + 7 - cx) ** 2 + (y + 7 - cy) ** 2;
        if (d < bestDist) { bestDist = d; base = { x, y }; }
      }
    }
    if (!base) return { error: '找不到 14x14 平地' };
    const bx = base.x;
    const by = base.y;
    const roadTiles = [];
    for (let x = bx; x <= bx + 11; x++) roadTiles.push([x, by + 3]);
    for (let y = by; y <= by + 10; y++) roadTiles.push([bx + 6, y]);

    const placeAt = (tool, x, y) => {
      actions.setTool(tool);
      actions.applyToolAt(idx(x, y));
    };
    for (const [x, y] of roadTiles) placeAt('road', x, y);
    const roadsBuilt = state.tiles.filter((t) => t.road).length;

    const huts = [
      [bx + 1, by + 2],
      [bx + 2, by + 2],
      [bx + 3, by + 2],
      [bx + 4, by + 2],
      [bx + 1, by + 4],
      [bx + 2, by + 4],
      [bx + 3, by + 4],
      [bx + 4, by + 4],
    ];
    for (const [x, y] of huts) placeAt('hut', x, y);
    placeAt('farm', bx + 8, by + 1);
    placeAt('well', bx + 5, by + 2);

    actions.setTool(null);
    window.__TEST_BASE__ = { bx, by };
    return {
      base: { bx, by },
      roadsBuilt,
      buildings: state.buildings.length,
      treasury: Math.round(state.finance.treasury),
      huts: state.buildings.filter((b) => b.key === 'hut').length,
      farm: state.buildings.filter((b) => b.key === 'farm').length,
    };
  });
  check('初始村落建造', !setup.error && setup.buildings >= 10, setup);
  await page.waitForTimeout(3200);
  await snap(shots.village);

  // ── 2. 快轉 12 天，等待移民遷入 ──
  const ff = await page.evaluate((days) => {
    const { store, simulation, ctx, actions } = window.__HUAXIA__;
    actions.setSpeed(3);
    const state = store.state;
    state.clock.paused = false;
    for (let i = 0; i < days; i++) simulation.update(state, 10, ctx); // 10s * 48 * 3 = 1440 遊戲分鐘
    return {
      day: state.clock.totalDays,
      month: state.clock.month,
      season: state.clock.season,
      population: state.stats.population,
      citizens: state.citizens.length,
      housed: state.buildings.reduce((n, b) => n + b.residents.length, 0),
      happiness: Math.round(state.stats.happiness),
      treasury: Math.round(state.finance.treasury),
    };
  }, 12);
  check('移民遷入', ff.population > 0, ff);
  check('居民入住', ff.housed > 0, ff);

  // ── 3. 人口達標後補建市集、糧倉 ──
  const services = await page.evaluate(() => {
    const { store, actions } = window.__HUAXIA__;
    const state = store.state;
    const idx = (x, y) => y * state.width + x;
    const t = window.__TEST_BASE__;
    if (!t) return { error: '缺少基地座標' };
    const bx = t.bx;
    const by = t.by;
    const targets = [
      ['market', bx + 8, by + 4],
      ['granary', bx + 7, by + 7],
    ];
    const placed = [];
    for (const [key, x, y] of targets) {
      const before = state.buildings.length;
      actions.setTool(key);
      actions.applyToolAt(idx(x, y));
      if (state.buildings.length > before) placed.push(key);
    }
    actions.setTool(null);
    return { placed, buildings: state.buildings.length, population: state.stats.population };
  });
  check('市集與糧倉建造', (services.placed?.length ?? 0) >= 1, services);

  // ── 4. 再快轉 20 天，檢查生產／物流／財政 ──
  const sim2 = await page.evaluate((days) => {
    const { store, simulation, ctx } = window.__HUAXIA__;
    const state = store.state;
    state.clock.paused = false;
    for (let i = 0; i < days; i++) simulation.update(state, 10, ctx);
    const farm = state.buildings.filter((b) => b.key === 'farm');
    const market = state.buildings.filter((b) => b.key === 'market');
    const granary = state.buildings.filter((b) => b.key === 'granary');
    const sum = (arr, fn) => arr.reduce((n, b) => n + fn(b), 0);
    return {
      day: state.clock.totalDays,
      month: state.clock.month,
      population: state.stats.population,
      employed: state.citizens.filter((c) => c.workId >= 0).length,
      walking: state.citizens.filter((c) => c.state === 'walking').length,
      happiness: Math.round(state.stats.happiness),
      treasury: Math.round(state.finance.treasury),
      historyMonths: state.finance.history.length,
      lastIncome: Math.round(state.finance.lastMonthIncome),
      lastExpense: Math.round(state.finance.lastMonthExpense),
      farmGrain: Math.round(sum(farm, (b) => b.inventory.grain ?? 0)),
      granaryGrain: Math.round(sum(granary, (b) => b.inventory.grain ?? 0)),
      marketGrain: Math.round(sum(market, (b) => b.inventory.grain ?? 0)),
      carts: state.carts.length,
      goodsInTransit: Math.round(state.stats.goodsInTransit),
      connectedBuildings: state.buildings.filter((b) => b.connected).length,
      farmActive: farm.map((b) => ({ connected: b.connected, workers: b.workers.length, progress: Number(b.productionProgress.toFixed(2)) })),
      log: state.log.slice(-5).map((l) => l.text),
    };
  }, 20);
  check('生產運作（農田有糧）', sim2.farmGrain > 0, { farmGrain: sim2.farmGrain });
  check('倉儲物流（糧倉或市集有糧）', sim2.granaryGrain > 0 || sim2.marketGrain > 0, {
    granaryGrain: sim2.granaryGrain,
    marketGrain: sim2.marketGrain,
    carts: sim2.carts,
  });
  check('就業分配', sim2.employed > 0, { employed: sim2.employed, population: sim2.population });
  check('市民走動', sim2.walking > 0, { walking: sim2.walking });
  check('月結算財政', sim2.historyMonths > 0, { months: sim2.historyMonths, income: sim2.lastIncome, expense: sim2.lastExpense });
  await page.waitForTimeout(3200);
  await snap(shots.village);

  // ── 5. 夜晚與惡劣天氣視覺 ──
  const weather = await page.evaluate(() => {
    const { store } = window.__HUAXIA__;
    const state = store.state;
    const dayStart = Math.floor(state.clock.minutes / 1440) * 1440;
    state.clock.minutes = dayStart + 21 * 60 + 30; // 夜晚 21:30
    state.clock.weather = 'rain';
    state.clock.weatherMinutesLeft = 300;
    state.clock.paused = false;
    return { hour: state.clock.hour, weather: state.clock.weather };
  });
  await page.waitForTimeout(3500);
  await snap(shots.night);
  await snap(shots.weather);
  check('夜晚與雨天', weather.weather === 'rain', weather);

  // ── 5b. 冬季雪景 ──
  const winter = await page.evaluate(async () => {
    const { deriveClockFields } = await import('/src/core/new-game.ts');
    const { store } = window.__HUAXIA__;
    const state = store.state;
    const winterDay = (10 - 1) * 7 + 1; // 10 月 1 日 = 冬季
    state.clock.minutes = (winterDay - 1) * 1440 + 13 * 60;
    deriveClockFields(state.clock); // 立刻更新 month/season/day/hour
    state.clock.weather = 'snow';
    state.clock.tempC = -2;
    state.clock.weatherIntensity = 1;
    state.clock.weatherMinutesLeft = 100000;
    state.clock.paused = true; // 暫停時間，讓雪景保持到截圖
    state.clock.speed = 0;
    return { month: state.clock.month, season: state.clock.season, weather: state.clock.weather };
  });
  await page.waitForTimeout(4500);
  await snap('/tmp/huaxia-verify-08-winter.png');
  await page.evaluate(() => {
    const { actions } = window.__HUAXIA__;
    actions.setSpeed(1);
  });
  const winterNow = await page.evaluate(() => {
    const c = window.__HUAXIA__.store.state.clock;
    return { month: c.month, season: c.season, weather: c.weather, temp: Math.round(c.tempC) };
  });
  check('冬季雪景', winterNow.season === 'winter' && winterNow.weather === 'snow', winterNow);

  // ── 6. 進入建築物 ──
  const interior = await page.evaluate(() => {
    const { store, actions } = window.__HUAXIA__;
    const state = store.state;
    const building = state.buildings.find((b) => b.key === 'hut') ?? state.buildings[0];
    if (!building) return { error: '沒有可進入的建築' };
    actions.enterBuilding(building.id);
    return {
      mode: state.ui.mode,
      interiorId: state.ui.interiorId,
      buildingKey: building.key,
      buildingName: building.key,
    };
  });
  await page.waitForTimeout(3500);
  await snap(shots.interior);
  check('進入建築室內', interior.mode === 'interior', interior);
  await page.evaluate(() => window.__HUAXIA__.actions.exitInterior());
  await page.waitForTimeout(400);

  // ── 7. 財政面板 ──
  await page.evaluate(() => window.__HUAXIA__.actions.toggleFinance());
  await page.waitForTimeout(2800);
  await snap(shots.finance);
  const financeOpen = await page.evaluate(() => window.__HUAXIA__.store.state.ui.showFinance);
  check('財政面板', financeOpen === true, { financeOpen });
  await page.evaluate(() => window.__HUAXIA__.actions.closeOverlays());
  await page.waitForTimeout(300);

  // ── 8. 存檔／讀檔 ──
  const saveTest = await page.evaluate(async () => {
    const { store, actions } = window.__HUAXIA__;
    const state = store.state;
    const before = {
      buildings: state.buildings.length,
      citizens: state.citizens.length,
      day: state.clock.totalDays,
      treasury: Math.round(state.finance.treasury),
    };
    const ok = actions.saveGame(1);
    const slots = actions.getSaves();
    // 破壞當前狀態再讀檔
    const idx = 0;
    actions.setTool('road');
    actions.applyToolAt(idx);
    actions.setTool(null);
    const dirty = store.state.buildings.length;
    const loaded = actions.loadGame(1);
    const after = {
      buildings: store.state.buildings.length,
      citizens: store.state.citizens.length,
      day: store.state.clock.totalDays,
      treasury: Math.round(store.state.finance.treasury),
    };
    return { ok, loaded, before, dirty, after, slot1: slots[1] };
  });
  check('存檔成功', saveTest.ok === true, saveTest);
  check('讀檔還原', saveTest.loaded && saveTest.after.buildings === saveTest.before.buildings, {
    before: saveTest.before,
    after: saveTest.after,
  });
  await page.evaluate(() => window.__HUAXIA__.actions.toggleSavePanel());
  await page.waitForTimeout(2800);
  await snap(shots.savePanel);
  const savePanelOpen = await page.evaluate(() => window.__HUAXIA__.store.state.ui.showSave);
  check('存檔面板', savePanelOpen === true, { savePanelOpen });

  // ── 8b. 手動存檔跨頁面重載持久化 ──
  await page.evaluate(() => {
    const { store, actions } = window.__HUAXIA__;
    store.state.ui.showSave = false;
    store.bumpUI();
    actions.saveGame(2);
    localStorage.setItem('huaxia-city.test.buildings', String(store.state.buildings.length));
    localStorage.setItem('huaxia-city.test.population', String(store.state.stats.population));
  });
  const beforeReload = await page.evaluate(() => ({
    buildings: Number(localStorage.getItem('huaxia-city.test.buildings')),
    population: Number(localStorage.getItem('huaxia-city.test.population')),
  }));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__HUAXIA__), { timeout: 60000 });
  await page.waitForTimeout(2500);
  const reloadTest = await page.evaluate((before) => {
    const { store, actions } = window.__HUAXIA__;
    const slots = actions.getSaves();
    const loaded = actions.loadGame(2);
    return {
      loaded,
      slot2: slots[2],
      buildings: store.state.buildings.length,
      population: store.state.stats.population,
      before,
      match: loaded && store.state.buildings.length === before.buildings && store.state.stats.population === before.population,
    };
  }, beforeReload);
  check('手動存檔跨重載持久化', reloadTest.match === true, reloadTest);
  cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => { const { store, actions } = window.__HUAXIA__; store.state.ui.showTutorial = false; store.bumpUI(); actions.setSpeed(1); });
  await page.waitForTimeout(1500);

  // ── 8c. 所有建築類型皆可進入室內 ──
  const allInteriors = await page.evaluate(async () => {
    const { BUILDINGS } = await import('/src/core/config.ts');
    const { store, actions } = window.__HUAXIA__;
    const st = store.state;
    const failed = [];
    const keys = Object.keys(BUILDINGS);
    for (const key of keys) {
      const id = st.nextBuildingId++;
      st.buildings.push({
        id, key, x: 2, y: 2, w: 1, h: 1, active: true, connected: true,
        workers: [], residents: [], inventory: {}, productionProgress: 0,
        level: 1, builtOnDay: 1, incomeThisMonth: 0, expenseThisMonth: 0,
      });
      try {
        actions.enterBuilding(id);
        const ok = st.ui.mode === 'interior' && st.ui.interiorId === id;
        if (!ok) failed.push({ key, reason: 'mode-not-interior' });
        actions.exitInterior();
      } catch (err) {
        failed.push({ key, reason: String(err) });
        try { actions.exitInterior(); } catch { /* ignore */ }
      }
      st.buildings = st.buildings.filter((b) => b.id !== id);
    }
    return { total: keys.length, failed };
  });
  check('所有建築皆可進入室內', allInteriors.failed.length === 0, allInteriors);

  // ── 9. 時間流逝檢查（真實 2 秒） ──
  const timeTest = await page.evaluate(async () => {
    const { store, actions } = window.__HUAXIA__;
    actions.closeOverlays();
    actions.setSpeed(1);
    const before = store.state.clock.minutes;
    await new Promise((r) => setTimeout(r, 2000));
    return { before, after: store.state.clock.minutes, advanced: store.state.clock.minutes > before };
  });
  check('遊戲時間流逝', timeTest.advanced, timeTest);

  const perf = await page.evaluate(() => {
    const v = window.__HUAXIA__?.view;
    if (!v) return { error: 'no view' };
    const info = v.renderer.info;
    let objects = 0;
    v.cityScene.traverse(() => objects++);
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      sceneObjects: objects,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      buildings: v.store?.state?.buildings?.length ?? window.__HUAXIA__.store.state.buildings.length,
    };
  });
  result.perf = perf;
  check('渲染負載合理', (perf.drawCalls ?? 0) > 0 && (perf.drawCalls ?? 0) < 600 && (perf.triangles ?? 0) < 3_000_000, perf);

  result.summary = sim2;
  result.errors = logs;
  result.ok = Object.values(result.checks).every((c) => c.pass) && logs.length === 0;
} catch (err) {
  result.error = String(err);
  result.errors = logs;
  await snap('/tmp/huaxia-verify-error.png').catch(() => {});
} finally {
  await browser.close();
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
