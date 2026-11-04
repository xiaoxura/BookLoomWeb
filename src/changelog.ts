import { initNotice } from './notice';

type ThemeMode = 'light' | 'dark';

const THEME_KEY = 'txt2book.theme';

const toggle = document.querySelector<HTMLButtonElement>('#theme-toggle');
const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

function currentTheme(): ThemeMode {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(mode: ThemeMode, persist = true): void {
  const dark = mode === 'dark';
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;

  const label = dark ? '切换到浅色主题' : '切换到深色主题';
  if (toggle) {
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-pressed', String(dark));
  }
  if (meta) meta.content = dark ? '#17150f' : '#f4efe4';

  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      /* 隐私模式下可能写入失败 */
    }
  }
}

applyTheme(currentTheme(), false);

toggle?.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

initNotice();
