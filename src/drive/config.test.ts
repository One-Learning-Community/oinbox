import { describe, expect, it } from 'vitest';
import { loadDriveConfig, NO_DRIVE, parseDriveConfig } from './config';

const answer = (body: string, status = 200) => () => Promise.resolve(new Response(body, { status }));

describe('parseDriveConfig', () => {
  it('takes enabled and the link threshold', () => {
    expect(parseDriveConfig({ enabled: true, linkOverMb: 35 })).toEqual({ enabled: true, linkOverMb: 35 });
  });
  it('is on only for a true boolean', () => {
    for (const enabled of ['true', 1, {}, null, undefined]) expect(parseDriveConfig({ enabled }).enabled).toBe(false);
  });
  it('keeps 20 MB for a threshold that is not a positive number', () => {
    for (const linkOverMb of [0, -5, '35', NaN, Infinity, null]) expect(parseDriveConfig({ enabled: true, linkOverMb }).linkOverMb).toBe(20);
  });
  it('is off for anything that is not an object', () => {
    for (const raw of [null, 'on', 7, []]) expect(parseDriveConfig(raw)).toEqual(NO_DRIVE);
  });
});

describe('loadDriveConfig', () => {
  it('reads /drive.json', async () => {
    let asked = '';
    const config = await loadDriveConfig((url) => {
      asked = url;
      return Promise.resolve(new Response('{"enabled":true,"linkOverMb":20}'));
    });
    expect(asked).toBe('/drive.json');
    expect(config).toEqual({ enabled: true, linkOverMb: 20 });
  });
  it('is off when the file is missing', async () => {
    expect(await loadDriveConfig(answer('not found', 404))).toEqual(NO_DRIVE);
  });
  it('is off when the answer is the app page, as behind a proxy that knows no such file', async () => {
    expect(await loadDriveConfig(answer('<!doctype html><title>oinbox</title>'))).toEqual(NO_DRIVE);
  });
  it('is off when the request fails', async () => {
    expect(await loadDriveConfig(() => Promise.reject(new TypeError('offline')))).toEqual(NO_DRIVE);
  });
});
