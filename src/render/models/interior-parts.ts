/**
 * 華夏古城 — 室內場景零件庫（architecture-dev）
 *
 * 提供室內專用的程序化貼圖（木地板、粉牆、窗外山水、水墨屏風）、
 * 家具（床榻、桌凳、貨架、酒罈、織機、鐵砧、佛龕、公案……）、
 * 人物象徵與燈籠煙火微動標記。interior.ts 依建築類型組合這些零件。
 */

import * as THREE from 'three';
import { MaterialLibrary, PAL } from './materials';
import {
  addBox,
  addCone,
  addCylinder,
  addLathe,
  addPlane,
  addSphere,
  type Mat,
} from './geometry-utils';
import {
  addBarrel,
  addBasket,
  addCrate,
  addHangingLantern,
  addPlaque,
  addSack,
  addSmoke,
  addStool,
  addTable,
  addWaterJar,
  addWineJar,
  markAnim,
} from './chinese-parts';

// ─────────────────────────── 室內色調 ───────────────────────────

export const IPAL = {
  floor: 0x6b4a2f,
  floorDark: 0x4e3420,
  floorLight: 0x8a623d,
  wall: 0xdcd0b8,
  wallWarm: 0xd6c6a8,
  wallRed: 0x9e3a2e,
  ceiling: 0x4a3524,
  beam: 0x5c3f27,
  beamDark: 0x3e2a1a,
  pillar: 0xa63e31,
  pillarDark: 0x7d2b24,
  wood: 0x7a5232,
  woodLight: 0xa37d4f,
  woodDark: 0x4a2f1c,
  woodBlack: 0x2c2015,
  ceramic: 0x6e5a45,
  ceramicDark: 0x514233,
  gold: 0xc9a24c,
  goldDark: 0x93712f,
  stone: 0x8f8b80,
  stoneDark: 0x6b675c,
  stoneLight: 0xb0ac9f,
  iron: 0x4a515c,
  paper: 0xefe2c4,
  ink: 0x2a241c,
  clothRed: 0xa63e31,
  clothBlue: 0x466880,
  clothTeal: 0x4e7f74,
  clothGold: 0xb99247,
  clothPink: 0xc08a9a,
  clothWhite: 0xe8dfcc,
  clothGreen: 0x6f8f5f,
  leaf: 0x5f7f4a,
  leafDark: 0x48643a,
  skin: 0xe0b48c,
  hair: 0x241a12,
  candle: 0xffd79a,
  fire: 0xff7a32,
  water: 0x4d7f9b,
  tea: 0x7f9a5f,
  grain: 0xd7b25a,
  ore: 0x7a6a58,
  bronze: 0x8a6f43,
  thatch: 0xb59a5c,
  thatchLight: 0xc9b077,
  thatchDark: 0x8b7443,
} as const;

// ─────────────────────────── 貼圖與共用材質 ───────────────────────────

export interface InteriorAssets {
  floorMat: THREE.Material;
  wallMat: THREE.Material;
  ceilingMat: THREE.Material;
  windowViewMat: THREE.MeshBasicMaterial;
  inkPaintingMat: THREE.MeshBasicMaterial;
  latticePaperMat: THREE.Material;
}

/** 程序化木地板貼圖（橫向木板＋木紋）。 */
function makeFloorTexture(lib: MaterialLibrary): THREE.Texture | null {
  const tex = lib.canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = '#6b4a2f';
    ctx.fillRect(0, 0, 512, 512);
    const rowH = 52;
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let y = 0; y < 512; y += rowH) {
      const shade = 0.82 + rand() * 0.32;
      const r = Math.round(0x6b * shade);
      const g = Math.round(0x4a * shade);
      const b = Math.round(0x2f * shade);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, 512, rowH - 2);
      // 木紋
      for (let i = 0; i < 6; i++) {
        ctx.strokeStyle = `rgba(40,24,12,${0.08 + rand() * 0.1})`;
        ctx.lineWidth = 1 + rand() * 1.5;
        ctx.beginPath();
        const baseY = y + 6 + rand() * (rowH - 12);
        ctx.moveTo(0, baseY);
        for (let x = 0; x <= 512; x += 64) {
          ctx.lineTo(x, baseY + Math.sin((x / 512) * Math.PI * 2 + i) * 3);
        }
        ctx.stroke();
      }
      // 板縫
      ctx.fillStyle = 'rgba(30,18,10,0.55)';
      ctx.fillRect(0, y + rowH - 2, 512, 2);
      // 錯縫
      const offset = (Math.floor(y / rowH) % 2) * 128;
      ctx.fillRect(offset, y, 2, rowH);
    }
  });
  if (tex) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 2.4);
  }
  return tex;
}

/** 粉牆貼圖（米白、微污漬、底部暗帶）。 */
function makeWallTexture(lib: MaterialLibrary): THREE.Texture | null {
  const tex = lib.canvasTexture(256, 256, (ctx) => {
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#ded2b9');
    grad.addColorStop(0.72, '#d8cbb0');
    grad.addColorStop(1, '#c8b899');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    let seed = 11;
    const rand = (): number => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 260; i++) {
      const a = 0.02 + rand() * 0.05;
      ctx.fillStyle = rand() > 0.5 ? `rgba(120,100,70,${a})` : `rgba(255,248,230,${a})`;
      const r = 1 + rand() * 8;
      ctx.beginPath();
      ctx.arc(rand() * 256, rand() * 256, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  if (tex) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 1.4);
  }
  return tex;
}

/** 天花木板。 */
function makeCeilingTexture(lib: MaterialLibrary): THREE.Texture | null {
  const tex = lib.canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#5f4835';
    ctx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 42) {
      ctx.fillStyle = `rgba(38,26,16,${0.18 + (y % 84 === 0 ? 0.16 : 0)})`;
      ctx.fillRect(0, y, 256, 2);
    }
    for (let x = 0; x < 256; x += 64) {
      ctx.fillStyle = 'rgba(26,16,8,0.32)';
      ctx.fillRect(x, 0, 2, 256);
    }
  });
  if (tex) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
  }
  return tex;
}

