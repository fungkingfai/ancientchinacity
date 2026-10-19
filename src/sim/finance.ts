/**
 * 財政系統：每日服務收入結算 + 每月稅收／維護費結算與月報表。
 *
 * 對外契約（見 docs/ARCHITECTURE.md）：
 *   tickDailyFinance(state, ctx): void      每日（simulation.ts 在跨日時呼叫）
 *   monthlyFinance(state, ctx): void        每月（跨月時呼叫）
 *
 * 公式與數值對齊 docs/GAME_DESIGN.md §6：
 *   人頭稅 = 人口 × 稅率 × 8             （100% 稅率時 8 兩／人／月）
 *   田賦   = (農田+茶園) 數 × 稅率 × 40   （100% 稅率時 40 兩／座／月）
 *   商稅   = (市集+茶館+客棧+碼頭) 數 × 稅率 × 60（100% 時 60 兩／座／月）
 *   稅收合計 × (1 + 衙門 taxBonus，config 0.15)
 *   服務收入 = Σ incomePerDay × util（util = 人力 × 覆蓋 × 貨源，每日即時入帳）
 *   維護費 = totalUpkeep（唯一在月底才扣的營運支出）
 *
 * 帳務設計
 * - 現金流採「發生即入帳」：建造費／節慶支出由 placement.ts、main.ts 即時扣款並
 *   累計到 finance.expenseThisMonth；服務收入由 tickDailyFinance 即時入帳並累計到
 *   finance.incomeThisMonth。月底 treasury 只再加「稅收 − 維護費」，避免重複計算。
 * - 月報表 income = 本月服務收入累計 + 稅收 + 碼頭出口（logistics 已即時入帳，僅統計）；
 *   expense = 本月建造／節慶累計 + 維護費；因此 balance 恰等於國庫實際月變動。
 * - 碼頭出口收入歸 logistics：到港時 treasury += revenue 且寫入 dock.incomeThisMonth；
 *   本檔月底只把該欄位併入報表收入（不再動 treasury），隨後與所有建築的
 *   incomeThisMonth／expenseThisMonth 一併歸零。
 * - 市民消費（citizens.ts）記入商家 building.incomeThisMonth 供 UI／統計使用；
 *   v1 商稅採 GAME_DESIGN §6.2 的固定公式（不以市民消費額為稅基）。
 */

import { BUILDINGS, MONTHS_PER_YEAR, formatMoney, totalUpkeep } from '../core/config';
import type { Building, GameState, MonthRecord, SimContext } from '../core/types';

// ─────────────────────────── 數值常數（GAME_DESIGN §6.2） ───────────────────────────

/** 人頭稅：100% 稅率時每人每月基礎稅額（兩） */
export const HEAD_TAX_PER_HEAD = 8;
/** 田賦：100% 稅率時每座農田／茶園每月稅額（兩） */
export const LAND_TAX_PER_FARM = 40;
/** 商稅：100% 稅率時每座市集／茶館／客棧／碼頭每月稅額（兩） */
export const SHOP_TAX_PER_BUILDING = 60;
/** 稅率 20% 時對民心的月懲罰（GAME_DESIGN §6.4：taxRate × 100 × 0.35） */
export const TAX_HAPPINESS_PENALTY = 7;

/** 服務覆蓋分母：半徑內住宅人口達此人數 → 覆蓋率 1（GAME_DESIGN §6.2） */
const MARKET_COVERAGE_POP = 200;
const TEAHOUSE_COVERAGE_POP = 150;
const INN_COVERAGE_POP = 250;
/** 服務建築備料需可撐幾日才算「貨源充足」 */
const SERVICE_SUPPLY_DAYS = 3;

/** 連續虧空月份計數（不進存檔；讀檔後重新累計，僅影響警告與民心） */
const fiscalStress = new WeakMap<GameState, number>();

const round2 = (value: number): number => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number): number => (value < min ? min : value > max ? max : value);
/** 月報表用整數兩 */
const fmt = (value: number): string => `${Math.round(value).toLocaleString('zh-Hant')}`;

// ─────────────────────────── 服務覆蓋 ───────────────────────────

/** 建築中心（與 citizen-common.buildingCenter 一致） */
function centerOf(building: Building): { x: number; y: number } {
  return { x: building.x + building.w / 2, y: building.y + building.h / 2 };
}

/** 服務半徑內的住宅人口（歐氏距離，與 citizens.ts 的 insideService 一致） */
function residentsWithinRadius(state: GameState, building: Building, radius: number): number {
  if (!(radius > 0)) return 0;
  const center = centerOf(building);
  const r2 = radius * radius;
  let population = 0;
  for (const home of state.buildings) {
    const homeDef = BUILDINGS[home.key];
    if (!homeDef || homeDef.housing <= 0 || home.residents.length === 0) continue;
    const homeCenter = centerOf(home);
    const dx = homeCenter.x - center.x;
    const dy = homeCenter.y - center.y;
    if (dx * dx + dy * dy <= r2) population += home.residents.length;
  }
  return population;
}

