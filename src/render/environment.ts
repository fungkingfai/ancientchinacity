/**
 * 環境渲染：天空、日月星辰、雲霧、晝夜與四季光照、雨雪粒子、飛鳥與螢火。
 *
 * - 天空：跟隨鏡頭的巨大天球 + 自訂 ShaderMaterial（漸層、日／月盤與光暈、
 *   程序化雲層、閃爍星空）；色彩隨季節／天氣／時刻平滑變化。
 * - 光照：HemisphereLight + 隨鏡頭對焦的 DirectionalLight（投影）+ AmbientLight，
 *   白天暖陽、夜晚冷月；陰雨雪時降低亮度與飽和度並加濃霧。
 * - 粒子：GPU 計算的雨絲（LineSegments）與雪花（Points），隨風向與強度增減。
 * - 氛圍：遠景雲朵 Sprite、晨昏／雨天地面薄霧、白天飛鳥、夏夜螢火。
 *
 * 介面（不可變）：createEnvironmentView(scene, state) → { update(state, dt, camera), dispose() }
 */

import * as THREE from 'three';
import type { GameState, Season, Weather } from '../core/types';
import { hash2d, mulberry32 } from '../core/rng';
import { createCloudTexture } from './world-geometry';
import {
  computeMoonDir,
  computeSun,
  createSkyPalette,
  createSunState,
  fogRange,
  sampleSkyPalette,
  weatherLightFactor,
  windStrength,
  type SkyPalette,
  type SunState,
} from './world-utils';

export interface EnvironmentView {
  update(state: GameState, dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

// ─────────────────────────── 天空 Shader ───────────────────────────

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform vec3 uSunColor;
  uniform vec3 uMoonColor;
  uniform vec3 uCloudColor;
  uniform float uDaylight;
  uniform float uNight;
  uniform float uCloudiness;
  uniform float uTime;
  uniform float uCloudDrift;
  uniform float uStarFade;
  varying vec3 vDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = p * 2.07 + vec2(3.1, 7.7);
      a *= 0.5;
    }
    return v;
  }
  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.27, 0.39));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float up = clamp(h, 0.0, 1.0);
    float t = pow(up, 0.62);
    vec3 col = mix(uHorizon, uZenith, t);
    // 地平線以下：淡出成較暗的地霧色
    col = mix(col, uHorizon * 0.8, smoothstep(0.0, -0.2, h));

    // 太陽盤與光暈
    vec3 sd = normalize(uSunDir);
    float sunDot = max(dot(d, sd), 0.0);
    float sunDisc = pow(sunDot, 1600.0) * 3.4;
    float sunHalo = pow(sunDot, 7.0) * 0.2;
    col += uSunColor * (sunDisc + sunHalo) * (0.35 + uDaylight);

    // 月亮
    vec3 md = normalize(uMoonDir);
    float moonDot = max(dot(d, md), 0.0);
    float moonDisc = pow(moonDot, 3200.0) * 2.4;
    float moonHalo = pow(moonDot, 42.0) * 0.08;
    col += uMoonColor * (moonDisc + moonHalo) * uNight * 1.4;

    // 星空：把方向切成小格，每格至多一顆圓點星，兩層密度 + 閃爍
    if (uStarFade > 0.01 && h > -0.02) {
      float starMask = smoothstep(-0.02, 0.2, h) * uStarFade;
      float twinkle = 0.7 + 0.3 * sin(uTime * 2.1 + h * 30.0);
      // 第一層（亮星）
      vec3 q1 = d * 190.0;
      vec3 c1 = floor(q1);
      vec3 f1 = fract(q1);
      float h1 = hash31(c1);
      if (h1 > 0.9935) {
        vec3 r1 = vec3(hash31(c1 + 1.7), hash31(c1 + 4.3), hash31(c1 + 9.1));
        float dist1 = length(f1 - r1);
        col += vec3(0.86, 0.92, 1.0) * smoothstep(0.34, 0.02, dist1) * twinkle * starMask * 1.5;
      }
      // 第二層（暗星）
      vec3 q2 = d * 330.0 + vec3(7.0, 3.0, 5.0);
      vec3 c2 = floor(q2);
      vec3 f2 = fract(q2);
      float h2 = hash31(c2);
      if (h2 > 0.9965) {
        vec3 r2 = vec3(hash31(c2 + 2.3), hash31(c2 + 6.1), hash31(c2 + 8.7));
        float dist2 = length(f2 - r2);
        col += vec3(0.78, 0.84, 0.96) * smoothstep(0.3, 0.02, dist2) * starMask * 0.8;
      }
    }

    // 程序化雲層（投影到高空平面，緩慢漂移）
    if (uCloudiness > 0.01 && h > 0.005) {
      vec2 cuv = d.xz / max(h, 0.12);
      cuv = cuv * 0.55 + vec2(uCloudDrift, uCloudDrift * 0.37);
      float cl = fbm2(cuv);
      float cover = smoothstep(0.62 - uCloudiness * 0.4, 0.98, cl);
      cover *= smoothstep(0.0, 0.12, h);
      // 地平線附近雲層拉長變淡
      cover *= 1.0 - smoothstep(0.35, 1.0, h) * 0.35;
      col = mix(col, uCloudColor, cover * (0.35 + uCloudiness * 0.65));
    }

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ─────────────────────────── 粒子 Shader ───────────────────────────