/** 窗外山水（白天用；interior.update 會依時辰調整材質顏色）。 */
function makeWindowViewTexture(lib: MaterialLibrary): THREE.Texture | null {
  return lib.canvasTexture(256, 256, (ctx) => {
    const sky = ctx.createLinearGradient(0, 0, 0, 256);
    sky.addColorStop(0, '#b9d6e8');
    sky.addColorStop(0.55, '#dbe7dc');
    sky.addColorStop(1, '#e9e3c8');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 256, 256);
    // 遠山
    ctx.fillStyle = 'rgba(120,145,150,0.45)';
    ctx.beginPath();
    ctx.moveTo(0, 150);
    ctx.lineTo(50, 95);
    ctx.lineTo(100, 140);
    ctx.lineTo(150, 82);
    ctx.lineTo(205, 128);
    ctx.lineTo(256, 105);
    ctx.lineTo(256, 256);
    ctx.lineTo(0, 256);
    ctx.closePath();
    ctx.fill();
    // 近山
    ctx.fillStyle = 'rgba(88,112,96,0.55)';
    ctx.beginPath();
    ctx.moveTo(0, 186);
    ctx.lineTo(45, 148);
    ctx.lineTo(92, 178);
    ctx.lineTo(140, 142);
    ctx.lineTo(196, 174);
    ctx.lineTo(256, 158);
    ctx.lineTo(256, 256);
    ctx.lineTo(0, 256);
    ctx.closePath();
    ctx.fill();
    // 樹影
    ctx.fillStyle = 'rgba(60,86,58,0.7)';
    for (let i = 0; i < 7; i++) {
      const x = 12 + i * 38;
      const h = 22 + (i % 3) * 9;
      ctx.beginPath();
      ctx.moveTo(x, 214);
      ctx.lineTo(x + 12, 214 - h);
      ctx.lineTo(x + 24, 214);
      ctx.closePath();
      ctx.fill();
    }
    // 地面
    ctx.fillStyle = 'rgba(140,150,105,0.7)';
    ctx.fillRect(0, 214, 256, 42);
  });
}

/** 水墨屏風畫。 */
function makeInkPaintingTexture(lib: MaterialLibrary): THREE.Texture | null {
  return lib.canvasTexture(256, 320, (ctx) => {
    ctx.fillStyle = '#e9dfc8';
    ctx.fillRect(0, 0, 256, 320);
    ctx.strokeStyle = 'rgba(50,45,38,0.75)';
    ctx.lineWidth = 3;
    // 遠山
    ctx.beginPath();
    ctx.moveTo(18, 150);
    ctx.bezierCurveTo(60, 80, 90, 120, 120, 88);
    ctx.bezierCurveTo(150, 60, 190, 110, 238, 95);
    ctx.stroke();
    // 山體
    ctx.fillStyle = 'rgba(70,72,64,0.25)';
    ctx.beginPath();
    ctx.moveTo(18, 158);
    ctx.bezierCurveTo(60, 88, 90, 128, 120, 96);
    ctx.bezierCurveTo(150, 68, 190, 118, 238, 103);
    ctx.lineTo(238, 190);
    ctx.lineTo(18, 190);
    ctx.closePath();
    ctx.fill();
    // 松樹
    ctx.strokeStyle = 'rgba(40,45,36,0.85)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(120, 250);
    ctx.bezierCurveTo(118, 210, 128, 190, 122, 160);
    ctx.stroke();
    for (const [x, y, r] of [
      [104, 176, 18],
      [140, 186, 16],
      [112, 156, 14],
    ]) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 題字與印章
    ctx.fillStyle = 'rgba(40,36,30,0.8)';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(30 + i * 3, 40 + i * 26, 16, 3);
    }
    ctx.fillStyle = '#a53f37';
    ctx.fillRect(204, 262, 20, 20);
  });
}

export function createInteriorAssets(lib: MaterialLibrary): InteriorAssets {
  const floorTex = makeFloorTexture(lib);
  const wallTex = makeWallTexture(lib);
  const ceilTex = makeCeilingTexture(lib);
  const viewTex = makeWindowViewTexture(lib);
  const inkTex = makeInkPaintingTexture(lib);

  const floorMat = lib.own(
    new THREE.MeshLambertMaterial({ map: floorTex ?? undefined, color: floorTex ? 0xffffff : IPAL.floor }),
  );
  const wallMat = lib.own(
    new THREE.MeshLambertMaterial({ map: wallTex ?? undefined, color: wallTex ? 0xffffff : IPAL.wall }),
  );
  const ceilingMat = lib.own(
    new THREE.MeshLambertMaterial({ map: ceilTex ?? undefined, color: ceilTex ? 0xffffff : IPAL.ceiling }),
  );
  const windowViewMat = lib.own(
    new THREE.MeshBasicMaterial({ map: viewTex ?? undefined, color: viewTex ? 0xffffff : 0xbfd6e2, toneMapped: false }),
  ) as THREE.MeshBasicMaterial;
  const inkPaintingMat = lib.own(
    new THREE.MeshBasicMaterial({ map: inkTex ?? undefined, color: inkTex ? 0xffffff : 0xd8c9ae, toneMapped: false }),
  ) as THREE.MeshBasicMaterial;
  const latticePaperMat = lib.lambert(0xf4e6c4, { emissive: 0x6a4d24, emissiveIntensity: 0.5 });
  return { floorMat, wallMat, ceilingMat, windowViewMat, inkPaintingMat, latticePaperMat };
}

// ─────────────────────────── 門窗、屏風、卷軸 ───────────────────────────

/** 牆上格子窗（室內側）：窗紙＋窗櫺；背後是窗外景色。 */
export function addIndoorWindow(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  assets: InteriorAssets,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  ry = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const frame = lib.lambert(IPAL.woodDark);
  // 窗外景色（貼圖）
  const view = new THREE.Mesh(new THREE.PlaneGeometry(w, h), assets.windowViewMat);
  view.position.z = -0.06;
  g.add(view);
  // 窗紙（半透明暖色，遮一點景）
  const paper = lib.lambert(IPAL.paper, { transparent: true, opacity: 0.28, depthWrite: false });
  const paperMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), paper);
  paperMesh.position.z = -0.02;
  g.add(paperMesh);
  // 外框
  addBox(g, frame, w + 0.14, 0.09, 0.12, 0, h / 2, 0);
  addBox(g, frame, w + 0.14, 0.09, 0.12, 0, -h / 2, 0);
  addBox(g, frame, 0.09, h, 0.12, -w / 2, 0, 0);
  addBox(g, frame, 0.09, h, 0.12, w / 2, 0, 0);
  const lattice = lib.lambert(IPAL.wood);
  for (let i = 1; i < 4; i++) {
    addBox(g, lattice, 0.03, h, 0.05, -w / 2 + (w / 4) * i, 0, 0.04);
  }
  for (let j = 1; j < 3; j++) {
    addBox(g, lattice, w, 0.03, 0.05, 0, -h / 2 + (h / 3) * j, 0.04);
  }
  parent.add(g);
  return g;
}

