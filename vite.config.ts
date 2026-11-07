import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function formatBuildTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const valueOf = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${valueOf('year')}-${valueOf('month')}-${valueOf('day')} ${valueOf('hour')}:${valueOf('minute')}`;
}

const APP_VERSION = readVersion();
const BUILT_AT = new Date().toISOString();

function appMetaPlugin(): Plugin {
  return {
    name: 'bookloom-app-meta',
    transformIndexHtml(html) {
      return html
        .replaceAll('%APP_VERSION%', APP_VERSION)
        .replaceAll('%BUILD_TIME%', formatBuildTime(BUILT_AT))
        .replaceAll('%BUILD_ISO%', BUILT_AT);
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [appMetaPlugin()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 8192,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
  worker: {
    format: 'es',
  },
});
