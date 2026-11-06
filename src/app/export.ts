import { strToU8 } from 'fflate';
import { buildDocx } from '../core/export/docx';
import { buildHtml } from '../core/export/html';
import { buildMarkdown } from '../core/export/markdown';
import { buildTxt } from '../core/export/txt';
import type { BookMeta, Chapter, LayoutOptions } from '../types';
import type { FromWorker } from '../worker/protocol';
import type { RequestPayload } from '../worker/client';
import type { ExportFormat, State } from './state';

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned || '未命名';
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export interface FormattedBook {
  data: Uint8Array;
  ext: string;
  mime: string;
}

/** 非 EPUB 格式的纯函数生成入口；批量导出和单本导出共用，保证结果一致 */
export function buildFormattedBook(
  format: ExportFormat,
  chapters: Chapter[],
  meta: BookMeta,
  layout: LayoutOptions,
): FormattedBook | null {
  if (format === 'epub') return null;
  if (format === 'txt') {
    const text = buildTxt(chapters);
    if (!text.trim()) return null;
    return { data: strToU8(text), ext: 'txt', mime: 'text/plain;charset=utf-8' };
  }
  if (format === 'md') {
    const text = buildMarkdown(chapters, meta);
    if (!text.trim()) return null;
    return { data: strToU8(text), ext: 'md', mime: 'text/markdown;charset=utf-8' };
  }
  if (format === 'docx') {
    return {
      data: buildDocx({ chapters, meta, layout }),
      ext: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }
  return {
    data: strToU8(buildHtml({ chapters, meta, layout })),
    ext: 'html',
    mime: 'text/html;charset=utf-8',
  };
}

export interface ExportedInfo {
  blob: Blob;
  filename: string;
  format: ExportFormat;
}

export interface ExportDeps {
  state: State;
  call: (payload: RequestPayload, transfer?: Transferable[]) => Promise<FromWorker>;
  setStatus: (message: string, kind?: 'normal' | 'error') => void;
  toast: (message: string, action?: { label: string; onClick: () => void }) => void;
  updateControls: () => void;
  onExported?: (info: ExportedInfo) => void;
}

/** 按当前格式导出 EPUB / TXT / Markdown；EPUB 打包在 Worker 里完成 */
export async function exportBook(deps: ExportDeps): Promise<void> {
  const { state, call, setStatus, toast, updateControls } = deps;
  if (!state.chapters.length || state.busy) return;

  if (state.exportFormat !== 'epub') {
    const formatted = buildFormattedBook(state.exportFormat, state.chapters, state.meta, state.layout);
    if (!formatted) {
      toast('没有可以导出的正文');
      return;
    }
    const blob = new Blob([toArrayBuffer(formatted.data)], { type: formatted.mime });
    const filename = `${sanitizeFilename(state.meta.title)}.${formatted.ext}`;
    download(blob, filename);
    setStatus(`已导出 · ${formatBytes(blob.size)}`);
    deps.onExported?.({ blob, filename, format: state.exportFormat });
    toast(`已生成 ${formatted.ext.toUpperCase()}，共 ${state.chapters.length} 章`);
    return;
  }

  state.busy = true;
  updateControls();
  setStatus('正在生成 EPUB…');

  try {
    const res = await call({
      type: 'pack',
      chapters: state.chapters,
      meta: state.meta,
      layout: state.layout,
      cover: state.cover,
      font: state.font,
      version: state.epubVersion,
    });
    if (res.type !== 'packed') return;

    const blob = new Blob([toArrayBuffer(res.data)], { type: 'application/epub+zip' });
    const filename = `${sanitizeFilename(state.meta.title)}.epub`;
    download(blob, filename);
    setStatus(`已导出 · ${formatBytes(blob.size)}`);
    deps.onExported?.({ blob, filename, format: 'epub' });
    toast('EPUB 已生成，拖到阅读器里看看效果吧');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导出失败', 'error');
  } finally {
    state.busy = false;
    updateControls();
  }
}
