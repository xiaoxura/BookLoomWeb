import type {
  CoverData,
  CoverOptions,
  CoverPalette,
} from '../types';

const WIDTH = 1200;
const HEIGHT = 1800;

export const DEFAULT_COVER_OPTIONS: CoverOptions = {
  palette: 'auto',
  titleScale: 1,
  authorPosition: 'bottom',
};

export const COVER_PALETTE_LABELS: Record<CoverPalette, string> = {
  auto: '跟随模板',
  sand: '原木',
  ink: '墨夜',
  sea: '深海',
  wine: '酒红',
  forest: '松林',
};

interface PaletteColors {
  /** 竖排模板的渐变背景 */
  from: string;
  to: string;
  /** 标题 / 正文文字 */
  ink: string;
  /** 作者和次要文字 */
  muted: string;
  /** 边框和分隔线 */
  line: string;
  /** 色块模板的底色 */
  block: string;
  /** 色块模板的正文 / 作者颜色 */
  onBlock: string;
  onBlockMuted: string;
  onBlockLine: string;
}

const PALETTES: Record<Exclude<CoverPalette, 'auto'>, PaletteColors> = {
  sand: {
    from: '#f8f2e4',
    to: '#e0d0b2',
    ink: '#2f2a22',
    muted: '#6b5d45',
    line: 'rgba(104, 82, 52, 0.35)',
    block: '#8a6a3a',
    onBlock: '#fffaf0',
    onBlockMuted: 'rgba(255, 250, 240, 0.82)',
    onBlockLine: 'rgba(255, 250, 240, 0.45)',
  },
  ink: {
    from: '#24221e',
    to: '#12110f',
    ink: '#f5efe2',
    muted: '#b8ab95',
    line: 'rgba(245, 239, 226, 0.32)',
    block: '#1f1e1b',
    onBlock: '#f5efe2',
    onBlockMuted: 'rgba(245, 239, 226, 0.74)',
    onBlockLine: 'rgba(245, 239, 226, 0.38)',
  },
  sea: {
    from: '#0f3446',
    to: '#071a26',
    ink: '#eef6f7',
    muted: '#9fc3cf',
    line: 'rgba(238, 246, 247, 0.3)',
    block: '#0f4c5c',
    onBlock: '#eef6f7',
    onBlockMuted: 'rgba(238, 246, 247, 0.78)',
    onBlockLine: 'rgba(238, 246, 247, 0.4)',
  },
  wine: {
    from: '#3a0d16',
    to: '#1d060b',
    ink: '#fbeee8',
    muted: '#d8a99f',
    line: 'rgba(251, 238, 232, 0.3)',
    block: '#6d001d',
    onBlock: '#fbeee8',
    onBlockMuted: 'rgba(251, 238, 232, 0.78)',
    onBlockLine: 'rgba(251, 238, 232, 0.42)',
  },
  forest: {
    from: '#173225',
    to: '#07150e',
    ink: '#eef5e9',
    muted: '#a9c4ae',
    line: 'rgba(238, 245, 233, 0.28)',
    block: '#1f5136',
    onBlock: '#eef5e9',
    onBlockMuted: 'rgba(238, 245, 233, 0.78)',
    onBlockLine: 'rgba(238, 245, 233, 0.4)',
  },
};

export type CoverStyle = 'vertical' | 'block';

/** Orly 风格的深色配色，本地复刻，不依赖网络 */
const BLOCK_COLORS = [
  '#61005e',
  '#890029',
  '#c4000e',
  '#6a00bd',
  '#0071b1',
  '#009047',
  '#009d9e',
  '#222e85',
  '#bd002e',
  '#009d1a',
  '#75a500',
  '#6d001d',
  '#ba009a',
  '#f10000',
  '#70706d',
  '#2c0077',
];

function hashOf(text: string): number {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash;
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1.3, Math.max(0.8, Math.round(value * 100) / 100));
}

export function normalizeCoverOptions(options?: Partial<CoverOptions> | null): CoverOptions {
  const palette = options?.palette;
  const authorPosition = options?.authorPosition;
  const validPalette =
    palette === 'auto' ||
    (typeof palette === 'string' && Object.prototype.hasOwnProperty.call(PALETTES, palette));
  return {
    palette: validPalette ? (palette as CoverPalette) : DEFAULT_COVER_OPTIONS.palette,
    titleScale: clampScale(options?.titleScale ?? DEFAULT_COVER_OPTIONS.titleScale),
    authorPosition:
      authorPosition === 'bottom' || authorPosition === 'top' || authorPosition === 'hidden'
        ? authorPosition
        : DEFAULT_COVER_OPTIONS.authorPosition,
  };
}

