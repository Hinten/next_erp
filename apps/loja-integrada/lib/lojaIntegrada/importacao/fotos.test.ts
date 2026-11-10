/**
 * The product import's photos (`fotos.ts`) on the fake Firestore and the fake bucket, through the
 * REAL shared uploader: when a produto takes pictures and which, one download per unit, the
 * `800x800` fallback as a unit of its own, every refusal, the upload's deadline, the write on a
 * read taken after the uploads (our landed write recognised, an operator's photo kept, the third
 * loss), no bucket, the cursor across units, and Simular.
 *
 * Every sameness decision is pinned as a PAIR (the equal case and the near-miss). Nothing reaches
 * the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file; the CDN is a
 * scripted reader, or the package's real reader over a stubbed transport, never a host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  type DesfechoImagemLi,
  type FormaImagemLi,
  type LeitorCdnLi,
  criarLeitorCdnLi,
} from '@delfrance/integrations-loja-integrada';
import {
  ACAO_IMPORTACAO_LI,
  type CursorFotosLi,
  DESFECHO_FOTOS_DO_PRODUTO_LI,
  FILETYPE,
  FOTOS_IMPORTACAO_LI,
  type Foto,
  type ImagemProdutoLi,
  MOTIVO_FOTO_RECUSADA_LI,
  PENDENCIA_IMPORTACAO_LI,
  buildFotoRefs,
  cursorFotosLiSchema,
  deriveFotosArquivosIds,
  productArquivoId,
  productOriginalPath,
} from '@delfrance/schemas';

import { FakeBucket, asBucket } from '../testing/fakeBucket';
import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { detalheLi, linhaProdutoLi, paiLi, vistaDetalhadaLi } from '../testing/produtosLi';
import {
  type AlvoDeFotosLi,
  type CandidatoAFotosLi,
  type DepsFotosLi,
  MAX_TENTATIVAS_FOTOS_LI,
  type PassoFotosLi,
  TIPO_PASSO_FOTOS_LI,
  contarFotosSimuladasLi,
  criarGuardarFotoLi,
  cursorInicialDeFotosLi,
  deveImportarFotosLi,
  executarUnidadeDeFotoLi,
  hashDaFotoLi,
  mesmoConjuntoDeImagensLi,
  planejarAlvosDeFotosLi,
  semFotosNoErpLi,
  unidadeDaFotoLi,
} from './fotos';
import { PRAZO_UPLOAD_LI_MS } from './orcamento';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('fotos.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ------------------------------- fixtures --------------------------------- */

const CONTA = 'conta-fotos-1';
const PRODUTO = 'erp-fotos-1';
const FILHO = 'erp-fotos-filho-1';
const P = `produtos/${PRODUTO}`;
const PF = `produtos/${FILHO}`;

/** A PNG: its magic number, then `n` so every picture has its own bytes (and its own hash). */
function png(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n + 1]);
}

/** A JPEG: its magic number, then `n`. */
function jpeg(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n]);
}

function imagem(id: number, caminho = `1000/produto/${String(id)}/foto.jpg`): ImagemProdutoLi {
  return { id, caminho, principal: false, posicao: null };
}

const ok = (
  bytes: Uint8Array,
  tipo: 'image/png' | 'image/jpeg' = 'image/png',
): DesfechoImagemLi => ({
  resultado: 'ok',
  status: 200,
  tipo,
  bytes,
});

interface ChamadaCdn {
  readonly caminho: string;
  readonly forma: FormaImagemLi;
}

/**
 * A scripted CDN reader: one answer per `<forma> <caminho>`, recorded call by call. An unscripted
 * picture THROWS — a unit that fetched one the test did not plan fails loudly.
 */
function cdnFake(roteiro: Readonly<Record<string, DesfechoImagemLi>>) {
  const chamadas: ChamadaCdn[] = [];
  const cdn: LeitorCdnLi = {
    baixarImagemLi: (caminho, { forma }) => {
      const c = String(caminho);
      chamadas.push({ caminho: c, forma });
      const resposta = roteiro[`${forma} ${c}`];
      if (resposta === undefined) {
        return Promise.reject(new Error(`fotos.test: imagem fora do roteiro (${forma} ${c})`));
      }
      return Promise.resolve(resposta);
    },
  };
  return { cdn, chamadas };
}

const orig = (i: ImagemProdutoLi) => `original ${i.caminho}`;
const reduzida = (i: ImagemProdutoLi) => `800x800 ${i.caminho}`;

interface Montagem {
  readonly db: FakeDb;
  readonly bucket: FakeBucket;
  readonly deps: DepsFotosLi;
  readonly chamadas: ChamadaCdn[];
  readonly esperas: number[];
  readonly warn: ReturnType<typeof vi.fn>;
}

function montar(
  roteiro: Readonly<Record<string, DesfechoImagemLi>>,
  o: { readonly semBucket?: boolean; readonly db?: FakeDb } = {},
): Montagem {
  const db = o.db ?? new FakeDb();
  const bucket = new FakeBucket();
  const { cdn, chamadas } = cdnFake(roteiro);
  const esperas: number[] = [];
  const warn = vi.fn();
  const deps: DepsFotosLi = {
    db: asDb(db),
    cdn,
    guardar:
      o.semBucket === true
        ? null
        : criarGuardarFotoLi({ db: asDb(db), bucket: asBucket(bucket), contaId: CONTA }),
    esperar: (ms) => {
      esperas.push(ms);
      return Promise.resolve();
    },
    agoraMs: () => AGORA_MS,
    logger: { warn },
  };
  return { db, bucket, deps, chamadas, esperas, warn };
}

/** A target for the root produto with `imagens`. */
function alvoRaiz(imagens: readonly ImagemProdutoLi[], produtoId = PRODUTO): AlvoDeFotosLi {
  return { produtoId, liId: null, imagens };
}

