import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chaptersFromText, findHeadingCandidates } from '../src/core/chapters';

/** 回归语料：改动识别逻辑后，先保证这几本的结构不变 */
const CASES = [
  { file: 'public/sample.txt', chapters: 7, first: '内容简介', candidates: 0 },
  { file: 'tests/fixtures/messy.txt', chapters: 4, first: '内容简介', candidates: 0 },
  { file: 'tests/fixtures/missed.txt', chapters: 2, first: '第1章 开始', candidates: 1 },
  { file: 'tests/fixtures/punctuation.txt', chapters: 3, first: '第1章 开始', candidates: 0 },
];

describe('回归语料', () => {
  for (const item of CASES) {
    it(`${item.file} 的章节结构保持稳定`, () => {
      const text = fs.readFileSync(item.file, 'utf8');
      const { chapters } = chaptersFromText(text, { filterAds: true });
      expect(chapters).toHaveLength(item.chapters);
      expect(chapters[0].title).toBe(item.first);
      expect(findHeadingCandidates(chapters)).toHaveLength(item.candidates);
    });
  }
});
