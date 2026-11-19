/**
 * The manual stock push's body (step 12, PR 12-g) against the fake Firestore,
 * the REAL stock producer over a recording queue, and a global `fetch` that
 * must never run: the strict body and the produto bound, the read switch and
 * the queue's region before any read, the conta and its depósito, the anchor
 * hop and the family's links, the 30-SKU switch (all or nothing), the per-SKU
 * skips, the queue valve, the budget, the failures it names — and, on every
 * arm, zero writes and zero Amazon calls.
 */
import { readFileSync } from 'node:fs';

import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ESTOQUE_AMAZON,
  INTEGRACAO_TIPO,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON,
  envioEstoqueManualAmazonSchema,
  erroEnvioEstoqueManualAmazonSchema,
} from '@delfrance/schemas';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import type { AmbienteAmazon } from '../env';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDeTarefaJaExistente,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import { espiaoDeFetch, loggerEspiao } from '../testing/fixtures';
import {
  AmazonEstoqueEnfileiramentoFalhouError,
  CAMPOS_CONTA_ENVIO_MANUAL_ESTOQUE_AMAZON,
  CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_ESTOQUE_AMAZON,
  CAMPOS_PRODUTO_ENVIO_MANUAL_ESTOQUE_AMAZON,
  CAMPOS_ROTULO_ANCORA_ENVIO_MANUAL_ESTOQUE_AMAZON,
  CAMPOS_VINCULO_ENVIO_MANUAL_ESTOQUE_AMAZON,
  type DepsEnvioManualEstoqueAmazon,
  LARGURA_LEITURAS_ENVIO_MANUAL_ESTOQUE,
  MAX_CORPO_ENVIO_MANUAL_ESTOQUE_BYTES,
  MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON,
  ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS,
  ROTA_ENVIO_MANUAL_ESTOQUE_AMAZON,
  enviarEstoqueManualAmazon,
} from './envioManualEstoque';
import {
  AmazonEstoqueRegiaoDaFilaInvalidaError,
  type FilaEstoqueAmazon,
  LARGURA_LOTE_ESTOQUE_AMAZON,
  caminhoDaFilaEstoqueAmazon,
  criarProdutorEstoqueAmazon,
} from './produtorEstoque';
import { CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON } from './resolverEstoque';
import { type TarefaEstoqueAmazon, nomeDaTarefaEstoque } from './tarefaEstoque';

const CONTA = 'conta-teste';
const REF_CONTA = `documents/integracao/${CONTA}`;
const REF_CONTA_NUA = `integracao/${CONTA}`;
const DEPOSITO = 'documents/depositos/dep-1';
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/enviar-estoque';
/** The request's id, as the route mints it (any id of the feed core's grammar). */
const REFERENCIA = '00000000-0000-4000-8000-000000000001';

/** The read switch on, the stock valve and its canary UNSET — the route must not care. */
const AMBIENTE: AmbienteAmazon = Object.freeze({ AMAZON_CHAMADAS: 'on' });

const MSG = MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON;

let fake: FakeDb;
let espiao: ReturnType<typeof loggerEspiao>;
let lerDb: ReturnType<typeof vi.fn>;
let criarProdutor: ReturnType<typeof vi.fn>;
let enqueue: ReturnType<typeof vi.fn<FilaEstoqueAmazon['enqueue']>>;
let chamadasFetch: unknown[];
/** The route's clock, ms. */
let relogio: number;

