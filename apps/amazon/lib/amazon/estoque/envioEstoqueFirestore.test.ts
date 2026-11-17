/**
 * The stock outcome write-back (step 12, PR 12-e1), offline against the fake
 * db: the masked read, the strictly-newer watermark (equal keeps the stored),
 * the precondition, the bounded re-read-and-re-decide, the ONE warning, the
 * unit guard, and the clock it answers. The emulator suite
 * (`envioEstoqueFirestore.firestore.test.ts`) proves the race on a real server.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { loggerEspiao } from '../testing/fixtures';
import { ADIANTAMENTO_MAXIMO_MS } from './descobertaEstoque';
import { envioDoFeed, envioDoPatch, envioIncerto } from './envioEstoque';
import {
  CAMPO_ENVIO_ESTOQUE_AMAZON,
  type LinkDoEnvioEstoqueAmazon,
  MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON,
  MOTIVO_GRAVACAO_ENVIO_EM_CONFLITO,
  gravarEnvioEstoqueAmazon,
} from './envioEstoqueFirestore';

/** ms — our clock (2027-01-15T08:00:00Z). */
const AGORA = 1_800_000_000_000;
const CONTA = 'conta-1';
const SKU = 'SKU-1';

let db: FakeDb;
let espiao: ReturnType<typeof loggerEspiao>;

beforeEach(() => {
  db = new FakeDb();
  // A link doc carries a product payload: no read of one may be unmasked.
  db.exigirMascaraEm('prodAmazon');
  espiao = loggerEspiao();
});

const L1: LinkDoEnvioEstoqueAmazon = { produtoId: 'P', linkId: 'l1' };
const L2: LinkDoEnvioEstoqueAmazon = { produtoId: 'P', linkId: 'l2' };
const caminho = (l: LinkDoEnvioEstoqueAmazon) => `produtos/${l.produtoId}/prodAmazon/${l.linkId}`;

/** A link doc with a product payload and, optionally, a stored outcome. */
function vinculo(l: LinkDoEnvioEstoqueAmazon, envioEstoqueAmazon: unknown = null) {
  return db.seed(caminho(l), {
    sku: SKU,
    productDataJson: { pesado: 'x'.repeat(64) },
    envioEstoqueAmazon,
  });
}

const aceito = (emMs: number, quantidade = 5) =>
  envioDoPatch({ status: 'ACCEPTED', submissionId: 'sub-1' }, emMs, quantidade);

const gravar = (envio = aceito(AGORA), links = [L1], agoraMs = AGORA) =>
  gravarEnvioEstoqueAmazon(
    asDb(db),
    { contaId: CONTA, sku: SKU, links, envio, agoraMs },
    { logger: espiao.logger },
  );

const armazenado = (l: LinkDoEnvioEstoqueAmazon) => db.ler(caminho(l))?.envioEstoqueAmazon;

describe('the read, the decision and the write', () => {
  it('★ ONE getAll masked to the outcome field alone; ONE preconditioned update of that field alone', async () => {
    vinculo(L1);
    vinculo(L2);
    const envio = aceito(AGORA);
    const r = await gravar(envio, [L1, L2]);
    expect(r).toMatchObject({ gravados: 2, mantidos: 0, ausentes: 0, emConflito: 0 });
    expect(db.leiturasDetalhadas).toEqual([
      { caminho: caminho(L1), via: 'getAll', chamada: 1, mascara: ['envioEstoqueAmazon'] },
      { caminho: caminho(L2), via: 'getAll', chamada: 1, mascara: ['envioEstoqueAmazon'] },
    ]);
    expect(db.escritas.map((e) => [e.verbo, e.caminho, e.dados, e.comPrecondicao])).toEqual([
      ['update', caminho(L1), { envioEstoqueAmazon: envio }, true],
      ['update', caminho(L2), { envioEstoqueAmazon: envio }, true],
    ]);
    // The product payload is never touched.
    expect(db.ler(caminho(L1))?.productDataJson).toEqual({ pesado: 'x'.repeat(64) });
    expect(CAMPO_ENVIO_ESTOQUE_AMAZON).toBe('envioEstoqueAmazon');
  });

  it.each<[string, number, boolean]>([
    ['a stored emMs ONE ms older ⇒ written', -1, true],
    ['NEAR-MISS: an EQUAL stored emMs ⇒ the stored is kept', 0, false],
    ['a stored emMs one ms newer ⇒ dropped', 1, false],
  ])('★ %s', async (_c, diferencaMs, escreve) => {
    vinculo(L1, aceito(AGORA + diferencaMs, 3));
    const r = await gravar(aceito(AGORA, 7));
    expect(r.gravados).toBe(escreve ? 1 : 0);
    expect(r.mantidos).toBe(escreve ? 0 : 1);
    expect((armazenado(L1) as { quantidade: number }).quantidade).toBe(escreve ? 7 : 3);
    if (!escreve) expect(db.escritas).toEqual([]);
  });

  it('a link with no stored outcome (null or no field) is written', async () => {
    vinculo(L1, null);
    db.seed(caminho(L2), { sku: SKU });
    expect((await gravar(aceito(AGORA), [L1, L2])).gravados).toBe(2);
  });

  it('★ a feed report (submission T) never overwrites a later patch outcome (T + 1)', async () => {
    vinculo(L1, aceito(AGORA + 1, 4));
    const r = await gravar(envioDoFeed([], '50001234567', AGORA));
    expect(r.mantidos).toBe(1);
    expect(armazenado(L1)).toMatchObject({ via: 'patch', quantidade: 4 });
  });

  it('★ a provisional incerto (T) is replaced by its retry’s outcome (T + n)', async () => {
    vinculo(L1, envioIncerto(AGORA, 4));
    await gravar(aceito(AGORA + 30_000, 3));
    expect(armazenado(L1)).toMatchObject({
      resultado: 'aceito',
      quantidade: 3,
      emMs: AGORA + 30_000,
    });
  });

  it('a link doc that no longer exists is skipped and counted, nothing written', async () => {
    vinculo(L1);
    const r = await gravar(aceito(AGORA), [L1, L2]);
    expect(r).toMatchObject({ gravados: 1, ausentes: 1 });
    expect(db.ler(caminho(L2))).toBeUndefined();
  });

  it('repeated links are read once', async () => {
    vinculo(L1);
    await gravar(aceito(AGORA), [L1, L1]);
    expect(db.contagem.leituras).toBe(1);
  });

  it('no link: nothing read, the clock is null', async () => {
    await expect(gravar(aceito(AGORA), [])).resolves.toEqual({
      relogio: null,
      gravados: 0,
      mantidos: 0,
      ausentes: 0,
      emConflito: 0,
    });
    expect(db.contagem.leituras).toBe(0);
  });
});

