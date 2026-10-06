import { describe, expect, it } from 'vitest';
import * as esquemas from '@delfrance/schemas';

import { FIXTURE_SIZE_CHART_DETAIL_DOC, lerDetalheDeTabelaDeMedidas } from '../fixtures/wireCorpus';
import {
  detalheTabelaMedidasDtoSchema,
  listaTabelasMedidasDtoSchema,
  tabelaMedidasLinhaDtoSchema,
} from './dto';

/**
 * The contract itself (key sets, strict numbers, required fields, stripped
 * unknown keys) is pinned where it is declared — `packages/schemas/src/
 * tabelaDeMedidasShopeeDto.test.ts`. What THIS file pins is that the app's
 * `./dto` is not a second declaration, and that the committed wire fixture
 * survives the trip into the detail envelope.
 */

/** The doc sample's own id — the one the detail page's sample echoes. */
const ID_DO_EXEMPLO = 700024639;

describe('./dto — os envelopes são os de @delfrance/schemas, nunca uma cópia', () => {
  it('cada export É o objeto do pacote compartilhado (o mesmo que apps/web importa)', () => {
    expect(tabelaMedidasLinhaDtoSchema).toBe(esquemas.tabelaMedidasLinhaDtoSchema);
    expect(listaTabelasMedidasDtoSchema).toBe(esquemas.listaTabelasMedidasDtoSchema);
    expect(detalheTabelaMedidasDtoSchema).toBe(esquemas.detalheTabelaMedidasDtoSchema);
    expect(detalheTabelaMedidasDtoSchema.shape.tabela).toBe(esquemas.tabelaShopeeProjetadaSchema);
  });
});

describe('detalheTabelaMedidasDtoSchema — o exemplo da página', () => {
  it('aceita a projeção do exemplo commitado, aninhada INTEIRA sob `tabela`, através de JSON', () => {
    const tabela = esquemas.projetarTabelaShopee(
      ID_DO_EXEMPLO,
      lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC),
    );
    const corpo = JSON.parse(JSON.stringify({ tabela })) as unknown;
    expect(detalheTabelaMedidasDtoSchema.parse(corpo)).toEqual({ tabela });
  });

  it('QUASE: a mesma tabela ESPALHADA no envelope é recusada (o corpo é montado por nome)', () => {
    const tabela = esquemas.projetarTabelaShopee(
      ID_DO_EXEMPLO,
      lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC),
    );
    expect(detalheTabelaMedidasDtoSchema.safeParse({ ...tabela }).success).toBe(false);
  });
});
