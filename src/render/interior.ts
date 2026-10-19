/**
 * 華夏古城 — 可進入的建築室內場景（architecture-dev）
 *
 * 依建築類型生成不同的室內：民居床榻、市集貨架、衙門大堂公案、寺廟佛龕、
 * 酒坊酒罈、茶館桌椅、學堂書案、鐵匠爐火、糧倉穀囤、碼頭貨箱、涼亭外景……
 * 木地板樑柱、暖光燈籠、人物象徵，update 內有燈火搖曳／炊煙／人物呼吸微動，
 * 並隨時辰（日／夜）改變窗光與燈籠亮度。
 *
 * 對外介面固定：
 *   createInteriorView(state, buildingId): InteriorView | null
 *   InteriorView.scene / camera / update(state, dt) / dispose()
 */

import * as THREE from 'three';
import { BUILDINGS } from '../core/config';
import type { Building, BuildingDef, GameState } from '../core/types';
import { MaterialLibrary } from './models/materials';
import { addBox, addCone, addCylinder, addLathe, addSphere } from './models/geometry-utils';
import {
  addChineseRoof,
  addBanner,
  addBarrel,
  addBasket,
  addCrate,
  addDrum,
  addHangingLantern,
  addPlaque,
  addSack,
  addSmoke,
  addStool,
  addTable,
  addWaterJar,
  addWineJar,
} from './models/chinese-parts';
import * as I from './models/interior-parts';

export interface InteriorView {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

interface Dims {
  w: number;
  d: number;
  h: number;
}

interface RoomRefs {
  windowLight: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  lamps: THREE.PointLight[];
  candleLight: THREE.PointLight | null;
  windowView: THREE.MeshBasicMaterial;
}

interface AnimPart {
  obj: THREE.Object3D;
  kind: string;
  phase: number;
  baseY: number;
  baseRotX: number;
  baseRotY: number;
  baseRotZ: number;
  baseScale: number;
  smokeChildren?: { mesh: THREE.Object3D; baseScale: number; baseY: number; offset: number }[];
}

const ROOM_BG = 0x17110c;

// ─────────────────────────── 房間外殼 ───────────────────────────

interface RoomOptions {
  /** 室外涼亭：不建牆與天花 */
  outdoor?: boolean;
  /** 不建後窗（礦坑等） */
  noWindows?: boolean;
  wallColor?: number;
  pillarColor?: number;
  ceilingBeams?: boolean;
}

function buildRoom(
  scene: THREE.Scene,
  lib: MaterialLibrary,
  assets: I.InteriorAssets,
  dims: Dims,
  opts: RoomOptions = {},
): RoomRefs {
  const { w, d, h } = dims;
  const halfD = d / 2;

  // 地板
  const floorMat = opts.outdoor ? lib.lambert(0x8f8b80) : assets.floorMat;
  const floor = addBox(scene, floorMat, w, 0.2, d, 0, -0.1, 0);
  floor.receiveShadow = true;
  if (!opts.outdoor) {
    // 木地板壓條
    for (let i = 1; i < 4; i++) {
      addBox(scene, lib.lambert(I.IPAL.floorDark), 0.04, 0.012, d, -w / 2 + (w / 4) * i, 0.012, 0);
    }
  }

  if (!opts.outdoor) {
    // 牆面
    const wallMat = opts.wallColor ? lib.lambert(opts.wallColor) : assets.wallMat;
    // 後牆
    addBox(scene, wallMat, w, h, 0.2, 0, h / 2, -halfD + 0.1);
    // 側牆
    addBox(scene, wallMat, 0.2, h, d, -w / 2 + 0.1, h / 2, 0);
    addBox(scene, wallMat, 0.2, h, d, w / 2 - 0.1, h / 2, 0);
    // 前牆僅留兩側短牆，中央敞開
    addBox(scene, wallMat, w * 0.11, h, 0.2, -w / 2 + w * 0.055, h / 2, halfD - 0.1);
    addBox(scene, wallMat, w * 0.11, h, 0.2, w / 2 - w * 0.055, h / 2, halfD - 0.1);
    // 踢腳板
    const skirt = lib.lambert(I.IPAL.woodDark);
    addBox(scene, skirt, w, 0.22, 0.09, 0, 0.11, -halfD + 0.22);
    addBox(scene, skirt, 0.09, 0.22, d, -w / 2 + 0.22, 0.11, 0);
    addBox(scene, skirt, 0.09, 0.22, d, w / 2 - 0.22, 0.11, 0);

    // 天花板與樑（天花板不投影，讓天光進入室內）
    const ceilingMesh = addBox(scene, assets.ceilingMat, w, 0.18, d, 0, h + 0.09, 0);
    ceilingMesh.castShadow = false;
    const beamMat = lib.lambert(I.IPAL.beam);
    for (let i = 0; i < 3; i++) {
      addBox(scene, beamMat, w, 0.2, 0.22, 0, h - 0.1, -d * 0.3 + i * d * 0.3);
    }
    addBox(scene, beamMat, 0.24, 0.24, d, 0, h - 0.11, 0);
    // 前簷橫樑
    addBox(scene, lib.lambert(I.IPAL.woodDark), w + 0.3, 0.26, 0.24, 0, h - 0.12, halfD - 0.12);
    // 前門框與敞開的門扇
    const frameMat = lib.lambert(I.IPAL.woodDark);
    addBox(scene, frameMat, 0.24, h, 0.26, -w * 0.34, h / 2, halfD - 0.1);
    addBox(scene, frameMat, 0.24, h, 0.26, w * 0.34, h / 2, halfD - 0.1);
    // 敞開的門扇貼在兩側前牆上（不遮擋視線）
    const doorMat = lib.lambert(opts.wallColor === I.IPAL.wallRed ? I.IPAL.pillarDark : I.IPAL.wood);
    for (const side of [-1, 1]) {
      const door = addBox(scene, doorMat, w * 0.1, h * 0.6, 0.06, side * (w * 0.37), h * 0.3, halfD - 0.34);
      door.rotation.y = side * 1.4;
    }
    // 門檻石
    addBox(scene, lib.lambert(I.IPAL.stoneLight), w * 0.3, 0.1, 0.34, 0, 0.05, halfD - 0.2);
  }

  // 紅柱（後角、中後、前角）
  const pillarR = 0.18;
  for (const px of [-w / 2 + 0.32, w / 2 - 0.32]) {
    for (const pz of [-halfD + 0.32, halfD - 0.32]) {
      I.addPillar(scene, lib, px, pz, opts.outdoor ? h : h - 0.05, pillarR);
    }
  }
  if (w > 8) {
    I.addPillar(scene, lib, 0, -halfD + 0.32, h - 0.05, pillarR * 0.85);
  }

  // 後窗（透入天光）
  if (!opts.outdoor && !opts.noWindows) {
    const winW = Math.min(1.7, w * 0.24);
    const winH = Math.min(1.35, h * 0.4);
    for (const sx of [-1, 1]) {
      I.addIndoorWindow(scene, lib, assets, sx * w * 0.24, h * 0.58, -halfD + 0.22, winW, winH);
    }
    if (w > 8.5) {
      I.addIndoorWindow(scene, lib, assets, 0, h * 0.62, -halfD + 0.22, winW * 0.75, winH * 0.8);
    }
  }

  // 燈籠與燈光
  const lampPositions: THREE.Vector3[] = [];
  const lampZ = opts.outdoor ? 0 : d * 0.12;
  for (const sx of [-1, 1]) {
    const lx = sx * Math.min(w * 0.27, 2.6);
    addHangingLantern(scene, lib, lx, h - 0.18, lampZ, { rope: 0.5, scale: opts.outdoor ? 1.2 : 1.45 });
    lampPositions.push(new THREE.Vector3(lx, h - 0.75, lampZ));
  }
  if (w > 9) {
    addHangingLantern(scene, lib, 0, h - 0.16, -d * 0.16, { rope: 0.5, scale: 1.35 });
    lampPositions.push(new THREE.Vector3(0, h - 0.7, -d * 0.16));
  }

  // ── 照明 ──
  const ambient = new THREE.AmbientLight(0xffe2c0, 0.5);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xffe8cc, 0x302216, 0.4);
  scene.add(hemi);