/** The produto's ref, through the collection's handle (another writer's writes go through it). */
function refProduto(db: FakeDb) {
  return produtoCollection.docRef(asDb(db), {}, PRODUTO);
}

/** A stored produto with every photo field absent, plus `over`. */
function semeiaProduto(db: FakeDb, caminho = P, over: DocData = {}): void {
  db.seed(caminho, { nome: 'Produto neutro', sku: 'SKU-NEUTRO', ...over });
}

/** A photo already on a produto (the operator's), by a hash no picture of these tests has. */
function fotoDoOperador(produtoId = PRODUTO): Foto {
  return {
    ...buildFotoRefs(produtoId, 'f'.repeat(128)),
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  };
}

/** The `Foto` the import writes for `bytes` on `produtoId`. */
function fotoEsperada(produtoId: string, bytes: Uint8Array): Foto {
  return {
    ...buildFotoRefs(produtoId, hashDaFotoLi(bytes)),
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  };
}

/**
 * Another writer renames the produto right before each of our next `n` writes on it, so each of
 * them loses its precondition. Chained: each hook queues the next one only AFTER its own write
 * (a hook's write would otherwise run the next hook itself, and every loss would land at once).
 */
function perderEscritas(db: FakeDb, n: number, i = 0): void {
  if (i >= n) return;
  db.antesDaProximaEscrita(P, async () => {
    await refProduto(db).update({ nome: `Outro ${String(i)}` });
    perderEscritas(db, n, i + 1);
  });
}

/**
 * Run units from `cursor` until the family is done (or a unit stops), the cursor round-tripped
 * through JSON and the schema between units — exactly as a checkpoint stores and reads it back.
 */
async function rodarAteOFim(
  m: Montagem,
  alvos: readonly AlvoDeFotosLi[],
  cursor: CursorFotosLi | null = null,
): Promise<PassoFotosLi[]> {
  const passos: PassoFotosLi[] = [];
  let atual = cursor;
  for (let i = 0; i < 200; i += 1) {
    const passo = await executarUnidadeDeFotoLi(m.deps, alvos, atual);
    passos.push(passo);
    if (passo.tipo !== TIPO_PASSO_FOTOS_LI.progresso) return passos;
    atual = cursorFotosLiSchema.parse(JSON.parse(JSON.stringify(passo.cursor)));
  }
  throw new Error('fotos.test: a família não terminou');
}

function ultimo(passos: readonly PassoFotosLi[]): PassoFotosLi {
  const p = passos.at(-1);
  if (p === undefined) throw new Error('fotos.test: nenhum passo');
  return p;
}

function concluido(passos: readonly PassoFotosLi[]) {
  const p = ultimo(passos);
  if (p.tipo !== TIPO_PASSO_FOTOS_LI.concluido) throw new Error(`esperava concluido: ${p.tipo}`);
  return p.resultado;
}

/* --------------------------------- when ----------------------------------- */

describe('when: complete + "only onto a produto with none"', () => {
  it('deveImportarFotosLi: only completar AND soSemFotos', () => {
    const completar = ACAO_IMPORTACAO_LI.completar;
    expect(deveImportarFotosLi({ acao: completar, fotos: FOTOS_IMPORTACAO_LI.soSemFotos })).toBe(
      true,
    );
    // NEAR-MISSES: either option off.
    expect(deveImportarFotosLi({ acao: completar, fotos: FOTOS_IMPORTACAO_LI.naoImportar })).toBe(
      false,
    );
    expect(
      deveImportarFotosLi({
        acao: ACAO_IMPORTACAO_LI.soVincular,
        fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      }),
    ).toBe(false);
  });

  it('EQUAL: absent, null and [] are "no photo"', () => {
    expect(semFotosNoErpLi({})).toBe(true);
    expect(semFotosNoErpLi({ fotos: null })).toBe(true);
    expect(semFotosNoErpLi({ fotos: [] })).toBe(true);
  });

  it.each([
    ['one photo', [{ arquivoOuterRef: 'arquivos/x' }]],
    ['an empty text', ''],
    ['a map', {}],
    ['zero', 0],
    ['false', false],
  ])('⚠️ NEAR-MISS: %s is a value, never written over', (_nome, fotos) => {
    expect(semFotosNoErpLi({ fotos })).toBe(false);
  });

  it('the unit it costs is the 52 s `foto` row', () => {
    expect(unidadeDaFotoLi()).toBe('foto');
  });
});

/* --------------------------------- which ---------------------------------- */