/** The REAL producer over a queue that records every enqueue, whole, and refuses a held name. */
function produtorReal(
  opcoes: { desligado?: boolean; falha?: () => unknown; fila?: () => FilaEstoqueAmazon } = {},
): void {
  const ids = new Set<string>();
  enqueue.mockImplementation((_tarefa, extras) => {
    if (opcoes.falha !== undefined) return Promise.reject(opcoes.falha());
    const id = extras?.id;
    if (id !== undefined && ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
    if (id !== undefined) ids.add(id);
    return Promise.resolve();
  });
  const fila: FilaEstoqueAmazon = {
    enqueue: (...args: Parameters<FilaEstoqueAmazon['enqueue']>) => enqueue(...args),
  };
  criarProdutor.mockImplementation(() =>
    criarProdutorEstoqueAmazon({
      fila: opcoes.fila ?? (() => fila),
      desligado: opcoes.desligado ?? false,
    }),
  );
}

function deps(over: Partial<DepsEnvioManualEstoqueAmazon> = {}): DepsEnvioManualEstoqueAmazon {
  return {
    ambiente: AMBIENTE,
    db: lerDb as unknown as DepsEnvioManualEstoqueAmazon['db'],
    filaDesligada: false,
    regiao: () => 'xx-tarefas-1',
    produtor: criarProdutor as unknown as DepsEnvioManualEstoqueAmazon['produtor'],
    agora: () => relogio,
    gerarReferencia: () => REFERENCIA,
    logger: espiao.logger,
    ...over,
  };
}

/** A POST to the route with `corpo` as its body (a string is sent verbatim). */
function requisicao(corpo: unknown): Request {
  return new Request(URL_ROTA, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function enviar(corpo: unknown, over: Partial<DepsEnvioManualEstoqueAmazon> = {}) {
  return enviarEstoqueManualAmazon(requisicao(corpo), deps(over));
}

const corpoDe = (...produtoIds: string[]) => ({ integracaoId: CONTA, produtoIds });

/** An INCOMPLETE Amazon conta with its depósito (fields over it). */
function semearConta(over: Record<string, unknown> = {}): void {
  fake.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste',
    ativo: true,
    depositoOuterRef: DEPOSITO,
    ...over,
  });
}

function produto(id: string, extra: Record<string, unknown> = {}): void {
  fake.seed(`produtos/${id}`, { nome: `Produto ${id}`, ...extra });
}

/** A link doc on `dono`, of this conta unless told otherwise, carrying a payload no read returns. */
function vinculo(
  dono: string,
  sku: string,
  opcoes: { conta?: string | null; id?: string } = {},
): void {
  const conta = opcoes.conta === undefined ? REF_CONTA : opcoes.conta;
  fake.seed(`produtos/${dono}/prodAmazon/${opcoes.id ?? `l-${sku}`}`, {
    ...(conta === null ? {} : { contaAmazonOuterRef: conta }),
    sku,
    productDataJson: { pesado: 'x'.repeat(64) },
  });
}

/** `n` SKUs, zero-padded so code-unit order is numeric order. */
const sku = (i: number) => `SKU-${String(i).padStart(3, '0')}`;

/** The enqueued payloads, in order. */
function enfileiradas(): TarefaEstoqueAmazon[] {
  return enqueue.mock.calls.map(([t]) => t);
}

/** Every `evento: 'estoque'` line's campos. */
function linhasEstoque() {
  return espiao.linhas.filter((l) => l.meta?.evento === 'estoque').map((l) => l.meta ?? {});
}

/** A 200 answer's body, checked against the contract (and returned RAW). */
function ok(r: Awaited<ReturnType<typeof enviar>>) {
  expect(r.status).toBe(200);
  if (r.status !== 200) throw new Error('esperado 200');
  expect(envioEstoqueManualAmazonSchema.safeParse(r.corpo).success).toBe(true);
  return r.corpo;
}

/** An error answer's body, checked against the contract. */
function recusa(r: Awaited<ReturnType<typeof enviar>>) {
  expect(r.status).not.toBe(200);
  return erroEnvioEstoqueManualAmazonSchema.parse(r.corpo);
}

/**
 * The fake db with hooks around each `getAll`, keyed by its first document's
 * path: `antes` runs (and is awaited) before the read, `depois` after it
 * answered. Everything else is the fake itself.
 */
function dbEspiado(ganchos: {
  readonly antes?: (caminho: string) => Promise<void> | void;
  readonly depois?: (caminho: string) => void;
}): Firestore {
  const real = asDb(fake);
  return new Proxy(real, {
    get(alvo, chave) {
      const v = Reflect.get(alvo, chave) as unknown;
      if (typeof v !== 'function') return v;
      const metodo = v as (...a: unknown[]) => unknown;
      if (chave !== 'getAll') return (...args: unknown[]) => metodo.apply(alvo, args);
      return async (...args: unknown[]) => {
        const caminho = String((args[0] as { readonly path?: unknown } | undefined)?.path);
        await ganchos.antes?.(caminho);
        const saida = await (metodo.apply(alvo, args) as Promise<unknown>);
        ganchos.depois?.(caminho);
        return saida;
      };
    },
  });
}

/** A hook that runs `fn` only for the read of `alvo`. */
const sobre =
  (alvo: string, fn: () => void) =>
  (caminho: string): void => {
    if (caminho === alvo) fn();
  };

beforeEach(() => {
  fake = new FakeDb();
  // Every read of these collections must be masked or projected.
  for (const c of ['integracao', 'produtos', 'prodAmazon', 'estoques']) fake.exigirMascaraEm(c);
  espiao = loggerEspiao();
  lerDb = vi.fn(() => asDb(fake));
  enqueue = vi.fn<FilaEstoqueAmazon['enqueue']>();
  criarProdutor = vi.fn();
  produtorReal();
  relogio = 1_000_000;
  const fetch = espiaoDeFetch();
  chamadasFetch = fetch.chamadas;
  vi.stubGlobal('fetch', fetch.fetch);
});

afterEach(() => {
  // ★ On EVERY arm: no Amazon call (no fetch at all) and no Firestore write.
  expect(chamadasFetch).toHaveLength(0);
  expect(fake.escritas).toEqual([]);
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                                  the 200                                   */
/* -------------------------------------------------------------------------- */

describe('200 — ONE named task per SKU, identities only', () => {
  it('★ one produto, one link ⇒ ONE task NAMED by its own fields, the payload EXACTLY its identities, the row naming the produto', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('p1')));
    // ★ The RAW body, EXACTLY these keys (the schema strips unknown ones).
    expect(corpo).toEqual({
      listings: [
        {
          produtoId: 'p1',
          produtoNome: 'Produto p1',
          sku: 'SKU-1',
          resultado: 'enviado',
          mensagem: MSG.enfileirado,
        },
      ],
      produtosSemEnvio: [],
      pausadoAte: null,
    });
    const payload = {
      v: 1,
      contaId: CONTA,
      sku: 'SKU-1',
      origem: 'manual',
      referencia: REFERENCIA,
      depositoId: null,
    };
    // ★ Identities only: no quantity, no depósito, NAMED by the payload's own fields.
    expect(enqueue.mock.calls).toEqual([
      [payload, { id: nomeDaTarefaEstoque(payload as TarefaEstoqueAmazon) }],
    ]);
    expect(Object.keys(enfileiradas()[0] ?? {}).sort()).toEqual(
      ['contaId', 'depositoId', 'origem', 'referencia', 'sku', 'v'].sort(),
    );
  });

  it('★ the quantity is never computed: no estoque row is read, and the reads are exactly the conta, the produto, its children and the partitions — every one masked', async () => {
    semearConta();
    produto('p1');
    fake.seed(`produtos/p1/estoques/e1`, { depositoOuterRef: DEPOSITO, quantidade: 7 });
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1')));
    // ★ The masks as LITERALS, never the module's own constants: a widened
    // mask (a credential field, the heavy link payload) reds here.
    expect(fake.leiturasDetalhadas).toEqual([
      expect.objectContaining({
        caminho: `integracao/${CONTA}`,
        via: 'getAll',
        mascara: ['tipo', 'ativo', 'depositoOuterRef'],
      }),
      expect.objectContaining({
        caminho: 'produtos/p1',
        via: 'getAll',
        mascara: ['paiId', 'nome'],
      }),
    ]);
    const consultas = fake.consultas.map((c) => c.colecao).sort();
    expect(consultas).toEqual(['produtos', 'produtos/p1/prodAmazon']);
    expect(JSON.stringify(fake.consultas)).not.toContain('estoques');
    expect(fake.consultas.find((c) => c.colecao === 'produtos/p1/prodAmazon')?.selecao).toEqual([
      'contaAmazonOuterRef',
      'sku',
    ]);
    // The children seek is keys only.
    expect(fake.consultas.find((c) => c.colecao === 'produtos')?.selecao).toEqual([]);
    // The constants ARE those literals (the names other tests and docs use).
    expect([...CAMPOS_CONTA_ENVIO_MANUAL_ESTOQUE_AMAZON]).toEqual([
      'tipo',
      'ativo',
      'depositoOuterRef',
    ]);
    expect([...CAMPOS_PRODUTO_ENVIO_MANUAL_ESTOQUE_AMAZON]).toEqual(['paiId', 'nome']);
    expect([...CAMPOS_ROTULO_ANCORA_ENVIO_MANUAL_ESTOQUE_AMAZON]).toEqual(['nome']);
    expect([...CAMPOS_VINCULO_ENVIO_MANUAL_ESTOQUE_AMAZON]).toEqual(['contaAmazonOuterRef', 'sku']);
  });

  it('★ a family anchor’s CHILDREN’s links are found, in BOTH stored conta ref forms; another conta’s link is not (NEAR-MISS: the same SKU shape under another conta)', async () => {
    semearConta();
    produto('ancora');
    produto('filho-a', { paiId: 'ancora' });
    produto('filho-b', { paiId: 'ancora' });
    vinculo('ancora', 'SKU-ANCORA');
    vinculo('filho-a', 'SKU-A', { conta: REF_CONTA_NUA });
    vinculo('filho-b', 'SKU-B');
    vinculo('filho-b', 'SKU-OUTRA', { conta: 'documents/integracao/outra-conta' });
    vinculo('filho-b', 'SKU-SEM-CONTA', { conta: null });
    const corpo = ok(await enviar(corpoDe('ancora')));
    expect(corpo.listings.map((l) => [l.produtoId, l.sku])).toEqual([
      ['ancora', 'SKU-A'],
      ['ancora', 'SKU-ANCORA'],
      ['ancora', 'SKU-B'],
    ]);
    expect(enfileiradas().map((t) => t.sku)).toEqual(['SKU-A', 'SKU-ANCORA', 'SKU-B']);
  });

  it('★ (mutation 5) a selected variation CHILD hops ONE paiId level: its anchor’s family is read and the rows name the ANCHOR (NEAR-MISS: answered by itself it would have no listing)', async () => {
    semearConta();
    produto('ancora');
    produto('filho', { paiId: 'ancora' });
    vinculo('ancora', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('filho')));
    expect(corpo.listings).toEqual([
      {
        produtoId: 'ancora',
        produtoNome: 'Produto ancora',
        sku: 'SKU-1',
        resultado: 'enviado',
        mensagem: MSG.enfileirado,
      },
    ]);
    expect(corpo.produtosSemEnvio).toEqual([]);
    // The child itself is read once, by id; then the anchor's LABEL alone
    // (never its `paiId`: no second hop); the anchor's partition is listed.
    expect(fake.consultas.map((c) => c.colecao)).toContain('produtos/ancora/prodAmazon');
    expect(fake.leituras).toEqual([`integracao/${CONTA}`, 'produtos/filho', 'produtos/ancora']);
    expect(fake.leiturasDetalhadas.at(-1)).toMatchObject({
      caminho: 'produtos/ancora',
      via: 'getAll',
      mascara: ['nome'],
    });
  });

  it('★ the rows carry the ANCHOR’s own name even when only a child was selected; a blank or absent name is `null`, never an empty label (NEAR-MISS: the child’s name is never used for the anchor’s row)', async () => {
    semearConta();
    produto('ancora', { nome: 'Camiseta' });
    produto('filho', { paiId: 'ancora', nome: 'Camiseta P' });
    produto('vazio', { nome: '   ' });
    fake.seed('produtos/sem-nome', {});
    vinculo('ancora', 'SKU-1');
    vinculo('vazio', 'SKU-2');
    vinculo('sem-nome', 'SKU-3');
    const corpo = ok(await enviar(corpoDe('filho', 'vazio', 'sem-nome', 'sumiu')));
    expect(corpo.listings.map((l) => [l.produtoId, l.produtoNome])).toEqual([
      ['ancora', 'Camiseta'],
      ['vazio', null],
      ['sem-nome', null],
    ]);
    // A produto with no document has no name to give.
    expect(corpo.produtosSemEnvio).toEqual([
      { produtoId: 'sumiu', produtoNome: null, mensagem: MSG['produto-ausente'] },
    ]);
  });

  it('★ a família-de-um MEMBER selected ⇒ the wrapper’s SKU is enqueued, and its row names the wrapper (the anchor)', async () => {
    semearConta();
    produto('embrulho', { ehFamiliaDeUm: true, filhoUnicoId: 'membro' });
    produto('membro', { paiId: 'embrulho' });
    vinculo('embrulho', 'SKU-EMB');
    const corpo = ok(await enviar(corpoDe('membro')));
    expect(corpo.listings).toEqual([
      {
        produtoId: 'embrulho',
        produtoNome: 'Produto embrulho',
        sku: 'SKU-EMB',
        resultado: 'enviado',
        mensagem: MSG.enfileirado,
      },
    ]);
    expect(enfileiradas().map((t) => t.sku)).toEqual(['SKU-EMB']);
  });

  it('ONE hop, never two: a grandchild resolves to its parent, whose family holds no link — answered under its OWN id, the grandparent’s link never reached', async () => {
    semearConta();
    produto('avo');
    produto('pai', { paiId: 'avo' });
    produto('neto', { paiId: 'pai' });
    vinculo('avo', 'SKU-AVO');
    const corpo = ok(await enviar(corpoDe('neto')));
    expect(corpo.listings).toEqual([]);
    expect(corpo.produtosSemEnvio).toEqual([
      { produtoId: 'neto', produtoNome: 'Produto neto', mensagem: MSG['sem-vinculo'] },
    ]);
    expect(fake.consultas.map((c) => c.colecao)).not.toContain('produtos/avo/prodAmazon');
    expect(fake.leituras).not.toContain('produtos/avo');
    expect(criarProdutor).not.toHaveBeenCalled();
  });

  it('a produto whose paiId names ITSELF is its own anchor, and its partition is listed ONCE', async () => {
    semearConta();
    produto('p1', { paiId: 'p1' });
    vinculo('p1', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => l.sku)).toEqual(['SKU-1']);
    expect(fake.consultas.filter((c) => c.colecao === 'produtos/p1/prodAmazon')).toHaveLength(1);
  });

  it.each([
    ['empty', ''],
    ['a path', 'a/b'],
    ['`..`', '..'],
    ['a number', 7],
  ])(
    '★ a stored paiId that is no document id (%s) leaves the produto its OWN anchor: no read under another path, no throw',
    async (_nome, paiId) => {
      semearConta();
      produto('p1', { paiId });
      vinculo('p1', 'SKU-1');
      const corpo = ok(await enviar(corpoDe('p1')));
      expect(corpo.listings.map((l) => [l.produtoId, l.sku, l.resultado])).toEqual([
        ['p1', 'SKU-1', 'enviado'],
      ]);
      expect(fake.leituras).toEqual([`integracao/${CONTA}`, 'produtos/p1']);
      expect(fake.consultas.map((c) => c.colecao).sort()).toEqual([
        'produtos',
        'produtos/p1/prodAmazon',
      ]);
    },
  );

  it('★ a selected child whose paiId names a produto with NO document ⇒ under its own id “pai não encontrado”, nothing of that parent read, nothing enqueued', async () => {
    semearConta();
    produto('filho', { paiId: 'sumiu' });
    produto('irmao', { paiId: 'sumiu' });
    vinculo('filho', 'SKU-FILHO');
    vinculo('irmao', 'SKU-IRMAO');
    const corpo = ok(await enviar(corpoDe('filho')));
    expect(corpo).toEqual({
      listings: [],
      produtosSemEnvio: [
        { produtoId: 'filho', produtoNome: 'Produto filho', mensagem: MSG['pai-ausente'] },
      ],
      pausadoAte: null,
    });
    // The parent was read ONCE (its label read found no document); no family.
    expect(fake.leituras).toEqual([`integracao/${CONTA}`, 'produtos/filho', 'produtos/sumiu']);
    expect(fake.consultas).toEqual([]);
    expect(criarProdutor).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: the same child with its parent PRESENT ⇒ the parent’s family, the child’s link enqueued under the parent’s row', async () => {
    semearConta();
    produto('pai');
    produto('filho', { paiId: 'pai' });
    vinculo('filho', 'SKU-FILHO');
    const corpo = ok(await enviar(corpoDe('filho')));
    expect(corpo.listings.map((l) => [l.produtoId, l.sku, l.resultado])).toEqual([
      ['pai', 'SKU-FILHO', 'enviado'],
    ]);
    expect(corpo.produtosSemEnvio).toEqual([]);
  });

  it('a child whose parent is a SELECTED id with no document ⇒ the parent “não encontrado”, the child “pai não encontrado”, the parent read once', async () => {
    semearConta();
    produto('filho', { paiId: 'sumiu' });
    vinculo('filho', 'SKU-FILHO');
    const corpo = ok(await enviar(corpoDe('sumiu', 'filho')));
    expect(corpo.produtosSemEnvio.map((p) => [p.produtoId, p.mensagem])).toEqual([
      ['sumiu', MSG['produto-ausente']],
      ['filho', MSG['pai-ausente']],
    ]);
    expect(fake.leituras.filter((c) => c === 'produtos/sumiu')).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('★ a selected child stored WITHOUT `nome` (outside the schema) is still a member of its anchor’s family: its own links are found (NEAR-MISS: the seek alone does not return it)', async () => {
    semearConta();
    produto('ancora');
    fake.seed('produtos/sem-nome', { paiId: 'ancora' });
    vinculo('sem-nome', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('sem-nome')));
    expect(corpo.listings).toEqual([
      {
        produtoId: 'ancora',
        produtoNome: 'Produto ancora',
        sku: 'SKU-1',
        resultado: 'enviado',
        mensagem: MSG.enfileirado,
      },
    ]);
    expect(corpo.produtosSemEnvio).toEqual([]);
    expect(enfileiradas().map((t) => t.sku)).toEqual(['SKU-1']);
    // Its partition listed ONCE, as a member the seek did not return.
    expect(fake.consultas.filter((c) => c.colecao === 'produtos/sem-nome/prodAmazon')).toHaveLength(
      1,
    );
  });

  it('★ SKUs are DEDUPLICATED: the same SKU on the anchor and a child is ONE task and ONE row; the child and its anchor selected together are ONE family', async () => {
    semearConta();
    produto('ancora');
    produto('filho', { paiId: 'ancora' });
    vinculo('ancora', 'SKU-1');
    vinculo('filho', 'SKU-1', { id: 'l-dup' });
    const corpo = ok(await enviar(corpoDe('filho', 'ancora')));
    expect(corpo.listings).toEqual([
      {
        produtoId: 'ancora',
        produtoNome: 'Produto ancora',
        sku: 'SKU-1',
        resultado: 'enviado',
        mensagem: MSG.enfileirado,
      },
    ]);
    expect(corpo.produtosSemEnvio).toEqual([]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The family is read once, whichever member led to it, and so is each
    // member's partition (the child: returned by the seek AND selected).
    expect(fake.consultas.filter((c) => c.colecao === 'produtos/ancora/prodAmazon')).toHaveLength(
      1,
    );
    expect(fake.consultas.filter((c) => c.colecao === 'produtos/filho/prodAmazon')).toHaveLength(1);
    // ★ The line counts DISTINCT anchors, not selected produtos.
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({ produtos: 2, ancoras: 1, anuncios: 1 }),
    ]);
  });

  it('a SKU two anchors hold is ONE task, answered on BOTH anchors’ rows', async () => {
    semearConta();
    produto('a');
    produto('b');
    vinculo('a', 'SKU-1');
    vinculo('b', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('a', 'b')));
    expect(corpo.listings.map((l) => [l.produtoId, l.sku, l.resultado])).toEqual([
      ['a', 'SKU-1', 'enviado'],
      ['b', 'SKU-1', 'enviado'],
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('rows come in first-seen ANCHOR order, each anchor’s SKUs in code-unit order; the tasks follow the same order', async () => {
    semearConta();
    produto('z');
    produto('a');
    vinculo('z', 'b-2');
    vinculo('z', 'B-1');
    vinculo('a', 'a-1');
    const corpo = ok(await enviar(corpoDe('z', 'a')));
    expect(corpo.listings.map((l) => `${l.produtoId}:${l.sku}`)).toEqual([
      'z:B-1',
      'z:b-2',
      'a:a-1',
    ]);
    expect(enfileiradas().map((t) => t.sku)).toEqual(['B-1', 'b-2', 'a-1']);
  });

  it('★ no link of the conta in the family ⇒ produtosSemEnvio under the SELECTED id, nothing enqueued, the producer never built', async () => {
    semearConta();
    produto('ancora');
    produto('filho', { paiId: 'ancora' });
    vinculo('ancora', 'SKU-X', { conta: 'documents/integracao/outra-conta' });
    const corpo = ok(await enviar(corpoDe('filho')));
    expect(corpo).toEqual({
      listings: [],
      produtosSemEnvio: [
        { produtoId: 'filho', produtoNome: 'Produto filho', mensagem: MSG['sem-vinculo'] },
      ],
      pausadoAte: null,
    });
    expect(criarProdutor).not.toHaveBeenCalled();
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({ resultado: 'nada-enfileirado', semEnvio: 1, anuncios: 0 }),
    ]);
  });

  it('a produto with no document ⇒ its own produtosSemEnvio entry; the others still go', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('sumiu', 'p1')));
    expect(corpo.produtosSemEnvio).toEqual([
      { produtoId: 'sumiu', produtoNome: null, mensagem: MSG['produto-ausente'] },
    ]);
    expect(corpo.listings.map((l) => l.sku)).toEqual(['SKU-1']);
  });

  it('★ a SKU with no listings path ⇒ `pulado` with its sentence, no task; a SKU no payload can carry ⇒ `pulado` too; the rest go', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'a/b', { id: 'l-barra' });
    vinculo('p1', 'L'.repeat(81), { id: 'l-longo' });
    vinculo('p1', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('p1')));
    const nome = 'Produto p1';
    expect(corpo.listings).toEqual([
      {
        produtoId: 'p1',
        produtoNome: nome,
        sku: 'L'.repeat(81),
        resultado: 'pulado',
        mensagem: MSG['fora-da-tarefa'],
      },
      {
        produtoId: 'p1',
        produtoNome: nome,
        sku: 'SKU-1',
        resultado: 'enviado',
        mensagem: MSG.enfileirado,
      },
      {
        produtoId: 'p1',
        produtoNome: nome,
        sku: 'a/b',
        resultado: 'pulado',
        mensagem: MSG['sem-caminho'],
      },
    ]);
    expect(enfileiradas().map((t) => t.sku)).toEqual(['SKU-1']);
    expect(linhasEstoque()).toEqual([expect.objectContaining({ pulados: 2, enfileirados: 1 })]);
  });

  it('NEAR-MISS: the longest SKU a payload carries (80 units) is sent', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'L'.repeat(80), { id: 'l-80' });
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => l.resultado)).toEqual(['enviado']);
  });

  it('★ reads exactly ONE variable — the read switch — never the stock valve or its canary list', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    const lidas: string[] = [];
    const base: AmbienteAmazon = {
      AMAZON_CHAMADAS: 'on',
      // Both set to what WOULD stop a write: the route must not look.
      AMAZON_MODO_ESTOQUE: 'off',
      AMAZON_CANARIO_ESTOQUE: '',
    };
    const ambiente = new Proxy(base, {
      get(alvo, chave, receptor) {
        lidas.push(String(chave));
        return Reflect.get(alvo, chave, receptor) as unknown;
      },
    });
    ok(await enviar(corpoDe('p1'), { ambiente }));
    expect([...new Set(lidas)]).toEqual(['AMAZON_CHAMADAS']);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('★ the referência is the request’s own: a re-send mints a new one, so its tasks are NEW names (the duplicates are harmless)', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1'), { gerarReferencia: () => 'req-a' }));
    ok(await enviar(corpoDe('p1'), { gerarReferencia: () => 'req-b' }));
    const ids = enqueue.mock.calls.map(([, extras]) => extras?.id);
    expect(enfileiradas().map((t) => t.referencia)).toEqual(['req-a', 'req-b']);
    expect(new Set(ids).size).toBe(2);
  });

  it('★ ONE referência per request: minted once, carried by EVERY task of the batch and by the answer’s line', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    vinculo('p1', 'SKU-2');
    vinculo('p1', 'SKU-3');
    let n = 0;
    const gerarReferencia = vi.fn(() => `req-${String(++n)}`);
    ok(await enviar(corpoDe('p1'), { gerarReferencia }));
    expect(gerarReferencia).toHaveBeenCalledTimes(1);
    expect(enfileiradas().map((t) => t.referencia)).toEqual(['req-1', 'req-1', 'req-1']);
    expect(linhasEstoque()).toEqual([expect.objectContaining({ referencia: 'req-1' })]);
  });

  it('the same request twice ⇒ the held names answer `enviado` (already durable), never an error', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1')));
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => l.resultado)).toEqual(['enviado']);
    // A held name IS on the queue: the line says enqueued, never "nothing".
    expect(linhasEstoque().at(-1)).toMatchObject({
      resultado: 'enfileirado',
      enfileirados: 0,
      jaEnfileirados: 1,
    });
  });

  it('a referência outside the id grammar is a wiring bug: RangeError, nothing enqueued', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    await expect(enviar(corpoDe('p1'), { gerarReferencia: () => 'a/b' })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('writes ONE INFO `estoque` line with the counts and the referência — never a SKU or a produto id', async () => {
    semearConta();
    produto('p1');
    produto('p2');
    vinculo('p1', 'SKU-SECRETO-1');
    const r = await enviar(corpoDe('p1', 'p2'));
    ok(r);
    expect(espiao.linhas).toHaveLength(1);
    expect(espiao.linhas[0]?.nivel).toBe('info');
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({
        evento: 'estoque',
        fluxo: 'estoque',
        conta: CONTA,
        rota: ROTA_ENVIO_MANUAL_ESTOQUE_AMAZON,
        resultado: 'enfileirado',
        motivo: null,
        referencia: REFERENCIA,
        produtos: 2,
        ancoras: 2,
        anuncios: 1,
        enfileirados: 1,
        jaEnfileirados: 0,
        pulados: 0,
        naoTentados: 0,
        semEnvio: 1,
      }),
    ]);
    const texto = JSON.stringify(espiao.linhas);
    expect(texto).not.toContain('SKU-SECRETO-1');
    expect(texto).not.toContain('"p1"');
  });

  it(`keeps at most ${String(LARGURA_LEITURAS_ENVIO_MANUAL_ESTOQUE)} reads in flight (the produtos and the families alike)`, async () => {
    semearConta();
    for (let i = 0; i < 40; i += 1) {
      produto(`p${String(i)}`);
      for (let f = 0; f < 3; f += 1)
        produto(`p${String(i)}-f${String(f)}`, { paiId: `p${String(i)}` });
    }
    const real = asDb(fake);
    let emVoo = 0;
    let maximo = 0;
    const atrasar = async <T>(fn: () => Promise<T>): Promise<T> => {
      emVoo += 1;
      maximo = Math.max(maximo, emVoo);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await fn();
      } finally {
        emVoo -= 1;
      }
    };
    const embrulhar = <Q extends object>(q: Q): Q =>
      new Proxy(q, {
        get(alvo, chave) {
          const v = Reflect.get(alvo, chave) as unknown;
          if (typeof v !== 'function') return v;
          if (chave === 'get') return () => atrasar(() => (v as () => Promise<unknown>).call(alvo));
          return (...args: unknown[]) => {
            const saida = (v as (...a: unknown[]) => unknown).apply(alvo, args);
            return typeof saida === 'object' && saida !== null && 'get' in saida
              ? embrulhar(saida)
              : saida;
          };
        },
      });
    const db = new Proxy(real, {
      get(alvo, chave) {
        const v = Reflect.get(alvo, chave) as unknown;
        if (chave === 'getAll') {
          return (...args: unknown[]) =>
            atrasar(() => (v as (...a: unknown[]) => Promise<unknown>).apply(alvo, args));
        }
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const saida = (v as (...a: unknown[]) => unknown).apply(alvo, args);
          return typeof saida === 'object' && saida !== null && 'get' in saida
            ? embrulhar(saida)
            : saida;
        };
      },
    }) as Firestore;
    const ids = Array.from({ length: 40 }, (_, i) => `p${String(i)}`);
    ok(await enviar(corpoDe(...ids), { db: () => db }));
    // EXACTLY the bound: 40 produto reads arrive at once, so a narrower
    // limiter (which would serialise the reads into the budget) reds too.
    expect(maximo).toBe(LARGURA_LEITURAS_ENVIO_MANUAL_ESTOQUE);
    // Anti-vacuity: every produto, child list and partition was read.
    expect(fake.consultas.length).toBe(40 + 40 * 4);
  });
});