/** 解析模板实际使用的颜色；auto 在竖排模板下走米色纸，在色块模板下走书名哈希色 */
export function resolveCoverPalette(
  style: CoverStyle,
  options: CoverOptions,
  title: string,
): PaletteColors {
  const normalized = normalizeCoverOptions(options);
  if (normalized.palette === 'auto') {
    return style === 'block'
      ? { ...PALETTES.sand, block: BLOCK_COLORS[hashOf(title) % BLOCK_COLORS.length] }
      : PALETTES.sand;
  }
  return PALETTES[normalized.palette];
}

function splitColumns(title: string): string[] {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim());
  const cleaned = chars.slice(0, 32);
  if (chars.length > 32) cleaned.push('…');
  const perColumn = cleaned.length > 16 ? 10 : 8;
  const columns: string[] = [];
  for (let i = 0; i < cleaned.length; i += perColumn) {
    columns.push(cleaned.slice(i, i + perColumn).join(''));
  }
  return columns.length ? columns : ['无题'];
}

function drawVertical(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, gap: number) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  Array.from(text).forEach((ch, i) => {
    ctx.fillText(ch, x, y + i * gap);
  });
}

function paintVertical(
  ctx: CanvasRenderingContext2D,
  title: string,
  author: string,
  options: CoverOptions,
  colors: PaletteColors,
): void {
  const bg = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  bg.addColorStop(0, colors.from);
  bg.addColorStop(0.55, colors.from);
  bg.addColorStop(1, colors.to);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 3;
  ctx.strokeRect(64, 64, WIDTH - 128, HEIGHT - 128);
  ctx.lineWidth = 1;
  ctx.strokeRect(84, 84, WIDTH - 168, HEIGHT - 168);

  const columns = splitColumns(title);
  const baseSize = columns.length > 3 ? 84 : 100;
  const titleSize = Math.round(baseSize * options.titleScale);
  const gap = titleSize + 14;
  const startX = WIDTH - 230;
  const columnGap = titleSize + 34;
  const startY = 260;

  ctx.fillStyle = colors.ink;
  ctx.font = `600 ${titleSize}px "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif`;
  columns.forEach((column, i) => {
    drawVertical(ctx, column, startX - i * columnGap, startY, gap);
  });

  if (author.trim() && options.authorPosition !== 'hidden') {
    ctx.fillStyle = colors.muted;
    ctx.font = '400 52px "Kaiti SC", "KaiTi", "Noto Serif CJK SC", serif';
    const authorChars = Array.from(author.trim()).slice(0, 12);
    const y =
      options.authorPosition === 'top'
        ? 260
        : HEIGHT - 320 - authorChars.length * 60;
    drawVertical(ctx, authorChars.join(''), 240, y, 60);
  }

  ctx.fillStyle = colors.line;
  ctx.fillRect(240, HEIGHT - 210, 150, 2);
  ctx.font = '400 30px "PingFang SC", "Noto Sans CJK SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = colors.muted;
  ctx.fillText('txt2book', 240, HEIGHT - 150);
}

