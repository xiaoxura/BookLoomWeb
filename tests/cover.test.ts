import { describe, expect, it } from 'vitest';
import {
  COVER_PALETTE_LABELS,
  DEFAULT_COVER_OPTIONS,
  normalizeCoverOptions,
  resolveCoverPalette,
} from '../src/core/cover';
import type { CoverAuthorPosition, CoverPalette } from '../src/types';

describe('封面参数', () => {
  it('缺省和旧草稿用默认值', () => {
    expect(normalizeCoverOptions(undefined)).toEqual(DEFAULT_COVER_OPTIONS);
    expect(normalizeCoverOptions({})).toEqual(DEFAULT_COVER_OPTIONS);
    expect(normalizeCoverOptions({ palette: 'sand' }).palette).toBe('sand');
  });

  it('颜色 / 位置非法时回退，字号限制在 0.8–1.3', () => {
    const normalized = normalizeCoverOptions({
      palette: 'rainbow' as CoverPalette,
      titleScale: 9,
      authorPosition: 'left' as unknown as CoverAuthorPosition,
    });
    expect(normalized.palette).toBe('auto');
    expect(normalized.titleScale).toBe(1.3);
    expect(normalized.authorPosition).toBe('bottom');
    expect(normalizeCoverOptions({ titleScale: 0.1 }).titleScale).toBe(0.8);
    expect(normalizeCoverOptions({ titleScale: Number.NaN }).titleScale).toBe(1);
    expect(normalizeCoverOptions({ titleScale: 1.234 }).titleScale).toBe(1.23);
  });

  it('auto 在竖排模板下是米色纸，色块模板按书名哈希', () => {
    const vertical = resolveCoverPalette('vertical', DEFAULT_COVER_OPTIONS, '雾港灯塔');
    expect(vertical.from).toBe('#f8f2e4');
    const block = resolveCoverPalette('block', DEFAULT_COVER_OPTIONS, '雾港灯塔');
    expect(block.block).toMatch(/^#[0-9a-f]{6}$/i);
    const same = resolveCoverPalette('block', DEFAULT_COVER_OPTIONS, '雾港灯塔');
    expect(same.block).toBe(block.block);
    const other = resolveCoverPalette('block', DEFAULT_COVER_OPTIONS, '另一本书');
    expect(other.block).not.toBe(block.block);
  });

  it('预设配色覆盖两种模板的颜色', () => {
    const solo = normalizeCoverOptions({ palette: 'sea', titleScale: 1, authorPosition: 'top' });
    const vertical = resolveCoverPalette('vertical', solo, '书');
    const block = resolveCoverPalette('block', solo, '书');
    expect(vertical.from).toBe('#0f3446');
    expect(vertical.ink).toBe('#eef6f7');
    expect(block.block).toBe('#0f4c5c');
    expect(block.onBlock).toBe('#eef6f7');
  });

  it('所有预设都有中文标签', () => {
    const palettes: CoverPalette[] = ['auto', 'sand', 'ink', 'sea', 'wine', 'forest'];
    for (const palette of palettes) {
      expect(COVER_PALETTE_LABELS[palette].length).toBeGreaterThan(0);
    }
  });
});
