/**
 * The parts of a price run on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 13, PR 13-e). The offline
 * suite drives every branch against `testing/fakeDb.ts`; this file proves what
 * only holds if the server behaves as the fake says:
 *
 *  - ★ the TTL stamp written as a `Date` comes back a `Timestamp` of the same
 *    instant, seven days after the page (a number would be ignored by the
 *    policy), under the run, at the part's id;
 *  - ★ the holding page's write is a FULL overwrite on the server: a re-run page's
 *    smaller part replaces the larger one whole;
 *  - ★ the reader is masked BY THE SERVER (the TTL stamp never comes back), a
 *    missing id reads as no part, and a part naming another run is refused.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * here sits under `precosAmazon/e2e-preco-partes-conta`, which no other suite
 * seeds; no `integracao` and no `nfev4` document is written, nothing is
 * enqueued. Every case wipes what it reads first, and the file leaves nothing
 * behind. PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ItemDivergenciaPrecoAmazon,
  TIPO_OFERTA_PRECO_AMAZON,
  idDivergenciaPrecoAmazon,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { DIA_MS } from '../testing/fixtures';
import {
  DivergenciaPrecoInvalidaError,
  gravarParteDivergenciaPrecoAmazon,
  lerParteDivergenciaPrecoAmazon,
  lerPartesDivergenciaPrecoAmazon,
} from './divergenciasPrecoFirestore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-preco-partes-';
/** The conta of this file — an id no other suite seeds (no conta document is written). */
const CONTA = `${P}conta`;
const EXEC = `${P}exec`;
const RUN = `precosAmazon/${CONTA}`;
const parte = (n: number, exec = EXEC) =>
  `${RUN}/divergenciasPrecoAmazon/${idDivergenciaPrecoAmazon(exec, n)}`;

function item(sku: string, base = 50): ItemDivergenciaPrecoAmazon {
  return {
    sku,
    vinculo: `produtos/${P}p-${sku}/prodAmazon/${P}l-${sku}`,
    unidadeId: `${P}p-${sku}`,
    oferta: { tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base: 60, minimo: 55, maximo: 60 },
    faixa: { base, minimo: base, maximo: base },
    tipoProduto: 'PRODUCT',
    lidoEmMs: 1_800_000_000_000,
  };
}

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(RUN));
}

const gravar = (n: number, itens: ItemDivergenciaPrecoAmazon[], agoraMs: number, exec = EXEC) =>
  gravarParteDivergenciaPrecoAmazon(db(), {
    contaId: CONTA,
    execucaoId: exec,
    parte: n,
    itens,
    agoraMs,
  });

describe.skipIf(!EMULATED)('the price run’s parts on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the TTL stamp is stored as a Timestamp seven days after the page; the part parses back, members in SKU order', async () => {
    const agora = Date.now();
    await gravar(0, [item('B'), item('A')], agora);
    const cru = (await db().doc(parte(0)).get()).data() ?? {};
    const expira = cru.expiraEm as Timestamp;
    expect(typeof expira.toMillis).toBe('function');
    expect(expira.toMillis()).toBe(agora + 7 * DIA_MS);
    const lida = await lerParteDivergenciaPrecoAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      parte: 0,
    });
    expect(lida).toEqual({ parte: 0, existe: true, itens: [item('A'), item('B')] });
  });

  it('★ a re-run page’s part REPLACES the earlier one whole on the server', async () => {
    const agora = Date.now();
    await gravar(1, [item('A', 50), item('B'), item('C')], agora);
    await gravar(1, [item('A', 45)], agora + 1_000);
    const [lida] = await lerPartesDivergenciaPrecoAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      parteInicial: 1,
      partes: 1,
    });
    expect(lida?.itens).toEqual([item('A', 45)]);
    const cru = (await db().doc(parte(1)).get()).data() ?? {};
    expect((cru.expiraEm as Timestamp).toMillis()).toBe(agora + 1_000 + 7 * DIA_MS);
  });

  it('★ the reader is masked by the SERVER (no TTL stamp comes back); a missing id is no part; a part naming another run is refused', async () => {
    const agora = Date.now();
    await gravar(1, [item('A')], agora);
    const original = db().getAll.bind(db());
    const campos: string[][] = [];
    vi.spyOn(db(), 'getAll').mockImplementation(async (...args) => {
      const snaps = await original(...args);
      for (const s of snaps) if (s.exists) campos.push(Object.keys(s.data() ?? {}).sort());
      return snaps;
    });
    const lidas = await lerPartesDivergenciaPrecoAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      parteInicial: 0,
      partes: 2,
    });
    expect(lidas.map((p) => [p.parte, p.existe, p.itens.map((i) => i.sku)])).toEqual([
      [0, false, []],
      [1, true, ['A']],
    ]);
    expect(campos).toEqual([['execucaoId', 'itens']]);
    vi.restoreAllMocks();
    // A hand edit that moved another run's content under this run's id.
    await gravar(0, [item('X')], agora, `${P}outra`);
    const outra =
      (
        await db()
          .doc(parte(0, `${P}outra`))
          .get()
      ).data() ?? {};
    await db().doc(parte(0)).set(outra);
    await expect(
      lerParteDivergenciaPrecoAmazon(db(), { contaId: CONTA, execucaoId: EXEC, parte: 0 }),
    ).rejects.toThrow(DivergenciaPrecoInvalidaError);
  });
});
