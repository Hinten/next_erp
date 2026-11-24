/**
 * The listings flows' shared outcome write-back, offline against the counting
 * fake db, at BOTH flows' fields: each flow reads and writes ONLY its own field
 * (the masked read, the patch), the other flow's stored outcome untouched;
 * the strictly-newer watermark, the precondition, the bounded re-decide and
 * its ONE warning under the flow's own event; the unit guard; the schema
 * gate. The emulator suite (`envioListingFirestore.firestore.test.ts`) proves
 * the field isolation on a real server. The price outcome here is a TEST
 * schema shaped like the stock outcome with an offer in place of the
 * quantity, never the price flow's own schema.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import {
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
  resultadoEnvioEstoqueAmazonSchema,
  viaEnvioEstoqueAmazonSchema,
} from '@delfrance/schemas';

import { ADIANTAMENTO_MAXIMO_MS } from '../estoque/descobertaEstoque';
import { envioDoPatch } from '../estoque/envioEstoque';
import {
  CAMPO_ENVIO_ESTOQUE_AMAZON,
  MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON,
  MOTIVO_GRAVACAO_ENVIO_EM_CONFLITO,
  gravarEnvioEstoqueAmazon,
} from '../estoque/envioEstoqueFirestore';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { loggerEspiao } from '../testing/fixtures';
import {
  ADIANTAMENTO_MAXIMO_ENVIO_LISTING_AMAZON_MS,
  type CampoEnvioListingAmazon,
  type LinkDoEnvioListingAmazon,
  MAX_TENTATIVAS_ENVIO_LISTING_AMAZON,
  MOTIVO_GRAVACAO_ENVIO_LISTING_EM_CONFLITO,
  gravarEnvioListingAmazon,
} from './envioListingFirestore';
import { FLUXO_LISTING_AMAZON } from './fluxoListing';
import { CAMPO_ENVIO_LISTING_AMAZON } from './vinculoListing';

/** ms — our clock (2027-01-15T08:00:00Z). */
const AGORA = 1_800_000_000_000;
const CONTA = 'conta-envio-listing';
const SKU = 'SKU-1';

/**
 * A test outcome of the price flow's field, shaped like the stock outcome with
 * an offer in place of the quantity: a patch carries its offer, a feed none.
 */
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
const teste = (emMs: number, base = 10): EnvioDeTeste => ({
  via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
  emMs,
  oferta: { base, minimo: base - 1, maximo: base },
  resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
  submissionId: 'sub-p',
  feedId: null,
  problemas: [],
});

const L1: LinkDoEnvioListingAmazon = { produtoId: 'P', linkId: 'l1' };
const L2: LinkDoEnvioListingAmazon = { produtoId: 'P', linkId: 'l2' };
const caminho = (l: LinkDoEnvioListingAmazon) => `produtos/${l.produtoId}/prodAmazon/${l.linkId}`;

let db: FakeDb;
let espiao: ReturnType<typeof loggerEspiao>;

beforeEach(() => {
  db = new FakeDb();
  // A link doc carries a product payload: no read of one may be unmasked.
  db.exigirMascaraEm('prodAmazon');
  espiao = loggerEspiao();
});

/** The stock flow's stored outcome, which a price write-back must never touch. */
const ESTOQUE_GUARDADO = envioDoPatch({ status: 'ACCEPTED', submissionId: 'sub-e' }, AGORA - 5, 7);

/** A link doc with a product payload, the stock flow's outcome and, optionally, the price field. */
function vinculo(l: LinkDoEnvioListingAmazon, envioPrecoAmazon?: unknown) {
  return db.seed(caminho(l), {
    sku: SKU,
    productDataJson: { pesado: 'x'.repeat(64) },
    envioEstoqueAmazon: ESTOQUE_GUARDADO,
    ...(envioPrecoAmazon === undefined ? {} : { envioPrecoAmazon }),
  });
}

const gravarPreco = (envio: EnvioDeTeste, links = [L1], agoraMs = AGORA) =>
  gravarEnvioListingAmazon(
    asDb(db),
    PRECO,
    { contaId: CONTA, sku: SKU, links, envio, agoraMs },
    { logger: espiao.logger },
  );

