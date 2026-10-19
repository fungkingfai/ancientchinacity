/**
 * 道路渲染：青石板路 + 路緣石 + 交叉口鋪石 + 臨水欄杆與木板小橋。
 *
 * - 石板：InstancedMesh，貼圖為程序化青石板，逐塊隨機轉向與明暗。
 * - 高度：跟隨地形（world-utils.roadSurfaceY），丘陵上的道路會逐級抬升。
 * - 路面重建只在道路集合變更時發生（以 signature 偵測），其餘時間零成本。
 */

import * as THREE from 'three';
import type { GameState } from '../core/types';
import { hash2d } from '../core/rng';
import { TILE, tileWorld } from './coords';
import {
  createCurbGeometry,
  createIntersectionStoneGeometry,
  createPlankTexture,
  createRailingGeometry,
  createStoneTexture,
} from './world-geometry';
import { roadSurfaceY } from './world-utils';

export interface RoadsView {
  group: THREE.Group;
  update(state: GameState, dt: number): void;
  dispose(): void;
}

const SLAB_THICKNESS = 0.1;

export function createRoadsView(state: GameState): RoadsView {
  const group = new THREE.Group();
  group.name = 'roads';

  const seed = state.seed >>> 0;
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  // ─────────── 共用資源（只建立一次） ───────────
  const slabGeo = new THREE.BoxGeometry(TILE * 0.99, SLAB_THICKNESS, TILE * 0.99);
  slabGeo.translate(0, -SLAB_THICKNESS / 2, 0); // 原點在路面頂部

  const deckGeo = new THREE.BoxGeometry(TILE * 0.99, 0.065, TILE * 0.99);
  deckGeo.translate(0, -0.035, 0);

  const stoneTex = createStoneTexture();
  const plankTex = createPlankTexture();

  const slabMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    map: stoneTex ?? undefined,
  });
  const deckMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    map: plankTex ?? undefined,
  });
  const curbMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const stoneMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const railMat = new THREE.MeshLambertMaterial({ vertexColors: true });

  const curbGeo = createCurbGeometry();
  const stoneGeo = createIntersectionStoneGeometry();
  const railGeo = createRailingGeometry();

  let slabs: THREE.InstancedMesh | null = null;
  let decks: THREE.InstancedMesh | null = null;
  let curbs: THREE.InstancedMesh | null = null;
  let corners: THREE.InstancedMesh | null = null;
  let rails: THREE.InstancedMesh | null = null;

  interface CurbPlacement {
    x: number;
    z: number;
    y: number;
    rot: number;
  }
  interface RailPlacement {
    x: number;
    z: number;
    y: number;
    rot: number;
  }

  const makeMesh = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    count: number,
    name: string,
    castShadow = false,
  ): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    mesh.name = name;
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.receiveShadow = true;
    mesh.castShadow = castShadow;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  const clearMeshes = (): void => {
    for (const m of [slabs, decks, curbs, corners, rails]) {
      if (!m) continue;
      group.remove(m);
      m.dispose();
    }
    slabs = decks = curbs = corners = rails = null;
  };

  const rebuild = (s: GameState): void => {
    clearMeshes();
    const roadTiles: number[] = [];
    for (let i = 0; i < s.tiles.length; i++) if (s.tiles[i].road) roadTiles.push(i);

    if (roadTiles.length === 0) return;

    const curbList: CurbPlacement[] = [];
    const railList: RailPlacement[] = [];
    const cornerTiles: number[] = [];
    const deckTiles: number[] = [];

    const isRoad = (x: number, y: number): boolean =>
      x < 0 || y < 0 || x >= s.width || y >= s.height ? false : s.tiles[y * s.width + x].road;
    const isWater = (x: number, y: number): boolean =>
      x < 0 || y < 0 || x >= s.width || y >= s.height ? false : s.tiles[y * s.width + x].terrain === 'water';

    for (const idx of roadTiles) {
      const tx = idx % s.width;
      const ty = Math.floor(idx / s.width);
      const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
      const surfaceY = roadSurfaceY(s.tiles[idx]);

      const nRoad = isRoad(tx, ty - 1);
      const sRoad = isRoad(tx, ty + 1);
      const eRoad = isRoad(tx + 1, ty);
      const wRoad = isRoad(tx - 1, ty);
      const hasWaterNeighbor =
        isWater(tx, ty - 1) || isWater(tx, ty + 1) || isWater(tx + 1, ty) || isWater(tx - 1, ty);
      if (hasWaterNeighbor) deckTiles.push(idx);

      // 交叉口：東⻄向與南北向道路交會（橋面不做中央鋪石）
      const waterNeighbor =
        isWater(tx, ty - 1) || isWater(tx, ty + 1) || isWater(tx + 1, ty) || isWater(tx - 1, ty);
      if (!waterNeighbor && (nRoad || sRoad) && (eRoad || wRoad)) cornerTiles.push(idx);

      // 路緣：非道路、非水域的邊
      const curbEdges: [number, number, number][] = [
        [0, -1, 0], // 北
        [0, 1, Math.PI], // 南
        [1, 0, Math.PI / 2], // 東
        [-1, 0, -Math.PI / 2], // 西
      ];
      for (const [dx, dz, rot] of curbEdges) {
        const nx = tx + dx;
        const ny = ty + dz;
        if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) continue;
        if (isRoad(nx, ny) || isWater(nx, ny)) continue;
        curbList.push({
          x: wx + dx * (TILE / 2 - 0.1),
          z: wz + dz * (TILE / 2 - 0.1),
          y: surfaceY + 0.012,
          rot,
        });
      }

      // 臨水欄杆（橋樑兩側）
      if (isWater(tx, ty - 1)) railList.push({ x: wx, z: wz - TILE / 2 + 0.09, y: surfaceY + 0.01, rot: 0 });
      if (isWater(tx, ty + 1)) railList.push({ x: wx, z: wz + TILE / 2 - 0.09, y: surfaceY + 0.01, rot: 0 });
      if (isWater(tx - 1, ty)) railList.push({ x: wx - TILE / 2 + 0.09, z: wz, y: surfaceY + 0.01, rot: Math.PI / 2 });
      if (isWater(tx + 1, ty)) railList.push({ x: wx + TILE / 2 - 0.09, z: wz, y: surfaceY + 0.01, rot: Math.PI / 2 });
    }

    // 石板
    slabs = makeMesh(slabGeo, slabMat, roadTiles.length, 'road-slabs');
    roadTiles.forEach((idx, n) => {
      const tx = idx % s.width;
      const ty = Math.floor(idx / s.width);
      const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
      const h = hash2d(tx, ty, seed + 9001);
      dummy.position.set(wx, roadSurfaceY(s.tiles[idx]), wz);
      dummy.rotation.set(0, Math.floor(h * 4) * (Math.PI / 2), 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      slabs!.setMatrixAt(n, dummy.matrix);
      const shade = 0.98 + h * 0.1;
      color.setRGB(shade, shade * 0.995, shade * 0.985);
      slabs!.setColorAt(n, color);
    });
    slabs.instanceMatrix.needsUpdate = true;
    if (slabs.instanceColor) slabs.instanceColor.needsUpdate = true;

    // 木板橋面（跨河渡口上的道路）
    if (deckTiles.length) {
      decks = makeMesh(deckGeo, deckMat, deckTiles.length, 'road-bridges');
      deckTiles.forEach((idx, n) => {
        const tx = idx % s.width;
        const ty = Math.floor(idx / s.width);
        const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
        const h = hash2d(tx, ty, seed + 9101);
        dummy.position.set(wx, roadSurfaceY(s.tiles[idx]) + 0.022, wz);
        dummy.rotation.set(0, Math.floor(h * 4) * (Math.PI / 2), 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        decks!.setMatrixAt(n, dummy.matrix);
        const shade = 0.82 + h * 0.2;
        color.setRGB(shade, shade * 0.94, shade * 0.86);
        decks!.setColorAt(n, color);
      });
      decks.instanceMatrix.needsUpdate = true;
      if (decks.instanceColor) decks.instanceColor.needsUpdate = true;
    }

    // 路緣石
    if (curbList.length) {
      curbs = makeMesh(curbGeo, curbMat, curbList.length, 'road-curbs');
      curbList.forEach((p, n) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        curbs!.setMatrixAt(n, dummy.matrix);
        const shade = 0.72 + hash2d(n, 3, seed + 9201) * 0.16;
        color.setRGB(shade, shade, shade * 1.02);
        curbs!.setColorAt(n, color);
      });
      curbs.instanceMatrix.needsUpdate = true;
      if (curbs.instanceColor) curbs.instanceColor.needsUpdate = true;
    }

    // 交叉口中央鋪石
    if (cornerTiles.length) {
      corners = makeMesh(stoneGeo, stoneMat, cornerTiles.length, 'road-corners');
      cornerTiles.forEach((idx, n) => {
        const tx = idx % s.width;
        const ty = Math.floor(idx / s.width);
        const { x: wx, z: wz } = tileWorld(tx, ty, s.width, s.height);
        dummy.position.set(wx, roadSurfaceY(s.tiles[idx]) + 0.014, wz);
        dummy.rotation.set(0, hash2d(tx, ty, seed + 9301) * Math.PI, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        corners!.setMatrixAt(n, dummy.matrix);
        const shade = 0.6 + hash2d(tx, ty, seed + 9302) * 0.12;
        color.setRGB(shade * 0.95, shade, shade * 1.03);
        corners!.setColorAt(n, color);
      });
      corners.instanceMatrix.needsUpdate = true;
      if (corners.instanceColor) corners.instanceColor.needsUpdate = true;
    }

    // 欄杆
    if (railList.length) {
      rails = makeMesh(railGeo, railMat, railList.length, 'road-railings', true);
      railList.forEach((p, n) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        rails!.setMatrixAt(n, dummy.matrix);
        const shade = 0.86 + hash2d(n, 7, seed + 9401) * 0.24;
        color.setRGB(shade, shade, shade);
        rails!.setColorAt(n, color);
      });
      rails.instanceMatrix.needsUpdate = true;
      if (rails.instanceColor) rails.instanceColor.needsUpdate = true;
    }
  };

  let signature = -1;
  let lastRevision = -1;
  const computeSignature = (s: GameState): number => {
    let count = 0;
    let sum = 0;
    for (let i = 0; i < s.tiles.length; i++) {
      if (s.tiles[i].road) {
        count++;
        sum += i;
      }
    }
    return count * 1000003 + sum;
  };

  rebuild(state);
  signature = computeSignature(state);

  return {
    group,
    update(s: GameState): void {
      // 只有 UI revision 變化（鋪路／拆路會 bump）時才重新計算簽章
      if (s.ui.revision === lastRevision) return;
      lastRevision = s.ui.revision;
      const sig = computeSignature(s);
      if (sig === signature) return;
      signature = sig;
      rebuild(s);
    },
    dispose(): void {
      clearMeshes();
      slabGeo.dispose();
      deckGeo.dispose();
      curbGeo.dispose();
      stoneGeo.dispose();
      railGeo.dispose();
      slabMat.dispose();
      deckMat.dispose();
      curbMat.dispose();
      stoneMat.dispose();
      railMat.dispose();
      stoneTex?.dispose();
      plankTex?.dispose();
      group.clear();
    },
  };
}
