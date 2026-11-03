import './styles.css';
import { findHeadingCandidates, guessTitle, type HeadingCandidate } from './core/chapters';
import { coverFromImage, generateCover } from './core/cover';
import {
  clearDraft,
  clearSource,
  deriveIdSeed,
  loadDraft,
  loadSource,
  saveDraft,
  sourceMatchesDraft,
  type DraftData,
} from './core/draft';
import { compileRules, getPreset, validateRuleSpec, type RuleSpec } from './core/rules';
import {
  mergeChapterUp,
  removeChapterAt,
  splitChapterAt,
  suggestChapterTitle,
  toggleChapterLevel,
} from './core/edit';
import type { BookMeta, Chapter, CoverData, LayoutOptions, ParseResult } from './types';
import { WorkerClient, type RequestPayload, type WorkerPort } from './worker/client';
import type { FromWorker } from './worker/protocol';

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`缺少元素 ${selector}`);
  return node as unknown as T;
};

const els = {
  dropZone: $('#drop-zone'),
  fileInput: $('#file-input') as HTMLInputElement,
  pickFile: $('#pick-file') as HTMLButtonElement,
  loadSample: $('#load-sample') as HTMLButtonElement,
  dropLoading: $('#drop-loading'),
  dropLoadingPhase: $('#drop-loading-phase'),
  appProgress: $('#app-progress'),
  themeToggle: $('#theme-toggle') as HTMLButtonElement,
  workspace: $('#workspace'),
  mobileTabs: $('#mobile-tabs'),
  guide: $('#guide'),
  privacy: $('#privacy'),
  batch: $('#batch'),
  batchList: $('#batch-list'),
  batchSummary: $('#batch-summary'),
  batchStatus: $('#batch-status'),
  batchClose: $('#batch-close') as HTMLButtonElement,
  batchDownload: $('#batch-download') as HTMLButtonElement,
  changeFile: $('#change-file'),
  stats: $('#stats'),
  warnings: $('#warnings'),
  chapterList: $('#chapter-list'),
  chapterSearch: $('#chapter-search') as HTMLInputElement,
  diagnostics: $('#diagnostics'),
  diagToggle: $('#diag-toggle') as HTMLButtonElement,
  diagSummary: $('#diag-summary'),
  diagCaret: $('#diag-caret'),
  diagList: $('#diag-list'),
  diagDismiss: $('#diag-dismiss') as HTMLButtonElement,
  preview: $('#preview'),
  previewScroll: $('#preview-scroll'),
  previewMeta: $('#preview-meta'),
  prevChapter: $('#prev-chapter') as HTMLButtonElement,
  nextChapter: $('#next-chapter') as HTMLButtonElement,
  chapterPosition: $('#chapter-position'),
  selectionBar: $('#selection-bar'),
  selectionIndex: $('#selection-index'),
  metaTitle: $('#meta-title') as HTMLInputElement,
  metaAuthor: $('#meta-author') as HTMLInputElement,
  coverThumb: $('#cover-thumb') as HTMLButtonElement,
  coverUpload: $('#cover-upload'),
  coverAuto: $('#cover-auto'),
  coverRemove: $('#cover-remove') as HTMLButtonElement,
  coverInput: $('#cover-input') as HTMLInputElement,
  coverView: $('#cover-view'),
  coverViewClose: $('#cover-view-close') as HTMLButtonElement,
  coverViewImg: $('#cover-view-img') as HTMLImageElement,
  encoding: $('#encoding') as HTMLSelectElement,
  filterAds: $('#filter-ads') as HTMLInputElement,
  rulePreset: $('#rule-preset') as HTMLSelectElement,
  ruleDetails: $('#rule-details') as HTMLDetailsElement,
  ruleJson: $('#rule-json') as HTMLTextAreaElement,
  ruleApply: $('#rule-apply') as HTMLButtonElement,
  ruleExport: $('#rule-export') as HTMLButtonElement,
  ruleImport: $('#rule-import') as HTMLButtonElement,
  ruleFile: $('#rule-file') as HTMLInputElement,
  ruleError: $('#rule-error'),
  reparse: $('#reparse') as HTMLButtonElement,
  font: $('#font') as HTMLSelectElement,
  lineHeight: $('#line-height') as HTMLInputElement,
  lineHeightVal: $('#line-height-val'),
  paraGap: $('#para-gap') as HTMLInputElement,
  paraGapVal: $('#para-gap-val'),
  indent: $('#indent') as HTMLInputElement,
  justify: $('#justify') as HTMLInputElement,
  export: $('#export') as HTMLButtonElement,
  exportHint: $('#export-hint'),
  epubVersion: $('#epub-version') as HTMLSelectElement,
  status: $('#status'),
  draftStatus: $('#draft-status'),
  clearDraft: $('#clear-draft') as HTMLButtonElement,
  toast: $('#toast'),
};

const DEFAULT_LAYOUT: LayoutOptions = {
  lineHeight: 1.75,
  indent: true,
  paragraphSpacing: 0,
  font: 'serif',
  justify: true,
};

const LAYOUT_KEY = 'txt2book.layout.v1';
const EPUB_VERSION_KEY = 'txt2book.epubVersion';
const THEME_KEY = 'txt2book.theme';

type ThemeMode = 'light' | 'dark';
type MobileView = 'chapters' | 'preview' | 'settings';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const mobileQuery = window.matchMedia('(max-width: 760px)');

function isMobileViewport(): boolean {
  return mobileQuery.matches;
}

function loadTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* 隐私模式下可能读取失败 */
  }
  return document.documentElement.dataset.theme === 'dark' || darkQuery.matches ? 'dark' : 'light';
}

let themeMode: ThemeMode = loadTheme();
let mobileView: MobileView = (els.workspace.dataset.mobileView as MobileView | undefined) ?? 'chapters';

function applyTheme(mode: ThemeMode, persist = true): void {
  themeMode = mode;
  const dark = mode === 'dark';
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;

  const label = dark ? '切换到浅色主题' : '切换到深色主题';
  els.themeToggle.title = label;
  els.themeToggle.setAttribute('aria-label', label);
  els.themeToggle.setAttribute('aria-pressed', String(dark));

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#17150f' : '#f4efe4';

  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* 忽略存储失败 */
    }
  }
}

function toggleTheme(): void {
  applyTheme(themeMode === 'dark' ? 'light' : 'dark');
}

function setMobileView(view: MobileView, scroll = false): void {
  mobileView = view;
  els.workspace.dataset.mobileView = view;
  els.mobileTabs.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  });
  if (!scroll) return;
  requestAnimationFrame(() => {
    els.workspace.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

interface BatchItem {
  file: File;
  title: string;
  status: 'waiting' | 'parsing' | 'packing' | 'done' | 'error';
  chapters?: number;
  message?: string;
  data?: Uint8Array;
}

interface State {
  parsed: ParseResult | null;
  chapters: Chapter[];
  activeId: string | null;
  meta: BookMeta;
  layout: LayoutOptions;
  cover: CoverData | null;
  coverAuto: boolean;
  coverUrl: string | null;
  busy: boolean;
  filter: string;
  selectedParagraph: number | null;
  diagnostics: HeadingCandidate[];
  diagDismissed: boolean;
  diagOpen: boolean;
  idSeed: number;
  filename: string;
  rules: RuleSpec | null;
  rulePreset: string;
  epubVersion: 2 | 3;
  batchItems: BatchItem[];
  batchRunning: boolean;
  batchCancelled: boolean;
  sourceReady: boolean;
  /** 当前草稿关联的原始 TXT id，旧草稿为 null */
  sourceId: string | null;
}

const state: State = {
  parsed: null,
  chapters: [],
  activeId: null,
  meta: { title: '', author: '', language: 'zh-CN' },
  layout: loadLayout(),
  cover: null,
  coverAuto: true,
  coverUrl: null,
  busy: false,
  filter: '',
  selectedParagraph: null,
  diagnostics: [],
  diagDismissed: false,
  diagOpen: true,
  idSeed: 0,
  filename: '',
  rules: null,
  rulePreset: 'auto',
  epubVersion: loadEpubVersion(),
  batchItems: [],
  batchRunning: false,
  batchCancelled: false,
  sourceReady: false,
  sourceId: null,
};

function loadLayout(): LayoutOptions {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<LayoutOptions>) };
  } catch {
    /* 忽略损坏的本地配置 */
  }
  return { ...DEFAULT_LAYOUT };
}

