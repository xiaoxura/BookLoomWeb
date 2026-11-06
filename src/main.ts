import { findHeadingCandidates, guessTitle } from './core/chapters';
import {
  DEFAULT_COVER_OPTIONS,
  coverThumbnail,
  drawCoverPreview,
  generateCover,
  normalizeCoverOptions,
} from './core/cover';
import {
  type LoadedBook,
  createBookId,
  deleteBook as deleteBookRecord,
  deriveIdSeed,
  estimateStorage,
  listBooks,
  loadBook,
  renameBook as renameBookRecord,
  saveBookDraft,
  saveBookFont,
  saveBookSource,
  sourceMatchesDraft,
  type BookRecord,
  type DraftData,
} from './core/draft';
import { compileRules, getPreset, validateRuleSpec, type RuleSpec } from './core/rules';
import { EditHistory } from './core/history';
import { auditChapters, renumberChapters } from './core/audit';
import {
  applyReplace,
  previewReplace,
  type ReplaceMatch,
  type ReplaceOptions,
  type ReplacePreview,
} from './core/replace';
import {
  mergeChapterUp,
  removeChapterAt,
  splitChapterAt,
  suggestChapterTitle,
  toggleChapterLevel,
} from './core/edit';
import { dismissNotice, initNotice } from './notice';
import type { Chapter, ConvertMode, CoverAuthorPosition, CoverPalette, ParseResult } from './types';
import {
  buildFormattedBook,
  download,
  exportBook as exportBookAction,
  formatBytes,
  sanitizeFilename,
  toArrayBuffer,
} from './app/export';
import { els } from './app/dom';
import { createRenderer } from './app/render';
import { bindEvents, type CoverUpdate, type EventDeps } from './app/events';
import { handleGlobalKeydown, type ShortcutDeps } from './app/shortcuts';
import {
  createInitialState,
  DEFAULT_LAYOUT,
  EXPORT_FORMATS,
  loadLastBookId,
  loadTheme,
  saveExportFormat,
  saveLastBookId,
  saveLayout,
  saveTheme,
  type ExportFormat,
  type MobileView,
  type State,
  type ThemeMode,
} from './app/state';
import { WorkerClient, type RequestPayload, type WorkerPort } from './worker/client';
import type { FromWorker } from './worker/protocol';

const mobileQuery = window.matchMedia('(max-width: 760px)');

const state: State = createInitialState();

/** 渲染层只管 DOM；当前章节等派生状态也放在这里复用 */
const render = createRenderer(els, state, () => closeCoverView());

function setExportFormat(value: string) {
  state.exportFormat = EXPORT_FORMATS.includes(value as ExportFormat) ? (value as ExportFormat) : 'epub';
  saveExportFormat(state.exportFormat);
  hideExportResult();
  render.controls();
}

function isMobileViewport(): boolean {
  return mobileQuery.matches;
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

  if (persist) saveTheme(mode);
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
      render.controls();
      toast('后台线程已重置，请重试；重新识别需要重新拖入 TXT');
    },
  },
);

function call(payload: RequestPayload, transfer: Transferable[] = []): Promise<FromWorker> {
  return workerClient.call(payload, transfer);
}

/* ---------------- 状态与渲染 ---------------- */










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


function selectParagraph(index: number | null, scroll = false) {
  state.selectedParagraph = index;
  els.preview.querySelectorAll<HTMLElement>('p[data-index]').forEach((paragraph) => {
    const on = index !== null && Number(paragraph.dataset.index) === index;
    paragraph.classList.toggle('selected', on);
    if (on && scroll) paragraph.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  render.updateSelectionBar();
}

let diagToken = 0;

function recomputeDiagnostics() {
  const token = ++diagToken;
  const run = () => {
    if (token !== diagToken) return;
    state.diagnostics = findHeadingCandidates(state.chapters, compileRules(state.rules));
    state.audit = auditChapters(state.chapters);
    render.diagnostics();
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 800 });
  } else {
    window.setTimeout(run, 0);
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
      // 先收起当前提示，动作里再弹新提示（比如撤销结果）时才不会被立刻隐藏
      hideToast();
      action.onClick();
    });
    els.toast.appendChild(button);
  }
  els.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, action ? 6000 : 3200);
}

/* ---------------- 解析 ---------------- */

function parseOptions() {
  return {
    encoding: els.encoding.value,
    filterAds: els.filterAds.checked,
    rules: state.rules,
    convert: state.convert,
  };
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
  els.shelf.hidden = true;
  els.dropZone.hidden = true;
  els.guide.hidden = true;
  els.howto.hidden = true;
  els.faq.hidden = true;
  els.privacy.hidden = true;
  els.batch.hidden = true;
  hideExportResult();
  dismissNotice();
  // 校对章节是导入后的主任务，手机上先给目录，预览随时可切
  setMobileView('chapters');
}

function showLanding() {
  els.workspace.hidden = true;
  els.shelf.hidden = true;
  els.dropZone.hidden = false;
  els.guide.hidden = false;
  els.howto.hidden = false;
  els.faq.hidden = false;
  els.privacy.hidden = false;
  els.batch.hidden = true;
  window.scrollTo(0, 0);
}

function setActive(id: string | null) {
  state.activeId = id;
  state.selectedParagraph = null;
  document.querySelectorAll<HTMLElement>('.chapter-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.id === id);
  });
  render.preview();
  if (id && isMobileViewport() && mobileView !== 'preview') setMobileView('preview', true);
}

interface ApplyResultOptions {
  /** 重新应用设置时保留用户改过的书名 / 作者 / 封面 */
  preserveMeta?: boolean;
  /** 重新解析后按原下标恢复当前章节 */
  activeIndex?: number;
}

