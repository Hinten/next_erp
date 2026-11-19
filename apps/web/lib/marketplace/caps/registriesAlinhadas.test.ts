import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '@delfrance/schemas';

import { PROVIDERS as PROVIDERS_ANUNCIO_STATUS } from '../anuncioStatus/registry';
import { PROVIDERS as PROVIDERS_ESTOQUE } from '../estoque/registry';
import { PROVIDERS as PROVIDERS_PRECO } from '../preco/registry';
import { type AcaoCanal, capsPermitem, vereditoCanal } from './suporteCanal';

/**
 * The drift test — what makes `MARKETPLACE_TIPO_CAPS` load-bearing rather than
 * decorative (#1430).
 *
 * The table and the registries answer two different questions: *"can the
 * provider do this, and did we build the channel?"* versus *"does this screen
 * have a provider row?"*. Nothing forces them to agree, and both directions of
 * disagreement are silent:
 *
 *  - a provider registered for a channel the table says cannot do it — the
 *    screen offers an action that will 4xx, and the table lies to whoever reads
 *    it next;
 *  - a caps row saying `'sim'` + `implementado` with no provider — the verdict
 *    says supported, then `resolve*` hands back the placeholder, so the operator
 *    is told the run happened and it did not.
 *
 * ⚠️ If a future channel legitimately sits in the middle (backend shipped, this
 * screen not wired yet), the fix is to SAY SO here with a named exception and a
 * comment — not to delete the assertion. The second arm above is exactly the
 * `'canal-sem-provider'` verdict, which exists so that state is at least
 * reported honestly at runtime. Shopee went the other way round — provider rows
 * in step 21 (#1529) ahead of its caps flip in step 22 (#1530) — behind a
 * one-member exception set that pinned the middle state and was deleted with the
 * flip; `git log -S LINHAS_ANTES_DO_FLIP` shows the shape. Loja Integrada's
 * stock row sits in that middle state now (master plan step 12 → step 22), under
 * the same name below.
 */

const REGISTRIES: ReadonlyArray<readonly [AcaoCanal, Partial<Record<IntegracaoTipo, unknown>>]> = [
  ['estoque', PROVIDERS_ESTOQUE],
  ['preco', PROVIDERS_PRECO],
  ['anuncioStatus', PROVIDERS_ANUNCIO_STATUS],
];

const TODOS_OS_TIPOS = Object.values(INTEGRACAO_TIPO);

/**
 * ⚠️ THE ONE NAMED EXCEPTION — Loja Integrada's STOCK row, rows-first (master
 * plan step 12 → step 22). Delete this list, the `continue` and the two tests
 * that name it in the step-22 flip's commit.
 *
 * Step 12 registered the Loja Integrada stock provider while its caps row still
 * says `implementado: false`, so for that one (action, tipo) pair the assertion
 * below would compare `false` (caps) with `true` (a provider) — the FIRST bullet
 * above. It is safe, as Shopee's was, for one structural reason: `vereditoCanal`
 * answers `canal-nao-implementado` BEFORE it consults any provider map, so the
 * dialog's warning, the run's `suportado` and `resolveStockPushProvider` all
 * still report Loja Integrada as not built. The row is unreachable, not offered.
 *
 * Keyed by the PAIR, never by the tipo: Loja Integrada's price and pause rows do
 * not exist, and they must keep passing the equality loop. The middle state is
 * pinned exactly below, so the flip turns it red; the list is pinned to one
 * member, so a second exception is a deliberate edit here, never an append.
 */
const LINHAS_ANTES_DO_FLIP: ReadonlyArray<readonly [AcaoCanal, IntegracaoTipo]> = [
  ['estoque', INTEGRACAO_TIPO.lojaIntegrada],
];

const ehExcecao = (acao: AcaoCanal, tipo: IntegracaoTipo): boolean =>
  LINHAS_ANTES_DO_FLIP.some(([a, t]) => a === acao && t === tipo);

describe('the caps table and the apps/web registries agree', () => {
  it.each(REGISTRIES)('%s', (acao, providers) => {
    for (const tipo of TODOS_OS_TIPOS) {
      if (ehExcecao(acao, tipo)) continue; // pinned exactly below
      expect(
        capsPermitem(acao, tipo),
        `tipo ${String(tipo)}: MARKETPLACE_TIPO_CAPS and the ${acao} registry disagree`,
      ).toBe(providers[tipo] !== undefined);
    }
  });

  it.each(REGISTRIES)(
    '%s: Shopee is supported — caps implemented AND a provider row',
    (acao, providers) => {
      // The deleted middle-state pin, inverted: the same call that answered
      // `canal-nao-implementado` through step 21 now answers supported, which is
      // what lets a /produtos selection reach a Shopee conta at all.
      expect(providers[INTEGRACAO_TIPO.shopee], 'the Shopee provider row').toBeDefined();
      expect(vereditoCanal(acao, INTEGRACAO_TIPO.shopee, providers)).toEqual({ suportado: true });
    },
  );

  it('estoque: Loja Integrada holds the rows-first middle state — remove at the step-22 flip', () => {
    expect(
      PROVIDERS_ESTOQUE[INTEGRACAO_TIPO.lojaIntegrada],
      'the stock provider row',
    ).toBeDefined();
    expect(vereditoCanal('estoque', INTEGRACAO_TIPO.lojaIntegrada, PROVIDERS_ESTOQUE)).toEqual({
      suportado: false,
      motivo: 'canal-nao-implementado',
    });
  });

  it('the named exception is exactly (estoque, Loja Integrada)', () => {
    expect([...LINHAS_ANTES_DO_FLIP]).toEqual([['estoque', INTEGRACAO_TIPO.lojaIntegrada]]);
  });

  it.each(REGISTRIES)(
    '%s: the exception skips nothing but its own pair — the other Loja Integrada rows stay compared',
    (acao) => {
      // Anti-vacuity for the `continue`: keying it by tipo alone would silently
      // skip Loja Integrada's price and pause rows too.
      for (const tipo of TODOS_OS_TIPOS) {
        expect(ehExcecao(acao, tipo)).toBe(
          acao === 'estoque' && tipo === INTEGRACAO_TIPO.lojaIntegrada,
        );
      }
    },
  );

  it('is comparing against registries that really have a provider', () => {
    // Guards the assertion above from passing vacuously if every row were empty
    // on both sides — `false === false` for eight tipos proves nothing.
    for (const [acao, providers] of REGISTRIES) {
      expect(providers[INTEGRACAO_TIPO.mercadoLivre], acao).toBeDefined();
      expect(capsPermitem(acao, INTEGRACAO_TIPO.mercadoLivre), acao).toBe(true);
    }
  });
});