function loadEpubVersion(): 2 | 3 {
  try {
    return localStorage.getItem(EPUB_VERSION_KEY) === '2' ? 2 : 3;
  } catch {
    return 3;
  }
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout));
  } catch {
    /* 隐私模式下可能写入失败 */
  }
}

/* ---------------- Worker ---------------- */

/** 每次加载新文件/批量开始时 +1；草稿恢复看到代次变化就放弃，避免覆盖新内容 */
let loadEpoch = 0;

const workerClient = new WorkerClient(
  () =>
    new Worker(new URL('./worker/pipeline.ts', import.meta.url), {
      type: 'module',
    }) as unknown as WorkerPort,
  {
    onProgress: (phase) => {
      setStatus(phase);
      if (dropLoading) els.dropLoadingPhase.textContent = phase;
    },
    onError: (error) => {
      // Worker 被重置后内存里的原文也没了，禁用重新识别，避免误以为还能用
      state.sourceReady = false;
      setStatus(`后台线程出错：${error.message}`, 'error');
      updateControls();
      toast('后台线程已重置，请重试；重新识别需要重新拖入 TXT');
    },
  },
);

function call(payload: RequestPayload, transfer: Transferable[] = []): Promise<FromWorker> {
  return workerClient.call(payload, transfer);
}

/* ---------------- 状态与渲染 ---------------- */

function activeChapter(): Chapter | null {
  return state.chapters.find((chapter) => chapter.id === state.activeId) ?? null;
}

function totalChars(): number {
  let total = 0;
  for (const chapter of state.chapters) {
    for (const paragraph of chapter.paragraphs) total += paragraph.length;
  }
  return total;
}

function renderStats() {
  if (!state.parsed) {
    els.stats.textContent = '—';
    return;
  }
  const encoding = (state.parsed.encoding || 'utf-8').toUpperCase();
  els.stats.textContent = `${state.chapters.length} 章 · ${totalChars().toLocaleString('zh-CN')} 字 · ${encoding}`;
}

function renderWarnings(warnings: string[]) {
  els.warnings.innerHTML = '';
  if (!warnings.length) {
    els.warnings.hidden = true;
    return;
  }
  for (const warning of warnings) {
    const p = document.createElement('p');
    p.textContent = warning;
    els.warnings.appendChild(p);
  }
  els.warnings.hidden = false;
}

function isFrontTitle(title: string): boolean {
  return /^(?:内容简介|作品简介|简介|序章|序言|序|楔子|引子|前言|引言)$/.test(title.trim());
}

function renderList() {
  const fragment = document.createDocumentFragment();
  const query = state.filter.trim().toLowerCase();
  const numeric = /^\d+$/.test(query) ? Number(query) : null;
  let chapterNo = 0;
  let shown = 0;

  state.chapters.forEach((chapter, index) => {
    const unnumbered = chapter.level === 2 && isFrontTitle(chapter.title);
    if (chapter.level === 2 && !unnumbered) chapterNo += 1;
    if (query) {
      const inTitle = chapter.title.toLowerCase().includes(query);
      const byNumber = numeric !== null && chapter.level === 2 && chapterNo === numeric;
      if (!inTitle && !byNumber) return;
    }
    shown += 1;
    const row = document.createElement('div');
    row.className =
      'chapter-row' +
      (chapter.level === 1 ? ' volume' : '') +
      (chapter.id === state.activeId ? ' active' : '');
    row.dataset.id = chapter.id;
    row.dataset.index = String(index);
    row.setAttribute('role', 'listitem');

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = chapter.level === 1 ? '卷' : unnumbered ? '序' : String(chapterNo);

    const input = document.createElement('input');
    input.className = 'ch-title';
    input.value = chapter.title;
    input.readOnly = true;
    input.title = '点击选中章节，再点一次改标题';
    input.setAttribute('aria-label', `章节标题：${chapter.title}`);
    input.spellcheck = false;

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.dataset.act = 'rename';
    rename.title = '重命名标题';
    rename.textContent = '✎';

    const level = document.createElement('button');
    level.type = 'button';
    level.dataset.act = 'level';
    level.title = chapter.level === 1 ? '降为普通章节' : '升为卷';
    level.textContent = chapter.level === 1 ? '降章' : '升卷';

    const merge = document.createElement('button');
    merge.type = 'button';
    merge.dataset.act = 'merge';
    merge.disabled = index === 0;
    merge.title = index === 0 ? '已经是第一章，不能并入上一章' : '并入上一章';
    merge.textContent = '↑';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.act = 'delete';
    remove.disabled = state.chapters.length <= 1;
    remove.title = state.chapters.length <= 1 ? '至少保留一章' : '删除本章';
    remove.className = 'danger';
    remove.textContent = '×';

    actions.append(rename, level, merge, remove);
    row.append(idx, input, actions);
    fragment.appendChild(row);
  });

  if (!shown) {
    const empty = document.createElement('p');
    empty.className = 'list-empty';
    empty.textContent = query ? '没有匹配的章节' : '还没有章节';
    fragment.appendChild(empty);
  }
  els.chapterList.replaceChildren(fragment);
}

function applyLayoutToPreview() {
  const { layout } = state;
  const fontStack =
    layout.font === 'sans'
      ? `"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`
      : layout.font === 'kai'
        ? `"Kaiti SC", "KaiTi", "STKaiti", "Noto Serif CJK SC", serif`
        : `"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif`;
  els.preview.style.setProperty('--p-font', fontStack);
  els.preview.style.setProperty('--p-lh', String(layout.lineHeight));
  els.preview.style.setProperty('--p-gap', `${layout.paragraphSpacing}em`);
  els.preview.style.setProperty('--p-indent', layout.indent ? '2em' : '0');
  els.preview.style.setProperty('--p-align', layout.justify ? 'justify' : 'left');
}

function renderPreview() {
  const chapter = activeChapter();
  els.preview.replaceChildren();
  applyLayoutToPreview();
  updateChapterNav();

  if (!chapter) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '选择左侧章节开始预览';
    els.preview.appendChild(p);
    els.previewMeta.textContent = '';
    els.previewScroll.scrollTop = 0;
    updateSelectionBar();
    return;
  }

  const heading = document.createElement(chapter.level === 1 ? 'h1' : 'h2');
  heading.textContent = chapter.title;
  els.preview.appendChild(heading);

  if (!chapter.paragraphs.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = chapter.level === 1 ? '（卷标题，正文在下一章）' : '（本章没有正文）';
    els.preview.appendChild(p);
  } else {
    const MAX_PREVIEW_CHARS = 120000;
    const MAX_PARAGRAPH_PREVIEW = 20000;
    let budget = MAX_PREVIEW_CHARS;
    let truncated = false;

    for (let index = 0; index < chapter.paragraphs.length; index += 1) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const text = chapter.paragraphs[index];
      const take = Math.min(text.length, budget, MAX_PARAGRAPH_PREVIEW);
      const p = document.createElement('p');
      p.dataset.index = String(index);
      p.title = '点击选中这一段，可从这里分章';
      p.textContent = take < text.length ? `${text.slice(0, take)}…` : text;
      if (take < text.length) truncated = true;
      budget -= take;
      els.preview.appendChild(p);
    }

    if (truncated) {
      const note = document.createElement('p');
      note.className = 'empty';
      note.textContent = '本章过长，预览只显示前 12 万字；导出的是完整内容。';
      els.preview.appendChild(note);
    }
  }

  const chars = chapter.paragraphs.reduce((n, p) => n + p.length, 0);
  els.previewMeta.textContent = `${chapter.paragraphs.length} 段 · ${chars.toLocaleString('zh-CN')} 字 · 点段落可拆分`;
  els.previewScroll.scrollTop = 0;
  updateSelectionBar();
}

