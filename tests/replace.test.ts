import { describe, expect, it } from 'vitest';
import {
  applyReplace,
  looksCatastrophic,
  previewReplace,
  REPLACE_LIMITS,
  validateReplaceOptions,
  type ReplaceOptions,
} from '../src/core/replace';
import type { Chapter } from '../src/types';

function makeChapters(): Chapter[] {
  return [
    { id: 'a', title: '第1章 开始', level: 2, paragraphs: ['他说：你好，世界。', '第二段 你好。'] },
    { id: 'b', title: '第2章 继续', level: 2, paragraphs: ['你好，旅人。'] },
  ];
}

function opts(partial: Partial<ReplaceOptions>): ReplaceOptions {
  return { find: '你好', replace: '您好', scope: 'all', regex: false, caseSensitive: false, ...partial };
}

describe('批量替换', () => {
  it('按范围替换正文，标题不动', () => {
    const chapters = makeChapters();
    const result = applyReplace(chapters, opts({ scope: 'body' }));
    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    expect(result.chapters[0].title).toBe('第1章 开始');
    expect(result.chapters[0].paragraphs[0]).toBe('他说：您好，世界。');
    expect(result.chapters[1].paragraphs[0]).toBe('您好，旅人。');
    // 原数组不被修改
    expect(chapters[0].paragraphs[0]).toBe('他说：你好，世界。');
  });

  it('按范围替换标题，正文不动', () => {
    const result = applyReplace(makeChapters(), opts({ find: '继续', replace: '再续', scope: 'title' }));
    expect(result.total).toBe(1);
    expect(result.chapters[1].title).toBe('第2章 再续');
    expect(result.chapters[0].paragraphs[0]).toContain('你好');
  });

  it('正则替换支持分组引用', () => {
    const result = applyReplace(
      makeChapters(),
      opts({ find: '第(\\d+)章', replace: 'Chapter $1', regex: true, scope: 'title' }),
    );
    expect(result.total).toBe(2);
    expect(result.chapters.map((c) => c.title)).toEqual(['Chapter 1 开始', 'Chapter 2 继续']);
  });

  it('普通查找时替换内容里的 $1 按字面量处理', () => {
    const result = applyReplace(makeChapters(), opts({ find: '你好', replace: '$1', scope: 'body' }));
    expect(result.chapters[0].paragraphs[0]).toBe('他说：$1，世界。');
  });

  it('默认不区分大小写，可以开启区分', () => {
    const chapters: Chapter[] = [{ id: 'a', title: 'T', level: 2, paragraphs: ['Alpha alpha ALPHA'] }];
    expect(applyReplace(chapters, opts({ find: 'alpha', replace: 'x', scope: 'body' })).total).toBe(3);
    const sensitive = applyReplace(
      chapters,
      opts({ find: 'alpha', replace: 'x', scope: 'body', caseSensitive: true }),
    );
    expect(sensitive.total).toBe(1);
    expect(sensitive.chapters[0].paragraphs[0]).toBe('Alpha x ALPHA');
  });

  it('预览给出命中数、上下文，并截断列表', () => {
    const preview = previewReplace(makeChapters(), opts({ scope: 'all' }), 2);
    expect(preview.ok).toBe(true);
    expect(preview.total).toBe(3);
    expect(preview.matches).toHaveLength(2);
    expect(preview.truncated).toBe(true);
    expect(preview.matches[0].field).toBe('body');
    expect(preview.matches[0].paragraphIndex).toBe(0);
    expect(preview.matches[0].match).toBe('你好');
    expect(preview.matches[0].before).toBe('他说：');
    expect(preview.matches[0].after).toBe('，世界。');
  });

  it('标题命中时 paragraphIndex 为 null', () => {
    const preview = previewReplace(makeChapters(), opts({ scope: 'title', find: '开始', replace: '出发' }));
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0].field).toBe('title');
    expect(preview.matches[0].paragraphIndex).toBeNull();
    expect(preview.matches[0].chapterId).toBe('a');
  });

  it('全角空格与特殊字符可以正常替换', () => {
    const chapters: Chapter[] = [{ id: 'a', title: '标题', level: 2, paragraphs: ['第一段\u3000第二段'] }];
    const result = applyReplace(chapters, opts({ find: '\u3000', replace: ' ', scope: 'body' }));
    expect(result.chapters[0].paragraphs[0]).toBe('第一段 第二段');
  });

  it('空查找、非法正则、超长输入会被拒绝', () => {
    expect(validateReplaceOptions(opts({ find: '' }))).toContain('不能为空');
    expect(validateReplaceOptions(opts({ find: '('.repeat(1), regex: true }))).toContain('正则表达式无效');
    expect(validateReplaceOptions(opts({ find: 'a'.repeat(REPLACE_LIMITS.pattern + 1) }))).toContain('不能超过');
    expect(
      validateReplaceOptions(opts({ replace: 'a'.repeat(REPLACE_LIMITS.replacement + 1) })),
    ).toContain('不能超过');

    const preview = previewReplace(makeChapters(), opts({ find: '(', regex: true }));
    expect(preview.ok).toBe(false);
    expect(preview.error).toContain('正则');
    expect(preview.total).toBe(0);
  });

  it('拒绝灾难性回溯的嵌套量词', () => {
    expect(looksCatastrophic('(a+)+')).toBe(true);
    expect(looksCatastrophic('(a*)*')).toBe(true);
    expect(looksCatastrophic('(\\w+)+')).toBe(true);
    expect(looksCatastrophic('(a|aa)+')).toBe(true);
    expect(looksCatastrophic('(foo|bar)+')).toBe(true);
    expect(looksCatastrophic('(ab)+')).toBe(false);
    expect(looksCatastrophic('第\\d+章')).toBe(false);

    const preview = previewReplace(makeChapters(), opts({ find: '(a+)+', regex: true }));
    expect(preview.ok).toBe(false);
    expect(preview.error).toContain('嵌套量词');
  });

  it('零长度匹配不会死循环', () => {
    const preview = previewReplace(makeChapters(), opts({ find: '^', regex: true, scope: 'body' }));
    expect(preview.ok).toBe(true);
    expect(preview.total).toBe(3);
    const result = applyReplace(makeChapters(), opts({ find: '^', replace: '*', regex: true, scope: 'body' }));
    expect(result.chapters[0].paragraphs[0]).toBe('*他说：你好，世界。');
  });

  it('没有命中时返回原数组', () => {
    const chapters = makeChapters();
    const result = applyReplace(chapters, opts({ find: '不存在' }));
    expect(result.total).toBe(0);
    expect(result.chapters).toBe(chapters);
  });
});