describe('★ the race: re-read and re-decide, never re-send the decision that lost', () => {
  it('★ a NEWER outcome lands between our read and our write ⇒ re-read, re-decide: ours is dropped', async () => {
    vinculo(L1, aceito(AGORA - 60_000, 3));
    db.antesDaProximaEscrita(caminho(L1), () => {
      db.seed(caminho(L1), { sku: SKU, envioEstoqueAmazon: aceito(AGORA + 5_000, 9) });
    });
    const r = await gravar(aceito(AGORA, 7));
    expect(r).toMatchObject({ gravados: 0, mantidos: 1, emConflito: 0 });
    expect(armazenado(L1)).toMatchObject({ quantidade: 9, emMs: AGORA + 5_000 });
    expect(db.contagem.chamadasGetAll).toBe(2);
  });

  it('NEAR-MISS: an OLDER outcome (or another field) lands meanwhile ⇒ re-read, re-decide: ours is written on the fresh stamp', async () => {
    vinculo(L1, aceito(AGORA - 60_000, 3));
    db.antesDaProximaEscrita(caminho(L1), () => {
      db.seed(caminho(L1), { sku: SKU, envioEstoqueAmazon: aceito(AGORA - 30_000, 2) });
    });
    const r = await gravar(aceito(AGORA, 7));
    expect(r).toMatchObject({ gravados: 1, mantidos: 0 });
    expect(armazenado(L1)).toMatchObject({ quantidade: 7, emMs: AGORA });
  });

  it('★ a precondition lost on every attempt ⇒ exactly three attempts, ONE warning for the whole call, no throw', async () => {
    for (const l of [L1, L2]) {
      vinculo(l, null);
      for (let i = 0; i < MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON; i += 1) {
        db.antesDaProximaEscrita(caminho(l), () => {
          db.seed(caminho(l), { sku: SKU, envioEstoqueAmazon: null, outro: i });
        });
      }
    }
    const r = await gravar(aceito(AGORA), [L1, L2]);
    expect(MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON).toBe(3);
    expect(r).toMatchObject({ gravados: 0, emConflito: 2 });
    expect(db.contagem.chamadasGetAll).toBe(3);
    expect(db.escritas).toEqual([]);
    const avisos = espiao.linhas.filter((l) => l.nivel === 'warn');
    expect(avisos).toHaveLength(1);
    expect(espiao.linhas).toHaveLength(1);
    expect(avisos[0]?.meta).toMatchObject({
      evento: 'estoque',
      conta: CONTA,
      motivo: MOTIVO_GRAVACAO_ENVIO_EM_CONFLITO,
      vinculos: 2,
      tentativas: 3,
    });
  });

  it('★ ONE link doc losing every attempt (the common case: one link per SKU) ⇒ exactly ONE warning naming it, no throw', async () => {
    vinculo(L1, null);
    for (let i = 0; i < MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON; i += 1) {
      db.antesDaProximaEscrita(caminho(L1), () => {
        db.seed(caminho(L1), { sku: SKU, envioEstoqueAmazon: null, outro: i });
      });
    }
    const r = await gravar(aceito(AGORA), [L1]);
    expect(r).toMatchObject({ gravados: 0, emConflito: 1 });
    expect(espiao.linhas).toHaveLength(1);
    expect(espiao.linhas[0]).toMatchObject({
      nivel: 'warn',
      meta: { motivo: MOTIVO_GRAVACAO_ENVIO_EM_CONFLITO, vinculos: 1, tentativas: 3 },
    });
  });

  it('NEAR-MISS: a precondition lost twice, then won ⇒ written on the third attempt, no warning', async () => {
    vinculo(L1, null);
    for (let i = 0; i < 2; i += 1) {
      db.antesDaProximaEscrita(caminho(L1), () => {
        db.seed(caminho(L1), { sku: SKU, envioEstoqueAmazon: null, outro: i });
      });
    }
    const r = await gravar(aceito(AGORA));
    expect(r).toMatchObject({ gravados: 1, emConflito: 0 });
    expect(espiao.linhas).toEqual([]);
  });

  it('a link deleted between our read and our write ⇒ re-read finds it gone: skipped, no warning', async () => {
    vinculo(L1, null);
    db.antesDaProximaEscrita(caminho(L1), () => {
      db.apagar(caminho(L1));
    });
    const r = await gravar(aceito(AGORA));
    expect(r).toMatchObject({ gravados: 0, ausentes: 1, emConflito: 0 });
    expect(espiao.linhas).toEqual([]);
  });

  it('only the loser is re-read: a sibling that landed is not read again', async () => {
    vinculo(L1, null);
    vinculo(L2, null);
    db.antesDaProximaEscrita(caminho(L2), () => {
      db.seed(caminho(L2), { sku: SKU, envioEstoqueAmazon: null, outro: 1 });
    });
    await gravar(aceito(AGORA), [L1, L2]);
    expect(db.leiturasDetalhadas.map((l) => [l.caminho, l.chamada])).toEqual([
      [caminho(L1), 1],
      [caminho(L2), 1],
      [caminho(L2), 2],
    ]);
  });

  it('any OTHER Firestore failure is rethrown untouched (rule 6)', async () => {
    vinculo(L1, null);
    const indisponivel = grpc(14, 'UNAVAILABLE');
    db.falharEscrita(caminho(L1), indisponivel);
    await expect(gravar(aceito(AGORA))).rejects.toBe(indisponivel);
  });
});

