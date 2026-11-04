import { describe, expect, it } from 'vitest';
import * as client from '../index';
import * as auth from './auth';
import * as signatures from './signatures';

// The explicit admin subpaths must never become part of the browser entry,
// including indirectly through another root export (#1431).
describe('shared security export boundaries', () => {
  it.each([
    ['auth', auth],
    ['signatures', signatures],
  ] as const)('keeps %s outside the client root', (_name, serverExports) => {
    const names = Object.keys(serverExports);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => name in client)).toEqual([]);
  });
});
