import { zipSync } from 'fflate';
import { chaptersFromText, countChars, guessAuthor, guessTitle, guessTitleFromText } from '../core/chapters';
import { buildEpub } from '../core/epub';
import { compileRules } from '../core/rules';
import { decodeBuffer, normalizeText } from '../core/text';
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

function runParse(id: number, options: ParseOptions) {
  if (!buffer) throw new Error('没有可解析的文件');

  post({ id, type: 'progress', phase: '正在检测编码…' });
  const decoded = decodeBuffer(buffer, options.encoding);

  post({ id, type: 'progress', phase: '正在识别章节…' });
  const text = normalizeText(decoded.text);
  const rules = compileRules(options.rules);
  const { chapters, warnings } = chaptersFromText(text, { filterAds: options.filterAds, rules });

  if (decoded.confidence < 0.7) {
    warnings.unshift('编码识别把握不大，如果正文有乱码，请在右侧手动切换编码后重新识别。');
  }

  const result: ParseResult = {
    encoding: decoded.encoding,
    confidence: decoded.confidence,
    chars: countChars(text),
    chapters,
    warnings,
    titleGuess: guessTitleFromText(text.slice(0, 2000)) || guessTitle(filename),
    authorGuess: guessAuthor(text.slice(0, 5000)),
  };

  post({ id, type: 'parsed', result });
}

ctx.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === 'parse') {
      buffer = message.buffer;
      filename = message.filename;
      runParse(message.id, message.options);
      return;
    }

    if (message.type === 'reparse') {
      runParse(message.id, message.options);
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
        version: message.version,
      });
      post({ id: message.id, type: 'packed', data }, [data.buffer as ArrayBuffer]);
      return;
    }

    if (message.type === 'zip') {
      post({ id: message.id, type: 'progress', phase: '正在打包 ZIP…' });
      const data = zipSync(message.files, { level: 0 });
      post({ id: message.id, type: 'zipped', data }, [data.buffer as ArrayBuffer]);
    }
  } catch (error) {
    post({
      id: message.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
