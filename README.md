# txt2book

把 TXT 小说转换成排版体面的 EPUB 3，纯浏览器本地运行，文件不出设备。

在线版可直接托管到 EdgeOne Pages（或任意静态托管）；转换全部在 Web Worker 里完成，没有后端、没有上传。

## 为什么再做一个

网上现成的 TXT 转换器大多有三个问题：编码识别不准（GBK 当 UTF-8）、章节全靠一条正则、转出来的文件没有目录和封面。txt2book 把重点放在**解析与校对**上：

- 自动识别 UTF-8 / GBK / GB18030 / Big5 / UTF-16，可手动切换
- 章节按「标题形态 + 密度」打分识别，支持卷/章两级、目录页剔除、空行分章兜底
- 解析结果可以在左侧列表里直接改标题、并入上一章、删除，并实时预览
- 点正文任意一段就能「从此分章」或「设为标题」，识别漏了的章节不用改代码
- 章节可一键升为卷 / 降为章，支持搜索章节、输入章号跳转
- 「疑似漏章」诊断：自动找出像标题却没被识别的段落，一键修正
- 本地草稿：解析结果和所有编辑自动存进 IndexedDB，刷新、关掉标签页都能接着改
- 识别规则可配置：内置爱下电子书、笔趣阁系、数字标题、英文 Chapter 预设，也能手写 JSON 规则并导入导出
- 导出可选 EPUB 3 或 EPUB 2（照顾只认老格式的阅读器）
- 批量转换：一次拖入多本 TXT，串行解析打包成一个 ZIP
- 设备导入指南内置在页面里（汉王 / 文石 / 掌阅 / Kobo / Kindle）
- 自动生成竖排书名封面，也可以上传自己的图
- 导出标准 EPUB 3（含 nav + NCX 双目录），Kindle / 文石 / 掌阅 / Kobo / 微信读书都能读

## 设备导入

| 设备 | 做法 |
|---|---|
| 汉王 / 文石 / 掌阅 / 墨案 | USB 连接电脑，把 `.epub` 复制到 Books 或「文档」目录，断连后刷新书架 |
| Kobo | 把 `.epub` 放到根目录，弹出设备时自动扫描 |
| Kindle（新款） | 用「发送至 Kindle」网页或邮箱推送 `.epub`，亚马逊会自动转码 |
| Kindle（老款 USB） | 先用 Calibre 把 EPUB 转成 AZW3，再拷进 `documents` |