/** 水墨屏風（三扇）。 */
export function addScreen(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  assets: InteriorAssets,
  x: number,
  z: number,
  ry = 0,
  panels = 3,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const frame = lib.lambert(IPAL.woodDark);
  const panelW = 0.78;
  const panelH = 1.9;
  for (let i = 0; i < panels; i++) {
    const px = (i - (panels - 1) / 2) * panelW;
    const panel = new THREE.Group();
    panel.position.set(px, 1.0, 0);
    panel.rotation.y = (i - (panels - 1) / 2) * -0.12;
    addBox(panel, frame, panelW, panelH, 0.05, 0, 0, 0);
    const art = new THREE.Mesh(new THREE.PlaneGeometry(panelW - 0.1, panelH - 0.12), assets.inkPaintingMat);
    art.position.z = 0.035;
    panel.add(art);
    addBox(panel, frame, 0.06, panelH + 0.06, 0.09, -panelW / 2, 0, 0);
    addBox(panel, frame, 0.06, panelH + 0.06, 0.09, panelW / 2, 0, 0);
    g.add(panel);
  }
  parent.add(g);
  return g;
}

/** 牆上書法卷軸。 */
export function addScroll(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  text: string,
  ry = 0,
  w = 0.42,
  h = 1.25,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = ry;
  const scrollMat = lib.scroll(text, '#e7dcc4', '#2c2419');
  const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h), scrollMat);
  g.add(art);
  const rod = lib.lambert(IPAL.woodDark);
  addCylinder(g, rod, 0.03, 0.03, w + 0.14, 0, h / 2 + 0.03, 0.01, 6, 0, Math.PI / 2);
  addCylinder(g, rod, 0.03, 0.03, w + 0.14, 0, -h / 2 - 0.03, 0.01, 6, 0, Math.PI / 2);
  parent.add(g);
  return g;
}

/** 紅柱。 */
export function addPillar(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  height: number,
  radius = 0.17,
): void {
  const mat = lib.lambert(IPAL.pillar);
  addCylinder(parent, mat, radius, radius * 1.12, height, x, height / 2, z, 10);
  addBox(parent, lib.lambert(IPAL.stone), radius * 2.6, 0.12, radius * 2.6, x, 0.06, z);
  addBox(parent, lib.lambert(IPAL.woodDark), radius * 2.4, 0.1, radius * 2.4, x, height - 0.06, z);
}

/** 室內燈籠（吊掛，會搖曳）。 */
export function addIndoorLantern(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  y: number,
  z: number,
  scale = 1.4,
): THREE.Group {
  return addHangingLantern(parent, lib, x, y, z, { rope: 0.45, scale });
}

// ─────────────────────────── 家具 ───────────────────────────

/** 架子床（含床架、帳幔、被褥、枕）。 */
export function addBed(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0, canopy = true): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lib.lambert(IPAL.woodDark);
  const woodLight = lib.lambert(IPAL.woodLight);
  // 床台
  addBox(g, wood, 1.75, 0.22, 1.0, 0, 0.2, 0);
  // 四柱與床頂（架子床）
  if (canopy) {
    for (const px of [-0.82, 0.82]) {
      for (const pz of [-0.46, 0.46]) {
        addCylinder(g, wood, 0.045, 0.055, 1.9, px, 1.02, pz, 6);
      }
    }
    addBox(g, wood, 1.8, 0.08, 1.06, 0, 1.98, 0);
    addBox(g, woodLight, 1.7, 0.04, 0.96, 0, 2.03, 0);
  } else {
    addBox(g, wood, 1.8, 0.1, 1.06, 0, 1.12, 0);
  }
  // 背板
  addBox(g, wood, 1.75, 1.0, 0.06, 0, 0.75, -0.48);
  // 床墊
  addBox(g, lib.lambert(IPAL.clothWhite), 1.55, 0.16, 0.85, 0, 0.39, 0);
  // 被子
  addBox(g, lib.lambert(IPAL.clothRed), 1.2, 0.14, 0.8, 0.18, 0.52, 0);
  addBox(g, lib.lambert(IPAL.clothRed), 0.55, 0.1, 0.82, -0.4, 0.55, 0);
  // 枕
  addBox(g, lib.lambert(IPAL.clothBlue), 0.4, 0.14, 0.3, -0.55, 0.56, 0);
  // 帳幔
  if (canopy) {
    const curtain = lib.lambert(IPAL.clothPink, { side: THREE.DoubleSide });
    addBox(g, curtain, 0.03, 1.25, 0.86, -0.84, 1.3, 0);
    addBox(g, curtain, 0.03, 1.25, 0.86, 0.84, 1.3, 0);
    addBox(g, curtain, 1.68, 0.5, 0.03, 0, 1.72, 0.47);
  }
  parent.add(g);
  return g;
}

/** 衣櫃。 */
export function addWardrobe(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lib.lambert(IPAL.woodDark);
  addBox(g, wood, 1.15, 2.0, 0.55, 0, 1.0, 0);
  addBox(g, lib.lambert(IPAL.wood), 1.05, 0.08, 0.06, 0, 1.0, 0.28);
  addBox(g, lib.lambert(IPAL.wood), 0.05, 1.9, 0.04, 0, 1.0, 0.29);
  for (const px of [-0.2, 0.2]) {
    addSphere(g, lib.lambert(IPAL.gold), 0.035, px, 1.0, 0.3, 5, 4);
  }
  addBox(g, lib.lambert(IPAL.wood), 1.2, 0.08, 0.6, 0, 2.04, 0);
  parent.add(g);
  return g;
}

/** 木箱／衣箱。 */
export function addChest(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0, s = 0.75): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lib.lambert(IPAL.wood), s, 0.45 * s, 0.55 * s, 0, 0.23 * s, 0);
  addBox(g, lib.lambert(IPAL.woodDark), s * 1.02, 0.06 * s, 0.57 * s, 0, 0.48 * s, 0);
  addBox(g, lib.lambert(IPAL.gold), 0.1 * s, 0.1 * s, 0.04, 0, 0.3 * s, 0.29 * s);
  parent.add(g);
  return g;
}

/** 高腳書桌／帳桌。 */
export function addDesk(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  w = 1.4,
  d = 0.65,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lib.lambert(IPAL.woodDark);
  addBox(g, lib.lambert(IPAL.woodLight), w, 0.08, d, 0, 0.78, 0);
  for (const [px, pz] of [
    [-w / 2 + 0.09, -d / 2 + 0.08],
    [w / 2 - 0.09, -d / 2 + 0.08],
    [-w / 2 + 0.09, d / 2 - 0.08],
    [w / 2 - 0.09, d / 2 - 0.08],
  ]) {
    addBox(g, wood, 0.08, 0.78, 0.08, px, 0.39, pz);
  }
  // 文房四寶
  addBox(g, lib.lambert(IPAL.paper), 0.34, 0.02, 0.26, 0.15, 0.83, 0.02);
  addCylinder(g, lib.lambert(IPAL.woodBlack), 0.03, 0.035, 0.2, -0.3, 0.9, -0.1, 6);
  addBox(g, lib.lambert(IPAL.stone), 0.16, 0.04, 0.12, 0.42, 0.84, -0.14);
  addBox(g, lib.lambert(IPAL.ink), 0.12, 0.012, 0.08, 0.42, 0.865, -0.14);
  parent.add(g);
  return g;
}

