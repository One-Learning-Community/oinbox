import { describe, expect, it, vi } from 'vitest';
import { createErrorReporter, errorDetails, errorMessage, isChunkLoadError } from './errors';

describe('errorMessage', () => {
  it('reads any thrown value', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(null)).toBe('Unknown error');
    expect(errorMessage({ nope: 1 })).toBe('Unknown error');
    expect(errorMessage(new Error(''))).toBe('Unknown error');
  });
});

describe('errorDetails', () => {
  it('ends with the version label', () => {
    expect(errorDetails(new Error('boom'))).toMatch(/^boom\n[\s\S]*oinbox 0\.1\.0-beta\.1 \(/);
  });
});

describe('isChunkLoadError', () => {
  it('recognises failed dynamic imports across engines', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
  });
});

describe('createErrorReporter', () => {
  it('shows at most one toast every 10 seconds but logs every error', () => {
    const toast = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let t = 0;
    const r = createErrorReporter(toast, () => t);
    r.report(new Error('a'), 'x');
    r.report(new Error('b'), 'x');
    t = 10_001;
    r.report(new Error('c'), 'x');
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith('Something went wrong. If things look off, reload.', 'error', expect.anything());
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });

  it('says the app was updated when a chunk fails to load', () => {
    const toast = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    createErrorReporter(toast).report(new TypeError('Importing a module script failed.'), 'calendar');
    expect(toast).toHaveBeenCalledWith('oinbox was updated. Reload to continue.', 'error', expect.objectContaining({ label: 'Reload' }));
    log.mockRestore();
  });

  it('listens for window errors and rejections, skipping handled ones', () => {
    const toast = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = createErrorReporter(toast);
    const off = r.install(window, (e) => e === 'auth');
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'auth' }));
    expect(toast).not.toHaveBeenCalled();
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('x') }));
    expect(toast).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('y') }));
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