function applyResult(result: ParseResult, options: ApplyResultOptions = {}) {
  const preservedMeta = options.preserveMeta ? { ...state.meta } : null;
  const preservedCover = options.preserveMeta
    ? { cover: state.cover, coverAuto: state.coverAuto, coverThumb: state.coverThumb }
    : null;

  state.sourceReady = true;
  state.parsed = result;
  state.chapters = result.chapters;
  const indexed = options.activeIndex === undefined ? undefined : result.chapters[options.activeIndex];
  state.activeId =
    indexed?.id ??
    result.chapters.find((chapter) => chapter.paragraphs.length)?.id ??
    result.chapters[0]?.id ??
    null;
  // 新书 / 重新识别的结果与旧历史无关
  history.clear();
  titleEditBase = null;
  state.filter = '';
  state.selectedParagraph = null;
  state.diagDismissed = false;
  state.diagOpen = true;
  state.idSeed = 0;
  els.chapterSearch.value = '';
  els.chapterSearch.hidden = false;

  const fromEpub = result.sourceType === 'epub';
  const fromDocx = result.sourceType === 'docx';
  const fromStructured = fromEpub || fromDocx;
  if (fromStructured) {
    if (result.titleGuess) state.meta.title = result.titleGuess;
    if (result.language) state.meta.language = result.language;
  }
  if (fromEpub && result.cover) {
    state.cover = result.cover;
    state.coverAuto = false;
    void refreshCoverThumb();
  }
  if (fromEpub && result.metaGuess) {
    state.meta = { ...state.meta, ...result.metaGuess };
  }

  if (preservedMeta) state.meta = preservedMeta;
  if (preservedCover) {
    state.cover = preservedCover.cover;
    state.coverAuto = preservedCover.coverAuto;
    state.coverThumb = preservedCover.coverThumb;
  }
  els.encoding.value = normalizeEncodingOption(result.encoding);
  if (!state.meta.author) state.meta.author = result.authorGuess;
  render.warnings(result.warnings);
  recomputeDiagnostics();
  render.all();
  resetReplacePanel();
  setStatus(
    fromEpub
      ? `已读入 EPUB · ${result.chapters.length} 章`
      : fromDocx
        ? `已读入 DOCX · ${result.chapters.length} 章`
        : `识别完成 · ${result.chapters.length} 章`,
  );
  updateHistoryControls();
  scheduleDraftSave(300);
  if (!state.cover) scheduleAutoCover();
  scheduleCoverPreview(0);
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

  // 换书前先把当前这本的改动落盘，避免旧书丢失最后一次编辑
  cancelScheduledDraftSave();
  await saveDraftNow();

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

    // 解析成功后才分配新的书架 id；失败时旧书和旧草稿不受影响
    state.bookId = createBookId();
    state.sourceId = state.bookId;
    state.filename = file.name;
    state.meta = { title: guessTitle(file.name), author: '', language: 'zh-CN' };
    state.cover = null;
    state.coverThumb = null;
    state.coverAuto = true;
    state.font = null;
    showWorkspace();
    window.scrollTo(0, 0);
    applyResult(res.result);
    if (isMobileViewport()) {
      toast(`已识别 ${res.result.chapters.length} 章，可在目录里校对`, {
        label: '看预览',
        onClick: () => setMobileView('preview', true),
      });
    }
    saveLastBookId(state.bookId);
    void persistSourceWithDraft(file, epoch);
  } catch (error) {
    const message = error instanceof Error ? error.message : '解析失败';
    setStatus(message, 'error');
    toast(`解析失败：${message}`);
  } finally {
    setDropLoading(false);
    state.busy = false;
    render.controls();
  }
}

interface ReparseOptions {
  /** 繁简转换需要允许 EPUB / DOCX 从原始文件重跑 */
  allowStructured?: boolean;
  /** 转换场景：保留书名 / 封面 / 当前章节，并记一步历史 */
  conversion?: boolean;
}

async function reparse(options: ReparseOptions = {}) {
  if (!state.parsed || state.busy) return;
  const structured =
    state.parsed.sourceType === 'epub' || state.parsed.sourceType === 'docx';
  const reading = options.conversion ? '繁简转换' : '重新识别';
  if (structured && !options.allowStructured) {
    toast('EPUB / DOCX 已经拆好章节，换编码或加规则都不会重新识别');
    return;
  }
  if (!state.sourceReady) {
    toast(
      options.conversion
        ? '草稿没有原始文件，重新拖入原文件后才能应用繁简转换'
        : '草稿没有可用的原始文件，重新拖入原文件后才能换编码或重新识别',
    );
    return;
  }
  state.busy = true;
  render.controls();
  setStatus(`正在${reading}…`);
  const activeIndex = state.chapters.findIndex((chapter) => chapter.id === state.activeId);
  try {
    const res = await call({ type: 'reparse', options: parseOptions() });
    if (res.type !== 'parsed') return;
    if (options.conversion) {
      applyResult(res.result, { preserveMeta: true, activeIndex });
      toast(
        state.convert === 'traditional'
          ? '已转为繁体'
          : state.convert === 'simplified'
            ? '已转为简体'
            : '已恢复原文',
      );
    } else {
      applyResult(res.result);
      toast('已按新的设置重新识别，手动改过的标题会被覆盖');
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : `${reading}失败`, 'error');
  } finally {
    state.busy = false;
    render.controls();
  }
}

function setConvert(value: string): void {
  const mode: ConvertMode =
    value === 'simplified' || value === 'traditional' ? value : 'none';
  if (state.convert === mode) return;
  state.convert = mode;
  render.controls();
  scheduleDraftSave(0);
  if (!state.parsed) return;
  if (state.busy) {
    toast('正在处理，请稍候');
    return;
  }
  if (!state.sourceReady) {
    toast('草稿没有原始文件，重新拖入原文件后才能应用繁简转换');
    return;
  }
  void reparse({ allowStructured: true, conversion: true });
}

/* ---------------- 封面 ---------------- */

let coverTimer = 0;
let coverThumbToken = 0;

