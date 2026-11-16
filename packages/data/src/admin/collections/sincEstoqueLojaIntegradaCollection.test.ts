import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  FLAG_ENTRADA_ESTOQUE_LI,
  ID_PAIS_SNAPSHOT_ESTOQUE_LI,
  ID_RECONCILE_ESTOQUE_LI,
  idFatiaKitsEstoqueLi,
  kitsComponenteEstoqueLiSchema,
  reconcileEstoqueLojaIntegradaSchema,
} from '@delfrance/schemas';
import {
  fatiaKitsComponenteEstoqueLiCollection,
  kitsComponenteEstoqueLiCollection,
  paisSnapshotEstoqueLiCollection,
  reconcileEstoqueLojaIntegradaCollection,
  sincEstoqueLojaIntegradaCollection,
  snapshotEstoqueLiCollection,
} from './index';

const CONTA = { integracaoId: 'conta-li-1' };
const RUN = 'estoque-reconcile-20271115';

describe('the Loja Integrada stock-sync handles (step 12)', () => {
  it('resolve to the documented paths', () => {
    expect(sincEstoqueLojaIntegradaCollection.docPath({}, 'conta-li-1')).toBe(
      'sincEstoqueLojaIntegrada/conta-li-1',
    );
    expect(snapshotEstoqueLiCollection.docPath(CONTA, '07')).toBe(
      'sincEstoqueLojaIntegrada/conta-li-1/snapshot/07',
    );
    expect(paisSnapshotEstoqueLiCollection.docPath(CONTA, ID_PAIS_SNAPSHOT_ESTOQUE_LI)).toBe(
      'sincEstoqueLojaIntegrada/conta-li-1/snapshot/pais',
    );
    expect(kitsComponenteEstoqueLiCollection.docPath(CONTA, 'blank')).toBe(
      'sincEstoqueLojaIntegrada/conta-li-1/kits/blank',
    );
    expect(
      fatiaKitsComponenteEstoqueLiCollection.docPath(CONTA, idFatiaKitsEstoqueLi('blank', 1)),
    ).toBe('sincEstoqueLojaIntegrada/conta-li-1/kitsFatias/blank~1');
    expect(reconcileEstoqueLojaIntegradaCollection.docPath({}, ID_RECONCILE_ESTOQUE_LI)).toBe(
      'reconcileEstoqueLojaIntegrada/atual',
    );
  });

  it('the snapshot pair (one subcollection) and the kits pair each parse ONLY their own shape', () => {
    const balde = {
      execucaoId: RUN,
      e: { '7': { p: 'p1', s: 1, f: FLAG_ENTRADA_ESTOQUE_LI.valido } },
    };
    const pais = { execucaoId: RUN, ids: ['3'] };
    expect(snapshotEstoqueLiCollection.parse(balde)).toEqual(balde);
    expect(paisSnapshotEstoqueLiCollection.parse(pais)).toEqual(pais);
    expect(() => paisSnapshotEstoqueLiCollection.parse({ execucaoId: RUN, ids: 'x' })).toThrow();

    const cabecalho = { execucaoId: RUN, F: 31, qMax: 1, fatias: 1 };
    const fatia = { execucaoId: RUN, kits: { k1: { i: '11', q: { blank: 1 } } } };
    expect(kitsComponenteEstoqueLiCollection.parse(cabecalho)).toMatchObject(cabecalho);
    expect(fatiaKitsComponenteEstoqueLiCollection.parse(fatia)).toEqual(fatia);
    // A shard is no header (no F, no qMax), and a header with its kits in shards is no shard.
    expect(() => kitsComponenteEstoqueLiCollection.parse(fatia)).toThrow();
    expect(() => fatiaKitsComponenteEstoqueLiCollection.parse(cabecalho)).toThrow();
  });

  it('⚠️ NEAR-MISS: the header of a produto `blank~0` and shard 0 of `blank` are two documents', () => {
    // A produto id may itself end in `~0`; beside the headers, shard 0 of `blank` would BE the
    // header of `blank~0`, and a listing of the headers would read a shard as one.
    const idFatia = idFatiaKitsEstoqueLi('blank', 0);
    expect(idFatia).toBe('blank~0');
    expect(fatiaKitsComponenteEstoqueLiCollection.docPath(CONTA, idFatia)).not.toBe(
      kitsComponenteEstoqueLiCollection.docPath(CONTA, 'blank~0'),
    );
    expect(fatiaKitsComponenteEstoqueLiCollection.resolvePath(CONTA)).not.toBe(
      kitsComponenteEstoqueLiCollection.resolvePath(CONTA),
    );
  });

  it.each([
    ['sincEstoqueLojaIntegradaCollection', sincEstoqueLojaIntegradaCollection, { reconcile: null }],
    ['snapshotEstoqueLiCollection', snapshotEstoqueLiCollection, { execucaoId: RUN }],
    ['paisSnapshotEstoqueLiCollection', paisSnapshotEstoqueLiCollection, { ids: ['3'] }],
    ['kitsComponenteEstoqueLiCollection', kitsComponenteEstoqueLiCollection, { execucaoId: RUN }],
    [
      'fatiaKitsComponenteEstoqueLiCollection',
      fatiaKitsComponenteEstoqueLiCollection,
      { execucaoId: RUN },
    ],
    [
      'reconcileEstoqueLojaIntegradaCollection',
      reconcileEstoqueLojaIntegradaCollection,
      { proximoSlotMs: 1 },
    ],
  ] as const)(
    '⚠️ %s validates a PATCH: parseMerge keeps the keys given, adds no default, refuses an unknown key',
    (_nome, handle, patch) => {
      expect(handle.parseMerge(patch)).toEqual(patch);
      expect(() => handle.parseMerge({ modoPendente: 'completo' })).toThrow(ZodError);
    },
  );

  it('the patches the plan writes: the run advancing its phase, and the kit fan-out taking the slot', () => {
    expect(
      reconcileEstoqueLojaIntegradaCollection.parseMerge({
        fase: 'li',
        idxConta: 1,
        seq: 8,
        candidatos: [{ c: 0, i: '7', p: 'p1', d: 2 }],
      }),
    ).toEqual({ fase: 'li', idxConta: 1, seq: 8, candidatos: [{ c: 0, i: '7', p: 'p1', d: 2 }] });
    expect(() => reconcileEstoqueLojaIntegradaCollection.parseMerge({ seq: -1 })).toThrow(ZodError);
  });

  it('the handles validate the SHAPE; the invariants are the refined schemas a full write parses with', () => {
    // An index two past one conta, and a header whose F disagrees with its inline kits.
    const corrida = { execucaoId: RUN, contas: ['conta-li-1'], idxConta: 2 };
    const cabecalho = { execucaoId: RUN, F: 3, qMax: 1, kits: { k1: { i: '11', q: { b: 1 } } } };
    expect(() => reconcileEstoqueLojaIntegradaCollection.parse(corrida)).not.toThrow();
    expect(reconcileEstoqueLojaIntegradaSchema.safeParse(corrida).success).toBe(false);
    expect(() => kitsComponenteEstoqueLiCollection.parse(cabecalho)).not.toThrow();
    expect(kitsComponenteEstoqueLiSchema.safeParse(cabecalho).success).toBe(false);
  });
});
