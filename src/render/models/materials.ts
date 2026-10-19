/**
 * 華夏古城 — 建築共用材質庫與程序化文字貼圖（匾額／旗幡／對聯）。
 *
 * 效能策略（architecture-dev）：
 *  - 材質以「顏色 + 參數」為 key 快取；所有建築實例共用同一批材質。
 *  - 匾額、旗幡的中文字用 CanvasTexture 程序化繪製，只建立一次後共用。
 *  - 幾何體由 building-prototypes 的 prototype 快取共用；本檔只負責外觀。
 *  - `dispose()` 一次釋放全部材質與貼圖（由 BuildingsView.dispose 呼叫）。
 *
 * 本檔可在無 DOM 環境（單元測試）安全載入：缺 document 時退回純色材質。
 */

import * as THREE from 'three';

export const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

/** 中式低多邊形調色盤（材質顏色一律由此取用，保持整體和諧）。 */
export const PAL = {
  // 牆體
  wallWhite: 0xe9e1d0,
  wallCream: 0xe2d7bf,
  wallGrey: 0xd3ccbd,
  wallMud: 0xb1986c,
  wallRed: 0xa8483b,
  wallRedDark: 0x8a352c,
  plasterWarm: 0xded0b4,
  // 木構
  wood: 0x7c5a37,
  woodLight: 0xa37d4f,
  woodDark: 0x4e3521,
  woodBlack: 0x2c2117,
  pillarRed: 0xa63e31,
  pillarRedDark: 0x7d2b24,
  // 屋瓦
  tile: 0x56616f,
  tileDark: 0x3f4651,
  tileLight: 0x707a88,
  tileGreen: 0x51645b,
  // 茅草
  thatch: 0xb59a5c,
  thatchDark: 0x8b7443,
  thatchLight: 0xc9b077,
  // 石
  stone: 0x9a9a90,
  stoneDark: 0x6f7068,
  stoneLight: 0xb8b7ac,
  // 金屬／金飾
  gold: 0xc9a24c,
  goldDark: 0x9a7833,
  iron: 0x596270,
  ironDark: 0x3b414a,
  bronze: 0x8a6f43,
  // 燈籠
  lantern: 0xc9492f,
  lanternGlow: 0xffb36b,
  lanternDark: 0x8f2f22,
  // 布料
  clothRed: 0xb4453a,
  clothBlue: 0x466880,
  clothTeal: 0x4e7f74,
  clothYellow: 0xc9a24c,
  clothWhite: 0xe8dfcc,
  clothPink: 0xc08a9a,
  clothGreen: 0x6f8f5f,
  // 自然
  crop: 0x9cb356,
  cropGold: 0xd6b856,
  leaf: 0x5f7f4a,
  leafDark: 0x48643a,
  bamboo: 0x7d9a52,
  water: 0x4d7f9b,
  earth: 0x8b6f45,
  soil: 0x6d5136,
  // 其他
  paper: 0xefe5cf,
  dark: 0x241c15,
  smoke: 0xd8d2c4,
  fire: 0xff7a32,
  ember: 0xffb347,
  ore: 0x7a6a58,
  coal: 0x2f2c29,
} as const;

export interface LambertParams {
  emissive?: number;
  emissiveIntensity?: number;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  map?: THREE.Texture | null;
  depthWrite?: boolean;
}

export interface BasicParams {
  map?: THREE.Texture | null;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  toneMapped?: boolean;
  blending?: THREE.Blending;
  vertexColors?: boolean;
}

interface TextOptions {
  w?: number;
  h?: number;
  bg?: string;
  fg?: string;
  border?: string;
  vertical?: boolean;
  fontScale?: number;
  borderWidth?: number;
  /** 底部加流蘇／裝飾帶 */
  tassel?: boolean;
  /** 雙面（旗幡） */
  doubleSide?: boolean;
}

const CN_FONT = '"Noto Serif TC", "Songti TC", "Source Han Serif TC", "STSong", "SimSun", serif';

function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** 置中繪製中文字（手動字距，避免依賴 letterSpacing 支援度）。 */
function drawCenteredChars(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  fontSize: number,
  color: string,
  spacing: number,
  font = CN_FONT,
): void {
  ctx.font = `700 ${fontSize}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, cy);
    x += widths[i] + spacing;
  }
}

/** 豎排文字（從上而下）。 */
function drawVerticalChars(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  fontSize: number,
  color: string,
  spacing: number,
  font = CN_FONT,
): void {
  ctx.font = `700 ${fontSize}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  const total = chars.length * fontSize + spacing * (chars.length - 1);
  let y = cy - total / 2 + fontSize / 2;
  for (const ch of chars) {
    ctx.fillText(ch, cx, y);
    y += fontSize + spacing;
  }
}

export class MaterialLibrary {
  private materials = new Map<string, THREE.Material>();
  private textures: THREE.Texture[] = [];

