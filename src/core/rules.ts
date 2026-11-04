/** 可配置的识别规则：站点预设 + 用户自定义 */
export interface RuleSpec {
  id?: string;
  name: string;
  /** 章节标题正则（整行匹配） */
  chapter?: string;
  /** 卷标题正则（整行匹配） */
  volume?: string;
  /** 需要整行丢弃的正则（不受行长限制） */
  drop?: string[];
  /** 标题前可能粘连的水印前缀（用于把标题救回来） */
  inlineJunk?: string[];
}

export interface CompiledRules {
  chapter: RegExp | null;
  volume: RegExp | null;
  drop: RegExp[];
  inlineJunk: RegExp | null;
}

export const RULE_PRESETS: RuleSpec[] = [
  {
    id: 'ixdzs',
    name: '爱下电子书',
    drop: ['爱下电子书', 'ixdzs', '章节内容开始', '内容还在处理中', '请稍后重试'],
    inlineJunk: ['内容还在处理中', '请稍后重试', '正在手打中'],
  },
  {
    id: 'biquge',
    name: '笔趣阁系',
    drop: ['笔趣阁', '最新章节', '无弹窗', '请记住本站', '手机阅读', '顶点小说', '八一中文'],
    inlineJunk: ['请记住本站', '最新章节', '无弹窗'],
  },
  {
    id: 'numbered',
    name: '数字标题（1. 标题 / 12、）',
    chapter: '^\\s*\\d{1,4}\\s*[、.．:：]\\s*.{0,40}$',
  },
  {
    id: 'bare-number',
    name: '裸数字标题（123）',
    chapter: '^\\s*\\d{1,4}\\s*$',
  },
  {
    id: 'english',
    name: '英文 Chapter / Section',
    chapter: '^(?:chapter|part|volume|section|page)\\s+[0-9ivxlcdm]+\\b.{0,60}$',
    volume: '^(?:part|volume)\\s+[0-9ivxlcdm]+\\b.{0,40}$',
  },
];

export function getPreset(id: string): RuleSpec | null {
  const preset = RULE_PRESETS.find((item) => item.id === id);
  return preset ? { ...preset } : null;
}

function toRegExp(source?: string): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

export function compileRules(spec?: RuleSpec | null): CompiledRules | null {
  if (!spec) return null;
  return {
    chapter: toRegExp(spec.chapter),
    volume: toRegExp(spec.volume),
    drop: (spec.drop ?? []).map(toRegExp).filter((item): item is RegExp => Boolean(item)),
    inlineJunk: toRegExp((spec.inlineJunk ?? []).join('|')),
  };
}

/** 返回第一条错误信息，合法时返回 null */
export function validateRuleSpec(value: unknown): string | null {
  if (!value || typeof value !== 'object') return '规则必须是一个 JSON 对象';
  const spec = value as RuleSpec;
  if (typeof spec.name !== 'string' || !spec.name.trim()) return '规则缺少 name';
  const check = (pattern: unknown, label: string): string | null => {
    if (pattern === undefined) return null;
    if (typeof pattern !== 'string') return `${label} 必须是字符串`;
    try {
      new RegExp(pattern, 'i');
      return null;
    } catch {
      return `${label} 不是合法的正则`;
    }
  };
  for (const [field, label] of [
    ['chapter', 'chapter'],
    ['volume', 'volume'],
  ] as const) {
    const error = check(spec[field], label);
    if (error) return error;
  }
  for (const field of ['drop', 'inlineJunk'] as const) {
    const list = spec[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `${field} 必须是字符串数组`;
    for (const item of list) {
      if (typeof item !== 'string') return `${field} 里只能放字符串`;
      try {
        new RegExp(item, 'i');
      } catch {
        return `${field} 里有不合法的正则：${item}`;
      }
    }
  }
  return null;
}
