import { describe, expect, it } from 'vitest';
import { PERM, hasPerm } from '@delfrance/auth';
import { PERM_LINK_PAGAMENTO } from '@delfrance/schemas';

/**
 * `PERM_LINK_PAGAMENTO` lives in `@delfrance/schemas` (browser-safe, shared by
 * the `apps/mercado-pago` routes and the `apps/web` tab) as bigint LITERALS,
 * because `schemas` does not depend on `@delfrance/auth` and so cannot import
 * `PERM`. Two copies of one bit mask agree only by convention — and a drift is
 * SILENT in the worst direction: the tab would gate its buttons on a mask the
 * route does not enforce (a 403 on click), or the route would enforce a weaker
 * one than the Firestore rules do.
 *
 * `@delfrance/data` is the first workspace that sees BOTH sides (it depends on
 * `auth` and on `schemas`), so the pin lives here.
 */

/** A claim string as `hasPerm` reads it: the decimal bitmask of a user's grants. */
const claim = (...bits: bigint[]): string => bits.reduce((acc, bit) => acc | bit, 0n).toString();

describe('PERM_LINK_PAGAMENTO is pinned against PERM', () => {
  it('ler is pagamento.read', () => {
    expect(PERM_LINK_PAGAMENTO.ler).toBe(PERM.pagamento.read);
  });

  it('gerenciar is pedido.write | pagamento.write', () => {
    expect(PERM_LINK_PAGAMENTO.gerenciar).toBe(PERM.pedido.write | PERM.pagamento.write);
  });

  it('listarContas is metodoPagamento.read', () => {
    expect(PERM_LINK_PAGAMENTO.listarContas).toBe(PERM.metodoPagamento.read);
  });

  it('NEAR-MISS: none of the three is the sibling bit a copy-paste slip would pick', () => {
    // read ≠ write ≠ delete of the same group, and pagamento ≠ pedido: each of these
    // is one edit away from the right constant and would still compile.
    expect(PERM_LINK_PAGAMENTO.ler).not.toBe(PERM.pagamento.write);
    expect(PERM_LINK_PAGAMENTO.ler).not.toBe(PERM.pedido.read);
    expect(PERM_LINK_PAGAMENTO.gerenciar).not.toBe(PERM.pagamento.write);
    expect(PERM_LINK_PAGAMENTO.gerenciar).not.toBe(PERM.pedido.write);
    expect(PERM_LINK_PAGAMENTO.gerenciar).not.toBe(PERM.pagamento.read | PERM.pedido.write);
    expect(PERM_LINK_PAGAMENTO.listarContas).not.toBe(PERM.metodoPagamento.write);
    expect(PERM_LINK_PAGAMENTO.listarContas).not.toBe(PERM.pagamento.read);
  });
});

describe('PERM_LINK_PAGAMENTO.gerenciar needs BOTH bits (hasPerm requires every bit of a mask)', () => {
  it('passes for a user holding pedido.write AND pagamento.write', () => {
    expect(
      hasPerm(claim(PERM.pedido.write, PERM.pagamento.write), PERM_LINK_PAGAMENTO.gerenciar),
    ).toBe(true);
  });

  it('fails for pedido.write alone', () => {
    expect(hasPerm(claim(PERM.pedido.write), PERM_LINK_PAGAMENTO.gerenciar)).toBe(false);
  });

  it('fails for pagamento.write alone', () => {
    expect(hasPerm(claim(PERM.pagamento.write), PERM_LINK_PAGAMENTO.gerenciar)).toBe(false);
  });

  it('fails for the read bits — reading a link is not managing one', () => {
    const leitor = claim(PERM.pedido.read, PERM.pagamento.read);
    expect(hasPerm(leitor, PERM_LINK_PAGAMENTO.gerenciar)).toBe(false);
  });

  it('a pagamento.read user can see links (ler) but cannot manage them', () => {
    const leitor = claim(PERM.pagamento.read);
    expect(hasPerm(leitor, PERM_LINK_PAGAMENTO.ler)).toBe(true);
    expect(hasPerm(leitor, PERM_LINK_PAGAMENTO.gerenciar)).toBe(false);
  });
});
