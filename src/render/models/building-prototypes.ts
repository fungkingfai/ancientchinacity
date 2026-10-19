/**
 * 華夏古城 — 22 種建築的程序化低多邊形中式模型。
 *
 * 設計重點：
 *  - 每種建築有可辨識的輪廓與細節（曲簷、青瓦、紅柱、白牆、匾額、燈籠、
 *    旗幡、窗櫺；茅屋草頂、農田田壟、酒坊酒罈、寺廟佛龕、衙門大堂……）。
 *  - 原型（prototype）每種只建立一次，`mergeStaticMeshes()` 合併同材質靜態
 *    mesh，建築實例只 clone 原型、共用 geometry/material。
 *  - 需要每幀微動的節點由 chinese-parts 標記 userData.anim，BuildingsView
 *    收集後做 transform 動畫（燈籠搖曳、旗幡飄動、炊煙、船身起伏、爐火）。
 *  - 模型原點在佔地中心、地面 y=0（BuildingsView 會把整個 group 抬到 y≈0.28）。
 */

import * as THREE from 'three';
import { BUILDINGS } from '../../core/config';
import type { BuildingDef } from '../../core/types';
import { TILE } from '../coords';
import { MaterialLibrary, PAL } from './materials';
import {
  addBox,
  addCone,
  addCylinder,
  addLathe,
  addRock,
  addSphere,
  mergeStaticMeshes,
} from './geometry-utils';
import {
  addAwning,
  addBanner,
  addBarrel,
  addBasket,
  addChineseRoof,
  addCrate,
  addDoor,
  addDrum,
  addFence,
  addFinial,
  addHangingLantern,
  addIncenseBurner,
  addLatticeWindow,
  addMarketStall,
  addPavedGround,
  addPennant,
  addPlaque,
  addSack,
  addSmallGableRoof,
  addSmoke,
  addSteps,
  addStoneLion,
  addTable,
  addStool,
  addTree,
  addWaterJar,
  addWineJar,
  darken,
} from './chinese-parts';

// ─────────────────────────── 原型型別 ───────────────────────────

export interface BuildingPrototype {
  key: string;
  variant: number;
  root: THREE.Group;
  /** 佔地世界尺寸（寬、深） */
  footprintW: number;
  footprintD: number;
}

export interface PrototypeFactory {
  /** 取得（必要時建立）建築原型；variant 會依 cap 循環。 */
  get(key: string, variant?: number): BuildingPrototype;
  variantCount(key: string): number;
  dispose(): void;
}

interface Ctx {
  lib: MaterialLibrary;
  root: THREE.Group;
  def: BuildingDef;
  w: number;
  h: number;
  /** 佔地世界寬／深 */
  W: number;
  D: number;
  variant: number;
}

// ─────────────────────────── 通用組件 ───────────────────────────

/** 牆段（白牆＋青瓦壓頂）。 */
function wallSegment(
  ctx: Ctx,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  height = 1.15,
  y = 0.14,
  color: number = PAL.wallWhite,
): void {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return;
  const yaw = Math.atan2(dx, dz);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  addBox(ctx.root, ctx.lib.lambert(color), 0.16, height, len, cx, y + height / 2, cz, yaw);
  addBox(ctx.root, ctx.lib.lambert(PAL.tile), 0.28, 0.09, len + 0.12, cx, y + height + 0.05, cz, yaw);
  addBox(ctx.root, ctx.lib.lambert(PAL.stoneDark), 0.22, 0.1, len, cx, y + 0.05, cz, yaw);
}

function addRolledEave(ctx: Ctx, x: number, y: number, z: number, w: number, d: number, color = PAL.tile): void {
  const roof = addChineseRoof(ctx.root, ctx.lib, {
    width: w,
    depth: d,
    height: Math.min(w, d) * 0.28,
    ridge: Math.max(0, w * 0.4),
    cornerLift: Math.min(w, d) * 0.06,
    cornerFlare: Math.min(w, d) * 0.04,
    slopeSegments: 4,
    edgeSegments: 4,
    tileColor: color,
    x,
    y,
    z,
    ornaments: 'none',
  });
  roof.userData.noMerge = false;
}

const DARK_INTERIOR = 0x2a2119;

/** 通用廳堂：石基、牆、紅柱、斗拱、曲簷、門窗、匾額、燈籠。 */
interface HallSpec {
  x?: number;
  z?: number;
  w: number;
  d: number;
  wallH: number;
  wallColor?: number;
  /** 前牆敞開（可見陰暗室內與陳設） */
  openFront?: boolean;
  /** 前簷柱數量；0 = 不加 */
  pillars?: number;
  door?: { w?: number; h?: number; panels?: 1 | 2; studs?: boolean } | null;
  /** 正面格子窗數量（左右對稱） */
  windows?: number;
  plaque?: string | null;
  /** 屋簷尺寸（預設比屋身外擴） */
  roof?: {
    w?: number;
    d?: number;
    h?: number;
    ridge?: number;
    tile?: number;
    ornaments?: 'none' | 'simple' | 'gold';
    lift?: number;
    ridgeAlongZ?: boolean;
  };
  lanterns?: boolean;
  steps?: boolean;
  floorY?: number;
  baseColor?: number;
  /** 不加屋頂（兩層樓的下層、重簷建築由外部自行加簷） */
  noRoof?: boolean;
}

function addHall(ctx: Ctx, spec: HallSpec): THREE.Group {
  const { lib, root } = ctx;
  const x = spec.x ?? 0;
  const z = spec.z ?? 0;
  const w = spec.w;
  const d = spec.d;
  const wallH = spec.wallH;
  const floorY = spec.floorY ?? 0.16;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  root.add(g);

  const stone = lib.lambert(PAL.stone);
  // 石基座
  addBox(g, stone, w + 0.16, floorY, d + 0.16, 0, floorY / 2, 0);
  addBox(g, lib.lambert(spec.baseColor ?? PAL.stoneLight), w + 0.24, 0.05, d + 0.24, 0, floorY + 0.005, 0);

  if (spec.openFront) {
    // 後牆與側牆
    addBox(g, lib.lambert(spec.wallColor ?? PAL.wallWhite), w, wallH, 0.16, 0, floorY + wallH / 2, -d / 2 + 0.08);
    addBox(g, lib.lambert(spec.wallColor ?? PAL.wallWhite), 0.16, wallH, d, -w / 2 + 0.08, floorY + wallH / 2, 0);
    addBox(g, lib.lambert(spec.wallColor ?? PAL.wallWhite), 0.16, wallH, d, w / 2 - 0.08, floorY + wallH / 2, 0);
    // 陰暗室內背板
    addBox(g, lib.lambert(DARK_INTERIOR), w - 0.3, wallH * 0.82, 0.05, 0, floorY + wallH * 0.44, -d / 2 + 0.18);
    addBox(g, lib.lambert(0x3a2c1e), w - 0.26, 0.12, d - 0.24, 0, floorY - 0.03, 0);
  } else {
    addBox(g, lib.lambert(spec.wallColor ?? PAL.wallWhite), w, wallH, d, 0, floorY + wallH / 2, 0);
    // 牆面木構框（白牆上的深色木框，中式感）
    const frameMat = lib.lambert(PAL.woodDark);
    addBox(g, frameMat, w + 0.02, 0.1, 0.05, 0, floorY + wallH - 0.05, d / 2 + 0.01);
    addBox(g, frameMat, w + 0.02, 0.08, 0.05, 0, floorY + 0.04, d / 2 + 0.01);
  }

  // 四角紅柱
  const pillarMat = lib.lambert(PAL.pillarRed);
  for (const px of [-w / 2, w / 2]) {
    for (const pz of [-d / 2, d / 2]) {
      addCylinder(g, pillarMat, 0.1, 0.12, wallH + 0.16, px, floorY + (wallH + 0.16) / 2, pz, 7);
    }
  }
  // 前簷柱
  const frontPillars = spec.pillars ?? 0;
  if (frontPillars > 0) {
    for (let i = 0; i < frontPillars; i++) {
      const px = frontPillars === 1 ? 0 : -w / 2 + (w / (frontPillars - 1)) * i;
      addCylinder(g, pillarMat, 0.09, 0.11, wallH, px, floorY + wallH / 2, d / 2 + 0.06, 7);
    }
  }

  // 額枋與簡化斗拱
  const beamMat = lib.lambert(PAL.pillarRedDark);
  addBox(g, beamMat, w + 0.1, 0.12, 0.12, 0, floorY + wallH - 0.1, d / 2 + 0.04);
  const bracketMat = lib.lambert(PAL.goldDark);
  const brackets = Math.max(2, Math.round(w / 0.55));
  for (let i = 0; i < brackets; i++) {
    const bx = -w / 2 + (w / (brackets - 1)) * i;
    addBox(g, lib.lambert(PAL.woodLight), 0.16, 0.1, 0.26, bx, floorY + wallH + 0.02, d / 2 + 0.08);
    addBox(g, bracketMat, 0.1, 0.06, 0.3, bx, floorY + wallH + 0.1, d / 2 + 0.1);
  }

  // 門
  if (spec.door !== null) {
    const doorW = spec.door?.w ?? Math.min(0.8, w * 0.3);
    const doorH = spec.door?.h ?? Math.min(1.15, wallH - 0.24);
    addDoor(g, lib, 0, floorY + doorH / 2 + 0.02, d / 2 + 0.02, {
      w: doorW,
      h: doorH,
      panels: spec.door?.panels ?? 2,
      studs: spec.door?.studs,
    });
    if (spec.steps !== false) addSteps(g, lib, 0, floorY, d / 2 + 0.04, doorW + 0.5, 2, 0.08, 0.18);
  }

  // 正面格子窗
  const windows = spec.windows ?? 0;
  if (windows > 0) {
    const winW = Math.min(0.62, w * 0.24);
    const winH = Math.min(0.55, wallH * 0.4);
    for (let i = 0; i < windows; i++) {
      const t = windows === 1 ? 0.5 : 0.12 + (0.76 / (windows - 1)) * i;
      const wx = -w / 2 + w * t;
      addLatticeWindow(g, lib, wx, floorY + wallH * 0.55, d / 2 + 0.045, { w: winW, h: winH });
    }
  }

  // 匾額
  if (spec.plaque) {
    addPlaque(g, lib, 0, floorY + wallH - 0.2, d / 2 + 0.1, spec.plaque, {
      w: Math.min(1.35, w * 0.5),
      h: 0.34,
    });
  }

  // 屋頂
  if (!spec.noRoof) {
    const roof = spec.roof ?? {};
    const ridgeAlongZ = roof.ridgeAlongZ ?? d > w;
    const roofW = (ridgeAlongZ ? d : w) + 0.55;
    const roofD = (ridgeAlongZ ? w : d) + 0.55;
    const roofH = roof.h ?? Math.min(roofW, roofD) * 0.46;
    const roofGroup = addChineseRoof(g, lib, {
      width: roofW,
      depth: roofD,
      height: roofH,
      ridge: roof.ridge ?? Math.max(0, roofW * 0.56),
      cornerLift: roof.lift ?? roofH * 0.26,
      cornerFlare: Math.min(roofW, roofD) * 0.08,
      tileColor: roof.tile ?? PAL.tile,
      ornaments: roof.ornaments ?? 'simple',
      y: floorY + wallH,
      slopeSegments: 6,
      edgeSegments: 6,
    });
    if (ridgeAlongZ) roofGroup.rotation.y = Math.PI / 2;
  }

  // 簷下燈籠
  if (spec.lanterns !== false) {
    addHangingLantern(g, lib, -w / 2 + 0.28, floorY + wallH - 0.02, d / 2 + 0.12, { rope: 0.18, scale: 0.85 });
    addHangingLantern(g, lib, w / 2 - 0.28, floorY + wallH - 0.02, d / 2 + 0.12, { rope: 0.18, scale: 0.85 });
  }
  return g;
}

