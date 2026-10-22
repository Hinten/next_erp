/**
 * `rotearFreteLi` for a row whose uid names a target no document can be — the shared row
 * decision's `mapeado` with `alvoId: null`. The importer never reads such a target
 * (`importarPedido.test.ts` pins the import end to end); this pins that the routing does not
 * trust a target read handed in beside one either, so a second caller that read something anyway
 * can never route the pedido to a target with no ref, or close the aviso. `freteMapeamento.test.ts`
 * stays the routing's own suite; this file sits beside it.
 */
import {
  INTEGRACAO_FRETE,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  TIPOS_ALVO_MAPA_FRETE_LI,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { rotearFreteLi, type AlvoLidoLi, type DecisaoMapaLi } from './freteMapeamento';

const INT_FRETE_LI = 'lojaIntegrada-conta1';
const CHAVE = '141909---PAC';

function mapeado(alvoId: string | null): DecisaoMapaLi {
  return { tipo: 'mapeado', chave: CHAVE, alvoId, nomeOriginal: 'Correios', idServico: '2' };
}

function ativo(tipo: string): AlvoLidoLi {
  return { existe: true, dados: { tipo, ativo: true } };
}

describe('rotearFreteLi — a mapped row whose target id is null', () => {
  it('a row naming `alvo-1`, read active ⇒ routed to it (the control: the same target read is trusted beside an id)', () => {
    for (const tipo of [
      INTEGRACAO_FRETE.melhorEnvios,
      INTEGRACAO_FRETE.motoboy,
      INTEGRACAO_FRETE.retiradaNaLoja,
    ]) {
      const r = rotearFreteLi({
        intFreteLiId: INT_FRETE_LI,
        decisao: mapeado('alvo-1'),
        alvo: ativo(tipo),
      });
      expect(r.integracaoFreteOuterRef, tipo).toBe('documents/int_frete/alvo-1');
      expect(r.aviso, tipo).toEqual({ tipo: 'resolver', chave: CHAVE });
    }
  });

  it('⚠️ `alvoId: null` with an existing, active target handed in anyway ⇒ the conta’s LI doc and `alvo-ausente` raised, whatever the target’s tipo', () => {
    for (const tipo of TIPOS_ALVO_MAPA_FRETE_LI) {
      expect(
        rotearFreteLi({ intFreteLiId: INT_FRETE_LI, decisao: mapeado(null), alvo: ativo(tipo) }),
        tipo,
      ).toEqual({
        integracaoFreteOuterRef: `documents/int_frete/${INT_FRETE_LI}`,
        externalOptionId: null,
        aviso: {
          tipo: 'levantar',
          chave: CHAVE,
          motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoAusente,
          formaEnvio: 'Correios',
        },
        deliberado: false,
        dispensaEndereco: false,
      });
    }
  });
});