describe('the clock it answers', () => {
  it('★ the read time of the LAST link-doc read: a retry’s, never the lost attempt’s', async () => {
    const semeado = vinculo(L1, null);
    let concorrente: ReturnType<FakeDb['seed']> | undefined;
    db.antesDaProximaEscrita(caminho(L1), () => {
      concorrente = db.seed(caminho(L1), { sku: SKU, envioEstoqueAmazon: null, outro: 1 });
    });
    const r = await gravar(aceito(AGORA));
    expect(r.gravados).toBe(1);
    // The fake's read time is the latest stamp issued before the read: the
    // first read saw the seed, the retry saw the concurrent writer's commit.
    expect(concorrente).toBeDefined();
    expect(r.relogio?.isEqual(concorrente as never)).toBe(true);
    expect(r.relogio?.isEqual(semeado as never)).toBe(false);
  });

  it('a call with no retry answers its one read’s time', async () => {
    const semeado = vinculo(L1, null);
    const r = await gravar(aceito(AGORA));
    expect(r.relogio?.isEqual(semeado as never)).toBe(true);
  });
});

describe('the units', () => {
  it('★ an emMs in MICROSECONDS is refused before anything is read', async () => {
    vinculo(L1, null);
    await expect(gravar(aceito(AGORA * 1000))).rejects.toBeInstanceOf(RangeError);
    expect(db.contagem.leituras).toBe(0);
    expect(armazenado(L1)).toBeNull();
  });

  it('NEAR-MISS: an emMs up to 24 h ahead of the caller’s clock (skew) is still written; one ms more is refused', async () => {
    vinculo(L1, null);
    await expect(gravar(aceito(AGORA + ADIANTAMENTO_MAXIMO_MS))).resolves.toMatchObject({
      gravados: 1,
    });
    await expect(gravar(aceito(AGORA + ADIANTAMENTO_MAXIMO_MS + 1))).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it.each([
    ['a produto id with a slash', { produtoId: 'a/b', linkId: 'l1' }],
    ['an empty link id', { produtoId: 'P', linkId: '' }],
  ])('%s is a RangeError, nothing read', async (_c, link) => {
    await expect(gravar(aceito(AGORA), [link])).rejects.toBeInstanceOf(RangeError);
    expect(db.contagem.leituras).toBe(0);
  });
});
