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
