import type { BookMeta, Chapter, CoverData, LayoutOptions, ParseOptions, ParseResult } from '../types';

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
      version: 2 | 3;
    };

export type FromWorker =
  | { id: number; type: 'ready' }
  | { id: number; type: 'parsed'; result: ParseResult }
  | { id: number; type: 'packed'; data: Uint8Array }
  | { id: number; type: 'progress'; phase: string }
  | { id: number; type: 'error'; message: string };