const PRECIP_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec2 uWind;
  uniform float uFall;
  uniform float uHeight;
  attribute float aRand;
  attribute float aTip;
  varying float vFade;
  void main() {
    float speed = uFall * (0.8 + aRand * 0.5);
    float y = mod(position.y - uTime * speed, uHeight);
    vec3 p = vec3(
      position.x + uWind.x * (uHeight - y) * 0.4,
      y,
      position.z + uWind.y * (uHeight - y) * 0.4
    );
    // 雨絲：線段兩端沿風向與落向延伸
    p += vec3(uWind.x * 0.35, -0.85, uWind.y * 0.35) * aTip;
    p.x += uCenter.x;
    p.z += uCenter.z;
    vFade = smoothstep(0.0, 2.5, y) * (1.0 - smoothstep(uHeight * 0.7, uHeight, y));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const PRECIP_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(uColor, uOpacity * vFade);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SNOW_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec2 uWind;
  uniform float uFall;
  uniform float uHeight;
  uniform float uSize;
  attribute float aRand;
  varying float vFade;
  void main() {
    float speed = uFall * (0.55 + aRand * 0.5);
    float y = mod(position.y - uTime * speed, uHeight);
    float sway = sin(uTime * 0.9 + aRand * 6.283) * 1.1 + sin(uTime * 2.1 + aRand * 12.0) * 0.4;
    vec3 p = vec3(
      position.x + sway + uWind.x * (uHeight - y) * 0.25,
      y,
      position.z + sway * 0.7 + uWind.y * (uHeight - y) * 0.25
    );
    p.x += uCenter.x;
    p.z += uCenter.z;
    vFade = smoothstep(0.0, 2.0, y) * (1.0 - smoothstep(uHeight * 0.75, uHeight, y));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * (940.0 / max(1.0, -mv.z)) * (0.7 + aRand * 0.7), 1.0, 8.0);
  }
`;

const SNOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.12, d);
    gl_FragColor = vec4(uColor, uOpacity * vFade * a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const FIREFLY_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uSize;
  attribute float aPhase;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    p.x += cos(uTime * 0.6 + aPhase * 6.283) * 0.6;
    p.y += sin(uTime * 1.1 + aPhase * 6.283) * 0.25;
    p.z += sin(uTime * 0.8 + aPhase * 6.283) * 0.6;
    vAlpha = (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 3.4 + aPhase * 30.0))) * uOpacity;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * (940.0 / max(1.0, -mv.z)), 1.0, 7.0);
  }
`;

