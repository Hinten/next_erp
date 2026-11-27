/**
 * GOLDEN (master plan step 13, PR 13-f1): with the price valve UNSET, the daily reconcile does
 * exactly what the stock-only reconcile did before the price arm was folded in — every document
 * read, every `getAll` and its field mask, every query, every write (verb, path, data, batch,
 * commit stamp), every enqueue on both queues and every logger line, slice by slice.
 *
 * The `.snap` files beside this suite were GENERATED ON THE BASE the price arm was built on, before
 * any of its source changed, and are never regenerated: Vitest refuses to write a missing file
 * snapshot under CI, so a changed trace fails here instead of being silently re-recorded.
 *
 * The scenarios (`testing/reconcilePrecoLi.ts`, one catalogue whose produtos carry prices and
 * whose contas name tabelas, so a price leak would show):
 *
 *  - A: stock `on`, canary `*`, the read switch `on` — the walk over three pages, the kits map,
 *    the store's list, one row out of step enqueued, the end avisos and the release;
 *  - B: stock `dry-run`, the read switch off;
 *  - C: the stock cap unreadable;
 *  - D: the stock valve off.
 *
 * And two that must equal A's: the price valve `off` exactly (E), and an unrecognised price value
 * (F: every Firestore record and every enqueue).
 *
 * No call to the store: the global `fetch` throws; the store is the scripted one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { __setRelogioDoCacheParaTestes } from '../../core/contaCache';
import { type AmbienteLi, CHAMADAS_ENV_LI, VALVULA_ENV_LI } from '../../core/valvulas';
import { AGORA_RECONCILE_MS } from '../../testing/reconcileEstoqueLi';
import {
  AMBIENTE_ESTOQUE_LIGADO_LI,
  type FatiaRastreadaLi,
  encadearReconcilePrecoLi,
  linhaEstavelLi,
  mundoReconcilePrecoLi,
  textoDoTracoLi,
} from '../../testing/reconcilePrecoLi';
import { LIMITE_PAGINA_ESTOQUE_ENV_LI, TETO_ESTOQUE_ENV_LI } from '../configEstoqueLi';

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_RECONCILE_MS);
  vi.stubGlobal('fetch', () => {
    throw new Error('reconcileEstoque.golden.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

const CENARIOS = {
  A: AMBIENTE_ESTOQUE_LIGADO_LI,
  B: { [VALVULA_ENV_LI.estoque]: 'dry-run', [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '2' },
  C: { ...AMBIENTE_ESTOQUE_LIGADO_LI, [TETO_ESTOQUE_ENV_LI]: 'abc' },
  D: { [CHAMADAS_ENV_LI]: 'on' },
} as const;

/** One whole chain in a fresh world; the conta cache emptied first, so every run reads alike. */
async function traco(ambiente: AmbienteLi): Promise<FatiaRastreadaLi[]> {
  __resetAllReadCaches();
  return encadearReconcilePrecoLi(mundoReconcilePrecoLi({ ambiente }));
}

describe('GOLDEN — the price valve unset: the trace is the stock-only reconcile’s, byte for byte', () => {
  it.each(Object.keys(CENARIOS) as (keyof typeof CENARIOS)[])(
    'scenario %s',
    // A whole chain of slices over a three-page walk; CI runners are slower under load.
    { timeout: 30_000 },
    async (cenario) => {
      const fatias = await traco(CENARIOS[cenario]);
      await expect(textoDoTracoLi(fatias)).toMatchFileSnapshot(
        `__snapshots__/reconcileEstoque.sem-preco.${cenario}.snap`,
      );
    },
  );

  it(
    'scenario A is a real run: several slices, the walk, the store, the queue phase and the release',
    // The same whole chain as scenario A above; CI runners are slower under load.
    { timeout: 30_000 },
    async () => {
      const fatias = await traco(CENARIOS.A);
      expect(fatias.length).toBeGreaterThan(3);
      expect(fatias.at(-1)?.resultado).toEqual({ kind: 'encerrado' });
      const texto = textoDoTracoLi(fatias);
      for (const marca of [
        'produtolojaintegrada',
        'sincEstoqueLojaIntegrada/C1/snapshot/',
        'sincEstoqueLojaIntegrada/C1/kits/',
        'fila-estoque ',
        '"msg":"[loja-integrada/estoque] reconcile execução encerrada"',
        '"caminho":"avisos/',
      ]) {
        expect(texto, marca).toContain(marca);
      }
      // The catalogue's prices are there to be leaked: nothing of them is read or written.
      expect(texto).not.toContain('sincPrecoLojaIntegrada');
      expect(texto).not.toContain('"precos"');
      expect(texto).not.toContain('"propagatePriceToChildren"');
    },
  );

  it('E: the price valve `off` EXACTLY ⇒ scenario A’s trace', { timeout: 30_000 }, async () => {
    const fatias = await traco({ ...CENARIOS.A, [VALVULA_ENV_LI.preco]: 'off' });
    await expect(textoDoTracoLi(fatias)).toMatchFileSnapshot(
      '__snapshots__/reconcileEstoque.sem-preco.A.snap',
    );
  });

  it(
    'F: an unrecognised price value (`OFF`) reads as `off` ⇒ scenario A’s trace',
    { timeout: 30_000 },
    async () => {
      const [a, f] = [
        await traco(CENARIOS.A),
        await traco({ ...CENARIOS.A, [VALVULA_ENV_LI.preco]: 'OFF' }),
      ];
      expect(textoDoTracoLi(f)).toBe(textoDoTracoLi(a));
      expect(f.map((x) => linhaEstavelLi(x.resultado))).toEqual(
        a.map((x) => linhaEstavelLi(x.resultado)),
      );
    },
  );
});
