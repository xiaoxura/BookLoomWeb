/**
 * 模态浮层的可访问性：打开时把页面区域设为 inert（键盘 / 读屏无法到达背景），
 * 并在浮层内做 Tab 焦点循环。返回清理函数，关闭时调用。
 */
export function beginModal(container: HTMLElement): () => void {
  const regions = Array.from(
    document.querySelectorAll<HTMLElement>('body > header, body > main'),
  );
  const previousInert = regions.map((region) => region.hasAttribute('inert'));
  regions.forEach((region) => region.setAttribute('inert', ''));

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => !node.hasAttribute('disabled') && node.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && container.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    regions.forEach((region, index) => {
      if (previousInert[index]) region.setAttribute('inert', '');
      else region.removeAttribute('inert');
    });
  };
}
