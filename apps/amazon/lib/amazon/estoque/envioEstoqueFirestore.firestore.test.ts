/**
 * The stock outcome write-back on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 12, PR 12-e1). The offline
 * suite drives every branch against `testing/fakeDb.ts`; this file proves, on
 * the real server, what only holds if the server behaves as the fake says:
 *
 *  - a MASKED `getAll` snapshot still carries the `updateTime` the precondition
 *    needs, answers only the outcome field, and its `readTime` is the clock;
 *  - a concurrent `update` landing between our read and our write fails our
 *    precondition, and the write-back RE-READS and RE-DECIDES: a newer outcome
 *    is kept, an older one is overwritten;
 *  - an older `emMs` arriving after a newer one is dropped; an EQUAL one keeps
 *    the stored (the near-miss).
 *
 * The concurrent writer is injected by spying on the database's own `getAll`
 * (the real call runs; the competing `update` lands right after it answers).
 * No network, no task: nothing here reaches a client.
 *
 * ⚠️ The emulator is SHARED: every document id here starts with
 * `e2e-estoque-envio-`, which no other suite seeds; no `integracao` document is
 * written, so the conta trigger never fires, and `prodAmazon` is no trigger
 * path. Every case wipes what it seeds first, and the file leaves nothing
 * behind.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { loggerEspiao } from '../testing/fixtures';
import { envioDoFeed, envioDoPatch, envioIncerto } from './envioEstoque';
import { type LinkDoEnvioEstoqueAmazon, gravarEnvioEstoqueAmazon } from './envioEstoqueFirestore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-envio-';
const CONTA = `${P}conta`;
const SKU = `${P}SKU-1`;
/** ms — our clock (2027-01-15T08:00:00Z). */
const AGORA = 1_800_000_000_000;

function db(): Firestore {
  return getAdminFirestore();
}

const L1: LinkDoEnvioEstoqueAmazon = { produtoId: `${P}P`, linkId: `${P}l1` };
const L2: LinkDoEnvioEstoqueAmazon = { produtoId: `${P}P`, linkId: `${P}l2` };
const caminho = (l: LinkDoEnvioEstoqueAmazon) => `produtos/${l.produtoId}/prodAmazon/${l.linkId}`;

/** Every path this file may seed, so each case starts clean and the file ends clean. */
const CAMINHOS: string[] = [caminho(L1), caminho(L2)];

async function limpar(): Promise<void> {
  await Promise.all(CAMINHOS.map((c) => db().doc(c).delete()));
}

/** A link doc with a product payload no read may return, and a stored outcome. */
async function vinculo(l: LinkDoEnvioEstoqueAmazon, envioEstoqueAmazon: unknown): Promise<void> {
  await db()
    .doc(caminho(l))
    .set({
      contaAmazonOuterRef: `documents/integracao/${CONTA}`,
      sku: SKU,
      productDataJson: { pesado: 'x'.repeat(256) },
      envioEstoqueAmazon,
    });
}

const aceito = (emMs: number, quantidade: number) =>
  envioDoPatch({ status: 'ACCEPTED', submissionId: 'sub-1' }, emMs, quantidade);

async function armazenado(
  l: LinkDoEnvioEstoqueAmazon,
): Promise<Record<string, unknown> | undefined> {
  return (await db().doc(caminho(l)).get()).data()?.envioEstoqueAmazon as
    | Record<string, unknown>
    | undefined;
}

function gravar(envio: ReturnType<typeof aceito>, links = [L1]) {
  return gravarEnvioEstoqueAmazon(
    db(),
    { contaId: CONTA, sku: SKU, links, envio, agoraMs: AGORA },
    { logger: loggerEspiao().logger },
  );
}

/** After the FIRST `getAll` answers, `competir` lands (once): the window a concurrent writer uses. */
function concorrenteAposALeitura(competir: () => Promise<unknown>) {
  const original = db().getAll.bind(db());
  const getAll = vi.spyOn(db(), 'getAll');
  getAll.mockImplementationOnce(async (...args: Parameters<Firestore['getAll']>) => {
    const snaps = await original(...args);
    await competir();
    return snaps;
  });
  return getAll;
}