  const windowLight = new THREE.DirectionalLight(0xffd9a0, opts.outdoor ? 2.2 : 1.9);
  windowLight.position.set(w * 0.28, h + 2.4, halfD + 2.4);
  windowLight.castShadow = true;
  windowLight.shadow.mapSize.set(1024, 1024);
  const sc = windowLight.shadow.camera;
  sc.left = -w * 0.75;
  sc.right = w * 0.75;
  sc.top = h * 1.6;
  sc.bottom = -h * 1.6;
  sc.near = 0.5;
  sc.far = d * 2.5 + h * 2;
  windowLight.shadow.bias = -0.0006;
  windowLight.target.position.set(0, 0.4, -d * 0.15);
  scene.add(windowLight);
  scene.add(windowLight.target);

  const lamps: THREE.PointLight[] = [];
  for (const pos of lampPositions) {
    const lamp = new THREE.PointLight(0xffc187, 16, w + d, 1.5);
    lamp.position.copy(pos);
    scene.add(lamp);
    lamps.push(lamp);
  }
  const candleLight = new THREE.PointLight(0xffcf8a, 10, 8, 1.6);
  candleLight.position.set(0, 1.6, 0);
  scene.add(candleLight);

  return { windowLight, hemi, ambient, lamps, candleLight, windowView: assets.windowViewMat };
}

// ─────────────────────────── 各類室內陳設 ───────────────────────────

function fillResidential(scene: THREE.Scene, lib: MaterialLibrary, assets: I.InteriorAssets, dims: Dims, key: string, people: number): void {
  const { w, d } = dims;
  const poor = key === 'hut';
  const rich = key === 'manor';
  // 床榻靠左後
  I.addBed(scene, lib, -w * 0.29, -d * 0.18, 0.06, !poor);
  if (poor) {
    // 茅屋簡樸：草席、矮桌、陶罐、柴堆
    addBox(scene, lib.lambert(I.IPAL.thatchLight), 1.5, 0.04, 1.0, -w * 0.29, 0.05, -d * 0.18);
    I.addLowTable(scene, lib, w * 0.16, d * 0.12, -0.1);
    addStool(scene, lib, w * 0.04, 0, d * 0.16, 0.15, 0.36);
    addCylinder(scene, lib.lambert(I.IPAL.ceramic), 0.2, 0.24, 0.42, -w * 0.38, 0.21, d * 0.22, 10);
    addCylinder(scene, lib.lambert(I.IPAL.ceramicDark), 0.16, 0.2, 0.32, -w * 0.3, 0.16, d * 0.3, 10);
    for (let i = 0; i < 3; i++) {
      addCylinder(scene, lib.lambert(I.IPAL.wood), 0.09, 0.09, 0.8, w * 0.34, 0.09 + (i % 2) * 0.16, -d * 0.24 + i * 0.2, 6, 0, Math.PI / 2);
    }
    addBasket(scene, lib, w * 0.36, 0, d * 0.1, 0.2, I.IPAL.grain);
  } else {
    // 衣櫃與衣箱
    I.addWardrobe(scene, lib, -w * 0.37, d * 0.18, 0.1);
    I.addChest(scene, lib, w * 0.3, d * 0.28, -0.2, 0.8);
    // 書桌與椅子
    I.addDesk(scene, lib, w * 0.25, -d * 0.16, -0.35, 1.2, 0.6);
    I.addChair(scene, lib, w * 0.25, d * 0.02, Math.PI * 0.85);
    // 架子供陶罐
    I.addShelf(scene, lib, w * 0.4, -d * 0.32, 0, 1.1, 1.7, 'jars');
  }
  // 地毯與矮桌
  I.addRug(scene, lib, 0, d * 0.12, poor ? 2.4 : 3.2, poor ? 1.7 : 2.2, poor ? I.IPAL.clothTeal : I.IPAL.clothRed);
  if (!poor) {
    I.addLowTable(scene, lib, w * 0.02, d * 0.16, 0.1);
    I.addCushion(scene, lib, -0.45, d * 0.18, I.IPAL.clothRed);
    I.addCushion(scene, lib, 0.68, d * 0.2, I.IPAL.clothBlue);
    I.addPottedPlant(scene, lib, -w * 0.42, -d * 0.36, 1.0);
  }
  // 屏風（宅院）
  if (rich) I.addScreen(scene, lib, assets, w * 0.05, -d * 0.26, 0, 3);
  // 掛軸
  I.addScroll(scene, lib, poor ? w * 0.1 : -w * 0.06, dims.h * 0.6, -d / 2 + 0.16, '福');
  if (!poor) I.addScroll(scene, lib, w * 0.36, dims.h * 0.58, -d / 2 + 0.16, '壽');
  // 人物
  const robes = [I.IPAL.clothBlue, I.IPAL.clothPink, I.IPAL.clothTeal];
  for (let i = 0; i < people; i++) {
    if (i === 0) {
      I.addPerson(scene, lib, { x: 0.25, z: d * 0.18, ry: Math.PI, pose: 'sit', robe: robes[i % 3], hat: 'bun' });
    } else {
      I.addPerson(scene, lib, {
        x: -w * 0.18 + i * 0.7,
        z: d * 0.04,
        ry: Math.PI * 0.8,
        robe: robes[i % 3],
        hat: i % 2 ? 'douli' : 'bun',
      });
    }
  }
}

