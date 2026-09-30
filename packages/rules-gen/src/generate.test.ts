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

/**
 * #367 — the Mercado Pago payment-link surface, asserted on the GENERATED source
 * rather than left to the two snapshots. A snapshot is refreshed with `-u`, which
 * accepts whatever the generator now says; these pin the security posture itself
 * (who reads a link, that nobody writes one, and that the attribution stamps stay
 * out of a client's reach), and they run on every machine — the emulator matrix in
 * `test/firestore.rules.test.ts` is skipped without one.
 */
describe.each([
  { variante: 'production', e2e: false },
  { variante: 'e2e', e2e: true },
])('generateRulesSource ($variante) — the payment-link surface (#367)', ({ e2e }) => {
  /** The `header` block (through its first `}`) of this variant's generated source. */
  function bloco(header: RegExp): string {
    const found = generateRulesSource({ e2e }).match(header)?.[0];
    expect(found, `no block matching ${header}`).toBeDefined();
    return found ?? '';
  }

  it('emits the link collection as read-only on the pagamento READ bit, no su bypass', () => {
    const link = bloco(/match \/pedidos\/\{pedidoId\}\/linkPgtoMercadoPago\/\{docId\} \{[^}]*\}/);
    expect(link).toContain("allow read: if isSuperUser() || p('d_pagamento', 1);");
    expect(link).toContain('allow create, update, delete: if false;');
    // Near-misses: no write path under the pagamento WRITE/DELETE bits, and the
    // read claim is not the pedido's (nor the conta's, metodo_pgto).
    expect(link).not.toContain("p('d_pagamento', 2)");
    expect(link).not.toContain("p('d_pagamento', 4)");
    expect(link).not.toContain('d_pedido');
    expect(link).not.toContain('d_metodoPagamento');
  });

  it('emits its collection-group read on the same bit and no other', () => {
    expect(generateRulesSource({ e2e })).toContain(
      [
        '    match /{path=**}/linkPgtoMercadoPago/{docId} {',
        "      allow read: if isSuperUser() || p('d_pagamento', 1);",
        '    }',
      ].join('\n'),
    );
  });

  it('locks both attribution stamps on pagamentos, create and update, beside lastProviderUpdate', () => {
    const pagamentos = bloco(/match \/pedidos\/\{pedidoId\}\/pagamentos\/\{docId\} \{[^}]*\}/);
    for (const campo of ['lastProviderUpdate', 'linkPagamentoId', 'primeiroNomePagador']) {
      // create: absent or null only
      expect(pagamentos).toContain(
        `(!request.resource.data.keys().hasAny(['${campo}']) || request.resource.data.get('${campo}', null) == null)`,
      );
    }
    // update: ANY change to the three is denied — one sorted list, so a stamp
    // dropped from `serverOwnedFields` is a visible diff here.
    expect(pagamentos).toContain(
      "!request.resource.data.diff(resource.data).affectedKeys().hasAny(['lastProviderUpdate', 'linkPagamentoId', 'primeiroNomePagador'])",
    );
    // The guards stay ANDed OUTSIDE the su bypass: a super user still cannot forge.
    expect(pagamentos).toContain("(isSuperUser() || p('d_pagamento', 2)) && v_pedidos_pagamentos(");
  });

  it('bounds both stamps in the pagamentos validator', () => {
    const validador = bloco(/function v_pedidos_pagamentos\(d, c\) \{[^}]*\}/);
    expect(validador).toContain("(!c.hasAny(['linkPagamentoId'])");
    expect(validador).toContain("(!c.hasAny(['primeiroNomePagador'])");
    expect(validador).toContain("d.get('linkPagamentoId', null).size() <= 20");
    expect(validador).toContain("d.get('primeiroNomePagador', null).size() <= 20");
  });
});