describe('which: the detail’s pictures, a variation’s only when they are not the parent’s', () => {
  const raiz = (imagens: readonly ImagemProdutoLi[]): CandidatoAFotosLi => ({
    produtoId: PRODUTO,
    liId: null,
    imagens,
  });
  const filho = (imagens: readonly ImagemProdutoLi[], produtoId = FILHO): CandidatoAFotosLi => ({
    produtoId,
    liId: 9101,
    imagens,
  });

  it('EQUAL: a variation with the parent’s SET (another order) gets none; the parent gets them', () => {
    const alvos = planejarAlvosDeFotosLi({
      raiz: raiz([imagem(1), imagem(2)]),
      filhos: [filho([imagem(2), imagem(1)])],
    });
    expect(alvos.map((a) => a.produtoId)).toEqual([PRODUTO]);
    expect(mesmoConjuntoDeImagensLi([imagem(2), imagem(1)], new Set([1, 2]))).toBe(true);
  });

  it.each([
    ['one id different', [1, 3]],
    ['a subset', [1]],
    ['a superset', [1, 2, 3]],
  ])('⚠️ NEAR-MISS: a variation whose set is %s gets its own', (_nome, ids) => {
    const alvos = planejarAlvosDeFotosLi({
      raiz: raiz([imagem(1), imagem(2)]),
      filhos: [filho(ids.map((id) => imagem(id)))],
    });
    expect(alvos.map((a) => a.produtoId)).toEqual([PRODUTO, FILHO]);
    expect(
      mesmoConjuntoDeImagensLi(
        ids.map((id) => imagem(id)),
        new Set([1, 2]),
      ),
    ).toBe(false);
  });

  it('a produto with no picture is no target: a variation with none, a root with none', () => {
    expect(
      planejarAlvosDeFotosLi({ raiz: raiz([imagem(1)]), filhos: [filho([])] }).map(
        (a) => a.produtoId,
      ),
    ).toEqual([PRODUTO]);
    // A root with none: a variation with pictures of its own still gets them.
    expect(
      planejarAlvosDeFotosLi({ raiz: raiz([]), filhos: [filho([imagem(5)])] }).map(
        (a) => a.produtoId,
      ),
    ).toEqual([FILHO]);
  });

  it('one produto named twice is a caller’s bug: RangeError', () => {
    expect(() =>
      planejarAlvosDeFotosLi({ raiz: raiz([imagem(1)]), filhos: [filho([imagem(2)], PRODUTO)] }),
    ).toThrow(RangeError);
  });

  it('the order is the shared reader’s: principal first, posicao ascending, null posicao after every number, then the store’s order', async () => {
    // A wire detail, read through the SAME reader the job stores details with.
    const detalhe = vistaDetalhadaLi(
      detalheLi(linhaProdutoLi(9001), null, {
        imagem_principal: { id: 40, caminho: 'p/40.jpg', principal: true, posicao: 9 },
        imagens: [
          { id: 10, caminho: 'p/10.jpg', principal: false, posicao: null },
          { id: 20, caminho: 'p/20.jpg', principal: false, posicao: '2' },
          { id: 30, caminho: 'p/30.jpg', principal: false, posicao: 1 },
          { id: 50, caminho: 'p/50.jpg', principal: false, posicao: null },
          { id: 40, caminho: 'p/40.jpg', principal: false, posicao: 9 },
        ],
      }),
    );
    const [alvo] = planejarAlvosDeFotosLi({
      raiz: { produtoId: PRODUTO, liId: null, imagens: detalhe.imagens },
      filhos: [],
    });
    if (alvo === undefined) throw new Error('sem alvo');
    expect(alvo.imagens.map((i) => i.id)).toEqual([40, 30, 20, 10, 50]);

    const bytes = new Map(alvo.imagens.map((i, n) => [i.id, png(10 * n)]));
    const m = montar(
      Object.fromEntries(alvo.imagens.map((i) => [orig(i), ok(bytes.get(i.id) ?? png(0))])),
    );
    semeiaProduto(m.db);
    const resultado = concluido(await rodarAteOFim(m, [alvo]));
    // Downloaded, and stored on the produto, in exactly that order.
    expect(m.chamadas.map((c) => c.caminho)).toEqual([
      'p/40.jpg',
      'p/30.jpg',
      'p/20.jpg',
      'p/10.jpg',
      'p/50.jpg',
    ]);
    expect(m.db.ler(P)?.fotos).toEqual(
      alvo.imagens.map((i) => fotoEsperada(PRODUTO, bytes.get(i.id) ?? png(0))),
    );
    expect(resultado.gravadas).toBe(5);
  });
});

/* ------------------------------- the units -------------------------------- */