function paintBlock(
  ctx: CanvasRenderingContext2D,
  title: string,
  author: string,
  options: CoverOptions,
  colors: PaletteColors,
): void {
  ctx.fillStyle = colors.block;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 右上角一团柔光
  const glow = ctx.createRadialGradient(WIDTH * 0.78, HEIGHT * 0.24, 40, WIDTH * 0.78, HEIGHT * 0.24, 660);
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(WIDTH * 0.78, HEIGHT * 0.24, 660, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = colors.onBlockLine;
  ctx.lineWidth = 3;
  ctx.strokeRect(64, 64, WIDTH - 128, HEIGHT - 128);
  ctx.lineWidth = 1;
  ctx.strokeRect(86, 86, WIDTH - 172, HEIGHT - 172);

  const columns = splitColumns(title);
  const baseSize = columns.length > 3 ? 82 : 98;
  const titleSize = Math.round(baseSize * options.titleScale);
  const gap = titleSize + 14;
  const startX = WIDTH - 232;
  const columnGap = titleSize + 34;

  ctx.fillStyle = colors.onBlock;
  ctx.font = `600 ${titleSize}px "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif`;
  columns.forEach((column, i) => {
    drawVertical(ctx, column, startX - i * columnGap, 232, gap);
  });

  if (author.trim() && options.authorPosition !== 'hidden') {
    ctx.fillStyle = colors.onBlockMuted;
    ctx.font = '400 50px "Kaiti SC", "KaiTi", "Noto Serif CJK SC", serif';
    const authorChars = Array.from(author.trim()).slice(0, 12);
    const y =
      options.authorPosition === 'top'
        ? 232
        : HEIGHT - 300 - authorChars.length * 58;
    drawVertical(ctx, authorChars.join(''), 232, y, 58);
  }

  ctx.fillStyle = colors.onBlockLine;
  ctx.fillRect(232, HEIGHT - 206, 132, 2);
  ctx.font = '400 30px "PingFang SC", "Noto Sans CJK SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = colors.onBlockMuted;
  ctx.fillText('txt2book', 232, HEIGHT - 150);
}

function createCoverCanvas(
  title: string,
  author: string,
  style: CoverStyle = 'vertical',
  rawOptions?: Partial<CoverOptions> | null,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas');
  const options = normalizeCoverOptions(rawOptions);
  const colors = resolveCoverPalette(style, options, title);
  if (style === 'block') paintBlock(ctx, title, author, options, colors);
  else paintVertical(ctx, title, author, options, colors);
  return canvas;
}

async function toJpeg(canvas: HTMLCanvasElement): Promise<CoverData> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('封面生成失败');
  const data = new Uint8Array(await blob.arrayBuffer());
  return { data, mime: 'image/jpeg' };
}

/** 生成正式封面（1200×1800 JPEG） */
export async function generateCover(
  title: string,
  author: string,
  style: CoverStyle = 'vertical',
  options?: Partial<CoverOptions> | null,
): Promise<CoverData> {
  return toJpeg(createCoverCanvas(title, author, style, options));
}

/** 实时预览：优先显示上传的封面，否则按当前模板绘制；没有预览尺寸时按 180×270 */
export async function drawCoverPreview(
  canvas: HTMLCanvasElement,
  title: string,
  author: string,
  style: CoverStyle,
  options?: Partial<CoverOptions> | null,
  cover?: CoverData | null,
): Promise<void> {
  if (!canvas.width || !canvas.height) {
    canvas.width = 180;
    canvas.height = 270;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (cover) {
    try {
      const bitmap = await createImageBitmap(new Blob([cover.data.slice().buffer], { type: cover.mime }));
      const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
      const dw = bitmap.width * scale;
      const dh = bitmap.height * scale;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      bitmap.close();
      return;
    } catch {
      /* 图片解码失败时退回模板预览 */
    }
  }

  const source = createCoverCanvas(title, author, style, options);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取这张图片'));
    };
    img.src = url;
  });
}

export async function coverFromImage(file: File): Promise<CoverData> {
  let width = 0;
  let height = 0;
  let source: CanvasImageSource;

  try {
    const bitmap = await createImageBitmap(file);
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } catch {
    const img = await loadImage(file);
    source = img;
    width = img.naturalWidth;
    height = img.naturalHeight;
  }

  if (!width || !height) throw new Error('无法读取这张图片');

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const scale = Math.max(WIDTH / width, HEIGHT / height);
  const dw = width * scale;
  const dh = height * scale;
  ctx.drawImage(source, (WIDTH - dw) / 2, (HEIGHT - dh) / 2, dw, dh);

  if ('close' in source && typeof source.close === 'function') source.close();
  return toJpeg(canvas);
}

/**
 * 书架缩略图：只存 120×180 的小图，避免把整张封面复制进书架记录。
 * 生成失败时返回 null，不影响主流程。
 */
export async function coverThumbnail(cover: CoverData): Promise<string | null> {
  try {
    const buffer = cover.data.slice().buffer;
    const bitmap = await createImageBitmap(new Blob([buffer], { type: cover.mime }));
    const width = 120;
    const height = 180;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    ctx.drawImage(bitmap, (width - dw) / 2, (height - dh) / 2, dw, dh);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}
