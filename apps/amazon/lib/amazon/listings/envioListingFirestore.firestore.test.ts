/**
 * The listings flows' shared outcome write-back on a REAL Firestore — the
 * emulator of `ci-amazon.yml` — at the PRICE flow's field. It proves on the
 * server what only holds if the server behaves as the offline fake says:
 *
 *  - a masked `getAll` snapshot answers ONLY the flow's field, still carries
 *    the `updateTime` the precondition needs, and the update writes that field
 *    alone: a stored `envioEstoqueAmazon` (and the product payload) is
 *    BYTE-EQUAL afterwards;
 *  - a concurrent `update` between our read and our write fails our
 *    precondition, and the write-back re-reads and re-decides;
 *  - NEAR-MISS: the stock binding at the same document writes
 *    `envioEstoqueAmazon` alone, the price field byte-equal afterwards.
 *
 * The price outcome here is a TEST schema shaped like the stock outcome with
 * an offer in place of the quantity, never the price flow's own schema. The
 * concurrent writer is injected by spying
 * on the database's own `getAll` (the real call runs; the competing `update`
 * lands right after it answers). No network, no task.
 *
 * ⚠️ The emulator is SHARED: every document id here starts with
 * `e2e-listings-envio-`, which no other suite seeds; no `integracao` document is
 * written, so the conta trigger never fires, and `prodAmazon` is no trigger
 * path. Every case wipes what it seeds first, and the file leaves nothing
 * behind.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
  resultadoEnvioEstoqueAmazonSchema,
  viaEnvioEstoqueAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { envioDoPatch } from '../estoque/envioEstoque';
import { gravarEnvioEstoqueAmazon } from '../estoque/envioEstoqueFirestore';
import { loggerEspiao } from '../testing/fixtures';
import {
  type CampoEnvioListingAmazon,
  type LinkDoEnvioListingAmazon,
  gravarEnvioListingAmazon,
} from './envioListingFirestore';
import { FLUXO_LISTING_AMAZON } from './fluxoListing';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-listings-envio-';
const CONTA = `${P}conta`;
const SKU = `${P}SKU-1`;
/** ms — our clock (2027-01-15T08:00:00Z). */
const AGORA = 1_800_000_000_000;

/** A test outcome of the price flow's field: the stock outcome's shape, an offer in place of the quantity. */
const envioDeTesteSchema = z
  .object({
    via: viaEnvioEstoqueAmazonSchema,
    emMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    oferta: z.object({ base: z.number(), minimo: z.number(), maximo: z.number() }).nullable(),
    resultado: resultadoEnvioEstoqueAmazonSchema,
    submissionId: z.string().min(1).nullable().default(null),
    feedId: z.string().min(1).nullable().default(null),
    problemas: z
      .array(z.unknown())
      .max(10)
      .default(() => []),
  })
  .superRefine((envio, ctx) => {
    if ((envio.via === VIA_ENVIO_ESTOQUE_AMAZON.patch) !== (envio.oferta !== null)) {
      ctx.addIssue({ code: 'custom', path: ['oferta'], message: 'só um patch guarda a oferta' });
    }
  });
type EnvioDeTeste = z.infer<typeof envioDeTesteSchema>;

const PRECO: CampoEnvioListingAmazon<EnvioDeTeste> = {
  fluxo: FLUXO_LISTING_AMAZON.preco,
  schema: envioDeTesteSchema,
  rotulo: 'precoDeTeste.ts',
};

/** A patch outcome whose offer's `base` is `base` (the floor below it, the ceiling at it). */
const teste = (emMs: number, base: number): EnvioDeTeste => ({
  via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
  emMs,
  oferta: { base, minimo: base - 1, maximo: base },
  resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
  submissionId: 'sub-p',
  feedId: null,
  problemas: [],
});

/** The stock flow's stored outcome, which a price write-back must leave byte-equal. */
const ESTOQUE = envioDoPatch(
  {
    status: 'ACCEPTED',
    submissionId: 'sub-estoque',
    issues: [{ code: '90000', severity: 'WARNING' }],
  },
  AGORA - 5_000,
  7,
);

function db(): Firestore {
  return getAdminFirestore();
}

const L1: LinkDoEnvioListingAmazon = { produtoId: `${P}P`, linkId: `${P}l1` };
const caminho = (l: LinkDoEnvioListingAmazon) => `produtos/${l.produtoId}/prodAmazon/${l.linkId}`;

