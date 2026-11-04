/**
 * The `nfeUploadRejeitado` producer and its two resolvers (step 14, PR 14-c),
 * through the REAL `escreverAviso` / `resolverAviso` against the fake
 * Firestore: the key, the row's shape, the refusal outside set A, the
 * Firestore-timeline clock on every side, and the tombstone that only the
 * order import's transition resolve creates.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { MOTIVO_AVISO_AMAZON, relogioDoDocumentoUs } from '../avisos/avisos';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, caminhoAviso } from '../testing/fixtures';
import {
  avisarNfeAmazon,
  chaveAvisoNfeAmazon,
  resolverNfeAmazon,
  resolverNfeDoPedidoAmazon,
} from './avisoNfe';
import {
  FRASE_DO_ERRO_NFE_AMAZON,
  MOTIVOS_NFE_QUE_AVISAM,
  MOTIVOS_NFE_SO_LOG,
  MOTIVO_NFE_AMAZON,
} from './motivosNfe';

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const PEDIDO = { integracaoId: CONTA, pedidoId: PEDIDO_ID, numero: ORDER } as const;
const CHAVE = chaveAvisoNfeAmazon(CONTA, PEDIDO_ID);

/** A Firestore commit/read stamp at `us` microseconds. */
function relogio(us: number): { seconds: number; nanoseconds: number } {
  return { seconds: Math.floor(us / 1_000_000), nanoseconds: (us % 1_000_000) * 1000 };
}
const T1 = relogio(1_800_000_000_000_100);
const T2 = relogio(1_800_000_000_000_200);
const T3 = relogio(1_800_000_000_000_300);

let db: FakeDb;
const deps = () => ({ increment, nowMs: AGORA_MS });

beforeEach(() => {
  db = new FakeDb();
});

function linha(): Record<string, unknown> | undefined {
  return db.ler(caminhoAviso(CHAVE));
}

describe('the key', () => {
  it('★ ONE row per pedido: (nfeUploadRejeitado, integração, pedido), no NF-e id, no janela', () => {
    expect(CHAVE).toBe(
      chaveDeAviso({ tipo: TIPO_AVISO.nfeUploadRejeitado, conta: CONTA, entidade: PEDIDO_ID }),
    );
    expect(CHAVE).toBe(`nfeUploadRejeitado:${CONTA}:${PEDIDO_ID}`);
  });
});

describe('avisarNfeAmazon', () => {
  it('★ writes the shared contract: atencao, canal amazon, params EXACTLY pedido + erro, the motivo, the pedido route, the µs clock', async () => {
    expect(
      await avisarNfeAmazon(asDb(db), deps(), {
        ...PEDIDO,
        motivo: MOTIVO_NFE_AMAZON.nfeCancelada,
        relogio: T1,
      }),
    ).toBe('criado');
    expect(linha()).toMatchObject({
      tipo: TIPO_AVISO.nfeUploadRejeitado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.amazon,
      params: { pedido: ORDER, erro: FRASE_DO_ERRO_NFE_AMAZON['nfe-cancelada'] },
      motivo: 'nfe-cancelada',
      urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null },
      relogioEvento: relogioDoDocumentoUs(T1),
      resolvidoEm: null,
    });
    expect(Object.keys((linha()?.params ?? {}) as object).sort()).toEqual(['erro', 'pedido']);
    // µs, never ms: the clock carries the stamp's microseconds.
    expect(linha()?.relogioEvento).toBe(1_800_000_000_000_100);
  });

  it('every reason of set A raises with its OWN fragment', async () => {
    let n = 0;
    for (const motivo of MOTIVOS_NFE_QUE_AVISAM) {
      db = new FakeDb();
      await avisarNfeAmazon(asDb(db), deps(), { ...PEDIDO, motivo, relogio: T1 });
      expect(linha()?.motivo, motivo).toBe(motivo);
      expect((linha()?.params as { erro?: string }).erro, motivo).toBe(
        FRASE_DO_ERRO_NFE_AMAZON[motivo as keyof typeof FRASE_DO_ERRO_NFE_AMAZON],
      );
      n += 1;
    }
    expect(n).toBeGreaterThan(20);
  });

  it('★ a log-only reason is REFUSED with a RangeError, and nothing is written', async () => {
    for (const motivo of MOTIVOS_NFE_SO_LOG) {
      const refusa = avisarNfeAmazon(asDb(db), deps(), { ...PEDIDO, motivo, relogio: T1 });
      await expect(refusa, motivo).rejects.toBeInstanceOf(RangeError);
      // The producer's OWN guard refuses, before anything is built — not the
      // fragment table's (`motivosNfe.ts`), which would only be reached by luck.
      await expect(
        avisarNfeAmazon(asDb(db), deps(), { ...PEDIDO, motivo, relogio: T1 }),
        motivo,
      ).rejects.toThrow(/^avisoNfe\.ts: /);
    }
    expect(db.escritas).toEqual([]);
    expect(MOTIVOS_NFE_SO_LOG.size).toBeGreaterThan(5);
  });

  it('★ the clock drops a raise that is not newer than the row (older and EQUAL), and a newer one refreshes it', async () => {
    const e = { ...PEDIDO, motivo: MOTIVO_NFE_AMAZON.envioRecusado, relogio: T2 };
    expect(await avisarNfeAmazon(asDb(db), deps(), e)).toBe('criado');
    expect(await avisarNfeAmazon(asDb(db), deps(), { ...e, relogio: T1 })).toBe('ignorado');
    expect(await avisarNfeAmazon(asDb(db), deps(), { ...e, relogio: T2 })).toBe('ignorado');
    expect(
      await avisarNfeAmazon(asDb(db), deps(), {
        ...e,
        motivo: MOTIVO_NFE_AMAZON.nfeRecusada,
        relogio: T3,
      }),
    ).toBe('repetido');
    expect(linha()).toMatchObject({ motivo: 'nfe-recusada', ocorrencias: 2 });
  });
});