function updateChapterNav() {
  const index = state.chapters.findIndex((chapter) => chapter.id === state.activeId);
  const total = state.chapters.length;
  els.prevChapter.disabled = index <= 0;
  els.nextChapter.disabled = index < 0 || index >= total - 1;
  els.chapterPosition.textContent = index >= 0 && total ? `${index + 1} / ${total}` : '—';
  els.chapterPosition.title = '当前章节在目录中的位置';
}

function stepChapter(delta: -1 | 1) {
  const index = state.chapters.findIndex((chapter) => chapter.id === state.activeId);
  if (index < 0) return;
  const next = state.chapters[index + delta];
  if (!next) return;
  setActive(next.id);
  if (isMobileViewport()) return;
  requestAnimationFrame(() => {
    const row = Array.from(els.chapterList.querySelectorAll<HTMLElement>('.chapter-row')).find(
      (item) => item.dataset.id === next.id,
    );
    row?.scrollIntoView({ block: 'nearest' });
  });
}

/* ---------------- 段落选择 / 诊断 ---------------- */

function updateSelectionBar() {
  const chapter = activeChapter();
  const index = state.selectedParagraph;
  const valid = !!chapter && index !== null && index >= 0 && index < chapter.paragraphs.length;
  els.selectionBar.hidden = !valid;
  if (!valid || index === null) return;

  els.selectionIndex.textContent = String(index + 1);
  const splitButton = els.selectionBar.querySelector<HTMLButtonElement>('[data-act="split"]');
  if (splitButton) {
    splitButton.disabled = index === 0;
    splitButton.title =
      index === 0 ? '这是本章第一段，没法再往上拆' : '截断本章，从这一段开始新的一章';
  }
  const titleButton = els.selectionBar.querySelector<HTMLButtonElement>('[data-act="title"]');
  if (titleButton) {
    titleButton.title =
      index === 0 ? '用这一段替换本章标题' : '把这一段作为新章节标题，正文从下一段开始';
  }
}

function selectParagraph(index: number | null, scroll = false) {
  state.selectedParagraph = index;
  els.preview.querySelectorAll<HTMLElement>('p[data-index]').forEach((paragraph) => {
    const on = index !== null && Number(paragraph.dataset.index) === index;
    paragraph.classList.toggle('selected', on);
    if (on && scroll) paragraph.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  updateSelectionBar();
}

let diagToken = 0;

function recomputeDiagnostics() {
  const token = ++diagToken;
  const run = () => {
    if (token !== diagToken) return;
    state.diagnostics = findHeadingCandidates(state.chapters, compileRules(state.rules));
    renderDiagnostics();
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 800 });
  } else {
    window.setTimeout(run, 0);
  }
}

function renderDiagnostics() {
  const items = state.diagnostics;
  const visible = items.length > 0 && !state.diagDismissed;
  els.diagnostics.hidden = !visible;
  if (!visible) return;

  els.diagSummary.textContent = `发现 ${items.length} 处疑似漏章`;
  els.diagList.hidden = !state.diagOpen;
  els.diagCaret.textContent = state.diagOpen ? '收起' : '展开';

  const max = 30;
  els.diagList.replaceChildren();
  items.slice(0, max).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'diag-item';

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'diag-text';
    label.dataset.role = 'locate';
    label.dataset.chapterIndex = String(item.chapterIndex);
    label.dataset.paragraphIndex = String(item.paragraphIndex);
    label.title = `「${item.chapterTitle}」第 ${item.paragraphIndex + 1} 段，点击定位`;

    const candidate = document.createElement('span');
    candidate.className = 'diag-cand';
    candidate.textContent = item.text;

    const source = document.createElement('span');
    source.className = 'diag-src';
    source.textContent = `来自「${item.chapterTitle}」第 ${item.paragraphIndex + 1} 段`;

    label.append(candidate, source);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'diag-action';
    action.dataset.role = 'title';
    action.dataset.chapterIndex = String(item.chapterIndex);
    action.dataset.paragraphIndex = String(item.paragraphIndex);
    if (item.paragraphIndex === 0) {
      action.title = '用这一段替换本章标题';
      action.textContent = '设为标题';
    } else {
      action.title = '以此段作为新章节标题，从此处拆出一章';
      action.textContent = '拆为新章';
    }

    row.append(label, action);
    els.diagList.appendChild(row);
  });

  if (items.length > max) {
    const more = document.createElement('p');
    more.className = 'diag-more';
    more.textContent = `还有 ${items.length - max} 处，建议先手动拆分`;
    els.diagList.appendChild(more);
  }
}

function openCoverView() {
  if (!state.coverUrl) return;
  els.coverViewImg.src = state.coverUrl;
  els.coverView.hidden = false;
  document.body.style.overflow = 'hidden';
  els.coverViewClose.focus();
}

function closeCoverView(restoreFocus = false) {
  if (els.coverView.hidden) return;
  els.coverView.hidden = true;
  document.body.style.overflow = '';
  if (restoreFocus) els.coverThumb.focus();
}

function renderCover() {
  closeCoverView();
  if (state.coverUrl) {
    URL.revokeObjectURL(state.coverUrl);
    state.coverUrl = null;
  }
  els.coverThumb.replaceChildren();
  els.coverRemove.hidden = !state.cover;
  els.coverThumb.title = state.cover ? '点击查看封面大图' : '点击上传封面';
  els.coverThumb.setAttribute('aria-label', state.cover ? '查看封面大图' : '上传封面');
  if (!state.cover) {
    const span = document.createElement('span');
    span.textContent = '无封面';
    els.coverThumb.appendChild(span);
    return;
  }
  const blob = new Blob([toArrayBuffer(state.cover.data)], { type: state.cover.mime });
  state.coverUrl = URL.createObjectURL(blob);
  const img = document.createElement('img');
  img.src = state.coverUrl;
  img.alt = '封面预览';
  els.coverThumb.appendChild(img);
}

function renderAll() {
  renderStats();
  renderList();
  renderPreview();
  renderCover();
  updateControls();
}

function updateControls() {
  els.metaTitle.value = state.meta.title;
  els.metaAuthor.value = state.meta.author;
  els.export.disabled = state.busy || !state.chapters.length;
  els.reparse.disabled = state.busy || !state.parsed || !state.sourceReady;
  els.reparse.title = state.sourceReady ? '' : '恢复的草稿没有原始文件';
  els.encoding.disabled = !state.sourceReady;
  els.lineHeight.value = String(state.layout.lineHeight);
  els.lineHeightVal.textContent = state.layout.lineHeight.toFixed(2);
  els.paraGap.value = String(state.layout.paragraphSpacing);
  els.paraGapVal.textContent = state.layout.paragraphSpacing.toFixed(1);
  els.indent.checked = state.layout.indent;
  els.justify.checked = state.layout.justify;
  els.font.value = state.layout.font;
  els.epubVersion.value = String(state.epubVersion);
  paintRange(els.lineHeight);
  paintRange(els.paraGap);
  updateExportHint();
}

function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || 0);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--range-pct', `${Math.max(0, Math.min(100, pct))}%`);
}

function updateExportHint(): void {
  els.exportHint.textContent =
    state.epubVersion === 2
      ? 'EPUB 2 · 兼容老设备（无 EPUB 3 导航页）'
      : 'EPUB 3 · 含封面与目录，Kindle 可推送';
}

