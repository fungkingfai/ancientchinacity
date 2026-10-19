/**
 * 展示截圖腳本：建立一座具規模的示範古城，拍下城市、夜晚、雪景、雨天、
 * 室內、財政、存檔等畫面，輸出到 docs/screenshots/。
 *
 * 用法：node scripts/capture-showcase.mjs [url]
 * 需要 dev server 運行。
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const outDir = process.argv[3] ?? 'docs/screenshots';
fs.mkdirSync(outDir, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

let session;
const snap = async (name) => {
  if (!session) session = await page.context().newCDPSession(page);
  // 強制同步 UI 一次，避免無頭軟體渲染幀率過低造成 UI 尚未更新
  await page
    .evaluate(() => {
      const h = window.__HUAXIA__;
      if (h?.ui) h.ui.update(h.store.state);
    })
    .catch(() => {});
  await page.waitForTimeout(3600);
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64'));
  console.log('saved', `${outDir}/${name}.png`);
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__HUAXIA__), { timeout: 30000 });
  await page.waitForTimeout(2400);
  session = await page.context().newCDPSession(page);
  await page.addStyleTag({
    content: '*, *::before, *::after { transition-duration: 0.001s !important; animation-duration: 0.001s !important; animation-delay: 0s !important; }',
  });

  const built = await page.evaluate(() => {
    const { store, actions, simulation, ctx } = window.__HUAXIA__;
    actions.newGame(20261018);
    const state = store.state;
    state.ui.showTutorial = false;
    store.bumpUI();

    const W = state.width;
    const H = state.height;
    const idx = (x, y) => y * W + x;
    const buildable = new Set(['grass', 'fertile', 'sand', 'forest', 'hill']);
    const farmable = new Set(['grass', 'fertile']);

    // 地圖中央附近的 18x18 可建平地
    let base = null;
    let best = Infinity;
    for (let y = 10; y + 20 < H - 10; y++) {
      for (let x = 10; x + 20 < W - 10; x++) {
        let ok = true;
        for (let dy = 0; dy < 18 && ok; dy++) {
          for (let dx = 0; dx < 18; dx++) {
            if (!buildable.has(state.tiles[(y + dy) * W + x + dx].terrain)) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) continue;
        let farmOk = true;
        const farmSpots = [
          [x + 1, y + 3],
          [x + 8, y + 3],
        ];
        for (const [fx, fy] of farmSpots) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              if (!farmable.has(state.tiles[(fy + dy) * W + fx + dx].terrain)) farmOk = false;
            }
          }
        }
        if (!farmOk) continue;
        const d = (x + 9 - W / 2) ** 2 + (y + 9 - H / 2) ** 2;
        if (d < best) {
          best = d;
          base = { x, y };
        }
      }
    }
    if (!base) return { error: 'no base' };
    const bx = base.x;
    const by = base.y;
    window.__SHOWCASE_BASE__ = { bx, by };

    const place = (tool, x, y) => {
      actions.setTool(tool);
      const before = state.buildings.length;
      actions.applyToolAt(idx(x, y));
      return state.buildings.length > before;
    };
    const ff = (days) => {
      // 以 3 倍速快轉：每次 update(10) = 10 * 48 * 3 = 1440 遊戲分鐘 = 1 日
      state.clock.paused = false;
      state.clock.speed = 3;
      state.ui.speed = 3;
      for (let i = 0; i < days; i++) simulation.update(state, 10, ctx);
      state.clock.speed = 1;
      state.ui.speed = 1;
    };

    // 道路網：兩橫兩縱
    actions.setTool('road');
    for (let x = bx + 1; x <= bx + 16; x++) {
      actions.applyToolAt(idx(x, by + 5));
      actions.applyToolAt(idx(x, by + 10));
    }
    for (let y = by + 1; y <= by + 15; y++) {
      actions.applyToolAt(idx(bx + 5, y));
      actions.applyToolAt(idx(bx + 12, y));
    }

    // 茅屋 16 間（全部臨路）
    const huts = [
      [3, 6], [4, 6], [6, 6], [8, 6], [10, 6], [11, 6],
      [3, 9], [4, 9], [6, 9], [11, 9],
      [3, 11], [4, 11], [6, 11], [11, 11],
      [4, 2], [6, 2],
    ];
    for (const [dx, dy] of huts) place('hut', bx + dx, by + dy);

    // 農田 ×2（臨路）
    place('farm', bx + 3, by + 3);
    place('farm', bx + 1, by + 8);

    // 人口成長 → 第一批公共建築
    ff(14);
    const wave1 = [
      ['market', 13, 3],
      ['granary', 15, 3],
      ['well', 1, 2],
      ['pavilion', 8, 12],
      ['farm', 8, 3],
      ['farm', 13, 6],
    ];
    for (const [key, dx, dy] of wave1) place(key, bx + dx, by + dy);

    // 第二批：住宅與服務
    ff(14);
    const wave2 = [
      ['house', 7, 4],
      ['house', 8, 4],
      ['house', 9, 4],
      ['house', 10, 4],
      ['temple', 7, 3],
      ['teahouse', 9, 3],
      ['warehouse', 7, 8],
      ['farm', 15, 6],
      ['farm', 13, 11],
    ];
    for (const [key, dx, dy] of wave2) place(key, bx + dx, by + dy);

    // 第三批：擴建與服務
    ff(14);
    const wave3 = [
      ['house', 8, 9],
      ['house', 9, 9],
      ['market', 13, 8],
      ['granary', 15, 8],
      ['teahouse', 10, 8],
      ['temple', 9, 8],
      ['farm', 15, 11],
      ['farm', 1, 11],
    ];
    for (const [key, dx, dy] of wave3) place(key, bx + dx, by + dy);

    ff(10);
    actions.setTool(null);

    return {
      base: { bx, by },
      buildings: state.buildings.length,
      population: state.stats.population,
      employed: state.stats.employed,
      carts: state.carts.length,
      treasury: Math.round(state.finance.treasury),
      month: state.clock.month,
      weather: state.clock.weather,
    };
  });

  console.log('built', JSON.stringify(built));
  if (built.error) throw new Error(built.error);

  // 設定為夏季晴朗上午，鏡頭拉近到村落
  const viewInfo = await page.evaluate(async () => {
    const { deriveClockFields } = await import('/src/core/new-game.ts');
    const { store, view, actions } = window.__HUAXIA__;
    const state = store.state;
    const TILE = 2;
    const base = window.__SHOWCASE_BASE__;
    const heroDay = (5 - 1) * 7 + 2; // 第 5 月第 2 日（夏季）
    state.clock.minutes = (heroDay - 1) * 1440 + 9 * 60 + 20;
    deriveClockFields(state.clock);
    state.clock.weather = 'clear';
    state.clock.weatherIntensity = 0;
    state.clock.weatherMinutesLeft = 100000;
    state.clock.paused = false;
    actions.setSpeed(1);
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const wx = (base.bx + 8.5) * TILE - (state.width * TILE) / 2;
    const wz = (base.by + 8.5) * TILE - (state.height * TILE) / 2;
    view.target.set(wx, 0, wz);
    view.distance = 40;
    view.pitch = 0.92;
    view.yaw = -0.72;
    return {
      hour: state.clock.hour,
      season: state.clock.season,
      weather: state.clock.weather,
      camera: { distance: view.distance, pitch: view.pitch, yaw: view.yaw },
    };
  });
  console.log('view', JSON.stringify(viewInfo));

  await snap('hero');
  await snap('city');

  // 財政面板
  await page.evaluate(() => window.__HUAXIA__.actions.toggleFinance());
  await snap('finance');
  await page.evaluate(() => window.__HUAXIA__.actions.closeOverlays());

  // 室內：優先寺廟 → 市集 → 糧倉 → 瓦房
  const interiorInfo = await page.evaluate(() => {
    const { store, actions } = window.__HUAXIA__;
    const state = store.state;
    const b =
      state.buildings.find((x) => x.key === 'temple') ??
      state.buildings.find((x) => x.key === 'market') ??
      state.buildings.find((x) => x.key === 'granary') ??
      state.buildings.find((x) => x.key === 'house') ??
      state.buildings.find((x) => x.key !== 'farm');
    if (!b) return { error: 'no building' };
    actions.enterBuilding(b.id);
    return { key: b.key, id: b.id };
  });
  console.log('interior', JSON.stringify(interiorInfo));
  // 等室內面板真正掛上 DOM（無頭軟體渲染下 rAF 很慢）
  await page
    .waitForFunction(
      () => {
        const layer = document.querySelector('.interior-layer');
        return Boolean(layer && layer.classList.contains('show') && layer.textContent.trim().length > 20);
      },
      { timeout: 40000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);
  await snap('interior');
  await page.evaluate(() => window.__HUAXIA__.actions.exitInterior());
  await page.waitForTimeout(1200);

  // 存檔面板
  await page.evaluate(() => window.__HUAXIA__.actions.toggleSavePanel());
  await snap('save');
  await page.evaluate(() => window.__HUAXIA__.actions.closeOverlays());
  await page.waitForTimeout(800);

  // 夜景
  await page.evaluate(async () => {
    const { deriveClockFields } = await import('/src/core/new-game.ts');
    const { store } = window.__HUAXIA__;
    const state = store.state;
    const heroDay = (5 - 1) * 7 + 2;
    state.clock.minutes = (heroDay - 1) * 1440 + 20 * 60 + 40;
    deriveClockFields(state.clock);
    state.clock.weather = 'clear';
    state.clock.weatherIntensity = 0;
    state.clock.weatherMinutesLeft = 100000;
    state.clock.paused = false;
  });
  await snap('night');

  // 冬雪
  await page.evaluate(async () => {
    const { deriveClockFields } = await import('/src/core/new-game.ts');
    const { store } = window.__HUAXIA__;
    const state = store.state;
    const winterDay = (10 - 1) * 7 + 2;
    state.clock.minutes = (winterDay - 1) * 1440 + 14 * 60;
    deriveClockFields(state.clock);
    state.clock.weather = 'snow';
    state.clock.weatherIntensity = 1;
    state.clock.weatherMinutesLeft = 100000;
    state.clock.paused = false;
  });
  await snap('snow');

  // 夏雨
  await page.evaluate(async () => {
    const { deriveClockFields } = await import('/src/core/new-game.ts');
    const { store } = window.__HUAXIA__;
    const state = store.state;
    const heroDay = (5 - 1) * 7 + 2;
    state.clock.minutes = (heroDay - 1) * 1440 + 15 * 60 + 10;
    deriveClockFields(state.clock);
    state.clock.weather = 'rain';
    state.clock.weatherIntensity = 0.9;
    state.clock.weatherMinutesLeft = 100000;
  });
  await snap('rain');

  const stats = await page.evaluate(() => {
    const { store, view } = window.__HUAXIA__;
    const st = store.state;
    const info = view.renderer.info;
    return {
      population: st.stats.population,
      buildings: st.buildings.length,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      weather: st.clock.weather,
      season: st.clock.season,
    };
  });
  console.log('stats', JSON.stringify(stats));
  console.log('errors', JSON.stringify(errors.slice(0, 10)));
} catch (err) {
  console.error('showcase failed:', String(err));
  console.error('errors:', JSON.stringify(errors.slice(0, 10)));
  process.exitCode = 1;
} finally {
  await browser.close();
}
