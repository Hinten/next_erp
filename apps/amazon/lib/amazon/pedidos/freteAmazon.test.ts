import {
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  ESTADO_FRETE,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  estadoFreteSchema,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { ATUALIZADO_US, pedidoAmazon } from '../testing/pedidoWireAmazon';
import {
  CAMPOS_FRETE_AMAZON,
  MERCADORIA_FORA,
  camposFreteAmazon,
  mercadoriaFora,
  seedFreteAmazon,
} from './freteAmazon';

describe('MERCADORIA_FORA — the exhaustive goods-out table', () => {
  it('covers every EstadoFrete and its true set is exactly the posted, failed, returning and out-of-channel estados', () => {
    const fora = estadoFreteSchema.options.filter((e) => MERCADORIA_FORA[e]);
    expect(Object.keys(MERCADORIA_FORA).sort()).toEqual([...estadoFreteSchema.options].sort());
    expect(fora.sort()).toEqual(
      [
        'postado',
        'recebidoPelaTransportadora',
        'aCaminho',
        'tentandoRealizarEntrega',
        'entregue',
        'falhaNaEntrega',
        'enderecoNaoEncontrado',
        'objetoExtraviado',
        'suspenso',
        'aguardandoRetirada',
        'aCaminhoDoRemetente',
        'devolvido',
      ].sort(),
    );
  });

  it('NEAR-MISS against the ladder index: packed (`checkFinalizado`, `empacotado`) is still in the warehouse, `objetoExtraviado`/`suspenso`/`aguardandoRetirada` are out', () => {
    expect(mercadoriaFora(ESTADO_FRETE.checkFinalizado)).toBe(false);
    expect(mercadoriaFora(ESTADO_FRETE.empacotado)).toBe(false);
    expect(mercadoriaFora(ESTADO_FRETE.aguardandoPostagem)).toBe(false);
    expect(mercadoriaFora(ESTADO_FRETE.objetoExtraviado)).toBe(true);
    expect(mercadoriaFora(ESTADO_FRETE.suspenso)).toBe(true);
    expect(mercadoriaFora(ESTADO_FRETE.aguardandoRetirada)).toBe(true);
    expect(mercadoriaFora(ESTADO_FRETE.fulfillment)).toBe(false);
    expect(mercadoriaFora(null)).toBe(false);
  });

  it('every "out" estado past posting is one the stock sync already treats as removed', () => {
    for (const estado of estadoFreteSchema.options.filter((e) => MERCADORIA_FORA[e])) {
      expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(estado), estado).toBe(true);
    }
  });
});

describe('the freight fields and the seed', () => {
  it('reads the deadlines through the offset-required instant reader; ultimaModificacao is the ORDER clock', () => {
    const campos = camposFreteAmazon(pedidoAmazon(), ATUALIZADO_US);
    expect(campos).toEqual({
      prazoDespacho: Date.parse('2026-10-03T23:59:59Z') * 1000,
      dataPrevisaoEntrega: Date.parse('2026-10-08T23:59:59Z') * 1000,
      ultimaModificacao: ATUALIZADO_US,
    });
    expect(Object.keys(campos)).toEqual([...CAMPOS_FRETE_AMAZON]);
    const semOffset = pedidoAmazon({
      extra: {
        fulfillment: {
          fulfillmentStatus: 'UNSHIPPED',
          fulfilledBy: 'MERCHANT',
          shipByWindow: { latestDateTime: '2026-10-03T23:59:59' },
        },
      },
    });
    expect(camposFreteAmazon(semOffset, ATUALIZADO_US).prazoDespacho).toBeNull();
  });

  it("seeds an 'amz' block (iniciado; fulfillment for AFN), FOB by default, the money as given", () => {
    const base = {
      modalidade: null,
      integracaoFreteOuterRef: 'documents/int_frete/amz-c1',
      enderecoFreteOuterReference: null,
      campos: camposFreteAmazon(pedidoAmazon(), ATUALIZADO_US),
      valorCobrado: null,
    } as const;
    const mfn = seedFreteAmazon({ ...base, afn: false });
    expect(mfn.externalOptionIntegracao).toBe(INTEGRACAO_FRETE.amazon);
    expect(mfn.estado).toBe('iniciado');
    expect(mfn.modalidade).toBe('1');
    expect(mfn.valorCobrado).toBeNull();
    expect(mfn.ultimaModificacao).toBe(ATUALIZADO_US);
    expect(mfn.integracaoFreteOuterRef).toBe('documents/int_frete/amz-c1');
    expect(seedFreteAmazon({ ...base, afn: true }).estado).toBe('fulfillment');
    expect(
      seedFreteAmazon({
        ...base,
        afn: false,
        modalidade: MODALIDADE_FRETE.cif,
        valorCobrado: 12.5,
      }),
    ).toMatchObject({
      modalidade: '0',
      valorCobrado: 12.5,
    });
  });
});