describe('★ each flow reads and writes ONLY its own field', () => {
  it('★ the price field: ONE getAll masked to envioPrecoAmazon alone, ONE preconditioned update of it alone; the stock outcome is untouched', async () => {
    vinculo(L1);
    vinculo(L2, teste(AGORA - 1));
    const envio = teste(AGORA, 12);
    const r = await gravarPreco(envio, [L1, L2]);
    expect(r).toMatchObject({ gravados: 2, mantidos: 0, ausentes: 0, emConflito: 0 });
    expect(db.leiturasDetalhadas).toEqual([
      { caminho: caminho(L1), via: 'getAll', chamada: 1, mascara: ['envioPrecoAmazon'] },
      { caminho: caminho(L2), via: 'getAll', chamada: 1, mascara: ['envioPrecoAmazon'] },
    ]);
    expect(db.escritas.map((e) => [e.verbo, e.caminho, e.dados, e.comPrecondicao])).toEqual([
      ['update', caminho(L1), { envioPrecoAmazon: envio }, true],
      ['update', caminho(L2), { envioPrecoAmazon: envio }, true],
    ]);
    for (const l of [L1, L2]) {
      expect(db.ler(caminho(l))?.envioEstoqueAmazon).toEqual(ESTOQUE_GUARDADO);
      expect(db.ler(caminho(l))?.productDataJson).toEqual({ pesado: 'x'.repeat(64) });
      expect(db.ler(caminho(l))?.envioPrecoAmazon).toEqual(envio);
    }
    expect(CAMPO_ENVIO_LISTING_AMAZON.preco).toBe('envioPrecoAmazon');
  });

  it('★ NEAR-MISS: a stored stock outcome NEWER than the price outcome does not hold the price write back (each flow its own watermark)', async () => {
    db.seed(caminho(L1), {
      sku: SKU,
      envioEstoqueAmazon: envioDoPatch({ status: 'ACCEPTED' }, AGORA + 60_000, 1),
    });
    const r = await gravarPreco(teste(AGORA));
    expect(r.gravados).toBe(1);
  });

  it('★ NEAR-MISS: the stock binding at the SAME doc reads and writes envioEstoqueAmazon alone, the price field untouched', async () => {
    const preco = teste(AGORA - 1);
    vinculo(L1, preco);
    const envio = envioDoPatch({ status: 'ACCEPTED', submissionId: 'sub-n' }, AGORA, 9);
    await gravarEnvioEstoqueAmazon(
      asDb(db),
      { contaId: CONTA, sku: SKU, links: [L1], envio, agoraMs: AGORA },
      { logger: espiao.logger },
    );
    expect(db.leiturasDetalhadas.map((l) => l.mascara)).toEqual([[CAMPO_ENVIO_ESTOQUE_AMAZON]]);
    expect(db.escritas.map((e) => e.dados)).toEqual([{ envioEstoqueAmazon: envio }]);
    expect(db.ler(caminho(L1))?.envioPrecoAmazon).toEqual(preco);
  });
});

