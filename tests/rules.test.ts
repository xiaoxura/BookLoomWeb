import { describe, expect, it } from 'vitest';
import { chaptersFromText } from '../src/core/chapters';
import { compileRules, getPreset, validateRuleSpec, type RuleSpec } from '../src/core/rules';

const NUMBERED = `1. 初见
正文一。
2. 再会
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

  it('自定义 drop 规则会整行删除', () => {
    const spec: RuleSpec = { name: '测试', chapter: '^第\\d+章', drop: ['本站域名'] };
    const text = '第1章 开始\n正文一。\n本站域名 example.com 请访问\n正文二。';
    const result = chaptersFromText(text, { filterAds: true, rules: compileRules(spec) });
    const body = result.chapters.flatMap((c) => c.paragraphs).join('\n');
    expect(body).not.toContain('本站域名');
    expect(body).toContain('正文二。');
  });

  it('规则文件校验能指出错误的字段', () => {
    expect(validateRuleSpec({ name: 'ok', chapter: '^第\\d+章' })).toBeNull();
    expect(validateRuleSpec(null)).toContain('JSON 对象');
    expect(validateRuleSpec({ chapter: 'x' })).toContain('name');
    expect(validateRuleSpec({ name: 'x', chapter: '[' })).toContain('chapter');
    expect(validateRuleSpec({ name: 'x', drop: ['['] })).toContain('drop');
    expect(validateRuleSpec({ name: 'x', drop: 'not-array' })).toContain('字符串数组');
  });
});
