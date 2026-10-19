/**
 * 城市視圖：three.js 場景、鏡頭控制、滑鼠／鍵盤互動、室內模式切換。
 *
 * 本檔由 Lead 維護（整合層）。各渲染模組只負責自己的 group：
 *   terrain / roads / buildings / citizens / environment / interior
 */

import * as THREE from 'three';
import { BUILDINGS } from '../core/config';
import type { GameActions, GameState } from '../core/types';
import type { GameStore as Store } from '../core/store';
import { buildingAnchor, TILE, tileWorld, worldToTileIndex } from './coords';
import { createTerrainView, type TerrainView } from './terrain';
import { createRoadsView, type RoadsView } from './roads';
import { createBuildingsView, type BuildingsView } from './buildings';
import { createCitizensView, type CitizensView } from './citizens';
import { createEnvironmentView, type EnvironmentView } from './environment';
import { createInteriorView, type InteriorView } from './interior';
import { canPlaceBuilding } from '../sim/placement';

export interface CityViewOptions {
  container: HTMLElement;
  store: Store;
  actions: GameActions;
}

const MIN_DISTANCE = 14;
const MAX_DISTANCE = 170;
const MIN_PITCH = 0.32;
const MAX_PITCH = 1.35;

export class CityView {
  private store: Store;
  private actions: GameActions;
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private canvas: HTMLCanvasElement;
  private cityScene!: THREE.Scene;
  private cityCamera: THREE.PerspectiveCamera;
  private interior: InteriorView | null = null;

  private terrain!: TerrainView;
  private roads!: RoadsView;
  private buildings!: BuildingsView;
  private citizens!: CitizensView;
  private environment!: EnvironmentView;

  private target = new THREE.Vector3(0, 0, 0);
  private yaw = -Math.PI / 4;
  private pitch = 0.85;
  private distance = 72;