function fillFarm(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims, key: string): void {
  const { w, d } = dims;
  // 穀囤、麻袋、農具
  I.addGrainBin(scene, lib, -w * 0.3, -d * 0.2, 1.0);
  I.addSackPile(scene, lib, w * 0.32, -d * 0.22, 4);
  I.addToolsCorner(scene, lib, -w * 0.36, d * 0.28, 'farm');
  I.addShelf(scene, lib, w * 0.36, d * 0.08, -Math.PI / 2, 1.6, 1.5, 'none');
  // 曬茶架（茶園）
  if (key === 'teaFarm') {
    I.addShelf(scene, lib, w * 0.05, -d * 0.26, 0, 2.2, 1.3, 'tea');
    addBasket(scene, lib, -w * 0.05, 0, d * 0.22, 0.28, I.IPAL.leaf);
    addBasket(scene, lib, 0.45, 0, d * 0.26, 0.24, I.IPAL.leafDark);
  } else {
    addBasket(scene, lib, -w * 0.05, 0, d * 0.24, 0.3, I.IPAL.grain);
    addBasket(scene, lib, 0.5, 0, d * 0.28, 0.24, I.IPAL.grain);
    // 鋤頭與斗笠掛牆
    addBox(scene, lib.lambert(I.IPAL.wood), 0.06, 1.4, 0.06, -w * 0.16, 1.4, -d / 2 + 0.22, 0.2);
    addBox(scene, lib.lambert(I.IPAL.iron), 0.34, 0.1, 0.07, -w * 0.16, 2.1, -d / 2 + 0.22, 0.5);
    addCone(scene, lib.lambert(I.IPAL.thatchLight), 0.3, 0.16, w * 0.2, 1.9, -d / 2 + 0.24, 12);
  }
  I.addPerson(scene, lib, { x: w * 0.12, z: d * 0.16, ry: Math.PI * 0.85, robe: I.IPAL.clothGreen, hat: 'douli' });
  I.addPerson(scene, lib, { x: -w * 0.16, z: d * 0.05, ry: Math.PI * 0.5, robe: I.IPAL.clothBlue, hat: 'douli' });
}

function fillLumber(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  // 原木堆
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 3; i++) {
      addCylinder(scene, lib.lambert(I.IPAL.wood), 0.17, 0.17, 2.0, -w * 0.3, 0.2 + row * 0.32, -d * 0.28 + i * 0.38 + row * 0.18, 8, 0, Math.PI / 2);
    }
  }
  // 鋸木架
  addBox(scene, lib.lambert(I.IPAL.woodDark), 0.14, 0.7, 0.14, -w * 0.05, 0.35, d * 0.18);
  addBox(scene, lib.lambert(I.IPAL.woodDark), 0.14, 1.0, 0.14, w * 0.28, 0.5, d * 0.18);
  addBox(scene, lib.lambert(I.IPAL.wood), 2.4, 0.16, 0.5, w * 0.06, 0.9, d * 0.18, 0);
  addBox(scene, lib.lambert(I.IPAL.iron), 0.7, 0.03, 0.12, w * 0.1, 1.0, d * 0.18, 0.4);
  // 木板堆與工具
  for (let i = 0; i < 4; i++) {
    addBox(scene, lib.lambert(I.IPAL.woodLight), 1.4, 0.07, 0.4, -w * 0.34, 0.06 + i * 0.08, d * 0.3);
  }
  I.addToolsCorner(scene, lib, w * 0.36, -d * 0.24, 'wood');
  I.addShelf(scene, lib, w * 0.36, -d * 0.02, -Math.PI / 2, 1.2, 1.4, 'none');
  I.addPerson(scene, lib, { x: w * 0.02, z: d * 0.24, ry: Math.PI * 0.9, robe: I.IPAL.clothGreen, hat: 'douli' });
}

function fillQuarry(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims, mine: boolean): void {
  const { w, d } = dims;
  const stone = lib.lambert(I.IPAL.stone);
  const stoneDark = lib.lambert(0x6b675c);
  for (let i = 0; i < 4; i++) {
    addBox(scene, i % 2 ? stone : stoneDark, 0.9, 0.5, 0.7, -w * 0.28 + (i % 2) * 0.95, 0.28 + Math.floor(i / 2) * 0.52, -d * 0.24);
  }
  I.addMineCart(scene, lib, w * 0.24, d * 0.1);
  I.addToolsCorner(scene, lib, -w * 0.36, d * 0.26, 'mine');
  I.addSackPile(scene, lib, w * 0.36, -d * 0.3, 3);
  if (mine) {
    I.addMineCart(scene, lib, -w * 0.1, d * 0.3);
  }
  I.addShelf(scene, lib, w * 0.38, -d * 0.06, -Math.PI / 2, 1.2, 1.3, 'none');
  I.addPerson(scene, lib, { x: w * 0.04, z: d * 0.24, ry: Math.PI * 0.85, robe: I.IPAL.clothBlue, hat: 'douli' });
}

function fillBrewery(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addBrewingVat(scene, lib, -w * 0.24, -d * 0.2, 1.05);
  I.addJarStack(scene, lib, w * 0.26, -d * 0.22, 4);
  I.addJarStack(scene, lib, w * 0.34, d * 0.16, 2);
  addBarrel(scene, lib, -w * 0.02, 0, -d * 0.3, 0.46);
  addBarrel(scene, lib, w * 0.08, 0, -d * 0.28, 0.38);
  addBarrel(scene, lib, w * 0.1, 0, d * 0.3, 0.4);
  I.addSackPile(scene, lib, -w * 0.36, d * 0.24, 4);
  I.addShelf(scene, lib, -w * 0.4, -d * 0.06, Math.PI / 2, 1.2, 1.5, 'jars');
  addBanner(scene, lib, w * 0.4, 0.1, d * 0.24, { height: 2.6, text: '酒', bg: 0xa63e31, ry: Math.PI * 0.8 });
  I.addPerson(scene, lib, { x: -w * 0.06, z: d * 0.1, ry: Math.PI * 0.85, robe: I.IPAL.clothBlue });
  I.addPerson(scene, lib, { x: w * 0.3, z: -d * 0.03, ry: Math.PI * 1.2, robe: I.IPAL.clothTeal, hat: 'bun' });
}

function fillWeaver(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addLoom(scene, lib, -w * 0.22, -d * 0.26, 0.15);
  I.addSpinningWheel(scene, lib, w * 0.3, -d * 0.2);
  I.addShelf(scene, lib, w * 0.38, d * 0.08, -Math.PI / 2, 1.4, 1.5, 'cloth');
  // 布匹桌
  I.addDesk(scene, lib, -w * 0.02, d * 0.2, 0, 1.9, 0.75);
  const clothColors = [I.IPAL.clothPink, I.IPAL.clothBlue, I.IPAL.clothTeal];
  for (let i = 0; i < 3; i++) {
    addBox(scene, lib.lambert(clothColors[i]), 0.44, 0.1, 0.6, -w * 0.28 + i * 0.56, 0.92, d * 0.2);
  }
  addBasket(scene, lib, w * 0.32, 0, d * 0.3, 0.24, I.IPAL.clothPink);
  I.addPerson(scene, lib, { x: -w * 0.05, z: -d * 0.18, ry: Math.PI, pose: 'sit', robe: I.IPAL.clothPink, hat: 'bun' });
  I.addPerson(scene, lib, { x: w * 0.18, z: d * 0.28, ry: Math.PI * 0.8, robe: I.IPAL.clothTeal });
}