/** 開敞工棚：石地、背牆、四柱、曲簷、工作臺。 */
function addWorkshopShed(
  ctx: Ctx,
  x: number,
  z: number,
  w: number,
  d: number,
  wallH: number,
  opts: { backWallColor?: number; roofColor?: number; roofRidge?: number } = {},
): THREE.Group {
  const { lib, root } = ctx;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  root.add(g);
  addBox(g, lib.lambert(PAL.earth), w + 0.2, 0.1, d + 0.2, 0, 0.05, 0);
  // 背牆與側牆半高
  addBox(g, lib.lambert(opts.backWallColor ?? PAL.wallMud), w, wallH, 0.18, 0, 0.1 + wallH / 2, -d / 2 + 0.09);
  addBox(g, lib.lambert(opts.backWallColor ?? PAL.wallMud), 0.16, wallH * 0.72, d, -w / 2 + 0.08, 0.1 + (wallH * 0.72) / 2, 0);
  // 木柱
  const wood = lib.lambert(PAL.wood);
  for (const [px, pz] of [
    [-w / 2, d / 2],
    [w / 2, d / 2],
    [-w / 2, -d / 2 + 0.1],
    [w / 2, -d / 2 + 0.1],
  ]) {
    addCylinder(g, wood, 0.07, 0.09, wallH + 0.1, px, 0.1 + (wallH + 0.1) / 2, pz, 6);
  }
  addBox(g, lib.lambert(PAL.woodDark), w + 0.2, 0.1, 0.1, 0, 0.1 + wallH, d / 2);
  const roof = addChineseRoof(g, lib, {
    width: w + 0.6,
    depth: d + 0.6,
    height: Math.min(w, d) * 0.42,
    ridge: Math.max(0, (w + 0.6) * 0.5),
    cornerLift: Math.min(w, d) * 0.1,
    cornerFlare: Math.min(w, d) * 0.05,
    tileColor: opts.roofColor ?? PAL.thatch,
    ornaments: 'none',
    y: 0.1 + wallH + 0.05,
    slopeSegments: 4,
    edgeSegments: 4,
  });
  return roof.parent ? g : g;
}

// ─────────────────────────── 民居 ───────────────────────────

/** 茅屋：泥土牆、稻草層疊屋頂、柴堆、炊煙。 */
function buildHut(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.92;
  const D = ctx.D * 0.9;
  addBox(root, lib.lambert(PAL.earth), W + 0.1, 0.08, D + 0.1, 0, 0.04, 0);
  // 泥牆
  addBox(root, lib.lambert(PAL.wallMud), W * 0.82, 1.15, D * 0.8, 0, 0.08 + 0.575, 0);
  // 木骨
  const wood = lib.lambert(PAL.woodDark);
  for (const px of [-W * 0.41, W * 0.41]) {
    for (const pz of [-D * 0.4, D * 0.4]) {
      addBox(root, wood, 0.09, 1.24, 0.09, px, 0.7, pz);
    }
  }
  addBox(root, wood, W * 0.86, 0.08, 0.08, 0, 1.22, D * 0.41);
  // 雙層草頂（底層大、頂層小，形成層疊茅草）
  addChineseRoof(root, lib, {
    width: W + 0.45,
    depth: D + 0.45,
    height: 0.72,
    ridge: 0,
    cornerLift: 0.16,
    cornerFlare: 0.18,
    tileColor: PAL.thatch,
    ornaments: 'none',
    y: 1.24,
    slopeSegments: 5,
    edgeSegments: 7,
  });
  addChineseRoof(root, lib, {
    width: W * 0.62,
    depth: D * 0.6,
    height: 0.42,
    ridge: 0,
    cornerLift: 0.08,
    cornerFlare: 0.1,
    tileColor: PAL.thatchDark,
    ornaments: 'none',
    y: 1.62,
    slopeSegments: 4,
    edgeSegments: 5,
  });
  // 門與窗洞
  addDoor(root, lib, 0, 0.08 + 0.5, D * 0.4 + 0.03, { w: 0.5, h: 0.95, panels: 1, color: PAL.wood });
  addBox(root, lib.lambert(DARK_INTERIOR), 0.34, 0.3, 0.05, -W * 0.24, 0.08 + 0.8, D * 0.4 + 0.02);
  addBox(root, lib.lambert(PAL.woodDark), 0.42, 0.36, 0.04, -W * 0.24, 0.08 + 0.8, D * 0.4 + 0.01);
  // 炊煙（草屋煙囪）
  addBox(root, lib.lambert(PAL.stoneDark), 0.16, 0.45, 0.16, W * 0.22, 1.5, -D * 0.1);
  addSmoke(root, lib, W * 0.22, 1.78, -D * 0.1, 0.85);
  // 柴堆
  const logMat = lib.lambert(PAL.wood);
  for (let i = 0; i < 3; i++) {
    addCylinder(root, logMat, 0.075, 0.075, 0.72, W * 0.44, 0.15 + i * 0.14, -D * 0.3, 6, Math.PI / 2);
  }
  // 水缸
  addWaterJar(root, lib, -W * 0.4, 0.02, D * 0.34, 0.85);
  if (ctx.variant === 1) {
    // 竹籬
    addFence(root, lib, -W / 2, D / 2 - 0.1, 0.1, D / 2 - 0.1, 0.7);
    addTree(root, lib, W * 0.36, -D * 0.36, 0.55, 'willow', 1);
  } else {
    addBasket(root, lib, -W * 0.36, 0.02, -D * 0.3, 0.16, PAL.crop);
  }
}

/** 瓦房：青瓦白牆、紅柱、格子窗、門前燈籠。 */
function buildHouse(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.94;
  const D = ctx.D * 0.92;
  addBox(root, lib.lambert(PAL.earth), W + 0.08, 0.06, D + 0.08, 0, 0.03, 0);
  addHall(ctx, {
    w: W * 0.82,
    d: D * 0.78,
    wallH: 1.3,
    door: { w: 0.58, h: 1.05, panels: 2 },
    windows: 2,
    lanterns: true,
    roof: { tile: PAL.tile, ornaments: 'simple' },
  });
  // 屋側披簷／灶房
  const side = new THREE.Group();
  side.position.set(W * 0.36, 0, -D * 0.06);
  root.add(side);
  addBox(side, lib.lambert(PAL.wallCream), 0.62, 0.9, 0.9, 0, 0.45, 0);
  addSmallGableRoof(side, lib, 0, 0.94, 0, 0.82, 1.1, 0.24);
  addSmoke(side, lib, 0.1, 1.15, 0, 0.55);
  if (ctx.variant === 1) {
    addTree(root, lib, -W * 0.38, -D * 0.34, 0.62, 'cypress', 1);
    addBox(root, lib.lambert(PAL.stone), 0.4, 0.28, 0.3, W * 0.38, 0.14, D * 0.34);
  } else {
    addWaterJar(root, lib, -W * 0.4, 0.02, D * 0.3, 0.9);
    addBasket(root, lib, W * 0.4, 0.02, D * 0.32, 0.18, PAL.crop);
  }
}

/** 宅院：圍牆院落、門樓、正房、廂房、庭院樹石。 */
function buildManor(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.94;
  const D = ctx.D * 0.94;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.stone, tile: 0.85, y: 0.09, thickness: 0.18 });
  // 圍牆
  const hx = W / 2 - 0.08;
  const hz = D / 2 - 0.08;
  wallSegment(ctx, -hx, -hz, hx, -hz, 1.2, 0.1, PAL.wallWhite);
  wallSegment(ctx, -hx, -hz, -hx, hz, 1.2, 0.1, PAL.wallWhite);
  wallSegment(ctx, hx, -hz, hx, hz, 1.2, 0.1, PAL.wallWhite);
  // 前牆留門洞
  wallSegment(ctx, -hx, hz, -0.62, hz, 1.2, 0.1, PAL.wallWhite);
  wallSegment(ctx, 0.62, hz, hx, hz, 1.2, 0.1, PAL.wallWhite);
  // 門樓
  const gate = new THREE.Group();
  gate.position.set(0, 0.1, hz);
  root.add(gate);
  const pillarMat = lib.lambert(PAL.pillarRed);
  addCylinder(gate, pillarMat, 0.09, 0.1, 1.5, -0.55, 0.75, 0, 7);
  addCylinder(gate, pillarMat, 0.09, 0.1, 1.5, 0.55, 0.75, 0, 7);
  addBox(gate, lib.lambert(PAL.woodDark), 1.3, 0.12, 0.16, 0, 1.5, 0);
  addDoor(gate, lib, 0, 0.66, 0.04, { w: 0.9, h: 1.2, panels: 2, color: PAL.pillarRedDark, studs: true });
  addSmallGableRoof(gate, lib, 0, 1.62, 0, 1.7, 1.3, 0.36);
  addPlaque(gate, lib, 0, 1.42, 0.16, '宅', { w: 0.5, h: 0.26 });
  addHangingLantern(gate, lib, -0.75, 1.55, 0.25, { rope: 0.15, scale: 0.8 });
  addHangingLantern(gate, lib, 0.75, 1.55, 0.25, { rope: 0.15, scale: 0.8 });
  // 正房（後）
  addHall(ctx, {
    x: 0,
    z: -D * 0.16,
    w: W * 0.66,
    d: D * 0.3,
    wallH: 1.55,
    door: { w: 0.7, h: 1.2, panels: 2 },
    windows: 2,
    pillars: 3,
    plaque: '福',
    roof: { h: 1.0, ridge: W * 0.5, tile: PAL.tile, ornaments: 'gold' },
  });
  // 廂房（左）
  addHall(ctx, {
    x: -W * 0.3,
    z: D * 0.14,
    w: W * 0.28,
    d: D * 0.34,
    wallH: 1.15,
    door: { w: 0.42, h: 0.85, panels: 1 },
    windows: 1,
    lanterns: false,
    steps: false,
    roof: { h: 0.6, ridge: 0.7, ornaments: 'none', ridgeAlongZ: true },
  });
  // 庭院：樹、石、石桌
  addTree(root, lib, W * 0.28, D * 0.16, 0.8, 'pine', 2);
  addRock(root, lib.lambert(PAL.stoneDark), -W * 0.06, D * 0.24, 0.9, 3);
  addBox(root, lib.lambert(PAL.stoneLight), 0.5, 0.1, 0.5, W * 0.1, 0.5, D * 0.24);
  addBox(root, lib.lambert(PAL.stone), 0.14, 0.34, 0.14, W * 0.1, 0.3, D * 0.24);
  addStool(root, lib, W * 0.1, 0.09, D * 0.3, 0.12, 0.3);
  addStool(root, lib, W * 0.16, 0.09, D * 0.2, 0.12, 0.3);
}

// ─────────────────────────── 生產 ───────────────────────────