function setStatus(message: string, kind: 'normal' | 'error' = 'normal') {
  els.status.textContent = message;
  els.status.classList.toggle('error', kind === 'error');
}

let dropLoading = false;

function setDropLoading(active: boolean, phase?: string): void {
  dropLoading = active;
  els.dropZone.classList.toggle('is-loading', active);
  els.dropZone.setAttribute('aria-busy', active ? 'true' : 'false');
  els.dropLoading.hidden = !active;
  els.appProgress.hidden = !active;
  els.pickFile.disabled = active;
  els.loadSample.disabled = active;
  if (phase) els.dropLoadingPhase.textContent = phase;
}

/* ---------------- 提示 ---------------- */

let toastTimer = 0;
let searchTimer = 0;

function hideToast() {
  els.toast.hidden = true;
}

function toast(message: string, action?: { label: string; onClick: () => void }) {
  els.toast.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  els.toast.appendChild(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.onClick();
      hideToast();
    });
    els.toast.appendChild(button);
  }
  els.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, action ? 6000 : 3200);
}

/* ---------------- 解析 ---------------- */

function parseOptions() {
  return { encoding: els.encoding.value, filterAds: els.filterAds.checked, rules: state.rules };
}

function normalizeEncodingOption(encoding: string): string {
  const normalized = encoding.toLowerCase();
  if (normalized === 'gbk' || normalized === 'gb2312') return 'gb18030';
  if (normalized === 'utf8') return 'utf-8';
  const known = Array.from(els.encoding.options).map((option) => option.value);
  return known.includes(normalized) ? normalized : 'auto';
}

function showWorkspace() {
  els.workspace.hidden = false;
  els.dropZone.hidden = true;
  els.guide.hidden = true;
  els.privacy.hidden = true;
  els.batch.hidden = true;
  setMobileView('preview');
}

function setActive(id: string | null) {
  state.activeId = id;
  state.selectedParagraph = null;
  document.querySelectorAll<HTMLElement>('.chapter-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.id === id);
  });
  renderPreview();
  if (id && isMobileViewport() && mobileView !== 'preview') setMobileView('preview', true);
}

function applyResult(result: ParseResult) {
  state.sourceReady = true;
  state.parsed = result;
  state.chapters = result.chapters;
  state.activeId = result.chapters.find((chapter) => chapter.paragraphs.length)?.id ?? result.chapters[0]?.id ?? null;
  state.filter = '';
  state.selectedParagraph = null;
  state.diagDismissed = false;
  state.diagOpen = true;
  state.idSeed = 0;
  els.chapterSearch.value = '';
  els.chapterSearch.hidden = false;
  els.encoding.value = normalizeEncodingOption(result.encoding);
  if (!state.meta.author) state.meta.author = result.authorGuess;
  renderWarnings(result.warnings);
  recomputeDiagnostics();
  renderAll();
  setStatus(`识别完成 · ${result.chapters.length} 章`);
  scheduleDraftSave(300);
  if (!state.cover) scheduleAutoCover();
}

async function loadFile(file: File) {
  if (state.busy) {
    toast('正在处理，请稍候');
    return;
  }
  if (file.size > 80 * 1024 * 1024) {
    const message = '文件超过 80MB，浏览器内存可能不够';
    setStatus(message, 'error');
    toast(message);
    return;
  }

  const epoch = ++loadEpoch;
  state.busy = true;
  els.export.disabled = true;
  els.reparse.disabled = true;
  // 新书默认重新自动检测，不能沿用上一本手动选的编码
  els.encoding.value = 'auto';
  setStatus('正在读取文件…');
  setDropLoading(true, `正在读取「${file.name}」…`);

  try {
    const buffer = await file.arrayBuffer();
    const res = await call(
      { type: 'parse', buffer, filename: file.name, options: parseOptions() },
      [buffer],
    );
    if (res.type !== 'parsed' || epoch !== loadEpoch) return;

    // 换书成功后再取消旧的自动保存，解析失败时旧书的待保存内容不受影响
    cancelScheduledDraftSave();
    const sessionEpoch = draftEpoch;
    state.sourceId = createSourceId();
    state.filename = file.name;
    state.meta.title = guessTitle(file.name);
    state.meta.author = '';
    state.cover = null;
    state.coverAuto = true;
    showWorkspace();
    window.scrollTo(0, 0);
    applyResult(res.result);
    void persistSourceWithDraft(file, epoch, sessionEpoch);
  } catch (error) {
    const message = error instanceof Error ? error.message : '解析失败';
    setStatus(message, 'error');
    toast(`解析失败：${message}`);
  } finally {
    setDropLoading(false);
    state.busy = false;
    updateControls();
  }
}

async function reparse() {
  if (!state.parsed || state.busy) return;
  if (!state.sourceReady) {
    toast('草稿没有可用的原始文件，重新拖入 TXT 后才能换编码或重新识别');
    return;
  }
  state.busy = true;
  updateControls();
  setStatus('正在重新识别…');
  try {
    const res = await call({ type: 'reparse', options: parseOptions() });
    if (res.type === 'parsed') {
      applyResult(res.result);
      toast('已按新的设置重新识别，手动改过的标题会被覆盖');
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '重新识别失败', 'error');
  } finally {
    state.busy = false;
    updateControls();
  }
}

/* ---------------- 封面 ---------------- */

let coverTimer = 0;

function scheduleAutoCover() {
  if (!state.coverAuto) return;
  window.clearTimeout(coverTimer);
  coverTimer = window.setTimeout(async () => {
    if (!state.coverAuto) return;
    try {
      state.cover = await generateCover(state.meta.title || '未命名', state.meta.author || '佚名');
      renderCover();
    } catch {
      /* 封面生成失败不阻塞导出 */
    }
  }, 450);
}

/* ---------------- 导出 ---------------- */

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned || '未命名';
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportEpub() {
  if (!state.chapters.length || state.busy) return;
  state.busy = true;
  updateControls();
  setStatus('正在生成 EPUB…');

  try {
    const res = await call({
      type: 'pack',
      chapters: state.chapters,
      meta: state.meta,
      layout: state.layout,
      cover: state.cover,
      version: state.epubVersion,
    });
    if (res.type !== 'packed') return;

    const blob = new Blob([toArrayBuffer(res.data)], { type: 'application/epub+zip' });
    download(blob, `${sanitizeFilename(state.meta.title)}.epub`);
    setStatus(`已导出 · ${formatBytes(blob.size)}`);
    toast('EPUB 已生成，拖到阅读器里看看效果吧');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导出失败', 'error');
  } finally {
    state.busy = false;
    updateControls();
  }
}

/* ---------------- 章节操作 ---------------- */

function snapshotChapters(): Chapter[] {
  return structuredClone(state.chapters);
}

function restore(snapshot: Chapter[], activeId: string | null) {
  state.chapters = snapshot;
  state.activeId = activeId;
  state.selectedParagraph = null;
  renderStats();
  renderList();
  renderPreview();
  updateControls();
  recomputeDiagnostics();
  scheduleDraftSave();
}

function commitChapters(next: Chapter[], activeId: string, focusTitle = false) {
  state.chapters = next;
  state.activeId = activeId;
  state.selectedParagraph = null;
  renderStats();
  renderList();
  renderPreview();
  updateControls();
  recomputeDiagnostics();
  scheduleDraftSave();
  if (focusTitle) focusChapterTitle(activeId);
}

function beginTitleEdit(input: HTMLInputElement) {
  input.readOnly = false;
  input.classList.add('editing');
  input.dataset.original = input.value;
  input.focus();
  input.select();
}

function endTitleEdit(input: HTMLInputElement) {
  input.readOnly = true;
  input.classList.remove('editing');
  delete input.dataset.original;
}