function fillBlacksmith(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  const forge = I.addForge(scene, lib, -w * 0.3, -d * 0.02);
  forge.rotation.y = 0.55;
  I.addAnvil(scene, lib, w * 0.12, d * 0.02);
  I.addWeaponRack(scene, lib, w * 0.4, -d * 0.28, -Math.PI / 2);
  addBarrel(scene, lib, w * 0.36, 0, d * 0.18, 0.42);
  I.addToolsCorner(scene, lib, -w * 0.36, d * 0.24, 'mine');
  // 工作臺
  I.addDesk(scene, lib, w * 0.02, d * 0.2, 0, 1.7, 0.7);
  addBox(scene, lib.lambert(I.IPAL.iron), 0.3, 0.1, 0.2, 0.4, 0.9, d * 0.2);
  addBox(scene, lib.lambert(I.IPAL.woodDark), 0.06, 0.4, 0.06, -0.4, 1.0, d * 0.2, 0.4);
  I.addPerson(scene, lib, { x: w * 0.12, z: d * 0.16, ry: -Math.PI / 2, robe: I.IPAL.clothBlue });
  I.addPerson(scene, lib, { x: -w * 0.16, z: d * 0.12, ry: Math.PI * 0.4, robe: I.IPAL.clothGreen, hat: 'none' });
  addSmoke(scene, lib, -w * 0.3, 1.7, -d * 0.02, 0.7);
}

function fillGranary(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addGrainBin(scene, lib, -w * 0.26, -d * 0.2, 1.15);
  I.addGrainBin(scene, lib, w * 0.24, -d * 0.26, 0.85);
  I.addSackPile(scene, lib, -w * 0.32, d * 0.24, 4);
  I.addSackPile(scene, lib, w * 0.26, d * 0.18, 3);
  I.addShelf(scene, lib, w * 0.38, -d * 0.04, -Math.PI / 2, 1.2, 1.4, 'tea');
  // 大秤（置於中央）
  addCylinder(scene, lib.lambert(I.IPAL.woodDark), 0.05, 0.06, 1.9, 0, 0.95, d * 0.1, 6);
  addBox(scene, lib.lambert(I.IPAL.wood), 2.2, 0.08, 0.08, 0, 1.9, d * 0.1);
  for (const sx of [-1.0, 1.0]) {
    addCylinder(scene, lib.lambert(I.IPAL.woodBlack), 0.012, 0.012, 0.52, sx, 1.58, d * 0.1, 4);
    addCylinder(scene, lib.lambert(I.IPAL.woodLight), 0.24, 0.17, 0.13, sx, 1.3, d * 0.1, 10);
  }
  I.addRug(scene, lib, 0, d * 0.1, 3.4, 2.2, I.IPAL.clothTeal);
  I.addPerson(scene, lib, { x: 0.1, z: -d * 0.28, ry: 0, robe: I.IPAL.clothBlue, hat: 'bun' });
}

function fillWarehouse(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addCrateStack(scene, lib, -w * 0.3, -d * 0.24);
  I.addCrateStack(scene, lib, w * 0.26, -d * 0.28);
  I.addCrateStack(scene, lib, w * 0.34, d * 0.12);
  I.addSackPile(scene, lib, -w * 0.28, d * 0.2, 3);
  I.addShelf(scene, lib, -w * 0.4, -d * 0.02, Math.PI / 2, 1.4, 1.6, 'jars');
  I.addCounter(scene, lib, w * 0.02, d * 0.26, 2.2, 0.7, 0.95);
  // 散落貨物
  I.addToolsCorner(scene, lib, w * 0.08, -d * 0.34, 'wood');
  I.addPerson(scene, lib, { x: 0.06, z: d * 0.16, ry: Math.PI, robe: I.IPAL.clothTeal });
  I.addPerson(scene, lib, { x: -w * 0.1, z: -d * 0.12, ry: -Math.PI / 2, robe: I.IPAL.clothBlue, hat: 'douli' });
}

function fillMarket(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addGoodsRack(scene, lib, -w * 0.3, -d * 0.2, Math.PI / 2, I.IPAL.grain);
  I.addGoodsRack(scene, lib, w * 0.28, -d * 0.24, -Math.PI / 2, I.IPAL.clothPink);
  I.addCounter(scene, lib, -w * 0.02, d * 0.16, 2.4, 0.75, 0.9);
  I.addSackPile(scene, lib, w * 0.34, d * 0.24, 3);
  addBasket(scene, lib, -w * 0.1, 0, d * 0.28, 0.3, I.IPAL.leaf);
  addBasket(scene, lib, w * 0.08, 0, d * 0.3, 0.26, I.IPAL.grain);
  // 市旗
  addBanner(scene, lib, -w * 0.38, 0.1, d * 0.26, { height: 2.5, text: '市', bg: 0x4e7f74, ry: Math.PI * 0.75 });
  addBanner(scene, lib, w * 0.38, 0.1, d * 0.26, { height: 2.3, text: '米', bg: 0xa63e31, ry: Math.PI * 1.25 });
  I.addPerson(scene, lib, { x: -w * 0.03, z: d * 0.05, ry: 0, robe: I.IPAL.clothTeal });
  I.addPerson(scene, lib, { x: w * 0.22, z: d * 0.06, ry: Math.PI * 0.7, robe: I.IPAL.clothPink, hat: 'bun' });
  I.addPerson(scene, lib, { x: -w * 0.26, z: d * 0.18, ry: -Math.PI * 0.4, robe: I.IPAL.clothBlue, hat: 'douli' });
}