/** 農田：田壟、稻禾、水渠、稻草人、田邊小草棚。 */
function buildFarm(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addBox(root, lib.lambert(PAL.soil), W, 0.1, D, 0, 0.06, 0);
  const ridgeMat = lib.lambert(PAL.earth);
  const cropMat = lib.lambert(PAL.crop);
  const cropGold = lib.lambert(PAL.cropGold);
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    const rz = -D / 2 + (D / rows) * (r + 0.5);
    addBox(root, ridgeMat, W - 0.3, 0.12, (D / rows) * 0.52, 0, 0.16, rz);
    const tufts = 9;
    for (let i = 0; i < tufts; i++) {
      const tx = -W / 2 + 0.28 + ((W - 0.56) / (tufts - 1)) * i;
      const crop = (i + r) % 3 === 0 ? cropGold : cropMat;
      addCone(root, crop, 0.09, 0.34, tx, 0.36, rz + ((i % 2) - 0.5) * 0.07, 4);
    }
  }
  // 水渠
  addBox(root, lib.lambert(PAL.water), 0.24, 0.04, D - 0.2, W / 2 - 0.22, 0.14, 0);
  addBox(root, lib.lambert(PAL.stone), 0.3, 0.16, 0.36, W / 2 - 0.22, 0.1, D / 2 - 0.4);
  // 田邊草棚
  const hut = new THREE.Group();
  hut.position.set(-W / 2 + 0.55, 0.1, -D / 2 + 0.62);
  root.add(hut);
  addBox(hut, lib.lambert(PAL.wallMud), 0.86, 0.72, 0.8, 0, 0.36, 0);
  addChineseRoof(hut, lib, {
    width: 1.15,
    depth: 1.1,
    height: 0.4,
    ridge: 0,
    cornerLift: 0.1,
    cornerFlare: 0.08,
    tileColor: PAL.thatch,
    ornaments: 'none',
    y: 0.74,
    slopeSegments: 4,
    edgeSegments: 5,
  });
  // 稻草人
  const scare = new THREE.Group();
  scare.position.set(W * 0.28, 0.1, D * 0.06);
  root.add(scare);
  addCylinder(scare, lib.lambert(PAL.woodDark), 0.03, 0.035, 1.15, 0, 0.575, 0, 5);
  addBox(scare, lib.lambert(PAL.woodDark), 0.8, 0.05, 0.05, 0, 0.82, 0);
  addBox(scare, lib.lambert(PAL.clothBlue), 0.34, 0.42, 0.16, 0, 0.72, 0);
  addSphere(scare, lib.lambert(PAL.thatchLight), 0.13, 0, 1.02, 0.02, 7, 5);
  addCone(scare, lib.lambert(PAL.thatch), 0.24, 0.16, 0, 1.16, 0.02, 7);
  // 竹籃、水缸
  addBasket(root, lib, -W * 0.2, 0.1, D * 0.34, 0.2, PAL.crop);
  addBasket(root, lib, -W * 0.32, 0.1, D * 0.3, 0.16, PAL.cropGold);
  addWaterJar(root, lib, W * 0.42, 0.1, -D * 0.34, 0.95);
  if (ctx.variant === 1) {
    addFence(root, lib, -W / 2, -D / 2 + 0.1, W / 2, -D / 2 + 0.1, 0.55, 0.1);
  }
}

/** 茶園：梯田茶壟、採茶籃、曬茶棚。 */
function buildTeaFarm(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  const terraces = 3;
  const matHill = lib.lambert(0x7e8c55);
  const bushMat = lib.lambert(PAL.leafDark);
  const bushMat2 = lib.lambert(PAL.leaf);
  for (let t = 0; t < terraces; t++) {
    const td = (D / terraces) * 0.92;
    const tz = -D / 2 + (D / terraces) * (t + 0.5);
    const h = 0.12 + t * 0.16;
    addBox(root, matHill, W - t * 0.12, h + 0.1, td, 0, (h + 0.1) / 2, tz);
    addBox(root, lib.lambert(PAL.stone), W - t * 0.12, 0.16, 0.12, 0, h * 0.7, tz + td / 2);
    const bushes = 7;
    for (let i = 0; i < bushes; i++) {
      const bx = -W / 2 + 0.3 + ((W - 0.6) / (bushes - 1)) * i;
      const bush = addSphere(root, (i + t) % 2 ? bushMat : bushMat2, 0.2, bx, h + 0.18, tz, 6, 4);
      bush.scale.set(1.15, 0.8, 0.9);
    }
  }
  // 曬茶棚
  const shed = new THREE.Group();
  shed.position.set(-W / 2 + 0.62, 0.1, -D / 2 + 0.58);
  root.add(shed);
  const wood = lib.lambert(PAL.wood);
  for (const [px, pz] of [
    [-0.4, -0.35],
    [0.4, -0.35],
    [-0.4, 0.35],
    [0.4, 0.35],
  ]) {
    addCylinder(shed, wood, 0.03, 0.04, 1.25, px, 0.625, pz, 5);
  }
  addSmallGableRoof(shed, lib, 0, 1.28, 0, 1.15, 1.0, 0.3);
  addTable(shed, lib, 0, 0, 0, 0.85, 0.55, 0.5);
  for (let i = 0; i < 3; i++) {
    addBox(shed, lib.lambert(PAL.bamboo), 0.4, 0.04, 0.3, -0.28 + i * 0.28, 0.55, 0);
    addSphere(shed, lib.lambert(PAL.leaf), 0.09, -0.28 + i * 0.28, 0.6, 0, 5, 4);
  }
  addBasket(root, lib, W * 0.36, 0.1, D * 0.3, 0.2, PAL.leaf);
  addBasket(root, lib, W * 0.26, 0.1, D * 0.38, 0.16, PAL.leafDark);
  addWaterJar(root, lib, -W * 0.4, 0.1, D * 0.34, 0.8);
  if (ctx.variant === 1) addTree(root, lib, W * 0.44, -D * 0.4, 0.6, 'cypress', 2);
}

/** 伐木場：原木堆、鋸木棚、樹樁與斧頭、木板。 */
function buildLumber(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addBox(root, lib.lambert(PAL.earth), W, 0.08, D, 0, 0.04, 0);
  const logMat = lib.lambert(PAL.wood);
  const endMat = lib.lambert(PAL.woodLight);
  // 原木堆（金字塔式）
  const rows = [4, 3, 2];
  for (let r = 0; r < rows.length; r++) {
    for (let i = 0; i < rows[r]; i++) {
      const lx = -W * 0.22;
      const lz = -D * 0.3 + 0.26 + i * 0.3 + (r % 2) * 0.15;
      const ly = 0.24 + r * 0.24;
      addCylinder(root, logMat, 0.13, 0.13, 1.5, lx, ly, lz, 8, 0, Math.PI / 2);
      addCylinder(root, endMat, 0.105, 0.105, 0.02, lx + 0.76, ly, lz, 8, 0, Math.PI / 2);
      addCylinder(root, endMat, 0.105, 0.105, 0.02, lx - 0.76, ly, lz, 8, 0, Math.PI / 2);
    }
  }
  // 鋸木棚
  addWorkshopShed(ctx, W * 0.26, D * 0.14, W * 0.36, D * 0.4, 1.15, {
    backWallColor: PAL.wallMud,
    roofColor: PAL.thatch,
  });
  // 樹樁與斧頭
  addCylinder(root, lib.lambert(PAL.woodDark), 0.2, 0.24, 0.34, W * 0.4, 0.27, -D * 0.34, 9);
  addBox(root, lib.lambert(PAL.wood), 0.06, 0.55, 0.06, W * 0.42, 0.62, -D * 0.34);
  addBox(root, lib.lambert(PAL.iron), 0.2, 0.14, 0.05, W * 0.46, 0.72, -D * 0.34);
  // 木板堆
  for (let i = 0; i < 3; i++) {
    addBox(root, lib.lambert(PAL.woodLight), 1.0, 0.05, 0.42, W * 0.26, 0.13 + i * 0.07, D * 0.36);
  }
  if (ctx.variant === 1) {
    addTree(root, lib, -W * 0.4, D * 0.36, 0.75, 'pine', 4);
  } else {
    addBasket(root, lib, -W * 0.34, 0.08, D * 0.36, 0.18, PAL.wood);
  }
}

/** 採石場：石料堆、木吊架、石塊與推車。 */
function buildQuarry(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addBox(root, lib.lambert(PAL.stone), W, 0.1, D, 0, 0.05, 0);
  const block = lib.lambert(PAL.stoneLight);
  const stone = lib.lambert(PAL.stone);
  const stoneDark = lib.lambert(PAL.stoneDark);
  // 採石壁
  addBox(root, stoneDark, W * 0.7, 1.5, 0.55, -W * 0.1, 0.8, -D / 2 + 0.32);
  addBox(root, stone, W * 0.66, 1.15, 0.4, -W * 0.1, 0.62, -D / 2 + 0.62);
  // 切割好的石塊
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      addBox(root, block, 0.62, 0.34, 0.5, W * 0.04 + i * 0.66, 0.27 + j * 0.35, D * 0.24 + i * 0.05);
    }
  }
  addBox(root, block, 0.55, 0.3, 0.45, -W * 0.28, 0.26, D * 0.3);
  // 碎石堆
  for (let i = 0; i < 4; i++) {
    addRock(root, stone, W * 0.32 + (i % 2) * 0.3, -D * 0.18 + Math.floor(i / 2) * 0.32, 0.8 + i * 0.12, i + 3);
  }
  // 木吊架（吊石）
  const crane = new THREE.Group();
  crane.position.set(-W * 0.34, 0.1, -D * 0.1);
  root.add(crane);
  const wood = lib.lambert(PAL.wood);
  addCylinder(crane, wood, 0.06, 0.08, 2.1, -0.35, 1.05, 0, 6);
  addCylinder(crane, wood, 0.06, 0.08, 2.1, 0.35, 1.05, 0, 6);
  addBox(crane, lib.lambert(PAL.woodDark), 1.1, 0.1, 0.1, 0, 2.08, 0);
  addBox(crane, wood, 1.5, 0.1, 0.1, 0.35, 2.2, 0, 0);
  addCylinder(crane, lib.lambert(PAL.woodBlack), 0.02, 0.02, 1.1, 0.95, 1.65, 0, 4);
  addBox(crane, block, 0.4, 0.3, 0.36, 0.95, 0.95, 0);
  // 推車
  addBox(root, lib.lambert(PAL.wood), 0.8, 0.22, 0.5, W * 0.28, 0.42, -D * 0.3);
  addCylinder(root, lib.lambert(PAL.woodDark), 0.22, 0.22, 0.08, W * 0.28, 0.3, -D * 0.3 + 0.3, 8, 0, Math.PI / 2);
  // 十字鎬
  addBox(root, lib.lambert(PAL.wood), 0.05, 0.9, 0.05, W * 0.4, 0.55, D * 0.06);
  addBox(root, lib.lambert(PAL.iron), 0.5, 0.07, 0.07, W * 0.4, 0.95, D * 0.06, 0.4);
}

/** 鐵礦場：礦洞口、木支撐、礦車軌道、礦石堆、礦燈。 */
function buildIronMine(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addBox(root, lib.lambert(PAL.stoneDark), W, 0.1, D, 0, 0.05, 0);
  const wood = lib.lambert(PAL.wood);
  const woodDark = lib.lambert(PAL.woodDark);
  // 礦山
  addRock(root, lib.lambert(PAL.stoneDark), -W * 0.06, -D * 0.28, 2.6, 1);
  addRock(root, lib.lambert(PAL.stone), -W * 0.34, -D * 0.2, 1.9, 2);
  addRock(root, lib.lambert(PAL.stoneDark), W * 0.26, -D * 0.34, 2.1, 3);
  // 礦洞口
  addBox(root, lib.lambert(PAL.woodBlack), 1.35, 1.2, 0.18, 0, 0.7, -D / 2 + 0.72);
  addCylinder(root, woodDark, 0.1, 0.12, 1.5, -0.75, 0.85, -D / 2 + 0.62, 6);
  addCylinder(root, woodDark, 0.1, 0.12, 1.5, 0.75, 0.85, -D / 2 + 0.62, 6);
  addBox(root, wood, 1.9, 0.16, 0.18, 0, 1.6, -D / 2 + 0.62);
  addBox(root, woodDark, 1.6, 0.12, 0.14, 0, 1.33, -D / 2 + 0.62);
  // 礦石
  const ore = lib.lambert(PAL.ore);
  for (let i = 0; i < 5; i++) {
    addSphere(root, ore, 0.12 + (i % 3) * 0.03, -0.3 + i * 0.17, 0.14, -D / 2 + 0.95 + (i % 2) * 0.12, 5, 4);
  }
  // 軌道
  for (const rx of [-0.32, 0.32]) {
    addBox(root, lib.lambert(PAL.ironDark), 0.08, 0.06, 2.3, rx, 0.14, -D * 0.05);
  }
  for (let i = 0; i < 6; i++) {
    addBox(root, woodDark, 0.8, 0.05, 0.12, 0, 0.1, -D / 2 + 1.1 + i * 0.38);
  }
  // 礦車
  const cart = new THREE.Group();
  cart.position.set(0, 0.16, D * 0.12);
  root.add(cart);
  addBox(cart, lib.lambert(PAL.ironDark), 0.7, 0.34, 0.5, 0, 0.3, 0);
  for (const [wx, wz] of [
    [-0.26, -0.2],
    [0.26, -0.2],
    [-0.26, 0.2],
    [0.26, 0.2],
  ]) {
    addCylinder(cart, lib.lambert(PAL.iron), 0.1, 0.1, 0.06, wx, 0.1, wz, 7, 0, Math.PI / 2);
  }
  for (let i = 0; i < 4; i++) {
    addSphere(cart, ore, 0.1, -0.2 + i * 0.14, 0.5, (i % 2) * 0.1 - 0.05, 5, 4);
  }
  // 礦燈
  addCylinder(root, woodDark, 0.04, 0.05, 1.3, W * 0.36, 0.75, -D * 0.18, 5);
  addHangingLantern(root, lib, W * 0.36 - 0.18, 1.38, -D * 0.18, { rope: 0.1, scale: 0.75 });
  // 十字鎬
  addBox(root, wood, 0.05, 0.85, 0.05, -W * 0.4, 0.5, -D * 0.1, 0.2);
  addBox(root, lib.lambert(PAL.iron), 0.44, 0.06, 0.06, -W * 0.4, 0.9, -D * 0.1, 0.6);
}