const FIREFLY_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, vAlpha * a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ─────────────────────────── 主體 ───────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function createEnvironmentView(scene: THREE.Scene, _state: GameState): EnvironmentView {
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const sun: SunState = createSunState();
  const palette: SkyPalette = createSkyPalette();
  const moonDir = new THREE.Vector3();
  const lightDir = new THREE.Vector3();
  const cameraDir = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const shadowDir = new THREE.Vector3();
  const _c = new THREE.Color();
  const _c2 = new THREE.Color();

  // 背景色（天球未覆蓋處的備援）與霧
  scene.background = new THREE.Color(0x9ec8e8);
  const fog = new THREE.Fog(0xb8d4e8, 90, 300);
  scene.fog = fog;

  // ── 天球 ──
  const skyGeo = track(new THREE.SphereGeometry(460, 32, 20));
  const skyUniforms = {
    uZenith: { value: new THREE.Color(0x6fb0d8) },
    uHorizon: { value: new THREE.Color(0xd6e6dc) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uMoonDir: { value: new THREE.Vector3(-0.4, 0.6, -0.3) },
    uSunColor: { value: new THREE.Color(0xfff0cf) },
    uMoonColor: { value: new THREE.Color(0xd4e0ff) },
    uCloudColor: { value: new THREE.Color(0xf0f5fa) },
    uDaylight: { value: 1 },
    uNight: { value: 0 },
    uCloudiness: { value: 0.2 },
    uTime: { value: 0 },
    uCloudDrift: { value: 0 },
    uStarFade: { value: 0 },
  };
  const skyMat = track(
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'sky-dome';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  track(sky);
  scene.add(sky);

  // ── 光照 ──
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x5d6b4a, 0.75);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0x9fb0c0, 0.35);
  scene.add(ambient);

  const sunLight = new THREE.DirectionalLight(0xffe7b8, 2.2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const shadowSize = 95;
  sunLight.shadow.camera.left = -shadowSize;
  sunLight.shadow.camera.right = shadowSize;
  sunLight.shadow.camera.top = shadowSize;
  sunLight.shadow.camera.bottom = -shadowSize;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 420;
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.03;
  sunLight.shadow.camera.updateProjectionMatrix();
  scene.add(sunLight);
  scene.add(sunLight.target);

  // 城市燈火：夜間以單一暖色點光照亮建成區（模擬窗燈／燈籠的整體光暈），
  // 不新增任何 mesh，draw call 不變；亮度依建築數量與夜色漸變。
  const cityGlow = new THREE.PointLight(0xffa45c, 0, 72, 1.35);
  cityGlow.castShadow = false;
  cityGlow.position.set(0, 3.4, 0);
  scene.add(cityGlow);
  const cityGlowTarget = new THREE.Vector3(0, 3.4, 0);
  let cityGlowTimer = 0;
  let cityGlowHasCity = false;

  // ── 遠景雲朵（Sprite） ──
  const cloudTex = createCloudTexture(91);
  const cloudMat = track(
    new THREE.SpriteMaterial({
      map: cloudTex ?? undefined,
      color: 0xf4f8fc,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false,
    }),
  );
  const cloudSprites: THREE.Sprite[] = [];
  {
    const rng = mulberry32(0x51c0de);
    for (let i = 0; i < 10; i++) {
      const sprite = new THREE.Sprite(cloudMat);
      const a = (i / 10) * Math.PI * 2 + rng() * 0.35;
      const radius = 400 + rng() * 120;
      sprite.position.set(Math.cos(a) * radius, 120 + rng() * 120, Math.sin(a) * radius);
      const s = 100 + rng() * 110;
      sprite.scale.set(s, s * (0.3 + rng() * 0.14), 1);
      sprite.renderOrder = -900;
      scene.add(sprite);
      cloudSprites.push(sprite);
    }
  }

  // ── 地面薄霧（晨昏／雨天） ──
  const mistTex = createCloudTexture(37);
  const mistMat = track(
    new THREE.MeshBasicMaterial({
      map: mistTex ?? undefined,
      color: 0xdde8ee,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    }),
  );
  const mistGeo = track(new THREE.PlaneGeometry(1, 1));
  mistGeo.rotateX(-Math.PI / 2);
  const mists: THREE.Mesh[] = [];
  {
    const rng = mulberry32(0x9a5e11);
    for (let i = 0; i < 7; i++) {
      const mesh = new THREE.Mesh(mistGeo, mistMat);
      mesh.position.set((rng() - 0.5) * 130, 1.6 + rng() * 1.6, (rng() - 0.5) * 130);
      const s = 30 + rng() * 40;
      mesh.scale.set(s, 1, s * 0.8);
      mesh.rotation.y = rng() * Math.PI;
      mesh.renderOrder = -800;
      scene.add(mesh);
      mists.push(mesh);
    }
  }

  // ── 雨（LineSegments） ──
  const RAIN_COUNT = 1700;
  const rainGeo = track(new THREE.BufferGeometry());
  {
    const rng = mulberry32(0x2a1f);
    const pos = new Float32Array(RAIN_COUNT * 2 * 3);
    const rnd = new Float32Array(RAIN_COUNT * 2);
    const tip = new Float32Array(RAIN_COUNT * 2);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (rng() - 0.5) * 74;
      const y = rng() * 34;
      const z = (rng() - 0.5) * 74;
      const r = rng();
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        pos[o] = x;
        pos[o + 1] = y;
        pos[o + 2] = z;
        rnd[i * 2 + k] = r;
        tip[i * 2 + k] = k;
      }
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rainGeo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    rainGeo.setAttribute('aTip', new THREE.BufferAttribute(tip, 1));
  }
  const rainUniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2(0.3, 0.1) },
    uFall: { value: 26 },
    uHeight: { value: 34 },
    uColor: { value: new THREE.Color(0xcfe0ee) },
    uOpacity: { value: 0.55 },
  };
  const rainMat = track(
    new THREE.ShaderMaterial({
      uniforms: rainUniforms,
      vertexShader: PRECIP_VERT,
      fragmentShader: PRECIP_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.name = 'rain';
  rain.frustumCulled = false;
  rain.visible = false;
  track(rain);
  scene.add(rain);

  // ── 雪（Points） ──
  const SNOW_COUNT = 1400;
  const snowGeo = track(new THREE.BufferGeometry());
  {
    const rng = mulberry32(0x77aa);
    const pos = new Float32Array(SNOW_COUNT * 3);
    const rand = new Float32Array(SNOW_COUNT);
    for (let i = 0; i < SNOW_COUNT; i++) {
      pos[i * 3] = (rng() - 0.5) * 78;
      pos[i * 3 + 1] = rng() * 30;
      pos[i * 3 + 2] = (rng() - 0.5) * 78;
      rand[i] = rng();
    }
    snowGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    snowGeo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  }
  const snowUniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2(0.3, 0.1) },
    uFall: { value: 4.5 },
    uHeight: { value: 30 },
    uSize: { value: 0.085 },
    uColor: { value: new THREE.Color(0xffffff) },
    uOpacity: { value: 0.9 },
  };
  const snowMat = track(
    new THREE.ShaderMaterial({
      uniforms: snowUniforms,
      vertexShader: SNOW_VERT,
      fragmentShader: SNOW_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.name = 'snow';
  snow.frustumCulled = false;
  snow.visible = false;
  track(snow);
  scene.add(snow);

  // ── 螢火（夏夜） ──
  const FIREFLY_COUNT = 130;
  const fireflyGeo = track(new THREE.BufferGeometry());
  {
    const rng = mulberry32(0x3f19);
    const pos = new Float32Array(FIREFLY_COUNT * 3);
    const phase = new Float32Array(FIREFLY_COUNT);
    const mapW = 72;
    const mapH = 72;
    for (let i = 0; i < FIREFLY_COUNT; i++) {
      // 偏向水岸與林地附近
      const x = (rng() - 0.5) * mapW * 0.85;
      const z = (rng() - 0.5) * mapH * 0.85;
      pos[i * 3] = x;
      pos[i * 3 + 1] = 0.9 + rng() * 2.2;
      pos[i * 3 + 2] = z;
      phase[i] = rng();
    }
    fireflyGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fireflyGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  }
  const fireflyUniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uSize: { value: 0.15 },
    uColor: { value: new THREE.Color(0xffdd7a) },
  };
  const fireflyMat = track(
    new THREE.ShaderMaterial({
      uniforms: fireflyUniforms,
      vertexShader: FIREFLY_VERT,
      fragmentShader: FIREFLY_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  const fireflies = new THREE.Points(fireflyGeo, fireflyMat);
  fireflies.name = 'fireflies';
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  track(fireflies);
  scene.add(fireflies);

  // ── 飛鳥 ──
  const BIRD_COUNT = 14;
  const birdGeo = track(new THREE.BufferGeometry());
  {
    const verts = new Float32Array([
      -0.62, 0, 0.05, 0, 0.04, 0, 0, 0.04, -0.2,
      0.62, 0, 0.05, 0, 0.04, 0, 0, 0.04, -0.2,
    ]);
    birdGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    birdGeo.computeVertexNormals();
  }
  const birdMat = track(
    new THREE.MeshBasicMaterial({
      color: 0x33342f,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      fog: false,
    }),
  );
  const birds = new THREE.InstancedMesh(birdGeo, birdMat, BIRD_COUNT);
  birds.name = 'birds';
  birds.frustumCulled = false;
  birds.visible = false;
  track(birds);
  scene.add(birds);
  const birdPhases: number[] = [];
  {
    const rng = mulberry32(0x6b1d);
    for (let i = 0; i < BIRD_COUNT; i++) birdPhases.push(rng() * Math.PI * 2);
  }

  // ── 每幀暫存 ──
  let time = 0;
  let lastWeather: Weather | null = null;
  const dummy = new THREE.Object3D();

  const updateCloudColor = (season: Season, weather: Weather, daylight: number): void => {
    // 雲色：晴天皎白、陰雨灰暗、晨昏帶暖
    switch (weather) {
      case 'cloudy':
        cloudMat.color.setHex(0xdfe5ea);
        skyUniforms.uCloudColor.value.setHex(0xe4e9ee);
        break;
      case 'rain':
        cloudMat.color.setHex(0x8d99a4);
        skyUniforms.uCloudColor.value.setHex(0x8f9aa4);
        break;
      case 'snow':
        cloudMat.color.setHex(0xd4dde4);
        skyUniforms.uCloudColor.value.setHex(0xd8e0e6);
        break;
      default:
        cloudMat.color.setHex(0xf4f8fc);
        skyUniforms.uCloudColor.value.setHex(0xf0f5fa);
        break;
    }
    const golden = clamp01(1 - Math.abs(daylight - 0.16) / 0.22);
    if (golden > 0.01) {
      _c.setHex(0xf2b27a);
      cloudMat.color.lerp(_c, golden * 0.5);
      skyUniforms.uCloudColor.value.lerp(_c, golden * 0.35);
    }
    _c.setHex(0x1c2430);
    cloudMat.color.lerp(_c, (1 - daylight) * 0.55);
    skyUniforms.uCloudColor.value.lerp(_c, (1 - daylight) * 0.5);
    void season;
  };

  const weatherCloudiness: Record<Weather, number> = {
    clear: 0.14,
    cloudy: 0.62,
    rain: 0.86,
    snow: 0.72,
  };

  return {
    update(state: GameState, dt: number, camera: THREE.Camera): void {
      time += dt;
      if (state.ui.mode === 'interior') return; // 室內時城市場景不渲染，省下更新
      const { clock } = state;

      // ── 太陽／月亮／色彩 ──
      computeSun(clock.hour, clock.minute, clock.season, sun);
      computeMoonDir(clock.hour, clock.minute, clock.season, moonDir);
      sampleSkyPalette(clock.season, clock.weather, sun.daylight, palette);
      const weatherLight = weatherLightFactor(clock.weather);
      const daylight = sun.daylight;
      const night = 1 - clamp01(daylight * 1.25);
      if (clock.weather !== lastWeather) {
        lastWeather = clock.weather;
      }
      updateCloudColor(clock.season, clock.weather, daylight);

      // ── 天空 ──
      const su = skyUniforms;
      (su.uZenith.value as THREE.Color).copy(palette.zenith);
      (su.uHorizon.value as THREE.Color).copy(palette.horizon).lerp(palette.fog, 0.55);
      (su.uSunDir.value as THREE.Vector3).copy(sun.dir);
      (su.uMoonDir.value as THREE.Vector3).copy(moonDir);
      (su.uSunColor.value as THREE.Color).copy(palette.sun);
      (su.uMoonColor.value as THREE.Color).copy(palette.moon);
      su.uDaylight.value = daylight;
      su.uNight.value = night;
      su.uCloudiness.value = weatherCloudiness[clock.weather];
      su.uTime.value = time;
      su.uCloudDrift.value = time * 0.004 + windStrength(clock.weather, clock.weatherIntensity) * 0.01;
      su.uStarFade.value = clamp01((night - 0.25) / 0.75);
      sky.position.copy(camera.position);
      (scene.background as THREE.Color).copy(palette.horizon);

      // ── 霧 ──
      const fogDist = fogRange(clock.weather, daylight);
      fog.color.copy(palette.fog);
      fog.near = fogDist.near;
      fog.far = fogDist.far;

      // ── 光照 ──
      const isNight = sun.elevation < 0.015;
      const dir = isNight ? moonDir : sun.dir;
      lightDir.copy(dir);
      // 陰影方向抬高一些，避免太陽貼地時陰影過長
      shadowDir.set(lightDir.x, Math.max(0.16, lightDir.y), lightDir.z).normalize();

      // 對焦點：鏡頭視線與地面的交點（限制在地圖內）
      camera.getWorldDirection(cameraDir);
      let focusDist = 70;
      if (cameraDir.y < -0.05) focusDist = Math.min(220, Math.max(20, camera.position.y / -cameraDir.y));
      focus.copy(camera.position).addScaledVector(cameraDir, focusDist);
      const halfW = (state.width * 2) / 2 + 4;
      const halfH = (state.height * 2) / 2 + 4;
      focus.x = THREE.MathUtils.clamp(focus.x, -halfW, halfW);
      focus.z = THREE.MathUtils.clamp(focus.z, -halfH, halfH);
      focus.y = 0;
      sunLight.position.copy(focus).addScaledVector(shadowDir, 150);
      sunLight.target.position.copy(focus);
      sunLight.target.updateMatrixWorld();

      // 光色與強度
      if (isNight) {
        (sunLight.color as THREE.Color).copy(palette.moon);
        // 月光：夜間補強，晴天較亮、雨雪夜稍柔
        sunLight.intensity = (0.62 + (1 - weatherLight) * 0.1) * clamp01(1 - daylight * 2);
      } else {
        (sunLight.color as THREE.Color).copy(palette.sun);
        sunLight.intensity = (0.62 + daylight * 1.38) * weatherLight;
      }
      (hemi.color as THREE.Color).copy(palette.hemiSky);
      (hemi.groundColor as THREE.Color).copy(palette.hemiGround);
      // 晝間曲線維持原值；夜間額外補光（+0.17 半球光 / +0.26 環境光）讓城市可讀
      hemi.intensity = (0.3 + daylight * 0.56) * (0.72 + weatherLight * 0.28) + night * 0.17;
      (ambient.color as THREE.Color).copy(palette.ambient);
      ambient.intensity = 0.13 + daylight * 0.13 + night * 0.26;

      // ── 夜間暖色氛圍：燈火映照的牆面暖調反彈 + 城市燈火點光 ──
      if (night > 0.02) {
        (hemi.groundColor as THREE.Color).lerp(_c.setHex(0x76502a), night * 0.5);
        (ambient.color as THREE.Color).lerp(_c.setHex(0x9a7a52), night * 0.22);
        cityGlowTimer += dt;
        if (cityGlowTimer > 0.5) {
          cityGlowTimer = 0;
          let sx = 0;
          let sz = 0;
          let n = 0;
          for (const b of state.buildings) {
            sx += (b.x + b.w / 2) * 2;
            sz += (b.y + b.h / 2) * 2;
            n++;
          }
          if (n > 0) {
            cityGlowTarget.set(
              sx / n - (state.width * 2) / 2,
              3.4,
              sz / n - (state.height * 2) / 2,
            );
            cityGlowHasCity = true;
          } else {
            cityGlowHasCity = false;
          }
        }
        cityGlow.position.lerp(cityGlowTarget, 0.12);
        const glowTarget = cityGlowHasCity
          ? night * Math.min(1, 0.25 + state.buildings.length * 0.02) * 55
          : 0;
        cityGlow.intensity += (glowTarget - cityGlow.intensity) * 0.08;
      } else {
        cityGlow.intensity += (0 - cityGlow.intensity) * 0.15;
      }

      // ── 雲與霧 ──
      const cloudiness = weatherCloudiness[clock.weather];
      cloudMat.opacity = 0.18 + cloudiness * 0.5;
      for (let i = 0; i < cloudSprites.length; i++) {
        const sprite = cloudSprites[i];
        const a = time * 0.0035 + i * 0.7;
        const radius = 405 + ((i * 53) % 110);
        const baseAngle = (i / cloudSprites.length) * Math.PI * 2;
        sprite.position.x = Math.cos(baseAngle + a) * radius;
        sprite.position.z = Math.sin(baseAngle + a) * radius;
        sprite.position.y = 120 + Math.sin(time * 0.02 + i) * 5 + i * 9;
      }
      // 地面薄霧：晨昏、陰雨、清晨
      const hour = clock.hour + clock.minute / 60;
      const dawn = clamp01(1 - Math.abs(hour - 6.2) / 2.4);
      const dusk = clamp01(1 - Math.abs(hour - 18.0) / 2.2);
      const wet = clock.weather === 'rain' ? 0.7 : clock.weather === 'snow' ? 0.45 : clock.weather === 'cloudy' ? 0.3 : 0;
      const mistAmount = Math.max(dawn * 0.42, dusk * 0.3, wet) * (0.35 + night * 0.2);
      mistMat.opacity = clamp01(mistAmount) * 0.38;
      mistMat.color.copy(palette.fog).lerp(_c2.setHex(0xf2f6f8), 0.35);
      const mistVisible = mistMat.opacity > 0.01;
      for (const m of mists) m.visible = mistVisible;

      // ── 降水粒子 ──
      const kind = clock.weather === 'rain' ? 'rain' : clock.weather === 'snow' ? 'snow' : null;
      const intensity = clamp01(0.35 + clock.weatherIntensity * 0.65);
      rain.visible = kind === 'rain';
      snow.visible = kind === 'snow';
      const wind = windStrength(clock.weather, clock.weatherIntensity);
      const windAngle = 0.6;
      if (kind === 'rain') {
        rainUniforms.uTime.value = time;
        rainUniforms.uCenter.value.set(camera.position.x, 0, camera.position.z);
        (rainUniforms.uWind.value as THREE.Vector2).set(Math.cos(windAngle) * 0.5 * wind, Math.sin(windAngle) * 0.5 * wind);
        rainUniforms.uFall.value = 24 + intensity * 12;
        rainUniforms.uOpacity.value = 0.32 + intensity * 0.35;
        (rainUniforms.uColor.value as THREE.Color).setHex(0xbcd2e4).multiplyScalar(0.45 + daylight * 0.7);
        rainGeo.setDrawRange(0, Math.floor(RAIN_COUNT * 2 * (0.45 + intensity * 0.55)));
      } else if (kind === 'snow') {
        snowUniforms.uTime.value = time;
        snowUniforms.uCenter.value.set(camera.position.x, 0, camera.position.z);
        (snowUniforms.uWind.value as THREE.Vector2).set(Math.cos(windAngle) * 0.35 * wind, Math.sin(windAngle) * 0.35 * wind);
        snowUniforms.uFall.value = 4 + intensity * 2.5;
        snowUniforms.uOpacity.value = 0.55 + intensity * 0.35;
        (snowUniforms.uColor.value as THREE.Color).setHex(0xffffff).multiplyScalar(0.55 + daylight * 0.6);
        snowGeo.setDrawRange(0, Math.floor(SNOW_COUNT * (0.4 + intensity * 0.6)));
      }

      // ── 螢火（春夏季夜晚、晴天） ──
      const fireflySeason = clock.season === 'spring' || clock.season === 'summer';
      const fireflyOn = fireflySeason && night > 0.5 && clock.weather !== 'rain' && clock.weather !== 'snow';
      fireflies.visible = fireflyOn;
      if (fireflyOn) {
        fireflyUniforms.uTime.value = time;
        fireflyUniforms.uOpacity.value = clamp01((night - 0.4) * 2) * (clock.weather === 'clear' ? 1 : 0.6);
      }

      // ── 飛鳥（白天、非雨雪） ──
      const birdsOn = daylight > 0.45 && clock.weather !== 'rain' && clock.weather !== 'snow';
      birds.visible = birdsOn;
      if (birdsOn) {
        const mapHalf = 70;
        for (let i = 0; i < BIRD_COUNT; i++) {
          const ph = birdPhases[i];
          const radius = 28 + ((i * 37) % 50);
          const speed = 0.12 + (i % 5) * 0.012;
          const a = time * speed + ph;
          const px = Math.cos(a) * radius;
          const pz = Math.sin(a) * radius * 0.8;
          const py = 20 + ((i * 13) % 16) + Math.sin(time * 0.7 + ph) * 1.5;
          dummy.position.set(px, py, pz);
          dummy.rotation.set(0, -a + Math.PI / 2, Math.sin(time * 0.6 + ph) * 0.15);
          const flap = 0.55 + Math.abs(Math.sin(time * 7 + ph * 3)) * 0.75;
          dummy.scale.set(0.8 + (i % 3) * 0.12, flap, 0.8);
          dummy.updateMatrix();
          birds.setMatrixAt(i, dummy.matrix);
        }
        birds.instanceMatrix.needsUpdate = true;
        // 鳥群整體位置：稍微跟隨城市中心
        birds.position.set(0, 0, 0);
        void mapHalf;
      }
    },
    dispose(): void {
      scene.remove(sky, hemi, ambient, sunLight, sunLight.target, cityGlow, rain, snow, fireflies, birds);
      for (const sprite of cloudSprites) scene.remove(sprite);
      for (const m of mists) scene.remove(m);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      if (scene.fog === fog) scene.fog = null;
    },
  };
}