function fillTeahouse(scene: THREE.Scene, lib: MaterialLibrary, assets: I.InteriorAssets, dims: Dims): void {
  const { w, d } = dims;
  I.addTeaCounter(scene, lib, w * 0.02, -d * 0.26, 2.8);
  I.addTeaTable(scene, lib, -w * 0.26, d * 0.1, 0.5);
  I.addTeaTable(scene, lib, w * 0.26, d * 0.16, 0.45);
  addStool(scene, lib, -w * 0.36, 0, d * 0.1, 0.16, 0.42);
  addStool(scene, lib, -w * 0.16, 0, d * 0.1, 0.16, 0.42);
  addStool(scene, lib, w * 0.36, 0, d * 0.18, 0.16, 0.42);
  I.addScreen(scene, lib, assets, -w * 0.08, -d * 0.22, 0.1, 3);
  I.addShelf(scene, lib, -w * 0.4, -d * 0.04, Math.PI / 2, 1.2, 1.5, 'tea');
  I.addScroll(scene, lib, w * 0.16, dims.h * 0.6, -d / 2 + 0.18, '茶');
  addBanner(scene, lib, -w * 0.42, 0.1, d * 0.28, { height: 2.6, text: '茶', bg: 0x4e7f74, ry: Math.PI * 0.8 });
  I.addPottedPlant(scene, lib, w * 0.38, -d * 0.32, 1.1);
  I.addPerson(scene, lib, { x: -w * 0.3, z: d * 0.02, ry: Math.PI / 2, pose: 'sit', robe: I.IPAL.clothBlue, hat: 'bun' });
  I.addPerson(scene, lib, { x: w * 0.2, z: d * 0.04, ry: -Math.PI / 2, pose: 'sit', robe: I.IPAL.clothTeal, hat: 'official' });
  I.addPerson(scene, lib, { x: 0.1, z: -d * 0.1, ry: Math.PI, robe: I.IPAL.clothPink, hat: 'bun' });
}

function fillInn(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addCounter(scene, lib, -w * 0.02, -d * 0.26, 2.9, 0.85, 1.05);
  I.addJarStack(scene, lib, -w * 0.36, -d * 0.22, 4);
  I.addJarStack(scene, lib, w * 0.34, -d * 0.26, 3);
  addTable(scene, lib, -w * 0.24, 0, d * 0.12, 1.3, 0.7, 0.66);
  addTable(scene, lib, w * 0.24, 0, d * 0.18, 1.1, 0.7, 0.66);
  for (const [sx, sz] of [
    [-w * 0.34, d * 0.12],
    [-w * 0.14, d * 0.12],
    [w * 0.14, d * 0.18],
    [w * 0.34, d * 0.18],
  ]) {
    addStool(scene, lib, sx, 0, sz + 0.55, 0.16, 0.42);
  }
  addBarrel(scene, lib, w * 0.38, 0, d * 0.3, 0.44);
  addBanner(scene, lib, -w * 0.44, 0.1, d * 0.26, { height: 2.8, text: '酒', bg: 0xa63e31, ry: Math.PI * 0.8 });
  I.addScroll(scene, lib, -w * 0.16, dims.h * 0.6, -d / 2 + 0.18, '酒');
  I.addScroll(scene, lib, w * 0.18, dims.h * 0.6, -d / 2 + 0.18, '宿');
  I.addPerson(scene, lib, { x: -w * 0.25, z: d * 0.05, ry: Math.PI / 2, pose: 'sit', robe: I.IPAL.clothTeal, hat: 'bun' });
  I.addPerson(scene, lib, { x: w * 0.24, z: d * 0.1, ry: -Math.PI / 2, pose: 'sit', robe: I.IPAL.clothBlue, hat: 'bun' });
  I.addPerson(scene, lib, { x: 0, z: -d * 0.14, ry: 0, pose: 'stand', robe: I.IPAL.clothPink, hat: 'bun' });
}

function fillWell(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  const stone = lib.lambert(I.IPAL.stone);
  const stoneLight = lib.lambert(I.IPAL.stoneLight);
  // 井
  addCylinder(scene, stone, 0.78, 0.86, 0.72, 0, 0.36, -d * 0.06, 12);
  addCylinder(scene, stoneLight, 0.9, 0.9, 0.1, 0, 0.74, -d * 0.06, 12);
  addCylinder(scene, lib.lambert(I.IPAL.water), 0.66, 0.66, 0.04, 0, 0.6, -d * 0.06, 12);
  // 井架與轆轤
  const wood = lib.lambert(I.IPAL.woodDark);
  addCylinder(scene, wood, 0.08, 0.1, 2.3, -0.95, 1.15, -d * 0.06, 6);
  addCylinder(scene, wood, 0.08, 0.1, 2.3, 0.95, 1.15, -d * 0.06, 6);
  addBox(scene, wood, 2.1, 0.14, 0.14, 0, 2.28, -d * 0.06);
  addCylinder(scene, lib.lambert(I.IPAL.wood), 0.2, 0.2, 1.6, 0, 2.1, -d * 0.06, 10, 0, Math.PI / 2);
  addBox(scene, lib.lambert(I.IPAL.woodLight), 0.08, 0.7, 0.08, 1.0, 2.1, -d * 0.06, 0.5);
  addCylinder(scene, lib.lambert(I.IPAL.woodBlack), 0.02, 0.02, 1.3, 0, 1.4, -d * 0.06, 4);
  addCylinder(scene, lib.lambert(I.IPAL.woodLight), 0.2, 0.17, 0.3, 0, 0.75, -d * 0.06, 10);
  addWaterJar(scene, lib, w * 0.3, 0, d * 0.16, 1.1);
  addBasket(scene, lib, -w * 0.3, 0, d * 0.2, 0.26, I.IPAL.grain);
  I.addPottedPlant(scene, lib, w * 0.36, -d * 0.3, 0.9);
  I.addPerson(scene, lib, { x: 0.9, z: -d * 0.02, ry: -Math.PI / 2, robe: I.IPAL.clothBlue, hat: 'bun' });
}

function fillTemple(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addBuddhaShrine(scene, lib, 0, -d * 0.24);
  I.addShelf(scene, lib, -w * 0.4, d * 0.06, Math.PI / 2, 1.3, 1.4, 'jars');
  // 香案前的蒲團與香爐
  for (const sx of [-0.7, 0, 0.7]) {
    I.addCushion(scene, lib, sx, d * 0.02, I.IPAL.clothGold);
  }
  addCylinder(scene, lib.lambert(I.IPAL.bronze), 0.42, 0.34, 0.4, 0, 0.2, d * 0.24, 12);
  addCylinder(scene, lib.lambert(I.IPAL.bronze), 0.48, 0.48, 0.08, 0, 0.44, d * 0.24, 12);
  addSmoke(scene, lib, 0, 0.55, d * 0.24, 1.0);
  // 鐘鼓
  const bellG = new THREE.Group();
  bellG.position.set(-w * 0.36, 0, -d * 0.16);
  scene.add(bellG);
  addBox(bellG, lib.lambert(I.IPAL.woodDark), 0.08, 2.4, 0.08, -0.5, 1.2, 0);
  addBox(bellG, lib.lambert(I.IPAL.woodDark), 0.08, 2.4, 0.08, 0.5, 1.2, 0);
  addBox(bellG, lib.lambert(I.IPAL.woodDark), 1.1, 0.12, 0.12, 0, 2.4, 0);
  addLathe(bellG, lib.lambert(I.IPAL.bronze), [
    [0.001, 0],
    [0.3, 0.02],
    [0.28, 0.4],
    [0.14, 0.66],
    [0.001, 0.7],
  ], 0, 1.2, 0, 14);
  addDrum(scene, lib, w * 0.36, -d * 0.2, 1.2, -0.4);
  // 幡與畫軸
  addBanner(scene, lib, -w * 0.44, 0.1, d * 0.28, { height: 3.0, text: '佛', bg: 0xb99247, ry: Math.PI * 0.8 });
  addBanner(scene, lib, w * 0.44, 0.1, d * 0.28, { height: 3.0, text: '禪', bg: 0xa63e31, ry: Math.PI * 1.2 });
  addPlaque(scene, lib, 0, dims.h * 0.72, -d / 2 + 0.2, '大雄寶殿', { w: 1.8, h: 0.42 });
  I.addPerson(scene, lib, { x: 0.1, z: d * 0.06, ry: Math.PI, pose: 'kneel', robe: I.IPAL.clothGold, hat: 'none' });
  I.addPerson(scene, lib, { x: w * 0.24, z: -d * 0.02, ry: -Math.PI / 3, robe: I.IPAL.clothRed, hat: 'bun' });
}