describe('the watermark and the race, at the price field', () => {
  it.each<[string, number, boolean]>([
    ['a stored emMs ONE ms older ⇒ written', -1, true],
    ['NEAR-MISS: an EQUAL stored emMs ⇒ the stored is kept', 0, false],
    ['a stored emMs one ms newer ⇒ dropped', 1, false],
  ])('★ %s', async (_c, diferencaMs, escreve) => {
    vinculo(L1, teste(AGORA + diferencaMs, 3));
    const r = await gravarPreco(teste(AGORA, 7));
    expect(r.gravados).toBe(escreve ? 1 : 0);
    expect(r.mantidos).toBe(escreve ? 0 : 1);
    expect((db.ler(caminho(L1))?.envioPrecoAmazon as EnvioDeTeste).oferta?.base).toBe(
      escreve ? 7 : 3,
    );
  });

  it('★ a NEWER outcome lands between our read and our write ⇒ re-read, re-decide: ours is dropped', async () => {
    vinculo(L1, teste(AGORA - 60_000, 3));
    db.antesDaProximaEscrita(caminho(L1), () => {
      db.seed(caminho(L1), { sku: SKU, envioPrecoAmazon: teste(AGORA + 5_000, 9) });
    });
    const r = await gravarPreco(teste(AGORA, 7));
    expect(r).toMatchObject({ gravados: 0, mantidos: 1, emConflito: 0 });
    expect(db.contagem.chamadasGetAll).toBe(2);
  });

  it('★ a precondition lost on every attempt ⇒ three attempts, ONE warning under the price flow’s own event, no throw', async () => {
    vinculo(L1);
    for (let i = 0; i < MAX_TENTATIVAS_ENVIO_LISTING_AMAZON; i += 1) {
      db.antesDaProximaEscrita(caminho(L1), () => {
        db.seed(caminho(L1), { sku: SKU, outro: i });
      });
    }
    const r = await gravarPreco(teste(AGORA));
    expect(r).toMatchObject({ gravados: 0, emConflito: 1 });
    expect(db.contagem.chamadasGetAll).toBe(3);
    expect(espiao.linhas).toHaveLength(1);
    expect(espiao.linhas[0]).toMatchObject({
      nivel: 'warn',
      mensagem: '[amazon] preco: resultado do envio não gravado no vínculo (precondição perdida)',
      meta: {
        evento: 'preco',
        fluxo: 'preco',
        conta: CONTA,
        fase: 'gravacao-envio',
        motivo: MOTIVO_GRAVACAO_ENVIO_LISTING_EM_CONFLITO,
        sku: SKU,
        via: 'patch',
        resultado: 'aceito',
        vinculos: 1,
        tentativas: 3,
      },
    });
  });

  it('NEAR-MISS: lost twice, then won ⇒ written on the third attempt, no warning', async () => {
    vinculo(L1);
    for (let i = 0; i < 2; i += 1) {
      db.antesDaProximaEscrita(caminho(L1), () => {
        db.seed(caminho(L1), { sku: SKU, outro: i });
      });
    }
    expect((await gravarPreco(teste(AGORA))).gravados).toBe(1);
    expect(espiao.linhas).toEqual([]);
  });

  it('★ the document gone since the read (5) is re-read and re-decided like a lost precondition, never thrown', async () => {
    vinculo(L1);
    db.falharEscrita(caminho(L1), grpc(5, 'NOT_FOUND'));
    const r = await gravarPreco(teste(AGORA));
    expect(r).toMatchObject({ gravados: 0, emConflito: 1 });
    expect(db.contagem.chamadasGetAll).toBe(MAX_TENTATIVAS_ENVIO_LISTING_AMAZON);
  });

  it('★ two link docs with the SAME id under different produtos are two documents: each read and written', async () => {
    const outroProduto: LinkDoEnvioListingAmazon = { produtoId: 'Q', linkId: L1.linkId };
    vinculo(L1);
    vinculo(outroProduto);
    const r = await gravarPreco(teste(AGORA), [L1, outroProduto]);
    expect(r).toMatchObject({ gravados: 2, ausentes: 0 });
    expect(db.leiturasDetalhadas.map((l) => l.caminho)).toEqual([
      caminho(L1),
      caminho(outroProduto),
    ]);
  });

  it('any OTHER Firestore failure is rethrown untouched (rule 6)', async () => {
    vinculo(L1);
    const indisponivel = grpc(14, 'UNAVAILABLE');
    db.falharEscrita(caminho(L1), indisponivel);
    await expect(gravarPreco(teste(AGORA))).rejects.toBe(indisponivel);
  });

  it('a link doc gone is skipped and counted; repeated links are read once; no link reads nothing', async () => {
    vinculo(L1);
    expect(await gravarPreco(teste(AGORA), [L1, L1, L2])).toMatchObject({
      gravados: 1,
      ausentes: 1,
    });
    expect(db.contagem.leituras).toBe(2);
    await expect(gravarPreco(teste(AGORA + 1), [])).resolves.toEqual({
      relogio: null,
      gravados: 0,
      mantidos: 0,
      ausentes: 0,
      emConflito: 0,
    });
    expect(db.contagem.leituras).toBe(2);
  });
});