describe('one picture per unit, stored through the shared uploader', () => {
  it('two pictures: two units, each one download; the produto written ONCE after the last', async () => {
    const a = imagem(701);
    const b = imagem(702, '1000/produto/702/foto.png');
    const bytesA = png(1);
    const bytesB = jpeg(2);
    const m = montar({ [orig(a)]: ok(bytesA), [orig(b)]: ok(bytesB, 'image/jpeg') });
    semeiaProduto(m.db);
    const passos = await rodarAteOFim(m, [alvoRaiz([a, b])]);

    expect(passos.map((p) => p.tipo)).toEqual(['progresso', 'concluido']);
    expect(passos.map((p) => ('downloads' in p ? p.downloads : null))).toEqual([1, 1]);
    // The pacer before EVERY download; the ORIGINAL form only.
    expect(m.esperas).toEqual([2000, 2000]);
    expect(m.chamadas.map((c) => c.forma)).toEqual(['original', 'original']);

    // The objects: content-addressed by sha-512, the extension of what the BYTES are — a PNG
    // served under a `.jpg` caminho is stored as `.png`.
    const hashA = hashDaFotoLi(bytesA);
    const hashB = hashDaFotoLi(bytesB);
    expect(hashA).toMatch(/^[0-9a-f]{128}$/);
    expect(m.bucket.caminhos).toEqual([
      productOriginalPath(PRODUTO, hashA, 'png'),
      productOriginalPath(PRODUTO, hashB, 'jpeg'),
    ]);
    expect(m.bucket.salvos.map((s) => [...s.bytes])).toEqual([[...bytesA], [...bytesB]]);
    expect(m.bucket.salvos.map((s) => s.contentType)).toEqual(['image/png', 'image/jpeg']);

    // The arquivos documents: the product-scoped id, resized later, the store image id of THIS conta.
    const arquivoA = m.db.ler(`arquivos/${productArquivoId(PRODUTO, hashA)}`);
    expect(arquivoA).toMatchObject({
      contentType: 'image/png',
      filetype: FILETYPE.image,
      resizeState: 'pending',
      externalIds: [{ externalId: '701', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    expect(arquivoA?.url).toEqual(expect.stringContaining(m.bucket.name));

    // ONE guarded write on the produto: the pictures in plan order, their ids, the job's clock.
    const escritas = m.db.escritasEm(P);
    expect(escritas).toHaveLength(1);
    const fotos = [fotoEsperada(PRODUTO, bytesA), fotoEsperada(PRODUTO, bytesB)];
    expect(m.db.ler(P)).toEqual({
      nome: 'Produto neutro',
      sku: 'SKU-NEUTRO',
      fotos,
      fotosArquivosIds: deriveFotosArquivosIds(fotos),
      ultimaModificacao: AGORA_MS,
    });
    expect(concluido(passos)).toEqual({
      produtos: [
        {
          produtoId: PRODUTO,
          liId: null,
          desfecho: DESFECHO_FOTOS_DO_PRODUTO_LI.importadas,
          fotos: 2,
        },
      ],
      gravadas: 2,
      pendencias: [],
    });
  });

  it('a produto with ONE photo gets none: nothing downloaded, stored or written', async () => {
    const a = imagem(711);
    const m = montar({ [orig(a)]: ok(png(1)) });
    semeiaProduto(m.db, P, { fotos: [fotoDoOperador()] });
    const antes = m.db.ler(P);
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.chamadas).toEqual([]);
    expect(m.esperas).toEqual([]);
    expect(m.bucket.salvos).toEqual([]);
    expect(m.db.escritas).toEqual([]);
    expect(m.db.ler(P)).toEqual(antes);
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.comFotos);
    expect(resultado.gravadas).toBe(0);
  });

  it('a second run over a produto this import already filled adds nothing (never twice)', async () => {
    const a = imagem(712);
    const m = montar({ [orig(a)]: ok(png(3)) });
    semeiaProduto(m.db);
    concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    const depois = m.db.ler(P);
    const outra = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(outra.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.comFotos);
    expect(m.chamadas).toHaveLength(1);
    expect(m.db.ler(P)).toEqual(depois);
  });

  it('a produto gone when its pictures start: `ausente`, nothing fetched', async () => {
    const a = imagem(713);
    const m = montar({});
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.chamadas).toEqual([]);
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.ausente);
    expect(resultado.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId: null, referencias: [PRODUTO] },
    ]);
  });

  it('a variation target: its own produto, the pendências name its store id', async () => {
    const a = imagem(721);
    const m = montar({ [orig(a)]: { resultado: 'nao-encontrada', status: 404 } });
    semeiaProduto(m.db, PF);
    const resultado = concluido(
      await rodarAteOFim(m, [{ produtoId: FILHO, liId: 9101, imagens: [a] }]),
    );
    expect(resultado.pendencias).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.fotoRecusada,
        liId: 9101,
        referencias: ['721', 'nao-encontrada'],
      },
    ]);
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.nenhumaAceita);
    // Every picture refused: nothing to write.
    expect(m.db.escritasEm(PF)).toEqual([]);
  });

  it('several produtos: a skipped one costs a read and no download; the next one is the same unit', async () => {
    const a = imagem(731);
    const b = imagem(732);
    const m = montar({ [orig(b)]: ok(png(7)) });
    semeiaProduto(m.db, P, { fotos: [fotoDoOperador()] });
    semeiaProduto(m.db, PF);
    const passos = await rodarAteOFim(m, [
      alvoRaiz([a]),
      { produtoId: FILHO, liId: 9101, imagens: [b] },
    ]);
    // The first unit skipped the produto with a photo and then downloaded the variation's picture.
    expect(passos.map((p) => p.tipo)).toEqual(['concluido']);
    expect(m.chamadas.map((c) => c.caminho)).toEqual([b.caminho]);
    expect(concluido(passos).produtos.map((p) => [p.produtoId, p.desfecho, p.fotos])).toEqual([
      [PRODUTO, 'com-fotos', 0],
      [FILHO, 'importadas', 1],
    ]);
  });
});

describe('`muito-grande`: the 800x800 form, in a unit of its own', () => {
  it('the original over the cap ⇒ the unit stops there; the NEXT unit fetches 800x800 and stores it', async () => {
    const a = imagem(741);
    const reduzidos = png(9);
    const m = montar({
      [orig(a)]: { resultado: 'muito-grande', status: 200 },
      [reduzida(a)]: ok(reduzidos),
    });
    semeiaProduto(m.db);
    const primeiro = await executarUnidadeDeFotoLi(m.deps, [alvoRaiz([a])], null);
    expect(primeiro).toEqual({
      tipo: 'progresso',
      downloads: 1,
      cursor: { ...cursorInicialDeFotosLi([alvoRaiz([a])]), reduzida: true },
    });
    // Nothing stored, nothing written in the original's unit.
    expect(m.bucket.salvos).toEqual([]);
    expect(m.db.escritasEm(P)).toEqual([]);

    if (primeiro.tipo !== 'progresso') throw new Error('progresso');
    const segundo = await rodarAteOFim(m, [alvoRaiz([a])], primeiro.cursor);
    expect(m.chamadas.map((c) => c.forma)).toEqual(['original', '800x800']);
    expect(m.esperas).toEqual([2000, 2000]);
    expect(m.bucket.salvos.map((s) => [...s.bytes])).toEqual([[...reduzidos]]);
    expect(m.db.ler(P)?.fotos).toEqual([fotoEsperada(PRODUTO, reduzidos)]);
    expect(concluido(segundo).pendencias).toEqual([]);
  });

  it('⚠️ NEAR-MISS: the 800x800 over the cap too ⇒ refused `muito-grande`, and the next picture still comes', async () => {
    const a = imagem(742);
    const b = imagem(743);
    const m = montar({
      [orig(a)]: { resultado: 'muito-grande', status: 200 },
      [reduzida(a)]: { resultado: 'muito-grande', status: 200 },
      [orig(b)]: ok(png(4)),
    });
    semeiaProduto(m.db);
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a, b])]));
    expect(m.chamadas.map((c) => `${c.forma} ${c.caminho}`)).toEqual([
      orig(a),
      reduzida(a),
      orig(b),
    ]);
    expect(resultado.pendencias).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.fotoRecusada,
        liId: null,
        referencias: ['742', 'muito-grande'],
      },
    ]);
    expect(m.db.ler(P)?.fotos).toEqual([fotoEsperada(PRODUTO, png(4))]);
  });
});