describe.skipIf(!EMULATED)('the stock outcome write-back on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await limpar();
  });

  it('the masked read: the outcome field alone, its updateTime feeds the precondition, the clock is its readTime', async () => {
    await vinculo(L1, null);
    const getAll = vi.spyOn(db(), 'getAll');
    const r = await gravar(aceito(AGORA, 5));
    expect(r).toMatchObject({ gravados: 1, mantidos: 0, ausentes: 0, emConflito: 0 });
    expect(await armazenado(L1)).toMatchObject({ via: 'patch', quantidade: 5, emMs: AGORA });
    // What the masked snapshot itself answered: the outcome field only.
    const snaps = await (getAll.mock.results[0]?.value as ReturnType<Firestore['getAll']>);
    expect(Object.keys(snaps[0]?.data() ?? {})).toEqual(['envioEstoqueAmazon']);
    expect(snaps[0]?.updateTime).toBeDefined();
    expect(r.relogio?.isEqual(snaps[0]!.readTime)).toBe(true);
    // The product payload is untouched by the update.
    const doc = (await db().doc(caminho(L1)).get()).data();
    expect(doc?.productDataJson).toEqual({ pesado: 'x'.repeat(256) });
  });

  it('★ a concurrent update with a NEWER outcome between our read and our write ⇒ re-read, re-decide: ours is dropped', async () => {
    await vinculo(L1, aceito(AGORA - 60_000, 3));
    const getAll = concorrenteAposALeitura(() =>
      db()
        .doc(caminho(L1))
        .update({ envioEstoqueAmazon: aceito(AGORA + 5_000, 9) }),
    );
    const r = await gravar(aceito(AGORA, 7));
    expect(getAll).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ gravados: 0, mantidos: 1, emConflito: 0 });
    expect(await armazenado(L1)).toMatchObject({ quantidade: 9, emMs: AGORA + 5_000 });
  });

  it('★ NEAR-MISS: a concurrent update with an OLDER outcome ⇒ re-read, re-decide: ours lands on the fresh stamp', async () => {
    await vinculo(L1, aceito(AGORA - 60_000, 3));
    const getAll = concorrenteAposALeitura(() =>
      db()
        .doc(caminho(L1))
        .update({ envioEstoqueAmazon: aceito(AGORA - 30_000, 2) }),
    );
    const r = await gravar(aceito(AGORA, 7));
    expect(getAll).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ gravados: 1, mantidos: 0, emConflito: 0 });
    expect(await armazenado(L1)).toMatchObject({ quantidade: 7, emMs: AGORA });
  });

  it('★ an older emMs arriving after a newer one is dropped; NEAR-MISS: an EQUAL emMs keeps the stored', async () => {
    await vinculo(L1, null);
    await gravar(aceito(AGORA + 1_000, 4));
    // A feed report of a submission BEFORE that patch arrives later.
    const tardio = await gravarEnvioEstoqueAmazon(
      db(),
      {
        contaId: CONTA,
        sku: SKU,
        links: [L1],
        envio: envioDoFeed([], '50001234567', AGORA),
        agoraMs: AGORA,
      },
      { logger: loggerEspiao().logger },
    );
    expect(tardio).toMatchObject({ gravados: 0, mantidos: 1 });
    expect(await armazenado(L1)).toMatchObject({
      via: 'patch',
      quantidade: 4,
      emMs: AGORA + 1_000,
    });
    // The same instant again, another quantity: the stored stays.
    const igual = await gravar(aceito(AGORA + 1_000, 8));
    expect(igual).toMatchObject({ gravados: 0, mantidos: 1 });
    expect(await armazenado(L1)).toMatchObject({ quantidade: 4 });
    // One ms newer: written.
    const novo = await gravar(aceito(AGORA + 1_001, 8));
    expect(novo).toMatchObject({ gravados: 1 });
    expect(await armazenado(L1)).toMatchObject({ quantidade: 8, emMs: AGORA + 1_001 });
  });

  it('a provisional incerto is replaced by its retry’s outcome, on every link doc of the SKU; a gone one is skipped', async () => {
    await vinculo(L1, envioIncerto(AGORA, 4));
    const r = await gravar(aceito(AGORA + 30_000, 3), [L1, L2]);
    expect(r).toMatchObject({ gravados: 1, ausentes: 1 });
    expect(await armazenado(L1)).toMatchObject({ resultado: 'aceito', quantidade: 3 });
    expect((await db().doc(caminho(L2)).get()).exists).toBe(false);
  });
});