/** 矮柜／几案。 */
export function addLowTable(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0): THREE.Group {
  return addDesk(parent, lib, x, z, ry, 0.9, 0.5);
}

/** 架子（可放陶罐、布卷、書）。 */
export function addShelf(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  ry = 0,
  w = 1.3,
  h = 1.7,
  goods: 'jars' | 'cloth' | 'books' | 'tea' | 'none' = 'none',
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lib.lambert(IPAL.woodDark);
  addBox(g, wood, 0.08, h, 0.42, -w / 2, h / 2, 0);
  addBox(g, wood, 0.08, h, 0.42, w / 2, h / 2, 0);
  addBox(g, wood, w + 0.08, 0.06, 0.44, 0, h, 0);
  const levels = 4;
  for (let i = 0; i < levels; i++) {
    const ly = 0.24 + (i * (h - 0.3)) / (levels - 1);
    addBox(g, lib.lambert(IPAL.wood), w, 0.05, 0.38, 0, ly, 0);
    // 貨品
    const count = Math.max(1, Math.floor(w / 0.3));
    for (let k = 0; k < count; k++) {
      const gx = -w / 2 + (w / count) * (k + 0.5);
      if (goods === 'jars') {
        addLathe(g, lib.lambert(IPAL.ceramic), [
          [0.001, 0],
          [0.08, 0.01],
          [0.1, 0.1],
          [0.06, 0.2],
          [0.07, 0.24],
        ], gx, ly + 0.03, 0, 8);
      } else if (goods === 'cloth') {
        addBox(g, lib.lambert([IPAL.clothPink, IPAL.clothBlue, IPAL.clothTeal][k % 3]), w / count - 0.06, 0.14, 0.24, gx, ly + 0.1, 0);
      } else if (goods === 'books') {
        for (let b = 0; b < 3; b++) {
          addBox(g, lib.lambert(b % 2 ? IPAL.paper : IPAL.clothBlue), w / count - 0.1, 0.05, 0.22, gx, ly + 0.04 + b * 0.055, 0);
        }
      } else if (goods === 'tea') {
        addBox(g, lib.lambert(IPAL.clothGreen), w / count - 0.08, 0.16, 0.24, gx, ly + 0.11, 0);
      }
    }
  }
  parent.add(g);
  return g;
}

/** 櫃台（掌櫃桌）。 */
export function addCounter(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w = 2.2,
  d = 0.7,
  h = 1.02,
  ry = 0,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addBox(g, lib.lambert(IPAL.woodDark), w, h, d, 0, h / 2, 0);
  addBox(g, lib.lambert(IPAL.woodLight), w + 0.12, 0.08, d + 0.12, 0, h + 0.04, 0);
  addBox(g, lib.lambert(IPAL.wood), w - 0.2, h - 0.25, 0.04, 0, h / 2 - 0.05, d / 2 + 0.01);
  // 算盤、帳冊
  addBox(g, lib.lambert(IPAL.woodBlack), 0.42, 0.04, 0.24, -w * 0.2, h + 0.1, 0.02);
  addBox(g, lib.lambert(IPAL.paper), 0.3, 0.05, 0.22, w * 0.24, h + 0.1, 0.02);
  parent.add(g);
  return g;
}

/** 茶桌（圓桌）＋茶具。 */
export function addTeaTable(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, r = 0.55): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCylinder(g, lib.lambert(IPAL.wood), r, r, 0.07, 0, 0.72, 0, 14);
  addCylinder(g, lib.lambert(IPAL.woodDark), 0.09, 0.12, 0.72, 0, 0.36, 0, 8);
  addCylinder(g, lib.lambert(IPAL.woodDark), 0.3, 0.34, 0.06, 0, 0.03, 0, 10);
  // 茶壺
  addLathe(g, lib.lambert(IPAL.clothTeal), [
    [0.001, 0],
    [0.09, 0.01],
    [0.12, 0.09],
    [0.07, 0.16],
    [0.04, 0.2],
  ], 0.08, 0.76, 0, 10);
  addCylinder(g, lib.lambert(IPAL.clothTeal), 0.012, 0.025, 0.12, 0.22, 0.84, 0.02, 6, 0, 0.9);
  // 茶杯
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    addCylinder(g, lib.lambert(IPAL.paper), 0.055, 0.04, 0.06, Math.cos(a) * 0.3, 0.79, Math.sin(a) * 0.3, 8);
  }
  parent.add(g);
  return g;
}

/** 官帽椅。 */
export function addChair(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lib.lambert(IPAL.woodDark);
  addBox(g, wood, 0.46, 0.06, 0.44, 0, 0.45, 0);
  addBox(g, wood, 0.46, 0.05, 0.05, 0, 0.72, -0.2);
  addBox(g, wood, 0.46, 0.72, 0.05, 0, 0.78, -0.21);
  for (const [px, pz] of [
    [-0.19, -0.18],
    [0.19, -0.18],
    [-0.19, 0.18],
    [0.19, 0.18],
  ]) {
    addBox(g, wood, 0.055, 0.45, 0.055, px, 0.225, pz);
  }
  parent.add(g);
  return g;
}

/** 榻榻米座墊／蒲團。 */
export function addCushion(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, color: number = IPAL.clothGold, ry = 0): void {
  addCylinder(parent, lib.lambert(color), 0.3, 0.32, 0.09, x, 0.045, z, 12);
  addCylinder(parent, lib.lambert(IPAL.woodDark), 0.02, 0.02, 0.02, x, 0.09, z, 4, ry);
}

/** 盆栽（室內）。 */
export function addPottedPlant(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, s = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  addLathe(g, lib.lambert(IPAL.ceramic), [
    [0.001, 0],
    [0.16, 0.02],
    [0.2, 0.22],
    [0.18, 0.36],
    [0.2, 0.4],
  ], 0, 0, 0, 10);
  addCylinder(g, lib.lambert(IPAL.leafDark), 0.03, 0.04, 0.5, 0, 0.6, 0, 5);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const leaf = addSphere(g, lib.lambert(i % 2 ? IPAL.leaf : IPAL.leafDark), 0.18, Math.cos(a) * 0.12, 0.85 + (i % 2) * 0.12, Math.sin(a) * 0.12, 6, 4);
    leaf.scale.set(1.2, 0.7, 1.2);
  }
  parent.add(g);
  return g;
}

