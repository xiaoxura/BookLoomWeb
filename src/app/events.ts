import { coverFromImage, generateCover } from '../core/cover';
import type { Els } from './dom';
import type { Renderer } from './render';
import type { LayoutOptions } from '../types';
import { saveEpubVersion, saveLayout, type MobileView, type State } from './state';

export interface CoverUpdate {
  style?: string;
  palette?: string;
  titleScale?: number;
  authorPosition?: string;
  reset?: boolean;
}

export interface EventDeps {
  els: Els;
  state: State;
  render: Renderer;
  getMobileView: () => MobileView;
  toggleTheme: () => void;
  setMobileView: (view: MobileView, scroll?: boolean) => void;
  setStatus: (message: string, kind?: 'normal' | 'error') => void;
  toast: (message: string, action?: { label: string; onClick: () => void }) => void;
  bindGlobalShortcuts: (event: KeyboardEvent) => void;
  loadFile: (file: File) => void;
  startBatch: (files: File[]) => void;
  reparse: () => void;
  setRulePreset: (id: string) => void;
  applyCustomRules: () => void;
  exportRules: () => void;
  importRules: (file: File) => void;
  exportCurrentBook: () => void;
  setExportFormat: (value: string) => void;
  setConvert: (value: string) => void;
  setCoverOptions: (update: CoverUpdate) => void;
  beginTitleEdit: (input: HTMLInputElement) => void;
  endTitleEdit: (input: HTMLInputElement) => void;
  setActive: (id: string | null) => void;
  selectParagraph: (index: number | null, scroll?: boolean) => void;
  splitAt: (chapterIndex: number, paragraphIndex: number, mode: 'split' | 'title') => void;
  deleteChapter: (index: number) => void;
  mergeUp: (index: number) => void;
  setChapterLevel: (index: number) => void;
  undo: () => void;
  redo: () => void;
  renumberByOrder: () => void;
  runReplacePreview: () => void;
  runReplaceApply: () => void;
  openCoverView: () => void;
  closeCoverView: (restoreFocus?: boolean) => void;
  scheduleAutoCover: () => void;
  scheduleDraftSave: (delay?: number) => void;
  stepChapter: (delta: -1 | 1) => void;
  importFont: (file: File) => void;
  handleClearDraft: () => void;
  downloadBatchZip: () => void;
  resetBatch: () => void;
  coverChanged: () => void;
  removeFont: () => void;
  toggleShelf: () => void;
  closeShelf: () => void;
  openShelfBook: (id: string) => void;
  renameShelfBook: (id: string, title: string) => void;
  deleteShelfBook: (id: string) => void;
}

let searchTimer = 0;

