import { coverFromImage, generateCover } from '../core/cover';
import type { Els } from './dom';
import type { Renderer } from './render';
import { beginModal } from './modal';
import { createAppDialog } from './dialog';
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
  /** 单独保存批量转换中的某一本成品 */
  downloadBatchItem: (index: number) => void;
  resetBatch: () => void;
  coverChanged: () => void;
  removeFont: () => void;
  toggleShelf: () => void;
  closeShelf: () => void;
  openShelfBook: (id: string) => void;
  renameShelfBook: (id: string, title: string) => void;
  deleteShelfBook: (id: string) => void;
  /** 取消批量转换中正在处理的这一本（终止后台任务，让「取消」立即生效） */
  cancelBatch?: () => void;
  /** 目录窗口门牌：上一页 / 回到开头 / 往后翻页 / 定位当前章 */
  jumpListWindow: (mode: 'top' | 'active' | 'prev' | 'next') => void;
  /** 输入变化时即时校验批量替换的查找内容（非法正则直接提示并禁用按钮） */
  validateReplaceInput: () => void;
  /** 输入变化时即时校验自定义规则 JSON */
  validateRuleInput: () => void;
  /** 重试批量转换里失败的项 */
  retryBatch: () => void;
  /** 选中章节并滚动到可见，附带短暂的定位高亮 */
  revealChapter: (id: string) => void;
  /** 进入某段编辑态（复用渲染层编辑器） */
  beginParagraphEdit: (chapterIndex: number, paragraphIndex: number) => void;
  /** 从编辑器 textarea 提交段落内容（保存按钮 / Ctrl+Enter / 失焦） */
  editParagraphFrom: (textarea: HTMLTextAreaElement) => void;
  /** 取消段落编辑 */
  cancelParagraphEdit: () => void;
  /** 在某段后面插入空段落并进入编辑；afterIndex 为 Infinity 时追加到章尾 */
  insertParagraph: (chapterIndex: number, afterIndex: number) => void;
  /** 删除某段（本章删空时连章一起移除） */
  deleteParagraph: (paragraphIndex: number, chapterIndex: number) => void;
  /** 修改目录每页章数（100 / 200 / 400 / 800） */
  setListPageSize: (size: number) => void;
  /** 开 / 关批量移动模式 */
  setMultiMode: (on: boolean) => void;
  /** 切换某章的批量选中状态 */
  toggleMultiSelect: (id: string) => void;
  /** 全选当前渲染窗口里的章节 */
  selectAllVisible: () => void;
  /** 打开「移动到卷…」对话框，targets 为章节下标集合 */
  startMove: (indexes: number[]) => void;
  /** 在某章前 / 后插入空白章节 */
  insertChapter: (index: number, position: 'before' | 'after') => void;
  /** 在某章后新建一个卷（空文件夹） */
  addVolumeAfter: (index: number) => void;
  /** 取消分卷：卷标题行移除，其下章节归属上一个卷 */
  dissolveVolume: (index: number) => void;
  /** 把选中段落设为新卷名（卷 = 文件夹），并重新归组受影响章节 */
  setVolumeFromParagraph: (chapterIndex: number, paragraphIndex: number) => void;
}

let searchTimer = 0;

/**
 * 不可逆动作的二次确认臂：第一次点击只把按钮变成「确认。」态，
 * 四秒内再点一次才真正执行；点别处或超时自动还原。
 */
export function armConfirm(button: HTMLElement, armedLabel: string): boolean {
  if (button.dataset.confirm === '1') {
    disarmConfirm(button);
    return false;
  }
  button.dataset.confirm = '1';
  button.dataset.confirmLabel = button.textContent ?? '';
  button.classList.add('confirm-armed');
  button.textContent = armedLabel;
  window.setTimeout(() => {
    // 超时还没确认就还原，避免出现长期待确认的按钮
    if (button.dataset.confirm === '1') disarmConfirm(button);
  }, 4000);
  return true;
}

function disarmConfirm(button: HTMLElement): void {
  if (button.dataset.confirm !== '1') return;
  delete button.dataset.confirm;
  button.classList.remove('confirm-armed');
  const originalLabel = button.dataset.confirmLabel;
  if (originalLabel !== undefined) button.textContent = originalLabel;
  delete button.dataset.confirmLabel;
}