/** 織機。 */
export function addLoom(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lib.lambert(IPAL.woodDark);
  const woodLight = lib.lambert(IPAL.wood);
  // 機架
  addBox(g, wood, 1.0, 1.3, 0.1, -0.5, 0.65, 0);
  addBox(g, wood, 1.0, 1.3, 0.1, 0.5, 0.65, 0);
  addBox(g, wood, 1.15, 0.1, 0.1, 0, 1.28, 0);
  addBox(g, wood, 1.15, 0.1, 0.1, 0, 0.85, 0);
  addBox(g, woodLight, 0.9, 0.08, 0.5, 0, 0.55, 0.1);
  // 經線
  for (let i = 0; i < 7; i++) {
    addBox(g, lib.lambert(i % 2 ? IPAL.clothWhite : IPAL.clothPink), 0.015, 0.75, 0.015, -0.36 + i * 0.12, 0.93, 0.02);
  }
  // 布卷
  addCylinder(g, lib.lambert(IPAL.clothPink), 0.09, 0.09, 0.56, 0, 0.5, 0.32, 8, 0, Math.PI / 2);
  // 梭子
  addBox(g, lib.lambert(IPAL.woodLight), 0.4, 0.05, 0.1, 0.1, 0.68, 0.18);
  parent.add(g);
  return g;
}

/** 紡車。 */
export function addSpinningWheel(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const wood = lib.lambert(IPAL.wood);
  for (let i = 0; i < 2; i++) {
    const a = -0.5 + i;
    const leg = addBox(g, wood, 0.06, 0.7, 0.06, 0, 0.35, 0);
    leg.rotation.z = a;
  }
  addCylinder(g, wood, 0.35, 0.35, 0.06, 0, 0.75, 0, 12);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    addBox(g, wood, 0.05, 0.05, 0.62, Math.cos(a) * 0.16, 0.75, Math.sin(a) * 0.16, a);
  }
  addBox(g, lib.lambert(IPAL.clothWhite), 0.18, 0.12, 0.12, 0.42, 0.42, 0);
  parent.add(g);
  return g;
}

/** 釀酒大釜。 */
export function addBrewingVat(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, s = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  addCylinder(g, lib.lambert(IPAL.stone), 0.62, 0.7, 0.4, 0, 0.2, 0, 12);
  addLathe(g, lib.lambert(IPAL.ceramicDark), [
    [0.001, 0],
    [0.5, 0.02],
    [0.58, 0.3],
    [0.52, 0.7],
    [0.4, 0.9],
    [0.42, 0.96],
    [0.34, 0.98],
  ], 0, 0.35, 0, 14);
  // 蒸氣
  addSmoke(g, lib, 0, 1.4, 0, 1.1);
  // 灶口火
  const fireMat = lib.basic(IPAL.fire, { toneMapped: false });
  const fire = addBox(g, fireMat, 0.34, 0.16, 0.1, 0, 0.16, 0.66);
  markAnim(fire, 'flame');
  addBox(g, lib.lambert(IPAL.stoneLight), 0.5, 0.5, 0.24, 0.62, 0.3, 0.5);
  parent.add(g);
  return g;
}

/** 酒罈堆（室內）。 */
export function addJarStack(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, count = 4): void {
  for (let i = 0; i < count; i++) {
    const px = x + ((i % 2) - 0.5) * 0.62;
    const pz = z + (Math.floor(i / 2) - 0.5) * 0.6;
    addWineJar(parent, lib, px, 0, pz, { scale: 0.62 + (i % 3) * 0.06 });
  }
}

/** 鐵匠爐（發光爐火＋風箱＋煙）。 */
export function addForge(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addBox(g, lib.lambert(IPAL.stone), 1.4, 0.62, 1.0, 0, 0.31, 0);
  addBox(g, lib.lambert(IPAL.stoneLight), 1.2, 0.14, 0.8, 0, 0.68, 0);
  const emberMat = lib.lambert(IPAL.fire, { emissive: 0xff5a18, emissiveIntensity: 1.1 });
  const embers = addBox(g, emberMat, 0.9, 0.06, 0.6, 0, 0.66, 0);
  markAnim(embers, 'glow');
  const glowMat = lib.basic(0xff9a50, { transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false });
  const glow = addSphere(g, glowMat, 0.42, 0, 0.82, 0, 8, 6);
  markAnim(glow, 'glow');
  addBox(g, lib.lambert(IPAL.stone), 0.42, 1.5, 0.42, -0.5, 0.75, -0.34);
  addSmoke(g, lib, -0.5, 1.6, -0.34, 0.9);
  // 風箱
  addBox(g, lib.lambert(IPAL.wood), 0.8, 0.4, 0.3, 0.85, 0.35, -0.2);
  addBox(g, lib.lambert(IPAL.clothBlue), 0.2, 0.28, 0.26, 1.28, 0.32, -0.2);
  parent.add(g);
  return g;
}

/** 鐵砧。 */
export function addAnvil(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addCylinder(g, lib.lambert(IPAL.woodDark), 0.22, 0.26, 0.32, 0, 0.16, 0, 8);
  addBox(g, lib.lambert(IPAL.iron), 0.5, 0.2, 0.28, 0, 0.42, 0);
  addBox(g, lib.lambert(IPAL.iron), 0.34, 0.12, 0.22, 0, 0.56, 0);
  addCone(g, lib.lambert(IPAL.iron), 0.09, 0.24, 0.36, 0.46, 0, 6, Math.PI / 2);
  // 鐵鎚
  addBox(g, lib.lambert(IPAL.wood), 0.04, 0.5, 0.04, 0.36, 0.3, 0.2, 0.5);
  addBox(g, lib.lambert(IPAL.iron), 0.18, 0.1, 0.1, 0.44, 0.52, 0.2);
  parent.add(g);
  return g;
}

/** 兵器架（衙門／武館）：水火棍、刀槍。 */
export function addWeaponRack(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  const wood = lib.lambert(IPAL.woodDark);
  addCylinder(g, wood, 0.05, 0.06, 1.5, -0.55, 0.75, 0, 5);
  addCylinder(g, wood, 0.05, 0.06, 1.5, 0.55, 0.75, 0, 5);
  addBox(g, wood, 1.2, 0.08, 0.08, 0, 1.42, 0);
  for (let i = 0; i < 3; i++) {
    const px = -0.4 + i * 0.4;
    addCylinder(g, lib.lambert(i === 1 ? IPAL.pillar : IPAL.wood), 0.03, 0.035, 1.35, px, 0.72, 0.06, 5);
    if (i === 1) {
      addBox(g, lib.lambert(IPAL.iron), 0.16, 0.05, 0.05, px, 1.35, 0.06);
    } else {
      addCone(g, lib.lambert(IPAL.iron), 0.04, 0.16, px, 1.46, 0.06, 5);
    }
  }
  parent.add(g);
  return g;
}

