import type { Els } from './dom';
import type { State } from './state';

export interface ShortcutDeps {
  els: Els;
  state: State;
  closeCoverView: (restoreFocus?: boolean) => void;
  selectParagraph: (index: number | null, scroll?: boolean) => void;
  hideToast: () => void;
  undo: () => void;
  redo: () => void;
  stepChapter: (delta: -1 | 1) => void;
  exportBook: () => void;
}

/** 输入框 / 文本域 / 下拉框聚焦时，单键快捷键要让给输入法 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function handleGlobalKeydown(event: KeyboardEvent, deps: ShortcutDeps): void {
  if (event.isComposing) return;
  const mod = event.ctrlKey || event.metaKey;
  const editable = isEditableTarget(event.target);
  const key = event.key.toLowerCase();

  if (event.key === 'Escape') {
    if (!deps.els.coverView.hidden) {
      deps.closeCoverView(true);
      return;
    }
    if (deps.state.selectedParagraph !== null) {
      deps.selectParagraph(null);
      return;
    }
    if (!deps.els.toast.hidden) deps.hideToast();
    return;
  }

  // Ctrl/Cmd+S：有书时即使在输入框里也拦下浏览器的「保存网页」
  if (mod && key === 's') {
    if (deps.state.chapters.length) {
      event.preventDefault();
      if (!deps.state.busy) deps.exportBook();
    }
    return;
  }

  if (mod && key === 'z') {
    // 输入框里保留浏览器/系统的原生撤销
    if (editable) return;
    event.preventDefault();
    if (event.shiftKey) deps.redo();
    else deps.undo();
    return;
  }
  if (mod && key === 'y') {
    if (editable) return;
    event.preventDefault();
    deps.redo();
    return;
  }

  if (mod || event.altKey || editable) return;

  if (event.key === 'ArrowUp' || key === 'k') {
    if (!deps.state.chapters.length) return;
    event.preventDefault();
    deps.stepChapter(-1);
    return;
  }
  if (event.key === 'ArrowDown' || key === 'j') {
    if (!deps.state.chapters.length) return;
    event.preventDefault();
    deps.stepChapter(1);
    return;
  }
  if (event.key === '/') {
    if (!deps.state.parsed) return;
    event.preventDefault();
    deps.els.chapterSearch.hidden = false;
    deps.els.chapterSearch.focus();
    deps.els.chapterSearch.select();
  }
}