/** 各業態的覆蓋率 0..1（GAME_DESIGN §6.2 表格） */
function serviceCoverage(state: GameState, building: Building, kind: string, radius: number): number {
  switch (kind) {
    case 'market':
      return Math.min(1, residentsWithinRadius(state, building, radius) / MARKET_COVERAGE_POP);
    case 'teahouse':
      return Math.min(1, residentsWithinRadius(state, building, radius) / TEAHOUSE_COVERAGE_POP);
    case 'inn':
      return Math.min(1, residentsWithinRadius(state, building, radius) / INN_COVERAGE_POP);
    // 碼頭客源是商旅貨運，不看住宅半徑；有營運即有基本吞吐
    case 'dock':
      return 1;
    default:
      return 1;
  }
}

// ─────────────────────────── 每日服務收入 ───────────────────────────

/**
 * 每日服務建築收入：市集、茶館、客棧、碼頭。
 * - 需 active && connected && 有工人；茶館／客棧另需自己店內有茶葉／酒
 *   （物流會補進建築自己的 inventory，本檔不向市集／倉庫領料）。
 * - util = 人力（工人比例）× 覆蓋（半徑內住宅人口 ÷ 分母）× 貨源（備料可撐日數）。
 */
export function tickDailyFinance(state: GameState, ctx: SimContext): void {
  const clock = state.clock;
  const finance = state.finance;
  const starved: string[] = [];

  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    const service = def?.service;
    if (!service || !service.incomePerDay) continue;
    if (!building.active || !building.connected) continue;

    const staffing = def.workers > 0 ? Math.min(1, building.workers.length / def.workers) : 1;
    if (staffing <= 0) continue;

    const coverage = serviceCoverage(state, building, service.kind, service.radius ?? 9);

    // 茶館／客棧：貨源係數；庫存不足則按比例打折、耗盡則歇業
    let supply = 1;
    const consumes = service.consumes;
    if (consumes) {
      const stock = building.inventory[consumes.resource] ?? 0;
      if (stock <= 0.05) {
        starved.push(def.name);
        continue;
      }
      const dailyNeed = consumes.amountPerDay;
      supply = Math.min(1, stock / (dailyNeed * SERVICE_SUPPLY_DAYS));
      const spend = Math.min(stock, dailyNeed);
      const left = stock - spend;
      if (left <= 0.005) delete building.inventory[consumes.resource];
      else building.inventory[consumes.resource] = round2(left);
    }

    const util = staffing * coverage * supply;
    const income = round2(service.incomePerDay * util);
    if (income <= 0) continue;

    // 官營服務收入直接入國庫；building.incomeThisMonth 保留給
    // 「市民消費（citizens.ts）」與「碼頭出口（logistics.ts）」的紀錄。
    finance.treasury = round2(finance.treasury + income);
    finance.incomeThisMonth = round2(finance.incomeThisMonth + income);
  }

  // 缺貨歇業提示（每 5 日一次，且只提示有庫存消耗的商家）
  if (starved.length > 0 && clock.totalDays % 5 === 0) {
    const names = [...new Set(starved)].slice(0, 3).join('、');
    ctx.log(`${names}因缺貨歇業，記得讓物流補貨。`, 'warn');
  }
}

// ─────────────────────────── 每月結算 ───────────────────────────