/** 公案（衙門大堂）。 */
export function addMagistrateDesk(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  // 高台
  addBox(g, lib.lambert(IPAL.woodDark), 2.0, 0.3, 1.0, 0, 0.15, 0);
  addBox(g, lib.lambert(IPAL.pillarDark), 1.7, 0.85, 0.7, 0, 0.72, 0);
  addBox(g, lib.lambert(IPAL.woodDark), 1.9, 0.1, 0.9, 0, 1.16, 0);
  // 驚堂木、官印、卷宗、令箭筒
  addBox(g, lib.lambert(IPAL.woodBlack), 0.16, 0.16, 0.16, -0.4, 1.29, 0.14);
  addBox(g, lib.lambert(IPAL.gold), 0.18, 0.14, 0.18, 0.34, 1.28, 0.1);
  addBox(g, lib.lambert(IPAL.paper), 0.34, 0.1, 0.24, 0.02, 1.26, 0.2);
  addCylinder(g, lib.lambert(IPAL.woodDark), 0.1, 0.12, 0.3, 0.66, 1.36, 0.1, 8);
  for (let i = 0; i < 3; i++) {
    addCylinder(g, lib.lambert(IPAL.pillar), 0.012, 0.012, 0.42, 0.66 + (i - 1) * 0.025, 1.6, 0.1, 4);
    addCone(g, lib.lambert(IPAL.iron), 0.03, 0.1, 0.66 + (i - 1) * 0.025, 1.84, 0.1, 4);
  }
  // 太師椅與屏風
  addBox(g, lib.lambert(IPAL.pillarDark), 0.8, 1.5, 0.5, 0, 1.02, -0.62);
  addBox(g, lib.lambert(IPAL.goldDark), 0.6, 0.9, 0.04, 0, 1.05, -0.36);
  addChair(g, lib, 0, -0.3, Math.PI);
  parent.add(g);
  return g;
}

/** 佛龕與金身佛像。 */
export function addBuddhaShrine(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const goldMat = lib.lambert(IPAL.gold, { emissive: 0x6a4a12, emissiveIntensity: 0.55 });
  const goldDark = lib.lambert(IPAL.goldDark);
  const red = lib.lambert(IPAL.pillarDark);
  // 佛龕與帳幔
  addBox(g, red, 2.4, 2.6, 0.4, 0, 1.3, -0.5);
  addBox(g, lib.lambert(IPAL.clothRed), 2.0, 2.2, 0.06, 0, 1.35, -0.28);
  // 蓮座
  addLathe(g, goldDark, [
    [0.001, 0],
    [0.5, 0.04],
    [0.42, 0.18],
    [0.3, 0.26],
    [0.34, 0.34],
    [0.001, 0.36],
  ], 0, 0.86, 0, 14);
  // 結跏趺坐
  const body = addSphere(g, goldMat, 0.42, 0, 1.45, 0.02, 10, 8);
  body.scale.set(1.0, 1.15, 0.72);
  addSphere(g, goldMat, 0.22, 0, 1.98, 0.06, 10, 8);
  addCone(g, goldMat, 0.09, 0.18, 0, 2.2, 0.06, 8);
  // 手印
  addSphere(g, goldMat, 0.1, -0.22, 1.34, 0.32, 6, 5);
  addSphere(g, goldMat, 0.1, 0.22, 1.42, 0.3, 6, 5);
  // 背光
  addCylinder(g, goldDark, 0.85, 0.85, 0.04, 0, 1.6, -0.24, 18, 0, Math.PI / 2);
  // 供桌
  addBox(g, red, 1.9, 0.8, 0.6, 0, 0.4, 0.9);
  addBox(g, lib.lambert(IPAL.woodDark), 2.0, 0.1, 0.72, 0, 0.86, 0.9);
  // 供果與燭台
  for (const px of [-0.6, 0.6]) {
    addCylinder(g, goldDark, 0.06, 0.08, 0.24, px, 1.0, 0.9, 8);
    addCone(g, lib.lambert(0xffeeaa, { emissive: 0xffbb55, emissiveIntensity: 1.0 }), 0.045, 0.14, px, 1.2, 0.9, 6);
  }
  addBasket(g, lib, 0, 0.92, 1.02, 0.2, 0xb4553f);
  addCylinder(g, lib.lambert(IPAL.bronze), 0.16, 0.2, 0.12, 0, 0.96, 1.06, 10);
  parent.add(g);
  // 香爐
  addSmoke(g, lib, 0, 1.1, 1.06, 0.7);
  return g;
}

/** 學堂書案（一桌一椅＋筆墨）。 */
export function addSchoolDesk(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addTable(g, lib, 0, 0, 0, 0.82, 0.46, 0.52);
  addBox(g, lib.lambert(IPAL.paper), 0.3, 0.02, 0.22, 0.06, 0.55, 0.02);
  addBox(g, lib.lambert(IPAL.woodBlack), 0.04, 0.18, 0.04, -0.18, 0.62, -0.06);
  addStool(g, lib, 0, 0, 0.5, 0.12, 0.34);
  parent.add(g);
  return g;
}

/** 講堂夫子案與戒尺。 */
export function addMasterDesk(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  addDesk(g, lib, 0, 0, 0, 1.6, 0.7);
  addBox(g, lib.lambert(IPAL.woodLight), 0.5, 0.04, 0.08, 0.3, 0.84, 0.16);
  addBox(g, lib.lambert(IPAL.paper), 0.4, 0.02, 0.3, -0.3, 0.84, 0.02);
  addCylinder(g, lib.lambert(IPAL.ceramic), 0.07, 0.08, 0.14, -0.55, 0.9, -0.1, 8);
  addChair(g, lib, 0, -0.55, Math.PI);
  parent.add(g);
  return g;
}

