import type { BookMeta, Chapter, CoverData, FontData, LayoutOptions, ParseOptions, ParseResult } from '../types';

export type ToWorker =
  | {
      id: number;
      type: 'parse';
      buffer: ArrayBuffer;
      filename: string;
      options: ParseOptions;
    }
  | {
      id: number;
      type: 'reparse';
      options: ParseOptions;
    }
  | {
      id: number;
      type: 'source';
      buffer: ArrayBuffer;
      filename: string;
    }
  | {
      id: number;
      type: 'pack';
      chapters: Chapter[];
      meta: BookMeta;
      layout: LayoutOptions;
      cover: CoverData | null;
      font: FontData | null;
      version: 2 | 3;
    }
  | {
      id: number;
      type: 'format';
      format: 'txt' | 'md' | 'docx' | 'html';
      chapters: Chapter[];
      meta: BookMeta;
      layout: LayoutOptions;
    }
  | {
      id: number;
      type: 'zip';
      files: Record<string, Uint8Array>;
    };

export type FromWorker =
  | { id: number; type: 'ready' }
  | { id: number; type: 'parsed'; result: ParseResult }
  | { id: number; type: 'packed'; data: Uint8Array }
  | { id: number; type: 'formatted'; data: Uint8Array; ext: string; mime: string }
  | { id: number; type: 'zipped'; data: Uint8Array }
  | { id: number; type: 'progress'; phase: string }
  | { id: number; type: 'error'; message: string };