describe('every other outcome refuses THAT picture, and the next one is still processed', () => {
  const recusas: readonly (readonly [string, DesfechoImagemLi])[] = [
    [MOTIVO_FOTO_RECUSADA_LI.caminhoInvalido, { resultado: 'caminho-invalido' }],
    [
      MOTIVO_FOTO_RECUSADA_LI.redirecionamento,
      { resultado: 'redirecionamento', status: 302, host: 'outro.invalid' },
    ],
    [MOTIVO_FOTO_RECUSADA_LI.naoEncontrada, { resultado: 'nao-encontrada', status: 404 }],
    [MOTIVO_FOTO_RECUSADA_LI.http, { resultado: 'http', status: 503 }],
    [MOTIVO_FOTO_RECUSADA_LI.http, { resultado: 'http', status: 401 }],
    [MOTIVO_FOTO_RECUSADA_LI.http, { resultado: 'http', status: 403 }],
    [MOTIVO_FOTO_RECUSADA_LI.http, { resultado: 'http', status: 429 }],
    [MOTIVO_FOTO_RECUSADA_LI.naoEImagem, { resultado: 'nao-e-imagem', status: 200 }],
  ];

  it.each(recusas)(
    '%s ⇒ foto-recusada (informational), the next picture stored',
    async (motivo, resposta) => {
      const a = imagem(751);
      const b = imagem(752);
      const m = montar({ [orig(a)]: resposta, [orig(b)]: ok(png(5)) });
      semeiaProduto(m.db);
      const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a, b])]));
      expect(resultado.pendencias).toEqual([
        { codigo: PENDENCIA_IMPORTACAO_LI.fotoRecusada, liId: null, referencias: ['751', motivo] },
      ]);
      expect(m.db.ler(P)?.fotos).toEqual([fotoEsperada(PRODUTO, png(5))]);
      // Only the original was asked: the 800x800 is `muito-grande`'s alone.
      expect(m.chamadas.map((c) => c.forma)).toEqual(['original', 'original']);
      // A CDN 401/403/429 parks nothing: the only writes are the arquivo and the produto.
      expect(m.db.escritas.every((e) => e.caminho.startsWith('arquivos/') || e.caminho === P)).toBe(
        true,
      );
      // ONE line per refusal: ids, the outcome, a status, a redirect's HOST — never a URL or a path.
      expect(m.warn).toHaveBeenCalledTimes(1);
      const [, campos] = m.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(campos).toMatchObject({
        produtoId: PRODUTO,
        imagemId: 751,
        resultado: resposta.resultado,
      });
      expect(JSON.stringify(campos)).not.toContain(a.caminho);
      expect(JSON.stringify(campos)).not.toContain('http://');
    },
  );

  it('a CDN transport failure is no outcome: it propagates (the task retries the unit)', async () => {
    const a = imagem(753);
    const m = montar({});
    semeiaProduto(m.db);
    const falha = new TypeError('fotos.test: conexão caiu');
    const deps: DepsFotosLi = {
      ...m.deps,
      cdn: { baixarImagemLi: () => Promise.reject(falha) },
    };
    await expect(executarUnidadeDeFotoLi(deps, [alvoRaiz([a])], null)).rejects.toBe(falha);
    expect(m.db.escritas).toEqual([]);
  });
});

/* ------------------------------ the write --------------------------------- */

