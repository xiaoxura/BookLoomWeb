import { extractIntroMeta, findHeadingCandidates, guessTitle } from './core/chapters';
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
  loadBookSource,
  markBookDeleted,
  purgeExpiredDeletedBooks,
  renameBook as renameBookRecord,
  restoreBook,
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
  validateReplaceOptions,
  type ReplaceMatch,
  type ReplaceOptions,
  type ReplacePreview,
} from './core/replace';
import {
  dissolveVolume as dissolveVolumeCore,
  insertChapter,
  insertVolumeAfter,
  mergeChapterUp,
  moveChaptersToVolume as moveChaptersCore,
  removeChapterAt,
  editParagraphAt,
  deleteParagraphAt as removeParagraphAt,
  insertParagraphAfter as addParagraphAfter,
  setVolumeFromParagraph as setVolumeFromParagraphCore,
  splitChapterAt,
  suggestChapterTitle,
} from './core/edit';
import { hideNoticeBanner, initNotice } from './notice';
import type { Chapter, ConvertMode, CoverAuthorPosition, CoverPalette, ParseResult } from './types';
import {
  download,
  exportBook as exportBookAction,
  formatBytes,
  sanitizeFilename,
  toArrayBuffer,
} from './app/export';
import { els } from './app/dom';
import { createRenderer } from './app/render';
import { beginModal } from './app/modal';
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
  saveListPageSize,
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
  syncHash();
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
      const kind =
        state.parsed?.sourceType === 'epub'
          ? 'EPUB'
          : state.parsed?.sourceType === 'docx'
            ? 'DOCX'
            : 'TXT';
      setStatus(`处理过程意外中断：${error.message}`, 'error');
      render.controls();
      toast(`后台线程已重置，请重试；重新读入需要重新拖入原文件（当前是 ${kind}）`);
    },
  },
);

function call(payload: RequestPayload, transfer: Transferable[] = [], timeoutMs = 0): Promise<FromWorker> {
  return workerClient.call(payload, transfer, timeoutMs);
}

/* ---------------- 状态与渲染 ---------------- */










function stepChapter(delta: -1 | 1) {
  const index = state.chapters.findIndex((chapter) => chapter.id === state.activeId);
  if (index < 0) return;
  const next = state.chapters[index + delta];
  if (!next) return;
  // 从搜索定位跳出后继续切章：清掉搜索态，让目录回到完整列表跟随高亮
  if (state.filter) {
    state.filter = '';
    els.chapterSearch.value = '';
    render.list();
  }
  setActive(next.id);
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




let coverModalCleanup: (() => void) | null = null;

function openCoverView() {
  if (!state.coverUrl) return;
  els.coverViewImg.src = state.coverUrl;
  els.coverView.hidden = false;
  document.body.style.overflow = 'hidden';
  coverModalCleanup = beginModal(els.coverView);
  els.coverViewClose.focus();
}

function closeCoverView(restoreFocus = false) {
  if (els.coverView.hidden) return;
  els.coverView.hidden = true;
  document.body.style.overflow = '';
  coverModalCleanup?.();
  coverModalCleanup = null;
  if (restoreFocus) els.coverThumb.focus();
}






function setStatus(message: string, kind: 'normal' | 'error' = 'normal') {
  els.status.textContent = message;
  els.status.classList.toggle('error', kind === 'error');
  // 右栏底部的状态小字同步显示，导出结果不用打开弹窗也能看到
  els.railStatus.textContent = message;
  els.railStatus.classList.toggle('error', kind === 'error');
}

let dropLoading = false;

/** 解析中给一个取消入口：取消 = 忽略本次结果 + 终止后台任务，当前书保持原样 */
const cancelLoadButton = document.createElement('button');
cancelLoadButton.type = 'button';
cancelLoadButton.className = 'ghost small';
cancelLoadButton.textContent = '取消';
cancelLoadButton.addEventListener('click', () => cancelActiveLoad());
els.dropLoading.appendChild(cancelLoadButton);

let activeLoadCancelled = false;

function cancelActiveLoad(): void {
  if (!dropLoading) return;
  activeLoadCancelled = true;
  loadEpoch += 1;
  workerClient.cancelAll(new Error('已取消'));
}

function setDropLoading(active: boolean, phase?: string): void {
  dropLoading = active;
  els.dropZone.classList.toggle('is-loading', active);
  els.dropZone.setAttribute('aria-busy', active ? 'true' : 'false');
  els.dropLoading.hidden = !active;
  cancelLoadButton.hidden = !active;
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
  // 带动作的提示给 10 秒；悬停 / 触摸按住时暂停计时，读得完再走
  toastTimer = window.setTimeout(hideToast, action ? 10000 : 3200);
}

els.toast.addEventListener('mouseenter', () => window.clearTimeout(toastTimer));
els.toast.addEventListener('mouseleave', () => {
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, 1600);
});

/* ---------------- 确认对话框 ---------------- */

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** 轻量确认框：覆盖手动校对这类破坏性操作前使用；Esc / 点空白 = 取消 */
function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.style.zIndex = '300';

    const card = document.createElement('div');
    card.className = 'shortcuts-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', options.title);

    const heading = document.createElement('h2');
    heading.textContent = options.title;
    const body = document.createElement('p');
    body.className = 'hint';
    body.style.marginTop = '10px';
    body.style.lineHeight = '1.7';
    body.textContent = options.message;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px;';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ghost';
    cancel.textContent = options.cancelLabel ?? '取消';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = options.danger ? 'danger' : 'primary';
    ok.textContent = options.confirmLabel ?? '确定';
    row.append(cancel, ok);

    card.append(heading, body, row);
    overlay.append(card);
    document.body.append(overlay);

    const settle = (result: boolean) => {
      cleanup();
      overlay.remove();
      resolve(result);
    };
    const cleanup = beginModal(card);
    cancel.addEventListener('click', () => settle(false));
    ok.addEventListener('click', () => settle(true));
    ok.focus();
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) settle(false);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        settle(false);
      }
    });
  });
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
  // 只收起首访提示条，不标记已读：用户没点开过公告，下次进入仍应看到
  hideNoticeBanner();
  // 校对章节是导入后的主任务，手机上先给目录，预览随时可切
  setMobileView('chapters');
  syncHash();
}

