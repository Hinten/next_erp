import { describe, expect, it } from 'vitest';
import {
  FLAG_ENTRADA_ESTOQUE_LI,
  ID_PAIS_SNAPSHOT_ESTOQUE_LI,
  ID_RECONCILE_ESTOQUE_LI,
  idFatiaKitsEstoqueLi,
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
    ).toBe('sincEstoqueLojaIntegrada/conta-li-1/kits/blank~1');
    expect(reconcileEstoqueLojaIntegradaCollection.docPath({}, ID_RECONCILE_ESTOQUE_LI)).toBe(
      'reconcileEstoqueLojaIntegrada/atual',
    );
  });

  it('the two pairs that share a subcollection parse ONLY their own shape', () => {
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
});
