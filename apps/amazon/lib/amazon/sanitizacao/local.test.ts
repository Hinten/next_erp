import { describe, expect, it } from 'vitest';

import { ancestraisDe, dentroDeCheckout } from './local';

describe('the capture folder sits outside every checkout', () => {
  it('lists the folder and every ancestor, POSIX and Windows', () => {
    expect(ancestraisDe('/home/fulano/capturas/')).toEqual([
      '/home/fulano/capturas',
      '/home/fulano',
      '/home',
      '/',
    ]);
    expect(ancestraisDe('C:\\Users\\fulano\\capturas')).toEqual([
      'C:/Users/fulano/capturas',
      'C:/Users/fulano',
      'C:/Users',
      'C:',
    ]);
  });

  it('★ a folder inside a checkout (.git in an ancestor) is refused', () => {
    const existe = (c: string) => c === '/home/fulano/repo/.git';
    expect(dentroDeCheckout('/home/fulano/repo/capturas', existe)).toBe(true);
    // A worktree's `.git` is a FILE: the check is on existence, of any type.
    expect(dentroDeCheckout('C:/w/repo/capturas', (c) => c === 'C:/w/repo/.git')).toBe(true);
    // The folder itself holding a `.git`.
    expect(dentroDeCheckout('/x/capturas', (c) => c === '/x/capturas/.git')).toBe(true);
  });

  it('near-miss: a sibling folder of a checkout is accepted', () => {
    const existe = (c: string) => c === '/home/fulano/repo/.git';
    expect(dentroDeCheckout('/home/fulano/capturas', existe)).toBe(false);
    expect(dentroDeCheckout('/home/fulano/repo-capturas', existe)).toBe(false);
  });
});