/** 茶館掌櫃台與茶罐。 */
export function addTeaCounter(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, w = 2.6, ry = 0): THREE.Group {
  const g = addCounter(parent, lib, x, z, w, 0.8, 1.05, ry);
  // 茶罐
  for (let i = 0; i < 5; i++) {
    const px = -w / 2 + 0.3 + i * ((w - 0.6) / 4);
    addLathe(g, lib.lambert(IPAL.ceramic), [
      [0.001, 0],
      [0.08, 0.01],
      [0.11, 0.12],
      [0.07, 0.22],
      [0.08, 0.26],
    ], px, 1.1, 0, 8);
    addBox(g, lib.lambert(IPAL.clothGreen), 0.14, 0.04, 0.14, px, 1.35, 0);
  }
  // 銅壺
  addLathe(g, lib.lambert(IPAL.bronze), [
    [0.001, 0],
    [0.14, 0.01],
    [0.18, 0.14],
    [0.1, 0.3],
    [0.06, 0.36],
  ], -w * 0.3, 1.1, 0.1, 10);
  addBox(g, lib.lambert(IPAL.paper), 0.3, 0.05, 0.2, w * 0.28, 1.14, 0.05);
  return g;
}

/** 市集貨架（可放貨物）。 */
export function addGoodsRack(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, ry = 0, goodsColor: number = IPAL.grain): THREE.Group {
  const g = addShelf(parent, lib, x, z, ry, 1.5, 1.5, 'none');
  // 米袋、布卷、竹籃
  addSack(g, lib, -0.45, 0.24, 0.05, 0.8);
  addSack(g, lib, -0.3, 0.24, 0.1, 0.7);
  addBasket(g, lib, 0.4, 0.24, 0.05, 0.2, goodsColor);
  addBox(g, lib.lambert(IPAL.clothBlue), 0.34, 0.16, 0.28, 0.1, 0.72, 0);
  addCylinder(g, lib.lambert(IPAL.ceramic), 0.12, 0.14, 0.18, -0.4, 0.72, 0.04, 8);
  return g;
}

/** 穀倉木斗／糧囤（室內）。 */
export function addGrainBin(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, s = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  addCylinder(g, lib.lambert(IPAL.wood), 0.6, 0.66, 0.9, 0, 0.45, 0, 12);
  addCylinder(g, lib.lambert(IPAL.woodDark), 0.64, 0.68, 0.06, 0, 0.2, 0, 12);
  addCylinder(g, lib.lambert(IPAL.woodDark), 0.62, 0.66, 0.06, 0, 0.72, 0, 12);
  // 穀物
  addCylinder(g, lib.lambert(IPAL.grain), 0.5, 0.5, 0.08, 0, 0.92, 0, 12);
  addSack(g, lib, 0.75, 0, 0.3, 0.9);
  addSack(g, lib, 0.7, 0, -0.2, 0.75, 0.8);
  parent.add(g);
  return g;
}

/** 麻袋堆。 */
export function addSackPile(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, count = 4): void {
  for (let i = 0; i < count; i++) {
    addSack(parent, lib, x + ((i % 2) - 0.5) * 0.5, 0, z + (Math.floor(i / 2) - 0.5) * 0.4, 0.9 - i * 0.06, i * 0.5);
  }
}

/** 竹筐與農具（農舍、倉庫）。 */
export function addToolsCorner(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number, kind: 'farm' | 'mine' | 'wood' = 'farm'): void {
  if (kind === 'farm') {
    addBasket(parent, lib, x, 0, z, 0.28, IPAL.grain);
    addBasket(parent, lib, x + 0.42, 0, z + 0.1, 0.24, IPAL.leaf);
    // 鋤頭
    addBox(parent, lib.lambert(IPAL.wood), 0.05, 1.2, 0.05, x - 0.35, 0.6, z + 0.2, 0.15);
    addBox(parent, lib.lambert(IPAL.iron), 0.3, 0.08, 0.06, x - 0.35, 1.22, z + 0.2, 0.4);
  } else if (kind === 'mine') {
    addBox(parent, lib.lambert(IPAL.wood), 0.05, 0.9, 0.05, x, 0.45, z, 0.2);
    addBox(parent, lib.lambert(IPAL.iron), 0.5, 0.08, 0.07, x, 0.9, z, 0.6);
    addCrate(parent, lib, x + 0.45, 0, z + 0.1, 0.5);
    for (let i = 0; i < 4; i++) {
      addSphere(parent, lib.lambert(IPAL.ore), 0.13, x - 0.3 + i * 0.14, 0.13, z + 0.34 + (i % 2) * 0.1, 5, 4);
    }
  } else {
    for (let i = 0; i < 3; i++) {
      addCylinder(parent, lib.lambert(IPAL.wood), 0.11, 0.11, 0.9, x, 0.12 + (i % 2) * 0.2, z + i * 0.24, 7, 0, Math.PI / 2);
    }
    addBox(parent, lib.lambert(IPAL.iron), 0.2, 0.16, 0.05, x + 0.5, 0.5, z, 0.3);
    addBox(parent, lib.lambert(IPAL.wood), 0.05, 0.55, 0.05, x + 0.5, 0.28, z, 0.3);
  }
}

/** 貨箱堆。 */
export function addCrateStack(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): void {
  addCrate(parent, lib, x, 0, z, 0.55);
  addCrate(parent, lib, x + 0.4, 0, z + 0.2, 0.45, 0.3);
  addCrate(parent, lib, x + 0.05, 0.48, z, 0.4, 0.15);
  addBarrel(parent, lib, x - 0.5, 0, z + 0.25, 0.34);
}

/** 魚簍與纜繩（碼頭室內）。 */
export function addDockGear(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): void {
  addBasket(parent, lib, x, 0, z, 0.3, IPAL.water);
  addCylinder(parent, lib.lambert(IPAL.thatchDark), 0.28, 0.28, 0.1, x + 0.7, 0.05, z, 12);
  addCylinder(parent, lib.lambert(IPAL.thatchDark), 0.22, 0.22, 0.1, x + 0.7, 0.12, z, 12);
  addBox(parent, lib.lambert(IPAL.woodDark), 0.5, 0.1, 0.38, x - 0.7, 0.28, z + 0.2);
  addBarrel(parent, lib, x + 1.1, 0, z + 0.4, 0.4);
}

/** 礦車（室內）。 */
export function addMineCart(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  addBox(g, lib.lambert(IPAL.iron), 0.9, 0.42, 0.6, 0, 0.34, 0);
  for (const [px, pz] of [
    [-0.32, -0.24],
    [0.32, -0.24],
    [-0.32, 0.24],
    [0.32, 0.24],
  ]) {
    addCylinder(g, lib.lambert(IPAL.woodDark), 0.13, 0.13, 0.08, px, 0.14, pz, 8, 0, Math.PI / 2);
  }
  for (let i = 0; i < 4; i++) {
    addSphere(g, lib.lambert(IPAL.ore), 0.13, -0.25 + i * 0.17, 0.6, (i % 2) * 0.12 - 0.06, 5, 4);
  }
  parent.add(g);
  return g;
}