/** 月底結算：稅收、維護費、月報表、破產警告、稅率對民心的影響 */
export function monthlyFinance(state: GameState, ctx: SimContext): void {
  const clock = state.clock;
  const finance = state.finance;

  // 跨月後結算的是「上一月」
  const recordYear = clock.month === 1 ? clock.year - 1 : clock.year;
  const recordMonth = clock.month === 1 ? MONTHS_PER_YEAR : clock.month - 1;

  // ── 1) 稅源盤點（只計 active && connected 的營運建築） ──
  const population = state.citizens.length;
  let farmCount = 0;
  let marketCount = 0;
  let teahouseCount = 0;
  let innCount = 0;
  let dockCount = 0;
  let taxBonus = 0;
  let dockExportIncome = 0;
  for (const building of state.buildings) {
    const def = BUILDINGS[building.key];
    if (!def) continue;
    // 碼頭出口收入由 logistics 即時入帳並寫在 dock.incomeThisMonth，
    // 月底只做報表統計、不再加一次 treasury。
    if (building.key === 'dock') dockExportIncome += Math.max(0, building.incomeThisMonth);
    if (!building.active || !building.connected) continue;
    const production = def.production;
    if (production && (production.output === 'grain' || production.output === 'tea')) farmCount++;
    const service = def.service;
    if (!service) continue;
    switch (service.kind) {
      case 'market':
        marketCount++;
        break;
      case 'teahouse':
        teahouseCount++;
        break;
      case 'inn':
        innCount++;
        break;
      case 'dock':
        dockCount++;
        break;
      case 'yamen':
        // 衙門只取最高一級加成，不疊加（有衙門 ×1.15）
        taxBonus = Math.max(taxBonus, service.taxBonus ?? 0);
        break;
      default:
        break;
    }
  }

  // ── 2) 稅收公式（GAME_DESIGN §6.2） ──
  const headTax = round2(population * finance.taxRate * HEAD_TAX_PER_HEAD);
  const landTax = round2(farmCount * finance.taxRate * LAND_TAX_PER_FARM);
  const shopTax = round2(
    (marketCount + teahouseCount + innCount + dockCount) * finance.taxRate * SHOP_TAX_PER_BUILDING,
  );
  const taxMult = 1 + taxBonus;
  const taxIncome = round2((headTax + landTax + shopTax) * taxMult);

  // ── 3) 收支與報表（服務收入已於月內即時入帳） ──
  const serviceIncomeBase = round2(finance.incomeThisMonth);
  const upkeep = round2(totalUpkeep(state.buildings));
  const income = round2(serviceIncomeBase + taxIncome + dockExportIncome);
  const expense = round2(finance.expenseThisMonth + upkeep);
  const balance = round2(income - expense);

  // treasury 只再加「稅收 − 維護費」；其餘已在月內入帳
  finance.treasury = round2(finance.treasury + taxIncome - upkeep);

  // ── 4) 稅率與虧空對民心的影響（GAME_DESIGN §6.4） ──
  const previousStress = fiscalStress.get(state) ?? 0;
  const negativeMonths = finance.treasury < 0 ? previousStress + 1 : 0;
  fiscalStress.set(state, negativeMonths);

  const taxPenalty = TAX_HAPPINESS_PENALTY * (finance.taxRate / 0.2);
  // 虧空第 1 個月 −3 民心，連續第 2 個月起 −6
  const povertyPenalty = negativeMonths > 0 ? (negativeMonths >= 2 ? 6 : 3) : 0;
  const happinessDelta = -(taxPenalty + povertyPenalty);
  if (happinessDelta < 0) {
    for (const citizen of state.citizens) citizen.happiness = clamp(citizen.happiness + happinessDelta, 0, 100);
  }

  const avgHappiness = state.citizens.length
    ? round2(state.citizens.reduce((sum, citizen) => sum + citizen.happiness, 0) / state.citizens.length)
    : 70;

  // ── 5) 月報表（保留最近 24 個月） ──
  const record: MonthRecord = {
    year: recordYear,
    month: recordMonth,
    income,
    expense,
    balance,
    population,
    happiness: Math.round(avgHappiness),
  };
  finance.history.push(record);
  if (finance.history.length > 24) finance.history.splice(0, finance.history.length - 24);
  finance.lastMonthIncome = income;
  finance.lastMonthExpense = expense;
  finance.totalIncome = round2(finance.totalIncome + income);
  finance.totalExpense = round2(finance.totalExpense + expense);

  // 新的一個月重新累計
  finance.incomeThisMonth = 0;
  finance.expenseThisMonth = 0;
  for (const building of state.buildings) {
    building.incomeThisMonth = 0;
    building.expenseThisMonth = 0;
  }

  // ── 6) 訊息 ──
  const parts: string[] = [];
  if (serviceIncomeBase >= 0.5) parts.push(`服務 ${fmt(serviceIncomeBase)}`);
  if (headTax >= 0.5) parts.push(`人頭稅 ${fmt(headTax)}`);
  if (landTax >= 0.5) parts.push(`田賦 ${fmt(landTax)}`);
  if (shopTax >= 0.5) parts.push(`商稅 ${fmt(shopTax)}`);
  if (taxBonus > 0) parts.push(`衙門加成 +${Math.round(taxBonus * 100)}%`);
  if (dockExportIncome >= 0.5) parts.push(`碼頭出口 ${fmt(dockExportIncome)}`);
  const outcome = balance >= 0 ? `盈餘 +${fmt(balance)}` : `虧空 −${fmt(-balance)}`;
  ctx.log(
    `【${recordYear}年${recordMonth}月】結算：收入 ${fmt(income)} 兩（${parts.join('、') || '尚無稅源'}），` +
      `支出 ${fmt(expense)} 兩（維護 ${fmt(upkeep)}），${outcome} 兩；民心 ${Math.round(avgHappiness)}。`,
    balance >= 0 ? 'good' : 'warn',
  );

  if (negativeMonths > 0) {
    if (negativeMonths >= 2) {
      ctx.log(`國庫連續 ${negativeMonths} 個月虧空（${formatMoney(finance.treasury)}），民心思變，速開稅源。`, 'bad');
    } else {
      ctx.log(`國庫虧空（${formatMoney(finance.treasury)}），若下月仍未改善，民心將受影響。`, 'bad');
    }
  } else if (balance < 0) {
    ctx.log(`本月入不敷出 ${fmt(-balance)} 兩，留意開支。`, 'warn');
  }
}