describe('the write: ONE guarded update on a read taken after the uploads', () => {
  it('a produto that gains a photo between the read and the write keeps ONLY the operator’s', async () => {
    const a = imagem(761);
    const m = montar({ [orig(a)]: ok(png(6)) });
    semeiaProduto(m.db);
    const operador = fotoDoOperador();
    // The operator's upload lands right before our write: our precondition is stale.
    m.db.antesDaProximaEscrita(P, async () => {
      await refProduto(m.db).update({ fotos: [operador] });
    });
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.db.ler(P)?.fotos).toEqual([operador]);
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.perdeu);
    expect(resultado.gravadas).toBe(0);
    // Ours stays an UNREFERENCED arquivo: the orphan reconcile's to reclaim.
    expect(m.db.ler(`arquivos/${productArquivoId(PRODUTO, hashDaFotoLi(png(6)))}`)).toBeDefined();
    // No pendência: keeping the operator's photo is the rule working.
    expect(resultado.pendencias).toEqual([]);
  });

  it('⚠️ NEAR-MISS: another writer that adds NO photo only costs a retry, and ours lands', async () => {
    const a = imagem(762);
    const m = montar({ [orig(a)]: ok(png(7)) });
    semeiaProduto(m.db);
    m.db.antesDaProximaEscrita(P, async () => {
      await refProduto(m.db).update({ nome: 'Renomeado' });
    });
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.db.ler(P)).toMatchObject({
      nome: 'Renomeado',
      fotos: [fotoEsperada(PRODUTO, png(7))],
    });
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.importadas);
  });

  it('the write is guarded by a read taken AFTER the upload: an edit landing DURING the upload costs no retry — ONE guarded write attempt, and ours lands', async () => {
    const a = imagem(773);
    const m = montar({ [orig(a)]: ok(png(26)) });
    semeiaProduto(m.db);
    const guardar = m.deps.guardar;
    if (guardar === null) throw new Error('fotos.test: a montagem tem um bucket');
    let tentativas = 0;
    const deps: DepsFotosLi = {
      ...m.deps,
      // Another writer's edit (no photo) lands while the picture is stored — after the produto's
      // first read, before the read the write is guarded by.
      guardar: async (foto) => {
        await guardar(foto);
        await refProduto(m.db).update({ nome: 'Editado durante o envio' });
        // From here on, every guarded write ATTEMPT on the produto is counted (none of them writes).
        for (let i = 0; i < MAX_TENTATIVAS_FOTOS_LI; i += 1) {
          m.db.antesDaProximaEscrita(P, () => {
            tentativas += 1;
          });
        }
      },
    };
    const resultado = concluido(await rodarAteOFim({ ...m, deps }, [alvoRaiz([a])]));
    expect(tentativas).toBe(1);
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.importadas);
    expect(m.db.ler(P)).toMatchObject({
      nome: 'Editado durante o envio',
      fotos: [fotoEsperada(PRODUTO, png(26))],
    });
  });

  it('EQUAL: our own write landed with its reply lost (a 9) ⇒ counted as written, never redone', async () => {
    const a = imagem(763);
    const m = montar({ [orig(a)]: ok(png(8)) });
    semeiaProduto(m.db);
    m.db.respostaPerdidaNaProximaEscrita(P);
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.db.escritasEm(P)).toHaveLength(1);
    expect(resultado.produtos[0]).toMatchObject({ desfecho: 'importadas', fotos: 1 });
  });

  it('⚠️ NEAR-MISS: a stored list that differs from ours in ONE picture is not ours ⇒ `perdeu`', async () => {
    const a = imagem(764);
    const b = imagem(765);
    const m = montar({ [orig(a)]: ok(png(11)), [orig(b)]: ok(png(12)) });
    semeiaProduto(m.db);
    // Someone wrote our first picture and ANOTHER second one.
    m.db.antesDaProximaEscrita(P, async () => {
      await refProduto(m.db).update({ fotos: [fotoEsperada(PRODUTO, png(11)), fotoDoOperador()] });
    });
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a, b])]));
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.perdeu);
    expect(m.db.ler(P)?.fotos).toEqual([fotoEsperada(PRODUTO, png(11)), fotoDoOperador()]);
  });

  it(`still no photo after ${String(MAX_TENTATIVAS_FOTOS_LI)} lost writes ⇒ conflito-de-escrita, never forced`, async () => {
    const a = imagem(766);
    const m = montar({ [orig(a)]: ok(png(13)) });
    semeiaProduto(m.db);
    perderEscritas(m.db, MAX_TENTATIVAS_FOTOS_LI);
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.db.ler(P)?.fotos).toBeUndefined();
    // Exactly the other writer's renames landed, one before each of our writes.
    expect(m.db.escritasEm(P).map((e) => Object.keys(e.dados ?? {}))).toEqual(
      Array.from({ length: MAX_TENTATIVAS_FOTOS_LI }, () => ['nome']),
    );
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.conflito);
    expect(resultado.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId: null, referencias: [PRODUTO] },
    ]);
  });

  it(`⚠️ NEAR-MISS: ${String(MAX_TENTATIVAS_FOTOS_LI - 1)} lost writes, the last write lands`, async () => {
    const a = imagem(767);
    const m = montar({ [orig(a)]: ok(png(14)) });
    semeiaProduto(m.db);
    perderEscritas(m.db, MAX_TENTATIVAS_FOTOS_LI - 1);
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.db.escritasEm(P)).toHaveLength(MAX_TENTATIVAS_FOTOS_LI);
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.importadas);
    expect(m.db.ler(P)?.fotos).toEqual([fotoEsperada(PRODUTO, png(14))]);
  });

  it('a produto deleted before the write ⇒ `ausente`, nothing recreated', async () => {
    const a = imagem(768);
    const m = montar({ [orig(a)]: ok(png(15)) });
    semeiaProduto(m.db);
    m.db.antesDaProximaEscrita(P, async () => {
      await refProduto(m.db).delete();
    });
    const resultado = concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.db.ler(P)).toBeUndefined();
    expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.ausente);
  });

  it('`fotosArquivosIds` keeps every id already stored and gains the new ones', async () => {
    const a = imagem(769);
    const m = montar({ [orig(a)]: ok(png(16)) });
    semeiaProduto(m.db, P, { fotos: null, fotosArquivosIds: ['restante-antigo'] });
    concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    const fotos = [fotoEsperada(PRODUTO, png(16))];
    expect(m.db.ler(P)?.fotosArquivosIds).toEqual([
      'restante-antigo',
      ...deriveFotosArquivosIds(fotos),
    ]);
  });

  it('a Storage failure propagates (the task retries); nothing is written on the produto', async () => {
    const a = imagem(770);
    const bytes = png(17);
    const m = montar({ [orig(a)]: ok(bytes) });
    semeiaProduto(m.db);
    const falha = new Error('storage fora');
    m.bucket.falhaAoSalvar.set(productOriginalPath(PRODUTO, hashDaFotoLi(bytes), 'png'), falha);
    await expect(executarUnidadeDeFotoLi(m.deps, [alvoRaiz([a])], null)).rejects.toBe(falha);
    expect(m.db.escritasEm(P)).toEqual([]);
  });

  it('a Firestore failure propagates too', async () => {
    const a = imagem(771);
    const m = montar({ [orig(a)]: ok(png(18)) });
    semeiaProduto(m.db);
    const falha = grpc(14, 'UNAVAILABLE');
    m.db.falharLeitura(P, falha);
    await expect(executarUnidadeDeFotoLi(m.deps, [alvoRaiz([a])], null)).rejects.toBe(falha);
  });

  it('a picture this produto already holds in `arquivos` is not uploaded again: its externalIds gain this conta’s image id', async () => {
    const a = imagem(772);
    const bytes = png(19);
    const m = montar({ [orig(a)]: ok(bytes) });
    semeiaProduto(m.db);
    const id = productArquivoId(PRODUTO, hashDaFotoLi(bytes));
    m.db.seed(`arquivos/${id}`, {
      filetype: FILETYPE.image,
      url: 'https://armazenamento.invalid/foto',
      externalIds: [{ externalId: 'outro', integracaoPath: 'documents/integracao/outra-conta' }],
    });
    concluido(await rodarAteOFim(m, [alvoRaiz([a])]));
    expect(m.bucket.salvos).toEqual([]);
    expect(m.db.ler(`arquivos/${id}`)?.externalIds).toEqual([
      { externalId: 'outro', integracaoPath: 'documents/integracao/outra-conta' },
      { externalId: '772', integracaoPath: `documents/integracao/${CONTA}` },
    ]);
    expect(m.db.ler(P)?.fotos).toEqual([fotoEsperada(PRODUTO, bytes)]);
  });
});

