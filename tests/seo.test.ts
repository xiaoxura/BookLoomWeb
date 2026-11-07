import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';

const SITE = 'https://bookloom.xiaoxura.com';

const html = readFileSync('index.html', 'utf8');
const robots = readFileSync('public/robots.txt', 'utf8');
const sitemap = readFileSync('public/sitemap.xml', 'utf8');
const llms = readFileSync('public/llms.txt', 'utf8').replace(/\r\n/g, '\n');
const ogImage = readFileSync('public/og.png');

interface SchemaNode {
  '@type'?: string | string[];
  [key: string]: unknown;
}

function graphOf(page: string): SchemaNode[] {
  const blocks = [
    ...page.matchAll(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  return blocks.flatMap((block) => {
    const data = JSON.parse(block[1]) as { '@graph'?: SchemaNode[] };
    return data['@graph'] ?? [data as SchemaNode];
  });
}

function typesOf(node: SchemaNode): string[] {
  const type = node['@type'];
  return Array.isArray(type) ? type : type ? [type] : [];
}

function findNode(nodes: SchemaNode[], type: string): SchemaNode | undefined {
  return nodes.find((node) => typesOf(node).includes(type));
}

function text(value: string | undefined): string {
  return (value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function metaContent(page: string, attribute: 'name' | 'property', key: string): string {
  const pattern = new RegExp(`<meta[^>]*${attribute}="${key}"[^>]*content="([^"]*)"`, 'i');
  return pattern.exec(page)?.[1] ?? '';
}

describe('页面基础 SEO', () => {
  it('首页只有唯一 h1', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it('标题与描述唯一且长度合理', () => {
    const description = metaContent(html, 'name', 'description');
    expect(description.length).toBeGreaterThanOrEqual(60);
    expect(description.length).toBeLessThanOrEqual(200);
  });

  it('canonical 与 og:url 指向正式域名', () => {
    expect(html).toContain(`<link rel="canonical" href="${SITE}/" />`);
    expect(metaContent(html, 'property', 'og:url')).toBe(`${SITE}/`);
  });

  it('社交分享图使用绝对地址并声明尺寸', () => {
    expect(metaContent(html, 'property', 'og:image')).toBe(`${SITE}/og.png`);
    expect(metaContent(html, 'property', 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'property', 'og:image:height')).toBe('630');
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(ogImage.readUInt32BE(16)).toBe(1200);
    expect(ogImage.readUInt32BE(20)).toBe(630);
  });
});

describe('结构化数据', () => {
  const homeNodes = graphOf(html);

  it('首页包含站点、应用、HowTo 与 FAQ 节点', () => {
    for (const type of ['WebSite', 'Organization', 'Person', 'WebApplication', 'HowTo', 'FAQPage']) {
      expect(findNode(homeNodes, type), `缺少 ${type}`).toBeDefined();
    }

    const app = findNode(homeNodes, 'WebApplication');
    expect(app?.url).toBe(`${SITE}/`);
    expect(app?.offers).toMatchObject({ price: '0' });
    expect(Array.isArray(app?.featureList)).toBe(true);
    expect((app?.featureList as unknown[]).length).toBeGreaterThan(5);
  });

  it('HowTo 步骤数与页面步骤一致', () => {
    const howto = findNode(homeNodes, 'HowTo');
    const steps = (howto?.step ?? []) as unknown[];
    expect(steps).toHaveLength((html.match(/<li class="step">/g) ?? []).length);
  });

  it('FAQ 问答与页面可见内容逐条一致', () => {
    const faq = findNode(homeNodes, 'FAQPage');
    const schema = ((faq?.mainEntity ?? []) as Array<{
      name: string;
      acceptedAnswer: { text: string };
    }>).map((item) => ({ question: item.name, answer: item.acceptedAnswer.text }));

    const visible = [...html.matchAll(/<details class="faq-item">([\s\S]*?)<\/details>/gi)].map(
      ([, body]) => ({
        question: text(/<summary>([\s\S]*?)<\/summary>/i.exec(body)?.[1]),
        answer: text(/<p>([\s\S]*?)<\/p>/i.exec(body)?.[1]),
      }),
    );

    expect(visible.length).toBeGreaterThanOrEqual(6);
    expect(schema).toEqual(visible);
  });
});

describe('抓取资产', () => {
  it('sitemap 可解析且只包含正式域名', () => {
    const parsed = new XMLParser().parse(sitemap) as {
      urlset?: { url?: Array<{ loc: string }> | { loc: string } };
    };
    const raw = parsed.urlset?.url ?? [];
    // 只有一个 URL 时 fast-xml-parser 不再返回数组
    const list = Array.isArray(raw) ? raw : [raw];
    expect(list.map((entry) => entry.loc)).toEqual([`${SITE}/`]);
  });

  it('robots 允许主流 AI 爬虫并声明 sitemap', () => {
    expect(robots).toContain('Content-Signal:');
    for (const bot of ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot']) {
      expect(robots).toContain(`User-agent: ${bot}`);
    }
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it('llms.txt 提供可引用的站点摘要', () => {
    expect(llms.startsWith('# BookLoom\n')).toBe(true);
    expect(llms).toContain(`(${SITE}/)`);
    expect(llms).toContain('## 常见问题');
  });

  it('llms.txt 与页面 FAQ 保持同步', () => {
    const items = [
      ...html.matchAll(
        /<details class="faq-item">[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<\/details>/gi,
      ),
    ];
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const match of items) {
      expect(llms).toContain(text(match[1]));
      expect(llms).toContain(text(match[2]));
    }
  });
});
