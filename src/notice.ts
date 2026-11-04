/**
 * 站内公告：右上角铃铛 + 弹窗。
 * 内容集中在这里，index.html 和 changelog.html 共用同一份，避免两个页面各改各的。
 */

const NOTICE_KEY = 'txt2book.noticeSeen';

interface NoticeItem {
  lead: string;
  text: string;
}

const NOTICE = {
  id: 'welcome-2026-11',
  kicker: '站内公告',
  title: '写在开始之前',
  intro: '这个工具只做一件事：把你手里的 TXT / EPUB / DOCX 整理成排版舒服的电子书。',
  items: [
    {
      lead: '全部在你的浏览器里完成',
      text: '文件不上传、不联网，断网也能用；草稿只存在本机，清除浏览器数据就会消失。',
    },
    {
      lead: '请只转换你有权处理的内容',
      text: '这里不提供、也不存储任何书，更不会破解 DRM。喜欢一本书，请支持正版。',
    },
    {
      lead: 'TXT 先认编码再分章，EPUB / DOCX 按原书顺序拆回章节',
      text: '卷/章层级和封面会尽量保留；DOCX 依赖标题样式，插图、脚注和复杂排版带不过来。',
    },
    {
      lead: '多本书会留在书架里',
      text: '顶栏书架可以切换、改名、删除，旧版单草稿会自动迁移过来。',
    },
    {
      lead: '认错的地方随时能改',
      text: '标题、分章、卷级都能在左侧列表里调整，改完再导出。',
    },
  ] as NoticeItem[],
  footnote: '公告只记录在本机，关掉后点右上角的铃铛可以再看。',
  hint: 'TXT / EPUB / DOCX 都可以，拖进来就行',
  ok: '开始使用',
};

let initialized = false;
let trigger: HTMLElement | null = null;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildNotice(): HTMLElement {
  const overlay = make('div', 'notice-overlay');
  overlay.id = 'notice';
  overlay.hidden = true;
  overlay.dataset.noticeId = NOTICE.id;

  const card = make('section', 'notice-card');
  card.id = 'notice-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'notice-title');
  card.tabIndex = -1;

  const head = make('div', 'notice-head');
  const heading = make('div');
  heading.append(make('p', 'notice-kicker', NOTICE.kicker));
  const title = make('h2', undefined, NOTICE.title);
  title.id = 'notice-title';
  heading.append(title);

  const closeButton = make('button', 'notice-close', '×');
  closeButton.id = 'notice-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭公告');
  head.append(heading, closeButton);

  const body = make('div', 'notice-body');
  body.append(make('p', undefined, NOTICE.intro));
  const list = make('ul');
  for (const item of NOTICE.items) {
    const row = make('li');
    row.append(make('b', undefined, item.lead), document.createTextNode(`：${item.text}`));
    list.append(row);
  }
  body.append(list, make('p', 'notice-dim', NOTICE.footnote));

  const foot = make('div', 'notice-foot');
  foot.append(make('p', 'hint', NOTICE.hint));
  const okButton = make('button', 'primary', NOTICE.ok);
  okButton.id = 'notice-ok';
  okButton.type = 'button';
  foot.append(okButton);

  card.append(head, body, foot);
  overlay.append(card);
  return overlay;
}

export function initNotice(): void {
  if (initialized) return;
  const button = document.querySelector<HTMLElement>('#notice-btn');
  if (!button || document.querySelector('#notice')) return;
  initialized = true;

  const overlay = buildNotice();
  document.body.append(overlay);

  const card = overlay.querySelector<HTMLElement>('#notice-card');
  const closeButton = overlay.querySelector<HTMLButtonElement>('#notice-close');
  const okButton = overlay.querySelector<HTMLButtonElement>('#notice-ok');
  if (!card || !closeButton || !okButton) return;

  const seen = (): boolean => {
    try {
      return localStorage.getItem(NOTICE_KEY) === NOTICE.id;
    } catch {
      return true;
    }
  };

  const markSeen = (): void => {
    try {
      localStorage.setItem(NOTICE_KEY, NOTICE.id);
    } catch {
      /* 隐私模式下写不进去就每次弹，不影响使用 */
    }
    button.classList.remove('has-dot');
  };

  const open = (from: HTMLElement | null): void => {
    if (!overlay.hidden) return;
    trigger = from;
    overlay.hidden = false;
    document.body.classList.add('notice-open');
    markSeen();
    // 焦点给弹窗本身而不是按钮，避免一打开就出现一圈焦点环
    card.focus();
  };

  const close = (): void => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove('notice-open');
    const target = trigger;
    trigger = null;
    // 手动打开时把焦点还给铃铛；自动弹出时不清空，避免页面上莫名多一圈焦点环
    if (target && document.contains(target)) {
      target.focus();
    } else {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  };

  button.addEventListener('click', () => open(button));
  closeButton.addEventListener('click', close);
  okButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) close();
  });

  if (!seen()) {
    button.classList.add('has-dot');
    window.setTimeout(() => {
      if (!overlay.hidden) return;
      if (!seen()) open(null);
    }, 700);
  }
}