function focusChapterTitle(id: string) {
  requestAnimationFrame(() => {
    const row = Array.from(els.chapterList.querySelectorAll<HTMLElement>('.chapter-row')).find(
      (item) => item.dataset.id === id,
    );
    const input = row?.querySelector<HTMLInputElement>('.ch-title');
    if (!input) return;
    beginTitleEdit(input);
    input.scrollIntoView({ block: 'nearest' });
  });
}

function deleteChapter(index: number) {
  const chapter = state.chapters[index];
  if (!chapter) return;
  if (state.chapters.length <= 1) {
    toast('至少保留一章');
    return;
  }
  const snapshot = snapshotChapters();
  const previousActive = state.activeId;
  const next = removeChapterAt(state.chapters, index);
  if (next === state.chapters) return;
  const nextActive = next[index] ?? next[index - 1];
  if (!nextActive) return;
  commitChapters(next, nextActive.id);
  toast(`已删除「${chapter.title}」`, {
    label: '撤销',
    onClick: () => restore(snapshot, previousActive),
  });
}

function mergeUp(index: number) {
  if (index <= 0) {
    toast('已经是第一章了');
    return;
  }
  const previous = state.chapters[index - 1];
  const current = state.chapters[index];
  if (!previous || !current) return;
  const snapshot = snapshotChapters();
  const next = mergeChapterUp(state.chapters, index);
  if (next === state.chapters) return;
  commitChapters(next, previous.id);
  toast(`已把「${current.title}」并入「${previous.title}」`, {
    label: '撤销',
    onClick: () => restore(snapshot, current.id),
  });
}

function titleFromFirstParagraph(chapterIndex: number) {
  const chapter = state.chapters[chapterIndex];
  if (!chapter || !chapter.paragraphs.length) return;
  const snapshot = snapshotChapters();
  const next = state.chapters.slice();
  next[chapterIndex] = {
    ...chapter,
    title: suggestChapterTitle(chapter.paragraphs[0]),
    paragraphs: chapter.paragraphs.slice(1),
  };
  commitChapters(next, chapter.id);
  toast('已用第一段作为本章标题', {
    label: '撤销',
    onClick: () => restore(snapshot, chapter.id),
  });
}

function splitAt(chapterIndex: number, paragraphIndex: number, mode: 'split' | 'title') {
  const chapter = state.chapters[chapterIndex];
  if (!chapter) return;
  if (paragraphIndex <= 0) {
    if (mode === 'title') {
      titleFromFirstParagraph(chapterIndex);
      return;
    }
    toast('这是本章第一段，没法再往上拆');
    return;
  }
  const snapshot = snapshotChapters();
  const id = `ch-new-${++state.idSeed}`;
  const next = splitChapterAt(state.chapters, chapterIndex, paragraphIndex, mode, id);
  if (next === state.chapters) {
    toast('这一段无法拆分');
    return;
  }
  state.filter = '';
  els.chapterSearch.value = '';
  commitChapters(next, id, true);
  // 手机上分章后切回目录，新的章节标题才能获得焦点直接改
  if (isMobileViewport()) setMobileView('chapters');
  toast(mode === 'title' ? '已把这一段设为新章标题，可直接改' : '已从这一段分出新章', {
    label: '撤销',
    onClick: () => restore(snapshot, chapter.id),
  });
}

function setChapterLevel(index: number) {
  const chapter = state.chapters[index];
  if (!chapter) return;
  const next = toggleChapterLevel(state.chapters, index);
  if (next === state.chapters) return;
  commitChapters(next, chapter.id);
  toast(chapter.level === 1 ? '已降为普通章节' : '已升为卷');
}

/* ---------------- 批量转换 ---------------- */

const MAX_BATCH_FILES = 40;
const MAX_BATCH_FILE_BYTES = 80 * 1024 * 1024;
const MAX_BATCH_TOTAL_BYTES = 200 * 1024 * 1024;

type BatchArchive = { blob: Blob; name: string };
let batchArchive: BatchArchive | null = null;
let batchZipPromise: Promise<BatchArchive | null> | null = null;

function startBatch(files: File[]) {
  if (state.busy) {
    toast('正在处理，请稍候');
    return;
  }
  if (files.length > MAX_BATCH_FILES) {
    toast(`一次最多 ${MAX_BATCH_FILES} 本，请分批处理`);
    return;
  }
  const oversized = files.find((file) => file.size > MAX_BATCH_FILE_BYTES);
  if (oversized) {
    toast(`「${oversized.name}」超过 80MB，请先拆分后再转换`);
    return;
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_BATCH_TOTAL_BYTES) {
    toast(`一次批量最多 200MB（当前 ${formatBytes(totalBytes)}），请分批处理`);
    return;
  }
  loadEpoch += 1;
  batchArchive = null;
  batchZipPromise = null;
  state.batchItems = files.map((file) => ({ file, title: guessTitle(file.name), status: 'waiting' }));
  state.batchRunning = true;
  state.batchCancelled = false;
  state.busy = true;

  els.dropZone.hidden = true;
  els.guide.hidden = true;
  els.privacy.hidden = true;
  els.workspace.hidden = true;
  els.batch.hidden = false;
  els.batchClose.disabled = false;
  els.batchClose.textContent = '取消';
  els.batchDownload.disabled = true;
  els.batchStatus.textContent = '正在准备…';

  renderBatch();
  void runBatch();
  window.scrollTo(0, 0);
}

function batchStateText(item: BatchItem): string {
  switch (item.status) {
    case 'waiting':
      return '等待';
    case 'parsing':
      return '解析中…';
    case 'packing':
      return '生成中…';
    case 'done':
      return '完成';
    case 'error':
      return '失败';
  }
}

function renderBatch() {
  const items = state.batchItems;
  const done = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'error').length;
  els.batchSummary.textContent = `共 ${items.length} 本 · 完成 ${done}${failed ? ` · 失败 ${failed}` : ''}`;

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'batch-item';

    const title = document.createElement('span');
    title.className = 'batch-title';
    title.textContent = item.title;
    title.title = item.file.name;

    const meta = document.createElement('span');
    meta.className = 'batch-meta';
    meta.textContent = item.chapters ? `${item.chapters} 章` : '';

    const status = document.createElement('span');
    status.className =
      'batch-state' + (item.status === 'done' ? ' done' : item.status === 'error' ? ' error' : '');
    status.textContent = batchStateText(item);
    status.title = item.message ?? '';

    row.append(title, meta, status);
    fragment.appendChild(row);
  }
  els.batchList.replaceChildren(fragment);
  els.batchDownload.disabled = done === 0;
}

async function runBatch() {
  let done = 0;
  for (const item of state.batchItems) {
    if (state.batchCancelled) break;
    if (item.status !== 'waiting') continue;

    item.status = 'parsing';
    renderBatch();
    els.batchStatus.textContent = `正在解析：${item.file.name}`;

    try {
      const buffer = await item.file.arrayBuffer();
      const parsed = await call(
        {
          type: 'parse',
          buffer,
          filename: item.file.name,
          options: { encoding: 'auto', filterAds: els.filterAds.checked, rules: state.rules },
        },
        [buffer],
      );
      if (parsed.type !== 'parsed') throw new Error('解析失败');

      const result = parsed.result;
      item.title = result.titleGuess || guessTitle(item.file.name);
      item.chapters = result.chapters.length;
      item.status = 'packing';
      renderBatch();
      els.batchStatus.textContent = `正在生成：${item.title}`;

      let cover = null;
      try {
        cover = await generateCover(item.title, result.authorGuess || '佚名');
      } catch {
        cover = null;
      }

      const packed = await call({
        type: 'pack',
        chapters: result.chapters,
        meta: { title: item.title, author: result.authorGuess || '', language: 'zh-CN' },
        layout: state.layout,
        cover,
        version: state.epubVersion,
      });
      if (packed.type !== 'packed') throw new Error('打包失败');

      item.data = packed.data;
      item.status = 'done';
      done += 1;
    } catch (error) {
      item.status = 'error';
      item.message = error instanceof Error ? error.message : '转换失败';
    }
    renderBatch();
  }

  state.busy = false;
  state.batchRunning = false;
  els.batchClose.disabled = false;
  els.batchClose.textContent = '返回';

  if (state.batchCancelled) {
    els.batchStatus.textContent = `已取消，完成 ${done} 本`;
    return;
  }

  if (done > 0) {
    els.batchStatus.textContent = `完成 ${done} 本，正在打包…`;
    await downloadBatchZip();
  } else {
    els.batchStatus.textContent = '没有成功转换的文件';
  }
}

