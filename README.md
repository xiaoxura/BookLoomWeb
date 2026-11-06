# txt2book

把 TXT / DOCX 小说转换成排版体面的 EPUB，也能导出 DOCX / 单文件 HTML / TXT / Markdown —— 纯浏览器本地运行，文件不出设备。

当前版本 **v0.3.0**（2026-11-06），完整变更见 [changelog.html](changelog.html)。

在线版可直接托管到 EdgeOne Markers（或任意静态托管）；转换全部在 Web Worker 里完成，没有后端、没有上传。

## 为什么再做一个

网上现成的 TXT 转换器大多有三个问题：编码识别不准（GBK 当 UTF-8）、章节全靠一条正则、转出来的文件没有目录和封面。txt2book 把重点放在**解析与校对**上：

- 自动识别 UTF-8 / GBK / GB18030 / Big5 / UTF-16，可手动切换
- 章节按「标题形态 + 密度」打分识别，支持卷/章两级、目录页剔除、空行分章兜底
- 解析结果可以在左侧列表里直接改标题、并入上一章、删除，并实时预览
- 点正文任意一段就能「从此分章」或「设为标题」，识别漏了的章节不用改代码
- 章节可一键升为卷 / 降为章，支持搜索章节、输入章号跳转
- 排版可以调行高、段距、缩进、字体、对齐，也能让章号单独一行、追加自己的 CSS
- 应用式布局：页面本身不滚动，章节 / 预览 / 设置各自滚动，页头和页脚常驻
- 可以嵌入 ttf / otf / woff 字体；封面可选竖排书名或 Orly 风格的色块（本地生成，配色由书名决定）
- 封面编辑器：在两种模板上切换配色（原木 / 墨夜 / 深海 / 酒红 / 松林）、标题字号和作者位置，右侧实时预览；参数随草稿保存，导出 JPEG 与预览一致
- 文件名支持知轩藏书格式：`《书名》（校对版全本）作者：远瞳.txt` 会自动拆出书名和作者
- 「第X部分 / 部门 / 部队」不会被误判成卷，完本感言、最终章、英文 Section / Page 都能识别
- 「疑似漏章」诊断：自动找出像标题却没被识别的段落，一键修正
- 全书体检：检查章号缺号 / 重复、空章节、标题重复、异常长短、卷内无章和广告残留，可手动按顺序重编号（保留中文 / 阿拉伯数字风格）
- 通用撤销 / 重做：改标题、分章、合并、删除、升降级、批量替换、重编号都进历史，最多 50 步，键盘和目录面板都能操作
- 批量替换 / 清洗：按标题 / 正文 / 全部范围查找替换，支持正则、区分大小写，先预览命中数和前后文，再执行并自动快照
- 繁简转换：导入时可选「保持原样 / 转为简体 / 转为繁体」，章节标题和正文一起转换；切换后自动重跑，原始文件不动
- 常用快捷键：`↑` / `↓` 或 `J` / `K` 切章、`/` 聚焦搜索、`Ctrl/Cmd+S` 导出、`Ctrl/Cmd+Z` 撤销、`Esc` 关闭浮层
- 书籍元数据：书名 / 作者之外，还能补简介、系列、出版社、标签和出版日期，写进 EPUB 的 `dc:description` / `dc:publisher` / `dc:subject` / `dc:date` 与系列字段（系列仅 EPUB 3）
- 内嵌目录页：EPUB 3 / EPUB 2 都会在封面后生成可点击的 `toc.xhtml`，卷 / 章层级和 nav / NCX 一致；导入时不会把目录页当成章节
- 多草稿书架：每本书的解析结果、原文和嵌入字体分开存进 IndexedDB；书架页可打开、重命名、删除，顶部显示本地占用与可用容量
- 自动恢复上次打开的书；导入新书不会覆盖旧书，旧版单草稿会在首次打开时自动迁移
- 本地草稿：解析结果和所有编辑自动存进 IndexedDB，刷新、关掉标签页都能接着改
- 识别规则可配置：内置爱下电子书、笔趣阁系、数字标题、英文 Chapter 预设，也能手写 JSON 规则并导入导出
- EPUB 导入：按 spine 顺序还原章节，标题和卷/章层级优先取 nav / NCX，没有目录时用正文标题兜底，封面一并带出来
- DOCX 导入：按 Heading 1 / Heading 2（含中文「标题 1 / 2」和大纲级别）还原卷 / 章，普通段落进正文；没有标题样式时整本作为单章并提示；图片与表格暂不导入
- 导出可选 EPUB 3 / EPUB 2 / DOCX / 单文件 HTML / TXT / Markdown；TXT 的标题单独成行，再拖回来还能识别成同样的章节；HTML 样式内联，目录可跳转
- 批量转换：一次拖入多本 TXT / EPUB / DOCX，按选定的格式串行导出成一个 ZIP
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