function fillSchool(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addMasterDesk(scene, lib, 0, -d * 0.24, 0);
  addPlaque(scene, lib, 0, dims.h * 0.72, -d / 2 + 0.2, '萬世師表', { w: 1.7, h: 0.4 });
  for (let i = 0; i < 3; i++) {
    I.addSchoolDesk(scene, lib, -w * 0.26 + i * (w * 0.26), d * 0.12, 0);
    I.addPerson(scene, lib, {
      x: -w * 0.26 + i * (w * 0.26),
      z: d * 0.16,
      ry: Math.PI,
      pose: 'sit',
      robe: [I.IPAL.clothBlue, I.IPAL.clothTeal, I.IPAL.clothGreen][i],
      hat: i % 2 ? 'bun' : 'official',
    });
  }
  I.addShelf(scene, lib, w * 0.38, -d * 0.06, -Math.PI / 2, 1.4, 1.7, 'books');
  I.addShelf(scene, lib, -w * 0.38, -d * 0.04, Math.PI / 2, 1.2, 1.5, 'books');
  I.addScroll(scene, lib, -w * 0.2, dims.h * 0.6, -d / 2 + 0.18, '學');
  I.addScroll(scene, lib, w * 0.2, dims.h * 0.6, -d / 2 + 0.18, '禮');
  addBanner(scene, lib, w * 0.44, 0.1, d * 0.28, { height: 2.7, text: '學', bg: 0x466880, ry: Math.PI * 1.2 });
  I.addPerson(scene, lib, { x: 0, z: d * 0.28, ry: 0, robe: I.IPAL.clothBlue, hat: 'official', scale: 1.05 });
}

function fillYamen(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addMagistrateDesk(scene, lib, 0, -d * 0.22, 0);
  addPlaque(scene, lib, 0, dims.h * 0.74, -d / 2 + 0.2, '明鏡高懸', { w: 2.0, h: 0.46 });
  // 兩側水火棍與兵器架
  I.addWeaponRack(scene, lib, -w * 0.38, -d * 0.16, Math.PI / 2);
  I.addWeaponRack(scene, lib, w * 0.38, -d * 0.16, -Math.PI / 2);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      addCylinder(scene, lib.lambert(i === 1 ? I.IPAL.pillar : I.IPAL.woodDark), 0.035, 0.035, 1.7, side * (w * 0.16 + i * 0.14), 0.85, d * 0.16, 5);
    }
  }
  // 鳴冤鼓與屏風
  addDrum(scene, lib, -w * 0.34, d * 0.14, 1.1, Math.PI / 2);
  I.addScroll(scene, lib, -w * 0.28, dims.h * 0.6, -d / 2 + 0.2, '清');
  I.addScroll(scene, lib, w * 0.28, dims.h * 0.6, -d / 2 + 0.2, '正');
  // 堂鼓、公案、差役與知府
  I.addPerson(scene, lib, { x: 0, z: -d * 0.08, ry: Math.PI, pose: 'sit', robe: I.IPAL.clothRed, hat: 'official', scale: 1.05 });
  I.addPerson(scene, lib, { x: -w * 0.24, z: d * 0.06, ry: Math.PI / 2.4, robe: I.IPAL.clothBlue, hat: 'none' });
  I.addPerson(scene, lib, { x: w * 0.24, z: d * 0.06, ry: -Math.PI / 2.4, robe: I.IPAL.clothTeal, hat: 'none' });
  I.addPottedPlant(scene, lib, -w * 0.42, -d * 0.36, 1.0);
  I.addPottedPlant(scene, lib, w * 0.42, -d * 0.36, 1.0);
}

function fillPavilion(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { d } = dims;
  // 石桌石凳
  addCylinder(scene, lib.lambert(I.IPAL.stoneLight), 0.42, 0.46, 0.72, 0, 0.36, -d * 0.02, 10);
  addCylinder(scene, lib.lambert(I.IPAL.stoneLight), 0.55, 0.55, 0.1, 0, 0.76, -d * 0.02, 10);
  for (const a of [0.3, 1.5, 2.7, 3.9]) {
    addCylinder(scene, lib.lambert(I.IPAL.stone), 0.2, 0.24, 0.42, Math.cos(a) * 1.25, 0.21, Math.sin(a) * 1.1 - d * 0.02, 8);
  }
  // 茶具
  addLathe(scene, lib.lambert(I.IPAL.clothTeal), [
    [0.001, 0],
    [0.1, 0.01],
    [0.13, 0.1],
    [0.07, 0.18],
    [0.04, 0.22],
  ], 0.1, 0.8, -d * 0.02, 10);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    addCylinder(scene, lib.lambert(I.IPAL.paper), 0.055, 0.04, 0.06, 0.1 + Math.cos(a) * 0.3, 0.84, -d * 0.02 + Math.sin(a) * 0.3, 8);
  }
  // 欄凳
  for (const side of [-1, 1]) {
    addBox(scene, lib.lambert(I.IPAL.woodDark), 2.6, 0.1, 0.34, 0, 0.55, side * (d / 2 - 0.5));
    addBox(scene, lib.lambert(I.IPAL.woodDark), 0.34, 0.1, d - 1.2, side * (Math.min(3.4, dims.w / 2 - 0.4)), 0.55, 0);
  }
  // 盆栽與古琴
  I.addPottedPlant(scene, lib, -2.2, -d * 0.22, 1.2);
  I.addPottedPlant(scene, lib, 2.3, -d * 0.2, 1.0);
  addBox(scene, lib.lambert(I.IPAL.woodDark), 1.3, 0.1, 0.4, 0, 0.85, -d * 0.24, 0.2);
  addBox(scene, lib.lambert(I.IPAL.woodBlack), 1.1, 0.06, 0.28, 0, 0.92, -d * 0.24, 0.2);
  I.addPerson(scene, lib, { x: -1.1, z: -d * 0.16, ry: Math.PI * 0.7, pose: 'kneel', robe: I.IPAL.clothBlue, hat: 'bun' });
  I.addPerson(scene, lib, { x: 1.5, z: d * 0.06, ry: -Math.PI * 0.4, robe: I.IPAL.clothTeal, hat: 'official' });
}