// 点到确认按钮以外的地方：撤销所有待确认臂（等于「点错了，还原」）
document.addEventListener(
  'pointerdown',
  (event) => {
    const node = event.target as Node | null;
    if (!node) return;
    document.querySelectorAll<HTMLElement>('[data-confirm="1"]').forEach((button) => {
      if (!button.contains(node)) disarmConfirm(button);
    });
  },
  true,
);

export function bindEvents(deps: EventDeps): void {
  const { els, state, render } = deps;

  /* ---------- 章节「更多」菜单 ---------- */

  let rowMenuAnchor: HTMLButtonElement | null = null;
  let rowMenuCleanup: (() => void) | null = null;

  const closeRowMenu = (restoreFocus = false): void => {
    if (!rowMenuAnchor && els.rowMenu.hidden) return;
    const anchor = rowMenuAnchor;
    rowMenuAnchor = null;
    els.rowMenu.hidden = true;
    els.rowMenu.replaceChildren();
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && document.contains(anchor)) anchor.focus();
    }
    rowMenuCleanup?.();
    rowMenuCleanup = null;
  };

  const openRowMenu = (
    button: HTMLButtonElement | null,
    row: HTMLElement,
    index: number,
    point?: { x: number; y: number },
  ): void => {
    if (!point && rowMenuAnchor === button && button) {
      closeRowMenu(true);
      return;
    }
    closeRowMenu();
    const chapter = state.chapters[index];
    if (!chapter) return;

    const menu = els.rowMenu;
    const kind = chapter.level;
    const items: Array<{
      label: string;
      glyph: string;
      act: 'rename' | 'insert-before' | 'insert-after' | 'add-volume' | 'dissolve' | 'move' | 'merge' | 'delete';
      disabled?: boolean;
      danger?: boolean;
    }> = [
      { label: '重命名标题', glyph: '✎', act: 'rename' },
      ...(kind === 1
        ? [
            { label: '取消分卷', glyph: '⇋', act: 'dissolve' as const },
          ]
        : [
            { label: '新建章节（前面）', glyph: '＋', act: 'insert-before' as const },
            { label: '新建章节（后面）', glyph: '＋', act: 'insert-after' as const },
            { label: '新建卷（后面）', glyph: '卷', act: 'add-volume' as const },
            { label: '并入上一章', glyph: '↑', act: 'merge' as const, disabled: index === 0 },
          ]),
      ...(kind === 2 ? [{ label: '移动到其他卷…', glyph: '⇄', act: 'move' as const }] : []),
      ...(kind === 2
        ? [
            {
              label: '删除本章',
              glyph: '×',
              act: 'delete' as const,
              disabled: state.chapters.length <= 1,
              danger: true,
            },
          ]
        : []),
    ];

    for (const item of items) {
      const menuItem = document.createElement('button');
      menuItem.type = 'button';
      menuItem.setAttribute('role', 'menuitem');
      menuItem.dataset.act = item.act;
      menuItem.disabled = Boolean(item.disabled);
      if (item.danger) menuItem.classList.add('danger');

      const glyph = document.createElement('span');
      glyph.className = 'row-menu-glyph';
      glyph.textContent = item.glyph;
      const label = document.createElement('span');
      label.textContent = item.label;
      menuItem.append(glyph, label);

      menuItem.addEventListener('click', () => {
        // 合并 / 删除这类不可逆感强的动作先二次确认：第一次只改文案，第二次才执行
        if (item.act === 'merge' || item.act === 'delete') {
          const armed = armConfirm(menuItem, item.act === 'delete' ? '再点一次删除' : '再点一次合并');
          if (armed) return; // 菜单保持打开，等第二次点击
        }
        closeRowMenu();
        if (item.act === 'rename') {
          const input = row.querySelector<HTMLInputElement>('.ch-title');
          if (input) deps.beginTitleEdit(input);
          return;
        }
        if (item.act === 'insert-before') deps.insertChapter(index, 'before');
        else if (item.act === 'insert-after') deps.insertChapter(index, 'after');
        else if (item.act === 'add-volume') deps.addVolumeAfter(index);
        else if (item.act === 'dissolve') deps.dissolveVolume(index);
        else if (item.act === 'move') deps.startMove([index]);
        else if (item.act === 'merge') deps.mergeUp(index);
        else deps.deleteChapter(index);
      });
      menu.append(menuItem);
    }

    rowMenuAnchor = button;
    if (button) button.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    // 位置：右键长按→贴近指针；⋯按钮→按钮下方
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
    const left = point
      ? Math.max(8, Math.min(point.x, maxLeft))
      : (() => {
          const rect = button!.getBoundingClientRect();
          return Math.max(8, Math.min(rect.right - menuRect.width, maxLeft));
        })();
    let top = point ? point.y + 4 : button!.getBoundingClientRect().bottom + 4;
    if (!point) {
      const rect = button!.getBoundingClientRect();
      if (top + menuRect.height > window.innerHeight - 8) {
        top = rect.top - menuRect.height - 4;
      }
    } else if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, point.y - menuRect.height - 4);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, top)}px`;

    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menu.contains(target)) return;
      closeRowMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRowMenu(true);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const buttons = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      );
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next = current;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === 'ArrowDown') next = (current + 1 + buttons.length) % buttons.length;
      else next = (current - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    const onScroll = (): void => closeRowMenu();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    rowMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  };

  /* ---------- 右键 / 长按上下文菜单 ---------- */

  /** 弹出与「⋯」一致的章节菜单到指针位置 */
  const openChapterContextMenu = (
    x: number,
    y: number,
    row: HTMLElement,
    index: number,
  ): void => {
    openRowMenu(null, row, index, { x, y });
  };

  /** 空白处：新建章节 / 新建卷（插入到当前选中章后；没有选中章时追加到末尾） */
  const openAppendMenu = (x: number, y: number): void => {
    const menu = els.rowMenu;
    closeRowMenu();
    rowMenuAnchor = null;
    const total = state.chapters.length;
    const items: Array<{ label: string; glyph: string; act: 'new-chapter' | 'new-volume'; disabled?: boolean }> = [
      {
        label: '新建章节（追加到目录末尾）',
        glyph: '＋',
        act: 'new-chapter',
        disabled: total === 0,
      },
      {
        label: '在当前选中章后新建卷',
        glyph: '卷',
        act: 'new-volume',
        disabled: state.chapters.findIndex((c) => c.id === state.activeId) < 0,
      },
    ];
    for (const item of items) {
      const menuItem = document.createElement('button');
      menuItem.type = 'button';
      menuItem.setAttribute('role', 'menuitem');
      menuItem.dataset.act = item.act;
      menuItem.disabled = Boolean(item.disabled);
      const glyph = document.createElement('span');
      glyph.className = 'row-menu-glyph';
      glyph.textContent = item.glyph;
      const label = document.createElement('span');
      label.textContent = item.label;
      menuItem.append(glyph, label);
      menuItem.addEventListener('click', () => {
        closeRowMenu();
        const activeIndex = state.chapters.findIndex((c) => c.id === state.activeId);
        if (item.act === 'new-chapter') {
          const index = activeIndex >= 0 ? activeIndex : total - 1;
          if (index < 0) {
            deps.toast('还没有章节，先导入一本书');
            return;
          }
          deps.insertChapter(index, 'after');
          return;
        }
        if (activeIndex < 0) {
          deps.toast('先在目录里选中一个章节');
          return;
        }
        deps.addVolumeAfter(activeIndex);
      });
      menu.append(menuItem);
    }
    menu.hidden = false;
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
    menu.style.left = `${Math.max(8, Math.min(x, maxLeft))}px`;
    let top = y + 4;
    if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, y - menuRect.height - 4);
    }
    menu.style.top = `${Math.max(8, top)}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null;
      if (!node) return;
      if (!menu.contains(node)) closeRowMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeRowMenu();
    };
    const onScroll = (): void => closeRowMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    rowMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  };

  /** 正文段落右键菜单 */
  const openParagraphEndMenu = (x: number, y: number): void => {
    const menu = els.rowMenu;
    closeRowMenu();
    rowMenuAnchor = null;
    const menuItem = document.createElement('button');
    menuItem.type = 'button';
    menuItem.setAttribute('role', 'menuitem');
    menuItem.dataset.act = 'add';
    const glyph = document.createElement('span');
    glyph.className = 'row-menu-glyph';
    glyph.textContent = '＋';
    const label = document.createElement('span');
    label.textContent = '在本章末尾新增段落';
    menuItem.append(glyph, label);
    menuItem.addEventListener('click', () => {
      closeRowMenu();
      const chapterIndex = state.chapters.findIndex((c) => c.id === state.activeId);
      if (chapterIndex < 0) return;
      deps.insertParagraph(chapterIndex, Number.POSITIVE_INFINITY);
    });
    menu.append(menuItem);
    menu.hidden = false;
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
    menu.style.left = `${Math.max(8, Math.min(x, maxLeft))}px`;
    let top = y + 4;
    if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, y - menuRect.height - 4);
    }
    menu.style.top = `${Math.max(8, top)}px`;
    menuItem.focus();

    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null;
      if (!node) return;
      if (!menu.contains(node)) closeRowMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeRowMenu();
    };
    const onScroll = (): void => closeRowMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    rowMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  };

  /** 正文段落右键菜单 */
  const openParagraphContextMenu = (
    x: number,
    y: number,
    paragraphIndex: number,
  ): void => {
    const menu = els.rowMenu;
    closeRowMenu();
    rowMenuAnchor = null;
    const isVolume = state.chapters.find((c) => c.id === state.activeId)?.level === 1;
    const items: Array<{ label: string; glyph: string; act: string; danger?: boolean; disabled?: boolean }> = [
      { label: '编辑这一段', glyph: '✎', act: 'edit' },
      { label: '在这一段后面新增段落', glyph: '＋', act: 'add' },
      { label: '从此分章', glyph: '⇂', act: 'split', disabled: paragraphIndex <= 0 },
      { label: '设为标题', glyph: 'T', act: 'title', disabled: paragraphIndex <= 0 },
      {
        label: '设为卷名',
        glyph: '卷',
        act: 'volume',
        disabled: isVolume || paragraphIndex <= 0,
      },
      { label: '删除段落', glyph: '×', act: 'delete', danger: true },
    ];
    for (const item of items) {
      const menuItem = document.createElement('button');
      menuItem.type = 'button';
      menuItem.setAttribute('role', 'menuitem');
      menuItem.dataset.act = item.act;
      menuItem.disabled = Boolean(item.disabled);
      if (item.danger) menuItem.classList.add('danger');
      const glyph = document.createElement('span');
      glyph.className = 'row-menu-glyph';
      glyph.textContent = item.glyph;
      const label = document.createElement('span');
      label.textContent = item.label;
      menuItem.append(glyph, label);
      menuItem.addEventListener('click', () => {
        if (item.act === 'delete') {
          const armed = armConfirm(menuItem, '再点一次删除');
          if (armed) return;
        }
        closeRowMenu();
        const chapterIndex = state.chapters.findIndex((c) => c.id === state.activeId);
        if (item.act === 'edit') deps.beginParagraphEdit(chapterIndex, paragraphIndex);
        else if (item.act === 'add') deps.insertParagraph(chapterIndex, paragraphIndex);
        else if (item.act === 'split') deps.splitAt(chapterIndex, paragraphIndex, 'split');
        else if (item.act === 'title') deps.splitAt(chapterIndex, paragraphIndex, 'title');
        else if (item.act === 'volume') deps.setVolumeFromParagraph(chapterIndex, paragraphIndex);
        else deps.deleteParagraph(paragraphIndex, chapterIndex);
      });
      menu.append(menuItem);
    }
    menu.hidden = false;
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
    menu.style.left = `${Math.max(8, Math.min(x, maxLeft))}px`;
    let top = y + 4;
    if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, y - menuRect.height - 4);
    }
    menu.style.top = `${Math.max(8, top)}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null;
      if (!node) return;
      if (!menu.contains(node)) closeRowMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeRowMenu();
    };
    const onScroll = (): void => closeRowMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    rowMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  };

  /* ---------- 居中弹窗：每个入口一个独立弹窗 ---------- */

  const dialogs = {
    info: createAppDialog(els.infoDialog, els.infoDialogClose),
    layout: createAppDialog(els.layoutDialog, els.layoutDialogClose),
    rules: createAppDialog(els.rulesDialog, els.rulesDialogClose),
    export: createAppDialog(els.exportDialog, els.exportDialogClose),
    diag: createAppDialog(els.diagDialog, els.diagDialogClose),
  };

  // 顶栏齿轮：默认打开「书籍信息」
  els.settingsBtn.addEventListener('click', () => dialogs.info.open(els.settingsBtn));

  // 右栏入口列表：每项直达自己的弹窗
  els.settingsRail
    .querySelectorAll<HTMLButtonElement>('.rail-item')
    .forEach((item) => {
      item.addEventListener('click', () => {
        const dialog = dialogs[(item.dataset.pane ?? 'info') as keyof typeof dialogs];
        dialog?.open(item);
      });
    });
  // 右栏底部常驻「导出」按钮：打开导出弹窗（格式 / EPUB 版本在里面选）
  els.railExport.addEventListener('click', () => dialogs.export.open(els.railExport));

  /* ---------- 移动端顶栏「更多」菜单 ---------- */

  let topMoreCleanup: (() => void) | null = null;

  const closeTopMore = (restoreFocus = false): void => {
    if (els.topMoreMenu.hidden) return;
    els.topMoreMenu.hidden = true;
    els.moreBtn.setAttribute('aria-expanded', 'false');
    topMoreCleanup?.();
    topMoreCleanup = null;
    if (restoreFocus) els.moreBtn.focus();
  };

  const openTopMore = (): void => {
    if (!els.topMoreMenu.hidden) {
      closeTopMore(true);
      return;
    }
    // 安装按钮只有在可安装时才出现在菜单里
    const installEntry = els.topMoreMenu.querySelector<HTMLElement>('[data-more="install"]');
    if (installEntry) installEntry.hidden = els.installApp.hidden;
    els.topMoreMenu.hidden = false;
    els.moreBtn.setAttribute('aria-expanded', 'true');
    els.topMoreMenu.querySelector<HTMLElement>('button:not([hidden])')?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null;
      if (!node) return;
      if (els.topMoreMenu.contains(node) || els.moreBtn.contains(node)) return;
      closeTopMore();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeTopMore(true);
    };
    const onDismiss = (): void => closeTopMore();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    topMoreCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  };

  els.moreBtn.addEventListener('click', openTopMore);
  els.topMoreMenu.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-more]');
    if (!button) return;
    closeTopMore();
    const act = button.dataset.more;
    if (act === 'diag') els.diagBtn.click();
    else if (act === 'help') els.helpBtn.click();
    else if (act === 'notice') document.querySelector<HTMLElement>('#notice-btn')?.click();
    else if (act === 'theme') deps.toggleTheme();
    else if (act === 'install') els.installApp.click();
    else if (act === 'github') {
      const href = document.querySelector<HTMLAnchorElement>('#github-link')?.href;
      if (href) window.open(href, '_blank', 'noopener');
    }
  });

  /* ---------- 快捷键帮助 ---------- */

  let shortcutsTrigger: HTMLElement | null = null;
  let shortcutsModalCleanup: (() => void) | null = null;

  const openShortcuts = (trigger: HTMLElement | null): void => {
    if (!els.shortcuts.hidden) return;
    closeRowMenu();
    shortcutsTrigger = trigger;
    els.shortcuts.hidden = false;
    shortcutsModalCleanup = beginModal(els.shortcuts);
    els.shortcutsClose.focus();
  };

  const closeShortcuts = (): void => {
    if (els.shortcuts.hidden) return;
    els.shortcuts.hidden = true;
    shortcutsModalCleanup?.();
    shortcutsModalCleanup = null;
    const trigger = shortcutsTrigger;
    shortcutsTrigger = null;
    if (trigger && document.contains(trigger)) trigger.focus();
  };

  els.helpBtn.addEventListener('click', () => openShortcuts(els.helpBtn));
  els.shortcutsClose.addEventListener('click', closeShortcuts);
  els.shortcuts.addEventListener('click', (event) => {
    if (event.target === els.shortcuts) closeShortcuts();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && !els.shortcuts.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeShortcuts();
        return;
      }
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      event.preventDefault();
      openShortcuts(els.helpBtn);
    },
    true,
  );

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

  els.undoBtn.addEventListener('click', () => deps.undo());
  els.redoBtn.addEventListener('click', () => deps.redo());

  // 批量移动模式：面板头部「多选」开关 + 操作条
  els.multiToggle.addEventListener('click', () => deps.setMultiMode(!state.multiMode));
  els.multiAll.addEventListener('click', () => deps.selectAllVisible());
  els.multiExit.addEventListener('click', () => deps.setMultiMode(false));
  els.multiMove.addEventListener('click', () => {
    const indexes = state.multiSelect
      .map((id) => state.chapters.findIndex((chapter) => chapter.id === id))
      .filter((index) => index >= 0);
    if (indexes.length) deps.startMove(indexes);
  });

  // 常规分页：上一页 / 下一页
  els.pagerPrev.addEventListener('click', () => deps.jumpListWindow('prev'));
  els.pagerNext.addEventListener('click', () => deps.jumpListWindow('next'));

  els.pickFile.addEventListener('click', () => els.fileInput.click());
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
    // 任何位置拖入都拦截浏览器默认行为（默认会用新页面打开文件，等于离开应用）
    event.preventDefault();
    const target = event.target as Node | null;
    if (target && els.dropZone.contains(target)) return; // 落地页拖拽区有自己的处理
    if (!els.batch.hidden) return; // 批量页不接收新文件
    const files = Array.from(event.dataTransfer?.files ?? []).filter((item) => /\.(txt|epub|docx)$/i.test(item.name));
    if (!files.length) {
      deps.toast('请拖入 .txt / .epub / .docx 文件');
      return;
    }
    if (files.length === 1) {
      if (state.parsed) deps.toast('当前书已自动保存，正在导入新书');
      void deps.loadFile(files[0]);
    } else {
      deps.startBatch(files);
    }
  });

  els.chapterList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    // 目录窗口门牌（长书时显示）：不落在任何章节行里，先于行判断处理
    const row = target.closest<HTMLElement>('.chapter-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (!Number.isFinite(index) || index < 0) return;

    // 批量移动模式：点行 = 切换勾选，行内快捷操作与多选菜单都归属这里
    if (state.multiMode) {
      deps.toggleMultiSelect(row.dataset.id ?? '');
      return;
    }

    const menuButton = target.closest<HTMLButtonElement>('.row-menu-btn');
    if (menuButton) {
      openRowMenu(menuButton, row, index);
      return;
    }

    const action = target.closest<HTMLElement>('[data-act]')?.dataset.act;
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
    if (input && input.readOnly && !state.multiMode) deps.beginTitleEdit(input);
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

  /* ---------- 右键 / 长按接管 ---------- */

  // 只有自带视角的地方才接管右键：输入框 / 弹窗 / 文档页保留浏览器原生菜单（复制粘贴）
  const bindPointerMenu = (element: HTMLElement, showMenu: (x: number, y: number) => void): void => {
    // 触屏长按（iOS Safari 不派发 contextmenu）：550ms 按住未移动即当右键
    let longPressTimer = 0;
    let lastTouch: { x: number; y: number } | null = null;
    element.addEventListener(
      'touchstart',
      (event) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        if (!touch) return;
        lastTouch = { x: touch.clientX, y: touch.clientY };
        window.clearTimeout(longPressTimer);
        longPressTimer = window.setTimeout(() => {
          if (lastTouch) showMenu(lastTouch.x, lastTouch.y);
        }, 550);
      },
      { passive: true },
    );
    const cancel = (): void => window.clearTimeout(longPressTimer);
    element.addEventListener('touchmove', cancel, { passive: true });
    element.addEventListener('touchend', cancel, { passive: true });
    element.addEventListener('touchcancel', cancel, { passive: true });

    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showMenu(event.clientX, event.clientY);
    });
  };

  bindPointerMenu(els.chapterList, (x, y) => {
    const target = document.elementFromPoint(x, y) ?? els.chapterList;
    const row = target.closest<HTMLElement>('.chapter-row');
    if (row) {
      const index = Number(row.dataset.index);
      if (Number.isFinite(index) && index >= 0) {
        openChapterContextMenu(x, y, row, index);
        return;
      }
    }
    openAppendMenu(x, y);
  });

  bindPointerMenu(els.preview, (x, y) => {
    // 输入中的编辑器交给浏览器原生菜单（复制 / 粘贴）
    const target = document.elementFromPoint(x, y) ?? els.preview;
    if (target.closest('.p-editor') || target.tagName === 'TEXTAREA') return;
    if (els.rowMenu.contains(target)) return;
    const p = target instanceof HTMLElement ? target.closest<HTMLElement>('p[data-index]') : null;
    if (p) {
      openParagraphContextMenu(x, y, Number(p.dataset.index) || 0);
      return;
    }
    // 正文空白处：菜单里只剩「在本章末尾新增段落」
    openParagraphEndMenu(x, y);
  });

  /* ---------- 分页尺寸 ---------- */

  els.pagerSize.addEventListener('change', () => {
    deps.setListPageSize(Number(els.pagerSize.value) || 400);
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
  // 查找内容变化时即时校验（非法正则立刻提示，不用等点「预览」才发现）
  let replaceValidateTimer = 0;
  const scheduleReplaceValidate = () => {
    window.clearTimeout(replaceValidateTimer);
    replaceValidateTimer = window.setTimeout(() => deps.validateReplaceInput(), 250);
  };
  els.replaceFind.addEventListener('input', scheduleReplaceValidate);
  els.replaceRegex.addEventListener('change', scheduleReplaceValidate);
  els.replaceCase.addEventListener('change', scheduleReplaceValidate);
  // 自定义规则 JSON 同样即时校验
  let ruleValidateTimer = 0;
  els.ruleJson.addEventListener('input', () => {
    window.clearTimeout(ruleValidateTimer);
    ruleValidateTimer = window.setTimeout(() => deps.validateRuleInput(), 300);
  });
  els.export.addEventListener('click', () => deps.exportCurrentBook());
  els.exportFormat.addEventListener('change', () => deps.setExportFormat(els.exportFormat.value));
  els.batchFormat.addEventListener('change', () => deps.setExportFormat(els.batchFormat.value));
  els.epubVersion.addEventListener('change', () => {
    state.epubVersion = els.epubVersion.value === '2' ? 2 : 3;
    render.updateExportHint();
    saveEpubVersion(state.epubVersion);
    deps.scheduleDraftSave(0);
  });
  let clearConfirmTimer = 0;
  const resetClearDraftButton = (): void => {
    window.clearTimeout(clearConfirmTimer);
    delete els.clearDraft.dataset.confirm;
    els.clearDraft.textContent = '从书架删除这本书';
  };
  els.clearDraft.addEventListener('click', () => {
    if (els.clearDraft.dataset.confirm === '1') {
      resetClearDraftButton();
      void deps.handleClearDraft();
      return;
    }
    els.clearDraft.dataset.confirm = '1';
    els.clearDraft.textContent = '再点一次确认删除';
    window.clearTimeout(clearConfirmTimer);
    clearConfirmTimer = window.setTimeout(resetClearDraftButton, 4000);
  });
  els.batchDownload.addEventListener('click', () => void deps.downloadBatchZip());
  els.batchList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-batch-act]');
    if (!button) return;
    const index = Number(button.closest<HTMLElement>('.batch-item')?.dataset.index);
    if (button.dataset.batchAct === 'save') {
      if (Number.isFinite(index)) deps.downloadBatchItem(index);
      return;
    }
    if (button.dataset.batchAct === 'retry') deps.retryBatch();
  });
  els.batchClose.addEventListener('click', () => {
    if (state.batchRunning) {
      state.batchCancelled = true;
      els.batchClose.disabled = true;
      els.batchStatus.textContent = '正在结束当前任务…';
      deps.cancelBatch?.();
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
    const before = els.customCss.value.length;
    state.layout.customCss = els.customCss.value.slice(0, 20000);
    els.customCss.title = `附加 CSS：${Math.min(before, 20000)} / 20000 字`;
    if (before > 20000 && before - state.layout.customCss.length > 0) {
      deps.toast('附加 CSS 已达到 20000 字上限，超出部分不会保存');
    }
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

  els.metaStatus.addEventListener('input', () => {
    state.meta.status = els.metaStatus.value || undefined;
    deps.scheduleDraftSave();
  });

  /* ---------- 正文段落：新增 / 编辑 / 删除 ---------- */

  // 段落编辑器：Esc 取消、Ctrl(Cmd)+Enter 或点保存/点到别处保存
  els.preview.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList?.contains('p-editor-input')) return;
    const ta = target as HTMLTextAreaElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      deps.cancelParagraphEdit();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      deps.editParagraphFrom(ta);
    }
  });

  els.preview.addEventListener('focusout', (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList?.contains('p-editor-input')) return;
    deps.editParagraphFrom(target as HTMLTextAreaElement);
  });

  els.preview.addEventListener('click', (event) => {
    // 当前预览章在 chapters 里的下标（预览永远只显示活动章）
    const activeIndex = () => state.chapters.findIndex((c) => c.id === state.activeId);
    // 打开新编辑器 / 删除段落前，先把正在编辑的内容落盘，避免双编辑态与下标错位
    const commitOpenEditor = (): void => {
      const ta = els.preview.querySelector<HTMLTextAreaElement>('.p-editor-input');
      if (ta && ta.dataset.done !== '1') deps.editParagraphFrom(ta);
    };
    const actionButton = (event.target as HTMLElement).closest<HTMLElement>('[data-pact]');
    if (actionButton) {
      const act = actionButton.dataset.pact;
      const editor = actionButton.closest<HTMLElement>('.p-editor');
      const paragraphEl = actionButton.closest<HTMLElement>('p[data-index]');
      if (act === 'edit') {
        commitOpenEditor();
        deps.beginParagraphEdit(activeIndex(), Number(paragraphEl?.dataset.index) || 0);
        return;
      }
      if (act === 'add') {
        commitOpenEditor();
        deps.insertParagraph(activeIndex(), Number(paragraphEl?.dataset.index) || 0);
        return;
      }
      if (act === 'add-end') {
        commitOpenEditor();
        deps.insertParagraph(activeIndex(), Number.POSITIVE_INFINITY);
        return;
      }
      if (act === 'del') {
        commitOpenEditor();
        const armed = armConfirm(actionButton, '确认删除');
        if (armed) {
          deps.toast('再点一次即可删除这一段');
          return;
        }
        deps.deleteParagraph(Number(paragraphEl?.dataset.index) || 0, activeIndex());
        return;
      }
      if (act === 'save') {
        const ta = editor?.querySelector<HTMLTextAreaElement>('.p-editor-input');
        if (ta) deps.editParagraphFrom(ta);
        return;
      }
      if (act === 'cancel') {
        deps.cancelParagraphEdit();
      }
      return;
    }

    // 编辑器里的其余点击（比如提示文字）不落到段落选择
    if ((event.target as HTMLElement).closest('.p-editor')) return;

    // 点到普通段落：保持原来的「选中段落，可分章」交互
    const paragraph = (event.target as HTMLElement).closest<HTMLElement>('p[data-index]');
    if (!paragraph) return;
    const index = Number(paragraph.dataset.index);
    deps.selectParagraph(state.selectedParagraph === index ? null : index);
  });

  els.preview.addEventListener('dblclick', (event) => {
    const p = (event.target as HTMLElement).closest<HTMLElement>('p[data-index]');
    if (!p) return;
    if (state.editingParagraph) return;
    const chapterIndex = state.chapters.findIndex((c) => c.id === state.activeId);
    if (chapterIndex < 0) return;
    deps.beginParagraphEdit(chapterIndex, Number(p.dataset.index) || 0);
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
    if (action === 'volume') {
      // 卷名行之前的文字留在上一卷，选中段落变成新卷（文件夹）
      deps.setVolumeFromParagraph(chapterIndex, state.selectedParagraph);
      deps.selectParagraph(null);
      return;
    }
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
      if (first?.dataset.id) deps.revealChapter(first.dataset.id);
    }
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
    deps.revealChapter(chapter.id);
    if (button.dataset.role === 'audit') {
      const raw = button.dataset.paragraphIndex;
      if (raw) deps.selectParagraph(Number(raw), true);
      return;
    }
    deps.selectParagraph(paragraphIndex, true);
  });
}

