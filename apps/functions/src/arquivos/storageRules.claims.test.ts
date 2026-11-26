import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERM } from '@delfrance/auth';

// Offline backstop for the hand-written root `storage.rules` — the behaviour suite
// (`storageRules.storage.test.ts`) needs the emulator, this does not.
//
// The rules authorise with the generated Firestore ruleset's claims, by NAME. A
// PERM domain renamed or a helper edited on one side only fails nothing: rules
// read an unknown claim as 0, so the Storage paths would silently become
// deny-all (or, with a loosened helper, allow-all). This pins both halves.

const root = (file: string) => fileURLToPath(new URL(`../../../../${file}`, import.meta.url));
const storageRules = readFileSync(root('storage.rules'), 'utf8');
const firestoreRules = readFileSync(root('firestore.rules'), 'utf8');

/** The body of `function <name>(…) { … }` with whitespace collapsed. */
function functionBody(rules: string, name: string): string {
  const match = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{([^}]*)\\}`).exec(rules);
  if (!match) throw new Error(`function ${name} not found`);
  return `${match[1]}|${match[2]}`.replace(/\s+/g, ' ').trim();
}

describe('storage.rules claims', () => {
  it('names only d_* claims that are real PERM domains', () => {
    const named = [...storageRules.matchAll(/'d_([A-Za-z]+)'/g)].map((m) => m[1] ?? '');
    expect(named.length).toBeGreaterThan(0);
    const domains = new Set(Object.keys(PERM));
    expect(named.filter((d) => !domains.has(d))).toEqual([]);
  });

  it('uses the same claim helpers as the generated firestore.rules', () => {
    for (const name of ['p', 'isSuperUser']) {
      expect(functionBody(storageRules, name)).toBe(functionBody(firestoreRules, name));
    }
  });

  it('the helper extraction sees a difference (not a vacuous comparison)', () => {
    expect(functionBody(storageRules, 'p')).not.toBe(functionBody(storageRules, 'isSuperUser'));
  });
});