function fillDock(scene: THREE.Scene, lib: MaterialLibrary, dims: Dims): void {
  const { w, d } = dims;
  I.addCrateStack(scene, lib, -w * 0.3, -d * 0.24);
  I.addCrateStack(scene, lib, w * 0.26, -d * 0.26);
  I.addDockGear(scene, lib, -w * 0.08, d * 0.12);
  addBarrel(scene, lib, w * 0.36, 0, d * 0.22, 0.44);
  I.addSackPile(scene, lib, -w * 0.34, d * 0.2, 3);
  I.addCounter(scene, lib, w * 0.02, -d * 0.28, 2.2, 0.7, 0.95);
  addBanner(scene, lib, w * 0.42, 0.1, d * 0.24, { height: 2.5, text: '貨', bg: 0x466880, ry: Math.PI * 1.2 });
  addPlaque(scene, lib, 0, dims.h * 0.72, -d / 2 + 0.2, '碼頭', { w: 1.4, h: 0.38 });
  I.addPerson(scene, lib, { x: 0, z: -d * 0.12, ry: Math.PI, robe: I.IPAL.clothBlue });
  I.addPerson(scene, lib, { x: -w * 0.18, z: d * 0.1, ry: Math.PI * 0.4, robe: I.IPAL.clothTeal, hat: 'douli' });
}

// ─────────────────────────── 動畫收集 ───────────────────────────

function collectAnimParts(scene: THREE.Scene): { parts: AnimPart[]; lanternLights: THREE.Object3D[] } {
  const parts: AnimPart[] = [];
  const lanterns: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    const kind = obj.userData?.anim as string | undefined;
    if (!kind) return;
    if (kind === 'lantern') lanterns.push(obj);
    const part: AnimPart = {
      obj,
      kind,
      phase: parts.length * 1.37,
      baseY: obj.position.y,
      baseRotX: obj.rotation.x,
      baseRotY: obj.rotation.y,
      baseRotZ: obj.rotation.z,
      baseScale: obj.scale.x,
    };
    if (kind === 'smoke') {
      part.smokeChildren = obj.children.map((child, i) => ({
        mesh: child,
        baseScale: child.scale.x,
        baseY: child.position.y,
        offset: i * 0.32,
      }));
    }
    parts.push(part);
  });
  return { parts, lanternLights: lanterns };
}

/** 依時辰計算日照 0..1（與 environment 對齊的近似）。 */
function daylightFactor(clock: GameState['clock']): number {
  const t = (clock.hour * 60 + clock.minute) / 1440;
  return Math.max(0.04, Math.min(1, Math.sin((t - 0.22) * Math.PI * 2) * 0.62 + 0.5));
}

// ─────────────────────────── 主建立函式 ───────────────────────────

const FALLBACK_DEF = (key: string): BuildingDef => ({
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
});