/** 落地页的导入失败信息：写在常驻错误块里，不会随 toast 消失 */
function showImportError(message: string): void {
  els.importErrorText.textContent = message;
  els.importError.hidden = false;
}

function hideImportError(): void {
  els.importError.hidden = true;
  lastAttemptFile = null;
}

let lastAttemptFile: File | null = null;

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
  syncHash();
}

function setActive(id: string | null) {
  state.activeId = id;
  state.selectedParagraph = null;
  document.querySelectorAll<HTMLElement>('.chapter-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.id === id);
  });
  ensureActiveRowVisible(id);
  render.preview();
  if (id && isMobileViewport() && mobileView !== 'preview') setMobileView('preview', true);
}

/**
 * 让左侧列表的高亮行一定可见：
 * - 高亮行不在渲染窗口里（长书跳章）→ 把窗口挪到覆盖当前章后再重渲染；
 * - 行存在 → 滚动列表使其进入可视区，视觉上「左侧跟着切换」。
 */
function ensureActiveRowVisible(id: string | null): void {
  if (!id) return;
  const index = state.chapters.findIndex((chapter) => chapter.id === id);
  if (index < 0) return;
  const row = Array.from(els.chapterList.querySelectorAll<HTMLElement>('.chapter-row')).find(
    (item) => item.dataset.id === id,
  );
  if (!row) {
    if (state.filter.trim()) return; // 搜索态下高亮行就是命中行本身
    state.listWindowStart = Math.max(
      0,
      Math.min(index - 200, Math.max(0, state.chapters.length - 400)),
    );
    render.list();
  }
  requestAnimationFrame(() => {
    const target = Array.from(
      els.chapterList.querySelectorAll<HTMLElement>('.chapter-row'),
    ).find((item) => item.dataset.id === id);
    target?.scrollIntoView({ block: 'nearest' });
  });
}

/** 目录窗口门牌：回到开头 / 定位当前章 */
function jumpListWindow(mode: 'top' | 'active' | 'prev' | 'next'): void {
  if (mode === 'top') {
    state.listWindowStart = 0;
    render.list();
    els.chapterList.scrollTop = 0;
    return;
  }
  if (mode === 'next') {
    // 翻到下一页，从页头继续浏览
    state.listWindowStart += state.listPageSize;
    render.list();
    els.chapterList.scrollTop = 0;
    return;
  }
  if (mode === 'prev') {
    // 翻回上一页
    state.listWindowStart = Math.max(0, state.listWindowStart - state.listPageSize);
    render.list();
    els.chapterList.scrollTop = 0;
    return;
  }
  const id = state.activeId;
  if (id) {
    ensureActiveRowVisible(id);
    flashChapterRow(id);
  } else {
    state.listWindowStart = 0;
    render.list();
  }
}

/** 改目录每页章数；保持用户正看到的第一章在在可视页内 */
function setListPageSize(size: number): void {
  if (![100, 200, 400, 800].includes(size)) return;
  const firstShown = state.listWindowStart;
  state.listPageSize = size;
  saveListPageSize(size);
  state.listWindowStart = Math.floor(firstShown / size) * size;
  render.list();
}

/* ---------------- 批量移动模式 ---------------- */

function setMultiMode(on: boolean): void {
  state.multiMode = on;
  state.multiSelect = [];
  if (on) selectParagraph(null);
  render.list();
  els.multiToggle.setAttribute('aria-pressed', String(on));
  if (on) toast('多选模式：点章节行勾选（卷本身不参与移动），选好后按「移动到卷…」');
}

function toggleMultiSelect(id: string): void {
  if (!id) return;
  const chapter = state.chapters.find((item) => item.id === id);
  if (!chapter || chapter.level === 1) return; // 卷是文件夹，不参与移动
  const next = state.multiSelect.includes(id)
    ? state.multiSelect.filter((item) => item !== id)
    : [...state.multiSelect, id];
  state.multiSelect = next;
  render.list();
}

function selectAllVisible(): void {
  const ids = Array.from(els.chapterList.querySelectorAll<HTMLElement>('.chapter-row'))
    .map((row) => row.dataset.id)
    .filter((id): id is string => Boolean(id))
    .filter((id) => {
      const chapter = state.chapters.find((item) => item.id === id);
      return chapter?.level === 2;
    });
  state.multiSelect = Array.from(new Set([...state.multiSelect, ...ids]));
  render.list();
}

/** 跳转定位后给目标行一个短暂的高亮闪烁，让「跳过来了」看得见 */
function flashChapterRow(id: string): void {
  requestAnimationFrame(() => {
    const row = Array.from(els.chapterList.querySelectorAll<HTMLElement>('.chapter-row')).find(
      (item) => item.dataset.id === id,
    );
    if (!row?.animate) return;
    row.scrollIntoView({ block: 'nearest' });
    row.animate(
      [
        { outline: '2px solid rgba(214, 134, 61, 0.95)', outlineOffset: '-2px' },
        { outline: '2px solid rgba(214, 134, 61, 0)', outlineOffset: '-2px' },
      ],
      { duration: 1200, easing: 'ease-out' },
    );
  });
}

function revealChapter(id: string): void {
  setActive(id);
  if (isMobileViewport()) return;
  flashChapterRow(id);
}

/** 第一次进工作区时提示一次行内操作，之后不再打扰 */
function maybeShowRowHint(): void {
  try {
    if (localStorage.getItem('txt2book.rowHintSeen') === '1') return;
    localStorage.setItem('txt2book.rowHintSeen', '1');
  } catch {
    return;
  }
  window.setTimeout(() => {
    toast('提示：点章节名可以改标题，行尾「⋯」里有全部操作');
  }, 1500);
}

