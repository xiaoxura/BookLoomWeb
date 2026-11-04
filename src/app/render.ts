import { normalizeCoverOptions } from '../core/cover';
import { AUDIT_ISSUE_META, AUDIT_ISSUE_ORDER, type AuditIssue, type AuditReport } from '../core/audit';
import type { Chapter } from '../types';
import type { Els } from './dom';
import { formatBytes, toArrayBuffer } from './export';
import { EXPORT_LABEL, type BatchItem, type State } from './state';
import type { BookRecord } from '../core/draft';

/**
 * 工作区渲染：章节列表、预览、封面、设置控件、体检面板与批量列表。
 * 只读写传入的 state / els，业务动作仍由 main 的事件层触发。
 */
export type Renderer = ReturnType<typeof createRenderer>;

export function createRenderer(els: Els, state: State, closeCover: () => void) {
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
    const sourceType = state.parsed.sourceType;
    const encoding =
      sourceType === 'epub'
        ? 'EPUB'
        : sourceType === 'docx'
          ? 'DOCX'
          : (state.parsed.encoding || 'utf-8').toUpperCase();
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

  function renderDiagnostics() {
    const candidates = state.diagnostics;
    const report = state.audit;
    const total = candidates.length + report.total;
    const visible = total > 0 && !state.diagDismissed;
    els.diagnostics.hidden = !visible;
    if (!visible) return;

    const parts: string[] = [];
    if (candidates.length) parts.push(`疑似漏章 ${candidates.length}`);
    if (report.total) parts.push(`结构问题 ${report.total}`);
    els.diagSummary.textContent = `全书体检：${parts.join(' · ')}`;
    els.diagList.hidden = !state.diagOpen;
    els.diagCaret.textContent = state.diagOpen ? '收起' : '展开';

    const max = 30;
    els.diagList.replaceChildren();
    candidates.slice(0, max).forEach((item) => {
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

    if (candidates.length > max) {
      const more = document.createElement('p');
      more.className = 'diag-more';
      more.textContent = `还有 ${candidates.length - max} 处，建议先手动拆分`;
      els.diagList.appendChild(more);
    }

    renderAuditIssues(report);
  }

  function renderAuditIssues(report: AuditReport) {
    AUDIT_ISSUE_ORDER.forEach((kind) => {
      const items = report.issues.filter((issue) => issue.kind === kind);
      if (!items.length) return;
      const meta = AUDIT_ISSUE_META[kind];
      const heading = document.createElement('p');
      heading.className = 'diag-group';
      heading.textContent = `${meta.label}（${report.counts[kind]}）`;
      heading.title = meta.hint;
      els.diagList.appendChild(heading);
      items.forEach((issue) => els.diagList.appendChild(renderAuditItem(issue)));
      if (report.counts[kind] > items.length) {
        const more = document.createElement('p');
        more.className = 'diag-more';
        more.textContent = `还有 ${report.counts[kind] - items.length} 处同类问题未列出`;
        els.diagList.appendChild(more);
      }
    });
  }

  function renderAuditItem(issue: AuditIssue): HTMLElement {
    const row = document.createElement('div');
    row.className = 'audit-item';

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'diag-text';
    label.dataset.role = 'audit';
    label.dataset.chapterIndex = String(issue.chapterIndex);
    label.dataset.paragraphIndex =
      issue.paragraphIndex === undefined ? '' : String(issue.paragraphIndex);
    label.title = `点击定位到「${issue.chapterTitle}」`;

    const message = document.createElement('span');
    message.className = 'diag-cand';
    message.textContent = issue.message;

    const source = document.createElement('span');
    source.className = 'diag-src';
    source.textContent = `「${issue.chapterTitle}」`;
    label.append(message, source);

    const kind = document.createElement('span');
    kind.className = 'audit-kind';
    kind.textContent = AUDIT_ISSUE_META[issue.kind].label;

    row.append(label, kind);
    return row;
  }

  function renderCover() {
    closeCover();
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
    els.metaDescription.value = state.meta.description ?? '';
    els.metaSeries.value = state.meta.series ?? '';
    els.metaPublisher.value = state.meta.publisher ?? '';
    els.metaTags.value = (state.meta.tags ?? []).join('、');
    els.metaPublished.value = state.meta.publishedAt ?? '';
    const sourceType = state.parsed?.sourceType;
    const fromEpub = sourceType === 'epub';
    const fromDocx = sourceType === 'docx';
    const fromStructured = fromEpub || fromDocx;
    els.export.disabled = state.busy || !state.chapters.length;
    els.reparse.disabled = state.busy || !state.parsed || !state.sourceReady || fromStructured;
    els.reparse.title = fromEpub
      ? 'EPUB 已经拆好章节，不需要重新识别'
      : fromDocx
        ? 'DOCX 已经拆好章节，不需要重新识别'
        : state.sourceReady
          ? ''
          : '恢复的草稿没有原始文件';
    els.convert.value = state.convert;
    els.convert.disabled = state.busy;
    els.encoding.disabled = !state.sourceReady || fromStructured;
    els.encodingNote.hidden = !fromStructured;
    els.encodingNote.textContent = fromDocx
      ? 'DOCX 里的文字自带编码，不需要再选'
      : 'EPUB 里的文字自带编码，不需要再选';
    els.filterAds.disabled = fromStructured;
    els.exportFormat.value = state.exportFormat;
    els.batchFormat.value = state.exportFormat;
    els.epubVersion.disabled = state.exportFormat !== 'epub';
    els.epubVersionField.hidden = state.exportFormat !== 'epub';
    els.export.textContent = EXPORT_LABEL[state.exportFormat];
    els.lineHeight.value = String(state.layout.lineHeight);
    els.lineHeightVal.textContent = state.layout.lineHeight.toFixed(2);
    els.paraGap.value = String(state.layout.paragraphSpacing);
    els.paraGapVal.textContent = state.layout.paragraphSpacing.toFixed(1);
    els.indent.checked = state.layout.indent;
    els.justify.checked = state.layout.justify;
    els.separateNumber.checked = state.layout.separateChapterNumber ?? false;
    els.coverStyle.value = state.layout.coverStyle ?? 'vertical';
    const coverOptions = normalizeCoverOptions(state.layout.coverOptions);
    els.coverPalette.value = coverOptions.palette;
    els.coverTitleScale.value = String(coverOptions.titleScale);
    els.coverTitleScaleValue.textContent = `${Math.round(coverOptions.titleScale * 100)}%`;
    els.coverAuthorPosition.value = coverOptions.authorPosition;
    if (document.activeElement !== els.customCss) {
      els.customCss.value = state.layout.customCss ?? '';
    }
    els.font.value = state.layout.font;
    const hasFont = Boolean(state.font);
    els.fontRemove.hidden = !hasFont;
    els.fontUpload.textContent = hasFont ? '更换字体' : '选择字体';
    els.fontStatus.textContent = state.font
      ? `已嵌入 ${state.font.name}（${formatBytes(state.font.data.length)}），导出时打进 EPUB`
      : '可选，字体文件会一起打进 EPUB';
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
    if (state.exportFormat === 'txt') {
      els.exportHint.textContent = 'UTF-8 纯文本 · 标题单独成行，可以再拖回来重新分章';
      return;
    }
    if (state.exportFormat === 'md') {
      els.exportHint.textContent = 'Markdown · 书名用 #，卷用 ##，章用 ###';
      return;
    }
    if (state.exportFormat === 'docx') {
      els.exportHint.textContent = 'DOCX · Word 可继续编辑，标题使用 Word 标题样式';
      return;
    }
    if (state.exportFormat === 'html') {
      els.exportHint.textContent = '单文件 HTML · 样式内联，双击即可阅读，目录可跳转';
      return;
    }
    els.exportHint.textContent =
      state.epubVersion === 2
        ? 'EPUB 2 · 兼容老设备（无 EPUB 3 导航页）'
        : 'EPUB 3 · 含封面与目录，Kindle 可推送';
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

  function renderShelf(books: BookRecord[], storageLabel: string) {
    els.shelfStorage.textContent = storageLabel;
    els.shelfEmpty.hidden = books.length > 0;
    els.shelfClose.hidden = !state.parsed;

    const fragment = document.createDocumentFragment();
    books.forEach((book) => {
      const card = document.createElement('article');
      card.className = 'shelf-card' + (book.id === state.bookId ? ' current' : '');
      card.dataset.id = book.id;
      card.setAttribute('role', 'listitem');

      const cover = document.createElement('button');
      cover.type = 'button';
      cover.className = 'shelf-cover';
      cover.dataset.shelfAct = 'open';
      cover.title = `打开《${book.title}》`;
      if (book.coverThumb) {
        const img = document.createElement('img');
        img.src = book.coverThumb;
        img.alt = '';
        cover.appendChild(img);
      } else {
        const span = document.createElement('span');
        span.textContent = '无封面';
        cover.appendChild(span);
      }

      const info = document.createElement('div');
      info.className = 'shelf-info';

      const title = document.createElement('input');
      title.className = 'shelf-title';
      title.value = book.title;
      title.maxLength = 60;
      title.dataset.original = book.title;
      title.setAttribute('aria-label', `书名：${book.title}`);
      title.title = '点一下改书名，回车或失焦保存';

      const meta = document.createElement('p');
      meta.className = 'shelf-meta';
      const updated = new Date(book.updatedAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      meta.textContent = `${book.author || '佚名'} · ${book.chapterCount} 章 · ${book.words.toLocaleString('zh-CN')} 字 · ${updated}`;

      const actions = document.createElement('div');
      actions.className = 'shelf-card-actions';

      const open = document.createElement('button');
      open.type = 'button';
      open.dataset.shelfAct = 'open';
      open.textContent = book.id === state.bookId ? '继续编辑' : '打开';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.dataset.shelfAct = 'delete';
      remove.textContent = '删除';
      remove.title = '需要再点一次确认';

      actions.append(open, remove);
      info.append(title, meta, actions);
      card.append(cover, info);
      fragment.appendChild(card);
    });
    els.shelfList.replaceChildren(fragment);
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

  return {
    activeChapter,
    totalChars,
    stats: renderStats,
    warnings: renderWarnings,
    list: renderList,
    applyLayoutToPreview,
    preview: renderPreview,
    updateChapterNav,
    updateSelectionBar,
    diagnostics: renderDiagnostics,
    cover: renderCover,
    all: renderAll,
    controls: updateControls,
    paintRange,
    updateExportHint,
    batch: renderBatch,
    shelf: renderShelf,
  };
}