/** 酒坊：釀酒作坊、成排酒罈、酒旗、蒸氣。 */
function buildBrewery(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.earth, tile: 1.0, y: 0.08, thickness: 0.16 });
  // 作坊（後方）
  addHall(ctx, {
    x: 0,
    z: -D * 0.18,
    w: W * 0.7,
    d: D * 0.32,
    wallH: 1.5,
    wallColor: PAL.wallCream,
    openFront: true,
    pillars: 3,
    door: null,
    windows: 0,
    plaque: '酒坊',
    lanterns: false,
    roof: { h: 0.85, ridge: W * 0.5, ornaments: 'simple' },
  });
  // 作坊內的蒸酒大灶（陰影中的暖色）
  const vat = new THREE.Group();
  vat.position.set(-W * 0.12, 0.16, -D * 0.2);
  root.add(vat);
  addCylinder(vat, lib.lambert(PAL.bronze), 0.34, 0.4, 0.5, 0, 0.25, 0, 10);
  addCylinder(vat, lib.lambert(PAL.stoneDark), 0.42, 0.46, 0.16, 0, 0.08, 0, 10);
  addBox(vat, lib.lambert(PAL.fire), 0.2, 0.12, 0.1, 0, 0.1, 0.34);
  addSmoke(root, lib, -W * 0.12, 0.8, -D * 0.2, 0.9);
  // 成排酒罈
  for (let i = 0; i < 4; i++) {
    addWineJar(root, lib, -W * 0.3 + i * 0.52, 0.08, D * 0.2, { scale: 0.85 + (i % 2) * 0.1 });
  }
  for (let i = 0; i < 3; i++) {
    addWineJar(root, lib, -W * 0.24 + i * 0.46, 0.08, D * 0.38, { scale: 0.65 });
  }
  // 酒旗與木桶
  addBanner(root, lib, W * 0.42, 0.1, D * 0.06, { height: 3.3, text: '酒', bg: PAL.clothRed, ry: -0.4 });
  addBarrel(root, lib, W * 0.3, 0.08, -D * 0.36, 0.42);
  addBarrel(root, lib, W * 0.34, 0.08, D * 0.32, 0.34);
  addSack(root, lib, -W * 0.42, 0.08, -D * 0.32, 1.1);
  addSack(root, lib, -W * 0.34, 0.08, -D * 0.36, 0.9, 0.6);
  addHangingLantern(root, lib, -W * 0.28, 1.5, D * 0.06, { rope: 0.2, scale: 0.9 });
}

/** 織坊：曬布架、彩色布匹、織機棚、織旗。 */
function buildWeaver(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.stone, tile: 0.95, y: 0.08, thickness: 0.16 });
  // 主作坊
  addHall(ctx, {
    x: 0,
    z: -D * 0.2,
    w: W * 0.68,
    d: D * 0.3,
    wallH: 1.4,
    wallColor: PAL.wallCream,
    openFront: true,
    pillars: 3,
    door: null,
    windows: 0,
    plaque: '織坊',
    lanterns: false,
    roof: { h: 0.8, ridge: W * 0.5, ornaments: 'simple', tile: PAL.tile },
  });
  // 作坊內的織機剪影
  const loom = new THREE.Group();
  loom.position.set(0, 0.16, -D * 0.22);
  root.add(loom);
  addBox(loom, lib.lambert(PAL.woodDark), 0.12, 1.0, 0.12, -0.4, 0.5, 0);
  addBox(loom, lib.lambert(PAL.woodDark), 0.12, 1.0, 0.12, 0.4, 0.5, 0);
  addBox(loom, lib.lambert(PAL.wood), 0.95, 0.1, 0.1, 0, 0.95, 0);
  addBox(loom, lib.lambert(PAL.wood), 0.95, 0.1, 0.1, 0, 0.45, 0);
  for (let i = 0; i < 5; i++) {
    addBox(loom, lib.lambert(i % 2 ? PAL.clothPink : PAL.clothBlue), 0.05, 0.6, 0.02, -0.32 + i * 0.16, 0.68, 0.02);
  }
  // 曬布架（彩色布匹）
  const rack = new THREE.Group();
  rack.position.set(-W * 0.26, 0.08, D * 0.16);
  root.add(rack);
  const wood = lib.lambert(PAL.wood);
  addCylinder(rack, wood, 0.04, 0.05, 1.65, -0.7, 0.82, 0, 6);
  addCylinder(rack, wood, 0.04, 0.05, 1.65, 0.7, 0.82, 0, 6);
  addBox(rack, lib.lambert(PAL.woodDark), 1.6, 0.07, 0.07, 0, 1.6, 0);
  addBox(rack, lib.lambert(PAL.woodDark), 1.6, 0.07, 0.07, 0, 1.25, 0);
  const colors = [PAL.clothPink, PAL.clothBlue, PAL.clothTeal, PAL.clothYellow];
  for (let i = 0; i < 4; i++) {
    addBox(rack, lib.lambert(colors[i], { side: THREE.DoubleSide }), 0.3, 1.05, 0.03, -0.6 + i * 0.4, 0.78, 0.02);
  }
  // 布匹桌
  addTable(root, lib, W * 0.3, 0.08, D * 0.24, 0.9, 0.6, 0.6);
  for (let i = 0; i < 3; i++) {
    addBox(root, lib.lambert(colors[(i + 1) % 4]), 0.3, 0.1, 0.5, W * 0.16 + i * 0.32, 0.72, D * 0.24);
  }
  // 織旗
  addBanner(root, lib, W * 0.44, 0.1, -D * 0.06, { height: 3.1, text: '織', bg: PAL.clothBlue, ry: -0.3 });
  addBasket(root, lib, -W * 0.36, 0.08, D * 0.36, 0.18, PAL.clothPink);
}

/** 鐵匠鋪：爐火、鐵砧、風箱、兵器架、炊煙。 */
function buildBlacksmith(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  const shed = addWorkshopShed(ctx, 0, -D * 0.06, W * 0.78, D * 0.62, 1.35, {
    backWallColor: PAL.wallMud,
    roofColor: PAL.tile,
    roofRidge: 1.4,
  });
  const stone = lib.lambert(PAL.stoneDark);
  const iron = lib.lambert(PAL.iron);
  const wood = lib.lambert(PAL.woodDark);
  // 爐灶與爐火
  addBox(root, stone, 0.9, 0.5, 0.7, -W * 0.22, 0.35, -D * 0.22);
  addBox(root, stone, 0.7, 0.26, 0.5, -W * 0.22, 0.73, -D * 0.22);
  const fireMat = lib.basic(PAL.fire, { toneMapped: false });
  const fire = addBox(root, fireMat, 0.42, 0.16, 0.32, -W * 0.22, 0.42, -D * 0.02);
  fire.userData.anim = 'glow';
  const glow = lib.basic(PAL.ember, { transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false });
  const glowMesh = addSphere(root, glow, 0.34, -W * 0.22, 0.42, -D * 0.02, 7, 5);
  glowMesh.userData.anim = 'glow';
  // 煙囪
  addBox(root, stone, 0.3, 1.4, 0.3, -W * 0.22, 1.2, -D * 0.26);
  addSmoke(root, lib, -W * 0.22, 1.95, -D * 0.26, 1.0);
  // 風箱
  addBox(root, lib.lambert(PAL.wood), 0.8, 0.3, 0.28, -W * 0.02, 0.34, -D * 0.2);
  addBox(root, lib.lambert(PAL.clothBlue), 0.24, 0.24, 0.22, W * 0.16, 0.3, -D * 0.2);
  // 鐵砧
  addCylinder(root, wood, 0.18, 0.22, 0.3, W * 0.14, 0.28, D * 0.02, 8);
  addBox(root, iron, 0.42, 0.2, 0.24, W * 0.14, 0.52, D * 0.02);
  addBox(root, iron, 0.3, 0.12, 0.2, W * 0.14, 0.64, D * 0.02);
  addCone(root, iron, 0.1, 0.25, W * 0.3, 0.56, D * 0.02, 6, Math.PI / 2);
  addBox(root, lib.lambert(PAL.wood), 0.05, 0.6, 0.05, W * 0.05, 0.42, D * 0.14, 0.4);
  // 淬火木桶
  addBarrel(root, lib, W * 0.38, 0.1, D * 0.22, 0.42);
  // 兵器架
  const rack = new THREE.Group();
  rack.position.set(-W * 0.38, 0.1, D * 0.24);
  root.add(rack);
  addCylinder(rack, wood, 0.04, 0.05, 1.1, -0.3, 0.55, 0, 5);
  addCylinder(rack, wood, 0.04, 0.05, 1.1, 0.3, 0.55, 0, 5);
  addBox(rack, wood, 0.72, 0.06, 0.06, 0, 1.0, 0);
  for (let i = 0; i < 3; i++) {
    addBox(rack, lib.lambert(PAL.iron), 0.035, 1.3, 0.035, -0.24 + i * 0.24, 0.7, 0.04);
    addCone(rack, lib.lambert(PAL.iron), 0.045, 0.16, -0.24 + i * 0.24, 1.4, 0.04, 5);
  }
  if (shed) addHangingLantern(root, lib, W * 0.3, 1.55, D * 0.2, { rope: 0.16, scale: 0.85 });
}

// ─────────────────────────── 倉儲 ───────────────────────────

