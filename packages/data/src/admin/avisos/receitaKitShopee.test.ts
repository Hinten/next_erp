import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MOTIVO_RESOLUCAO_RECEITA_KIT, chaveAvisoReceitaKitShopee } from '@delfrance/schemas';

import * as barrel from './index';
import { microsDeUpdateTime, reavaliarAvisoDeReceitaKit } from './receitaKitShopee';

/**
 * THIN on purpose (S3F-08). The behaviour of `reavaliarAvisoDeReceitaKit` — the
 * decision over real link/child/row documents, the clock, the watermark and the
 * snapshot — is pinned in `apps/shopee/lib/shopee/produtos/reavaliarAvisoReceitaKit.test.ts`,
 * over the Shopee app's `FakeDb`, the only double in the repo with queries, a
 * transaction AND a per-document `updateTime`. This folder's own fake (in
 * `escreverAviso.test.ts`) has none of the three, and `packages/data` cannot import
 * an app. What lives here is the one pure conversion and the wiring.
 */

describe('microsDeUpdateTime', () => {
  it('seconds · 1e6 + ⌊nanoseconds / 1e3⌋', () => {
    expect(microsDeUpdateTime({ seconds: 1_760_000_000, nanoseconds: 123_456_789 })).toBe(
      1_760_000_000_123_456,
    );
    expect(microsDeUpdateTime({ seconds: 0, nanoseconds: 0 })).toBe(0);
    // ⌊⌋, never a round: 999 ns is still the same microsecond.
    expect(microsDeUpdateTime({ seconds: 5, nanoseconds: 999 })).toBe(5_000_000);
  });

  it('M163: two commits in ONE millisecond are two DIFFERENT clocks — never toMillis()·1000', () => {
    const primeiro = { seconds: 1_760_000_000, nanoseconds: 1_000 };
    const segundo = { seconds: 1_760_000_000, nanoseconds: 2_000 };
    // Both read 1_760_000_000_000 ms: a ms-truncated clock would TIE them, and an
    // equal clock is dropped as stale by `escreverAviso`/`resolverAviso`.
    expect(Math.floor(primeiro.nanoseconds / 1e6)).toBe(Math.floor(segundo.nanoseconds / 1e6));
    expect(microsDeUpdateTime(segundo)).toBeGreaterThan(microsDeUpdateTime(primeiro));
    expect(microsDeUpdateTime(segundo) - microsDeUpdateTime(primeiro)).toBe(1);
  });

  it('⛔ NEAR-MISS: a stamp with no integer seconds/nanoseconds THROWS — never a NaN watermark', () => {
    const invalidos: unknown[] = [
      {},
      { seconds: 1 },
      { nanoseconds: 0 },
      { seconds: Number.NaN, nanoseconds: 0 },
      { seconds: 1.5, nanoseconds: 0 },
      { seconds: 1, nanoseconds: -1 },
      { seconds: 1, nanoseconds: 1_000_000_000 },
      { seconds: '1', nanoseconds: 0 },
    ];
    for (const ts of invalidos) {
      expect(() => microsDeUpdateTime(ts as { seconds: number; nanoseconds: number })).toThrow(
        RangeError,
      );
    }
  });
});

/**
 * A db that answers every query EMPTY and every document ABSENT, recording the
 * transaction options and every write attempt. Enough to pin the wiring; the
 * behaviour lives in the Shopee suite (see the header).
 */
function dbVazio() {
  const opcoes: unknown[] = [];
  const escritas: string[] = [];
  const lidosNaTransacao: string[] = [];
  const consulta = (path: string) => {
    const q = {
      path,
      where: () => q,
      doc: (id: string) => ({
        path: `${path}/${id}`,
        create: () => {
          escritas.push(`${path}/${id}`);
          return Promise.resolve();
        },
        update: () => {
          escritas.push(`${path}/${id}`);
          return Promise.resolve();
        },
        get: () => Promise.resolve({ exists: false, data: () => undefined }),
      }),
    };
    return q;
  };
  const db = {
    collection: (path: string) => consulta(path),
    runTransaction: async (
      fn: (tx: { get: (alvo: { path: string }) => Promise<unknown> }) => Promise<unknown>,
      o?: unknown,
    ) => {
      opcoes.push(o);
      return fn({
        get: (alvo) => {
          lidosNaTransacao.push(alvo.path);
          // An odd segment count is a collection/query: empty. Even: an absent doc.
          return Promise.resolve(
            alvo.path.split('/').length % 2 === 1
              ? { docs: [] }
              : { exists: false, data: () => undefined },
          );
        },
      });
    },
  };
  return { db: db as unknown as Firestore, opcoes, escritas, lidosNaTransacao };
}

describe('reavaliarAvisoDeReceitaKit — wiring', () => {
  it('both names leave through the `@delfrance/data/admin/avisos` barrel', () => {
    expect(barrel.reavaliarAvisoDeReceitaKit).toBe(reavaliarAvisoDeReceitaKit);
    expect(barrel.microsDeUpdateTime).toBe(microsDeUpdateTime);
  });

  it('ONE read-only transaction; a K with nothing at all reads its aviso in it and writes NOTHING', async () => {
    const { db, opcoes, escritas, lidosNaTransacao } = dbVazio();

    const r = await reavaliarAvisoDeReceitaKit(
      db,
      { integracaoId: 'int-1', kitProdutoId: 'kit-k' },
      MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
      { agoraUs: 1_760_000_000_000_000, increment: (n) => n },
    );

    expect(r).toBe('nada');
    expect(opcoes).toEqual([{ readOnly: true }]);
    expect(lidosNaTransacao).toEqual([
      'produtos/kit-k/prodshopee',
      'produtos',
      `avisos/${chaveAvisoReceitaKitShopee('int-1', 'kit-k')}`,
    ]);
    // `resolverAviso` CREATES a resolved row on a missing key — and the trigger
    // reaches this branch for every old-model kit edit, so it must not be called.
    expect(escritas).toEqual([]);
  });
});
