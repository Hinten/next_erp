import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  FLAG_ENTRADA_PRECO_LI,
  ID_PAIS_ERP_SNAPSHOT_PRECO_LI,
  ID_SLOT_PRECO_RECONCILE_LI,
  reconcileEstoqueLojaIntegradaSchema,
} from '@delfrance/schemas';
import {
  paisErpSnapshotPrecoLiCollection,
  reconcileEstoqueLojaIntegradaCollection,
  sincPrecoLojaIntegradaCollection,
  snapshotEstoqueLiCollection,
  snapshotPrecoLiCollection,
} from './index';

const CONTA = { integracaoId: 'conta-li-1' };
const RUN = 'estoque-reconcile-20271115';

describe('the Loja Integrada price-sync handles (step 13)', () => {
  it('resolve to the documented paths', () => {
    expect(sincPrecoLojaIntegradaCollection.docPath({}, 'conta-li-1')).toBe(
      'sincPrecoLojaIntegrada/conta-li-1',
    );
    expect(snapshotPrecoLiCollection.docPath(CONTA, '07')).toBe(
      'sincPrecoLojaIntegrada/conta-li-1/snapshot/07',
    );
    expect(paisErpSnapshotPrecoLiCollection.docPath(CONTA, ID_PAIS_ERP_SNAPSHOT_PRECO_LI)).toBe(
      'sincPrecoLojaIntegrada/conta-li-1/snapshot/paisErp',
    );
    // The price slot is a second document of the run document's collection.
    expect(reconcileEstoqueLojaIntegradaCollection.docPath({}, ID_SLOT_PRECO_RECONCILE_LI)).toBe(
      'reconcileEstoqueLojaIntegrada/slot-preco',
    );
  });

  it('⚠️ NEAR-MISS: the price buckets are never the stock buckets of the same conta', () => {
    expect(snapshotPrecoLiCollection.resolvePath(CONTA)).not.toBe(
      snapshotEstoqueLiCollection.resolvePath(CONTA),
    );
    expect(snapshotPrecoLiCollection.docPath(CONTA, '07')).not.toBe(
      snapshotEstoqueLiCollection.docPath(CONTA, '07'),
    );
  });

  it('the bucket and the parents doc (one subcollection) each parse ONLY their own shape', () => {
    const balde = {
      execucaoId: RUN,
      e: { '7': { p: 'f1', f: FLAG_ENTRADA_PRECO_LI.valido, n: 5000, a: { c: 5000, q: null } } },
    };
    const pais = { execucaoId: RUN, pais: { pai1: { pp: true, n: 5000, pr: null } } };
    expect(snapshotPrecoLiCollection.parse(balde)).toEqual(balde);
    expect(paisErpSnapshotPrecoLiCollection.parse(pais)).toEqual(pais);
    expect(() => paisErpSnapshotPrecoLiCollection.parse({ execucaoId: RUN, pais: 'x' })).toThrow();
    expect(() =>
      snapshotPrecoLiCollection.parse({ execucaoId: RUN, e: { '7': { p: 'f1' } } }),
    ).toThrow();
  });

  it.each([
    [
      'sincPrecoLojaIntegradaCollection',
      sincPrecoLojaIntegradaCollection,
      { reconcilePreco: null },
    ],
    ['snapshotPrecoLiCollection', snapshotPrecoLiCollection, { execucaoId: RUN }],
    ['paisErpSnapshotPrecoLiCollection', paisErpSnapshotPrecoLiCollection, { pais: {} }],
  ] as const)(
    '⚠️ %s validates a PATCH: parseMerge keeps the keys given, adds no default, refuses an unknown key',
    (_nome, handle, patch) => {
      expect(handle.parseMerge(patch)).toEqual(patch);
      expect(() => handle.parseMerge({ custo: 12.5 })).toThrow(ZodError);
    },
  );

  it('the patches the plan writes: a run’s state and the memory; the slot alone', () => {
    const execucaoPreco = {
      execucaoId: RUN,
      tabelas: { normal: 'tab-normal', promocional: null },
      vistos: ['7'],
      amostras: {},
      contadores: { candidatos: 1 },
      candidatos: [{ i: '7', p: 'f1', d: 100 }],
    };
    const enviadosPreco = [{ i: '7', h: '5000:0:4900:0', n: 1 }];
    expect(sincPrecoLojaIntegradaCollection.parseMerge({ execucaoPreco, enviadosPreco })).toEqual({
      execucaoPreco,
      enviadosPreco,
    });
    expect(() =>
      sincPrecoLojaIntegradaCollection.parseMerge({ enviadosPreco: [{ i: '7', h: 'x', n: 1 }] }),
    ).toThrow(ZodError);
    // The price slot's ONE write, through the run document's handle.
    expect(reconcileEstoqueLojaIntegradaCollection.parseMerge({ proximoSlotMs: 1 })).toEqual({
      proximoSlotMs: 1,
    });
    // …and a price phase or "Atualizar preços" patch on the run document itself.
    const precoSolicitado = { execucaoId: RUN, contaId: 'conta-li-1', permitirBaixar: false };
    expect(
      reconcileEstoqueLojaIntegradaCollection.parseMerge({
        fasePreco: 'li-preco',
        precoSolicitado,
      }),
    ).toEqual({ fasePreco: 'li-preco', precoSolicitado });
    // NEAR-MISS: a request with no run of its own is refused, never stored.
    expect(() =>
      reconcileEstoqueLojaIntegradaCollection.parseMerge({
        precoSolicitado: { contaId: 'conta-li-1', permitirBaixar: false },
      }),
    ).toThrow(ZodError);
  });

  it('the run handle validates the SHAPE; the price-phase invariant is the refined schema’s', () => {
    const corrida = { execucaoId: RUN, fase: 'fim', fasePreco: 'li-preco' };
    expect(() => reconcileEstoqueLojaIntegradaCollection.parse(corrida)).not.toThrow();
    expect(reconcileEstoqueLojaIntegradaSchema.safeParse(corrida).success).toBe(false);
  });
});