async function limpar(): Promise<void> {
  await db().doc(caminho(L1)).delete();
}

/** A link doc with a product payload no read may return, the stock outcome and, maybe, the price one. */
async function vinculo(envioPrecoAmazon: unknown): Promise<void> {
  await db()
    .doc(caminho(L1))
    .set({
      contaAmazonOuterRef: `documents/integracao/${CONTA}`,
      sku: SKU,
      productDataJson: { pesado: 'x'.repeat(256) },
      envioEstoqueAmazon: ESTOQUE,
      envioPrecoAmazon,
    });
}

async function documento(): Promise<Record<string, unknown>> {
  return (await db().doc(caminho(L1)).get()).data() ?? {};
}

function gravarPreco(envio: EnvioDeTeste) {
  return gravarEnvioListingAmazon(
    db(),
    PRECO,
    { contaId: CONTA, sku: SKU, links: [L1], envio, agoraMs: AGORA },
    { logger: loggerEspiao().logger },
  );
}

describe.skipIf(!EMULATED)('the shared outcome write-back on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the price field alone: the masked read answers it alone, and the stored envioEstoqueAmazon and payload are BYTE-EQUAL afterwards', async () => {
    await vinculo(null);
    const antes = await documento();
    const getAll = vi.spyOn(db(), 'getAll');
    const envio = teste(AGORA, 12.5);
    const r = await gravarPreco(envio);
    expect(r).toMatchObject({ gravados: 1, mantidos: 0, ausentes: 0, emConflito: 0 });
    const snaps = await (getAll.mock.results[0]?.value as ReturnType<Firestore['getAll']>);
    expect(Object.keys(snaps[0]?.data() ?? {})).toEqual(['envioPrecoAmazon']);
    expect(snaps[0]?.updateTime).toBeDefined();
    expect(r.relogio?.isEqual(snaps[0]!.readTime)).toBe(true);
    const depois = await documento();
    expect(depois.envioPrecoAmazon).toEqual(envio);
    // BYTE-EQUAL: everything but the price field is exactly as it was.
    const { envioPrecoAmazon: _a, ...restoAntes } = antes;
    const { envioPrecoAmazon: _b, ...restoDepois } = depois;
    expect(JSON.stringify(restoDepois)).toBe(JSON.stringify(restoAntes));
    expect(depois.envioEstoqueAmazon).toEqual(ESTOQUE);
  });

  it('★ a concurrent NEWER price outcome between our read and our write ⇒ re-read, re-decide: ours is dropped, the stock outcome untouched', async () => {
    await vinculo(teste(AGORA - 60_000, 3));
    const estoqueAntes = JSON.stringify((await documento()).envioEstoqueAmazon);
    const original = db().getAll.bind(db());
    const getAll = vi.spyOn(db(), 'getAll');
    getAll.mockImplementationOnce(async (...args: Parameters<Firestore['getAll']>) => {
      const snaps = await original(...args);
      await db()
        .doc(caminho(L1))
        .update({ envioPrecoAmazon: teste(AGORA + 5_000, 9) });
      return snaps;
    });
    const r = await gravarPreco(teste(AGORA, 7));
    expect(getAll).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ gravados: 0, mantidos: 1, emConflito: 0 });
    const depois = await documento();
    expect(depois.envioPrecoAmazon).toMatchObject({
      oferta: { base: 9 },
      emMs: AGORA + 5_000,
    });
    expect(JSON.stringify(depois.envioEstoqueAmazon)).toBe(estoqueAntes);
  });

  it('★ NEAR-MISS: the stock binding at the same document writes envioEstoqueAmazon alone; the price field is BYTE-EQUAL afterwards', async () => {
    const preco = teste(AGORA - 1, 4.25);
    await vinculo(preco);
    const precoAntes = JSON.stringify((await documento()).envioPrecoAmazon);
    const envio = envioDoPatch({ status: 'ACCEPTED', submissionId: 'sub-novo' }, AGORA, 2);
    await gravarEnvioEstoqueAmazon(
      db(),
      { contaId: CONTA, sku: SKU, links: [L1], envio, agoraMs: AGORA },
      { logger: loggerEspiao().logger },
    );
    const depois = await documento();
    expect(depois.envioEstoqueAmazon).toMatchObject({ quantidade: 2, emMs: AGORA });
    expect(JSON.stringify(depois.envioPrecoAmazon)).toBe(precoAntes);
    expect(depois.envioPrecoAmazon).toEqual(preco);
  });
});
