import type { Page } from '@playwright/test';
import type { ScorerResult } from '../types.ts';

export const F5_VERSION = '0.1.0';

// Analytics / CDN domains whose errors we don't hold against the site.
const IGNORED_ORIGINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'hotjar.com',
  'clarity.ms',
  'segment.com',
  'intercom.io',
  'crisp.chat',
  'sentry.io',
  'bugsnag.com',
];

export interface ErrorCollector {
  readonly consoleErrors: string[];
  readonly networkErrors: Array<{ url: string; status: number }>;
  stop: () => void;
}

export function attachErrorCollector(page: Page): ErrorCollector {
  const consoleErrors: string[] = [];
  const networkErrors: Array<{ url: string; status: number }> = [];

  const onConsole = (msg: import('@playwright/test').ConsoleMessage): void => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text().slice(0, 200));
    }
  };
  const onPageError = (err: Error): void => {
    consoleErrors.push(`Uncaught: ${err.message}`.slice(0, 200));
  };
  const onResponse = async (response: import('@playwright/test').Response): Promise<void> => {
    const status = response.status();
    if (status >= 400) {
      const url = response.url();
      if (!IGNORED_ORIGINS.some((origin) => url.includes(origin))) {
        networkErrors.push({ url: url.slice(0, 200), status });
      }
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  return {
    consoleErrors,
    networkErrors,
    stop() {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponse);
    },
  };
}

export function scoreF5(collector: ErrorCollector): ScorerResult {
  const { consoleErrors, networkErrors } = collector;
  const totalErrors = consoleErrors.length + networkErrors.length;

  // 0 errors = 1.0; linear decay to 0 at 10+ errors
  const score = Math.max(0, 1 - totalErrors / 10);
  const passed = totalErrors === 0;

  return {
    scorer: 'f5',
    version: F5_VERSION,
    passed,
    score,
    details: {
      consoleErrorCount: consoleErrors.length,
      networkErrorCount: networkErrors.length,
      totalErrors,
      consoleErrors: consoleErrors.slice(0, 10),
      networkErrors: networkErrors.slice(0, 10),
    },
  };
}