/* ------------------------------ the deadline ------------------------------ */

describe(`the upload's deadline (${String(PRAZO_UPLOAD_LI_MS)} ms): past it, the photo units stop`, () => {
  it('an upload that does not answer ⇒ `parar` at the deadline, the cursor UNCHANGED; the next dispatch stores it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = imagem(781);
    const b = imagem(782);
    const bytesA = png(21);
    const m = montar({ [orig(a)]: ok(bytesA), [orig(b)]: ok(png(22)) });
    semeiaProduto(m.db);
    const alvos = [alvoRaiz([a, b])];
    const caminho = productOriginalPath(PRODUTO, hashDaFotoLi(bytesA), 'png');
    const seguro = m.bucket.segurar(caminho);

    let passo: PassoFotosLi | null = null;
    const unidade = executarUnidadeDeFotoLi(m.deps, alvos, null).then((p) => {
      passo = p;
    });
    await vi.advanceTimersByTimeAsync(PRAZO_UPLOAD_LI_MS - 1);
    // NEAR-MISS: one millisecond before the deadline, the unit still waits on the upload.
    expect(seguro.chamado).toBe(true);
    expect(passo).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await unidade;
    expect(passo).toEqual({ tipo: 'parar', downloads: 1, cursor: cursorInicialDeFotosLi(alvos) });
    expect(m.db.escritasEm(P)).toEqual([]);
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('passou do prazo'), {
      produtoId: PRODUTO,
      imagemId: 781,
      prazoMs: PRAZO_UPLOAD_LI_MS,
    });

    // The next dispatch, from the same cursor: the same picture fetched and stored again (the
    // create-first anchor the abandoned upload left is healed), then the rest of the family.
    const resto = await rodarAteOFim(m, alvos, cursorInicialDeFotosLi(alvos));
    expect(m.chamadas.map((c) => c.caminho)).toEqual([a.caminho, a.caminho, b.caminho]);
    expect(m.db.ler(P)?.fotos).toEqual([
      fotoEsperada(PRODUTO, bytesA),
      fotoEsperada(PRODUTO, png(22)),
    ]);
    expect(concluido(resto).gravadas).toBe(2);

    // The abandoned upload landing late changes nothing and logs nothing more.
    const linhas = m.warn.mock.calls.length;
    seguro.soltar();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.warn.mock.calls.length).toBe(linhas);
  });

  it('an abandoned upload that FAILS late is one WARN line (its class), never an unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = imagem(783);
    const bytes = png(23);
    const m = montar({ [orig(a)]: ok(bytes) });
    semeiaProduto(m.db);
    const seguro = m.bucket.segurar(productOriginalPath(PRODUTO, hashDaFotoLi(bytes), 'png'));
    const unidade = executarUnidadeDeFotoLi(m.deps, [alvoRaiz([a])], null);
    await vi.advanceTimersByTimeAsync(PRAZO_UPLOAD_LI_MS);
    expect((await unidade).tipo).toBe('parar');
    seguro.falhar(new RangeError('storage caiu tarde'));
    await vi.advanceTimersByTimeAsync(0);
    expect(m.warn).toHaveBeenLastCalledWith(expect.stringContaining('abandonado'), {
      produtoId: PRODUTO,
      imagemId: 783,
      erro: 'RangeError',
    });
  });

  it('⚠️ NEAR-MISS: an upload that fails BEFORE the deadline is rethrown as it came', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = imagem(784);
    const bytes = png(24);
    const m = montar({ [orig(a)]: ok(bytes) });
    semeiaProduto(m.db);
    const seguro = m.bucket.segurar(productOriginalPath(PRODUTO, hashDaFotoLi(bytes), 'png'));
    const unidade = executarUnidadeDeFotoLi(m.deps, [alvoRaiz([a])], null);
    const esperado = expect(unidade).rejects.toThrow('caiu antes');
    await vi.advanceTimersByTimeAsync(10);
    seguro.falhar(new Error('caiu antes'));
    await vi.advanceTimersByTimeAsync(0);
    await esperado;
  });
});

/* -------------------------------- no bucket ------------------------------- */

describe('no bucket', () => {
  it('nothing is attempted: no read, no download, no wait', async () => {
    const a = imagem(791);
    const m = montar({ [orig(a)]: ok(png(25)) }, { semBucket: true });
    semeiaProduto(m.db);
    expect(await executarUnidadeDeFotoLi(m.deps, [alvoRaiz([a])], null)).toEqual({
      tipo: 'sem-bucket',
    });
    expect(m.db.leituras).toEqual([]);
    expect(m.chamadas).toEqual([]);
    expect(m.esperas).toEqual([]);
  });
});

/* -------------------------------- the cursor ------------------------------ */