/** 糧倉：干欄式圓倉、草頂、木梯、穀袋。 */
function buildGranary(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W * 0.86, D * 0.86, 0, 0, { color: PAL.stone, tile: 0.9, y: 0.08, thickness: 0.16 });
  const g = new THREE.Group();
  g.position.set(-W * 0.06, 0.08, -D * 0.06);
  root.add(g);
  const wood = lib.lambert(PAL.wood);
  const plaster = lib.lambert(PAL.wallWhite);
  const ringMat = lib.lambert(PAL.woodDark);
  // 干欄支柱
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    addCylinder(g, wood, 0.09, 0.11, 0.5, Math.cos(a) * 0.62, 0.25, Math.sin(a) * 0.62, 6);
  }
  addBox(g, wood, 1.7, 0.12, 1.7, 0, 0.52, 0);
  // 圓倉身
  addCylinder(g, plaster, 0.78, 0.82, 1.55, 0, 1.35, 0, 14);
  // 木箍
  for (let i = 0; i < 3; i++) {
    addCylinder(g, ringMat, 0.84, 0.84, 0.06, 0, 0.82 + i * 0.5, 0, 14);
  }
  // 倉門
  addBox(g, ringMat, 0.5, 0.8, 0.08, 0, 1.12, 0.8);
  addBox(g, lib.lambert(PAL.woodDark), 0.56, 0.86, 0.04, 0, 1.12, 0.83);
  addPlaque(g, lib, 0, 1.72, 0.82, '糧倉', { w: 0.8, h: 0.3 });
  // 草頂（攢尖）＋寶頂
  addChineseRoof(g, lib, {
    width: 1.95,
    depth: 1.95,
    height: 0.9,
    ridge: 0,
    cornerLift: 0.2,
    cornerFlare: 0.14,
    tileColor: PAL.thatch,
    ornaments: 'none',
    y: 2.18,
    slopeSegments: 5,
    edgeSegments: 7,
  });
  addFinial(g, lib, 0, 3.1, 0, 0.9);
  // 木梯
  for (const lx of [-0.24, 0.24]) {
    addBox(root, wood, 0.06, 1.5, 0.07, lx, 0.85, D * 0.3, -0.28);
  }
  for (let i = 0; i < 5; i++) {
    addBox(root, wood, 0.52, 0.05, 0.06, 0, 0.28 + i * 0.3, D * 0.3 - 0.16 + i * 0.05, -0.28);
  }
  // 穀袋與推車
  addSack(root, lib, W * 0.28, 0.08, D * 0.24, 1.1);
  addSack(root, lib, W * 0.36, 0.08, D * 0.3, 0.95, 0.5);
  addSack(root, lib, W * 0.3, 0.08, D * 0.36, 0.8, 1.2);
  addBasket(root, lib, -W * 0.36, 0.08, D * 0.3, 0.2, PAL.cropGold);
  addBox(root, lib.lambert(PAL.wood), 0.8, 0.22, 0.5, W * 0.3, 0.4, -D * 0.3);
  addCylinder(root, lib.lambert(PAL.woodDark), 0.2, 0.2, 0.07, W * 0.3, 0.28, -D * 0.3 + 0.28, 8, 0, Math.PI / 2);
  addBox(root, lib.lambert(PAL.cropGold), 0.6, 0.24, 0.34, W * 0.3, 0.6, -D * 0.3);
}

/** 貨棧：大倉房、裝卸平台、貨箱木桶。 */
function buildWarehouse(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.earth, tile: 1.1, y: 0.08, thickness: 0.16 });
  // 大倉房
  const hall = addHall(ctx, {
    w: W * 0.82,
    d: D * 0.52,
    wallH: 1.7,
    wallColor: PAL.wallCream,
    openFront: true,
    pillars: 4,
    door: null,
    windows: 0,
    plaque: '貨棧',
    lanterns: false,
    roof: { h: 1.0, ridge: W * 0.7, tile: PAL.tile, ornaments: 'simple' },
  });
  // 立面木框（搬運門）
  addBox(hall, lib.lambert(PAL.woodDark), 2.2, 1.5, 0.06, 0, 0.85, D * 0.14);
  // 大門板與陰暗內部
  addBox(root, lib.lambert(DARK_INTERIOR), 1.4, 1.3, 0.1, 0, 0.82, -D * 0.08);
  addBox(root, lib.lambert(PAL.wood), 0.66, 1.3, 0.1, -0.72, 0.82, D * 0.2 - 0.06);
  addBox(root, lib.lambert(PAL.wood), 0.66, 1.3, 0.1, 0.72, 0.82, D * 0.2 - 0.06);
  // 裝卸平台
  addBox(root, lib.lambert(PAL.woodLight), W * 0.6, 0.16, 0.7, 0, 0.24, D * 0.28);
  addBox(root, lib.lambert(PAL.wood), 0.1, 0.24, 0.1, -W * 0.28, 0.12, D * 0.28);
  addBox(root, lib.lambert(PAL.wood), 0.1, 0.24, 0.1, W * 0.28, 0.12, D * 0.28);
  addSteps(root, lib, 0, 0.32, D * 0.28 + 0.35, 1.0, 2, 0.08, 0.18);
  // 貨物
  addCrate(root, lib, -W * 0.3, 0.08, D * 0.18, 0.5);
  addCrate(root, lib, -W * 0.3, 0.34, D * 0.18, 0.42, 0.3);
  addCrate(root, lib, W * 0.22, 0.08, D * 0.34, 0.46);
  addBarrel(root, lib, W * 0.36, 0.08, D * 0.16, 0.4);
  addSack(root, lib, W * 0.04, 0.08, D * 0.38, 1.0);
  addBanner(root, lib, W * 0.44, 0.1, -D * 0.16, { height: 3.0, text: '貨', bg: PAL.clothTeal, ry: -0.35 });
  addHangingLantern(root, lib, -W * 0.3, 1.6, D * 0.2, { rope: 0.2, scale: 0.9 });
}

// ─────────────────────────── 商業 ───────────────────────────

/** 市集：布棚攤位、貨物、市旗、秤。 */
function buildMarket(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.stone, tile: 0.85, y: 0.08, thickness: 0.16 });
  addMarketStall(root, lib, -W * 0.24, -D * 0.1, W * 0.34, D * 0.36, PAL.clothRed, PAL.cropGold, 0.1);
  addMarketStall(root, lib, W * 0.24, -D * 0.12, W * 0.32, D * 0.34, PAL.clothBlue, PAL.clothPink, -0.12);
  addMarketStall(root, lib, 0, D * 0.28, W * 0.36, D * 0.3, PAL.clothTeal, PAL.clothGreen, Math.PI);
  if (ctx.variant === 1) {
    addMarketStall(root, lib, -W * 0.24, D * 0.3, W * 0.3, D * 0.26, PAL.clothYellow, PAL.crop, 0.2);
  }
  // 市旗
  addBanner(root, lib, -W * 0.42, 0.1, -D * 0.36, { height: 3.4, text: '市', bg: PAL.clothTeal, ry: 0.35 });
  addBanner(root, lib, W * 0.42, 0.1, -D * 0.34, { height: 3.0, text: '米', bg: PAL.clothRed, ry: -0.35 });
  // 秤
  const scale = new THREE.Group();
  scale.position.set(W * 0.02, 0.08, -D * 0.32);
  root.add(scale);
  addCylinder(scale, lib.lambert(PAL.woodDark), 0.04, 0.05, 1.4, 0, 0.7, 0, 5);
  addBox(scale, lib.lambert(PAL.wood), 1.3, 0.06, 0.06, 0, 1.38, 0);
  for (const sx of [-0.6, 0.6]) {
    addCylinder(scale, lib.lambert(PAL.woodBlack), 0.012, 0.012, 0.4, sx, 1.16, 0, 4);
    addCylinder(scale, lib.lambert(PAL.woodLight), 0.16, 0.12, 0.1, sx, 0.94, 0, 8);
  }
  // 貨箱與水缸
  addCrate(root, lib, W * 0.38, 0.08, D * 0.3, 0.44);
  addWaterJar(root, lib, -W * 0.4, 0.08, D * 0.08, 0.85);
  addHangingLantern(root, lib, -W * 0.16, 1.62, -D * 0.1, { rope: 0.16, scale: 0.8 });
  addHangingLantern(root, lib, W * 0.34, 1.62, -D * 0.12, { rope: 0.16, scale: 0.8 });
}

/** 茶館：兩層茶樓、露台、茶旗、茶桌。 */
function buildTeahouse(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.stone, tile: 0.85, y: 0.08, thickness: 0.16 });
  // 一樓敞廳
  addHall(ctx, {
    x: 0,
    z: -D * 0.08,
    w: W * 0.68,
    d: D * 0.42,
    wallH: 1.7,
    wallColor: PAL.wallCream,
    openFront: true,
    pillars: 4,
    door: null,
    windows: 0,
    plaque: null,
    lanterns: false,
    noRoof: true,
  });
  // 二樓
  const upY = 1.95;
  addBox(root, lib.lambert(PAL.wallWhite), W * 0.7, 1.5, D * 0.42, 0, upY + 0.75, -D * 0.08);
  // 二樓窗櫺與露台欄杆
  for (let i = 0; i < 3; i++) {
    addLatticeWindow(root, lib, -W * 0.2 + i * W * 0.2, upY + 0.85, -D * 0.08 + D * 0.21 + 0.02, {
      w: 0.55,
      h: 0.5,
    });
  }
  addBox(root, lib.lambert(PAL.woodLight), W * 0.78, 0.12, 0.5, 0, upY + 0.02, -D * 0.08 + D * 0.21 + 0.2);
  const railMat = lib.lambert(PAL.woodDark);
  for (let i = 0; i <= 6; i++) {
    addBox(root, railMat, 0.06, 0.5, 0.06, -W * 0.36 + (W * 0.72 * i) / 6, upY + 0.3, -D * 0.08 + D * 0.21 + 0.42);
  }
  addBox(root, railMat, W * 0.76, 0.06, 0.08, 0, upY + 0.55, -D * 0.08 + D * 0.21 + 0.42);
  // 兩層屋頂
  const lowerRoof = addChineseRoof(root, lib, {
    width: W * 0.95,
    depth: D * 0.8,
    height: 0.7,
    ridge: W * 0.7,
    cornerLift: 0.18,
    cornerFlare: 0.12,
    tileColor: PAL.tile,
    ornaments: 'simple',
    y: upY + 0.02,
    slopeSegments: 5,
    edgeSegments: 6,
  });
  lowerRoof.position.z = -D * 0.08;
  addChineseRoof(root, lib, {
    width: W * 0.8,
    depth: D * 0.6,
    height: 0.85,
    ridge: W * 0.55,
    cornerLift: 0.2,
    cornerFlare: 0.1,
    tileColor: PAL.tile,
    ornaments: 'gold',
    y: upY + 1.5,
    z: -D * 0.08,
    slopeSegments: 6,
    edgeSegments: 6,
  });
  // 茶旗與匾額
  addBanner(root, lib, W * 0.44, 0.16, D * 0.24, { height: 3.9, text: '茶', bg: PAL.clothGreen, ry: -0.3 });
  addPlaque(root, lib, 0, 1.76, -D * 0.08 + D * 0.21 + 0.12, '茶館', { w: 0.9, h: 0.3 });
  // 戶外茶桌
  addTable(root, lib, -W * 0.24, 0.16, D * 0.36, 0.8, 0.6, 0.55);
  addStool(root, lib, -W * 0.36, 0.16, D * 0.36, 0.13, 0.36);
  addStool(root, lib, -W * 0.12, 0.16, D * 0.36, 0.13, 0.36);
  addTable(root, lib, W * 0.24, 0.16, D * 0.34, 0.7, 0.55, 0.55);
  addStool(root, lib, W * 0.24, 0.16, D * 0.42, 0.13, 0.36);
  addTree(root, lib, -W * 0.4, -D * 0.3, 0.55, 'willow', 5);
  addHangingLantern(root, lib, -W * 0.3, 1.78, D * 0.12, { rope: 0.2, scale: 0.9 });
  addHangingLantern(root, lib, W * 0.3, 1.78, D * 0.12, { rope: 0.2, scale: 0.9 });
}