排版或目录异常时，优先试一次 **EPUB 2** 导出。

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 单元测试 + 大文件压测（会生成 samples/demo.epub）
npm run build      # 产物在 dist/
npm run validate   # 校验 samples/demo.epub 的结构
```

浏览器端到端冒烟测试（需要本机有 Chrome）：

```bash
npm run build
npx vite preview --port 4173 &
npm run smoke      # 载入示例 → 导出 → 解包校验，截图写到 samples/
```

## 部署到 EdgeOne Pages

1. 把仓库推到 GitHub / GitLab，或把 `dist/` 直接上传。
2. 新建项目：框架选 **Vite**（没有就选「其他」），构建命令 `npm run build`，输出目录 `dist`，Node 版本 20+。
3. 不需要环境变量、不需要函数、不需要数据库，部署完直接访问域名。

仓库里的 `edgeone.json` 已固定构建参数：`npm ci`、`dist`、Node `22.11.0`（EdgeOne 预装版本）。Vite 锁在 6.x，就是为了兼容这个 Node 版本；不要把 Vite 升到 8，否则要求 Node 22.12+，EdgeOne 上会构建失败。

项目是纯静态的，不调用任何外部接口。`public/sw.js` 会在生产环境注册 Service Worker，第二次打开可离线使用（需要 HTTPS）。

> 如果部署在子路径而不是域名根目录，需要把 `vite.config.ts` 的 `base` 改成对应路径，并同步修改 `manifest.webmanifest`、`sw.js` 里的 `/`。

### 自托管

```bash
npm ci
npm run build
# 把 dist/ 交给任意静态服务器，例如：
npx serve dist
```

Service Worker 只在 HTTPS 或 localhost 下生效；其余功能与域名无关。

### 发布前自检

```bash
npm test                 # 39 项单测 + 回归语料
npm run build
npm run validate         # EPUB 3 结构校验
npm run smoke            # 真实 Chrome 端到端（含批量、草稿、EPUB 2）
```

## 目录结构

```
src/
├── core/
│   ├── text.ts        # 编码检测、清洗、并段、广告行过滤
│   ├── chapters.ts    # 章节标题打分、卷/章切分、目录页剔除、兜底
│   ├── edit.ts        # 分章 / 设标题 / 合并 / 删除 / 升降级
│   ├── rules.ts       # 站点预设、自定义规则校验与编译
│   ├── draft.ts       # IndexedDB 本地草稿
│   ├── epub.ts        # OPF / nav / NCX / XHTML / CSS 生成与 ZIP 打包
│   └── cover.ts       # Canvas 生成竖排封面、上传图裁切
├── worker/
│   ├── pipeline.ts    # 解析与打包都在 Worker 里跑
│   └── protocol.ts
├── types.ts
├── main.ts            # UI 与状态
└── styles.css
tests/                 # vitest：编码、分章、规则、草稿、EPUB、语料压测
scripts/
├── smoke.mjs          # 真实 Chrome 的端到端测试
├── validate-epub.mjs  # 无 Java 的 EPUB 结构校验
└── make-og.mjs        # 生成分享图 public/og.png
```

## 转换规则（可预期的部分）

- **编码**：BOM 优先；否则先严格 UTF-8；失败后在 GB18030 / Big5 / UTF-16 之间按「常用汉字命中率」评分选择。
- **段落**：如果超过一半的行带缩进，认为一行就是一段；否则认为是被硬换行的 TXT，按句末标点并回段落（英文之间补空格）。
- **章节**：看点是否像标题——长度、结尾标点、是否匹配「第 X 章 / 卷」「序章 / 番外」「Chapter N」；再看标题密度是否合理。开头的连续标题会被当作目录页整段丢弃。
- **广告**：只在开启开关时删除短行里的站点水印、网址、「本章未完」之类，长段落不会误伤；选择站点预设后会追加该站点的强特征规则。
- **规则**：`chapter` / `volume` 是整行正则，命中即当作标题；`drop` 是不受行长限制的整行丢弃；`inlineJunk` 用来把粘连在标题前的水印剥掉。规则在 Worker 里编译，非法正则会在应用时直接报错。
- **EPUB**：`mimetype` 是压缩包第一个且不压缩的条目；每章一个 XHTML，单章超过 4 万字自动分文件但只占一个目录项；中文默认 `zh-CN`。EPUB 2 模式会去掉 `nav.xhtml`、`epub:type` 和 `dcterms:modified`，改用 XHTML 1.1 + NCX，包版本写 2.0。
- **草稿**：只保留最近一本，自动保存有 1.2s 防抖并放在空闲时执行；原始 TXT 会单独存一份，刷新后仍可切换编码、重新识别。上传新书会覆盖旧草稿，也可以手动清除。

## 已知限制

- **MOBI / AZW3 暂不支持**（EPUB 2 兼容模式只能解决老阅读器对 EPUB 3 的挑剔，不能替代 AZW3）。MOBI 需要自己实现 PDB + PalmDOC 容器（还要处理 NCX 索引记录），AZW3 的 KF8 结构更复杂。考虑到亚马逊自 2022 年底起「发送至 Kindle」已不再接受 MOBI、USB 侧载主流是 AZW3，建议先用 EPUB 推送或经 Calibre 转换。
- 暂不支持 PDF（中文字体子集化是硬骨头）。
- 「疑似漏章」是启发式扫描，可能把正文里提到「第 X 章」的句子也列出来，忽略即可。
- 分章只能从段落边界切，不支持在段落内部按字符拆。
- 单文件建议在 20MB 以内；压测 2.4MB / 129 万字 / 1200 章约 0.3 秒完成解析与打包。
- 草稿会同时保存原始 TXT 和解析结果，百万字级别大约 5-10 MB；浏览器存储被清理时会丢。
- 旧版本（没有保存原始文件）的草稿恢复后无法换编码，页面会提示一键清除，重新拖入 TXT 即可。
- EPUB 结构用自研校验脚本验证（`scripts/validate-epub.mjs`），未跑官方 epubcheck（需要 Java）；上架前建议再用 Kindle Previewer 或 Calibre 打开确认一次。

## 许可

代码以 [MIT](LICENSE) 协议开源，可自由使用、修改、自托管。

请只转换你拥有或已获授权的内容；工具本身不提供、不存储任何书籍。