describe('the cursor', () => {
  it('reads back what a checkpoint stored; anything else does not parse', () => {
    const cursor: CursorFotosLi = {
      produtoId: PRODUTO,
      proxima: 2,
      reduzida: true,
      enviadas: [{ imagemId: 1, hash: 'a'.repeat(128) }],
      feitos: [
        {
          produtoId: FILHO,
          liId: 9101,
          desfecho: DESFECHO_FOTOS_DO_PRODUTO_LI.comFotos,
          fotos: 0,
        },
      ],
      recusadas: [{ liId: null, imagemId: 3, motivo: MOTIVO_FOTO_RECUSADA_LI.http }],
    };
    expect(cursorFotosLiSchema.parse(JSON.parse(JSON.stringify(cursor)))).toEqual(cursor);
    expect(cursorFotosLiSchema.safeParse(null).success).toBe(false);
    expect(
      cursorFotosLiSchema.safeParse({
        ...cursor,
        enviadas: [{ imagemId: 1, hash: 'nao-e-hash' }],
      }).success,
    ).toBe(false);
    expect(
      cursorFotosLiSchema.safeParse({
        ...cursor,
        recusadas: [{ liId: null, imagemId: 3, motivo: 'ok' }],
      }).success,
    ).toBe(false);
    expect(cursorFotosLiSchema.safeParse({ ...cursor, proxima: -1 }).success).toBe(false);
  });

  it('a cursor naming a produto outside the targets is another plan’s: RangeError', async () => {
    const m = montar({});
    await expect(
      executarUnidadeDeFotoLi(m.deps, [alvoRaiz([imagem(1)])], {
        ...cursorInicialDeFotosLi([alvoRaiz([imagem(1)])]),
        produtoId: 'outro',
      }),
    ).rejects.toThrow(RangeError);
  });

  it('a family with no target concludes at once, with nothing', async () => {
    const m = montar({});
    expect(await executarUnidadeDeFotoLi(m.deps, [], null)).toEqual({
      tipo: 'concluido',
      downloads: 0,
      resultado: { produtos: [], gravadas: 0, pendencias: [] },
    });
  });
});

/* ------------------------- the real reader, stubbed ------------------------ */

describe('through the package’s real CDN reader (its transport stubbed)', () => {
  it('asks the pinned host for the original, then for 800x800 when the original is over the cap — never with a credential', async () => {
    const a = imagem(795, 'loja/produto/795/foto.jpg');
    const grande = new Uint8Array(64).fill(1);
    const pequenos = png(30);
    const pedidos: { url: string; init: RequestInit | undefined }[] = [];
    const transporte = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      pedidos.push({ url: String(url), init });
      const corpo = String(url).includes('/800x800/') ? pequenos : grande;
      return Promise.resolve(
        new Response(corpo, { status: 200, headers: { 'content-type': 'image/jpg' } }),
      );
    });
    const m = montar({});
    semeiaProduto(m.db);
    const deps: DepsFotosLi = {
      ...m.deps,
      cdn: criarLeitorCdnLi({ fetch: transporte, maxBytes: 32 }),
    };
    const resultado = concluido(await rodarAteOFim({ ...m, deps }, [alvoRaiz([a])]));
    expect(pedidos.map((p) => p.url)).toEqual([
      'https://cdn.awsli.com.br/loja/produto/795/foto.jpg',
      'https://cdn.awsli.com.br/800x800/loja/produto/795/foto.jpg',
    ]);
    for (const p of pedidos) expect(p.init?.headers).toBeUndefined();
    expect(resultado.gravadas).toBe(1);
    // The header said `image/jpg`; the bytes are a PNG, and that is what is stored.
    expect(m.bucket.salvos[0]?.contentType).toBe('image/png');
  });
});

/* --------------------------------- Simular -------------------------------- */

describe('Simular (decided 2026-11-06): no download, no upload, no write — the count a real run would fetch', () => {
  it('existing without photo ⇒ every picture; with a photo or gone ⇒ none; created ⇒ every picture, with no read', async () => {
    const db = new FakeDb();
    semeiaProduto(db, P);
    semeiaProduto(db, PF, { fotos: [fotoDoOperador(FILHO)] });
    const CRIADO = 'li-sku-criado';
    const resultado = await contarFotosSimuladasLi(
      asDb(db),
      [
        alvoRaiz([imagem(1), imagem(2)]),
        { produtoId: FILHO, liId: 9101, imagens: [imagem(3)] },
        { produtoId: 'erp-sumiu', liId: 9102, imagens: [imagem(4)] },
        { produtoId: CRIADO, liId: 9103, imagens: [imagem(5), imagem(6), imagem(7)] },
      ],
      new Set([CRIADO]),
    );
    expect(resultado.produtos.map((p) => [p.produtoId, p.desfecho, p.fotos])).toEqual([
      [PRODUTO, 'importadas', 2],
      [FILHO, 'com-fotos', 0],
      ['erp-sumiu', 'ausente', 0],
      [CRIADO, 'importadas', 3],
    ]);
    expect(resultado.gravadas).toBe(5);
    expect(resultado.pendencias).toEqual([]);
    expect(db.escritas).toEqual([]);
    expect(db.leituras).toEqual([P, PF, 'produtos/erp-sumiu']);
  });

  it('a family planned from a parent with pictures and variations repeating them: only the parent counts', async () => {
    const db = new FakeDb();
    semeiaProduto(db, P);
    const pai = vistaDetalhadaLi(
      detalheLi(paiLi(9100, [9101]), null, {
        imagens: [{ id: 1, caminho: 'p/1.jpg', principal: true, posicao: 1 }],
      }),
    );
    const alvos = planejarAlvosDeFotosLi({
      raiz: { produtoId: PRODUTO, liId: null, imagens: pai.imagens },
      filhos: [{ produtoId: FILHO, liId: 9101, imagens: pai.imagens }],
    });
    const resultado = await contarFotosSimuladasLi(asDb(db), alvos, new Set());
    expect(resultado.produtos.map((p) => p.produtoId)).toEqual([PRODUTO]);
    expect(resultado.gravadas).toBe(1);
  });
});