/** 封面变化后生成书架缩略图；生成失败不阻塞编辑 */
async function refreshCoverThumb(): Promise<void> {
  const token = ++coverThumbToken;
  if (!state.cover) {
    state.coverThumb = null;
    return;
  }
  const thumb = await coverThumbnail(state.cover);
  if (token !== coverThumbToken) return;
  state.coverThumb = thumb;
  scheduleDraftSave(0);
}

const FONT_MIME: Record<string, string> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

async function importFont(file: File): Promise<void> {
  const ext = file.name.match(/\.(ttf|otf|woff2?)$/i)?.[1]?.toLowerCase();
  if (!ext) {
    toast('请选择 ttf / otf / woff / woff2 字体');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast('字体超过 20MB，请换一个更小的文件');
    return;
  }
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    state.font = { name: file.name, data, mime: FONT_MIME[ext] };
    render.controls();
    if (state.bookId) {
      void saveBookFont(state.bookId, state.font).catch(() =>
        toast('字体没能保存到本地，刷新后需要重新选择'),
      );
    }
    toast('字体已加入，导出时会一起打进 EPUB');
  } catch {
    toast('字体读取失败');
  }
}

function removeFont(): void {
  state.font = null;
  render.controls();
  if (state.bookId) void saveBookFont(state.bookId, null).catch(() => undefined);
  toast('已移除嵌入字体');
}

let coverPreviewTimer = 0;

function coverPreviewStyle(): 'vertical' | 'block' {
  return state.layout.coverStyle === 'block' ? 'block' : 'vertical';
}

async function drawCoverPreviewNow(): Promise<void> {
  try {
    await drawCoverPreview(
      els.coverPreview,
      state.meta.title || '未命名',
      state.meta.author || '佚名',
      coverPreviewStyle(),
      normalizeCoverOptions(state.layout.coverOptions),
      state.coverAuto ? null : state.cover,
    );
  } catch {
    /* 预览失败不影响导出 */
  }
}

function scheduleCoverPreview(delay = 80): void {
  window.clearTimeout(coverPreviewTimer);
  coverPreviewTimer = window.setTimeout(() => {
    void drawCoverPreviewNow();
  }, delay);
}

/** 封面参数变更：切回自动封面、重绘预览，并延迟生成正式 JPEG */
function setCoverOptions(update: CoverUpdate): void {
  if (update.style) {
    state.layout.coverStyle = update.style === 'block' ? 'block' : 'vertical';
  }
  if (update.reset) {
    state.layout.coverOptions = { ...DEFAULT_COVER_OPTIONS };
  } else if (
    update.palette !== undefined ||
    update.titleScale !== undefined ||
    update.authorPosition !== undefined
  ) {
    state.layout.coverOptions = normalizeCoverOptions({
      ...normalizeCoverOptions(state.layout.coverOptions),
      ...(update.palette !== undefined ? { palette: update.palette as CoverPalette } : {}),
      ...(update.titleScale !== undefined ? { titleScale: update.titleScale } : {}),
      ...(update.authorPosition !== undefined
        ? { authorPosition: update.authorPosition as CoverAuthorPosition }
        : {}),
    });
  }
  state.coverAuto = true;
  render.controls();
  saveLayout(state.layout);
  scheduleCoverPreview(20);
  scheduleAutoCover();
  scheduleDraftSave();
}

function scheduleAutoCover() {
  if (!state.coverAuto) return;
  scheduleCoverPreview(20);
  window.clearTimeout(coverTimer);
  coverTimer = window.setTimeout(async () => {
    if (!state.coverAuto) return;
    try {
      state.cover = await generateCover(
        state.meta.title || '未命名',
        state.meta.author || '佚名',
        coverPreviewStyle(),
        state.layout.coverOptions,
      );
      render.cover();
      void refreshCoverThumb();
    } catch {
      /* 封面生成失败不阻塞导出 */
    }
  }, 450);
}

/* ---------------- 导出 ---------------- */

interface ExportedFile {
  blob: Blob;
  filename: string;
  format: ExportFormat;
}

let lastExport: ExportedFile | null = null;

function hideExportResult(): void {
  els.exportResult.hidden = true;
}

function showExportResult(file: ExportedFile): void {
  lastExport = file;
  const hint =
    file.format === 'epub'
      ? `EPUB ${state.epubVersion} · 可发送至 Kindle，或拷进电纸书的 Books 目录`
      : file.format === 'docx'
        ? 'Word 可直接打开继续编辑'
        : file.format === 'html'
          ? '单文件 HTML · 双击即可在浏览器阅读'
          : file.format === 'txt'
            ? 'UTF-8 纯文本 · 可以再拖回来重新分章'
            : 'Markdown · 书名 #，卷 ##，章 ###';
  els.exportResultTitle.textContent = '导出完成';
  els.exportResultMeta.textContent = `${file.filename} · ${formatBytes(file.blob.size)} · ${hint}`;
  els.exportResult.hidden = false;
}

function exportCurrentBook(): void {
  hideExportResult();
  void exportBookAction({
    state,
    call,
    setStatus,
    toast,
    updateControls: render.controls,
    onExported: showExportResult,
  });
}

/* ---------------- 章节操作 ---------------- */

const HISTORY_LIMIT = 50;
/** 历史快照的字符预算：大书存 50 步会吃内存，超出预算时先丢最旧的一步 */
const HISTORY_MAX_CHARS = 30_000_000;

function chaptersWeight(chapters: Chapter[]): number {
  let total = 0;
  for (const chapter of chapters) {
    total += chapter.title.length;
    for (const paragraph of chapter.paragraphs) total += paragraph.length;
  }
  return total;
}

const history = new EditHistory<Chapter[]>({
  limit: HISTORY_LIMIT,
  clone: (chapters) => structuredClone(chapters),
  weight: chaptersWeight,
  maxWeight: HISTORY_MAX_CHARS,
});