function buildBatchZip(): Promise<BatchArchive | null> {
  if (batchArchive) return Promise.resolve(batchArchive);
  if (batchZipPromise) return batchZipPromise;

  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  let count = 0;

  for (const item of state.batchItems) {
    if (item.status !== 'done' || !item.data) continue;
    const base = sanitizeFilename(item.title) || '未命名';
    let name = `${base}.epub`;
    let index = 2;
    while (used.has(name)) name = `${base} (${index++}).epub`;
    used.add(name);
    files[name] = item.data;
    count += 1;
  }

  if (!count) return Promise.resolve(null);

  batchZipPromise = (async () => {
    try {
      // ZIP 放到 Worker 里生成，主线程只负责保存和下载
      const res = await call({ type: 'zip', files });
      if (res.type !== 'zipped') throw new Error('打包失败');
      const archive: BatchArchive = {
        blob: new Blob([toArrayBuffer(res.data)], { type: 'application/zip' }),
        name: `txt2book-${count}本.zip`,
      };
      batchArchive = archive;
      // ZIP 已经缓存成 Blob，EPUB 原始字节可以释放
      for (const item of state.batchItems) item.data = undefined;
      return archive;
    } catch (error) {
      els.batchStatus.textContent = `打包失败：${error instanceof Error ? error.message : '未知错误'}`;
      return null;
    } finally {
      batchZipPromise = null;
    }
  })();
  return batchZipPromise;
}

async function downloadBatchZip() {
  const archive = await buildBatchZip();
  if (!archive) return;
  download(archive.blob, archive.name);
  els.batchStatus.textContent = `已打包 ${archive.name}（${formatBytes(archive.blob.size)}）`;
}

function resetBatch() {
  batchArchive = null;
  batchZipPromise = null;
  for (const item of state.batchItems) item.data = undefined;
  state.batchItems = [];
  state.batchRunning = false;
  state.batchCancelled = false;
  els.batch.hidden = true;
  els.workspace.hidden = true;
  els.dropZone.hidden = false;
  els.guide.hidden = false;
  els.privacy.hidden = false;
  els.batchDownload.disabled = true;
  els.batchClose.disabled = false;
  els.batchClose.textContent = '取消';
  window.scrollTo(0, 0);
}

/* ---------------- 识别规则 ---------------- */

function renderRules() {
  els.rulePreset.value = state.rulePreset;
  els.ruleJson.value = state.rules ? JSON.stringify(state.rules, null, 2) : '';
  els.ruleDetails.open = state.rulePreset === 'custom';
  showRuleError(null);
}

function showRuleError(message: string | null) {
  els.ruleError.hidden = !message;
  els.ruleError.textContent = message ?? '';
}

function setRulePreset(id: string) {
  if (id === 'custom') {
    els.ruleDetails.open = true;
    els.ruleJson.focus();
    return;
  }
  state.rulePreset = id;
  state.rules = id === 'auto' ? null : getPreset(id);
  els.ruleJson.value = state.rules ? JSON.stringify(state.rules, null, 2) : '';
  els.ruleDetails.open = false;
  showRuleError(null);
  void reparse();
}

function applyCustomRules() {
  const raw = els.ruleJson.value.trim();
  if (!raw) {
    showRuleError('规则内容不能为空');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    showRuleError(`JSON 解析失败：${error instanceof Error ? error.message : '格式不正确'}`);
    return;
  }
  const message = validateRuleSpec(parsed);
  if (message) {
    showRuleError(message);
    return;
  }
  state.rules = parsed as RuleSpec;
  state.rulePreset = 'custom';
  els.rulePreset.value = 'custom';
  showRuleError(null);
  void reparse();
  toast('已应用自定义规则并重新识别');
}

function exportRules() {
  const spec: RuleSpec = state.rules ?? { name: '我的规则', chapter: '', volume: '', drop: [], inlineJunk: [] };
  const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
  download(blob, 'txt2book-rules.json');
  toast('规则已导出');
}

async function importRules(file: File) {
  try {
    const text = await file.text();
    els.ruleJson.value = text;
    els.ruleDetails.open = true;
    applyCustomRules();
  } catch {
    showRuleError('规则文件读取失败');
  }
}

/* ---------------- 本地草稿 ---------------- */

let draftTimer = 0;
let draftIdle = 0;
let draftEpoch = 0;
let draftSaveChain: Promise<void> = Promise.resolve();

function cancelScheduledDraftSave() {
  draftEpoch += 1;
  window.clearTimeout(draftTimer);
  draftTimer = 0;
  if (draftIdle && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(draftIdle);
    draftIdle = 0;
  }
}

function enqueueDraftWrite(task: () => Promise<void>): Promise<void> {
  const next = draftSaveChain.then(task, task);
  draftSaveChain = next.catch(() => undefined);
  return next;
}

function scheduleDraftSave(delay = 1200) {
  if (!state.parsed) return;
  window.clearTimeout(draftTimer);
  if (draftIdle && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(draftIdle);
    draftIdle = 0;
  }
  const epoch = draftEpoch;
  draftTimer = window.setTimeout(() => {
    if (epoch !== draftEpoch) return;
    if (state.busy) {
      scheduleDraftSave(800);
      return;
    }
    const run = () => {
      draftIdle = 0;
      if (epoch !== draftEpoch) return;
      void saveDraftNow(epoch);
    };
    if (typeof window.requestIdleCallback === 'function') {
      draftIdle = window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      run();
    }
  }, delay);
}

function saveDraftNow(epoch = draftEpoch): Promise<void> {
  const snapshot = draftSnapshot();
  if (!snapshot) return Promise.resolve();
  return enqueueDraftWrite(async () => {
    if (epoch !== draftEpoch) return;
    try {
      await saveDraft(snapshot);
      if (epoch !== draftEpoch) return;
      const time = new Date(snapshot.savedAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      });
      setDraftStatus(`草稿已自动保存 · ${time}`);
      els.draftStatus.dataset.savedAt = String(snapshot.savedAt);
    } catch (error) {
      if (epoch !== draftEpoch) return;
      setDraftStatus(error instanceof Error ? error.message : '草稿保存失败，可能是存储空间不足', true);
    }
  });
}

function createSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把新书的原始文件与草稿放在同一个事务里写入。
 * 保存失败时最多留下「新草稿 + 旧原文」，恢复时 id 不匹配会被判定为无原文，不会拿去重新识别。
 */
async function persistSourceWithDraft(file: File, fileEpoch: number, sessionEpoch: number): Promise<void> {
  try {
    const copy = await file.arrayBuffer();
    if (fileEpoch !== loadEpoch || sessionEpoch !== draftEpoch) return;
    const snapshot = draftSnapshot();
    if (!snapshot?.sourceId) return;
    await enqueueDraftWrite(async () => {
      if (fileEpoch !== loadEpoch || sessionEpoch !== draftEpoch) return;
      try {
        await saveDraft(snapshot, { id: snapshot.sourceId as string, name: file.name, data: copy });
      } catch {
        if (fileEpoch === loadEpoch && sessionEpoch === draftEpoch) {
          toast('原始文件没能保存到本地，刷新后需要重新拖入 TXT');
        }
      }
    });
  } catch {
    if (fileEpoch === loadEpoch) toast('原始文件读取失败，刷新后需要重新拖入 TXT');
  }
}

