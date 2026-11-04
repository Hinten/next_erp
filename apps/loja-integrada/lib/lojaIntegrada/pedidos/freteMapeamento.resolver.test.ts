/**
 * How the order import WIRES the shared freight resolver (`decidirLinhaDoMapaLi`,
 * `avaliarAlvoDoMapaLi`, `@delfrance/schemas`) into `decidirMapaLi` and `rotearFreteLi` — the
 * pins the routing's own suite (`freteMapeamento.test.ts`, which stays as it is) does not carry:
 *
 * - a method with no key stays `sem-chave` even beside a registration's `mapa-invalido`;
 * - the row's Melhor Envio service is written beside a Melhor Envio target only;
 * - a mapped row whose target id is null (a uid naming a target no document can be) is never
 *   routed by a target read handed in beside it. The importer never reads such a target
 *   (`importarPedido.test.ts` pins the import end to end); this pins that the routing does not
 *   trust one either, so a second caller that read something anyway can never route the pedido to
 *   a target with no ref, or close the aviso.
 */
import {
  INTEGRACAO_FRETE,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  TIPOS_ALVO_MAPA_FRETE_LI,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import {
  decidirMapaLi,
  rotearFreteLi,
  type AlvoLidoLi,
  type DecisaoMapaLi,
} from './freteMapeamento';

const INT_FRETE_LI = 'lojaIntegrada-conta1';
const CHAVE = '141909---PAC';

function mapeado(alvoId: string | null): DecisaoMapaLi {
  return { tipo: 'mapeado', chave: CHAVE, alvoId, nomeOriginal: 'Correios', idServico: '2' };
}

function ativo(tipo: string): AlvoLidoLi {
  return { existe: true, dados: { tipo, ativo: true } };
}

describe('decidirMapaLi — the registration’s `mapa-invalido` beside the method’s key', () => {
  const mapaInvalido = { resultado: 'mapa-invalido', mapa: null, lidoEmUs: 1 } as const;

  it('a keyed method beside a registration’s `mapa-invalido` ⇒ `mapa-invalido` under its key', () => {
    expect(
      decidirMapaLi({
        intFreteLiId: INT_FRETE_LI,
        registro: mapaInvalido,
        formaEnvio: { id: 141909, code: 'PAC' },
      }),
    ).toEqual({ tipo: 'mapa-invalido', chave: CHAVE });
  });

  it('⚠️ a method with NO key beside the same `mapa-invalido` ⇒ `sem-chave` (no aviso row), never a `mapa-invalido` without a key', () => {
    for (const formaEnvio of [{ id: 0, code: 'PAC' }, { id: '0141909', code: 'PAC' }, null]) {
      const decisao = decidirMapaLi({
        intFreteLiId: INT_FRETE_LI,
        registro: mapaInvalido,
        formaEnvio,
      });
      expect(decisao, JSON.stringify(formaEnvio)).toEqual({ tipo: 'sem-chave' });
      expect(
        rotearFreteLi({ intFreteLiId: INT_FRETE_LI, decisao, alvo: null }).aviso,
        JSON.stringify(formaEnvio),
      ).toBeNull();
    }
  });
});

describe('rotearFreteLi — the row’s Melhor Envio service goes with a Melhor Envio target only', () => {
  it('a Melhor Envio target ⇒ routed with the row’s service (the control)', () => {
    const r = rotearFreteLi({
      intFreteLiId: INT_FRETE_LI,
      decisao: mapeado('alvo-1'),
      alvo: ativo(INTEGRACAO_FRETE.melhorEnvios),
    });
    expect(r.integracaoFreteOuterRef).toBe('documents/int_frete/alvo-1');
    expect(r.externalOptionId).toBe('2');
  });

  it('⚠️ a motoboy or pickup target on a row that still carries a service ⇒ routed with NO `externalOptionId`', () => {
    for (const tipo of [INTEGRACAO_FRETE.motoboy, INTEGRACAO_FRETE.retiradaNaLoja]) {
      const r = rotearFreteLi({
        intFreteLiId: INT_FRETE_LI,
        decisao: mapeado('alvo-1'),
        alvo: ativo(tipo),
      });
      expect(r.integracaoFreteOuterRef, tipo).toBe('documents/int_frete/alvo-1');
      expect(r.externalOptionId, tipo).toBeNull();
    }
  });
});

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