describe('the gates before any read', () => {
  it('★ an emMs in MICROSECONDS is refused (RangeError), nothing read; NEAR-MISS: 24 h ahead is still written', async () => {
    vinculo(L1);
    await expect(gravarPreco(teste(AGORA * 1000))).rejects.toBeInstanceOf(RangeError);
    expect(db.contagem.leituras).toBe(0);
    await expect(
      gravarPreco(teste(AGORA + ADIANTAMENTO_MAXIMO_ENVIO_LISTING_AMAZON_MS)),
    ).resolves.toMatchObject({ gravados: 1 });
    await expect(
      gravarPreco(teste(AGORA + ADIANTAMENTO_MAXIMO_ENVIO_LISTING_AMAZON_MS + 1)),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('★ NEAR-MISS: an emMs days in the PAST (a report read long after its send) is no unit error: written', async () => {
    vinculo(L1);
    await expect(gravarPreco(teste(AGORA - 3 * 86_400_000))).resolves.toMatchObject({
      gravados: 1,
    });
  });

  it('★ the stock binding names its refusals as its own module, and a refused stock outcome keeps its issues under envioEstoqueAmazon', async () => {
    vinculo(L1);
    const estoque = (envio: ReturnType<typeof envioDoPatch>, links = [L1]) =>
      gravarEnvioEstoqueAmazon(
        asDb(db),
        { contaId: CONTA, sku: SKU, links, envio, agoraMs: AGORA },
        { logger: espiao.logger },
      );
    await expect(estoque(envioDoPatch({ status: 'ACCEPTED' }, AGORA * 1000, 1))).rejects.toThrow(
      new RangeError(
        'envioEstoqueFirestore.ts: emMs à frente do relógio (microssegundos no lugar de ms?)',
      ),
    );
    await expect(
      estoque(envioDoPatch({ status: 'ACCEPTED' }, AGORA, 1), [{ produtoId: 'a/b', linkId: 'l' }]),
    ).rejects.toThrow(
      new RangeError('envioEstoqueFirestore.ts: produtoId ou linkId não é um id de documento'),
    );
    const fora = { ...envioDoPatch({ status: 'ACCEPTED' }, AGORA, 1), quantidade: -1 };
    const erro: unknown = await estoque(fora).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ZodError);
    const caminhos = (erro as ZodError).issues.map((i) => i.path);
    expect(caminhos.length).toBeGreaterThan(0);
    expect(caminhos.every((c) => c[0] === CAMPO_ENVIO_ESTOQUE_AMAZON)).toBe(true);
    expect(db.contagem.leituras).toBe(0);
  });

  it('★ an outcome the field’s schema refuses is a ZodError, nothing read or written', async () => {
    vinculo(L1);
    const fora: EnvioDeTeste = { ...teste(AGORA), oferta: null };
    await expect(gravarPreco(fora)).rejects.toBeInstanceOf(ZodError);
    expect(db.contagem.leituras).toBe(0);
    expect(db.escritas).toEqual([]);
  });

  it.each([
    ['a produto id with a slash', { produtoId: 'a/b', linkId: 'l1' }],
    ['an empty link id', { produtoId: 'P', linkId: '' }],
  ])('%s is a RangeError, nothing read', async (_c, link) => {
    await expect(gravarPreco(teste(AGORA), [link])).rejects.toBeInstanceOf(RangeError);
    expect(db.contagem.leituras).toBe(0);
  });
});

describe('the stock binding binds the shared constants', () => {
  it('the attempts, the warning motivo and the 24-h unit guard are the stock module’s own values', () => {
    expect(MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON).toBe(MAX_TENTATIVAS_ENVIO_LISTING_AMAZON);
    expect(MAX_TENTATIVAS_ENVIO_LISTING_AMAZON).toBe(3);
    expect(MOTIVO_GRAVACAO_ENVIO_EM_CONFLITO).toBe(MOTIVO_GRAVACAO_ENVIO_LISTING_EM_CONFLITO);
    // The stock module's window bound and this guard are one 24-hour figure.
    expect(ADIANTAMENTO_MAXIMO_ENVIO_LISTING_AMAZON_MS).toBe(ADIANTAMENTO_MAXIMO_MS);
    expect(CAMPO_ENVIO_ESTOQUE_AMAZON).toBe(CAMPO_ENVIO_LISTING_AMAZON.estoque);
  });
});