function updateHistoryControls(): void {
  const undoLabel = history.undoLabel;
  const redoLabel = history.redoLabel;
  els.undoBtn.disabled = !history.canUndo;
  els.redoBtn.disabled = !history.canRedo;
  els.undoBtn.title = history.canUndo
    ? `撤销${undoLabel ? `「${undoLabel}」` : '上一步'}（Ctrl+Z）`
    : '没有可撤销的操作（Ctrl+Z）';
  els.redoBtn.title = history.canRedo
    ? `重做${redoLabel ? `「${redoLabel}」` : '上一步'}（Shift+Ctrl+Z）`
    : '没有可重做的操作（Shift+Ctrl+Z）';
}

/** 记录编辑之前的状态；一次批量操作只调用一次，从而合并成一步 */
function recordChange(label: string): void {
  history.record({ value: state.chapters, activeId: state.activeId, label });
  updateHistoryControls();
}

function applyChapterState(chapters: Chapter[], activeId: string | null, focusTitle = false): void {
  state.chapters = chapters;
  state.activeId = activeId;
  state.selectedParagraph = null;
  render.stats();
  render.list();
  render.preview();
  render.controls();
  recomputeDiagnostics();
  updateHistoryControls();
  scheduleDraftSave();
  if (focusTitle && activeId) focusChapterTitle(activeId);
}

function commitChapters(next: Chapter[], activeId: string, label: string, focusTitle = false): void {
  if (next === state.chapters) return;
  recordChange(label);
  applyChapterState(next, activeId, focusTitle);
}

function undoChapters(): boolean {
  const frame = history.undo({ value: state.chapters, activeId: state.activeId, label: '' });
  if (!frame) return false;
  applyChapterState(frame.value, frame.activeId);
  return true;
}

function redoChapters(): boolean {
  const frame = history.redo({ value: state.chapters, activeId: state.activeId, label: '' });
  if (!frame) return false;
  applyChapterState(frame.value, frame.activeId);
  return true;
}

function undo(): void {
  const label = history.undoLabel;
  if (!undoChapters()) {
    toast('没有可以撤销的操作');
    return;
  }
  toast(label ? `已撤销「${label}」` : '已撤销上一步');
}

function redo(): void {
  const label = history.redoLabel;
  if (!redoChapters()) {
    toast('没有可以重做的操作');
    return;
  }
  toast(label ? `已重做「${label}」` : '已重做上一步');
}

let titleEditBase: {
  chapters: Chapter[];
  activeId: string | null;
  chapterId: string;
  original: string;
} | null = null;

function beginTitleEdit(input: HTMLInputElement) {
  if (!input.readOnly) {
    input.focus();
    input.select();
    return;
  }
  const row = input.closest<HTMLElement>('.chapter-row');
  const chapter = state.chapters.find((item) => item.id === row?.dataset.id);
  input.readOnly = false;
  input.classList.add('editing');
  input.dataset.original = input.value;
  titleEditBase = {
    chapters: structuredClone(state.chapters),
    activeId: state.activeId,
    chapterId: chapter?.id ?? '',
    original: chapter?.title ?? input.value,
  };
  input.focus();
  input.select();
}