/* -------------------------------------------------------------------------- */
/*                                the switch                                  */
/* -------------------------------------------------------------------------- */

describe('★ the 30-SKU switch: ALL or nothing, counted AFTER the hops (mutation 3)', () => {
  /** `n` produtos, each with ONE link. */
  function produtosComUmSku(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = `p${String(i).padStart(3, '0')}`;
      produto(id);
      vinculo(id, sku(i));
      ids.push(id);
    }
    return ids;
  }

  it(`★ ${String(LIMIAR_FEED_ESTOQUE_AMAZON)} SKUs ⇒ ${String(LIMIAR_FEED_ESTOQUE_AMAZON)} tasks`, async () => {
    semearConta();
    const ids = produtosComUmSku(LIMIAR_FEED_ESTOQUE_AMAZON);
    const corpo = ok(await enviar(corpoDe(...ids)));
    expect(enqueue).toHaveBeenCalledTimes(30);
    expect(corpo.listings.map((l) => l.resultado)).toEqual(Array(30).fill('enviado'));
  });

  it('★ NEAR-MISS: 31 SKUs ⇒ 400 AMAZON_ESTOQUE_SELECAO_EXCEDE_LIMITE, `unidade: anuncios`, ZERO enqueues, the producer never built', async () => {
    semearConta();
    const ids = produtosComUmSku(31);
    const r = await enviar(corpoDe(...ids));
    expect(r.status).toBe(400);
    expect(recusa(r)).toMatchObject({
      code: CODIGO_ERRO_ESTOQUE_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { limite: 30, unidade: 'anuncios', encontrados: 31 },
    });
    // ★ The RAW envelope's keys.
    expect(Object.keys(r.corpo).sort()).toEqual(['code', 'detalhes', 'error']);
    expect(enqueue).not.toHaveBeenCalled();
    expect(criarProdutor).not.toHaveBeenCalled();
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({
        resultado: CODIGO_ERRO_ESTOQUE_AMAZON.SELECAO_EXCEDE_LIMITE,
        motivo: 'anuncios',
        anuncios: 31,
      }),
    ]);
  });

  it('★ 12 produtos whose anchors hold 31 SKUs ⇒ refused: the bound counts SKUs, not produtos', async () => {
    semearConta();
    const ids: string[] = [];
    let n = 0;
    for (let i = 0; i < 12; i += 1) {
      const id = `p${String(i)}`;
      produto(id);
      const quantos = i === 11 ? 9 : 2;
      for (let k = 0; k < quantos; k += 1) {
        vinculo(id, sku(n));
        n += 1;
      }
      ids.push(id);
    }
    expect(n).toBe(31);
    const r = await enviar(corpoDe(...ids));
    expect(recusa(r)).toMatchObject({
      detalhes: { limite: 30, unidade: 'anuncios', encontrados: 31 },
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('★ ONE family anchor with 31 linked children ⇒ refused (its movement still goes through the tick and the reconcile)', async () => {
    semearConta();
    produto('ancora');
    for (let i = 0; i < 31; i += 1) {
      produto(`filho-${String(i)}`, { paiId: 'ancora' });
      vinculo(`filho-${String(i)}`, sku(i));
    }
    const r = await enviar(corpoDe('ancora'));
    expect(recusa(r)).toMatchObject({ detalhes: { encontrados: 31, unidade: 'anuncios' } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: 31 LINKS of 30 distinct SKUs ⇒ accepted (the bound counts distinct SKUs)', async () => {
    semearConta();
    const ids = produtosComUmSku(30);
    vinculo(ids[0] ?? '', sku(1), { id: 'l-repetido' });
    ok(await enviar(corpoDe(...ids)));
    expect(enqueue).toHaveBeenCalledTimes(30);
  });

  it('the bound counts every distinct SKU found, a skipped one included: 30 sendable + 1 without a path ⇒ refused', async () => {
    semearConta();
    const ids = produtosComUmSku(30);
    vinculo(ids[0] ?? '', 'a/b', { id: 'l-barra' });
    const r = await enviar(corpoDe(...ids));
    expect(recusa(r)).toMatchObject({ detalhes: { encontrados: 31 } });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the body                                   */
/* -------------------------------------------------------------------------- */

describe('400 AMAZON_ESTOQUE_CORPO_INVALIDO — STRICT, before anything is read', () => {
  it.each([
    [
      '★ a stray key',
      { integracaoId: CONTA, produtoIds: ['p1'], reenviarComErro: true },
      ['reenviarComErro'],
    ],
    ['no integracaoId', { produtoIds: ['p1'] }, ['integracaoId']],
    [
      'a conta id outside its grammar',
      { integracaoId: 'a/b', produtoIds: ['p1'] },
      ['integracaoId'],
    ],
    ['an empty selection', { integracaoId: CONTA, produtoIds: [] }, ['produtoIds']],
    ['no selection', { integracaoId: CONTA }, ['produtoIds']],
    ['a numeric id', { integracaoId: CONTA, produtoIds: [1] }, ['produtoIds.0']],
    [
      'an id with a "/" (another document)',
      { integracaoId: CONTA, produtoIds: ['p1', 'a/b'] },
      ['produtoIds.1'],
    ],
    ['an id of `..`', { integracaoId: CONTA, produtoIds: ['..'] }, ['produtoIds.0']],
    ['an empty id', { integracaoId: CONTA, produtoIds: [''] }, ['produtoIds.0']],
    ['an array', [CONTA], ['(corpo)']],
    ['null', null, ['(corpo)']],
    ['not JSON', '{integracaoId:', ['(corpo)']],
    ['an empty body', '', ['(corpo)']],
  ])('%s', async (_nome, corpo, issues) => {
    semearConta();
    const r = await enviar(corpo);
    expect(r.status).toBe(400);
    expect(recusa(r)).toMatchObject({ code: CODIGO_ERRO_ESTOQUE_AMAZON.CORPO_INVALIDO, issues });
    // ★ The RAW envelope's keys.
    expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error', 'issues']);
    expect(lerDb).not.toHaveBeenCalled();
    expect(fake.operacoes).toBe(0);
  });

  it('a body over the read bound ⇒ 400, the stream never read past it', async () => {
    const r = await enviar(
      JSON.stringify({
        integracaoId: CONTA,
        produtoIds: ['x'.repeat(MAX_CORPO_ENVIO_MANUAL_ESTOQUE_BYTES)],
      }),
    );
    expect(r).toMatchObject({ status: 400, corpo: { issues: ['(corpo)'] } });
    expect(lerDb).not.toHaveBeenCalled();
  });

  it('the issues are field PATHS — never a value — and the line carries none of them', async () => {
    const r = await enviar({ integracaoId: 'SEGREDO/NO-VALOR', produtoIds: ['p1'] });
    expect(r.corpo).toMatchObject({ issues: ['integracaoId'] });
    expect(JSON.stringify(r.corpo)).not.toContain('SEGREDO');
    expect(JSON.stringify(espiao.linhas)).not.toContain('SEGREDO');
  });

  it('★ the body is judged FIRST: an invalid body with the switch off ⇒ 400, never 503', async () => {
    const r = await enviar(
      { integracaoId: CONTA, produtoIds: [] },
      {
        ambiente: { AMAZON_CHAMADAS: 'off' },
      },
    );
    expect(recusa(r).code).toBe(CODIGO_ERRO_ESTOQUE_AMAZON.CORPO_INVALIDO);
    expect(espiao.linhas.map((l) => l.meta?.evento)).toEqual(['estoque']);
  });

  it('★ the produto bound is judged with the body, BEFORE the switch: 51 ids with the switch off ⇒ 400 `produtos`, never 503', async () => {
    const r = await enviar(corpoDe(...Array.from({ length: 51 }, (_, i) => `p${String(i)}`)), {
      ambiente: { AMAZON_CHAMADAS: 'off' },
    });
    expect(recusa(r)).toMatchObject({
      code: CODIGO_ERRO_ESTOQUE_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { unidade: 'produtos', encontrados: 51 },
    });
    expect(espiao.linhas.map((l) => l.meta?.evento)).toEqual(['estoque']);
    expect(lerDb).not.toHaveBeenCalled();
  });
});

describe(`★ the produto bound: ${String(MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON)} DISTINCT produtos (mutation 3)`, () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i)}`);

  it('★ 50 produtos are accepted', async () => {
    semearConta();
    const r = await enviar(corpoDe(...ids(50)));
    expect(ok(r).produtosSemEnvio).toHaveLength(50);
  });

  it('★ NEAR-MISS: 51 ⇒ 400 SELECAO_EXCEDE_LIMITE, `unidade: produtos`, NOTHING read', async () => {
    semearConta();
    const r = await enviar(corpoDe(...ids(51)));
    expect(r.status).toBe(400);
    expect(recusa(r)).toMatchObject({
      code: CODIGO_ERRO_ESTOQUE_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { limite: 50, unidade: 'produtos', encontrados: 51 },
    });
    expect(lerDb).not.toHaveBeenCalled();
    expect(fake.operacoes).toBe(0);
  });

  it('51 ids of which 50 are DISTINCT are accepted: the bound counts the deduplicated selection', async () => {
    semearConta();
    const r = await enviar(corpoDe(...ids(50), 'p0'));
    expect(ok(r).produtosSemEnvio.map((p) => p.produtoId)).toEqual(ids(50));
    // Each distinct produto is read once.
    expect(fake.leituras.filter((c) => c === 'produtos/p0')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                    the switch, the region and the conta                    */
/* -------------------------------------------------------------------------- */

describe('503 and the region — answered BEFORE any Firestore read', () => {
  it.each([
    ['unset', undefined],
    ['off', 'off'],
    ['ON (never folded)', 'ON'],
    [' on (never trimmed)', ' on'],
  ])(
    '★ AMAZON_CHAMADAS %s ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS, zero reads, one blocked line',
    async (_nome, valor) => {
      semearConta();
      const r = await enviar(corpoDe('p1'), { ambiente: { AMAZON_CHAMADAS: valor } });
      expect(r.status).toBe(503);
      expect(r.corpo).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
      expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error']);
      expect(lerDb).not.toHaveBeenCalled();
      expect(fake.operacoes).toBe(0);
      expect(criarProdutor).not.toHaveBeenCalled();
      expect(espiao.linhas.map((l) => l.meta)).toEqual([
        expect.objectContaining({
          evento: 'chamada-bloqueada',
          rota: ROTA_ENVIO_MANUAL_ESTOQUE_AMAZON,
        }),
      ]);
    },
  );

  it.each([
    [
      'missing',
      (): string => {
        throw new MissingRegionError('região ausente', ['AMAZON_TASKS_REGION', 'FUNCTIONS_REGION']);
      },
      MissingRegionError,
    ],
    ['malformed', (): string => 'regiao/errada', AmazonEstoqueRegiaoDaFilaInvalidaError],
  ])(
    '★ a %s queue region PROPAGATES before ANY read, after ONE ERROR line naming AMAZON_TASKS_REGION',
    async (_nome, regiao, classe) => {
      await expect(enviar(corpoDe('p1'), { regiao })).rejects.toBeInstanceOf(classe);
      expect(lerDb).not.toHaveBeenCalled();
      expect(criarProdutor).not.toHaveBeenCalled();
      expect(espiao.linhas.map((l) => l.nivel)).toEqual(['error']);
      expect(linhasEstoque()).toEqual([
        expect.objectContaining({
          resultado: 'falhou',
          motivo: `AMAZON_TASKS_REGION/${classe.name}`,
          conta: CONTA,
        }),
      ]);
    },
  );

  it('the switch is checked before the region (both broken ⇒ the switch answers, nothing thrown)', async () => {
    const r = await enviar(corpoDe('p1'), {
      ambiente: { AMAZON_CHAMADAS: 'off' },
      regiao: () => 'regiao/errada',
    });
    expect(r.corpo).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
  });

  it('with the queue valve CLOSED the region is never resolved (the producer would never use it)', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    const regiao = vi.fn(() => 'regiao/errada');
    const corpo = ok(await enviar(corpoDe('p1'), { filaDesligada: true, regiao }));
    expect(regiao).not.toHaveBeenCalled();
    expect(corpo.listings.map((l) => l.resultado)).toEqual(['nao-tentado']);
  });
});

describe('the conta — RAW, uncached, its depósito through the ONE parse', () => {
  it.each([
    ['no conta document', null],
    ['not an Amazon conta', { tipo: INTEGRACAO_TIPO.shopee }],
    ['an INACTIVE conta', { ativo: false }],
  ])(
    '%s ⇒ 404 AMAZON_ESTOQUE_CONTA_NAO_ENCONTRADA after ONE read, no produto read',
    async (_nome, over) => {
      if (over !== null) semearConta(over);
      produto('p1');
      vinculo('p1', 'SKU-1');
      const r = await enviar(corpoDe('p1'));
      expect(r.status).toBe(404);
      expect(recusa(r).code).toBe(CODIGO_ERRO_ESTOQUE_AMAZON.CONTA_NAO_ENCONTRADA);
      expect(Object.keys(r.corpo).sort()).toEqual(['code', 'error']);
      expect(fake.leituras).toEqual([`integracao/${CONTA}`]);
      expect(fake.consultas).toEqual([]);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('NEAR-MISS: a conta with no `ativo` stored is active (only an explicit false refuses)', async () => {
    fake.seed(`integracao/${CONTA}`, {
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta',
      depositoOuterRef: DEPOSITO,
    });
    produto('p1');
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1')));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no depósito', { depositoOuterRef: null }],
    ['another collection', { depositoOuterRef: 'documents/produtos/dep-1' }],
    ['a sub-path', { depositoOuterRef: 'documents/depositos/dep-1/x/y' }],
    ['a padded ref (never trimmed)', { depositoOuterRef: ` ${DEPOSITO}` }],
    ['not a string', { depositoOuterRef: 7 }],
  ])('%s ⇒ 400 AMAZON_ESTOQUE_CONTA_SEM_DEPOSITO, nothing more read', async (_nome, over) => {
    semearConta(over);
    produto('p1');
    vinculo('p1', 'SKU-1');
    const r = await enviar(corpoDe('p1'));
    expect(r.status).toBe(400);
    expect(recusa(r).code).toBe(CODIGO_ERRO_ESTOQUE_AMAZON.CONTA_SEM_DEPOSITO);
    expect(fake.leituras).toEqual([`integracao/${CONTA}`]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: the BARE depósito form is a depósito too (the parse takes either stored form)', async () => {
    semearConta({ depositoOuterRef: 'depositos/dep-1' });
    produto('p1');
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1')));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a depósito id outside the stock documents’ id grammar still gates OPEN: the route stores no depósito (the patch task’s plain parse, never the tick’s storable one)', async () => {
    semearConta({ depositoOuterRef: 'documents/depositos/dep.1' });
    produto('p1');
    vinculo('p1', 'SKU-1');
    ok(await enviar(corpoDe('p1')));
    expect(enfileiradas().map((t) => t.depositoId)).toEqual([null]);
  });
});

/* -------------------------------------------------------------------------- */
/*                     the queue valve and the budget                         */
/* -------------------------------------------------------------------------- */

describe('the queue valve and the 40-s budget ⇒ `nao-tentado` rows', () => {
  it('★ the valve closed ⇒ every row that would be enqueued `nao-tentado` “Fila de envio desligada.”, the producer NEVER built, one WARNING; a skipped SKU stays `pulado`', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    vinculo('p1', 'a/b', { id: 'l-barra' });
    const corpo = ok(await enviar(corpoDe('p1'), { filaDesligada: true }));
    expect(corpo.listings.map((l) => [l.sku, l.resultado, l.mensagem])).toEqual([
      ['SKU-1', 'nao-tentado', MSG['fila-desligada']],
      ['a/b', 'pulado', MSG['sem-caminho']],
    ]);
    expect(criarProdutor).not.toHaveBeenCalled();
    expect(espiao.linhas.map((l) => l.nivel)).toEqual(['warn']);
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({
        resultado: 'nada-enfileirado',
        motivo: 'fila-desligada',
        naoTentados: 1,
      }),
    ]);
  });

  it('★ the valve closing between the root’s read and the batch (the producer refuses) ⇒ the SAME rows, nothing enqueued', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    produtorReal({ desligado: true });
    const corpo = ok(await enviar(corpoDe('p1')));
    expect(corpo.listings.map((l) => [l.resultado, l.mensagem])).toEqual([
      ['nao-tentado', MSG['fila-desligada']],
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('★ a SLOW producer ⇒ no enqueue STARTS past the budget, the rest are its TAIL `nao-tentado` “Tempo esgotado: envie de novo.”, and the route still answers', async () => {
    semearConta();
    for (let i = 0; i < 30; i += 1) {
      produto(`p${String(i).padStart(2, '0')}`);
      vinculo(`p${String(i).padStart(2, '0')}`, sku(i));
    }
    const inicio = relogio;
    const iniciadasEm: number[] = [];
    enqueue.mockImplementation(() => {
      iniciadasEm.push(relogio);
      // Each enqueue takes 3 s of the route's clock.
      relogio += 3_000;
      return Promise.resolve();
    });
    const ids = Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const corpo = ok(await enviar(corpoDe(...ids)));
    const resultados = corpo.listings.map((l) => l.resultado);
    const enviados = resultados.filter((r) => r === 'enviado').length;
    expect(enviados).toBeGreaterThan(0);
    expect(enviados).toBeLessThan(30);
    // ★ The sent ones are a PREFIX; the rest, the tail, were never started.
    expect(resultados).toEqual([
      ...Array.from({ length: enviados }, () => 'enviado'),
      ...Array.from({ length: 30 - enviados }, () => 'nao-tentado'),
    ]);
    expect(corpo.listings.at(-1)?.mensagem).toBe(MSG['orcamento-esgotado']);
    expect(iniciadasEm).toHaveLength(enviados);
    for (const t of iniciadasEm) expect(t).toBeLessThan(inicio + ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS);
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({
        resultado: 'enfileirado',
        motivo: 'orcamento-esgotado',
        enfileirados: enviados,
        naoTentados: 30 - enviados,
      }),
    ]);
    expect(espiao.linhas.map((l) => l.nivel)).toEqual(['warn']);
  });

  it('★ the budget is counted from the REQUEST’s start: reads that used it all ⇒ every row `nao-tentado`, nothing enqueued (the clock moves with the READS, never with how often it is asked)', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    const gasta = () => {
      relogio += ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS;
    };
    const corpo = ok(
      await enviar(corpoDe('p1'), { db: () => dbEspiado({ depois: sobre('produtos/p1', gasta) }) }),
    );
    expect(corpo.listings.map((l) => [l.resultado, l.mensagem])).toEqual([
      ['nao-tentado', MSG['orcamento-esgotado']],
    ]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: reads that leave ONE ms of the budget ⇒ the batch still starts', async () => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
    const gasta = () => {
      relogio += ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS - 1;
    };
    const corpo = ok(
      await enviar(corpoDe('p1'), { db: () => dbEspiado({ depois: sobre('produtos/p1', gasta) }) }),
    );
    expect(corpo.listings.map((l) => l.resultado)).toEqual(['enviado']);
  });

  it(`the batch keeps at most ${String(LARGURA_LOTE_ESTOQUE_AMAZON)} enqueues in flight`, async () => {
    semearConta();
    for (let i = 0; i < 30; i += 1) {
      produto(`p${String(i)}`);
      vinculo(`p${String(i)}`, sku(i));
    }
    let emVoo = 0;
    let maximo = 0;
    enqueue.mockImplementation(async () => {
      emVoo += 1;
      maximo = Math.max(maximo, emVoo);
      await new Promise((r) => setTimeout(r, 1));
      emVoo -= 1;
    });
    ok(await enviar(corpoDe(...Array.from({ length: 30 }, (_, i) => `p${String(i)}`))));
    expect(maximo).toBe(LARGURA_LOTE_ESTOQUE_AMAZON);
  });
});

/* -------------------------------------------------------------------------- */
/*                          an enqueue that fails                             */
/* -------------------------------------------------------------------------- */

describe('an enqueue that fails for any reason but the valve PROPAGATES (rule 6; the platform answers 500)', () => {
  beforeEach(() => {
    semearConta();
    produto('p1');
    vinculo('p1', 'SKU-1');
  });

  it('★ a Cloud Tasks transient ⇒ AmazonTarefasTransitoriasError, after ONE ERROR line — never a coded answer', async () => {
    produtorReal({ falha: () => falhaDoFunctions('unavailable', 503) });
    await expect(enviar(corpoDe('p1'))).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
    expect(espiao.linhas.map((l) => l.nivel)).toEqual(['error']);
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({
        resultado: 'falhou',
        motivo: 'enfileiramento/AmazonTarefasTransitoriasError',
        referencia: REFERENCIA,
        anuncios: 1,
      }),
    ]);
  });

  it('★ a RAW SDK failure (permission-denied 403) ⇒ rethrown SANITIZED — class, code, status; no SDK instance, cause or httpResponse', async () => {
    const bruta = falhaDoFunctions('permission-denied', 403);
    produtorReal({ falha: () => bruta });
    const err: unknown = await enviar(corpoDe('p1')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AmazonEstoqueEnfileiramentoFalhouError);
    expect(err).not.toBe(bruta);
    expect(err).toMatchObject({
      falha: 'FirebaseFunctionsError/functions/permission-denied',
      httpStatus: 403,
    });
    expect(Object.keys(err as object)).not.toContain('httpResponse');
    expect((err as Error).cause).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect((err as Error).message).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({
        resultado: 'falhou',
        motivo: 'enfileiramento/FirebaseFunctionsError/functions/permission-denied',
      }),
    ]);
    expect(JSON.stringify(espiao.linhas)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  it('a missing region at the producer ⇒ MissingRegionError, untouched, after ONE ERROR line', async () => {
    const err = new MissingRegionError('região ausente', [
      'AMAZON_TASKS_REGION',
      'FUNCTIONS_REGION',
    ]);
    produtorReal({
      fila: () => {
        throw err;
      },
    });
    await expect(enviar(corpoDe('p1'))).rejects.toBe(err);
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({ resultado: 'falhou', motivo: 'enfileiramento/MissingRegionError' }),
    ]);
  });

  it('a malformed region at the producer ⇒ AmazonEstoqueRegiaoDaFilaInvalidaError (a broken deploy)', async () => {
    produtorReal({
      fila: () => {
        caminhoDaFilaEstoqueAmazon('regiao/errada');
        throw new Error('inalcançável');
      },
    });
    await expect(enviar(corpoDe('p1'))).rejects.toBeInstanceOf(
      AmazonEstoqueRegiaoDaFilaInvalidaError,
    );
    expect(linhasEstoque()).toEqual([
      expect.objectContaining({
        motivo: 'enfileiramento/AmazonEstoqueRegiaoDaFilaInvalidaError',
      }),
    ]);
  });

  it('an unnamed failure (a bug) propagates untouched, with NO line of its own', async () => {
    const bug = new TypeError('defeito');
    produtorReal({ falha: () => bug });
    await expect(enviar(corpoDe('p1'))).rejects.toBe(bug);
    expect(espiao.linhas).toEqual([]);
  });

  it('a Firestore failure on a read propagates untouched, with no line, nothing enqueued', async () => {
    const falha = new Error('leitura falhou');
    fake.falharLeitura('produtos/p1', falha);
    await expect(enviar(corpoDe('p1'))).rejects.toBe(falha);
    expect(enqueue).not.toHaveBeenCalled();
    expect(espiao.linhas).toEqual([]);
  });

  it('two failed reads ⇒ the EARLIEST in list order is rethrown (never the first in time), and only once every read has SETTLED: none left running behind the answer', async () => {
    produto('p2');
    produto('p3');
    const primeira = new Error('p1 falhou');
    const segunda = new Error('p2 falhou');
    fake.falharLeitura('produtos/p1', primeira);
    fake.falharLeitura('produtos/p2', segunda);
    let terceiraAcabou = false;
    const db = dbEspiado({
      // p2 fails FIRST in time, p1 later; p3 is the slowest read and succeeds.
      antes: async (caminho) => {
        const atraso = { 'produtos/p1': 10, 'produtos/p3': 30 }[caminho] ?? 0;
        await new Promise((r) => setTimeout(r, atraso));
      },
      depois: sobre('produtos/p3', () => {
        terceiraAcabou = true;
      }),
    });
    const err: unknown = await enviar(corpoDe('p1', 'p2', 'p3'), { db: () => db }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(primeira);
    expect(terceiraAcabou).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                      the codes, the index, the source                      */
/* -------------------------------------------------------------------------- */

describe('the contract around the ladder', () => {
  it('★ CODIGO_ERRO_ESTOQUE_AMAZON is EXHAUSTIVE in the route: every code is some arm’s answer, and no arm answers another', async () => {
    const codigos = new Set<string>();
    const tentar = async (preparar: () => void, corpo: unknown) => {
      fake = new FakeDb();
      lerDb.mockImplementation(() => asDb(fake));
      preparar();
      const r = await enviar(corpo);
      if (r.status !== 200) codigos.add(r.corpo.code);
    };
    await tentar(() => semearConta(), { integracaoId: CONTA, produtoIds: [] });
    await tentar(
      () => semearConta(),
      corpoDe(...Array.from({ length: 51 }, (_, i) => `p${String(i)}`)),
    );
    await tentar(() => undefined, corpoDe('p1'));
    await tentar(() => semearConta({ depositoOuterRef: null }), corpoDe('p1'));
    await tentar(
      () => {
        semearConta();
        for (let i = 0; i < 31; i += 1) {
          produto(`p${String(i)}`);
          vinculo(`p${String(i)}`, sku(i));
        }
      },
      corpoDe(...Array.from({ length: 31 }, (_, i) => `p${String(i)}`)),
    );
    expect([...codigos].sort()).toEqual(Object.values(CODIGO_ERRO_ESTOQUE_AMAZON).sort());
  });

  it('★ the route’s budget is 40 s: 20 s inside the web caller’s 60-s deadline, for the answer and a slow network', () => {
    const PRAZO_DO_CLIENTE_WEB_MS = 60_000;
    expect(ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS).toBe(40_000);
    expect(ORCAMENTO_ENVIO_MANUAL_ESTOQUE_MS + 20_000).toBeLessThanOrEqual(PRAZO_DO_CLIENTE_WEB_MS);
    expect(LARGURA_LEITURAS_ENVIO_MANUAL_ESTOQUE).toBe(16);
  });

  it('every sentence is pt-BR text from the table, by motivo, and ends in a full stop', () => {
    for (const [motivo, frase] of Object.entries(MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON)) {
      expect(frase, motivo).toMatch(/^[A-Z]/);
      expect(frase, motivo).toMatch(/\.$/);
    }
  });

  it('the children seek filters and orders on its index fields, in that order — the same fields the stock resolver seeks on', async () => {
    semearConta();
    produto('p1');
    ok(await enviar(corpoDe('p1')));
    const [campoPai, campoOrdem] = CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_ESTOQUE_AMAZON;
    const seek = fake.consultas.find((c) => c.colecao === 'produtos');
    expect(seek?.filtros).toEqual([[campoPai, 'p1']]);
    expect(seek?.ordens).toEqual([[campoOrdem, 'asc']]);
    expect(seek?.limite).toBeNull();
    expect([...CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_ESTOQUE_AMAZON]).toEqual([
      ...CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON,
    ]);
  });

  it('exactly ONE declared index serves the seek: COLLECTION scope on produtos, the same fields in the same order, ASC', () => {
    const indices = (
      JSON.parse(
        readFileSync(new URL('../../../../../firestore.indexes.json', import.meta.url), 'utf8'),
      ) as {
        indexes: {
          collectionGroup?: string;
          queryScope?: string;
          fields?: { fieldPath?: string; order?: string }[];
        }[];
      }
    ).indexes;
    const exato = indices.filter(
      (i) =>
        i.collectionGroup === 'produtos' &&
        i.queryScope === 'COLLECTION' &&
        JSON.stringify(i.fields) ===
          JSON.stringify(
            CAMPOS_INDICE_FILHOS_ENVIO_MANUAL_ESTOQUE_AMAZON.map((fieldPath) => ({
              fieldPath,
              order: 'ASCENDING',
            })),
          ),
    );
    expect(exato).toHaveLength(1);
  });

  it('a child stored WITHOUT `nome` is not returned by the seek (the index’s order also filters), so with only its ANCHOR selected its links are not found', async () => {
    semearConta();
    produto('ancora');
    fake.seed('produtos/sem-nome', { paiId: 'ancora' });
    vinculo('sem-nome', 'SKU-1');
    const corpo = ok(await enviar(corpoDe('ancora')));
    expect(corpo.produtosSemEnvio).toEqual([
      { produtoId: 'ancora', produtoNome: 'Produto ancora', mensagem: MSG['sem-vinculo'] },
    ]);
  });
});