interface ApplyResultOptions {
  /** 重新应用设置时保留用户改过的书名 / 作者 / 封面 */
  preserveMeta?: boolean;
  /** 重新解析后按原下标恢复当前章节 */
  activeIndex?: number;
}

/** 卷首简介识别成功后，状态栏补一句提示，告诉你信息去了哪里 */
const recommendedIntroSuffix = '；卷首简介已自动填入「设置 - 书籍信息」';

function applyResult(result: ParseResult, options: ApplyResultOptions = {}) {
  const preservedMeta = options.preserveMeta ? { ...state.meta } : null;
  const preservedCover = options.preserveMeta
    ? { cover: state.cover, coverAuto: state.coverAuto, coverThumb: state.coverThumb }
    : null;

  state.sourceReady = true;
  state.parsed = result;
  state.chapters = result.chapters;

  // 卷首信息章（『占有者/状态：已完结』『内容简介:…』）→ 填进书籍信息并隐藏该章
  let chapters = result.chapters;
  if (!options.preserveMeta) {
    const intro = extractIntroMeta(chapters);
    state.meta.description = intro.meta.description;
    state.meta.status = intro.meta.status;
    chapters = intro.remaining;
    if (intro.meta.description || intro.meta.status) {
      state.chapters = chapters;
    }
  }

  const indexed = options.activeIndex === undefined ? undefined : chapters[options.activeIndex];
  state.activeId =
    indexed?.id ??
    chapters.find((chapter) => chapter.paragraphs.length)?.id ??
    chapters[0]?.id ??
    null;
  // 新书 / 重新识别的结果与旧历史无关
  history.clear();
  titleEditBase = null;
  state.filter = '';
  state.selectedParagraph = null;
  state.idSeed = 0;
  state.listWindowStart = 0;
  state.multiSelect = [];
  state.multiMode = false;
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
  const introNotice =
    state.meta.description || state.meta.status ? recommendedIntroSuffix : '';
  setStatus(
    fromEpub
      ? `已读入 EPUB · ${chapters.length} 章`
      : fromDocx
        ? `已读入 DOCX · ${chapters.length} 章`
        : `识别完成 · ${chapters.length} 章${introNotice}`,
  );
  updateHistoryControls();
  scheduleDraftSave(300);
  if (!state.cover) scheduleAutoCover();
  scheduleCoverPreview(0);
}

/** 分片读取文件，顺带把真实读取进度报到加载区 */
async function readFileWithProgress(file: File): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const step = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += step) {
    const slice = file.slice(offset, Math.min(offset + step, file.size));
    const buffer = await slice.arrayBuffer();
    chunks.push(new Uint8Array(buffer));
    const percent = Math.min(100, Math.round(((offset + buffer.byteLength) / file.size) * 100));
    setDropLoading(true, `正在读取「${file.name}」… ${percent}%`);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out.buffer;
}

/** 书架快占满时提前打招呼，免得导入/保存悄悄失败 */
async function warnIfStorageTight(fileSize: number): Promise<void> {
  try {
    const estimate = await estimateStorage();
    if (!estimate?.quota) return;
    const remaining = estimate.quota - estimate.usage;
    if (remaining <= 0 || (estimate.usage / estimate.quota > 0.85 && fileSize > remaining)) {
      toast('本机存储空间快用完了，建议去书架删掉不看的书释放空间');
    }
  } catch {
    /* 容量信息拿不到就算了 */
  }
}