function endTitleEdit(input: HTMLInputElement) {
  input.readOnly = true;
  input.classList.remove('editing');
  delete input.dataset.original;
  const base = titleEditBase;
  titleEditBase = null;
  if (!base) return;
  const chapter = state.chapters.find((item) => item.id === base.chapterId);
  if (!chapter || chapter.title === base.original) return;
  history.record({ value: base.chapters, activeId: base.activeId, label: '改标题' });
  updateHistoryControls();
  scheduleDraftSave();
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
  const next = removeChapterAt(state.chapters, index);
  if (next === state.chapters) return;
  const nextActive = next[index] ?? next[index - 1];
  if (!nextActive) return;
  commitChapters(next, nextActive.id, '删除章节');
  toast(`已删除「${chapter.title}」`, {
    label: '撤销',
    onClick: () => {
      undoChapters();
    },
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
  const next = mergeChapterUp(state.chapters, index);
  if (next === state.chapters) return;
  commitChapters(next, previous.id, '合并章节');
  toast(`已把「${current.title}」并入「${previous.title}」`, {
    label: '撤销',
    onClick: () => {
      undoChapters();
    },
  });
}

function titleFromFirstParagraph(chapterIndex: number) {
  const chapter = state.chapters[chapterIndex];
  if (!chapter || !chapter.paragraphs.length) return;
  const next = state.chapters.slice();
  next[chapterIndex] = {
    ...chapter,
    title: suggestChapterTitle(chapter.paragraphs[0]),
    paragraphs: chapter.paragraphs.slice(1),
  };
  commitChapters(next, chapter.id, '设为标题');
  toast('已用第一段作为本章标题', {
    label: '撤销',
    onClick: () => {
      undoChapters();
    },
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
  const id = `ch-new-${++state.idSeed}`;
  const next = splitChapterAt(state.chapters, chapterIndex, paragraphIndex, mode, id);
  if (next === state.chapters) {
    toast('这一段无法拆分');
    return;
  }
  state.filter = '';
  els.chapterSearch.value = '';
  commitChapters(next, id, mode === 'title' ? '设为新章标题' : '分章', true);
  // 手机上分章后切回目录，新的章节标题才能获得焦点直接改
  if (isMobileViewport()) setMobileView('chapters');
  toast(mode === 'title' ? '已把这一段设为新章标题，可直接改' : '已从这一段分出新章', {
    label: '撤销',
    onClick: () => {
      undoChapters();
    },
  });
}

function setChapterLevel(index: number) {
  const chapter = state.chapters[index];
  if (!chapter) return;
  const next = toggleChapterLevel(state.chapters, index);
  if (next === state.chapters) return;
  commitChapters(next, chapter.id, '调整章节层级');
  toast(chapter.level === 1 ? '已降为普通章节' : '已升为卷');
}

/* ---------------- 批量替换 / 体检修复 ---------------- */

function currentReplaceOptions(): ReplaceOptions {
  const scope = els.replaceScope.value;
  return {
    find: els.replaceFind.value,
    replace: els.replaceWith.value,
    scope: scope === 'title' || scope === 'body' ? scope : 'all',
    regex: els.replaceRegex.checked,
    caseSensitive: els.replaceCase.checked,
  };
}

function setReplaceStatus(message: string, error = false): void {
  els.replaceStatus.textContent = message;
  els.replaceStatus.classList.toggle('error', error);
}

function resetReplacePanel(): void {
  els.replaceResults.hidden = true;
  els.replaceResults.replaceChildren();
  setReplaceStatus('替换前会自动记录一步，可撤销');
}

function renderReplaceMatches(preview: ReplacePreview): void {
  els.replaceResults.replaceChildren();
  preview.matches.forEach((hit: ReplaceMatch) => {
    const row = document.createElement('div');
    row.className = 'replace-hit';

    const source = document.createElement('span');
    source.className = 'replace-src';
    const position = hit.field === 'title' ? '标题' : `第 ${(hit.paragraphIndex ?? 0) + 1} 段`;
    source.textContent = `${hit.chapterTitle} · ${position}`;

    const text = document.createElement('span');
    text.append(document.createTextNode(hit.before));
    const mark = document.createElement('mark');
    mark.textContent = hit.match;
    text.append(mark, document.createTextNode(hit.after));
    row.append(source, text);
    els.replaceResults.appendChild(row);
  });

  if (preview.truncated) {
    const more = document.createElement('p');
    more.className = 'diag-more';
    more.textContent = `只显示前 ${preview.matches.length} 处，实际命中 ${preview.total} 处`;
    els.replaceResults.appendChild(more);
  }
  els.replaceResults.hidden = false;
}

function runReplacePreview(): void {
  if (!state.chapters.length) {
    setReplaceStatus('先导入一本书再替换', true);
    return;
  }
  const preview = previewReplace(state.chapters, currentReplaceOptions());
  if (!preview.ok) {
    els.replaceResults.hidden = true;
    setReplaceStatus(preview.error ?? '预览失败', true);
    return;
  }
  if (!preview.total) {
    els.replaceResults.hidden = true;
    setReplaceStatus('没有命中，检查一下查找内容或范围', true);
    return;
  }
  setReplaceStatus(`共命中 ${preview.total.toLocaleString('zh-CN')} 处`);
  renderReplaceMatches(preview);
}

function runReplaceApply(): void {
  if (!state.chapters.length) {
    setReplaceStatus('先导入一本书再替换', true);
    return;
  }
  const options = currentReplaceOptions();
  const outcome = applyReplace(state.chapters, options);
  if (!outcome.ok) {
    setReplaceStatus(outcome.error ?? '替换失败', true);
    return;
  }
  if (!outcome.total) {
    setReplaceStatus('没有命中，未做修改', true);
    return;
  }
  // 整次替换只入一步历史，撤销可一次还原
  commitChapters(outcome.chapters, state.activeId ?? outcome.chapters[0]?.id ?? null, '批量替换');
  setReplaceStatus(`已替换 ${outcome.total.toLocaleString('zh-CN')} 处，可撤销`);
  toast(`已替换 ${outcome.total.toLocaleString('zh-CN')} 处`, {
    label: '撤销',
    onClick: () => {
      undoChapters();
    },
  });
  // 替换后刷新预览，方便连续处理剩余命中
  const preview = previewReplace(state.chapters, options);
  if (preview.ok && preview.total) {
    renderReplaceMatches(preview);
  } else {
    els.replaceResults.hidden = true;
  }
}

function renumberByOrder(): void {
  if (!state.chapters.length) return;
  const result = renumberChapters(state.chapters);
  if (!result.changes.length) {
    toast('章号已经是连续的，不需要重编号');
    return;
  }
  // 重编号必须手动触发；只改章号数字，不改标题文字
  commitChapters(result.chapters, state.activeId ?? result.chapters[0]?.id ?? null, '按顺序重编号');
  toast(`已按顺序重编号 ${result.changes.length} 章`, {
    label: '撤销',
    onClick: () => {
      undoChapters();
    },
  });
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
  const batchFormat = EXPORT_FORMATS.includes(els.batchFormat.value as ExportFormat)
    ? (els.batchFormat.value as ExportFormat)
    : 'epub';
  state.exportFormat = batchFormat;
  saveExportFormat(batchFormat);
  els.batchFormat.value = batchFormat;
  els.batchFormat.disabled = true;

  loadEpoch += 1;
  batchArchive = null;
  batchZipPromise = null;
  state.batchItems = files.map((file) => ({ file, title: guessTitle(file.name), status: 'waiting' }));
  state.batchRunning = true;
  state.batchCancelled = false;
  state.busy = true;

  els.dropZone.hidden = true;
  els.guide.hidden = true;
  els.howto.hidden = true;
  els.faq.hidden = true;
  els.privacy.hidden = true;
  els.workspace.hidden = true;
  els.shelf.hidden = true;
  els.batch.hidden = false;
  els.batchClose.disabled = false;
  els.batchClose.textContent = '取消';
  els.batchDownload.disabled = true;
  els.batchStatus.textContent = '正在准备…';

  render.batch();
  void runBatch();
  window.scrollTo(0, 0);
}



async function runBatch() {
  let done = 0;
  for (const item of state.batchItems) {
    if (state.batchCancelled) break;
    if (item.status !== 'waiting') continue;

    item.status = 'parsing';
    render.batch();
    els.batchStatus.textContent = `正在解析：${item.file.name}`;

    try {
      const buffer = await item.file.arrayBuffer();
      const parsed = await call(
        {
          type: 'parse',
          buffer,
          filename: item.file.name,
          options: {
            encoding: 'auto',
            filterAds: els.filterAds.checked,
            rules: state.rules,
            convert: state.convert,
          },
        },
        [buffer],
      );
      if (parsed.type !== 'parsed') throw new Error('解析失败');

      const result = parsed.result;
      item.title = result.titleGuess || guessTitle(item.file.name);
      item.chapters = result.chapters.length;
      item.status = 'packing';
      render.batch();
      els.batchStatus.textContent = `正在生成：${item.title}`;

      if (state.exportFormat !== 'epub') {
        const formatted = buildFormattedBook(
          state.exportFormat,
          result.chapters,
          {
            title: item.title,
            author: result.authorGuess || '',
            language: result.language || 'zh-CN',
          },
          state.layout,
        );
        if (!formatted) throw new Error('没有可以导出的正文');
        item.data = formatted.data;
        item.ext = formatted.ext;
        item.status = 'done';
        done += 1;
        render.batch();
        continue;
      }

      let cover = result.cover ?? null;
      if (!cover) {
        try {
          cover = await generateCover(
            item.title,
            result.authorGuess || '佚名',
            state.layout.coverStyle,
            state.layout.coverOptions,
          );
        } catch {
          cover = null;
        }
      }

      const packed = await call({
        type: 'pack',
        chapters: result.chapters,
        meta: { title: item.title, author: result.authorGuess || '', language: 'zh-CN' },
        layout: state.layout,
        cover,
        font: state.font,
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
    render.batch();
  }

  state.busy = false;
  state.batchRunning = false;
  els.batchFormat.disabled = false;
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
    const ext = item.ext ?? 'epub';
    let name = `${base}.${ext}`;
    let index = 2;
    while (used.has(name)) name = `${base} (${index++}).${ext}`;
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
  els.batchDownload.disabled = true;
  els.batchClose.disabled = false;
  els.batchClose.textContent = '取消';
  showLanding();
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
  setSaveBadge('saving', '保存中…', '正在把改动写入本机草稿');
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
      await saveBookDraft(snapshot, undefined, {
        coverThumb: state.cover ? (state.coverThumb ?? undefined) : null,
      });
      if (epoch !== draftEpoch) return;
      saveLastBookId(snapshot.bookId ?? null);
      const time = new Date(snapshot.savedAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      });
      setDraftStatus(`草稿已自动保存 · ${time}`);
      setSaveBadge('saved', `已保存 ${time}`, '草稿自动保存在这台设备上');
      els.draftStatus.dataset.savedAt = String(snapshot.savedAt);
    } catch (error) {
      if (epoch !== draftEpoch) return;
      setDraftStatus(error instanceof Error ? error.message : '草稿保存失败，可能是存储空间不足', true);
      setSaveBadge('error', '保存失败', '草稿保存失败，可能是存储空间不足');
    }
  });
}

/**
 * 把新书的原始文件与草稿放在同一个事务里写入。
 * 保存失败时最多留下「新草稿 + 旧原文」，恢复时 id 不匹配会被判定为无原文，不会拿去重新识别。
 */
async function persistSourceWithDraft(file: File, fileEpoch: number): Promise<void> {
  try {
    const copy = await file.arrayBuffer();
    if (fileEpoch !== loadEpoch) return;
    const snapshot = draftSnapshot();
    if (!snapshot?.bookId) return;
    const source = { id: snapshot.bookId, name: file.name, data: copy };
    // 原文写入不跟 draftEpoch 绑定：切书 / 进书架时也要把这本新书的原文补上；
    // 删除当前书会等待 draftSaveChain 完成后再删，不会把书「写回来」。
    await enqueueDraftWrite(async () => {
      try {
        const current = draftSnapshot();
        if (current && current.bookId === snapshot.bookId) {
          // 仍停留在本书：顺手把最新草稿一起写入，避免用旧快照覆盖新编辑
          await saveBookDraft(current, source, {
            coverThumb: state.cover ? (state.coverThumb ?? undefined) : null,
          });
          saveLastBookId(current.bookId ?? null);
        } else {
          // 已经切走：旧草稿在切书时已落盘，这里只补原文
          await saveBookSource(source);
        }
      } catch {
        if (fileEpoch === loadEpoch) {
          toast('原始文件没能保存到本地，刷新后需要重新拖入文件');
        }
      }
    });
  } catch {
    if (fileEpoch === loadEpoch) toast('原始文件读取失败，刷新后需要重新拖入文件');
  }
}

function draftSnapshot(): DraftData | null {
  if (!state.parsed || !state.chapters.length || !state.bookId) return null;
  return {
    version: 3,
    bookId: state.bookId,
    savedAt: Date.now(),
    filename: state.filename,
    meta: state.meta,
    chapters: state.chapters,
    layout: state.layout,
    cover: state.cover,
    coverAuto: state.coverAuto,
    activeId: state.activeId,
    options: {
      encoding: els.encoding.value,
      filterAds: els.filterAds.checked,
      convert: state.convert,
    },
    parse: { ...state.parsed, chapters: [], cover: null },
    rules: state.rules,
    rulePreset: state.rulePreset,
    sourceId: state.sourceId ?? undefined,
  };
}

function setDraftStatus(message: string, error = false) {
  els.draftStatus.textContent = message;
  els.draftStatus.classList.toggle('error', error);
}

function setSaveBadge(
  kind: 'idle' | 'saving' | 'saved' | 'error',
  label: string,
  title = '草稿自动保存在这台设备上',
): void {
  els.saveStatus.dataset.state = kind;
  els.saveStatus.textContent = label;
  els.saveStatus.title = title;
}

function applyLoadedBook(loaded: LoadedBook, sourceReady: boolean): void {
  const { draft, book } = loaded;
  state.bookId = book.id;
  state.sourceReady = sourceReady;
  state.sourceId = draft.sourceId ?? null;
  state.filename = draft.filename ?? '';
  state.parsed = { ...draft.parse, chapters: draft.chapters };
  state.chapters = draft.chapters;
  state.meta = draft.meta;
  state.layout = { ...DEFAULT_LAYOUT, ...draft.layout };
  state.cover = draft.cover;
  state.coverAuto = draft.coverAuto;
  state.coverThumb = book.coverThumb;
  state.font = loaded.font;
  state.filter = '';
  state.selectedParagraph = null;
  state.diagDismissed = false;
  state.diagOpen = true;
  state.idSeed = deriveIdSeed(draft.chapters);
  state.rules = draft.rules ?? null;
  state.rulePreset = draft.rulePreset ?? (draft.rules ? 'custom' : 'auto');
  state.convert = draft.options.convert ?? 'none';
  history.clear();
  titleEditBase = null;
  updateHistoryControls();

  const remembered = draft.chapters.find((chapter) => chapter.id === draft.activeId);
  state.activeId =
    remembered?.id ??
    draft.chapters.find((chapter) => chapter.paragraphs.length)?.id ??
    draft.chapters[0]?.id ??
    null;

  showWorkspace();
  els.chapterSearch.hidden = false;
  els.chapterSearch.value = '';
  els.filterAds.checked = draft.options.filterAds;
  els.encoding.value = normalizeEncodingOption(
    draft.options.encoding === 'auto' ? draft.parse.encoding : draft.options.encoding,
  );

  renderRules();
  const warnings = [...draft.parse.warnings];
  if (!sourceReady) {
    warnings.unshift(
      '草稿关联的原始文件缺失或已失效；要换编码或重新识别，请重新拖入同一个文件。',
    );
  }
  render.warnings(warnings);
  recomputeDiagnostics();
  render.all();
  resetReplacePanel();

  const minutes = Math.max(1, Math.round((Date.now() - draft.savedAt) / 60000));
  const when = minutes < 60 ? `${minutes} 分钟前` : new Date(draft.savedAt).toLocaleString('zh-CN');
  setDraftStatus(`已恢复 ${when} 的草稿`);
  const savedTime = new Date(draft.savedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  setSaveBadge('saved', `已保存 ${savedTime}`, '草稿已保存在这台设备上');
  setStatus('已恢复上次的草稿，继续编辑即可');
  scheduleCoverPreview(0);
  saveLastBookId(book.id);
  if (!sourceReady) {
    toast('草稿关联的原始文件缺失，请重新导入同一个文件；也可以在设置里删除这本书');
  }
}

async function openBook(bookId: string, options: { silent?: boolean } = {}): Promise<boolean> {
  if (!bookId) return false;
  const epoch = ++loadEpoch;
  let loaded: LoadedBook | null = null;
  try {
    loaded = await loadBook(bookId);
  } catch (error) {
    toast(error instanceof Error ? error.message : '打开这本书失败，请稍后重试');
    return false;
  }
  if (!loaded) {
    if (!options.silent) toast('这本书的草稿数据不完整，可能已被清理');
    return false;
  }
  if (epoch !== loadEpoch) return false;

  let sourceReady = false;
  if (loaded.source && sourceMatchesDraft(loaded.draft, loaded.source)) {
    try {
      await call(
        { type: 'source', buffer: loaded.source.data, filename: loaded.source.name },
        [loaded.source.data],
      );
      sourceReady = true;
    } catch {
      sourceReady = false;
    }
  }
  if (epoch !== loadEpoch) return false;

  applyLoadedBook(loaded, sourceReady);
  // 迁移来的旧书没有缩略图时按需补一张
  if (!loaded.book.coverThumb && loaded.draft.cover) void refreshCoverThumb();
  if (!options.silent) toast(`已打开「${loaded.book.title}」`);
  return true;
}

async function restoreLastBookOnStart(): Promise<boolean> {
  let books: BookRecord[] = [];
  try {
    books = await listBooks();
  } catch (error) {
    toast(
      error instanceof Error ? `本地书架不可用：${error.message}` : '本地书架不可用，本次只能临时编辑',
      { label: '重试', onClick: () => window.location.reload() },
    );
    return false;
  }
  if (!books.length) return false;

  const remembered = loadLastBookId();
  const target = books.find((book) => book.id === remembered) ?? books[0];
  return openBook(target.id, { silent: true });
}

/* ---------------- 书架 ---------------- */

let shelfToken = 0;

function formatCapacity(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return formatBytes(bytes);
}

async function shelfStorageLabel(): Promise<string> {
  const estimate = await estimateStorage();
  if (!estimate) return '本地书架 · 浏览器未提供容量信息';
  const parts = [`已用 ${formatCapacity(estimate.usage)}`];
  if (estimate.quota) parts.push(`可用 ${formatCapacity(estimate.quota)}`);
  return `本地书架 · ${parts.join(' / ')}`;
}

async function refreshShelf(): Promise<void> {
  const token = ++shelfToken;
  let books: BookRecord[] = [];
  let label = '本地书架';
  try {
    books = await listBooks();
    label = await shelfStorageLabel();
  } catch (error) {
    label = error instanceof Error ? error.message : '本地书架不可用';
  }
  if (token !== shelfToken) return;
  render.shelf(books, label);
}

async function showShelf(): Promise<void> {
  if (state.busy) {
    toast('正在处理，请稍候');
    return;
  }
  // 进入书架前先落盘，卡片上的字数 / 更新时间才是最新的
  cancelScheduledDraftSave();
  await saveDraftNow();
  await refreshShelf();
  els.shelf.hidden = false;
  els.workspace.hidden = true;
  els.dropZone.hidden = true;
  els.guide.hidden = true;
  els.howto.hidden = true;
  els.faq.hidden = true;
  els.privacy.hidden = true;
  els.batch.hidden = true;
  window.scrollTo(0, 0);
}

function closeShelf(): void {
  if (state.parsed) showWorkspace();
  else showLanding();
}

function toggleShelf(): void {
  if (els.shelf.hidden) void showShelf();
  else closeShelf();
}

async function openShelfBook(bookId: string): Promise<void> {
  if (state.busy) {
    toast('正在处理，请稍候');
    return;
  }
  if (bookId === state.bookId) {
    showWorkspace();
    return;
  }
  cancelScheduledDraftSave();
  await saveDraftNow();
  if (await openBook(bookId)) window.scrollTo(0, 0);
}

async function renameShelfBook(bookId: string, title: string): Promise<void> {
  try {
    await renameBookRecord(bookId, title);
    if (bookId === state.bookId) {
      state.meta.title = title.trim();
      els.metaTitle.value = state.meta.title;
      scheduleDraftSave(0);
    }
    await refreshShelf();
    toast('书名已更新');
  } catch {
    toast('重命名失败，请稍后重试');
  }
}

async function deleteShelfBook(bookId: string): Promise<void> {
  const current = state.bookId === bookId;
  const fromShelf = !els.shelf.hidden;
  try {
    if (current) {
      cancelScheduledDraftSave();
      await draftSaveChain;
    }
    await deleteBookRecord(bookId);
    if (loadLastBookId() === bookId) saveLastBookId(null);
    if (current) resetWorkspaceState();
    await refreshShelf();
    toast('已从书架删除');
  } catch {
    toast('删除失败，请稍后重试');
    return;
  }

  if (!current) return;
  const books = await listBooks().catch(() => []);
  if (!books.length) showLanding();
  else if (!fromShelf) await showShelf();
}

function resetWorkspaceState(): void {
  state.parsed = null;
  state.chapters = [];
  state.activeId = null;
  state.meta = { title: '', author: '', language: 'zh-CN' };
  state.cover = null;
  state.coverThumb = null;
  state.coverAuto = true;
  state.font = null;
  state.coverUrl = null;
  state.filter = '';
  state.selectedParagraph = null;
  state.diagnostics = [];
  state.audit = auditChapters([]);
  state.diagDismissed = false;
  state.diagOpen = true;
  state.idSeed = 0;
  state.filename = '';
  state.rules = null;
  state.rulePreset = 'auto';
  state.sourceReady = false;
  state.sourceId = null;
  state.bookId = null;
  history.clear();
  titleEditBase = null;
  updateHistoryControls();
  els.chapterSearch.value = '';
  els.chapterSearch.hidden = true;
  render.warnings([]);
  render.all();
  resetReplacePanel();
}

async function clearDraftStorage(): Promise<void> {
  // 先停止待执行的定时器/空闲回调，再等在途写入完成，最后删掉这本书的书架记录
  cancelScheduledDraftSave();
  await draftSaveChain;
  const bookId = state.bookId;
  if (bookId) {
    await deleteBookRecord(bookId);
    if (loadLastBookId() === bookId) saveLastBookId(null);
  }
  resetWorkspaceState();
}

async function handleClearDraft() {
  try {
    await clearDraftStorage();
    setDraftStatus('草稿已清除');
    toast('已从书架删除这本书');
    const books = await listBooks().catch(() => []);
    if (books.length) await showShelf();
    else showLanding();
  } catch {
    toast('删除失败，请稍后重试');
  }
}

/* ---------------- 事件绑定 ---------------- */

const eventDeps: EventDeps = {
  els,
  state,
  render,
  getMobileView: () => mobileView,
  toggleTheme,
  setMobileView,
  setStatus,
  toast,
  bindGlobalShortcuts: (event) => handleGlobalKeydown(event, shortcutDeps),
  loadFile: (file) => void loadFile(file),
  startBatch,
  reparse: () => void reparse(),
  setRulePreset,
  applyCustomRules,
  exportRules,
  importRules: (file) => void importRules(file),
  exportCurrentBook,
  setExportFormat,
  beginTitleEdit,
  endTitleEdit,
  setActive,
  selectParagraph,
  splitAt,
  deleteChapter,
  mergeUp,
  setChapterLevel,
  undo,
  redo,
  renumberByOrder,
  runReplacePreview,
  runReplaceApply,
  openCoverView,
  closeCoverView,
  scheduleAutoCover,
  scheduleDraftSave,
  stepChapter,
  importFont: (file) => void importFont(file),
  handleClearDraft: () => void handleClearDraft(),
  downloadBatchZip: () => void downloadBatchZip(),
  resetBatch,
  setConvert,
  coverChanged: () => {
    void refreshCoverThumb();
    scheduleCoverPreview(0);
  },
  setCoverOptions,
  removeFont,
  toggleShelf,
  closeShelf,
  openShelfBook: (id) => void openShelfBook(id),
  renameShelfBook: (id, title) => void renameShelfBook(id, title),
  deleteShelfBook: (id) => void deleteShelfBook(id),
};

/* ---------------- 快捷键 ---------------- */

const shortcutDeps: ShortcutDeps = {
  els,
  state,
  closeCoverView,
  selectParagraph,
  hideToast,
  undo,
  redo,
  stepChapter,
  exportBook: exportCurrentBook,
};

/* ---------------- 启动 ---------------- */

applyTheme(themeMode);
setMobileView(mobileView);
render.paintRange(els.lineHeight);
render.paintRange(els.paraGap);
bindEvents(eventDeps);

els.exportAgain.addEventListener('click', () => {
  if (lastExport) download(lastExport.blob, lastExport.filename);
});
els.exportResultClose.addEventListener('click', hideExportResult);

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

const hideInstallEntry = (): void => {
  els.installApp.hidden = true;
  els.installSep.hidden = true;
};

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event as BeforeInstallPromptEvent;
  els.installApp.hidden = false;
  els.installSep.hidden = false;
});

els.installApp.addEventListener('click', () => {
  const prompt = deferredInstallPrompt;
  if (!prompt) return;
  deferredInstallPrompt = null;
  void prompt.prompt();
  hideInstallEntry();
});

window.addEventListener('appinstalled', hideInstallEntry);

initNotice();
render.applyLayoutToPreview();
renderRules();
updateHistoryControls();
void restoreLastBookOnStart().then((restored) => {
  if (restored) toast('已恢复上次未导出的草稿');
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 离线能力不可用不影响主流程 */
    });
  });
}