describe('resolverNfeAmazon — the task’s resolve', () => {
  it('★ no row ⇒ false and ZERO writes: the task’s happy path writes nothing', async () => {
    expect(
      await resolverNfeAmazon(asDb(db), deps(), {
        ...PEDIDO,
        motivo: MOTIVO_AVISO_AMAZON.nfeValidada,
        relogio: T2,
      }),
    ).toBe(false);
    expect(db.escritas).toEqual([]);
    expect(linha()).toBeUndefined();
  });

  it('an open row ⇒ closed as nfe-validada, its clock advanced', async () => {
    await avisarNfeAmazon(asDb(db), deps(), {
      ...PEDIDO,
      motivo: MOTIVO_NFE_AMAZON.aceiteNaoConfirmado,
      relogio: T1,
    });
    expect(
      await resolverNfeAmazon(asDb(db), deps(), {
        ...PEDIDO,
        motivo: MOTIVO_AVISO_AMAZON.nfeValidada,
        relogio: T2,
      }),
    ).toBe(true);
    expect(linha()).toMatchObject({
      resolucaoMotivo: 'nfe-validada',
      relogioEvento: relogioDoDocumentoUs(T2),
    });
    expect(linha()?.resolvidoEm).not.toBeNull();
  });

  it('a resolve OLDER than the raise is stale: the row stays open', async () => {
    await avisarNfeAmazon(asDb(db), deps(), {
      ...PEDIDO,
      motivo: MOTIVO_NFE_AMAZON.nfeRecusada,
      relogio: T2,
    });
    expect(
      await resolverNfeAmazon(asDb(db), deps(), {
        ...PEDIDO,
        motivo: MOTIVO_AVISO_AMAZON.pedidoCancelado,
        relogio: T1,
      }),
    ).toBe(false);
    expect(linha()?.resolvidoEm).toBeNull();
  });
});

describe('resolverNfeDoPedidoAmazon — the order import’s transition resolve', () => {
  it('★ no row ⇒ a RESOLVED tombstone carrying the clock, and a later STALE raise is dropped', async () => {
    expect(
      await resolverNfeDoPedidoAmazon(asDb(db), deps(), {
        ...PEDIDO,
        motivo: MOTIVO_AVISO_AMAZON.pedidoCancelado,
        relogio: T2,
      }),
    ).toBe(false);
    expect(linha()).toMatchObject({
      tipo: TIPO_AVISO.nfeUploadRejeitado,
      canal: CANAL_AVISO.amazon,
      severidade: SEVERIDADE_AVISO.atencao,
      resolucaoMotivo: 'pedido-cancelado',
      relogioEvento: relogioDoDocumentoUs(T2),
      params: { pedido: ORDER },
      urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null },
    });
    expect(linha()?.resolvidoEm).not.toBeNull();

    // A task that read the pedido BEFORE the import, raising after it.
    expect(
      await avisarNfeAmazon(asDb(db), deps(), {
        ...PEDIDO,
        motivo: MOTIVO_NFE_AMAZON.nfeRecusada,
        relogio: T1,
      }),
    ).toBe('ignorado');
    expect(linha()?.resolvidoEm).not.toBeNull();

    // NEAR-MISS: a raise from a LATER read reopens it — a new problem.
    expect(
      await avisarNfeAmazon(asDb(db), deps(), {
        ...PEDIDO,
        motivo: MOTIVO_NFE_AMAZON.nfeRecusada,
        relogio: T3,
      }),
    ).toBe('reaberto');
  });

  it('an open row ⇒ closed as frete-despachado', async () => {
    await avisarNfeAmazon(asDb(db), deps(), {
      ...PEDIDO,
      motivo: MOTIVO_NFE_AMAZON.nfeNaoRegistrada,
      relogio: T1,
    });
    expect(
      await resolverNfeDoPedidoAmazon(asDb(db), deps(), {
        ...PEDIDO,
        motivo: MOTIVO_AVISO_AMAZON.freteDespachado,
        relogio: T2,
      }),
    ).toBe(true);
    expect(linha()).toMatchObject({ resolucaoMotivo: 'frete-despachado' });
  });

  it('the three resolve motivos are the shared contract’s spellings', () => {
    expect([
      MOTIVO_AVISO_AMAZON.nfeValidada,
      MOTIVO_AVISO_AMAZON.pedidoCancelado,
      MOTIVO_AVISO_AMAZON.freteDespachado,
    ]).toEqual(['nfe-validada', 'pedido-cancelado', 'frete-despachado']);
  });
});