async function loadFile(file: File) {
  if (state.busy) {
    toast('正在处理，请稍候');
    return;
  }
  if (file.size > 80 * 1024 * 1024) {
    const message = '文件超过 80MB，浏览器内存可能不够；请拆分后分次导入，或用批量转换';
    setStatus(message, 'error');
    toast(message);
    if (els.dropZone.hidden) showLanding();
    return;
  }

  hideImportError();
  lastAttemptFile = file;
  // 换书前先把当前这本的改动落盘，避免旧书丢失最后一次编辑
  cancelScheduledDraftSave();
  await saveDraftNow();
  void warnIfStorageTight(file.size);

  const epoch = ++loadEpoch;
  activeLoadCancelled = false;
  state.busy = true;
  els.export.disabled = true;
  els.railExport.disabled = true;
  els.reparse.disabled = true;
  // 新书默认重新自动检测，不能沿用上一本手动选的编码
  els.encoding.value = 'auto';
  setStatus('正在读取文件…');
  setDropLoading(true, `正在读取「${file.name}」…`);

  try {
    const buffer = await readFileWithProgress(file);
    setDropLoading(true, '正在解析章节…');
    const res = await call(
      { type: 'parse', buffer, filename: file.name, options: parseOptions() },
      [buffer],
      120_000,
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
    lastAttemptFile = null;
    showWorkspace();
    window.scrollTo(0, 0);
    applyResult(res.result);
    maybeShowRowHint();
    if (isMobileViewport()) {
      toast(`已识别 ${res.result.chapters.length} 章，可在目录里校对`, {
        label: '看预览',
        onClick: () => setMobileView('preview', true),
      });
    } else {
      toast(`已识别 ${res.result.chapters.length} 章，校对后点右侧「导出」生成电子书`);
    }
    saveLastBookId(state.bookId);
    void persistSourceWithDraft(file, epoch);
  } catch (error) {
    if (activeLoadCancelled) {
      toast('已取消导入，当前书保持原样');
      void restoreWorkerSource();
    } else {
      const message = error instanceof Error ? error.message : '解析失败';
      setStatus(message, 'error');
      toast(`解析失败：${message}`);
      // 落地页上给一个不会消失的错误块，说明原因并提供重试入口
      if (!els.dropZone.hidden) showImportError(`解析「${file.name}」失败：${message}`);
    }
  } finally {
    setDropLoading(false);
    state.busy = false;
    render.controls();
  }
}

/** 取消/批量之后把当前书的原文塞回 Worker，保住「重新识别」能力 */
async function restoreWorkerSource(): Promise<void> {
  if (!state.bookId) return;
  try {
    const source = await loadBookSource(state.bookId);
    if (!source || !sourceMatchesDraft(draftSnapshot(), source)) return;
    await call({ type: 'source', buffer: source.data, filename: source.name }, [source.data], 15_000);
  } catch {
    state.sourceReady = false;
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
        ? '草稿没有原文件，重新拖入原文件后才能应用繁简转换'
        : '草稿没有可用的原文件，重新拖入原文件后才能换编码或重新识别',
    );
    return;
  }
  // 有手动校对时先确认：重新识别/转换会把分章、合并、删除、改名全部覆盖
  if (history.canUndo) {
    const ok = await confirmDialog({
      title: options.conversion ? '繁简转换会覆盖手动校对' : '重新识别会覆盖手动校对',
      message:
        '这一步会丢弃你手动做过的分章、合并、删除和改标题（改标题也会被还原），建议先导出一份备份。要继续吗？',
      confirmLabel: options.conversion ? '继续转换' : '重新识别',
      danger: true,
    });
    if (!ok) return;
  }
  state.busy = true;
  render.controls();
  setStatus(`正在${reading}…`);
  const activeIndex = state.chapters.findIndex((chapter) => chapter.id === state.activeId);
  try {
    const res = await call({ type: 'reparse', options: parseOptions() }, [], 120_000);
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
      toast('已按新的设置重新识别');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : `${reading}失败`;
    setStatus(message, 'error');
    toast(`${reading}失败：${message}`);
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
    toast('草稿没有原文件，重新拖入原文件后才能应用繁简转换');
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
  state.editingParagraph = null;
  render.stats();
  render.list();
  render.preview();
  render.controls();
  ensureActiveRowVisible(activeId);
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
  if (chapter.level === 1) {
    toast('卷是文件夹没有正文；要移除卷请用「取消分卷」，章节会自动归属上一个卷');
    return;
  }
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

/* ---------------- 正文段落：新增 / 编辑 / 删除 ---------------- */

/** 保存编辑器里的段落内容；没变化时安静退出编辑态 */
function editParagraphFrom(textarea: HTMLTextAreaElement): void {
  if (textarea.dataset.done === '1') return;
  textarea.dataset.done = '1';
  const chapterIndex = state.chapters.findIndex((c) => c.id === state.activeId);
  const paragraphIndex = Number(textarea.dataset.index);
  if (chapterIndex < 0 || !Number.isFinite(paragraphIndex)) {
    cancelParagraphEdit();
    return;
  }
  if (textarea.dataset.cancel === '1') {
    cancelParagraphEdit();
    return;
  }
  const text = textarea.value;
  const original = textarea.dataset.original ?? '';
  if (text === original) {
    cancelParagraphEdit();
    return;
  }
  const next = editParagraphAt(state.chapters, chapterIndex, paragraphIndex, text);
  commitChapters(next, state.activeId ?? '', '编辑正文');
}

function cancelParagraphEdit(): void {
  if (!state.editingParagraph) return;
  state.editingParagraph = null;
  render.preview();
}

function beginParagraphEdit(chapterIndex: number, paragraphIndex: number): void {
  const chapter = state.chapters[chapterIndex];
  if (!chapter) return;
  state.editingParagraph = { chapterId: chapter.id, paragraphIndex };
  const chapterId = chapter.id;
  if (state.activeId !== chapterId) {
    state.activeId = chapterId;
    render.list();
  }
  render.preview();
}

function insertParagraph(chapterIndex: number, afterIndex: number): void {
  const chapter = state.chapters[chapterIndex];
  if (!chapter) return;
  const { chapters: next, paragraphIndex } = addParagraphAfter(
    state.chapters,
    chapterIndex,
    afterIndex,
  );
  if (paragraphIndex < 0) return;
  commitChapters(next, chapter.id, '新增段落');
  // commit 已把编辑态清掉 → 直接挂新空段并重渲染（同步两步，避免 rAF 竞态）
  state.editingParagraph = { chapterId: chapter.id, paragraphIndex };
  if (state.activeId === chapter.id) render.preview();
}

function deleteParagraph(paragraphIndex: number, chapterIndex: number): void {
  const chapter = state.chapters[chapterIndex];
  if (!chapter) return;
  const result = removeParagraphAt(state.chapters, chapterIndex, paragraphIndex);
  if (result.chapters === state.chapters) return;
  const nextActiveId = result.removedChapter
    ? state.chapters[chapterIndex - 1]?.id ??
      state.chapters[chapterIndex + 1]?.id ??
      ''
    : chapter.id;
  commitChapters(result.chapters, nextActiveId, '删除段落');
  toast(result.removedChapter ? '段落删空后这一章也一并移除了' : '已删除这一段', {
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

/* ---------------- 卷 / 章节结构操作 ---------------- */

function newId(): string {
  return `ch-new-${++state.idSeed}`;
}

/** 在某章前 / 后插入空白章节，等待用户改标题、填正文（手动补章） */
function insertChapterAt(index: number, position: 'before' | 'after'): void {
  const anchor = state.chapters[index];
  if (!anchor) return;
  const next = insertChapter(state.chapters, index, position, newId());
  if (next === state.chapters) return;
  const createdIndex = position === 'before' ? index : index + 1;
  const created = next[createdIndex];
  commitChapters(next, created.id, '新建章节', true);
  toast(position === 'before' ? '已在前面插入新章节，直接改标题' : '已在后面插入新章节，直接改标题');
}

/** 在某章后新建一个空卷文件夹；章节进卷用「多选」批量移动 */
function addVolumeAfter(index: number): void {
  const anchor = state.chapters[index];
  if (!anchor) return;
  const volumeId = newId();
  const next = insertVolumeAfter(state.chapters, index, volumeId);
  if (next === state.chapters) return;
  commitChapters(next, volumeId, '新建卷');
  toast('新卷是空文件夹；点「多选」勾选章节后可批量移动进来', { label: '开始多选', onClick: () => setMultiMode(true) });
}

/** 取消分卷：卷标题行删掉，其下章节按顺序归属上一个卷（或成为顶层） */
function dissolveVolumeAt(index: number): void {
  const volume = state.chapters[index];
  if (!volume || volume.level !== 1) return;
  const next = dissolveVolumeCore(state.chapters, index);
  if (next === state.chapters) return;
  const follow = next[index] && next[index].level === 2 ? next[index].id : null;
  commitChapters(next, follow ?? next[index]?.id ?? state.activeId, '取消分卷');
  toast(`已取消「${volume.title}」，下面的章节归属上一个卷`);
}

/** 段落选择条「设为卷名」：选中行成为新卷，重新归组到下一个卷之前的章节 */
function setVolumeAt(chapterIndex: number, paragraphIndex: number): void {
  const chapter = state.chapters[chapterIndex];
  if (!chapter) return;
  if (paragraphIndex === 0) {
    toast('这一段是本章标题行；要建卷请选它之后的段落');
    return;
  }
  const volumeId = newId();
  const remainderId = newId();
  const next = setVolumeFromParagraphCore(state.chapters, chapterIndex, paragraphIndex, volumeId, remainderId);
  if (!next) {
    toast('这段不能设为卷名');
    return;
  }
  commitChapters(next, volumeId, '设为卷名');
  toast(`已把「${next[chapterIndex + 1].title}」设为卷，直到下一个卷为止的章节都归它管`);
}

/* ---------------- 批量移动章节 ---------------- */

const MOVE_DIALOG_MAX = 80;

/** 打开「移动到卷…」对话框：列出所有卷 + 顶层，确认后用 core.moveChaptersToVolume 重排 */
function startMove(indexes: number[]): void {
  const targets = indexes
    .filter((index) => index >= 0 && index < state.chapters.length)
    .map((index) => state.chapters[index])
    .filter((chapter) => chapter.level === 2);
  if (!targets.length) {
    toast('先在章节行上选择要移动的章节（卷本身就是文件夹，不需要移动）');
    return;
  }
  const volumes = state.chapters.filter((chapter) => chapter.level === 1);
  if (!volumes.length) {
    toast('这本书还没有卷；先在某章后「新建卷」，再移动章节进去');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.style.zIndex = '300';
  const card = document.createElement('div');
  card.className = 'shortcuts-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '移动章节到卷');

  const heading = document.createElement('h2');
  heading.textContent = `把 ${targets.length} 章移动到…`;
  const body = document.createElement('div');
  body.style.cssText = 'margin-top:12px;max-height:min(52vh,420px);overflow:auto;display:grid;gap:6px;';
  for (const volume of volumes.slice(0, MOVE_DIALOG_MAX)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.style.justifyContent = 'space-between';
    button.textContent = `「${volume.title}」`;
    button.dataset.volume = volume.id;
    body.appendChild(button);
  }

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = '取消';
  row.append(cancel);

  card.append(heading, body, row);
  overlay.append(card);
  document.body.append(overlay);
  const cleanup = beginModal(card);
  const settle = (volumeId: string | null): void => {
    cleanup();
    overlay.remove();
    if (volumeId) moveTargetsToVolume(targets.map((chapter) => chapter.id), volumeId);
  };
  body.querySelectorAll<HTMLButtonElement>('button[data-volume]').forEach((button) => {
    button.addEventListener('click', () => settle(button.dataset.volume ?? null));
  });
  cancel.addEventListener('click', () => settle(null));
  body.querySelector<HTMLButtonElement>('button[data-volume]')?.focus();
}

/** 「移动到其他卷…」单章 / 批量共用入口 */
function moveTargetsToVolume(ids: string[], volumeId: string | null): void {
  const targetVolume = state.chapters.find((chapter) => chapter.id === volumeId) ?? null;
  const next = moveChaptersCore(state.chapters, ids, volumeId);
  if (next === state.chapters) {
    toast('这些章节已经在目标卷里，顺序没有变化');
    return;
  }
  commitChapters(next, state.activeId ?? next[0]?.id ?? null, '批量移动章节');
  toast(`已把 ${ids.length} 章移动到「${targetVolume?.title ?? '顶层'}」`);
}

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
  setReplaceBusy(false);
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

function setReplaceBusy(busy: boolean): void {
  els.replacePreview.disabled = busy;
  els.replaceApply.disabled = busy;
}

/** 交给 UI 的轻校验：输入时即时提示，不用等点「预览」才发现正则写错了 */
function validateReplaceInput(): void {
  if (!state.chapters.length) return;
  const message = validateReplaceOptions(currentReplaceOptions());
  if (message) {
    els.replaceResults.hidden = true;
    setReplaceStatus(message, true);
    setReplaceBusy(true);
    return;
  }
  setReplaceBusy(false);
  const options = currentReplaceOptions();
  if (options.regex && options.find) setReplaceStatus('正则可用，点「预览命中」查看结果');
  else if (els.replaceStatus.classList.contains('error')) setReplaceStatus('替换前会自动记录一步，可撤销');
}

function validateRuleInput(): void {
  const raw = els.ruleJson.value.trim();
  if (!raw) {
    showRuleError(null);
    els.ruleApply.disabled = false;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    showRuleError(`JSON 解析失败：${error instanceof Error ? error.message : '格式不正确'}`);
    els.ruleApply.disabled = true;
    return;
  }
  const message = validateRuleSpec(parsed);
  if (message) {
    showRuleError(message);
    els.ruleApply.disabled = true;
    return;
  }
  showRuleError(null);
  els.ruleApply.disabled = false;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

async function runReplacePreview(): Promise<void> {
  if (replaceBusy) return;
  if (!state.chapters.length) {
    setReplaceStatus('先导入一本书再替换', true);
    return;
  }
  // 大书 + 正则回溯时扫描可能要几秒：先给反馈并挡住重复点击
  replaceBusy = true;
  setReplaceBusy(true);
  setReplaceStatus('正在扫描…');
  await nextFrame();
  try {
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
  } finally {
    replaceBusy = false;
    setReplaceBusy(false);
  }
}

let replaceBusy = false;

async function runReplaceApply(): Promise<void> {
  if (replaceBusy) return;
  if (!state.chapters.length) {
    setReplaceStatus('先导入一本书再替换', true);
    return;
  }
  replaceBusy = true;
  setReplaceBusy(true);
  setReplaceStatus('正在替换…');
  await nextFrame();
  try {
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
  } finally {
    replaceBusy = false;
    setReplaceBusy(false);
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
  syncHash();
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
        120_000,
      );
      if (parsed.type !== 'parsed') throw new Error('解析失败');

      const result = parsed.result;
      item.title = result.titleGuess || guessTitle(item.file.name);
      item.chapters = result.chapters.length;
      item.status = 'packing';
      render.batch();
      els.batchStatus.textContent = `正在生成：${item.title}`;

      if (state.exportFormat !== 'epub') {
        // 非 EPUB 的构建也放进 Worker，避免大书卡住界面
        const formatted = await call(
          {
            type: 'format',
            format: state.exportFormat,
            chapters: result.chapters,
            meta: {
              title: item.title,
              author: result.authorGuess || '',
              language: result.language || 'zh-CN',
            },
            layout: state.layout,
          },
          [],
          60_000,
        );
        if (formatted.type !== 'formatted') throw new Error('没有可以导出的正文');
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

      const packed = await call(
        {
          type: 'pack',
          chapters: result.chapters,
          meta: { title: item.title, author: result.authorGuess || '', language: 'zh-CN' },
          layout: state.layout,
          cover,
          font: state.font,
          version: state.epubVersion,
        },
        [],
        60_000,
      );
      if (packed.type !== 'packed') throw new Error('打包失败');

      item.data = packed.data;
      item.status = 'done';
      done += 1;
    } catch (error) {
      item.status = 'error';
      item.message = state.batchCancelled
        ? '已取消'
        : error instanceof Error
          ? error.message
          : '转换失败';
    }
    render.batch();
  }

  state.busy = false;
  state.batchRunning = false;
  els.batchFormat.disabled = false;
  els.batchClose.disabled = false;
  els.batchClose.textContent = '返回';
  render.batch();

  const failed = state.batchItems.filter((item) => item.status === 'error').length;
  if (state.batchCancelled) {
    els.batchStatus.textContent = `已取消，完成 ${done} 本${failed ? `，失败 ${failed} 本可重试` : ''}`;
  } else if (done > 0) {
    // 不自动下载：给用户选择权（只要 ZIP 或逐本重转），点「下载 ZIP」手动触发
    els.batchStatus.textContent = `完成 ${done} 本${failed ? `，失败 ${failed} 本` : ''}；点「下载 ZIP」保存，浏览器拦截下载时再点一次`;
    els.batchDownload.disabled = done === 0;
  } else {
    els.batchStatus.textContent = failed
      ? `全部失败；每行右侧可查看原因并重试`
      : '没有成功转换的文件';
    els.batchDownload.disabled = true;
  }
  // 批量解析会覆盖 Worker 里当前书的原文，恢复一下保住「重新识别」
  void restoreWorkerSource();
}

/** 重试批量转换里所有失败的项 */
function retryBatch(): void {
  if (state.batchRunning || state.busy) return;
  const failed = state.batchItems.filter((item) => item.status === 'error');
  if (!failed.length) return;
  for (const item of failed) {
    item.status = 'waiting';
    item.message = undefined;
    item.data = undefined;
    item.chapters = undefined;
  }
  state.batchRunning = true;
  state.batchCancelled = false;
  state.busy = true;
  els.batchFormat.disabled = true;
  els.batchClose.disabled = false;
  els.batchClose.textContent = '取消';
  els.batchDownload.disabled = true;
  els.batchStatus.textContent = `正在重试 ${failed.length} 本…`;
  render.batch();
  void runBatch();
}

/** 让「取消」立即中断正在处理的一本，而不是等它解析完 */
function cancelBatch(): void {
  if (!state.batchRunning) return;
  workerClient.cancelAll(new Error('已取消'));
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
      const res = await call({ type: 'zip', files }, [], 60_000);
      if (res.type !== 'zipped') throw new Error('打包失败');
      const archive: BatchArchive = {
        blob: new Blob([toArrayBuffer(res.data)], { type: 'application/zip' }),
        name: `BookLoom-${count}本.zip`,
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
  els.batchStatus.textContent = `已打包 ${archive.name}（${formatBytes(archive.blob.size)}）；逐本下载已并入 ZIP`;
  render.batch();
}

/** 单独下载批量转换里某一本的成品（ZIP 打包会复用字节，打包后即释放） */
function downloadBatchItem(index: number): void {
  const item = state.batchItems[index];
  if (!item?.data || item.status !== 'done') return;
  const ext = item.ext ?? 'epub';
  const mime =
    ext === 'epub'
      ? 'application/epub+zip'
      : ext === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : ext === 'md'
          ? 'text/markdown;charset=utf-8'
          : ext === 'html'
            ? 'text/html;charset=utf-8'
            : 'text/plain;charset=utf-8';
  download(new Blob([toArrayBuffer(item.data)], { type: mime }), `${sanitizeFilename(item.title)}.${ext}`);
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
  // 还有打开着的书就回工作区，和 closeShelf 行为一致，别把人踹回落地页
  if (state.parsed) showWorkspace();
  else showLanding();
}

/* ---------------- 识别规则 ---------------- */

function renderRules() {
  els.rulePreset.value = state.rulePreset;
  els.ruleJson.value = state.rules ? JSON.stringify(state.rules, null, 2) : '';
  showRuleError(null);
}

function showRuleError(message: string | null) {
  els.ruleError.hidden = !message;
  els.ruleError.textContent = message ?? '';
}

function setRulePreset(id: string) {
  if (id === 'custom') {
    els.ruleJson.focus();
    return;
  }
  state.rulePreset = id;
  state.rules = id === 'auto' ? null : getPreset(id);
  els.ruleJson.value = state.rules ? JSON.stringify(state.rules, null, 2) : '';
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
  download(blob, 'BookLoom-rules.json');
  toast('规则已导出');
}

async function importRules(file: File) {
  try {
    const text = await file.text();
    els.ruleJson.value = text;
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
  // 「保存中…」等到真正落盘前再显示，连续编辑时徽标不会来回闪
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
      setSaveBadge('saving', '保存中…', '正在把改动写入本机草稿');
      void saveDraftNow(epoch);
    };
    if (typeof window.requestIdleCallback === 'function') {
      draftIdle = window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      run();
    }
  }, delay);
}

let persistRequested = false;

/** 保存成功后申请持久化存储，降低浏览器自动清理草稿的概率 */
function requestPersistentStorage(): void {
  if (persistRequested) return;
  persistRequested = true;
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* 不支持就算了 */
  }
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
      requestPersistentStorage();
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
      const reason = error instanceof Error ? error.message : '存储空间可能不足';
      setDraftStatus(`草稿保存失败（${reason}）。点上方「保存失败」可重试；也可以导出一份备份，或到书架删除不看的书释放空间`, true);
      setSaveBadge('error', '保存失败', '点这里重试保存');
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
          toast('原文件没能保存到本地，刷新后需要重新拖入文件');
        }
      }
    });
  } catch {
    if (fileEpoch === loadEpoch) toast('原文件读取失败，刷新后需要重新拖入文件');
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

// 关页前如果还有没落盘的改动，请浏览器拦一下；切到后台时立刻强制保存
function hasPendingDraftSave(): boolean {
  return draftTimer !== 0 || draftIdle !== 0;
}

window.addEventListener('beforeunload', (event) => {
  if (!state.parsed || !hasPendingDraftSave()) return;
  event.preventDefault();
  event.returnValue = '';
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !state.parsed) return;
  cancelScheduledDraftSave();
  void saveDraftNow();
});