  private hover = -1;
  private hoverMesh!: THREE.Mesh;
  private selectionRing!: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.3);

  private pointer = new THREE.Vector2();
  private dragging = false;
  private dragButton = -1;
  private dragStart = new THREE.Vector2();
  private dragLast = new THREE.Vector2();
  private dragDistance = 0;
  private lastPaintTile = -1;

  private keys = new Set<string>();
  private resizeObserver: ResizeObserver;
  private lastTime = performance.now();
  private disposed = false;

  constructor(opts: CityViewOptions) {
    this.store = opts.store;
    this.actions = opts.actions;
    this.container = opts.container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.id = 'game-canvas';
    this.container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.cityCamera = new THREE.PerspectiveCamera(46, 1, 0.1, 600);
    this.rebuild(this.store.state);
    this.resize();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    this.bindEvents();
    this.applyCamera();
  }

  // ───────────────────────── 場景重建 ─────────────────────────

  rebuild(state: GameState): void {
    if (this.terrain) this.terrain.dispose();
    if (this.roads) this.roads.dispose();
    if (this.buildings) this.buildings.dispose();
    if (this.citizens) this.citizens.dispose();
    if (this.environment) this.environment.dispose();
    if (this.interior) {
      this.interior.dispose();
      this.interior = null;
    }

    this.cityScene = new THREE.Scene();
    this.environment = createEnvironmentView(this.cityScene, state);
    this.terrain = createTerrainView(state);
    this.roads = createRoadsView(state);
    this.buildings = createBuildingsView(state);
    this.citizens = createCitizensView(state);
    this.cityScene.add(this.terrain.group, this.roads.group, this.buildings.group, this.citizens.group);

    // 懸停格高亮
    const hoverGeo = new THREE.PlaneGeometry(TILE * 0.96, TILE * 0.96);
    const hoverMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, opacity: 0.22, depthWrite: false });
    this.hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
    this.hoverMesh.rotation.x = -Math.PI / 2;
    this.hoverMesh.position.y = 0.42;
    this.hoverMesh.visible = false;
    this.cityScene.add(this.hoverMesh);

    // 選取建築光環
    const ringGeo = new THREE.RingGeometry(0.82, 1, 40);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xf3c969, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.visible = false;
    this.cityScene.add(this.selectionRing);

    this.target.set(0, 0, 0);
    this.hover = -1;
  }

  // ───────────────────────── 主迴圈 ─────────────────────────

  frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const state = this.store.state;

    this.updateKeyboardPan(dt);
    this.applyCamera();

    this.environment.update(state, dt, this.activeCamera());
    this.terrain.update(state, dt);
    this.roads.update(state, dt);
    this.buildings.update(state, dt);
    this.citizens.update(state, dt);
    this.updateGhostAndHighlights(state);

    if (state.ui.mode === 'interior' && this.interior) {
      this.interior.update(state, dt);
      this.renderer.render(this.interior.scene, this.interior.camera);
    } else {
      this.renderer.render(this.cityScene, this.cityCamera);
    }
  }

  private activeCamera(): THREE.Camera {
    return this.interior && this.store.state.ui.mode === 'interior' ? this.interior.camera : this.cityCamera;
  }

  private applyCamera(): void {
    const cp = Math.cos(this.pitch);
    this.cityCamera.position.set(
      this.target.x + this.distance * cp * Math.sin(this.yaw),
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + this.distance * cp * Math.cos(this.yaw),
    );
    this.cityCamera.lookAt(this.target);
  }

  private updateGhostAndHighlights(state: GameState): void {
    const tool = state.ui.tool;
    const inCity = state.ui.mode === 'city';
    this.hoverMesh.visible = inCity && this.hover >= 0;
    if (this.hover >= 0 && inCity) {
      const { x, z } = tileWorld(this.hover % state.width, Math.floor(this.hover / state.width), state.width, state.height);
      this.hoverMesh.position.set(x, 0.42, z);
    }

    // 選取光環
    const selected = state.ui.selectedId != null ? state.buildings.find((b) => b.id === state.ui.selectedId) : null;
    this.selectionRing.visible = inCity && !!selected;
    if (selected) {
      const cx = (selected.x + selected.w / 2) * TILE - (state.width * TILE) / 2;
      const cz = (selected.y + selected.h / 2) * TILE - (state.height * TILE) / 2;
      this.selectionRing.position.set(cx, 0.44, cz);
      const scale = Math.max(selected.w, selected.h) * TILE * 0.72;
      this.selectionRing.scale.setScalar(scale);
    }

    // 建造幽靈
    const valid = tool ? this.isToolValidAt(state, this.hover) : false;
    this.buildings.setPreview(state, inCity ? tool : null, this.hover, valid);
  }

  private isToolValidAt(state: GameState, tileIndex: number): boolean {
    if (tileIndex < 0) return false;
    const tool = state.ui.tool;
    if (!tool) return false;
    const tile = state.tiles[tileIndex];
    if (tool === 'demolish') return tile.buildingId >= 0 || tile.road;
    if (tool === 'road') {
      return !tile.road && tile.buildingId < 0 && tile.terrain !== 'water' && tile.terrain !== 'mountain' && state.finance.treasury >= 4;
    }
    const def = BUILDINGS[tool];
    if (!def) return false;
    const anchor = buildingAnchor(state, tool, def.size[0], def.size[1], tileIndex % state.width, Math.floor(tileIndex / state.width));
    return canPlaceBuilding(state, tool, anchor.x, anchor.y).ok;
  }

  // ───────────────────────── 事件綁定 ─────────────────────────

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.unsubs = [
      this.store.on('reset', () => {
        this.rebuild(this.store.state);
        this.lastTime = performance.now();
      }),
      this.store.on('enter', (payload) => {
        const id = typeof payload === 'number' ? payload : this.store.state.ui.interiorId;
        if (id != null) this.openInterior(id);
      }),
      this.store.on('exit', () => this.closeInterior()),
    ];
  }

  private unsubs: (() => void)[] = [];

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.dragButton = e.button;
    this.dragStart.set(e.clientX, e.clientY);
    this.dragLast.copy(this.dragStart);
    this.dragDistance = 0;
    this.lastPaintTile = -1;
    if (e.button === 0 && !e.shiftKey && this.store.state.ui.tool === 'road') {
      this.paintRoadAt(e.clientX, e.clientY);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.updatePointer(e.clientX, e.clientY);
    this.updateHover();
    if (!this.dragging) return;
    const dx = e.clientX - this.dragLast.x;
    const dy = e.clientY - this.dragLast.y;
    this.dragLast.set(e.clientX, e.clientY);
    this.dragDistance += Math.abs(dx) + Math.abs(dy);

    if (this.dragButton === 2) {
      // 右鍵拖曳：旋轉視角
      this.yaw -= dx * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.005, MIN_PITCH, MAX_PITCH);
      return;
    }
    if (this.dragButton === 1 || (this.dragButton === 0 && e.shiftKey)) {
      // 中鍵 / Shift+左鍵：平移
      this.pan(dx, dy);
      return;
    }
    if (this.dragButton === 0 && this.store.state.ui.tool === 'road' && this.dragDistance > 4) {
      this.paintRoadAt(e.clientX, e.clientY);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const wasDragging = this.dragging;
    this.dragging = false;
    this.dragButton = -1;
    if (!wasDragging) return;
    if (this.dragDistance < 7) {
      if (e.button === 0) this.clickAt(e.clientX, e.clientY);
      else if (e.button === 2) {
        // 右鍵點擊：取消工具
        if (this.store.state.ui.tool) this.actions.setTool(null);
      }
    }
    this.dragDistance = 0;
  };

  private onPointerLeave = (): void => {
    this.hover = -1;
    this.hoverMesh.visible = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.distance = THREE.MathUtils.clamp(this.distance * (e.deltaY > 0 ? 1.1 : 0.9), MIN_DISTANCE, MAX_DISTANCE);
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const tile = this.pickTile(e.clientX, e.clientY);
    if (tile < 0) return;
    const state = this.store.state;
    const buildingId = state.tiles[tile].buildingId;
    if (buildingId >= 0) this.actions.enterBuilding(buildingId);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    this.keys.add(e.code);
    if (e.code === 'Space') {
      e.preventDefault();
      this.actions.togglePause();
    } else if (e.code === 'Digit1') this.actions.setSpeed(1);
    else if (e.code === 'Digit2') this.actions.setSpeed(2);
    else if (e.code === 'Digit3') this.actions.setSpeed(3);
    else if (e.code === 'Digit0') this.actions.setSpeed(0);
    else if (e.code === 'Escape') {
      if (this.store.state.ui.mode === 'interior') this.actions.exitInterior();
      else {
        this.actions.closeOverlays();
        this.actions.setTool(null);
      }
    } else if (e.code === 'KeyQ') this.yaw += 0.12;
    else if (e.code === 'KeyE') this.yaw -= 0.12;
    else if (e.code === 'KeyF') this.actions.toggleFinance();
    else if (e.code === 'KeyH') this.actions.toggleHelp();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private updateKeyboardPan(dt: number): void {
    if (this.store.state.ui.mode === 'interior') return;
    let mx = 0;
    let mz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (!mx && !mz) return;
    const speed = this.distance * 0.55 * dt;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(right, mx * speed);
    this.target.addScaledVector(forward, -mz * speed);
    this.clampTarget();
  }

  private pan(dx: number, dy: number): void {
    const scale = this.distance * 0.0018;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(forward, dy * scale);
    this.clampTarget();
  }

  private clampTarget(): void {
    const state = this.store.state;
    const halfW = (state.width * TILE) / 2 + 10;
    const halfH = (state.height * TILE) / 2 + 10;
    this.target.x = THREE.MathUtils.clamp(this.target.x, -halfW, halfW);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -halfH, halfH);
  }

  private updatePointer(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  private pickTile(clientX: number, clientY: number): number {
    this.updatePointer(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.cityCamera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, point)) return -1;
    return worldToTileIndex(this.store.state, point.x, point.z);
  }

  private updateHover(): void {
    this.raycaster.setFromCamera(this.pointer, this.cityCamera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, point)) {
      this.hover = -1;
      return;
    }
    this.hover = worldToTileIndex(this.store.state, point.x, point.z);
  }

  private clickAt(clientX: number, clientY: number): void {
    const state = this.store.state;
    const tile = this.pickTile(clientX, clientY);
    if (tile < 0) return;
    if (state.ui.tool) {
      this.actions.applyToolAt(tile);
    } else {
      this.actions.select(tile);
    }
  }

  private paintRoadAt(clientX: number, clientY: number): void {
    const tile = this.pickTile(clientX, clientY);
    if (tile < 0 || tile === this.lastPaintTile) return;
    this.lastPaintTile = tile;
    this.actions.applyToolAt(tile);
  }

  // ───────────────────────── 室內模式 ─────────────────────────

  private openInterior(buildingId: number): void {
    if (this.interior) {
      this.interior.dispose();
      this.interior = null;
    }
    this.interior = createInteriorView(this.store.state, buildingId);
    if (this.interior) {
      this.resizeInteriorCamera();
      this.lastTime = performance.now();
    }
  }

  private closeInterior(): void {
    if (this.interior) {
      this.interior.dispose();
      this.interior = null;
    }
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cityCamera.aspect = w / h;
    this.cityCamera.updateProjectionMatrix();
    this.resizeInteriorCamera();
  }

  private resizeInteriorCamera(): void {
    if (!this.interior) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.interior.camera.aspect = w / h;
    this.interior.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    for (const unsub of this.unsubs) unsub();
    this.terrain?.dispose();
    this.roads?.dispose();
    this.buildings?.dispose();
    this.citizens?.dispose();
    this.environment?.dispose();
    this.interior?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