  /** 受光材質（牆、木、瓦、石…）。 */
  lambert(color: number, params: LambertParams = {}): THREE.MeshLambertMaterial {
    const key = `L|${color}|${params.emissive ?? ''}|${params.emissiveIntensity ?? ''}|${params.side ?? ''}|${
      params.transparent ? 1 : 0
    }|${params.opacity ?? ''}|${params.map ? params.map.uuid : ''}|${params.depthWrite === false ? 0 : 1}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshLambertMaterial;
    const mat = new THREE.MeshLambertMaterial({
      color,
      emissive: params.emissive ?? 0x000000,
      emissiveIntensity: params.emissiveIntensity ?? 1,
      side: params.side ?? THREE.FrontSide,
      transparent: params.transparent ?? false,
      opacity: params.opacity ?? 1,
      depthWrite: params.depthWrite ?? true,
    });
    if (params.map) mat.map = params.map;
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /** 自發光／貼圖材質（燈籠內芯、匾額、旗幡）。 */
  basic(color: number, params: BasicParams = {}): THREE.MeshBasicMaterial {
    const key = `B|${color}|${params.side ?? ''}|${params.transparent ? 1 : 0}|${params.opacity ?? ''}|${
      params.depthWrite === false ? 0 : 1
    }|${params.toneMapped === false ? 0 : 1}|${params.blending ?? ''}|${params.map ? params.map.uuid : ''}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;
    const mat = new THREE.MeshBasicMaterial({
      color,
      side: params.side ?? THREE.FrontSide,
      transparent: params.transparent ?? false,
      opacity: params.opacity ?? 1,
      depthWrite: params.depthWrite ?? true,
      toneMapped: params.toneMapped ?? true,
      blending: params.blending ?? THREE.NormalBlending,
    });
    if (params.map) mat.map = params.map;
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /** 建築物的燈籠紅（自帶微弱自發光，夜間仍可見）。 */
  lantern(): THREE.MeshLambertMaterial {
    return this.lambert(PAL.lantern, { emissive: PAL.lanternGlow, emissiveIntensity: 0.55 });
  }

  /** 匾額：木底金字（橫排）。 */
  plaque(text: string, bg = '#231c15', fg = '#e9c874', border = '#a07c38'): THREE.Material {
    return this.textMaterial(text, {
      w: 320,
      h: 112,
      bg,
      fg,
      border,
      vertical: false,
      fontScale: 0.56,
      borderWidth: 7,
    });
  }

  /** 直幡／酒旗：布底大字（豎排）。 */
  banner(text: string, bg: number = PAL.clothRed, fg = '#f5ead2', border = '#e3c377'): THREE.Material {
    return this.textMaterial(text, {
      w: 128,
      h: 320,
      bg: cssColor(bg),
      fg,
      border,
      vertical: true,
      fontScale: 0.56,
      borderWidth: 5,
      tassel: true,
      doubleSide: true,
    });
  }

  /** 室內卷軸（書法、對聯）。 */
  scroll(text: string, bg = '#e7dcc4', fg = '#2c2419'): THREE.Material {
    return this.textMaterial(text, {
      w: 128,
      h: 340,
      bg,
      fg,
      border: '#8a6a3a',
      vertical: true,
      fontScale: 0.5,
      borderWidth: 4,
    });
  }

  /** 自由文字貼圖材質（快取）。 */
  textMaterial(text: string, opts: TextOptions = {}): THREE.Material {
    const w = opts.w ?? 256;
    const h = opts.h ?? 128;
    const bg = opts.bg ?? '#231c15';
    const fg = opts.fg ?? '#e9c874';
    const border = opts.border ?? '#a07c38';
    const vertical = opts.vertical ?? false;
    const fontScale = opts.fontScale ?? 0.58;
    const borderWidth = opts.borderWidth ?? 6;
    const tassel = opts.tassel ?? false;
    const doubleSide = opts.doubleSide ?? false;
    const key = `T|${text}|${w}x${h}|${bg}|${fg}|${border}|${vertical ? 1 : 0}|${fontScale}|${borderWidth}|${tassel ? 1 : 0}|${doubleSide ? 1 : 0}`;
    const found = this.materials.get(key);
    if (found) return found;

    if (!HAS_DOM) {
      // 無 DOM（測試環境）：退回純色板。
      const fallback = this.basic(0x231c15);
      this.materials.set(key, fallback);
      return fallback;
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallback = this.basic(0x231c15);
      this.materials.set(key, fallback);
      return fallback;
    }

    // 底色：略帶漸層，像舊木／舊布
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, shadeHex(bg, -0.12));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 內外雙框
    ctx.strokeStyle = border;
    ctx.lineWidth = borderWidth;
    ctx.strokeRect(borderWidth / 2, borderWidth / 2, w - borderWidth, h - borderWidth);
    ctx.strokeStyle = fg;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1, borderWidth * 0.35);
    ctx.strokeRect(borderWidth * 1.8, borderWidth * 1.8, w - borderWidth * 3.6, h - borderWidth * 3.6);
    ctx.globalAlpha = 1;