/** 客棧：兩層樓、酒旗、馬樁、酒罈。 */
function buildInn(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.earth, tile: 1.0, y: 0.08, thickness: 0.16 });
  // 一樓
  addHall(ctx, {
    x: 0,
    z: -D * 0.1,
    w: W * 0.72,
    d: D * 0.4,
    wallH: 1.8,
    wallColor: PAL.wallCream,
    openFront: true,
    pillars: 4,
    door: null,
    windows: 0,
    lanterns: false,
    noRoof: true,
  });
  // 一樓內部：酒罈與櫃檯
  addWineJar(root, lib, -W * 0.2, 0.16, -D * 0.12, { scale: 0.6 });
  addWineJar(root, lib, 0.02, 0.16, -D * 0.12, { scale: 0.5 });
  addBox(root, lib.lambert(PAL.woodDark), W * 0.4, 0.62, 0.28, W * 0.16, 0.47, -D * 0.02);
  // 二樓
  const upY = 2.06;
  addBox(root, lib.lambert(PAL.wallWhite), W * 0.74, 1.55, D * 0.4, 0, upY + 0.77, -D * 0.1);
  for (let i = 0; i < 4; i++) {
    addLatticeWindow(root, lib, -W * 0.27 + i * W * 0.18, upY + 0.9, -D * 0.1 + D * 0.2 + 0.02, {
      w: 0.46,
      h: 0.48,
    });
  }
  addBox(root, lib.lambert(PAL.woodLight), W * 0.82, 0.12, 0.52, 0, upY + 0.02, -D * 0.1 + D * 0.2 + 0.2);
  const railMat = lib.lambert(PAL.woodDark);
  for (let i = 0; i <= 7; i++) {
    addBox(root, railMat, 0.06, 0.55, 0.06, -W * 0.38 + (W * 0.76 * i) / 7, upY + 0.34, -D * 0.1 + D * 0.2 + 0.44);
  }
  addBox(root, railMat, W * 0.8, 0.06, 0.08, 0, upY + 0.6, -D * 0.1 + D * 0.2 + 0.44);
  // 屋頂
  const lowerRoof = addChineseRoof(root, lib, {
    width: W * 0.98,
    depth: D * 0.82,
    height: 0.72,
    ridge: W * 0.72,
    cornerLift: 0.18,
    cornerFlare: 0.12,
    tileColor: PAL.tile,
    ornaments: 'simple',
    y: upY + 0.02,
    slopeSegments: 5,
    edgeSegments: 6,
  });
  lowerRoof.position.z = -D * 0.1;
  addChineseRoof(root, lib, {
    width: W * 0.82,
    depth: D * 0.62,
    height: 0.9,
    ridge: W * 0.56,
    cornerLift: 0.2,
    cornerFlare: 0.1,
    tileColor: PAL.tile,
    ornaments: 'gold',
    y: upY + 1.55,
    z: -D * 0.1,
    slopeSegments: 6,
    edgeSegments: 6,
  });
  addPlaque(root, lib, 0, 1.84, -D * 0.1 + D * 0.2 + 0.12, '客棧', { w: 0.9, h: 0.3 });
  addBanner(root, lib, -W * 0.44, 0.16, D * 0.22, { height: 4.1, text: '酒', bg: PAL.clothRed, ry: 0.3 });
  // 馬樁與水槽
  const horse = new THREE.Group();
  horse.position.set(W * 0.42, 0.16, D * 0.28);
  root.add(horse);
  addCylinder(horse, lib.lambert(PAL.wood), 0.07, 0.09, 0.9, 0, 0.45, 0, 6);
  addBox(horse, lib.lambert(PAL.woodDark), 0.2, 0.08, 0.2, 0, 0.9, 0);
  addBox(horse, lib.lambert(PAL.stone), 0.8, 0.26, 0.36, -0.5, 0.13, 0.18);
  addBox(horse, lib.lambert(PAL.water), 0.66, 0.03, 0.24, -0.5, 0.26, 0.18);
  // 戶外桌椅
  addTable(root, lib, -W * 0.26, 0.16, D * 0.38, 0.7, 0.55, 0.55);
  addStool(root, lib, -W * 0.4, 0.16, D * 0.38, 0.13, 0.36);
  addHangingLantern(root, lib, -W * 0.32, 1.85, D * 0.2, { rope: 0.2, scale: 0.9 });
  addHangingLantern(root, lib, W * 0.4, 1.85, D * 0.16, { rope: 0.2, scale: 0.9 });
}

// ─────────────────────────── 民生 ───────────────────────────

/** 水井：石井圈、木井架、轆轤、吊桶。 */
function buildWell(ctx: Ctx): void {
  const { lib, root } = ctx;
  addPavedGround(root, lib, ctx.W * 0.9, ctx.D * 0.9, 0, 0, { color: PAL.stone, tile: 0.7, y: 0.08, thickness: 0.16 });
  const stone = lib.lambert(PAL.stone);
  const stoneLight = lib.lambert(PAL.stoneLight);
  // 井圈（八角）
  addCylinder(root, stone, 0.5, 0.56, 0.5, 0, 0.33, 0, 8);
  addCylinder(root, stoneLight, 0.58, 0.58, 0.08, 0, 0.6, 0, 8);
  addCylinder(root, lib.basic(PAL.water), 0.4, 0.4, 0.03, 0, 0.5, 0, 8);
  // 井架
  const wood = lib.lambert(PAL.woodDark);
  addCylinder(root, wood, 0.05, 0.06, 1.5, -0.62, 0.83, 0, 5);
  addCylinder(root, wood, 0.05, 0.06, 1.5, 0.62, 0.83, 0, 5);
  addBox(root, wood, 1.5, 0.1, 0.1, 0, 1.58, 0);
  // 轆轤
  addCylinder(root, lib.lambert(PAL.wood), 0.13, 0.13, 1.0, 0, 1.42, 0, 9, 0, Math.PI / 2);
  addBox(root, lib.lambert(PAL.woodLight), 0.06, 0.5, 0.06, 0.72, 1.42, 0, 0.5);
  // 繩與吊桶
  addCylinder(root, lib.lambert(PAL.woodBlack), 0.014, 0.014, 0.9, 0, 0.92, 0, 4);
  addCylinder(root, lib.lambert(PAL.woodLight), 0.13, 0.11, 0.22, 0, 0.38, 0, 8);
  // 小瓦頂（曲簷）
  addChineseRoof(root, lib, {
    width: 1.75,
    depth: 1.3,
    height: 0.42,
    ridge: 0.7,
    cornerLift: 0.14,
    cornerFlare: 0.1,
    tileColor: PAL.tile,
    ornaments: 'none',
    y: 1.64,
    slopeSegments: 4,
    edgeSegments: 5,
  });
  // 草地與小石
  addRock(root, lib.lambert(PAL.stoneDark), -0.68, 0.55, 0.5, 5);
  addCone(root, lib.lambert(PAL.leaf), 0.12, 0.3, 0.55, 0.22, -0.55, 5);
  addCone(root, lib.lambert(PAL.leafDark), 0.1, 0.26, 0.7, 0.2, 0.5, 5);
  addWaterJar(root, lib, 0.68, 0.16, 0.5, 0.8);
}

/** 寺廟：紅牆大殿、重簷、佛龕金身、石獅、香爐、鐘。 */
function buildTemple(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.stone, tile: 0.8, y: 0.1, thickness: 0.2 });
  // 月台與台階
  addBox(root, lib.lambert(PAL.stoneLight), W * 0.8, 0.22, D * 0.62, 0, 0.2, D * 0.1);
  addSteps(root, lib, 0, 0.3, D * 0.1 + D * 0.31 + 0.16, 2.4, 3, 0.1, 0.22);
  // 大殿
  const hall = addHall(ctx, {
    x: 0,
    z: -D * 0.06,
    w: W * 0.72,
    d: D * 0.4,
    wallH: 2.0,
    wallColor: PAL.wallRed,
    openFront: true,
    pillars: 4,
    door: null,
    windows: 0,
    plaque: null,
    lanterns: false,
    floorY: 0.32,
    baseColor: PAL.stoneLight,
    noRoof: true,
  });
  // 重簷：下簷＋上簷
  const lower = addChineseRoof(root, lib, {
    width: W * 0.94,
    depth: D * 0.56,
    height: 0.85,
    ridge: W * 0.7,
    cornerLift: 0.22,
    cornerFlare: 0.14,
    tileColor: PAL.tile,
    ornaments: 'simple',
    y: 2.34,
    z: -D * 0.06,
    slopeSegments: 6,
    edgeSegments: 7,
  });
  lower.updateMatrix();
  // 上層明間
  addBox(root, lib.lambert(PAL.wallRedDark), W * 0.4, 0.75, D * 0.24, 0, 2.6, -D * 0.06);
  addLatticeWindow(root, lib, 0, 2.62, -D * 0.06 + D * 0.12 + 0.02, { w: 0.6, h: 0.5 });
  addChineseRoof(root, lib, {
    width: W * 0.68,
    depth: D * 0.36,
    height: 0.9,
    ridge: W * 0.45,
    cornerLift: 0.22,
    cornerFlare: 0.12,
    tileColor: PAL.tile,
    ornaments: 'gold',
    y: 3.0,
    z: -D * 0.06,
    slopeSegments: 6,
    edgeSegments: 6,
  });
  addFinial(root, lib, 0, 3.9, -D * 0.06, 1.05);
  // 匾額「大雄寶殿」
  addPlaque(root, lib, 0, 2.08, -D * 0.06 + D * 0.2 + 0.16, '大雄寶殿', { w: 1.3, h: 0.34 });
  // 佛龕金身（敞開的前殿內）
  const shrine = new THREE.Group();
  shrine.position.set(0, 0.32, -D * 0.18);
  root.add(shrine);
  addLathe(shrine, lib.lambert(PAL.gold, { emissive: 0x5a3d10, emissiveIntensity: 0.35 }), [
    [0.001, 0],
    [0.42, 0.04],
    [0.36, 0.2],
    [0.001, 0.28],
  ], 0, 0, 0, 12);
  const body = addSphere(shrine, lib.lambert(PAL.gold), 0.3, 0, 0.62, 0, 9, 7);
  body.scale.set(0.9, 1.15, 0.7);
  addSphere(shrine, lib.lambert(PAL.gold), 0.17, 0, 0.98, 0.02, 8, 6);
  addCylinder(shrine, lib.lambert(PAL.gold), 0.06, 0.09, 0.12, 0, 1.14, 0.02, 6);
  // 供桌與燭台
  addBox(shrine, lib.lambert(PAL.pillarRedDark), 1.0, 0.5, 0.36, 0, 0.25, 0.6);
  for (const cx of [-0.28, 0.28]) {
    addCylinder(shrine, lib.lambert(PAL.goldDark), 0.03, 0.04, 0.2, cx, 0.6, 0.6, 5);
    const flame = lib.basic(0xffcf7a, { toneMapped: false });
    addCone(shrine, flame, 0.035, 0.1, cx, 0.74, 0.6, 5);
  }
  // 石獅、香爐
  addStoneLion(root, lib, -W * 0.38, D * 0.3, 1.25, 0.3);
  addStoneLion(root, lib, W * 0.38, D * 0.3, 1.25, -0.3);
  addIncenseBurner(root, lib, 0, 0.32, D * 0.36, 1.15);
  // 香客跪墊
  for (const cx of [-0.4, 0, 0.4]) {
    addBox(root, lib.lambert(PAL.clothRed), 0.34, 0.08, 0.26, cx, 0.36, D * 0.2);
  }
  // 鐘與鼓
  const bell = new THREE.Group();
  bell.position.set(-W * 0.4, 0.32, -D * 0.22);
  root.add(bell);
  addBox(bell, lib.lambert(PAL.wood), 0.1, 1.7, 0.1, -0.35, 0.85, 0);
  addBox(bell, lib.lambert(PAL.wood), 0.1, 1.7, 0.1, 0.35, 0.85, 0);
  addBox(bell, lib.lambert(PAL.woodDark), 0.9, 0.1, 0.1, 0, 1.7, 0);
  addLathe(bell, lib.lambert(PAL.bronze), [
    [0.001, 0],
    [0.24, 0.02],
    [0.22, 0.3],
    [0.12, 0.5],
    [0.001, 0.52],
  ], 0, 0.6, 0, 10);
  // 柏樹與幡
  addTree(root, lib, -W * 0.42, -D * 0.42, 0.85, 'cypress', 7);
  addTree(root, lib, W * 0.42, -D * 0.42, 0.85, 'cypress', 8);
  addBanner(root, lib, -W * 0.44, 0.32, D * 0.02, { height: 3.0, text: '佛', bg: PAL.clothYellow, ry: 0.3 });
  addBanner(root, lib, W * 0.44, 0.32, D * 0.02, { height: 3.0, text: '禪', bg: PAL.clothRed, ry: -0.3 });
  addHangingLantern(root, lib, -W * 0.26, 2.28, D * 0.14, { rope: 0.25, scale: 1.05 });
  addHangingLantern(root, lib, W * 0.26, 2.28, D * 0.14, { rope: 0.25, scale: 1.05 });
}

