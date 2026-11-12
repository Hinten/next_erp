/**
 * The feed core's provider seam (step 12a, PR 12-b): the closed abort motivos,
 * the timing constants, and a fluxo-neutral provider that type-checks against
 * the seam with no stock import.
 */
import { MOTIVO_CONTA_AMAZON, type RegistroFeedAmazon } from '@delfrance/schemas';
import type { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { CommitDoDocumento } from '../avisos/avisos';
import { FLUXO_AMAZON } from '../core/valvulas';
import {
  type ContextoLoteAmazon,
  ESPACO_MINIMO_ENTRE_FEEDS_MS,
  ESPERA_LOTE_EM_VEZ_S,
  ESPERA_MAXIMA_ATRAS_DE_FEED_MS,
  ESPERA_MAXIMA_LOTE_RECUPERACAO_MS,
  ESPERA_SONDA_DISJUNTOR_MS,
  MAX_FALHAS_SEGUIDAS_FEED,
  MOTIVO_ABORTO_LOTE,
  type MotivoAbortoLote,
  type ProvedorLoteAmazon,
  type ResultadoLoteAmazon,
} from './provedorLote';

describe('the provider seam', () => {
  it('the abort motivos are a closed set of three', () => {
    expect(Object.values(MOTIVO_ABORTO_LOTE).sort()).toEqual([
      'deposito-mudou',
      'janela-grande',
      'snapshot-lento',
    ]);
    expectTypeOf<MotivoAbortoLote>().toEqualTypeOf<
      'snapshot-lento' | 'deposito-mudou' | 'janela-grande'
    >();
  });

  it('the timing constants', () => {
    expect(MAX_FALHAS_SEGUIDAS_FEED).toBe(3);
    expect(ESPERA_LOTE_EM_VEZ_S).toBe(300);
    expect(ESPERA_SONDA_DISJUNTOR_MS).toBe(60 * 60_000);
    expect(ESPERA_MAXIMA_ATRAS_DE_FEED_MS).toBe(30 * 60_000);
    expect(ESPACO_MINIMO_ENTRE_FEEDS_MS).toBe(120_000);
    expect(ESPERA_MAXIMA_LOTE_RECUPERACAO_MS).toBe(60 * 60_000);
  });

  it('the seam’s clocks are structural: the record’s STORED clock and a read’s readTime both fit, and the aviso module converts either', () => {
    // What the record handle reads back (a duck-typed Timestamp) is the write-back's clock as is.
    expectTypeOf<NonNullable<RegistroFeedAmazon['relogioDesfecho']>>().toMatchTypeOf<
      ResultadoLoteAmazon['relogio']
    >();
    // A lease read's `readTime` (the Admin SDK class) is the send-side clock.
    expectTypeOf<Timestamp>().toMatchTypeOf<NonNullable<ContextoLoteAmazon['relogioVez']>>();
    expectTypeOf<ResultadoLoteAmazon['relogio']>().toMatchTypeOf<CommitDoDocumento>();
    expectTypeOf<
      NonNullable<ContextoLoteAmazon['relogioVez']>
    >().toMatchTypeOf<CommitDoDocumento>();
  });

  it('a price provider fits the seam with no stock module (the seam is fluxo-neutral)', async () => {
    const precos: ProvedorLoteAmazon<typeof FLUXO_AMAZON.preco, { readonly n: number }> = {
      fluxo: FLUXO_AMAZON.preco,
      membros: () => Promise.resolve({ skus: ['A', 'B'], dados: { n: 2 } }),
      montar: (_ctx, _entrada, membrosOn) =>
        Promise.resolve(
          membrosOn.length === 0
            ? { abortado: MOTIVO_ABORTO_LOTE.snapshotLento, aviso: null }
            : { mensagens: [], snapshotEmMs: 1, diff: { membros: membrosOn.length } },
        ),
      gravarResultado: () => Promise.resolve(),
      recuperar: () => Promise.resolve({ nada: true }),
      repassarParaPatches: (_ctx, _entrada, skus) => Promise.resolve({ tarefas: skus.length }),
      motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
    };
    expect(precos.fluxo).toBe('preco');
    const ctx = {} as Parameters<typeof precos.membros>[0];
    const entrada = {} as Parameters<typeof precos.membros>[1];
    await expect(precos.montar(ctx, entrada, [], { n: 0 })).resolves.toEqual({
      abortado: 'snapshot-lento',
      aviso: null,
    });
  });
});