## 部署到 EdgeOne Markers

1. 把仓库推到 GitHub / GitLab，或把 `dist/` 直接上传。
2. 新建项目：框架选 **Vite**（没有就选「其他」），构建命令 `npm run build`，输出目录 `dist`，Node 版本 20+。
3. 不需要环境变量、不需要函数、不需要数据库，部署完直接访问域名。

仓库里的 `edgeone.json` 已固定构建参数：`npm ci`、`dist`、Node `24.18.0`。EdgeOne 控制台里也能切 Node 版本，选 22.17 以上的都可以；构建前确认项目设置里的 Node 版本与 `edgeone.json` 一致。

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
npm test                 # 全部单测 + 回归语料 + SEO 校验
npm run build
npm run validate         # EPUB 3 结构校验
npm run smoke            # 真实 Chrome 端到端（含批量、草稿、EPUB 2）
```

## SEO / GEO

站点固定使用 `https://txt2book.xiaoxura.com/` 作为 canonical 域名。迁移域名时要同步修改：

- `index.html` / `changelog.html`：`canonical`、`og:url`、`og:image` 与 JSON-LD 里的绝对地址
- `public/robots.txt`、`public/sitemap.xml`、`public/llms.txt`

站内约定：

- 首页唯一 `h1` 是「TXT 转 EPUB」，下面保留「三步把 TXT 转成 EPUB」与「常见问题」两段静态正文；FAQ 的可见问答与 JSON-LD `FAQPage` 逐条对应
- 结构化数据：`WebSite`、`Organization`、`Person`、`WebApplication` / `SoftwareApplication`、`HowTo`、`FAQPage`；更新日志另加 `Article` 与 `BreadcrumbList`
- `robots.txt` 显式放行主流 AI 检索与训练爬虫，并声明 `Content-Signal`；`sitemap.xml` 只列可索引页面；`llms.txt` 给生成式引擎一份可引用的站点摘要
- 分享图 `og.png` 为 1200×630；`npm run build` 会把版本号与构建时间注入 JSON-LD
- `tests/seo.test.ts` 校验 canonical、JSON-LD 可解析、FAQ 与页面一致，以及 sitemap / robots / llms.txt 的地址

新增可索引页面时，记得同时更新 `sitemap.xml`，并把内容写进静态 HTML（不要只靠 JS 渲染）。

## 目录结构

```
src/
├── app/
│   ├── dom.ts         # 工作区元素引用
│   ├── state.ts       # 状态初始值与布局 / 主题 / 导出格式的本地存储
│   ├── render.ts      # 章节列表、预览、设置控件、体检与批量列表渲染
│   ├── events.ts      # DOM 事件绑定
│   ├── export.ts      # EPUB / DOCX / HTML / TXT / Markdown 导出与下载
│   └── shortcuts.ts   # 统一键盘快捷键
├── core/
│   ├── text.ts        # 编码检测、清洗、并段、广告行过滤
│   ├── chapters.ts    # 章节标题打分、卷/章切分、目录页剔除、兜底
│   ├── edit.ts        # 分章 / 设标题 / 合并 / 删除 / 升降级
│   ├── convert.ts     # 繁简转换（opencc-js 词典按需加载）
│   ├── rules.ts       # 站点预设、自定义规则校验与编译
│   ├── draft.ts       # IndexedDB 书架、草稿、原文、字体（v1 → v2 迁移）
│   ├── import/        # 格式探测、EPUB 读取、DOCX 读取
│   ├── export/        # EPUB / DOCX / HTML / TXT / Markdown 写出
│   └── cover.ts       # Canvas 生成竖排封面、上传图裁切
├── worker/
│   ├── pipeline.ts    # 解析与打包都在 Worker 里跑
│   └── protocol.ts
├── types.ts
├── main.ts            # 启动、草稿、Worker 调用与业务动作
├── changelog.ts       # 更新日志页的主题切换
├── notice.ts          # 站内公告：文案与弹窗（TXT / 更新日志页共用）
└── styles.css
tests/                 # vitest：编码、分章、规则、草稿、EPUB、语料压测、SEO
scripts/
├── smoke.mjs          # 真实 Chrome 的端到端测试
├── validate-epub.mjs  # 无 Java 的 EPUB 结构校验
└── make-og.mjs        # 生成分享图 public/og.png
public/
├── robots.txt         # 爬虫规则（含 AI 爬虫白名单与 Content-Signal）
├── sitemap.xml        # 可索引页面
├── llms.txt           # 给生成式引擎的站点摘要
├── manifest.webmanifest
└── sw.js              # 离线缓存
docs/
└── roadmap.md         # 开发计划、优先级、里程碑与不做清单
```

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `↑` / `K` | 上一章 |
| `↓` / `J` | 下一章 |
| `/` | 聚焦章节搜索 |
| `Ctrl/Cmd + Z` | 撤销 |
| `Shift + Ctrl/Cmd + Z`（或 `Ctrl/Cmd + Y`） | 重做 |
| `Ctrl/Cmd + S` | 按当前格式导出 |
| `Esc` | 关闭封面预览、段落选择条和提示 |

