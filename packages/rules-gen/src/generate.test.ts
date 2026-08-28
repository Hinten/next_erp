import { describe, expect, it } from 'vitest';
import { generateRulesSource } from './generate';
import { sizeGate } from './size-gate';

describe('generateRulesSource', () => {
  it('is deterministic', () => {
    expect(generateRulesSource()).toBe(generateRulesSource());
  });

  it('passes the size gate without warnings', () => {
    const warnings: string[] = [];
    sizeGate(generateRulesSource(), (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
  });

  it('matches the committed full-output snapshot (the review artifact)', async () => {
    // A schema/PERM PR shows its exact rules impact as this snapshot's diff.
    // Refresh with: pnpm --filter @delfrance/rules-gen test -u
    await expect(generateRulesSource()).toMatchFileSnapshot('__snapshots__/firestore.rules.snap');
  });

  it('production rules do NOT contain the e2e namespace block', () => {
    // The permissive e2e_* block must never ship to production. `nsColl` is its
    // unique marker (it never appears in the production header or body).
    expect(generateRulesSource()).not.toContain('nsColl');
  });

  it('emits the super-user helper and short-circuits the allow rules', () => {
    const out = generateRulesSource();
    expect(out).toContain('function isSuperUser() {');
    expect(out).toContain("request.auth.token.get('su', false) == true");
    // Permission checks are short-circuited by isSuperUser()...
    expect(out).toContain("allow read: if isSuperUser() || p('d_cliente', 1);");
    // ...but the field validator stays ANDed OUTSIDE the bypass (decision: a
    // super user can write without the bit, but still writes valid data).
    expect(out).toContain(
      "allow create: if (isSuperUser() || p('d_cliente', 2)) && v_clientes(request.resource.data, request.resource.data.keys());",
    );
  });
});

describe('generateRulesSource({ e2e: true })', () => {
  it('is deterministic', () => {
    expect(generateRulesSource({ e2e: true })).toBe(generateRulesSource({ e2e: true }));
  });

  it('passes the size gate without warnings', () => {
    const warnings: string[] = [];
    sizeGate(generateRulesSource({ e2e: true }), (msg) => warnings.push(msg));
    expect(warnings).toEqual([]);
  });

  it('adds the e2e namespace block', () => {
    const e2e = generateRulesSource({ e2e: true });
    expect(e2e).toContain('match /{nsColl}/{document=**} {');
    expect(e2e).toContain(
      "allow read, write: if request.auth != null && nsColl.matches('^e2e_[0-9A-Za-z_]+$');",
    );
  });

  it('drops no production rule (every production rule line survives in the e2e variant)', () => {
    const prodRuleLines = generateRulesSource()
      .split('\n')
      .filter((l) => !l.startsWith('//')); // ignore the differing header comments
    const e2eLines = new Set(generateRulesSource({ e2e: true }).split('\n'));
    for (const line of prodRuleLines) expect(e2eLines.has(line)).toBe(true);
  });

  it('matches the committed e2e full-output snapshot', async () => {
    // Refresh with: pnpm --filter @delfrance/rules-gen test -u
    await expect(generateRulesSource({ e2e: true })).toMatchFileSnapshot(
      '__snapshots__/firestore.e2e.rules.snap',
    );
  });
});