export function createInteriorView(state: GameState, buildingId: number): InteriorView | null {
  const building: Building | undefined = state.buildings.find((b) => b.id === buildingId);
  if (!building) return null;
  const def: BuildingDef = BUILDINGS[building.key] ?? FALLBACK_DEF(building.key);

  const lib = new MaterialLibrary();
  const assets = I.createInteriorAssets(lib);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(ROOM_BG);

  const wTiles = def.size[0];
  const hTiles = def.size[1];
  const outdoor = building.key === 'pavilion';
  const mineShaft = building.key === 'ironMine';
  const dims: Dims = {
    w: 7 + (wTiles - 1) * 1.95,
    d: 6.2 + (hTiles - 1) * 1.75,
    h: 3.1 + (Math.max(wTiles, hTiles) - 1) * 0.62,
  };
  const { w, d, h } = dims;

  const roomOpts: RoomOptions = { outdoor };
  if (mineShaft) {
    roomOpts.noWindows = true;
    roomOpts.wallColor = 0x8a7f6e;
    roomOpts.pillarColor = 0x6b4a33;
  }
  const templeLike = building.key === 'temple' || building.key === 'yamen';
  if (templeLike) roomOpts.pillarColor = I.IPAL.pillar;
  if (outdoor) {
    scene.background = new THREE.Color(0x9ec8e8);
    scene.fog = new THREE.Fog(0xb8d4e8, 40, 90);
  } else {
    scene.fog = new THREE.Fog(ROOM_BG, 22, 52);
  }

  const room = buildRoom(scene, lib, assets, dims, roomOpts);

  if (outdoor) {
    // 涼亭：補上頭頂的攢尖屋頂（從內側看見深色椽底）
    addChineseRoof(scene, lib, {
      width: w + 1.0,
      depth: d + 1.0,
      height: 1.1,
      ridge: 0,
      cornerLift: 0.28,
      cornerFlare: 0.16,
      tileColor: 0x56616f,
      ornaments: 'none',
      y: h + 0.02,
      slopeSegments: 4,
      edgeSegments: 5,
    });
  }

  if (outdoor) {
    // 涼亭外景：遠山、樹木、石燈
    const hillMat = lib.lambert(0x7e9a7a);
    const farMat = lib.lambert(0x8fa8b8);
    for (let i = 0; i < 5; i++) {
      const tree = new THREE.Group();
      const tx = -9 + i * 4.6;
      const tz = -9 - (i % 2) * 2;
      tree.position.set(tx, 0, tz);
      addCylinder(tree, lib.lambert(I.IPAL.woodDark), 0.12, 0.18, 1.6, 0, 0.8, 0, 6);
      addCone(tree, i % 2 ? hillMat : farMat, 1.1 + (i % 3) * 0.25, 2.6, 0, 2.2, 0, 7);
      scene.add(tree);
    }
    addCone(scene, farMat, 7, 8, -12, 4, -22, 6);
    addCone(scene, hillMat, 5.5, 6, 10, 3, -20, 6);
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(60, 0.1, 60), lib.lambert(0x86a85c)));
    const grass = scene.children[scene.children.length - 1] as THREE.Mesh;
    grass.position.y = -0.06;
    grass.receiveShadow = true;
    addCylinder(scene, lib.lambert(I.IPAL.stoneDark), 0.16, 0.2, 0.7, -2.8, 0.35, -3.2, 8);
    addCone(scene, lib.lambert(I.IPAL.stoneLight), 0.22, 0.3, -2.8, 0.85, -3.2, 8);
  }

  // ── 各類型陳設 ──
  const residents = building.residents.length;
  const workers = building.workers.length;
  const key = building.key;
  switch (key) {
    case 'hut':
      fillResidential(scene, lib, assets, dims, key, 1);
      break;
    case 'house':
      fillResidential(scene, lib, assets, dims, key, Math.max(1, Math.min(3, Math.ceil(residents / 3))));
      break;
    case 'manor':
      fillResidential(scene, lib, assets, dims, key, 3);
      break;
    case 'farm':
      fillFarm(scene, lib, dims, key);
      break;
    case 'teaFarm':
      fillFarm(scene, lib, dims, key);
      break;
    case 'lumber':
      fillLumber(scene, lib, dims);
      break;
    case 'quarry':
      fillQuarry(scene, lib, dims, false);
      break;
    case 'ironMine':
      fillQuarry(scene, lib, dims, true);
      break;
    case 'brewery':
      fillBrewery(scene, lib, dims);
      break;
    case 'weaver':
      fillWeaver(scene, lib, dims);
      break;
    case 'blacksmith':
      fillBlacksmith(scene, lib, dims);
      break;
    case 'granary':
      fillGranary(scene, lib, dims);
      break;
    case 'warehouse':
      fillWarehouse(scene, lib, dims);
      break;
    case 'market':
      fillMarket(scene, lib, dims);
      break;
    case 'teahouse':
      fillTeahouse(scene, lib, assets, dims);
      break;
    case 'inn':
      fillInn(scene, lib, dims);
      break;
    case 'well':
      fillWell(scene, lib, dims);
      break;
    case 'temple':
      fillTemple(scene, lib, dims);
      break;
    case 'school':
      fillSchool(scene, lib, dims);
      break;
    case 'yamen':
      fillYamen(scene, lib, dims);
      break;
    case 'pavilion':
      fillPavilion(scene, lib, dims);
      break;
    case 'dock':
      fillDock(scene, lib, dims);
      break;
    default:
      fillResidential(scene, lib, assets, dims, key, 1);
      break;
  }
  void workers;

  // ── 相機 ──
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
  const camBase = new THREE.Vector3(0, h * 0.52 + 1.6, d * 0.5 + (outdoor ? 4.6 : 3.4));
  const camLook = new THREE.Vector3(0, h * 0.4, outdoor ? d * 0.05 : -d * 0.12);
  camera.position.copy(camBase);
  camera.lookAt(camLook);
  if (outdoor) {
    camera.position.set(0, 2.9, d * 0.5 + 5.2);
    camera.lookAt(0, 1.35, -d * 0.04);
  }

  // ── 動畫 ──
  const { parts } = collectAnimParts(scene);
  let elapsed = 0;
  const flicker = (seed: number): number => 0.86 + Math.sin(elapsed * 7.3 + seed) * 0.07 + Math.sin(elapsed * 13.1 + seed * 2.1) * 0.05;

  const update = (s: GameState, dt: number): void => {
    elapsed += Math.min(0.1, dt);
    const day = daylightFactor(s.clock);
    const weather = s.clock.weather;
    const overcast = weather === 'rain' || weather === 'snow' ? 0.55 : weather === 'cloudy' ? 0.8 : 1;

    // 窗光隨晝夜與天氣
    room.windowLight.intensity = (0.3 + day * 2.3) * overcast;
    room.windowLight.color.setHex(day > 0.5 ? 0xffe6bd : 0x9fb6d8);
    room.windowView.color.setRGB(
      (0.22 + day * 0.78) * (overcast * 0.4 + 0.6),
      (0.24 + day * 0.76) * (overcast * 0.4 + 0.6),
      (0.32 + day * 0.68) * (overcast * 0.4 + 0.6),
    );
    room.hemi.intensity = 0.18 + day * 0.3;
    room.ambient.intensity = 0.34 + (1 - day) * 0.12;

    // 燈籠／油燈明滅
    for (let i = 0; i < room.lamps.length; i++) {
      room.lamps[i].intensity = (13 + (1 - day) * 20) * flicker(i * 1.7);
    }
    if (room.candleLight) room.candleLight.intensity = 6 + (1 - day) * 6;

    // 動畫部件
    for (const part of parts) {
      const t = elapsed;
      switch (part.kind) {
        case 'lantern':
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.25 + part.phase) * 0.055;
          part.obj.rotation.x = part.baseRotX + Math.sin(t * 0.8 + part.phase * 1.2) * 0.02;
          break;
        case 'banner':
          part.obj.rotation.z = part.baseRotZ + Math.sin(t * 1.5 + part.phase) * 0.05;
          part.obj.rotation.y = part.baseRotY + Math.sin(t * 0.9 + part.phase) * 0.035;
          break;
        case 'smoke':
          if (part.smokeChildren) {
            for (const child of part.smokeChildren) {
              const cycle = (t * 0.25 + part.phase * 0.1 + child.offset) % 1;
              child.mesh.scale.setScalar(child.baseScale * (0.4 + cycle * 1.6));
              child.mesh.position.y = child.baseY + cycle * 1.1;
            }
          }
          break;
        case 'flame': {
          const scl = 1 + Math.sin(t * 9 + part.phase) * 0.16 + Math.sin(t * 23 + part.phase) * 0.08;
          part.obj.scale.set(part.baseScale, part.baseScale * scl, part.baseScale);
          break;
        }
        case 'glow': {
          const scl = 1 + Math.sin(t * 3.4 + part.phase) * 0.14;
          part.obj.scale.setScalar(part.baseScale * scl);
          break;
        }
        case 'person': {
          part.obj.position.y = part.baseY + Math.sin(t * 1.1 + part.phase) * 0.008;
          part.obj.rotation.z = Math.sin(t * 0.7 + part.phase) * 0.006;
          break;
        }
        case 'bob': {
          part.obj.position.y = part.baseY + Math.sin(t * 0.8 + part.phase) * 0.05;
          break;
        }
        case 'wheel':
          part.obj.rotation.z = part.baseRotZ + t * 0.8;
          break;
      }
    }
    // 相機極輕微呼吸
    camera.position.x = camBase.x + Math.sin(elapsed * 0.21) * 0.045;
    camera.position.y = camBase.y + Math.sin(elapsed * 0.17 + 1.2) * 0.02;
    camera.lookAt(camLook);
  };

  update(state, 0);

  return {
    scene,
    camera,
    update,
    dispose(): void {
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
        }
        const line = obj as THREE.Line;
        if (line.isLine || (line as THREE.LineSegments).isLineSegments) {
          line.geometry?.dispose();
        }
      });
      room.windowLight.shadow.map?.dispose();
      room.windowLight.dispose();
      for (const lamp of room.lamps) lamp.dispose();
      room.candleLight?.dispose();
      lib.dispose();
      scene.clear();
    },
  };
}