/** 學堂：圍牆院落、講堂、書案、碑、柏樹。 */
function buildSchool(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.96;
  const D = ctx.D * 0.96;
  addPavedGround(root, lib, W * 0.94, D * 0.94, 0, 0, { color: PAL.stone, tile: 0.9, y: 0.08, thickness: 0.16 });
  // 圍牆（前留門）
  const hx = W / 2 - 0.06;
  const hz = D / 2 - 0.06;
  wallSegment(ctx, -hx, -hz, hx, -hz, 1.0, 0.1);
  wallSegment(ctx, -hx, -hz, -hx, hz, 1.0, 0.1);
  wallSegment(ctx, hx, -hz, hx, hz, 1.0, 0.1);
  wallSegment(ctx, -hx, hz, -0.75, hz, 1.0, 0.1);
  wallSegment(ctx, 0.75, hz, hx, hz, 1.0, 0.1);
  // 門樓
  const gate = new THREE.Group();
  gate.position.set(0, 0.1, hz);
  root.add(gate);
  const pillar = lib.lambert(PAL.pillarRed);
  addCylinder(gate, pillar, 0.07, 0.09, 1.4, -0.6, 0.7, 0, 6);
  addCylinder(gate, pillar, 0.07, 0.09, 1.4, 0.6, 0.7, 0, 6);
  addBox(gate, lib.lambert(PAL.woodDark), 1.3, 0.1, 0.14, 0, 1.4, 0);
  addDoor(gate, lib, 0, 0.62, 0.03, { w: 0.85, h: 1.1, panels: 2, color: PAL.wood });
  addSmallGableRoof(gate, lib, 0, 1.48, 0, 1.7, 1.2, 0.34);
  addPlaque(gate, lib, 0, 1.3, 0.14, '學堂', { w: 0.7, h: 0.28 });
  // 講堂
  addHall(ctx, {
    x: 0,
    z: -D * 0.18,
    w: W * 0.62,
    d: D * 0.3,
    wallH: 1.55,
    wallColor: PAL.wallCream,
    openFront: true,
    pillars: 3,
    door: null,
    windows: 0,
    lanterns: false,
    roof: { h: 0.9, ridge: W * 0.46, ornaments: 'simple' },
  });
  // 講堂內的書案
  const deskGroup = new THREE.Group();
  deskGroup.position.set(0, 0.16, -D * 0.2);
  root.add(deskGroup);
  addTable(deskGroup, lib, 0, 0, 0, 1.0, 0.5, 0.6);
  addBox(deskGroup, lib.lambert(PAL.paper), 0.4, 0.03, 0.3, 0.2, 0.64, 0);
  addBox(deskGroup, lib.lambert(PAL.woodBlack), 0.06, 0.12, 0.06, 0.32, 0.68, 0.06);
  for (const dx of [-0.5, 0.5]) {
    addTable(deskGroup, lib, dx, 0, 0.5, 0.5, 0.35, 0.45);
    addStool(deskGroup, lib, dx, 0, 0.75, 0.11, 0.3);
  }
  // 碑
  addBox(root, lib.lambert(PAL.stoneDark), 0.6, 0.1, 0.5, -W * 0.3, 0.13, -D * 0.02);
  addBox(root, lib.lambert(PAL.stoneLight), 0.5, 0.9, 0.16, -W * 0.3, 0.6, -D * 0.02);
  addPlaque(root, lib, -W * 0.3, 0.7, -D * 0.02 + 0.1, '禮', { w: 0.34, h: 0.5 });
  // 柏樹與鐘
  addTree(root, lib, W * 0.3, -D * 0.02, 0.8, 'cypress', 6);
  addTree(root, lib, -W * 0.4, -D * 0.36, 0.6, 'pine', 9);
  addCylinder(root, lib.lambert(PAL.woodDark), 0.04, 0.05, 1.1, W * 0.38, 0.65, D * 0.28, 5);
  addLathe(root, lib.lambert(PAL.bronze), [
    [0.001, 0],
    [0.16, 0.02],
    [0.15, 0.22],
    [0.08, 0.34],
    [0.001, 0.36],
  ], W * 0.38, 1.16, D * 0.28, 8);
  addBanner(root, lib, -W * 0.44, 0.1, D * 0.3, { height: 2.7, text: '學', bg: PAL.clothBlue, ry: 0.3 });
}

/** 衙門：照壁門樓、大堂、六房廂房、鳴冤鼓、肅靜迴避旗。 */
function buildYamen(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.97;
  const D = ctx.D * 0.97;
  addPavedGround(root, lib, W, D, 0, 0, { color: PAL.stone, tile: 0.95, y: 0.1, thickness: 0.2 });
  // 外圍牆
  const hx = W / 2 - 0.06;
  const hz = D / 2 - 0.06;
  wallSegment(ctx, -hx, -hz, hx, -hz, 1.35, 0.1);
  wallSegment(ctx, -hx, -hz, -hx, hz, 1.35, 0.1);
  wallSegment(ctx, hx, -hz, hx, hz, 1.35, 0.1);
  wallSegment(ctx, -hx, hz, -1.6, hz, 1.35, 0.1);
  wallSegment(ctx, 1.6, hz, hx, hz, 1.35, 0.1);
  // 門樓（三開間）
  const gate = new THREE.Group();
  gate.position.set(0, 0.1, hz);
  root.add(gate);
  const pillar = lib.lambert(PAL.pillarRed);
  for (const px of [-1.3, -0.45, 0.45, 1.3]) {
    addCylinder(gate, pillar, 0.1, 0.12, 1.9, px, 0.95, 0, 7);
  }
  addBox(gate, lib.lambert(PAL.pillarRedDark), 2.9, 0.14, 0.16, 0, 1.86, 0);
  addDoor(gate, lib, 0, 0.75, 0.04, { w: 1.0, h: 1.4, panels: 2, color: PAL.pillarRedDark, studs: true });
  addChineseRoof(gate, lib, {
    width: 3.3,
    depth: 1.5,
    height: 0.62,
    ridge: 2.4,
    cornerLift: 0.16,
    cornerFlare: 0.12,
    tileColor: PAL.tile,
    ornaments: 'simple',
    y: 1.95,
    slopeSegments: 5,
    edgeSegments: 6,
  });
  addPlaque(gate, lib, 0, 1.68, 0.14, '衙門', { w: 1.0, h: 0.3 });
  // 石獅、鼓、旗
  addStoneLion(root, lib, -2.0, D / 2 + 0.2, 1.35, 0.35);
  addStoneLion(root, lib, 2.0, D / 2 + 0.2, 1.35, -0.35);
  addDrum(root, lib, -1.25, D * 0.3, 1.25, 0.4);
  addDrum(root, lib, 1.25, D * 0.3, 1.25, -0.4);
  addBanner(root, lib, -2.35, 0.1, D * 0.34, { height: 3.8, text: '肅靜', bg: PAL.clothRed, ry: 0.3 });
  addBanner(root, lib, 2.35, 0.1, D * 0.34, { height: 3.8, text: '迴避', bg: PAL.clothRed, ry: -0.3 });
  // 甬道
  addBox(root, lib.lambert(PAL.stoneLight), 1.4, 0.04, D * 0.46, 0, 0.13, D * 0.03);
  // 大堂（後方高台）
  addBox(root, lib.lambert(PAL.stoneLight), W * 0.72, 0.3, D * 0.4, 0, 0.16, -D * 0.2);
  addSteps(root, lib, 0, 0.32, -D * 0.02, 2.6, 3, 0.1, 0.22);
  const hall = addHall(ctx, {
    x: 0,
    z: -D * 0.22,
    w: W * 0.62,
    d: D * 0.3,
    wallH: 2.1,
    wallColor: PAL.wallRed,
    openFront: true,
    pillars: 4,
    door: null,
    windows: 0,
    lanterns: false,
    floorY: 0.32,
    baseColor: PAL.stoneLight,
    noRoof: true,
  });
  // 大堂內：公案、屏風、明鏡高懸
  const desk = new THREE.Group();
  desk.position.set(0, 0.32, -D * 0.2);
  root.add(desk);
  addBox(desk, lib.lambert(PAL.pillarRedDark), 1.5, 0.16, 0.66, 0, 0.85, 0.1);
  addBox(desk, lib.lambert(PAL.pillarRedDark), 1.3, 0.7, 0.5, 0, 0.42, 0.1);
  addBox(desk, lib.lambert(PAL.gold), 0.26, 0.2, 0.14, 0.3, 0.98, 0.32);
  addBox(desk, lib.lambert(PAL.woodDark), 0.5, 0.4, 0.1, 0, 1.0, -0.2);
  addBox(desk, lib.lambert(PAL.paper), 0.3, 0.2, 0.02, 0.25, 1.0, 0.18);
  // 屏風
  addBox(desk, lib.lambert(PAL.pillarRedDark), 2.3, 1.3, 0.08, 0, 0.9, -0.7);
  addBox(desk, lib.lambert(PAL.gold), 1.9, 0.9, 0.02, 0, 0.95, -0.64);
  // 明鏡高懸匾
  addPlaque(root, lib, 0, 2.5, -D * 0.22 + D * 0.15 + 0.18, '明鏡高懸', { w: 1.5, h: 0.38 });
  // 重簷大堂
  addChineseRoof(root, lib, {
    width: W * 0.8,
    depth: D * 0.44,
    height: 0.9,
    ridge: W * 0.6,
    cornerLift: 0.22,
    cornerFlare: 0.14,
    tileColor: PAL.tile,
    ornaments: 'simple',
    y: 2.52,
    z: -D * 0.22,
    slopeSegments: 6,
    edgeSegments: 7,
  });
  addBox(root, lib.lambert(PAL.wallRedDark), W * 0.38, 0.6, D * 0.18, 0, 2.75, -D * 0.22);
  addChineseRoof(root, lib, {
    width: W * 0.56,
    depth: D * 0.3,
    height: 0.8,
    ridge: W * 0.4,
    cornerLift: 0.2,
    cornerFlare: 0.1,
    tileColor: PAL.tile,
    ornaments: 'gold',
    y: 3.05,
    z: -D * 0.22,
    slopeSegments: 6,
    edgeSegments: 6,
  });
  addFinial(root, lib, 0, 3.85, -D * 0.22, 1.0);
  // 六房廂房
  for (const side of [-1, 1]) {
    const wing = addHall(ctx, {
      x: side * (W * 0.33),
      z: D * 0.02,
      w: W * 0.18,
      d: D * 0.34,
      wallH: 1.3,
      door: { w: 0.4, h: 0.8, panels: 1 },
      windows: 1,
      lanterns: false,
      steps: false,
      roof: { h: 0.55, ridge: 0.8, ornaments: 'none', ridgeAlongZ: true },
    });
    wing.rotation.y = side * -0.04;
  }
  // 庭院柏樹、燈籠
  addTree(root, lib, -W * 0.3, D * 0.34, 0.8, 'cypress', 11);
  addTree(root, lib, W * 0.3, D * 0.34, 0.8, 'cypress', 12);
  addHangingLantern(root, lib, -1.2, 2.4, -D * 0.06, { rope: 0.25, scale: 1.05 });
  addHangingLantern(root, lib, 1.2, 2.4, -D * 0.06, { rope: 0.25, scale: 1.05 });
  if (hall) {
    // 大堂前的衙役水火棍
    for (const sx of [-1.4, 1.4]) {
      for (let i = 0; i < 3; i++) {
        addCylinder(root, lib.lambert(i === 1 ? PAL.clothRed : PAL.woodDark), 0.035, 0.035, 1.5, sx + i * 0.1, 0.85, -D * 0.04, 5);
      }
    }
  }
}

// ─────────────────────────── 裝飾／碼頭 ───────────────────────────

