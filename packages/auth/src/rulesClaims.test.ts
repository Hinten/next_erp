import { describe, expect, it } from 'vitest';
import { PERM } from './permissions';
import { ACTION_K, rulesCheckForBit, rulesClaimsFromBits } from './rulesClaims';

// Same value as SUPERUSER_MASK in @delfrance/schemas (usuario.ts); duplicated
// as a literal because auth must not depend on schemas.
const SUPERUSER_BITS = (1n << 128n) - 1n;

describe('rulesClaimsFromBits', () => {
  it('returns an empty object for zero bits', () => {
    expect(rulesClaimsFromBits(0n)).toEqual({});
  });

  it('ORs action constants per domain', () => {
    expect(rulesClaimsFromBits(PERM.cliente.read | PERM.cliente.write)).toEqual({ d_cliente: 3 });
    expect(rulesClaimsFromBits(PERM.produto.delete)).toEqual({ d_produto: 4 });
  });

  it('keeps byte-sharing domains independent (cliente/endereco byte 0)', () => {
    const bits = PERM.cliente.read | PERM.cliente.write | PERM.endereco.delete;
    expect(rulesClaimsFromBits(bits)).toEqual({ d_cliente: 3, d_endereco: 4 });
  });

  it('keeps byte-sharing domains independent (produto/categoria byte 1)', () => {
    const bits = PERM.produto.read | PERM.categoria.read | PERM.categoria.write;
    expect(rulesClaimsFromBits(bits)).toEqual({ d_produto: 1, d_categoria: 3 });
  });

  it('caps configuracoes at 3 (read|write, no delete action)', () => {
    const bits = PERM.configuracoes.read | PERM.configuracoes.write;
    expect(rulesClaimsFromBits(bits)).toEqual({ d_configuracoes: 3 });
  });

  it('maps the superuser mask to every domain fully granted', () => {
    const claims = rulesClaimsFromBits(SUPERUSER_BITS);
    expect(Object.keys(claims).sort()).toEqual(
      Object.keys(PERM)
        .map((d) => `d_${d}`)
        .sort(),
    );
    for (const [domain, actions] of Object.entries(PERM)) {
      const expected = Object.keys(actions).reduce(
        (acc, action) => acc | ACTION_K[action as keyof typeof ACTION_K],
        0,
      );
      expect(claims[`d_${domain}`], domain).toBe(expected);
    }
    expect(claims.d_configuracoes).toBe(3);
    expect(claims.d_cliente).toBe(7);
  });

  it('keeps the full claims payload comfortably under the 1000-byte platform limit', () => {
    const payload = {
      permissions: SUPERUSER_BITS.toString(),
      ...rulesClaimsFromBits(SUPERUSER_BITS),
    };
    expect(JSON.stringify(payload).length).toBeLessThan(800);
  });
});

describe('rulesCheckForBit', () => {
  it('maps plain action bits', () => {
    expect(rulesCheckForBit(PERM.produto.read)).toEqual({ claim: 'd_produto', k: 1 });
    expect(rulesCheckForBit(PERM.nfe.delete)).toEqual({ claim: 'd_nfe', k: 4 });
  });

  it('resolves metas that reuse a bit across actions by bit identity', () => {
    // cargo/filial/usuario declare delete: PERM_CONFIG_WRITE.
    expect(rulesCheckForBit(PERM.configuracoes.write)).toEqual({ claim: 'd_configuracoes', k: 2 });
    // tokenMelEnv declares read: PERM_FRETE_WRITE.
    expect(rulesCheckForBit(PERM.frete.write)).toEqual({ claim: 'd_frete', k: 2 });
  });

  it('throws on bits outside PERM (generate-time failure)', () => {
    // 1n << 78n is one of the retired impostoCategoria bits.
    expect(() => rulesCheckForBit(1n << 78n)).toThrow(/not in PERM/);
    expect(() => rulesCheckForBit(0n)).toThrow(/not in PERM/);
  });
});

describe('ACTION_K covers the whole PERM action vocabulary', () => {
  /**
   * ⚠️ The trap this guard exists for. `rulesClaimsFromBits` projects an action
   * through `ACTION_K[action]`; an action name outside `{read, write, delete}`
   * yields `undefined`, and `value |= undefined` contributes NOTHING. So a
   * domain declaring, say, `reembolsar` would silently produce no rules claim —
   * a permission that appears granted in the cargo editor and denies in rules.
   *
   * ⚠️ The existing "maps the superuser mask" case CANNOT catch it: it computes
   * its expectation with the same `ACTION_K[action]` lookup, so both sides go
   * `undefined` together and the row passes. A test that mirrors the
   * implementation cannot detect a gap in the thing it mirrors.
   *
   * This one is independent of ACTION_K's VALUES — it compares key sets.
   */
  it('every action name declared in PERM is projectable', () => {
    const declaradas = new Set(Object.values(PERM).flatMap((acoes) => Object.keys(acoes)));
    const projetaveis = new Set(Object.keys(ACTION_K));
    const semProjecao = [...declaradas].filter((a) => !projetaveis.has(a)).sort();

    expect(
      semProjecao,
      'add these to ACTION_K (and give them a k value) or rename them to read/write/delete',
    ).toEqual([]);
  });

  it('is anchored — the check would notice a name outside the vocabulary', () => {
    // Positive control for the assertion above: prove the comparison rejects
    // something, so an empty `declaradas` could never make it vacuous.
    const projetaveis = new Set(Object.keys(ACTION_K));
    expect(projetaveis.has('reembolsar')).toBe(false);
    expect(projetaveis.has('read')).toBe(true);
  });
});

describe('incidenteResolucao — the marketplace resolution bits', () => {
  it('projects into rules claims like any other domain', () => {
    // It gates no Firestore path today (the channel backend checks it in
    // `verifyCaller`), but it must still project — `rulesCheckForBit` throws on
    // a bit outside PERM, so an unprojectable domain would break generate-time
    // if a meta ever referenced it.
    const bits = PERM.incidenteResolucao.read | PERM.incidenteResolucao.write;
    expect(rulesClaimsFromBits(bits)).toEqual({ d_incidenteResolucao: 3 });
  });

  // ⚠️ No collision test here on purpose. `permissions.test.ts:53` — "no two
  // domains share a bit" — already walks all of `Object.entries(PERM)` into a
  // `Map<bigint, string>`, so it picked `incidenteResolucao` up the moment this
  // domain was added, with no edit, and it names the offender
  // ("incidenteResolucao.read reuses the bit of cmun.read") rather than failing a
  // bare `not.toContain`. A domain-scoped copy here was strictly weaker and would
  // rot the day someone assumes it is the guard.
});
