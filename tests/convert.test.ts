import { describe, expect, it } from 'vitest';
import {
  convertChapters,
  convertParseResult,
  loadConverter,
  resetConverterCache,
} from '../src/core/convert';
import type { Chapter, ParseResult } from '../src/types';

const chapters: Chapter[] = [
  { id: 'v', title: '第一卷 潮声', level: 1, paragraphs: [] },
  { id: 'c', title: '第一章 守塔人', level: 2, paragraphs: ['雾从海面漫上来。', '他头发湿了。'] },
  { id: 'f', title: '前言', level: 2, paragraphs: ['干净的海风。'], frontMatter: true },
];

describe('繁简转换', () => {
  it('保持原样时返回恒等转换，不加载词典', async () => {
    const convert = await loadConverter('none');
    expect(convert('汉语')).toBe('汉语');
  });

  it('简体转繁体：一对多和词组都按 OpenCC 处理', async () => {
    const convert = await loadConverter('traditional');
    expect(convert('汉语 头发 干净 里面 面条 发展')).toBe('漢語 頭髮 乾淨 裡面 麵條 發展');
  });

  it('繁体转简体', async () => {
    const convert = await loadConverter('simplified');
    expect(convert('漢語 頭髮 乾淨 裡面 麵條 發展')).toBe('汉语 头发 干净 里面 面条 发展');
  });

  it('同一方向只加载一次词典', async () => {
    resetConverterCache();
    const first = await loadConverter('traditional');
    const second = await loadConverter('traditional');
    expect(first).toBe(second);
  });

  it('章节标题、正文都转换，结构和 frontMatter 不变，也不修改原数组', async () => {
    const convert = await loadConverter('traditional');
    const converted = convertChapters(chapters, convert);
    expect(converted.map((chapter) => chapter.title)).toEqual([
      '第一卷 潮聲',
      '第一章 守塔人',
      '前言',
    ]);
    expect(converted[1].paragraphs).toEqual(['霧從海面漫上來。', '他頭髮溼了。']);
    expect(converted[2].frontMatter).toBe(true);
    expect(converted[1].level).toBe(2);
    expect(converted[1].id).toBe('c');
    expect(chapters[1].paragraphs[0]).toBe('雾从海面漫上来。');
  });

  it('转换结果里的书名 / 作者猜测一起转换，警告和封面保留', async () => {
    const convert = await loadConverter('traditional');
    const result: ParseResult = {
      sourceType: 'txt',
      encoding: 'utf-8',
      confidence: 1,
      chars: 4,
      chapters,
      warnings: ['原样保留'],
      titleGuess: '雾港灯塔',
      authorGuess: '林间',
      language: 'zh-CN',
    };
    const converted = convertParseResult(result, convert);
    expect(converted.titleGuess).toBe('霧港燈塔');
    expect(converted.authorGuess).toBe('林間');
    expect(converted.warnings).toEqual(['原样保留']);
    expect(converted.encoding).toBe('utf-8');
    expect(converted.chapters[0].title).toBe('第一卷 潮聲');
  });

  it('清空缓存后可以重新加载', async () => {
    resetConverterCache();
    const converter = await loadConverter('simplified');
    expect(converter('漢語')).toBe('汉语');
  });
});
