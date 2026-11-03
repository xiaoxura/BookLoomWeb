import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { buildParagraphs, decodeBuffer } from '../src/core/text';

function toBuffer(text: string, encoding: string): ArrayBuffer {
  const encoded = iconv.encode(text, encoding);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

const SIMPLIFIED =
  '第一章 风起\n\n夜色像一块湿透的布，慢慢盖住了整座城。\n他站在桥头，听见远处传来汽笛声，一声长，一声短。';
const TRADITIONAL =
  '第一章 風起\n\n夜色像一塊濕透的布，慢慢蓋住了整座城。\n他站在橋頭，聽見遠處傳來汽笛聲，一聲長，一聲短。';

describe('decodeBuffer', () => {
  it('识别 UTF-8', () => {
    const result = decodeBuffer(toBuffer(SIMPLIFIED, 'utf8'));
    expect(result.encoding).toBe('utf-8');
    expect(result.text).toContain('湿透的布');
  });

  it('识别带 BOM 的 UTF-8', () => {
    const raw = iconv.encode(SIMPLIFIED, 'utf8');
    const withBom = new Uint8Array(raw.length + 3);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(raw, 3);
    const result = decodeBuffer(withBom.buffer as ArrayBuffer);
    expect(result.encoding).toBe('utf-8');
    expect(result.text.startsWith('第一章')).toBe(true);
  });

  it('识别 GBK / GB18030', () => {
    const result = decodeBuffer(toBuffer(SIMPLIFIED, 'gbk'));
    expect(result.encoding).toBe('gb18030');
    expect(result.text).toContain('湿透的布');
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it('识别 Big5', () => {
    const result = decodeBuffer(toBuffer(TRADITIONAL, 'big5'));
    expect(result.encoding).toBe('big5');
    expect(result.text).toContain('濕透的布');
  });

  it('识别带 BOM 的 UTF-16LE', () => {
    const raw = iconv.encode(SIMPLIFIED, 'utf16-le');
    const withBom = new Uint8Array(raw.length + 2);
    withBom.set([0xff, 0xfe]);
    withBom.set(raw, 2);
    const result = decodeBuffer(withBom.buffer as ArrayBuffer);
    expect(result.encoding).toBe('utf-16le');
    expect(result.text).toContain('汽笛声');
  });

  it('纯 ASCII 按 UTF-8 处理', () => {
    const result = decodeBuffer(toBuffer('hello world', 'utf8'));
    expect(result.encoding).toBe('utf-8');
    expect(result.text).toBe('hello world');
  });
});

describe('buildParagraphs', () => {
  it('把硬换行并回段落', () => {
    const lines = ['夜色像一块湿透的布，', '慢慢盖住了整座城。', '', '他站在桥头，', '听见远处传来汽笛声。'];
    expect(buildParagraphs(lines, { filterAds: false })).toEqual([
      '夜色像一块湿透的布，慢慢盖住了整座城。',
      '他站在桥头，听见远处传来汽笛声。',
    ]);
  });

  it('带缩进的行按段处理并去掉首尾空白', () => {
    const lines = ['　　第一段。', '　　第二段。'];
    expect(buildParagraphs(lines, { filterAds: false })).toEqual(['第一段。', '第二段。']);
  });

  it('过滤广告行', () => {
    const lines = ['正文第一段。', '请记住本站域名 www.example.com', '本章未完，点击下一页继续阅读', '正文第二段。'];
    expect(buildParagraphs(lines, { filterAds: true })).toEqual(['正文第一段。', '正文第二段。']);
    const unfiltered = buildParagraphs(lines, { filterAds: false });
    expect(unfiltered.join('')).toContain('请记住本站域名');
    expect(unfiltered.join('')).toContain('点击下一页');
  });

  it('长广告行、分隔线和单独邮箱也能过滤', () => {
    const lines = [
      '正文第一段。',
      '爱下电子书Txt版阅读,下载和分享更多电子书请访问,简体与繁体站点同步更新,欢迎收藏',
      '------章节内容开始-------',
      'mail:support@ixdzs8.com',
      '正文第二段。',
    ];
    expect(buildParagraphs(lines, { filterAds: true })).toEqual(['正文第一段。', '正文第二段。']);
  });

  it('异常长的无标点行会按 2 万字切开', () => {
    const long = '字'.repeat(25000);
    const paragraphs = buildParagraphs([long], { filterAds: false });
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toHaveLength(20000);
    expect(paragraphs[1]).toHaveLength(5000);
  });

  it('英文并段时补空格', () => {
    const lines = ['The night was dark and', 'the sea was quiet.'];
    expect(buildParagraphs(lines, { filterAds: false })).toEqual(['The night was dark and the sea was quiet.']);
  });
});
