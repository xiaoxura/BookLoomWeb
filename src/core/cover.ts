import type { CoverData } from '../types';

const WIDTH = 1200;
const HEIGHT = 1800;

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

function paint(canvas: HTMLCanvasElement, title: string, author: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas');

  const bg = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  bg.addColorStop(0, '#f8f2e4');
  bg.addColorStop(0.55, '#efe4cf');
  bg.addColorStop(1, '#e0d0b2');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = 'rgba(104, 82, 52, 0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(64, 64, WIDTH - 128, HEIGHT - 128);
  ctx.strokeStyle = 'rgba(104, 82, 52, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(84, 84, WIDTH - 168, HEIGHT - 168);

  const columns = splitColumns(title);
  const titleSize = columns.length > 3 ? 84 : 100;
  const gap = titleSize + 14;
  const startX = WIDTH - 230;
  const columnGap = titleSize + 34;
  const startY = 260;

  ctx.fillStyle = '#2f2a22';
  ctx.font = `600 ${titleSize}px "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif`;
  columns.forEach((column, i) => {
    drawVertical(ctx, column, startX - i * columnGap, startY, gap);
  });

  if (author.trim()) {
    ctx.fillStyle = '#6b5d45';
    ctx.font = '400 52px "Kaiti SC", "KaiTi", "Noto Serif CJK SC", serif';
    const authorChars = Array.from(author.trim()).slice(0, 12);
    drawVertical(ctx, authorChars.join(''), 240, HEIGHT - 320 - authorChars.length * 60, 60);
  }

  ctx.fillStyle = 'rgba(104, 82, 52, 0.45)';
  ctx.fillRect(240, HEIGHT - 210, 150, 2);
  ctx.font = '400 30px "PingFang SC", "Noto Sans CJK SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('txt2book', 240, HEIGHT - 150);
}

async function toJpeg(canvas: HTMLCanvasElement): Promise<CoverData> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('封面生成失败');
  const data = new Uint8Array(await blob.arrayBuffer());
  return { data, mime: 'image/jpeg' };
}

export async function generateCover(title: string, author: string): Promise<CoverData> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  paint(canvas, title, author);
  return toJpeg(canvas);
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
