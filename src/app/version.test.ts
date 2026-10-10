import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { COMMIT, VERSION, versionLabel } from './version';

describe('version', () => {
  it('takes the version from package.json', () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toBe('0.1.0-beta.3');
  });
  it('labels the build with version and commit', () => {
    expect(COMMIT).toMatch(/^[0-9a-f]{7,}$|^unknown$/);
    expect(versionLabel()).toBe(`oinbox ${VERSION} (${COMMIT})`);
  });
});