/** 地毯（帶邊框）。 */
export function addRug(
  parent: THREE.Object3D,
  lib: MaterialLibrary,
  x: number,
  z: number,
  w = 3.2,
  d = 2.2,
  color: number = IPAL.clothRed,
): void {
  addBox(parent, lib.lambert(0x5c3b28), w, 0.02, d, x, 0.012, z);
  addBox(parent, lib.lambert(color), w - 0.24, 0.024, d - 0.24, x, 0.02, z);
  addBox(parent, lib.lambert(IPAL.clothGold), w - 0.5, 0.026, d - 0.5, x, 0.024, z);
  addBox(parent, lib.lambert(color), w - 0.62, 0.028, d - 0.62, x, 0.028, z);
}

/** 小茶几／矮几（兩層）。 */
export function addTeaStand(parent: THREE.Object3D, lib: MaterialLibrary, x: number, z: number): void {
  addBox(parent, lib.lambert(IPAL.woodDark), 0.5, 0.42, 0.36, x, 0.21, z);
  addBox(parent, lib.lambert(IPAL.woodLight), 0.6, 0.05, 0.44, x, 0.44, z);
  addCylinder(parent, lib.lambert(IPAL.ceramic), 0.06, 0.07, 0.16, x + 0.1, 0.55, z, 8);
}

// ─────────────────────────── 人物象徵 ───────────────────────────

export type PersonPose = 'stand' | 'sit' | 'kneel';
export type PersonHat = 'none' | 'bun' | 'douli' | 'official';

export interface PersonOptions {
  x: number;
  z: number;
  ry?: number;
  robe?: number;
  pose?: PersonPose;
  hat?: PersonHat;
  scale?: number;
  skin?: number;
  /** 加上輕微呼吸／搖擺動畫 */
  idle?: boolean;
}

/** 低多邊形人物象徵（長衫、斗笠、官帽）。 */
export function addPerson(parent: THREE.Object3D, lib: MaterialLibrary, opts: PersonOptions): THREE.Group {
  const pose = opts.pose ?? 'stand';
  const s = opts.scale ?? 1;
  const g = new THREE.Group();
  g.position.set(opts.x, 0, opts.z);
  g.rotation.y = opts.ry ?? 0;
  g.scale.setScalar(s);
  const robe = lib.lambert(opts.robe ?? IPAL.clothBlue);
  const robeDark = lib.lambert(darkenColor(opts.robe ?? IPAL.clothBlue, 0.8));
  const skin = lib.lambert(opts.skin ?? IPAL.skin);
  const hair = lib.lambert(IPAL.hair);
  const gold = lib.lambert(IPAL.gold);

  let headY = 1.42;
  if (pose === 'stand') {
    // 腿
    addCylinder(g, robeDark, 0.07, 0.08, 0.56, -0.09, 0.28, 0, 6);
    addCylinder(g, robeDark, 0.07, 0.08, 0.56, 0.09, 0.28, 0, 6);
    // 長衫
    addLathe(g, robe, [
      [0.001, 0],
      [0.24, 0.02],
      [0.23, 0.2],
      [0.19, 0.52],
      [0.15, 0.78],
      [0.001, 0.8],
    ], 0, 0.5, 0, 10);
    // 腰帶
    addCylinder(g, lib.lambert(IPAL.woodDark), 0.16, 0.16, 0.05, 0, 1.0, 0, 10);
    // 手臂
    for (const side of [-1, 1]) {
      const arm = addBox(g, robe, 0.1, 0.46, 0.1, side * 0.23, 1.02, 0.02);
      arm.rotation.z = side * 0.12;
      addSphere(g, skin, 0.055, side * 0.25, 0.78, 0.05, 6, 5);
    }
    headY = 1.46;
  } else if (pose === 'sit') {
    // 坐姿（腿彎）
    addBox(g, robeDark, 0.4, 0.14, 0.4, 0, 0.5, 0.1);
    addBox(g, robeDark, 0.14, 0.4, 0.14, -0.12, 0.25, 0.26);
    addBox(g, robeDark, 0.14, 0.4, 0.14, 0.12, 0.25, 0.26);
    addLathe(g, robe, [
      [0.001, 0],
      [0.25, 0.02],
      [0.2, 0.35],
      [0.14, 0.55],
      [0.001, 0.58],
    ], 0, 0.52, 0, 10);
    for (const side of [-1, 1]) {
      addBox(g, robe, 0.09, 0.36, 0.09, side * 0.19, 0.74, 0.06);
    }
    headY = 1.18;
  } else {
    // 跪坐
    addBox(g, robeDark, 0.5, 0.16, 0.42, 0, 0.1, 0.05);
    addLathe(g, robe, [
      [0.001, 0],
      [0.28, 0.02],
      [0.23, 0.26],
      [0.15, 0.46],
      [0.001, 0.48],
    ], 0, 0.2, 0, 10);
    for (const side of [-1, 1]) {
      addBox(g, robe, 0.09, 0.3, 0.09, side * 0.18, 0.46, 0.08);
    }
    headY = 0.82;
  }
  // 頭
  addSphere(g, skin, 0.135, 0, headY, 0.01, 8, 6);
  // 髮
  const hairBack = addSphere(g, hair, 0.14, 0, headY + 0.02, -0.03, 8, 6);
  hairBack.scale.set(1, 1.02, 0.9);
  const hat = opts.hat ?? 'bun';
  if (hat === 'bun') {
    addSphere(g, hair, 0.06, 0, headY + 0.16, -0.02, 6, 5);
    addCylinder(g, hair, 0.035, 0.045, 0.05, 0, headY + 0.13, -0.02, 6);
  } else if (hat === 'douli') {
    addCone(g, lib.lambert(IPAL.thatchLight), 0.28, 0.14, 0, headY + 0.18, 0, 12);
    addCylinder(g, lib.lambert(IPAL.thatch), 0.3, 0.3, 0.025, 0, headY + 0.12, 0, 12);
  } else if (hat === 'official') {
    addBox(g, hair, 0.28, 0.14, 0.26, 0, headY + 0.16, 0);
    addBox(g, gold, 0.06, 0.1, 0.04, 0, headY + 0.22, 0.13);
    // 烏紗帽雙翅
    for (const side of [-1, 1]) {
      addBox(g, hair, 0.22, 0.03, 0.08, side * 0.3, headY + 0.14, -0.02);
    }
  }
  if (opts.idle !== false) markAnim(g, 'person');
  parent.add(g);
  return g;
}

/** 顏色加深（人物衣著用）。 */
export function darkenColor(color: number, factor: number): number {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((color >> 16) & 255) * factor);
  const g = clamp(((color >> 8) & 255) * factor);
  const b = clamp((color & 255) * factor);
  return (r << 16) | (g << 8) | b;
}