// 「保存失败」徽标可以点：立即重试保存
els.saveStatus.style.cursor = 'pointer';
els.saveStatus.addEventListener('click', () => {
  if (!state.parsed) return;
  if (els.saveStatus.dataset.state === 'error') {
    setSaveBadge('saving', '保存中…', '正在重试保存');
    void saveDraftNow();
  }
});

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
  state.idSeed = deriveIdSeed(draft.chapters);
  state.listWindowStart = 0;
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
    warnings.unshift('草稿关联的原文件缺失或已失效；要换编码或重新识别，请重新拖入同一个文件。');
  }
  render.warnings(warnings);
  recomputeDiagnostics();
  render.all();
  // 草稿可能在目录深处的章节上保存过：把渲染窗口挪过去，让高亮行直接可见
  ensureActiveRowVisible(state.activeId);
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
    toast('草稿关联的原文件缺失，请重新导入同一个文件；也可以在设置里删除这本书');
  }
}

async function openBook(bookId: string, options: { silent?: boolean } = {}): Promise<boolean> {
  if (!bookId) return false;
  const epoch = ++loadEpoch;
  state.busy = true;
  els.shelfBtn.disabled = true;
  // 卡片上给个「打开中…」，大书读草稿 + 回填原文需要一点时间，也挡住连点
  const card = els.shelfList.querySelector(`.shelf-card[data-id="${CSS.escape(bookId)}"]`);
  const openButton = card?.querySelector<HTMLButtonElement>('[data-shelf-act="open"]');
  const originalLabel = openButton?.textContent ?? null;
  if (openButton) openButton.textContent = '打开中…';

  let loaded: LoadedBook | null = null;
  try {
    loaded = await loadBook(bookId);
  } catch (error) {
    toast(error instanceof Error ? error.message : '打开这本书失败，请稍后重试');
    return false;
  } finally {
    state.busy = false;
    els.shelfBtn.disabled = false;
    if (openButton && originalLabel !== null) openButton.textContent = originalLabel;
  }
  if (!loaded) {
    if (!options.silent)
      toast('这本书的草稿数据不完整，可能已被清理；可在书架删除这张卡片，或重新导入原文件');
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

async function restoreLastBookOnStart(): Promise<string | null> {
  // 地址栏里带了页面位置（#/bookshelf、#book/<id>…）就先按链接走，链接比“恢复上次”优先
  if (await applyHash(location.hash)) return null;

  let books: BookRecord[] = [];
  try {
    books = await listBooks();
  } catch (error) {
    toast(
      error instanceof Error ? `本地书架不可用：${error.message}` : '本地书架不可用，本次只能临时编辑',
      { label: '重试', onClick: () => window.location.reload() },
    );
    return null;
  }
  if (!books.length) return null;

  const remembered = loadLastBookId();
  const target = books.find((book) => book.id === remembered) ?? books[0];
  const opened = await openBook(target.id, { silent: true });
  return opened ? target.title : null;
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
  syncHash();
}

function closeShelf(): void {
  if (state.parsed) showWorkspace();
  else showLanding();
}

function toggleShelf(): void {
  if (els.shelf.hidden) void showShelf();
  else closeShelf();
}

/* ---------------- 极简 hash 路由：地址栏记住页面位置 ----------------
 * #/            落地页
 * #/bookshelf   书架
 * #/batch       批量转换
 * #book/<id>            工作区（具体某本书）
 * #book/<id>/preview    工作区 + 移动端预览视图
 * 用 replaceState 写入，不会把每一步操作都塞进历史记录；刷新 / 分享链接都能回到原页面。
 */

let hashSyncing = false;

function currentHash(): string {
  if (!els.shelf.hidden) return '#/bookshelf';
  if (!els.batch.hidden) return '#/batch';
  if (!els.workspace.hidden) {
    const base = state.bookId ? `#book/${state.bookId}` : '#draft';
    return isMobileViewport() && mobileView === 'preview' ? `${base}/preview` : base;
  }
  return '';
}

function syncHash(): void {
  if (hashSyncing) return;
  const next = currentHash();
  if (location.hash === next) return;
  window.history.replaceState(null, '', next || location.pathname + location.search);
}

/** 解析并跳到 hash 描述的页面；无法还原时交给默认流程 */
async function applyHash(hash: string): Promise<boolean> {
  const match = hash.match(/^#(\/)?(bookshelf|batch|book(?:\/([A-Za-z0-9_-]+)(?:\/preview)?)?|draft)$/);
  if (!match) return false;
  const [, , page, bookId] = match;
  if (page === 'bookshelf') {
    await showShelf();
    return true;
  }
  if (page === 'batch') return true; // 批量页依赖上传行为，链接直达没有上下文时忽略
  if (page?.startsWith('book')) {
    if (bookId && bookId !== state.bookId) {
      const opened = await openBook(bookId, { silent: true });
      if (!opened) return false;
    } else {
      showWorkspace();
    }
    if (match[0].endsWith('/preview') && state.parsed) setMobileView('preview', false);
    return true;
  }
  if (page === 'draft' && state.parsed) {
    showWorkspace();
    return true;
  }
  return false;
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
  if (await openBook(bookId)) {
    window.scrollTo(0, 0);
  }
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
    // 刷新卡片，把输入框里没保存成功的值还原成实际书名
    await refreshShelf().catch(() => undefined);
  }
}

const PURGE_DELAY_MS = 8000;
const pendingPurges = new Map<string, number>();

/**
 * 软删除：先把书架记录打上删除标记（草稿和原文原地不动），
 * 8 秒后才真正清理；期间可从 toast 撤销。
 */
async function softDeleteBook(
  bookId: string,
  options: { current: boolean; fromShelf: boolean },
): Promise<void> {
  let title = '未命名';
  try {
    const books = await listBooks();
    title = books.find((book) => book.id === bookId)?.title ?? title;
  } catch {
    /* 拿不到书名就用默认值 */
  }
  try {
    if (options.current) {
      cancelScheduledDraftSave();
      await draftSaveChain;
    }
    await markBookDeleted(bookId);
    if (loadLastBookId() === bookId) saveLastBookId(null);
    if (options.current) resetWorkspaceState();
    await refreshShelf();
  } catch {
    toast('删除失败，请稍后重试');
    return;
  }

  window.clearTimeout(pendingPurges.get(bookId) ?? 0);
  const purgeTimer = window.setTimeout(() => {
    pendingPurges.delete(bookId);
    void deleteBookRecord(bookId).catch(() => undefined);
  }, PURGE_DELAY_MS);
  pendingPurges.set(bookId, purgeTimer);

  toast(`已删除《${title}》（含原始文件）`, {
    label: '撤销',
    onClick: () => {
      window.clearTimeout(purgeTimer);
      pendingPurges.delete(bookId);
      void restoreBook(bookId).then(async (restored) => {
        if (!restored) return;
        if (!els.shelf.hidden) await refreshShelf();
        toast(`已恢复《${title}》`);
      });
    },
  });

  if (!options.current) return;
  // 删掉当前书后工作区已清空：还有别的书就回书架挑一本，否则回落地页
  const books = await listBooks().catch(() => []);
  if (!books.length) showLanding();
  else await showShelf();
}

async function deleteShelfBook(bookId: string): Promise<void> {
  await softDeleteBook(bookId, {
    current: state.bookId === bookId,
    fromShelf: !els.shelf.hidden,
  });
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
  state.idSeed = 0;
  state.listWindowStart = 0;
  state.multiSelect = [];
  state.multiMode = false;
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
  const bookId = state.bookId;
  try {
    if (bookId) {
      await softDeleteBook(bookId, {
        current: true,
        fromShelf: els.shelf.hasAttribute('hidden') === false,
      });
      setDraftStatus('已从书架删除这本书（可在 toast 里撤销）');
    } else {
      await clearDraftStorage();
      setDraftStatus('草稿已清除');
      const books = await listBooks().catch(() => []);
      if (books.length) await showShelf();
      else showLanding();
    }
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
  validateReplaceInput,
  validateRuleInput,
  retryBatch,
  cancelBatch,
  downloadBatchItem,
  jumpListWindow,
  setMultiMode,
  toggleMultiSelect,
  selectAllVisible,
  startMove,
  insertChapter: (index, position) => insertChapterAt(index, position),
  addVolumeAfter,
  dissolveVolume: (index) => dissolveVolumeAt(index),
  setVolumeFromParagraph: (chapterIndex, paragraphIndex) => setVolumeAt(chapterIndex, paragraphIndex),
  revealChapter,
  beginParagraphEdit,
  editParagraphFrom,
  cancelParagraphEdit,
  insertParagraph,
  deleteParagraph,
  setListPageSize,
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
};

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event as BeforeInstallPromptEvent;
  els.installApp.hidden = false;
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

// 导入失败的「换个文件重试」：还有失败的文件就直接重试它，否则打开文件选择器
els.importErrorRetry.addEventListener('click', () => {
  hideImportError();
  if (lastAttemptFile) void loadFile(lastAttemptFile);
  else els.fileInput.click();
});

// 上次会话里软删除但没等到清理就关掉的书，隔了一天还没被清理就补一刀
void purgeExpiredDeletedBooks().catch(() => undefined);

void restoreLastBookOnStart().then((title) => {
  if (title) toast(`已恢复上次编辑的《${title}》`);
});

// 手动改地址栏 / 浏览器前进后退：按 hash 跳页；不认识的 hash 还原成当前页面
window.addEventListener('hashchange', () => {
  void applyHash(location.hash).then((matched) => {
    if (!matched) syncHash();
  });
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 离线能力不可用不影响主流程 */
    });
  });
}