输入框、文本域、下拉框聚焦时，单键快捷键不会触发；`Ctrl/Cmd+Z` 在这些控件里保留浏览器原生的文本撤销。

## 转换规则（可预期的部分）

- **编码**：BOM 优先；否则先严格 UTF-8；失败后在 GB18030 / Big5 / UTF-16 之间按「常用汉字命中率」评分选择。
- **段落**：如果超过一半的行带缩进，认为一行就是一段；否则认为是被硬换行的 TXT，按句末标点并回段落（英文之间补空格）。
- **章节**：看点是否像标题——长度、结尾标点、是否匹配「第 X 章 / 卷」「序章 / 番外」「Chapter N / Section N」；再看标题密度是否合理。「第X部分 / 部门 / 部队 / 部件」这类正文词会被排除，不会当成卷。开头的连续标题会被当作目录页整段丢弃。标题里的「第 X 章」和后面的文字如果粘在一起（`第1章我的天呐`），会自动补一个半角空格；原本就有空格或标点分隔的保持原样。
- **EPUB 导入**：按 spine 顺序读 XHTML，标题和层级优先取 EPUB 3 的 nav、其次 NCX；没有目录时用 `h1`–`h3` 兜底。`<br>` 造成硬换行的正文按句末标点并段，正常的 `<p>` 一段就是一段。有 DRM 加密的文件会直接报错，不会导出乱码。
- **DOCX 导入**：解压 `word/document.xml`，把 `Heading 1` / `Heading 2`（本地化的「标题 1 / 2」也认）映射成卷 / 章；如果整本书只用了 Heading 1，则按章节导入避免出现空卷。没有标题样式时整本作为单章并提示；图片、表格、页眉页脚、脚注和自动编号暂不还原。书名 / 作者优先读 `docProps/core.xml`。
- **繁简转换**：使用 `opencc-js`，简体转繁体走台湾标准（`cn → tw`），繁体转简体走通用 `t → cn`；转换只作用于解析出的章节标题和正文，不改原始文件。词典按方向动态加载：转繁体约 440KB gzip，转简体约 51KB gzip，不用转换时不会下载。
- **广告**：只在开启开关时删除短行里的站点水印、网址、「本章未完」之类，长段落不会误伤；选择站点预设后会追加该站点的强特征规则。
- **规则**：`chapter` / `volume` 是整行正则，命中即当作标题；`drop` 是不受行长限制的整行丢弃；`inlineJunk` 用来把粘连在标题前的水印剥掉。规则在 Worker 里编译，非法正则会在应用时直接报错。
- **EPUB**：`mimetype` 是压缩包第一个且不压缩的条目；每章一个 XHTML，单章超过 4 万字自动分文件但只占一个目录项；中文默认 `zh-CN`。EPUB 2 模式会去掉 `nav.xhtml`、`epub:type` 和 `dcterms:modified`，改用 XHTML 1.1 + NCX，包版本写 2.0。两种模式都会在封面之后、正文之前插入 `text/toc.xhtml` 目录页，并在 guide 里登记 `toc` 引用。
- **EPUB 元数据**：简介、出版社、标签和出版日期分别写 `dc:description` / `dc:publisher` / `dc:subject` / `dc:date`；系列在 EPUB 3 用 `belongs-to-collection` + `collection-type=series` 表达，EPUB 2 只保留基础字段。导入 EPUB 时会读取这些字段，calibre 的 `calibre:series` 也能兜底。
- **DOCX 导出**：输出最小 OOXML 包（`document.xml` + `styles.xml` + `[Content_Types].xml` + 关系与 `core.xml`），书名用 Title、卷用 Heading 1、章用 Heading 2，正文段落套用行距 / 缩进 / 对齐设置；不包含封面和插图。
- **HTML 导出**：单文件、CSS 内联、不引用外部资源；正文前生成可点击目录，卷 / 章用 `h1` / `h2`，章节带锚点；不嵌入封面和插图。
- **书架与草稿**：每本书按 `bookId` 分开存草稿、原始文件和嵌入字体；自动保存有 1.2s 防抖并放在空闲时执行。启动自动恢复上次打开的书，点顶栏书架图标可切换 / 重命名 / 删除。旧版只有一本的草稿会在首次打开时自动迁移成书架里的一本。

