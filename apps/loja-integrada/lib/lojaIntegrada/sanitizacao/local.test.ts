import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ancestraisDe, dentroDeCheckout } from './local';

const existentes =
  (...caminhos: string[]) =>
  (caminho: string) =>
    caminhos.includes(caminho);

describe('dentroDeCheckout', () => {
  it('a folder whose ancestor holds a `.git` directory is inside a checkout', () => {
    expect(dentroDeCheckout('/home/u/repo/sub/capturas', existentes('/home/u/repo/.git'))).toBe(
      true,
    );
  });

  it('a folder that holds `.git` itself is inside a checkout', () => {
    expect(dentroDeCheckout('/home/u/repo', existentes('/home/u/repo/.git'))).toBe(true);
  });

  it('a Windows path, with either separator, up to the drive root', () => {
    expect(dentroDeCheckout('C:\\Users\\u\\repo\\x', existentes('C:/Users/u/repo/.git'))).toBe(
      true,
    );
    expect(dentroDeCheckout('C:\\Users\\u\\li-capturas', existentes('C:/.git'))).toBe(true);
  });

  it('a folder with no `.git` anywhere up its ancestors is outside', () => {
    const vistos: string[] = [];
    const existe = (caminho: string) => {
      vistos.push(caminho);
      return false;
    };
    expect(dentroDeCheckout('/home/u/li-capturas', existe)).toBe(false);
    // Anti-vacuity: every level was asked, root included.
    expect(vistos).toEqual(['/home/u/li-capturas/.git', '/home/u/.git', '/home/.git', '/.git']);
    expect(dentroDeCheckout('C:/Users/u/li-capturas', existentes('C:/Users/u/outro/.git'))).toBe(
      false,
    );
  });

  it('ancestraisDe: trailing separators, the root, a drive', () => {
    expect(ancestraisDe('/a/b/')).toEqual(['/a/b', '/a', '/']);
    expect(ancestraisDe('/')).toEqual(['/']);
    expect(ancestraisDe('D:\\x\\')).toEqual(['D:/x', 'D:']);
  });
});

// The script passes `existsSync`, which must see BOTH shapes of a checkout: the
// `.git` directory, and a worktree's `.git` FILE. Synthetic folders under the
// system temp directory only; nothing here reads a real capture.
describe('dentroDeCheckout with the real file system', () => {
  const base = mkdtempSync(join(tmpdir(), 'li-sanitizacao-local-'));
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('a `.git` directory in an ancestor', () => {
    mkdirSync(join(base, 'clone', '.git'), { recursive: true });
    expect(dentroDeCheckout(join(base, 'clone', 'capturas'), existsSync)).toBe(true);
  });

  it("a worktree's `.git` file in an ancestor", () => {
    mkdirSync(join(base, 'worktree'), { recursive: true });
    writeFileSync(join(base, 'worktree', '.git'), 'gitdir: ../outro\n');
    expect(dentroDeCheckout(join(base, 'worktree', 'a', 'b'), existsSync)).toBe(true);
  });
});
