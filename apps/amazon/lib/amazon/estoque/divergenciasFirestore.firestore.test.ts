/**
 * The drift blocks on a REAL Firestore — the emulator of `ci-amazon.yml`, not
 * the in-memory fake (step 12, PR 12-f). The offline suite drives every branch
 * against `testing/fakeDb.ts`; this file proves what only holds if the server
 * behaves as the fake says:
 *
 *  - ★ the TTL stamp written as a `Date` comes back a `Timestamp` of the same
 *    instant (a number would be ignored by the policy), and the block parses
 *    back through its schema;
 *  - ★ the page's write is a FULL overwrite on the server: a retried page's
 *    smaller block replaces the larger one whole;
 *  - ★ the reader is ONE by-id `getAll`: a missing id reads as an empty block,
 *    and a block of another run is never read.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * here sits under `reconciliacaoEstoqueAmazon/e2e-estoque-divergencias-conta`,
 * which no other suite seeds; no `integracao` and no `nfev4` document is
 * written, nothing is enqueued. Every case wipes what it reads first, and the
 * file leaves nothing behind.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idDivergenciaEstoqueAmazon } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { DIA_MS } from '../testing/fixtures';
import {
  DivergenciaEstoqueInvalidaError,
  gravarBlocoDivergenciaEstoqueAmazon,
  lerBlocosDivergenciaEstoqueAmazon,
} from './divergenciasFirestore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-divergencias-';
/** The conta of this file — an id no other suite seeds (no conta document is written). */
const CONTA = `${P}conta`;
const EXEC = `${P}exec`;
const DEP = `${P}dep`;
const RUN = `reconciliacaoEstoqueAmazon/${CONTA}`;
const bloco = (n: number, exec = EXEC) =>
  `${RUN}/divergenciasEstoqueAmazon/${idDivergenciaEstoqueAmazon(exec, n)}`;
const item = (sku: string) => ({
  sku,
  unidadeId: `${P}u-${sku}`,
  quantidadeAmazon: null,
  quantidadeErp: 3,
});

function db(): Firestore {
  return getAdminFirestore();
}

async function limpar(): Promise<void> {
  await db().recursiveDelete(db().doc(RUN));
}

const gravar = (pagina: number, itens: ReturnType<typeof item>[], agoraMs: number) =>
  gravarBlocoDivergenciaEstoqueAmazon(db(), {
    contaId: CONTA,
    execucaoId: EXEC,
    pagina,
    depositoId: DEP,
    itens,
    agoraMs,
  });

describe.skipIf(!EMULATED)('the drift blocks on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the TTL stamp is stored as a Timestamp of the same instant; the block parses back, items sorted, the canonical depósito', async () => {
    const agora = Date.now();
    await gravar(0, [item('B'), item('A')], agora);
    const cru = (await db().doc(bloco(0)).get()).data() ?? {};
    const expira = cru.expiraEm as Timestamp;
    expect(typeof expira.toMillis).toBe('function');
    expect(expira.toMillis()).toBe(agora + 7 * DIA_MS);
    expect(cru.depositoOuterRef).toBe(`documents/depositos/${DEP}`);
    const [lido] = await lerBlocosDivergenciaEstoqueAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      partes: 1,
    });
    expect(lido).toEqual({
      pagina: 0,
      existe: true,
      depositoId: DEP,
      itens: [item('A'), item('B')],
    });
  });

  it('★ a retried page’s block REPLACES the earlier one whole on the server', async () => {
    const agora = Date.now();
    await gravar(1, [item('A'), item('B'), item('C')], agora);
    await gravar(1, [item('C')], agora + 1_000);
    const [, segundo] = await lerBlocosDivergenciaEstoqueAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      partes: 2,
    });
    expect(segundo?.itens).toEqual([item('C')]);
  });

  it('★ the reader: a missing id is an empty block, another run’s block is never read, a block naming another run throws', async () => {
    const agora = Date.now();
    await gravar(2, [item('A')], agora);
    await gravarBlocoDivergenciaEstoqueAmazon(db(), {
      contaId: CONTA,
      execucaoId: `${P}outro`,
      pagina: 0,
      depositoId: DEP,
      itens: [item('X')],
      agoraMs: agora,
    });
    const blocos = await lerBlocosDivergenciaEstoqueAmazon(db(), {
      contaId: CONTA,
      execucaoId: EXEC,
      partes: 3,
    });
    expect(blocos.map((b) => [b.pagina, b.existe, b.itens.map((i) => i.sku)])).toEqual([
      [0, false, []],
      [1, false, []],
      [2, true, ['A']],
    ]);
    // A hand edit that moved another run's content under this run's id.
    const outro =
      (
        await db()
          .doc(bloco(0, `${P}outro`))
          .get()
      ).data() ?? {};
    await db().doc(bloco(0)).set(outro);
    await expect(
      lerBlocosDivergenciaEstoqueAmazon(db(), { contaId: CONTA, execucaoId: EXEC, partes: 1 }),
    ).rejects.toThrow(DivergenciaEstoqueInvalidaError);
  });
});
