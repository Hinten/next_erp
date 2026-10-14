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
 * reported honestly at runtime.
 */

const REGISTRIES: ReadonlyArray<readonly [AcaoCanal, Partial<Record<IntegracaoTipo, unknown>>]> = [
  ['estoque', PROVIDERS_ESTOQUE],
  ['preco', PROVIDERS_PRECO],
  ['anuncioStatus', PROVIDERS_ANUNCIO_STATUS],
];

const TODOS_OS_TIPOS = Object.values(INTEGRACAO_TIPO);

/**
 * ⚠️ THE ONE NAMED EXCEPTION — Shopee, rows-first (#1529 step 21 → #1530 step 22).
 *
 * Step 21 registered Shopee's three providers while its caps row still says
 * `implementado: false`, so for Shopee the assertion below would compare `false`
 * (caps) with `true` (a provider) — the FIRST bullet above. It is safe here, unlike
 * the case that bullet warns about, for one structural reason: `vereditoCanal`
 * answers `canal-nao-implementado` BEFORE it consults any provider map, so every
 * caller — the dialogs' warning, the runs' `suportado`, `resolve*` — still reports
 * Shopee as not built and hands it the placeholder. The provider is unreachable,
 * not offered: nothing 4xx's, and the table does not lie (the survey says Shopee
 * CAN; the row says WE have not shipped it — both true).
 *
 * The middle state is pinned EXACTLY below, so it cannot outlive its purpose: the
 * step-22 flip turns that verdict into `suportado` and reds the pin. Delete this
 * set, the `continue` and both tests in the flip's commit. The set is pinned to one
 * member: a second exception is a deliberate edit here, never a silent append.
 */
const LINHAS_ANTES_DO_FLIP: ReadonlySet<IntegracaoTipo> = new Set([INTEGRACAO_TIPO.shopee]);

describe('the caps table and the apps/web registries agree', () => {
  it.each(REGISTRIES)('%s', (acao, providers) => {
    for (const tipo of TODOS_OS_TIPOS) {
      if (LINHAS_ANTES_DO_FLIP.has(tipo)) continue; // pinned exactly below
      expect(
        capsPermitem(acao, tipo),
        `tipo ${String(tipo)}: MARKETPLACE_TIPO_CAPS and the ${acao} registry disagree`,
      ).toBe(providers[tipo] !== undefined);
    }
  });

  it.each(REGISTRIES)(
    '%s: Shopee holds the rows-first middle state — remove at the step-22 flip (#1530)',
    (acao, providers) => {
      expect(providers[INTEGRACAO_TIPO.shopee], 'the Shopee provider row').toBeDefined();
      expect(vereditoCanal(acao, INTEGRACAO_TIPO.shopee, providers)).toEqual({
        suportado: false,
        motivo: 'canal-nao-implementado',
      });
    },
  );

  it('the named exception is exactly Shopee', () => {
    expect([...LINHAS_ANTES_DO_FLIP]).toEqual([INTEGRACAO_TIPO.shopee]);
  });

  it('is comparing against registries that really have a provider', () => {
    // Guards the assertion above from passing vacuously if every row were empty
    // on both sides — `false === false` for eight tipos proves nothing.
    for (const [acao, providers] of REGISTRIES) {
      expect(providers[INTEGRACAO_TIPO.mercadoLivre], acao).toBeDefined();
      expect(capsPermitem(acao, INTEGRACAO_TIPO.mercadoLivre), acao).toBe(true);
    }
  });
});
