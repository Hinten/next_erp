import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO, type IntegracaoTipo } from '@delfrance/schemas';

import { PROVIDERS as PROVIDERS_ANUNCIO_STATUS } from '../anuncioStatus/registry';
import { PROVIDERS as PROVIDERS_ESTOQUE } from '../estoque/registry';
import { PROVIDERS as PROVIDERS_PRECO } from '../preco/registry';
import { type AcaoCanal, capsPermitem } from './suporteCanal';

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

describe('the caps table and the apps/web registries agree', () => {
  it.each(REGISTRIES)('%s', (acao, providers) => {
    for (const tipo of TODOS_OS_TIPOS) {
      expect(
        capsPermitem(acao, tipo),
        `tipo ${String(tipo)}: MARKETPLACE_TIPO_CAPS and the ${acao} registry disagree`,
      ).toBe(providers[tipo] !== undefined);
    }
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
