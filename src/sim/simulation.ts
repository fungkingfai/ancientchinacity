/**
 * 模擬主迴圈：固定順序呼叫各子系統。
 *
 * 每個影格由 main.ts 呼叫 Simulation.update(state, realDt, ctx)。
 * 呼叫順序（不要任意更改；其他 Agent 依賴此順序）：
 *   1. advanceClock          時間／天氣（回傳跨日／跨月／跨年／跨季旗標）
 *   2. tickCitizens          市民移動（走路、購物、通勤）
 *   3. tickLogistics         搬運工與貨物（每幀）
 *   4. newDay  → updateConnectivity → tickProduction → tickPopulation
 *               → tickDailyFinance（服務業每日收入）→ updateStats → 每日事件提示
 *   5. newMonth → monthlyFinance（在該月最後一日收入入帳後、新月份第一日收入入帳前結算）
 *   6. updateStats           統計（供 UI 顯示）
 *
 * 效能：所有昂貴結算都只在跨日／跨月時執行；每幀只做市民／物流移動與 O(n) 統計。
 */

import { GAME_MINUTES_PER_SECOND } from '../core/config';
import type { GameState, SimContext } from '../core/types';
import { advanceClock } from './time';
import { tickCitizens } from './citizens';
import { tickPopulation } from './population';
import { tickLogistics } from './logistics';
import { tickProduction } from './production';
import { monthlyFinance, tickDailyFinance } from './finance';
import { updateStats } from './stats';
import { updateConnectedBuildings } from './placement';

export class Simulation {
  update(state: GameState, realDt: number, ctx: SimContext): void {
    const clock = state.clock;
    if (clock.paused) {
      // 暫停時仍刷新一次統計，讓 UI 反映外部動作（建造／拆除／稅率）後的最新數字
      updateStats(state);
      return;
    }
    const speed = Math.max(0, clock.speed);
    const gameMinutes = realDt * GAME_MINUTES_PER_SECOND * speed;
    if (gameMinutes <= 0) return;

    // 1) 時間／天氣
    const flags = advanceClock(state, gameMinutes, ctx);

    // 2~3) 每幀：市民與物流
    tickCitizens(state, gameMinutes, ctx);
    tickLogistics(state, gameMinutes, ctx);

    // 4) 跨日：連通性 → 生產 → 人口 →（若同時跨月先月結）→ 服務收入 → 統計 → 提示
    if (flags.newDay) {
      updateConnectedBuildings(state);
      tickProduction(state, ctx);
      tickPopulation(state, ctx);
      // 跨月的那一天先結算上一個月，再記新一日的服務收入；
      // 否則新月份第一日的收入會被算進上月報表、且從新月份消失，月報表與國庫對不上。
      if (flags.newMonth) monthlyFinance(state, ctx);
      tickDailyFinance(state, ctx);
      updateStats(state);
      runDailyEvents(state, ctx);
    } else if (flags.newMonth) {
      // 保險：理論上不會發生（跨月必跨日），仍確保月結算不遺漏
      monthlyFinance(state, ctx);
    }

    // 6) 每幀統計
    updateStats(state);
  }
}

/** 建立模擬器（無狀態，方便讀檔後直接沿用） */
export function createSimulation(): Simulation {
  return new Simulation();
}

/** 每日事件提示：糧食告急、人口里程碑等（節流避免洗版） */
function runDailyEvents(state: GameState, ctx: SimContext): void {
  const { clock, stats } = state;
  if (stats.population <= 0) return;

  // 糧食安全
  if (stats.foodPerDay > 0) {
    const daysLeft = stats.foodStored / stats.foodPerDay;
    if (stats.foodStored < stats.foodPerDay) {
      if (clock.totalDays % 2 === 0) {
        ctx.log(`城中糧食見底（存糧 ${stats.foodStored}），百姓恐將挨餓！速建農田或等待物流補糧。`, 'bad');
      }
    } else if (daysLeft < 3 && clock.totalDays % 4 === 0) {
      ctx.log(`存糧僅夠約 ${Math.floor(daysLeft)} 日（${stats.foodStored} 單位），宜多闢農田。`, 'warn');
    }
  }

  // 人口里程碑（每 25 人一次，只提示一次）
  if (stats.population >= 25 && stats.population % 25 === 0 && clock.totalDays % 5 === 0) {
    ctx.log(`城中人口已達 ${stats.population} 人，街市漸興。`, 'good');
  }
}