function draftSnapshot(): DraftData | null {
  if (!state.parsed || !state.chapters.length) return null;
  return {
    version: 2,
    savedAt: Date.now(),
    filename: state.filename,
    meta: state.meta,
    chapters: state.chapters,
    layout: state.layout,
    cover: state.cover,
    coverAuto: state.coverAuto,
    activeId: state.activeId,
    options: { encoding: els.encoding.value, filterAds: els.filterAds.checked },
    parse: { ...state.parsed, chapters: [] },
    rules: state.rules,
    rulePreset: state.rulePreset,
    sourceId: state.sourceId ?? undefined,
  };
}

function setDraftStatus(message: string, error = false) {
  els.draftStatus.textContent = message;
  els.draftStatus.classList.toggle('error', error);
}

async function restoreDraftOnStart(): Promise<boolean> {
  const epoch = loadEpoch;
  let draft: DraftData | null = null;
  let source: Awaited<ReturnType<typeof loadSource>> = null;
  try {
    [draft, source] = await Promise.all([loadDraft(), loadSource()]);
  } catch {
    return false;
  }
  if (!draft || epoch !== loadEpoch) return false;

  const sourceOk = sourceMatchesDraft(draft, source);
  if (!sourceOk && source) {
    // 老草稿没有 sourceId，或原文在换书时没保存成功：不能信任，直接丢掉
    await clearSource().catch(() => undefined);
  }

  let sourceReady = false;
  if (sourceOk && source) {
    try {
      await call({ type: 'source', buffer: source.data, filename: source.name }, [source.data]);
      sourceReady = true;
    } catch {
      sourceReady = false;
    }
  }
  if (epoch !== loadEpoch) return false;

  state.sourceReady = sourceReady;
  state.sourceId = draft.sourceId ?? null;
  state.filename = draft.filename ?? '';
  state.parsed = { ...draft.parse, chapters: draft.chapters };
  state.chapters = draft.chapters;
  state.meta = draft.meta;
  state.layout = { ...DEFAULT_LAYOUT, ...draft.layout };
  state.cover = draft.cover;
  state.coverAuto = draft.coverAuto;
  state.filter = '';
  state.selectedParagraph = null;
  state.diagDismissed = false;
  state.diagOpen = true;
  state.idSeed = deriveIdSeed(draft.chapters);
  state.rules = draft.rules ?? null;
  state.rulePreset = draft.rulePreset ?? (draft.rules ? 'custom' : 'auto');

  const remembered = draft.chapters.find((chapter) => chapter.id === draft.activeId);
  state.activeId =
    remembered?.id ??
    draft.chapters.find((chapter) => chapter.paragraphs.length)?.id ??
    draft.chapters[0]?.id ??
    null;

  showWorkspace();
  els.chapterSearch.hidden = false;
  els.chapterSearch.value = '';
  els.metaTitle.value = state.meta.title;
  els.metaAuthor.value = state.meta.author;
  els.filterAds.checked = draft.options.filterAds;
  els.encoding.value = normalizeEncodingOption(
    draft.options.encoding === 'auto' ? draft.parse.encoding : draft.options.encoding,
  );

  renderRules();
  const warnings = [...draft.parse.warnings];
  if (!sourceReady) {
    warnings.unshift(
      '草稿关联的原始文件缺失或已失效；要换编码或重新识别，请重新拖入同一个 TXT。',
    );
  }
  renderWarnings(warnings);
  recomputeDiagnostics();
  renderAll();

  const minutes = Math.max(1, Math.round((Date.now() - draft.savedAt) / 60000));
  const when = minutes < 60 ? `${minutes} 分钟前` : new Date(draft.savedAt).toLocaleString('zh-CN');
  setDraftStatus(`已恢复 ${when} 的草稿`);
  setStatus('已恢复上次的草稿，继续编辑即可');
  if (!sourceReady) {
    toast('草稿关联的原始文件缺失，重新识别前请重新拖入 TXT', {
      label: '清除草稿',
      onClick: () => {
        void clearDraftStorage()
          .catch(() => undefined)
          .finally(() => window.location.reload());
      },
    });
  }
  return true;
}

async function clearDraftStorage(): Promise<void> {
  // 先停止待执行的定时器/空闲回调，再等在途写入完成，最后原子删除草稿和原文
  cancelScheduledDraftSave();
  await draftSaveChain;
  await clearDraft();
  state.sourceId = null;
}

