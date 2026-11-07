import { beginModal } from './modal';

/**
 * 通用居中弹窗：遮罩 + 卡片（结构在 index.html 里以 .app-dialog 提供）。
 * 负责：打开 / 关闭、背景锁滚动、Esc 与点击遮罩关闭、焦点陷阱（beginModal）、
 * 关闭后把焦点还给触发按钮。
 */
export interface AppDialog {
  readonly root: HTMLElement;
  readonly isOpen: () => boolean;
  open: (trigger?: HTMLElement | null) => void;
  close: (restoreFocus?: boolean) => void;
}

let openCount = 0;

export function createAppDialog(root: HTMLElement, closeButton: HTMLElement): AppDialog {
  let cleanup: (() => void) | null = null;
  let trigger: HTMLElement | null = null;

  closeButton.addEventListener('click', () => close());
  const isOpen = (): boolean => !root.hidden;

  const onPointerDown = (event: PointerEvent): void => {
    // 点在卡片外的遮罩上才关闭；点击卡片内部（包括滚动条）不关
    if (event.target instanceof Node && !root.querySelector('.app-dialog-card')?.contains(event.target)) {
      close();
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || root.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  const open = (from?: HTMLElement | null): void => {
    if (!root.hidden) return;
    trigger = from ?? null;
    root.hidden = false;
    openCount += 1;
    if (openCount === 1) {
      document.documentElement.classList.add('dialog-open');
    }
    cleanup = beginModal(root);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    closeButton.focus();
  };

  const close = (restoreFocus = false): void => {
    if (root.hidden) return;
    const previousTrigger = trigger;
    root.hidden = true;
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) {
      document.documentElement.classList.remove('dialog-open');
    }
    cleanup?.();
    cleanup = null;
    trigger = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (restoreFocus && previousTrigger && document.contains(previousTrigger)) {
      previousTrigger.focus();
    }
  };

  return { root, isOpen, open, close };
}