/** 涼亭：石台、四柱、重簷攢尖、欄凳、石桌。 */
function buildPavilion(ctx: Ctx): void {
  const { lib, root } = ctx;
  // 石台
  addCylinder(root, lib.lambert(PAL.stone), 0.92, 1.0, 0.22, 0, 0.11, 0, 8);
  addSteps(root, lib, 0, 0.24, 0.92, 0.9, 2, 0.08, 0.18);
  const pillar = lib.lambert(PAL.pillarRed);
  const wood = lib.lambert(PAL.wood);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    addCylinder(root, pillar, 0.07, 0.09, 1.8, Math.cos(a) * 0.62, 1.12, Math.sin(a) * 0.62, 7);
  }
  // 欄凳
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const x = Math.cos(a) * 0.58;
    const z = Math.sin(a) * 0.58;
    addBox(root, wood, 0.9, 0.08, 0.22, x, 0.68, z, -a);
    addBox(root, lib.lambert(PAL.woodDark), 0.9, 0.05, 0.06, x, 0.86, z, -a);
  }
  // 簷枋
  addBox(root, lib.lambert(PAL.pillarRedDark), 1.3, 0.1, 0.1, 0, 1.9, 0);
  addBox(root, lib.lambert(PAL.pillarRedDark), 0.1, 0.1, 1.3, 0, 1.9, 0);
  // 重簷
  addChineseRoof(root, lib, {
    width: 2.0,
    depth: 2.0,
    height: 0.42,
    ridge: 0,
    cornerLift: 0.22,
    cornerFlare: 0.16,
    tileColor: PAL.tile,
    ornaments: 'none',
    y: 1.92,
    slopeSegments: 4,
    edgeSegments: 6,
  });
  addChineseRoof(root, lib, {
    width: 1.35,
    depth: 1.35,
    height: 0.62,
    ridge: 0,
    cornerLift: 0.15,
    cornerFlare: 0.1,
    tileColor: PAL.tile,
    ornaments: 'none',
    y: 2.3,
    slopeSegments: 5,
    edgeSegments: 5,
  });
  addFinial(root, lib, 0, 2.9, 0, 0.85);
  // 石桌與茶具
  addCylinder(root, lib.lambert(PAL.stoneLight), 0.24, 0.26, 0.5, 0, 0.48, 0, 8);
  addCylinder(root, lib.lambert(PAL.stoneLight), 0.32, 0.32, 0.06, 0, 0.76, 0, 8);
  addLathe(root, lib.lambert(PAL.clothWhite), [
    [0.001, 0],
    [0.07, 0.02],
    [0.09, 0.1],
    [0.05, 0.16],
    [0.001, 0.18],
  ], 0.1, 0.79, 0.05, 8);
  // 吊燈與小樹
  addHangingLantern(root, lib, 0, 2.3, 0, { rope: 0.25, scale: 0.75 });
  addTree(root, lib, 0.82, -0.66, 0.5, 'pine', 13);
}

/** 碼頭：木棧橋、貨棚、吊臂、貨船。 */
function buildDock(ctx: Ctx): void {
  const { lib, root } = ctx;
  const W = ctx.W * 0.98;
  const D = ctx.D * 0.98;
  const wood = lib.lambert(PAL.wood);
  const woodLight = lib.lambert(PAL.woodLight);
  const woodDark = lib.lambert(PAL.woodDark);
  // 岸上地基
  addBox(root, lib.lambert(PAL.stoneDark), W * 0.5, 0.22, D, -W * 0.24, 0.11, 0);
  addPavedGround(root, lib, W * 0.48, D * 0.94, -W * 0.24, 0, { color: PAL.stone, tile: 0.9, y: 0.22, thickness: 0.04 });
  // 貨棚（面向 +x）
  const shed = new THREE.Group();
  shed.position.set(-W * 0.24, 0.24, -D * 0.05);
  root.add(shed);
  addBox(shed, woodDark, 1.9, 0.1, 2.6, 0, 0.05, 0);
  addBox(shed, lib.lambert(PAL.wallCream), 0.16, 1.5, 2.4, -0.86, 0.85, 0);
  addBox(shed, lib.lambert(PAL.wallCream), 1.7, 1.5, 0.16, 0, 0.85, -1.2);
  for (const [px, pz] of [
    [0.8, -1.1],
    [0.8, 1.1],
    [-0.8, 0.05],
    [0.8, 0.05],
  ]) {
    addCylinder(shed, wood, 0.07, 0.09, 1.6, px, 0.85, pz, 6);
  }
  addChineseRoof(shed, lib, {
    width: 3.0,
    depth: 2.9,
    height: 0.72,
    ridge: 2.0,
    cornerLift: 0.16,
    cornerFlare: 0.1,
    tileColor: PAL.thatch,
    ornaments: 'none',
    y: 1.66,
    z: 0,
    slopeSegments: 4,
    edgeSegments: 5,
  });
  addPlaque(shed, lib, 0.92, 1.3, 0.2, '碼頭', { w: 0.8, h: 0.28, ry: Math.PI / 2 });
  // 貨物
  addCrate(shed, lib, -0.2, 0.1, 0.2, 0.5);
  addCrate(shed, lib, 0.3, 0.1, -0.2, 0.42);
  addBarrel(shed, lib, 0.3, 0.1, 0.5, 0.36);
  // 棧橋（往 +x 伸入水面）
  const pierLen = W * 0.8;
  addBox(root, woodLight, pierLen, 0.12, 1.6, W * 0.06, 0.4, 0);
  for (let i = 0; i < 7; i++) {
    addBox(root, woodDark, 0.1, 0.06, 1.65, -W * 0.3 + (pierLen / 6) * i, 0.42, 0);
  }
  // 橋樁
  for (let i = 0; i < 4; i++) {
    for (const pz of [-0.74, 0.74]) {
      addCylinder(root, woodDark, 0.08, 0.09, 1.2, W * 0.0 + i * (pierLen / 3.2), 0, pz, 6);
    }
  }
  // 吊臂
  const crane = new THREE.Group();
  crane.position.set(W * 0.36, 0.46, 0);
  root.add(crane);
  addCylinder(crane, wood, 0.08, 0.1, 1.9, 0, 0.95, 0, 6);
  addBox(crane, woodDark, 1.5, 0.1, 0.1, 0.55, 1.86, 0);
  addBeamHelper(crane, lib, new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(1.1, 1.86, 0), 0.07);
  addCylinder(crane, lib.lambert(PAL.woodBlack), 0.015, 0.015, 1.3, 1.25, 1.2, 0, 4);
  addCrate(root, lib, W * 0.36 + 1.25, 0.42, 0, 0.38);
  // 碼頭燈
  addCylinder(root, woodDark, 0.04, 0.05, 1.3, W * 0.44, 0.9, 0.82, 5);
  addHangingLantern(root, lib, W * 0.44 - 0.02, 1.5, 0.82, { rope: 0.12, scale: 0.85 });
  // 貨船（泊在棧橋旁）
  const boat = new THREE.Group();
  boat.position.set(W * 0.1, 0.06, D * 0.34);
  boat.userData.anim = 'bob';
  root.add(boat);
  const hullMat = woodDark;
  addBox(boat, hullMat, 2.0, 0.34, 0.9, 0, 0.17, 0);
  const bow = addCone(boat, hullMat, 0.45, 0.7, 1.15, 0.2, 0, 5, -Math.PI / 2);
  bow.rotation.z = -Math.PI / 2;
  addBox(boat, woodLight, 1.9, 0.06, 0.94, 0, 0.36, 0);
  addBox(boat, lib.lambert(PAL.clothWhite), 0.7, 0.5, 0.7, -0.3, 0.6, 0);
  addSmallGableRoof(boat, lib, -0.3, 0.86, 0, 0.9, 0.9, 0.2);
  addCylinder(boat, wood, 0.035, 0.045, 2.2, 0.4, 1.4, 0, 5);
  addBox(boat, lib.lambert(PAL.clothWhite), 0.7, 0.9, 0.04, 0.62, 1.75, 0);
  // 繩圈與魚簍
  addCylinder(root, lib.lambert(PAL.thatchDark), 0.2, 0.2, 0.08, -W * 0.36, 0.36, D * 0.32, 10);
  addBasket(root, lib, -W * 0.42, 0.24, -D * 0.3, 0.2, PAL.water);
  addSack(root, lib, -W * 0.4, 0.24, D * 0.1, 0.9);
}

/** box 樑的小工具（避免 import 循環，直接用 geometry-utils 的 addBeamBetween 包裝）。 */
function addBeamHelper(parent: THREE.Object3D, lib: MaterialLibrary, a: THREE.Vector3, b: THREE.Vector3, t: number): void {
  // 以小段圓柱拼成斜撐
  const dir = b.clone().sub(a);
  const len = dir.length();
  const mesh = addCylinder(parent, lib.lambert(PAL.wood), t, t, len, a.x + dir.x / 2, a.y + dir.y / 2, a.z + dir.z / 2, 5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
}

// ─────────────────────────── 原型工廠 ───────────────────────────

type Builder = (ctx: Ctx) => void;

const BUILDERS: Record<string, Builder> = {
  hut: buildHut,
  house: buildHouse,
  manor: buildManor,
  farm: buildFarm,
  teaFarm: buildTeaFarm,
  lumber: buildLumber,
  quarry: buildQuarry,
  ironMine: buildIronMine,
  brewery: buildBrewery,
  weaver: buildWeaver,
  blacksmith: buildBlacksmith,
  granary: buildGranary,
  warehouse: buildWarehouse,
  market: buildMarket,
  teahouse: buildTeahouse,
  inn: buildInn,
  well: buildWell,
  temple: buildTemple,
  school: buildSchool,
  yamen: buildYamen,
  pavilion: buildPavilion,
  dock: buildDock,
};

/** 每種建築可用的外觀變體數量（用 building.id 取模，讓同類建築不至於一模一樣）。 */
const VARIANTS: Record<string, number> = {
  hut: 2,
  house: 2,
  farm: 2,
  lumber: 2,
  market: 2,
  teaFarm: 2,
};

const FALLBACK: Builder = (ctx) => {
  const { lib, root } = ctx;
  addHall(ctx, {
    w: ctx.W * 0.8,
    d: ctx.D * 0.8,
    wallH: 1.2,
    door: { w: 0.6, h: 1.0 },
    windows: 2,
    roof: { ornaments: 'simple' },
  });
  addTree(root, lib, -ctx.W * 0.35, -ctx.D * 0.35, 0.6, 'pine', 21);
};

export function createPrototypeFactory(lib: MaterialLibrary): PrototypeFactory {
  const cache = new Map<string, BuildingPrototype>();

  const build = (key: string, variant: number): BuildingPrototype => {
    const def = BUILDINGS[key];
    const wTiles = def?.size[0] ?? 1;
    const hTiles = def?.size[1] ?? 1;
    const W = wTiles * TILE;
    const D = hTiles * TILE;
    const root = new THREE.Group();
    root.name = `proto:${key}#${variant}`;
    const ctx: Ctx = {
      lib,
      root,
      def: def ?? {
        key,
        name: key,
        desc: '',
        category: 'decoration',
        size: [1, 1],
        cost: 0,
        upkeep: 0,
        workers: 0,
        housing: 0,
        unlockPop: 0,
        color: 0xffffff,
      },
      w: wTiles,
      h: hTiles,
      W,
      D,
      variant,
    };
    const builder = BUILDERS[key] ?? FALLBACK;
    builder(ctx);
    mergeStaticMeshes(root, lib);
    const proto: BuildingPrototype = { key, variant, root, footprintW: W, footprintD: D };
    cache.set(`${key}#${variant}`, proto);
    return proto;
  };

  return {
    get(key: string, variant = 0): BuildingPrototype {
      const count = VARIANTS[key] ?? 1;
      const v = count > 1 ? ((variant % count) + count) % count : 0;
      const id = `${key}#${v}`;
      return cache.get(id) ?? build(key, v);
    },
    variantCount(key: string): number {
      return VARIANTS[key] ?? 1;
    },
    dispose(): void {
      for (const proto of cache.values()) {
        proto.root.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) mesh.geometry?.dispose();
        });
      }
      cache.clear();
    },
  };
}