async function handleClearDraft() {
  try {
    await clearDraftStorage();
    setDraftStatus('草稿已清除，当前编辑内容仍保留在页面里');
    toast('已清除本地草稿');
  } catch {
    toast('清除失败，请稍后重试');
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  els.themeToggle.addEventListener('click', toggleTheme);

  els.mobileTabs.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!button) return;
    const view = button.dataset.view as MobileView | undefined;
    if (!view || view === mobileView) return;
    setMobileView(view, true);
  });

  els.prevChapter.addEventListener('click', () => stepChapter(-1));
  els.nextChapter.addEventListener('click', () => stepChapter(1));

  els.pickFile.addEventListener('click', () => els.fileInput.click());
  els.changeFile.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const files = Array.from(els.fileInput.files ?? []);
    els.fileInput.value = '';
    if (!files.length) return;
    if (files.length === 1) void loadFile(files[0]);
    else startBatch(files);
  });

  els.loadSample.addEventListener('click', async () => {
    try {
      const response = await fetch('/sample.txt');
      const text = await response.text();
      const file = new File([text], '雾港灯塔.txt', { type: 'text/plain' });
      void loadFile(file);
    } catch {
      setStatus('示例加载失败，请直接选择本地文件', 'error');
    }
  });

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    els.dropZone.classList.add('dragover');
  };
  const onDragLeave = () => els.dropZone.classList.remove('dragover');
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    els.dropZone.classList.remove('dragover');
    const files = Array.from(event.dataTransfer?.files ?? []).filter((item) => /\.txt$/i.test(item.name));
    if (files.length === 1) void loadFile(files[0]);
    else if (files.length > 1) startBatch(files);
    else toast('请拖入 .txt 文件');
  };

  els.dropZone.addEventListener('dragover', onDragOver);
  els.dropZone.addEventListener('dragleave', onDragLeave);
  els.dropZone.addEventListener('drop', onDrop);

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    if (els.dropZone.contains(event.target as Node) || els.dropZone.hidden) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []).filter((item) => /\.txt$/i.test(item.name));
    if (files.length === 1) void loadFile(files[0]);
    else if (files.length > 1) startBatch(files);
  });

  els.chapterList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.chapter-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (!Number.isFinite(index) || index < 0) return;

    const action = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (action === 'delete') {
      deleteChapter(index);
      return;
    }
    if (action === 'merge') {
      mergeUp(index);
      return;
    }
    if (action === 'level') {
      setChapterLevel(index);
      return;
    }
    if (action === 'rename') {
      const input = row.querySelector<HTMLInputElement>('.ch-title');
      if (input) beginTitleEdit(input);
      return;
    }
    if (target instanceof HTMLInputElement && target.classList.contains('ch-title')) {
      // 标题平时只读：先选中章节，再点一次才进编辑态，避免手机一点就弹键盘
      if (!target.readOnly) return;
      if (row.classList.contains('active')) {
        beginTitleEdit(target);
        return;
      }
    }
    setActive(row.dataset.id ?? null);
  });

  els.chapterList.addEventListener('dblclick', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.ch-title');
    if (input && input.readOnly) beginTitleEdit(input);
  });

  els.chapterList.addEventListener('focusout', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.ch-title');
    if (input && !input.readOnly) endTitleEdit(input);
  });

  els.chapterList.addEventListener('keydown', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.ch-title');
    if (!input) return;
    if (input.readOnly) {
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        beginTitleEdit(input);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      input.value = input.dataset.original ?? input.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    }
  });

  els.chapterList.addEventListener('input', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const row = input.closest<HTMLElement>('.chapter-row');
    if (!row) return;
    const chapter = state.chapters.find((item) => item.id === row.dataset.id);
    if (!chapter) return;
    chapter.title = input.value;
    input.setAttribute('aria-label', `章节标题：${input.value}`);
    scheduleDraftSave();
    if (chapter.id === state.activeId) {
      const heading = els.preview.querySelector('h1, h2');
      if (heading) heading.textContent = input.value || '未命名';
    }
  });

  els.metaTitle.addEventListener('input', () => {
    state.meta.title = els.metaTitle.value;
    scheduleAutoCover();
    scheduleDraftSave();
  });
  els.metaAuthor.addEventListener('input', () => {
    state.meta.author = els.metaAuthor.value;
    scheduleAutoCover();
    scheduleDraftSave();
  });

  els.coverThumb.addEventListener('click', () => {
    if (state.coverUrl) openCoverView();
    else els.coverInput.click();
  });
  els.coverViewClose.addEventListener('click', () => closeCoverView(true));
  els.coverView.addEventListener('click', (event) => {
    if (event.target === els.coverViewImg) return;
    closeCoverView(true);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.coverView.hidden) closeCoverView(true);
  });
  els.coverUpload.addEventListener('click', () => els.coverInput.click());
  els.coverRemove.addEventListener('click', () => {
    state.cover = null;
    state.coverAuto = false;
    renderCover();
    scheduleDraftSave();
    toast('已移除封面，导出时不再包含封面');
  });
  els.coverInput.addEventListener('change', async () => {
    const file = els.coverInput.files?.[0];
    els.coverInput.value = '';
    if (!file) return;
    try {
      state.cover = await coverFromImage(file);
      state.coverAuto = false;
      renderCover();
      scheduleDraftSave();
      toast('封面已更新，导出后可在阅读器书架看到');
    } catch (error) {
      toast(error instanceof Error ? error.message : '封面读取失败');
    }
  });
  els.coverAuto.addEventListener('click', () => {
    state.coverAuto = true;
    void (async () => {
      state.cover = await generateCover(state.meta.title || '未命名', state.meta.author || '佚名');
      renderCover();
      scheduleDraftSave();
    })();
  });

  els.encoding.addEventListener('change', () => void reparse());
  els.filterAds.addEventListener('change', () => void reparse());
  els.reparse.addEventListener('click', () => void reparse());
  els.rulePreset.addEventListener('change', () => setRulePreset(els.rulePreset.value));
  els.ruleApply.addEventListener('click', () => applyCustomRules());
  els.ruleExport.addEventListener('click', () => exportRules());
  els.ruleImport.addEventListener('click', () => els.ruleFile.click());
  els.ruleFile.addEventListener('change', () => {
    const file = els.ruleFile.files?.[0];
    els.ruleFile.value = '';
    if (file) void importRules(file);
  });
  els.export.addEventListener('click', () => void exportEpub());
  els.epubVersion.addEventListener('change', () => {
    state.epubVersion = els.epubVersion.value === '2' ? 2 : 3;
    updateExportHint();
    try {
      localStorage.setItem(EPUB_VERSION_KEY, String(state.epubVersion));
    } catch {
      /* 忽略存储失败 */
    }
    scheduleDraftSave(0);
  });
  els.clearDraft.addEventListener('click', () => void handleClearDraft());
  els.batchDownload.addEventListener('click', () => void downloadBatchZip());
  els.batchClose.addEventListener('click', () => {
    if (state.batchRunning) {
      state.batchCancelled = true;
      els.batchClose.disabled = true;
      els.batchStatus.textContent = '正在结束当前任务…';
      return;
    }
    resetBatch();
  });

  els.font.addEventListener('change', () => {
    state.layout.font = els.font.value as LayoutOptions['font'];
    saveLayout();
    applyLayoutToPreview();
    scheduleDraftSave();
  });
  els.lineHeight.addEventListener('input', () => {
    state.layout.lineHeight = Number(els.lineHeight.value);
    els.lineHeightVal.textContent = state.layout.lineHeight.toFixed(2);
    paintRange(els.lineHeight);
    saveLayout();
    applyLayoutToPreview();
    scheduleDraftSave();
  });
  els.paraGap.addEventListener('input', () => {
    state.layout.paragraphSpacing = Number(els.paraGap.value);
    els.paraGapVal.textContent = state.layout.paragraphSpacing.toFixed(1);
    paintRange(els.paraGap);
    saveLayout();
    applyLayoutToPreview();
    scheduleDraftSave();
  });
  els.indent.addEventListener('change', () => {
    state.layout.indent = els.indent.checked;
    saveLayout();
    applyLayoutToPreview();
    scheduleDraftSave();
  });
  els.justify.addEventListener('change', () => {
    state.layout.justify = els.justify.checked;
    saveLayout();
    applyLayoutToPreview();
    scheduleDraftSave();
  });

  els.preview.addEventListener('click', (event) => {
    const paragraph = (event.target as HTMLElement).closest<HTMLElement>('p[data-index]');
    if (!paragraph) return;
    const index = Number(paragraph.dataset.index);
    selectParagraph(state.selectedParagraph === index ? null : index);
  });

  els.selectionBar.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!action) return;
    if (action === 'cancel') {
      selectParagraph(null);
      return;
    }
    const chapterIndex = state.chapters.findIndex((chapter) => chapter.id === state.activeId);
    if (chapterIndex < 0 || state.selectedParagraph === null) return;
    splitAt(chapterIndex, state.selectedParagraph, action === 'title' ? 'title' : 'split');
  });

  els.chapterSearch.addEventListener('input', () => {
    state.filter = els.chapterSearch.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => renderList(), 140);
  });

  els.chapterSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      state.filter = '';
      els.chapterSearch.value = '';
      renderList();
      return;
    }
    if (event.key === 'Enter') {
      window.clearTimeout(searchTimer);
      state.filter = els.chapterSearch.value;
      renderList();
      const first = els.chapterList.querySelector<HTMLElement>('.chapter-row');
      if (first) setActive(first.dataset.id ?? null);
    }
  });

  els.diagToggle.addEventListener('click', () => {
    state.diagOpen = !state.diagOpen;
    renderDiagnostics();
  });

  els.diagDismiss.addEventListener('click', () => {
    state.diagDismissed = true;
    renderDiagnostics();
  });

  els.diagList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-role]');
    if (!button) return;
    const chapterIndex = Number(button.dataset.chapterIndex);
    const paragraphIndex = Number(button.dataset.paragraphIndex);

    if (button.dataset.role === 'title') {
      splitAt(chapterIndex, paragraphIndex, 'title');
      return;
    }

    const chapter = state.chapters[chapterIndex];
    if (!chapter) return;
    if (state.filter) {
      state.filter = '';
      els.chapterSearch.value = '';
      renderList();
    }
    setActive(chapter.id);
    requestAnimationFrame(() => {
      const row = Array.from(els.chapterList.querySelectorAll<HTMLElement>('.chapter-row')).find(
        (item) => item.dataset.id === chapter.id,
      );
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    selectParagraph(paragraphIndex, true);
  });
}

/* ---------------- 启动 ---------------- */

applyTheme(themeMode);
setMobileView(mobileView);
paintRange(els.lineHeight);
paintRange(els.paraGap);
bindEvents();
applyLayoutToPreview();
renderRules();
void restoreDraftOnStart().then((restored) => {
  if (restored) toast('已恢复上次未导出的草稿');
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 离线能力不可用不影响主流程 */
    });
  });
}