    const fontSize = Math.min(vertical ? w : h, vertical ? h : w) * fontScale;
    if (vertical) {
      drawVerticalChars(ctx, text, w / 2, h / 2, fontSize, fg, Math.max(2, fontSize * 0.08));
    } else {
      drawCenteredChars(ctx, text, w / 2, h / 2 + fontSize * 0.04, fontSize, fg, Math.max(2, fontSize * 0.1));
    }

    // 底部裝飾帶（旗幡流蘇感）
    if (tassel) {
      ctx.fillStyle = border;
      ctx.fillRect(0, h - h * 0.045, w, h * 0.045);
      ctx.fillStyle = fg;
      ctx.globalAlpha = 0.65;
      for (let x = w * 0.08; x < w * 0.95; x += w * 0.11) {
        ctx.fillRect(x, h - h * 0.045, w * 0.035, h * 0.045);
      }
      ctx.globalAlpha = 1;
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.textures.push(tex);

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      toneMapped: false,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /** 建立並登記一張 CanvasTexture（供室內地板、牆面、窗景使用）。 */
  canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture | null {
    if (!HAS_DOM) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    draw(ctx);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.textures.push(tex);
    return tex;
  }

  private ownedTexture(tex: THREE.Texture): THREE.Texture {
    this.textures.push(tex);
    return tex;
  }

  registerTexture(tex: THREE.Texture): THREE.Texture {
    return this.ownedTexture(tex);
  }

  /** 接管一個自建材質（例如貼圖地板），由本庫統一 dispose。 */
  own<T extends THREE.Material>(mat: T): T {
    this.materials.set(`own|${mat.uuid}`, mat);
    return mat;
  }


  // ── 合併用（vertex color）共用材質 ─────────────────────────
  // 建築原型把所有靜態同類材質合併成 1~3 個 mesh 後，用這些材質上色，
  // 色彩由頂點色烘入，故整棟建築只需數個 draw call。

  /** 受光頂點色材質（牆、木、石、瓦…）。 */
  vertexLit(side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
    return this.vertexMaterial('lit', side, 0x000000, 0);
  }

  /** 帶微暖自發光的頂點色材質（窗紙、貼金裝飾）。 */
  vertexWarm(side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
    return this.vertexMaterial('warm', side, 0x5a4320, 0.5);
  }

  /** 不受光頂點色材質（火焰、燈芯）。 */
  vertexBasic(side: THREE.Side = THREE.FrontSide): THREE.MeshBasicMaterial {
    const key = `V|basic|${side}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshBasicMaterial;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side, toneMapped: false });
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /** 動畫部件用頂點色材質（燈籠：帶暖光；其他：普通受光）。 */
  vertexAnim(side: THREE.Side, glow: boolean): THREE.MeshLambertMaterial {
    return glow ? this.vertexMaterial('animGlow', side, 0x7a3318, 0.5) : this.vertexMaterial('lit', side, 0x000000, 0);
  }

  private vertexMaterial(kind: string, side: THREE.Side, emissive: number, emissiveIntensity: number): THREE.MeshLambertMaterial {
    const key = `V|${kind}|${side}`;
    const found = this.materials.get(key);
    if (found) return found as THREE.MeshLambertMaterial;
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side,
      emissive,
      emissiveIntensity,
    });
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /**
   * 夜間模式：把共用「窗紙暖光」與「燈籠自發光」材質切到夜間參數，
   * 白天則還原成原本的微弱自發光。只在日/夜切換時呼叫（每幀零成本），
   * 因為材質是所有建築共用的，不需要為每棟建築額外 draw call。
   */
  setNightMode(night: boolean): void {
    for (const [key, mat] of this.materials) {
      if (key.startsWith('V|warm|')) {
        // 窗紙、貼金飾件：夜間轉為暖黃透光
        const m = mat as THREE.MeshLambertMaterial;
        m.emissive.setHex(night ? 0xffb75e : 0x5a4320);
        m.emissiveIntensity = night ? 1.15 : 0.5;
      } else if (key.startsWith('V|animGlow|')) {
        // 燈籠本體：夜間更亮更紅
        const m = mat as THREE.MeshLambertMaterial;
        m.emissive.setHex(night ? 0xff5a1e : 0x7a3318);
        m.emissiveIntensity = night ? 1.4 : 0.5;
      }
    }
  }

  dispose(): void {
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
    for (const tex of this.textures) tex.dispose();
    this.textures.length = 0;
  }
}

/** 簡單 hex 亮度調整（用於貼圖漸層）。 */
function shadeHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * (1 + amount));
  const g = clamp(((n >> 8) & 255) * (1 + amount));
  const b = clamp((n & 255) * (1 + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
