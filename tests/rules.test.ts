import { describe, expect, it } from 'vitest';
import { chaptersFromText, findHeadingCandidates } from '../src/core/chapters';
import { compileRules, getPreset, validateRuleSpec, type RuleSpec } from '../src/core/rules';

const NUMBERED = `1. 初见
正文一。
2. 再会
正文二。`;

const CUSTOM_INLINE = `我的站点水印第1章 开始
正文一。
我的站点水印第2章 继续
正文二。`;

describe('识别规则', () => {
  it('数字标题预设能识别非「第X章」格式', () => {
    const preset = getPreset('numbered');
    expect(preset).not.toBeNull();
    const withRules = chaptersFromText(NUMBERED, { filterAds: true, rules: compileRules(preset) });
    expect(withRules.chapters.map((c) => c.title)).toEqual(['1. 初见', '2. 再会']);

    const withoutRules = chaptersFromText(NUMBERED, { filterAds: true });
    expect(withoutRules.chapters).toHaveLength(1);
  });

  it('裸数字和英文 Section 预设可用', () => {
    const bare = compileRules(getPreset('bare-number'));
    expect(bare?.chapter?.test('123')).toBe(true);
    expect(bare?.chapter?.test('第1章')).toBe(false);
    const bareText = '12\n正文一。\n13\n正文二。';
    const parsed = chaptersFromText(bareText, { filterAds: true, rules: bare });
    expect(parsed.chapters.map((c) => c.title)).toEqual(['12', '13']);

    const english = compileRules(getPreset('english'));
    expect(english?.chapter?.test('Section 2 尾声')).toBe(true);
    expect(english?.chapter?.test('Page 9')).toBe(true);
  });

  it('自定义 drop 规则会整行删除', () => {
    const spec: RuleSpec = { name: '测试', chapter: '^第\\d+章', drop: ['本站域名'] };
    const text = '第1章 开始\n正文一。\n本站域名 example.com 请访问\n正文二。';
    const result = chaptersFromText(text, { filterAds: true, rules: compileRules(spec) });
    const body = result.chapters.flatMap((c) => c.paragraphs).join('\n');
    expect(body).not.toContain('本站域名');
    expect(body).toContain('正文二。');
  });

  it('自定义 inlineJunk 能识别粘连水印的标题，并用于漏章诊断', () => {
    const spec: RuleSpec = { name: '测试', chapter: '^第\\d+章', inlineJunk: ['我的站点水印'] };
    const rules = compileRules(spec);

    const withRules = chaptersFromText(CUSTOM_INLINE, { filterAds: true, rules });
    expect(withRules.chapters.map((c) => c.title)).toEqual(['第1章 开始', '第2章 继续']);

    const withoutRules = chaptersFromText(CUSTOM_INLINE, { filterAds: true });
    expect(withoutRules.chapters).toHaveLength(1);

    const chapters = [
      { id: 'ch-1', title: '第一章', level: 2 as const, paragraphs: ['我的站点水印第9章 决战'] },
    ];
    expect(findHeadingCandidates(chapters)).toHaveLength(0);
    expect(findHeadingCandidates(chapters, rules)).toHaveLength(1);
  });

  it('规则文件校验能指出错误的字段', () => {
    expect(validateRuleSpec({ name: 'ok', chapter: '^第\\d+章' })).toBeNull();
    expect(validateRuleSpec(null)).toContain('JSON 对象');
    expect(validateRuleSpec({ chapter: 'x' })).toContain('name');
    expect(validateRuleSpec({ name: 'x', chapter: '[' })).toContain('chapter');
    expect(validateRuleSpec({ name: 'x', drop: ['['] })).toContain('drop');
    expect(validateRuleSpec({ name: 'x', drop: 'not-array' })).toContain('字符串数组');
    expect(validateRuleSpec({ name: 'x', inlineJunk: 'not-array' })).toContain('字符串数组');
  });
});