## 已知限制

- EPUB 导入只取文字和封面，不还原插图、脚注链接和 CSS 排版；带复杂版式的书导进来会变成「标题 + 段落」的朴素结构。
- DOCX 导入依赖 Word 标题样式（或大纲级别）；正文全用「正文」样式、靠手动加粗/字号区分章节的稿子会被当成单章导入。表格、图片、页眉页脚、脚注和自动编号不还原。
- DOCX / HTML 导出目前不包含封面和插图（当前章节模型只有文字）；DOCX 在 Word 里重新分页、字体替换后的效果需要自己确认一遍。
- 封面编辑器只调整自动生成模板的配色 / 字号 / 作者位置，不支持拖拽元素或任意字体；调整参数会把已上传的封面替换成模板封面，需要的话再上传一次。
- 扩展元数据目前只写进 EPUB；DOCX / HTML 导出仍只有书名和作者。系列字段只在 EPUB 3 输出。
- 繁简转换按 OpenCC 的通用词典处理，不做港台用词差异定制；一次转换后再切回原样需要原始文件重新解析，旧草稿没有原文时会提示重新拖入。
- 首次使用某个转换方向需要下载对应词典（约 440KB / 51KB gzip），之后会被 Service Worker 缓存；完全离线且从未用过该方向时会加载失败，联网后再试即可。
- 嵌入字体会让 EPUB 增大（常见中文字体 5–10MB），并且要自己确认字体授权；不加字体时阅读器会用系统字体。
- **MOBI / AZW3 暂不支持**（EPUB 2 兼容模式只能解决老阅读器对 EPUB 3 的挑剔，不能替代 AZW3）。MOBI 需要自己实现 PDB + PalmDOC 容器（还要处理 NCX 索引记录），AZW3 的 KF8 结构更复杂。考虑到亚马逊自 2022 年底起「发送至 Kindle」已不再接受 MOBI、USB 侧载主流是 AZW3，建议先用 EPUB 推送或经 Calibre 转换。
- 暂不支持 PDF（中文字体子集化是硬骨头）。
- 「疑似漏章」和「全书体检」都是启发式扫描：体检可能把番外、特殊编号或本身不连续的原书报成问题；重编号只改「第 X 章 / 回 / 节 / 话」里的数字，并且必须手动点击，执行前会进历史，可撤销。
- 批量替换的正则运行在主线程，已限制查找 200 字 / 替换 500 字，并拦截常见的嵌套量词和「交替分支 + 无限量词」写法；复杂正则仍可能较慢，预览超时会直接取消。
- 撤销历史上限 50 步，并按字符总量做了内存预算；超长书籍会优先丢弃更早的历史，刷新页面后不再保留历史（草稿仍会保存最后状态）。
- 分章只能从段落边界切，不支持在段落内部按字符拆。
- 单文件建议在 20MB 以内；压测 2.4MB / 129 万字 / 1200 章约 0.3 秒完成解析与打包。
- 书架会同时保存每本书的原始文件和解析结果，百万字级别大约 5-10 MB；没有硬性本数上限，容量看浏览器配额，书架顶部会显示占用。浏览器存储被清理时所有书都会丢。
- 旧版本（没有保存原始文件）的草稿恢复后无法换编码，页面会提示从哪里删除，重新拖入 TXT 即可。
- 书架依赖 IndexedDB；无痕模式或浏览器禁用本地存储时只能临时编辑，页面会给出提示。
- EPUB 结构用自研校验脚本验证（`scripts/validate-epub.mjs`），未跑官方 epubcheck（需要 Java）；上架前建议再用 Kindle Previewer 或 Calibre 打开确认一次。

## 开发计划

后续功能的实现要点、优先级、里程碑和「不做清单」都在 [docs/roadmap.md](docs/roadmap.md)。

## 许可

代码以 [MIT](LICENSE) 协议开源，可自由使用、修改、自托管。

繁简转换使用 [opencc-js](https://github.com/nk2028/opencc-js)（MIT AND Apache-2.0），词典数据来自 `opencc-data`（Apache-2.0）。相关许可证全文见 [licenses/opencc-js/](licenses/opencc-js/)。

请只转换你拥有或已获授权的内容；工具本身不提供、不存储任何书籍。
