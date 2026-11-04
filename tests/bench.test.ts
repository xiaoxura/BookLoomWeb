import fs from 'node:fs';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { chaptersFromText, countChars } from '../src/core/chapters';
import { buildEpub } from '../src/core/export/epub';
import { decodeBuffer, normalizeText } from '../src/core/text';

const WORDS =
  '夜色像一块湿透的布慢慢盖住了整座城他站在桥头听见远处传来汽笛声一声长一声短风从海面吹来带着咸味和铁锈的味道灯塔的光穿过雾照在礁石上碎成一片一片';

function sentence(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += WORDS[(i * 7 + length) % WORDS.length];
  return `${out}。`;
}

function makeNovel(chapters: number): string {
  const pieces: string[] = ['内容简介\n这是一个用于压测的长篇故事。\n'];
  for (let i = 1; i <= chapters; i++) {
    pieces.push(`第${i}章 第${i}次潮汐`);
    for (let j = 0; j < 8; j++) pieces.push(sentence(90 + ((i * 13 + j * 7) % 80)));
    if (i % 100 === 0) pieces.push(`第${i}卷 潮声再起`);
    if (i % 37 === 0) pieces.push('请记住本站域名 www.example.com');
  }
  return pieces.join('\n\n');
}

describe('大文件压测', () => {
  it('1200 章 / 4MB GBK 走完整链路', () => {
    const text = makeNovel(1200);
    const raw = iconv.encode(text, 'gbk');
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;

    const t0 = performance.now();
    const decoded = decodeBuffer(buffer);
    const t1 = performance.now();
    const normalized = normalizeText(decoded.text);
    const t2 = performance.now();
    const { chapters } = chaptersFromText(normalized, { filterAds: true });
    const t3 = performance.now();
    const epub = buildEpub({
      chapters,
      meta: { title: '潮汐记事', author: '压测', language: 'zh-CN' },
      layout: { lineHeight: 1.75, indent: true, paragraphSpacing: 0, font: 'serif', justify: true },
      cover: null,
    });
    const t4 = performance.now();

    console.log(
      [
        `原文 ${(text.length / 10000).toFixed(1)} 万字 / GBK ${(raw.length / 1024 / 1024).toFixed(2)} MB`,
        `编码 ${decoded.encoding}（${decoded.confidence.toFixed(2)}）· 章节 ${chapters.length} · 字数 ${countChars(normalized).toLocaleString('zh-CN')}`,
        `EPUB ${(epub.length / 1024).toFixed(0)} KB`,
        `decode ${(t1 - t0).toFixed(0)}ms · normalize ${(t2 - t1).toFixed(0)}ms · chapters ${(t3 - t2).toFixed(0)}ms · pack ${(t4 - t3).toFixed(0)}ms`,
      ].join('\n'),
    );

    expect(decoded.encoding).toBe('gb18030');
    expect(chapters.length).toBeGreaterThanOrEqual(1200);
    expect(epub.length).toBeGreaterThan(500_000);
    expect(t4 - t0).toBeLessThan(5000);

    fs.mkdirSync('samples', { recursive: true });
    fs.writeFileSync('samples/bench.epub', epub);
  }, 60000);
});
