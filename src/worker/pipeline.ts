import { zipSync } from 'fflate';
import { chaptersFromText, countChars, guessAuthor, guessTitle, guessTitleFromText, parseFilenameInfo } from '../core/chapters';
import { buildEpub } from '../core/export/epub';
import { detectFormat, importDocxFile, importEpubFile } from '../core/import';
import { convertParseResult, loadConverter } from '../core/convert';
import { compileRules } from '../core/rules';
import { decodeBuffer, normalizeText } from '../core/text';
import { buildFormattedBook } from '../app/export';
import type { ParseOptions, ParseResult } from '../types';
import type { FromWorker, ToWorker } from './protocol';

interface WorkerCtx {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage: (message: FromWorker, transfer?: Transferable[]) => void;
}

const ctx = globalThis as unknown as WorkerCtx;

let buffer: ArrayBuffer | null = null;
let filename = '';

function post(message: FromWorker, transfer?: Transferable[]) {
  ctx.postMessage(message, transfer);
}

async function finishParse(id: number, result: ParseResult, options: ParseOptions): Promise<void> {
  if (options.convert && options.convert !== 'none') {
    post({ id, type: 'progress', phase: '正在转换繁简…' });
    const converter = await loadConverter(options.convert);
    result = convertParseResult(result, converter);
  }
  post({ id, type: 'parsed', result });
}

async function runParse(id: number, options: ParseOptions): Promise<void> {
  if (!buffer) throw new Error('没有可解析的文件');

  const bytes = new Uint8Array(buffer);
  const format = detectFormat(filename, bytes);
  if (format === 'epub') {
    post({ id, type: 'progress', phase: '正在解析 EPUB…' });
    const epub = importEpubFile(bytes, filename);
    await finishParse(id, epub, options);
    return;
  }
  if (format === 'docx') {
    post({ id, type: 'progress', phase: '正在解析 DOCX…' });
    const docx = importDocxFile(bytes, filename);
    await finishParse(id, docx, options);
    return;
  }

  post({ id, type: 'progress', phase: '正在检测编码…' });
  const decoded = decodeBuffer(buffer, options.encoding);

  post({ id, type: 'progress', phase: '正在识别章节…' });
  const text = normalizeText(decoded.text);
  const rules = compileRules(options.rules);
  const { chapters, warnings } = chaptersFromText(text, { filterAds: options.filterAds, rules });

  if (decoded.confidence < 0.7) {
    warnings.unshift('编码识别把握不大，如果正文有乱码，请在右侧「导入与文本」里切换编码后重新识别。');
  }

  const result: ParseResult = {
    encoding: decoded.encoding,
    confidence: decoded.confidence,
    chars: countChars(text),
    chapters,
    warnings,
    titleGuess: guessTitleFromText(text.slice(0, 2000)) || guessTitle(filename),
    authorGuess: guessAuthor(text.slice(0, 5000)) || parseFilenameInfo(filename).author,
  };

  await finishParse(id, result, options);
}

ctx.onmessage = (event) => {
  const message = event.data;
  const fail = (error: unknown) => {
    post({
      id: message.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  };

  try {
    if (message.type === 'parse') {
      buffer = message.buffer;
      filename = message.filename;
      void runParse(message.id, message.options).catch(fail);
      return;
    }

    if (message.type === 'reparse') {
      void runParse(message.id, message.options).catch(fail);
      return;
    }

    // 从草稿恢复时把原始文件塞回 Worker，让「重新识别」仍然可用
    if (message.type === 'source') {
      buffer = message.buffer;
      filename = message.filename;
      post({ id: message.id, type: 'ready' });
      return;
    }

    if (message.type === 'pack') {
      post({ id: message.id, type: 'progress', phase: '正在生成 EPUB…' });
      const data = buildEpub({
        chapters: message.chapters,
        meta: message.meta,
        layout: message.layout,
        cover: message.cover,
        font: message.font,
        version: message.version,
      });
      post({ id: message.id, type: 'packed', data }, [data.buffer as ArrayBuffer]);
      return;
    }

    if (message.type === 'format') {
      post({ id: message.id, type: 'progress', phase: `正在生成 ${message.format.toUpperCase()}…` });
      const formatted = buildFormattedBook(
        message.format,
        message.chapters,
        message.meta,
        message.layout,
      );
      if (!formatted) throw new Error('没有可以导出的正文');
      post(
        { id: message.id, type: 'formatted', data: formatted.data, ext: formatted.ext, mime: formatted.mime },
        [formatted.data.buffer as ArrayBuffer],
      );
      return;
    }

    if (message.type === 'zip') {
      post({ id: message.id, type: 'progress', phase: '正在打包 ZIP…' });
      const data = zipSync(message.files, { level: 0 });
      post({ id: message.id, type: 'zipped', data }, [data.buffer as ArrayBuffer]);
    }
  } catch (error) {
    fail(error);
  }
};
