/**
 * 物流庫存工具（logistics-dev 自有檔）：
 * 建築庫存容量／可存資源／加減貨物的共用規則。
 *
 * 重要：所有貨物移動都必須經由 `addCargo` / `removeCargo` 實際加減庫存，
 * 不可憑空生成或消失（唯一例外是生產與服務消耗，屬 economy-dev 的職責）。
 *
 * 各建築可存放的資源：
 *   - 倉儲（糧倉／貨棧）：BuildingDef.storage.accepted，容量 storage.capacity
 *   - 生產建築：自身產出物＋所需投入物（酒坊收糧食、鐵匠鋪收鐵礦），容量 30（本地暫存上限）
 *   - 服務建築（茶館／客棧）：consumes 的資源（茶葉／酒），容量 30（營運備料）
 *   - 其他建築（市集以外）：容量 0，不參與物流
 *
 * 市集雖然 `storage.accepted='all'`，但物流只補貨架目標（見 logistics.ts）。
 */

import { BUILDINGS } from '../core/config';
import type { Building, ResourceKey } from '../core/types';

/** 生產建築本地暫存上限（與 economy-dev 的 production 約定一致） */
export const PRODUCER_LOCAL_CAP = 30;
/** 服務建築營運備料上限（茶館茶葉／客棧酒） */
export const SERVICE_STOCK_CAP = 30;

/** 建築對應的定義（未知建築回傳 undefined） */
export function defOf(building: Building) {
  return BUILDINGS[building.key];
}

/** 是否為倉儲建築（糧倉／貨棧） */
export function isStorage(building: Building): boolean {
  return !!BUILDINGS[building.key]?.storage;
}

/** 是否為生產建築 */
export function isProducer(building: Building): boolean {
  return !!BUILDINGS[building.key]?.production;
}

/** 倉儲的服務種類（'market' | 'dock' | ...；非服務建築回傳 null） */
export function serviceKindOf(building: Building): string | null {
  return BUILDINGS[building.key]?.service?.kind ?? null;
}

/** 該建築可存放哪些資源；null 代表不可存放任何資源 */
export function acceptedResourcesOf(building: Building): ResourceKey[] | 'all' | null {
  const def = BUILDINGS[building.key];
  if (!def) return null;
  if (def.storage) return def.storage.accepted;
  if (def.production) {
    const list: ResourceKey[] = [def.production.output];
    if (def.production.input) list.push(def.production.input.resource);
    return list;
  }
  if (def.service?.consumes) return [def.service.consumes.resource];
  return null;
}

/** 建築庫存容量（總量）。0 代表不能存貨。 */
export function capacityOf(building: Building): number {
  const def = BUILDINGS[building.key];
  if (!def) return 0;
  if (def.storage) return def.storage.capacity;
  if (def.production) return PRODUCER_LOCAL_CAP;
  if (def.service?.consumes) return SERVICE_STOCK_CAP;
  return 0;
}

/** 是否接受某資源 */
export function accepts(building: Building, resource: ResourceKey): boolean {
  const accepted = acceptedResourcesOf(building);
  if (!accepted) return false;
  return accepted === 'all' || accepted.includes(resource);
}

/** 目前庫存總量 */
export function inventoryTotal(building: Building): number {
  let total = 0;
  for (const key in building.inventory) {
    total += building.inventory[key as ResourceKey] ?? 0;
  }
  return total;
}

/**
 * 該建築對「某資源」還可容納多少（扣除 reserved：已派車、尚未抵達的入庫量）。
 * - 倉儲（含市集貨架）：容量為所有資源總和制。
 * - 生產建築：每個資源各自上限 30（產出與投入分開計算，避免互相排擠）。
 * - 服務建築（茶館／客棧）：備料上限 30。
 * - 其他建築：0。
 */
export function freeCapacityFor(building: Building, resource: ResourceKey, reserved = 0): number {
  if (!accepts(building, resource)) return 0;
  const def = BUILDINGS[building.key];
  if (!def) return 0;
  if (def.storage) {
    return Math.max(0, def.storage.capacity - inventoryTotal(building) - reserved);
  }
  if (def.production) {
    return Math.max(0, PRODUCER_LOCAL_CAP - (building.inventory[resource] ?? 0) - reserved);
  }
  if (def.service?.consumes) {
    return Math.max(0, SERVICE_STOCK_CAP - (building.inventory[resource] ?? 0) - reserved);
  }
  return 0;
}

/** 可再容納的總量（總量制建築用；生產／服務建築請用 freeCapacityFor） */
export function freeCapacity(building: Building, reserved = 0): number {
  return Math.max(0, capacityOf(building) - inventoryTotal(building) - reserved);
}

/** 某資源目前庫存量 */
export function stockOf(building: Building, resource: ResourceKey): number {
  return building.inventory[resource] ?? 0;
}

/**
 * 把貨物加入建築庫存；回傳實際加入量（0 表示不接受／已滿）。
 * 不會超過容量；小數會保留一位以避免浮點誤差累積（資源量以整數為主）。
 */
export function addCargo(building: Building, resource: ResourceKey, amount: number, reserved = 0): number {
  if (!(amount > 0) || !accepts(building, resource)) return 0;
  const room = freeCapacityFor(building, resource, reserved);
  if (room <= 0) return 0;
  const added = Math.min(amount, room);
  building.inventory[resource] = roundQty((building.inventory[resource] ?? 0) + added);
  return added;
}

/** 從建築庫存取出貨物；回傳實際取出量 */
export function removeCargo(building: Building, resource: ResourceKey, amount: number): number {
  if (!(amount > 0)) return 0;
  const have = building.inventory[resource] ?? 0;
  if (have <= 0) return 0;
  const taken = Math.min(have, amount);
  const left = roundQty(have - taken);
  if (left <= 0.0001) delete building.inventory[resource];
  else building.inventory[resource] = left;
  return taken;
}

/** 資源數量保留一位小數（避免 0.30000000000000004 類誤差） */
export function roundQty(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 市集貨架：物流補貨目標（單位）。市集 storage 容量 250，總和需低於容量。
 * 糧食目標較高（人口 150~200 的城市每日約需 150~200 糧，一次早晨結算可能吃完），
 * 人口更多時請多蓋市集。
 */
export const MARKET_SHELF_TARGETS: Partial<Record<ResourceKey, number>> = {
  grain: 160,
  tea: 18,
  wine: 18,
  cloth: 18,
};

/** 物流會補進市集的民生資源（市民購物／茶館客棧會消耗） */
export const MARKET_GOODS: ResourceKey[] = ['grain', 'tea', 'wine', 'cloth'];