export function bindEvents(deps: EventDeps): void {
  const { els, state, render } = deps;

  els.themeToggle.addEventListener('click', () => deps.toggleTheme());

  els.shelfBtn.addEventListener('click', () => deps.toggleShelf());
  els.shelfImport.addEventListener('click', () => els.fileInput.click());
  els.shelfClose.addEventListener('click', () => deps.closeShelf());

  els.shelfList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('.shelf-card');
    const id = card?.dataset.id;
    if (!id) return;
    const action = target.closest<HTMLElement>('[data-shelf-act]')?.dataset.shelfAct;
    if (action === 'delete') {
      const button = target.closest<HTMLButtonElement>('[data-shelf-act="delete"]');
      if (!button) return;
      if (button.dataset.confirm !== '1') {
        button.dataset.confirm = '1';
        button.textContent = '再点一次删除';
        window.setTimeout(() => {
          if (!button.isConnected) return;
          delete button.dataset.confirm;
          button.textContent = '删除';
        }, 4000);
        return;
      }
      deps.deleteShelfBook(id);
      return;
    }
    deps.openShelfBook(id);
  });

  els.shelfList.addEventListener('focusout', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.shelf-title');
    if (!input) return;
    const id = input.closest<HTMLElement>('.shelf-card')?.dataset.id;
    if (!id) return;
    const value = input.value.trim();
    const original = input.dataset.original ?? '';
    if (!value) {
      input.value = original;
      return;
    }
    if (value !== original) deps.renameShelfBook(id, value);
  });

  els.shelfList.addEventListener('keydown', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.shelf-title');
    if (!input) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      input.value = input.dataset.original ?? input.value;
      input.blur();
    }
  });

  els.mobileTabs.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!button) return;
    const view = button.dataset.view as MobileView | undefined;
    if (!view || view === deps.getMobileView()) return;
    deps.setMobileView(view, true);
  });

  els.prevChapter.addEventListener('click', () => deps.stepChapter(-1));
  els.nextChapter.addEventListener('click', () => deps.stepChapter(1));

  els.undoBtn.addEventListener('click', () => deps.undo());
  els.redoBtn.addEventListener('click', () => deps.redo());

  els.pickFile.addEventListener('click', () => els.fileInput.click());
  els.changeFile.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const files = Array.from(els.fileInput.files ?? []);
    els.fileInput.value = '';
    if (!files.length) return;
    if (files.length === 1) void deps.loadFile(files[0]);
    else deps.startBatch(files);
  });

  els.loadSample.addEventListener('click', async () => {
    try {
      const response = await fetch('/sample.txt');
      const text = await response.text();
      const file = new File([text], '雾港灯塔.txt', { type: 'text/plain' });
      void deps.loadFile(file);
    } catch {
      deps.setStatus('示例加载失败，请直接选择本地文件', 'error');
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
    const files = Array.from(event.dataTransfer?.files ?? []).filter((item) => /\.(txt|epub|docx)$/i.test(item.name));
    if (files.length === 1) void deps.loadFile(files[0]);
    else if (files.length > 1) deps.startBatch(files);
    else deps.toast('请拖入 .txt / .epub / .docx 文件');
  };

  els.dropZone.addEventListener('dragover', onDragOver);
  els.dropZone.addEventListener('dragleave', onDragLeave);
  els.dropZone.addEventListener('drop', onDrop);

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    if (els.dropZone.contains(event.target as Node) || els.dropZone.hidden) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []).filter((item) => /\.(txt|epub|docx)$/i.test(item.name));
    if (files.length === 1) void deps.loadFile(files[0]);
    else if (files.length > 1) deps.startBatch(files);
  });

  els.chapterList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.chapter-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (!Number.isFinite(index) || index < 0) return;

    const action = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (action === 'delete') {
      deps.deleteChapter(index);
      return;
    }
    if (action === 'merge') {
      deps.mergeUp(index);
      return;
    }
    if (action === 'level') {
      deps.setChapterLevel(index);
      return;
    }
    if (action === 'rename') {
      const input = row.querySelector<HTMLInputElement>('.ch-title');
      if (input) deps.beginTitleEdit(input);
      return;
    }
    if (target instanceof HTMLInputElement && target.classList.contains('ch-title')) {
      // 标题平时只读：先选中章节，再点一次才进编辑态，避免手机一点就弹键盘
      if (!target.readOnly) return;
      if (row.classList.contains('active')) {
        deps.beginTitleEdit(target);
        return;
      }
    }
    deps.setActive(row.dataset.id ?? null);
  });

  els.chapterList.addEventListener('dblclick', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.ch-title');
    if (input && input.readOnly) deps.beginTitleEdit(input);
  });

  els.chapterList.addEventListener('focusout', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.ch-title');
    if (input && !input.readOnly) deps.endTitleEdit(input);
  });

  els.chapterList.addEventListener('keydown', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.ch-title');
    if (!input) return;
    if (input.readOnly) {
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        deps.beginTitleEdit(input);
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
    deps.scheduleDraftSave();
    if (chapter.id === state.activeId) {
      const heading = els.preview.querySelector('h1, h2');
      if (heading) heading.textContent = input.value || '未命名';
    }
  });

  els.metaTitle.addEventListener('input', () => {
    state.meta.title = els.metaTitle.value;
    deps.scheduleAutoCover();
    deps.scheduleDraftSave();
  });
  els.metaAuthor.addEventListener('input', () => {
    state.meta.author = els.metaAuthor.value;
    deps.scheduleAutoCover();
    deps.scheduleDraftSave();
  });
  els.metaDescription.addEventListener('input', () => {
    state.meta.description = els.metaDescription.value;
    deps.scheduleDraftSave();
  });
  els.metaSeries.addEventListener('input', () => {
    state.meta.series = els.metaSeries.value;
    deps.scheduleDraftSave();
  });
  els.metaPublisher.addEventListener('input', () => {
    state.meta.publisher = els.metaPublisher.value;
    deps.scheduleDraftSave();
  });
  els.metaTags.addEventListener('input', () => {
    const tags = els.metaTags.value
      .split(/[,，、;；\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    state.meta.tags = tags.length ? tags : undefined;
    deps.scheduleDraftSave();
  });
  els.metaPublished.addEventListener('change', () => {
    state.meta.publishedAt = els.metaPublished.value;
    deps.scheduleDraftSave();
  });

  els.coverThumb.addEventListener('click', () => {
    if (state.coverUrl) deps.openCoverView();
    else els.coverInput.click();
  });
  els.coverViewClose.addEventListener('click', () => deps.closeCoverView(true));
  els.coverView.addEventListener('click', (event) => {
    if (event.target === els.coverViewImg) return;
    deps.closeCoverView(true);
  });
  document.addEventListener('keydown', (event) => deps.bindGlobalShortcuts(event));
  els.coverUpload.addEventListener('click', () => els.coverInput.click());
  els.coverRemove.addEventListener('click', () => {
    state.cover = null;
    state.coverAuto = false;
    render.cover();
    deps.coverChanged();
    deps.scheduleDraftSave();
    deps.toast('已移除封面，导出时不再包含封面');
  });
  els.coverInput.addEventListener('change', async () => {
    const file = els.coverInput.files?.[0];
    els.coverInput.value = '';
    if (!file) return;
    try {
      state.cover = await coverFromImage(file);
      state.coverAuto = false;
      render.cover();
      deps.coverChanged();
      deps.scheduleDraftSave();
      deps.toast('封面已更新，导出后可在阅读器书架看到');
    } catch (error) {
      deps.toast(error instanceof Error ? error.message : '封面读取失败');
    }
  });
  els.coverAuto.addEventListener('click', () => {
    state.coverAuto = true;
    void (async () => {
      state.cover = await generateCover(
        state.meta.title || '未命名',
        state.meta.author || '佚名',
        state.layout.coverStyle,
        state.layout.coverOptions,
      );
      render.cover();
      deps.coverChanged();
      deps.scheduleDraftSave();
    })();
  });

  els.encoding.addEventListener('change', () => void deps.reparse());
  els.convert.addEventListener('change', () => deps.setConvert(els.convert.value));
  els.filterAds.addEventListener('change', () => void deps.reparse());
  els.reparse.addEventListener('click', () => void deps.reparse());
  els.rulePreset.addEventListener('change', () => deps.setRulePreset(els.rulePreset.value));
  els.ruleApply.addEventListener('click', () => deps.applyCustomRules());
  els.ruleExport.addEventListener('click', () => deps.exportRules());
  els.ruleImport.addEventListener('click', () => els.ruleFile.click());
  els.ruleFile.addEventListener('change', () => {
    const file = els.ruleFile.files?.[0];
    els.ruleFile.value = '';
    if (file) void deps.importRules(file);
  });
  els.replacePreview.addEventListener('click', () => deps.runReplacePreview());
  els.replaceApply.addEventListener('click', () => deps.runReplaceApply());
  els.export.addEventListener('click', () => deps.exportCurrentBook());
  els.exportFormat.addEventListener('change', () => deps.setExportFormat(els.exportFormat.value));
  els.batchFormat.addEventListener('change', () => deps.setExportFormat(els.batchFormat.value));
  els.epubVersion.addEventListener('change', () => {
    state.epubVersion = els.epubVersion.value === '2' ? 2 : 3;
    render.updateExportHint();
    saveEpubVersion(state.epubVersion);
    deps.scheduleDraftSave(0);
  });
  els.clearDraft.addEventListener('click', () => void deps.handleClearDraft());
  els.batchDownload.addEventListener('click', () => void deps.downloadBatchZip());
  els.batchClose.addEventListener('click', () => {
    if (state.batchRunning) {
      state.batchCancelled = true;
      els.batchClose.disabled = true;
      els.batchStatus.textContent = '正在结束当前任务…';
      return;
    }
    deps.resetBatch();
  });

  els.font.addEventListener('change', () => {
    state.layout.font = els.font.value as LayoutOptions['font'];
    saveLayout(state.layout);
    render.applyLayoutToPreview();
    deps.scheduleDraftSave();
  });
  els.lineHeight.addEventListener('input', () => {
    state.layout.lineHeight = Number(els.lineHeight.value);
    els.lineHeightVal.textContent = state.layout.lineHeight.toFixed(2);
    render.paintRange(els.lineHeight);
    saveLayout(state.layout);
    render.applyLayoutToPreview();
    deps.scheduleDraftSave();
  });
  els.paraGap.addEventListener('input', () => {
    state.layout.paragraphSpacing = Number(els.paraGap.value);
    els.paraGapVal.textContent = state.layout.paragraphSpacing.toFixed(1);
    render.paintRange(els.paraGap);
    saveLayout(state.layout);
    render.applyLayoutToPreview();
    deps.scheduleDraftSave();
  });
  els.indent.addEventListener('change', () => {
    state.layout.indent = els.indent.checked;
    saveLayout(state.layout);
    render.applyLayoutToPreview();
    deps.scheduleDraftSave();
  });
  els.justify.addEventListener('change', () => {
    state.layout.justify = els.justify.checked;
    saveLayout(state.layout);
    render.applyLayoutToPreview();
    deps.scheduleDraftSave();
  });
  els.separateNumber.addEventListener('change', () => {
    state.layout.separateChapterNumber = els.separateNumber.checked;
    saveLayout(state.layout);
    deps.scheduleDraftSave();
  });
  els.customCss.addEventListener('input', () => {
    state.layout.customCss = els.customCss.value.slice(0, 20000);
    saveLayout(state.layout);
    deps.scheduleDraftSave();
  });
  els.coverStyle.addEventListener('change', () =>
    deps.setCoverOptions({ style: els.coverStyle.value }),
  );
  els.coverPalette.addEventListener('change', () =>
    deps.setCoverOptions({ palette: els.coverPalette.value }),
  );
  els.coverAuthorPosition.addEventListener('change', () =>
    deps.setCoverOptions({ authorPosition: els.coverAuthorPosition.value }),
  );
  els.coverTitleScale.addEventListener('input', () =>
    deps.setCoverOptions({ titleScale: Number(els.coverTitleScale.value) }),
  );
  els.coverResetOptions.addEventListener('click', () => deps.setCoverOptions({ reset: true }));
  els.fontUpload.addEventListener('click', () => els.fontInput.click());
  els.fontInput.addEventListener('change', () => {
    const file = els.fontInput.files?.[0];
    els.fontInput.value = '';
    if (file) void deps.importFont(file);
  });
  els.fontRemove.addEventListener('click', () => deps.removeFont());

  els.preview.addEventListener('click', (event) => {
    const paragraph = (event.target as HTMLElement).closest<HTMLElement>('p[data-index]');
    if (!paragraph) return;
    const index = Number(paragraph.dataset.index);
    deps.selectParagraph(state.selectedParagraph === index ? null : index);
  });

  els.selectionBar.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!action) return;
    if (action === 'cancel') {
      deps.selectParagraph(null);
      return;
    }
    const chapterIndex = state.chapters.findIndex((chapter) => chapter.id === state.activeId);
    if (chapterIndex < 0 || state.selectedParagraph === null) return;
    deps.splitAt(chapterIndex, state.selectedParagraph, action === 'title' ? 'title' : 'split');
  });

  els.chapterSearch.addEventListener('input', () => {
    state.filter = els.chapterSearch.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => render.list(), 140);
  });

  els.chapterSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      state.filter = '';
      els.chapterSearch.value = '';
      render.list();
      return;
    }
    if (event.key === 'Enter') {
      window.clearTimeout(searchTimer);
      state.filter = els.chapterSearch.value;
      render.list();
      const first = els.chapterList.querySelector<HTMLElement>('.chapter-row');
      if (first) deps.setActive(first.dataset.id ?? null);
    }
  });

  els.diagToggle.addEventListener('click', () => {
    state.diagOpen = !state.diagOpen;
    render.diagnostics();
  });

  els.diagDismiss.addEventListener('click', () => {
    state.diagDismissed = true;
    render.diagnostics();
  });

  els.auditRenumber.addEventListener('click', () => deps.renumberByOrder());

  els.diagList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-role]');
    if (!button) return;
    const chapterIndex = Number(button.dataset.chapterIndex);
    const paragraphIndex = Number(button.dataset.paragraphIndex);

    if (button.dataset.role === 'title') {
      deps.splitAt(chapterIndex, paragraphIndex, 'title');
      return;
    }

    const chapter = state.chapters[chapterIndex];
    if (!chapter) return;
    if (state.filter) {
      state.filter = '';
      els.chapterSearch.value = '';
      render.list();
    }
    deps.setActive(chapter.id);
    requestAnimationFrame(() => {
      const row = Array.from(els.chapterList.querySelectorAll<HTMLElement>('.chapter-row')).find(
        (item) => item.dataset.id === chapter.id,
      );
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    if (button.dataset.role === 'audit') {
      const raw = button.dataset.paragraphIndex;
      if (raw) deps.selectParagraph(Number(raw), true);
      return;
    }
    deps.selectParagraph(paragraphIndex, true);
  });
}

