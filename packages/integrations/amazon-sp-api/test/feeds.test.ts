import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ChamadaAmazon, criarClienteSpApi, type OpcoesClienteSpApi } from '../src/client';
import { AmazonConfigError, AmazonDocumentoFeedError, AmazonSchemaError } from '../src/errors';
import { criarClienteEscritaSpApi } from '../src/escrita';
import {
  CAMINHO_DOCUMENTOS_FEED,
  CAMINHO_FEEDS,
  CONTENT_TYPE_FEED_JSON,
  criarDocumentoFeedAmazon,
  criarFeedAmazon,
  DADOS_RELATORIO_FEED,
  type DadoRelatorioFeed,
  FEED_ID_AMAZON_REGEX,
  feedAmazonSchema,
  feedCriadoSchema,
  lerDocumentoFeedAmazon,
  lerFeedAmazon,
  lerRelatorioProcessamentoListings,
  MAX_BYTES_FEED,
  MAX_MENSAGENS_FEED,
  type MensagemListingsFeed,
  montarDocumentoListingsFeed,
  OPERACAO_CRIAR_DOCUMENTO_FEED,
  OPERACAO_CRIAR_FEED,
  OPERACAO_LER_DOCUMENTO_FEED,
  OPERACAO_LER_FEED,
  type PatchListingAmazon,
  STATUS_FEED_AMAZON,
  TIPO_FEED_LISTINGS,
  VERSAO_FEED_LISTINGS,
} from '../src/feeds';
import {
  type FaixaOfertaAmazon,
  patchDisponibilidadeAmazon,
  patchOfertaAmazon,
  VERSAO_API_LISTINGS,
} from '../src/listings';
import {
  documentoFeed200,
  documentoFeedCriado201,
  feed200Concluido,
  feedCriado202,
  feedCriado202NaoDigitos,
  URL_DOCUMENTO_FEED_FALSA,
} from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  falha,
  json,
  mockFetch,
  requisicao,
  USER_AGENT,
  verificarFormaDasRequisicoesSpApi,
} from './_helpers/mockFetch';

afterEach(verificarFormaDasRequisicoesSpApi);

const SELLER = 'SELLER-TESTE';

function opcoes(fetch: typeof globalThis.fetch, eventos: ChamadaAmazon[] = []) {
  const obterCredencial = vi.fn(() => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }));
  const o: OpcoesClienteSpApi = {
    obterCredencial,
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 1_000,
    onChamada: (e) => eventos.push(e),
  };
  return { o, obterCredencial };
}

const leitor = (f: typeof globalThis.fetch) => {
  const { o, obterCredencial } = opcoes(f);
  return { c: criarClienteSpApi(o), obterCredencial };
};
const escritor = (f: typeof globalThis.fetch) => {
  const eventos: ChamadaAmazon[] = [];
  const { o, obterCredencial } = opcoes(f, eventos);
  return { c: criarClienteEscritaSpApi(o), obterCredencial, eventos };
};

function corpoEnviado(f: { mock: { calls: Parameters<typeof globalThis.fetch>[] } }): unknown {
  const body = requisicao(f).init.body;
  if (typeof body !== 'string') throw new Error('corpo não é texto');
  return JSON.parse(body) as unknown;
}

/** A stock patch as a caller builds it (test-local: the module takes any patch). */
const patchEstoque = (quantity: number): readonly PatchListingAmazon[] => [
  {
    op: 'merge',
    path: '/attributes/fulfillment_availability',
    value: [{ fulfillment_channel_code: 'DEFAULT', quantity }],
  },
];

const mensagem = (sku: string, q = 1): MensagemListingsFeed => ({ sku, patches: patchEstoque(q) });

const textoDe = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/* -------------------------------------------------------------------------- */
/*                            The SP-API operations                           */
/* -------------------------------------------------------------------------- */

describe('criarDocumentoFeedAmazon', () => {
  it('★ POSTs EXACTLY { contentType } and parses the 201', async () => {
    const f = mockFetch(() => json(documentoFeedCriado201, 201));
    const { c, eventos } = escritor(f);
    const r = await criarDocumentoFeedAmazon(c);
    expect(corpoEnviado(f)).toStrictEqual({ contentType: 'application/json; charset=UTF-8' });
    expect(CONTENT_TYPE_FEED_JSON).toBe('application/json; charset=UTF-8');
    const { init, url } = requisicao(f);
    expect(init.method).toBe('POST');
    expect(url.pathname).toBe(CAMINHO_DOCUMENTOS_FEED);
    expect(url.search).toBe('');
    expect(r.status).toBe(201);
    expect(r.dados).toMatchObject({
      feedDocumentId: '3d4e42b5-1d6e-44e8-a89c-2abfca0625bb',
      url: URL_DOCUMENTO_FEED_FALSA,
    });
    expect(eventos.map((e) => e.operacao)).toEqual([OPERACAO_CRIAR_DOCUMENTO_FEED]);
  });

  it('a 201 without the url or the id is a schema error', async () => {
    for (const corpo of [
      { feedDocumentId: 'x' },
      { url: 'https://x' },
      { feedDocumentId: '', url: 'u' },
      { feedDocumentId: 'x', url: '' },
    ]) {
      const err = await falha(
        criarDocumentoFeedAmazon(escritor(mockFetch(() => json(corpo, 201))).c),
      );
      expect(err).toBeInstanceOf(AmazonSchemaError);
    }
  });
});

describe('criarFeedAmazon', () => {
  const ESPERADO = {
    feedType: 'JSON_LISTINGS_FEED',
    marketplaceIds: ['A2Q3Y263D00KWC'],
    inputFeedDocumentId: 'doc-1',
  };

  it('★ POSTs EXACTLY three keys, the BR store alone, and parses the 202', async () => {
    const f = mockFetch(() => json(feedCriado202, 202));
    const { c, eventos } = escritor(f);
    const entrada = {
      inputFeedDocumentId: 'doc-1',
      // Extra keys a caller could hand in: none may ride along.
      feedOptions: {},
      marketplaceIds: ['ATVPDKIKX0DER'],
    };
    const r = await criarFeedAmazon(c, entrada);
    expect(corpoEnviado(f)).toStrictEqual(ESPERADO);
    expect(requisicao(f).url.pathname).toBe(CAMINHO_FEEDS);
    expect(r.status).toBe(202);
    expect(r.dados.feedId).toBe('3485934');
    expect(eventos.map((e) => e.operacao)).toEqual([OPERACAO_CRIAR_FEED]);
    expect(TIPO_FEED_LISTINGS).toBe('JSON_LISTINGS_FEED');
  });

  it.each<[string, unknown]>([
    ['feedOptions: {}', { ...ESPERADO, feedOptions: {} }],
    ['a second marketplace', { ...ESPERADO, marketplaceIds: ['A2Q3Y263D00KWC', 'ATVPDKIKX0DER'] }],
  ])('★ NEAR-MISS: %s is refused by the pin', async (_caso, quase) => {
    const f = mockFetch(() => json(feedCriado202, 202));
    await criarFeedAmazon(escritor(f).c, { inputFeedDocumentId: 'doc-1' });
    expect(corpoEnviado(f)).not.toStrictEqual(quase);
  });

  it('★ a 202 whose feedId fails the grammar is a schema error (the caller’s uncertain path)', async () => {
    const f = mockFetch(() => json(feedCriado202NaoDigitos, 202));
    const err = await falha(criarFeedAmazon(escritor(f).c, { inputFeedDocumentId: 'doc-1' }));
    expect(err).toBeInstanceOf(AmazonSchemaError);
    expect(err).toMatchObject({ status: 202, motivo: 'formato' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('an empty document id is refused (feed), nothing sent', async () => {
    const f = mockFetch(() => json(feedCriado202, 202));
    const err = await falha(criarFeedAmazon(escritor(f).c, { inputFeedDocumentId: '' }));
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect(err).toMatchObject({ motivo: 'feed', operacao: OPERACAO_CRIAR_FEED });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('FEED_ID_AMAZON_REGEX', () => {
  it.each<[string, boolean]>([
    ['3485934', true],
    ['0', true],
    ['9'.repeat(20), true],
    ['9'.repeat(21), false],
    ['', false],
    ['POST_FLAT_FILE_FBA_CREATE_REMOVAL_feed_01_SUCCESS', false],
    ['FeedId1', false],
    [' 1', false],
    ['1\n', false],
    ['１２３', false],
    ['-1', false],
  ])('★ %j → %s, by the regex, the 202 schema and lerFeedAmazon alike', async (feedId, valido) => {
    expect(FEED_ID_AMAZON_REGEX.test(feedId)).toBe(valido);
    expect(feedCriadoSchema.safeParse({ feedId }).success).toBe(valido);
    const f = mockFetch(() => json({ ...feed200Concluido, feedId }));
    const p = lerFeedAmazon(leitor(f).c, feedId);
    if (valido) {
      await p;
      expect(requisicao(f).url.pathname).toBe(`${CAMINHO_FEEDS}/${feedId}`);
    } else {
      const err = await falha(p);
      expect(err).toBeInstanceOf(AmazonConfigError);
      expect(err).toMatchObject({ motivo: 'feed', operacao: OPERACAO_LER_FEED });
      expect(f).not.toHaveBeenCalled();
    }
  });

  it('★ pins the grammar: digits only, 1 to 20, no flags', () => {
    expect(FEED_ID_AMAZON_REGEX.source).toBe('^[0-9]{1,20}$');
    expect(FEED_ID_AMAZON_REGEX.flags).toBe('');
  });
});

describe('lerFeedAmazon', () => {
  it('★ the sandbox DONE answer parses (its id replaced by digits)', async () => {
    const f = mockFetch(() => json(feed200Concluido));
    const r = await lerFeedAmazon(leitor(f).c, '3485934');
    expect(r.dados).toMatchObject({
      feedId: '3485934',
      processingStatus: STATUS_FEED_AMAZON.concluido,
      resultFeedDocumentId: 'POST_FLAT_FILE_FBA_CREATE_REMOVAL_resultDoc_success_01',
    });
    expect(requisicao(f).url.search).toBe('');
  });

  it('an unknown processingStatus parses (an open set), and every field may be absent', () => {
    expect(feedAmazonSchema.parse({ processingStatus: 'NOVO' }).processingStatus).toBe('NOVO');
    expect(feedAmazonSchema.safeParse({}).success).toBe(true);
    expect(Object.values(STATUS_FEED_AMAZON).sort()).toEqual([
      'CANCELLED',
      'DONE',
      'FATAL',
      'IN_PROGRESS',
      'IN_QUEUE',
    ]);
  });
});

describe('lerDocumentoFeedAmazon', () => {
  it('★ reads the document, encodes its id as one segment and never asks for the content-encoding header', async () => {
    const f = mockFetch(() => json(documentoFeed200));
    const r = await lerDocumentoFeedAmazon(leitor(f).c, 'a b:c');
    const { url, init } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(url.pathname).toBe(`${CAMINHO_DOCUMENTOS_FEED}/a%20b%3Ac`);
    expect(url.search).toBe('');
    expect(r.dados.url).toBe(URL_DOCUMENTO_FEED_FALSA);
    expect(r.dados.compressionAlgorithm).toBeUndefined();
  });

  it.each(['', '.', 'a/b', '..', 'a\\b'])(
    'an id that is not one segment is refused (feed), nothing sent: %j',
    async (id) => {
      const f = mockFetch(() => json(documentoFeed200));
      const err = await falha(lerDocumentoFeedAmazon(leitor(f).c, id));
      expect(err).toMatchObject({ motivo: 'feed', operacao: OPERACAO_LER_DOCUMENTO_FEED });
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('a document answer without url, or with an empty one, is a schema error', async () => {
    for (const corpo of [{ feedDocumentId: 'x' }, { feedDocumentId: 'x', url: '' }]) {
      const err = await falha(lerDocumentoFeedAmazon(leitor(mockFetch(() => json(corpo))).c, 'x'));
      expect(err).toBeInstanceOf(AmazonSchemaError);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                             The feed document                              */
/* -------------------------------------------------------------------------- */

describe('montarDocumentoListingsFeed', () => {
  it('★ the header, then messageId 1..n in input order, PATCH and PRODUCT on each', () => {
    const r = montarDocumentoListingsFeed({
      sellerId: SELLER,
      mensagens: [mensagem('C', 3), mensagem('A', 0), mensagem('B', 9)],
    });
    expect(r.mensagens).toBe(3);
    const doc = JSON.parse(textoDe(r.bytes)) as {
      header: Record<string, unknown>;
      messages: Record<string, unknown>[];
    };
    expect(doc.header).toStrictEqual({ sellerId: SELLER, version: '2.0', issueLocale: 'pt_BR' });
    expect(VERSAO_FEED_LISTINGS).toBe('2.0');
    expect(Object.keys(doc)).toEqual(['header', 'messages']);
    expect(doc.messages).toStrictEqual([
      {
        messageId: 1,
        sku: 'C',
        operationType: 'PATCH',
        productType: 'PRODUCT',
        patches: patchEstoque(3),
      },
      {
        messageId: 2,
        sku: 'A',
        operationType: 'PATCH',
        productType: 'PRODUCT',
        patches: patchEstoque(0),
      },
      {
        messageId: 3,
        sku: 'B',
        operationType: 'PATCH',
        productType: 'PRODUCT',
        patches: patchEstoque(9),
      },
    ]);
  });

  it('★ is minified: no whitespace outside the strings, the bytes equal one compact serialisation', () => {
    const r = montarDocumentoListingsFeed({ sellerId: SELLER, mensagens: [mensagem('A b')] });
    const texto = textoDe(r.bytes);
    expect(texto).toBe(JSON.stringify(JSON.parse(texto)));
    expect(texto.replace('"A b"', '')).not.toMatch(/\s/);
  });

  it('copies the patches by named keys: a patch without value stays without one', () => {
    const r = montarDocumentoListingsFeed({
      sellerId: SELLER,
      mensagens: [{ sku: 'A', patches: [{ op: 'delete', path: '/attributes/x' }] }],
    });
    const doc = JSON.parse(textoDe(r.bytes)) as { messages: { patches: unknown[] }[] };
    expect(doc.messages[0]?.patches).toStrictEqual([{ op: 'delete', path: '/attributes/x' }]);
  });

  it.each<[string, () => Parameters<typeof montarDocumentoListingsFeed>[0]]>([
    ['zero messages', () => ({ sellerId: SELLER, mensagens: [] })],
    [
      'a duplicate SKU',
      () => ({ sellerId: SELLER, mensagens: [mensagem('A'), mensagem('B'), mensagem('A')] }),
    ],
    ['an empty SKU', () => ({ sellerId: SELLER, mensagens: [mensagem('')] })],
    [
      'a message without patches',
      () => ({ sellerId: SELLER, mensagens: [{ sku: 'A', patches: [] }] }),
    ],
    ['an empty sellerId', () => ({ sellerId: '', mensagens: [mensagem('A')] })],
    [
      `${String(MAX_MENSAGENS_FEED + 1)} messages`,
      () => ({
        sellerId: SELLER,
        mensagens: Array.from({ length: MAX_MENSAGENS_FEED + 1 }, (_, i) =>
          mensagem(`S${String(i)}`),
        ),
      }),
    ],
  ])('★ refuses %s (feed), whole', (_caso, entrada) => {
    let err: unknown;
    try {
      montarDocumentoListingsFeed(entrada());
    } catch (e) {
      if (!(e instanceof AmazonConfigError)) throw e;
      err = e;
    }
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect(err).toMatchObject({ motivo: 'feed', refCredencial: null });
  });

  it('★ NEAR-MISS: exactly 25,000 messages are accepted', () => {
    expect(MAX_MENSAGENS_FEED).toBe(25_000);
    const r = montarDocumentoListingsFeed({
      sellerId: SELLER,
      mensagens: Array.from({ length: MAX_MENSAGENS_FEED }, (_, i) => mensagem(`S${String(i)}`)),
    });
    expect(r.mensagens).toBe(MAX_MENSAGENS_FEED);
    const doc = JSON.parse(textoDe(r.bytes)) as { messages: { messageId: number }[] };
    expect(doc.messages.at(-1)?.messageId).toBe(MAX_MENSAGENS_FEED);
  });

  describe('★ the byte limit is on UTF-8 BYTES, built with one long multi-byte SKU', () => {
    /** The size of a one-message document whose SKU is `sku`. */
    const tamanho = (sku: string) =>
      montarDocumentoListingsFeed({ sellerId: SELLER, mensagens: [mensagem(sku)] }).bytes
        .byteLength;
    /** A SKU of `é` (2 bytes, 1 character) and `a` padding that makes the document `alvo` bytes. */
    const skuPara = (alvo: number): string => {
      const base = tamanho('a') - 1;
      const resto = alvo - base;
      return 'é'.repeat(Math.floor(resto / 2)) + 'a'.repeat(resto % 2);
    };

    it('exactly MAX_BYTES_FEED bytes is accepted', () => {
      expect(MAX_BYTES_FEED).toBe(9_500_000);
      const sku = skuPara(MAX_BYTES_FEED);
      const r = montarDocumentoListingsFeed({ sellerId: SELLER, mensagens: [mensagem(sku)] });
      expect(r.bytes.byteLength).toBe(MAX_BYTES_FEED);
    });

    it('MAX_BYTES_FEED + 1 bytes is refused, though it holds far fewer CHARACTERS', () => {
      const sku = skuPara(MAX_BYTES_FEED + 1);
      const caracteres = JSON.stringify({ sku }).length;
      expect(caracteres).toBeLessThan(MAX_BYTES_FEED / 2 + 1_000);
      let err: unknown;
      try {
        montarDocumentoListingsFeed({ sellerId: SELLER, mensagens: [mensagem(sku)] });
      } catch (e) {
        if (!(e instanceof AmazonConfigError)) throw e;
        err = e;
      }
      expect(err).toMatchObject({ motivo: 'feed' });
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                   The committed schemas (structural pins)                  */
/* -------------------------------------------------------------------------- */

const ARQUIVO_SANDBOX = new URL('./_fixtures/sandbox.ts', import.meta.url);
const ESQUEMA_FEED = new URL('./_fixtures/listings-feed-schema-v2.json', import.meta.url);
const ESQUEMA_RELATORIO = new URL(
  './_fixtures/listings-feed-processing-report-schema-v2.json',
  import.meta.url,
);

/** The sha256 the provenance comment in `sandbox.ts` names for `nome`. */
function sha256DaProveniencia(nome: string): string | undefined {
  const fonte = readFileSync(ARQUIVO_SANDBOX, 'utf8');
  const escapado = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\`${escapado}\` —[\\s\\S]*?sha256 \`([0-9a-f]{64})\``).exec(fonte)?.[1];
}

interface EsquemaJson {
  readonly [chave: string]: unknown;
}

function ler(url: URL): EsquemaJson {
  return JSON.parse(readFileSync(url, 'utf8')) as EsquemaJson;
}

/** A nested object of a JSON schema, by keys, failing loudly when absent. */
function em(raiz: unknown, ...chaves: string[]): EsquemaJson {
  let atual: unknown = raiz;
  for (const k of chaves) {
    if (typeof atual !== 'object' || atual === null) throw new Error(`sem ${k}`);
    atual = (atual as EsquemaJson)[k];
  }
  if (typeof atual !== 'object' || atual === null) throw new Error(`sem ${chaves.join('.')}`);
  return atual as EsquemaJson;
}

describe('★ the committed listings-feed schemas', () => {
  it.each([
    ['listings-feed-schema-v2.json', ESQUEMA_FEED],
    ['listings-feed-processing-report-schema-v2.json', ESQUEMA_RELATORIO],
  ])('%s: its bytes hash to the provenance comment’s sha256', (nome, url) => {
    const esperado = sha256DaProveniencia(nome);
    expect(esperado, nome).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(readFileSync(url)).digest('hex')).toBe(esperado);
  });

  const feed = ler(ESQUEMA_FEED);
  const mensagemDoEsquema = em(feed, 'properties', 'messages', 'items');
  const ramos = mensagemDoEsquema.oneOf as readonly EsquemaJson[];
  const ramoPatch = ramos.find((r) => em(r, 'properties', 'operationType').const === 'PATCH');

  it('pins what the builder relies on: the message cap, the header, the version, messageId and the PATCH branch', () => {
    expect(em(feed, 'properties', 'messages').maxItems).toBe(MAX_MENSAGENS_FEED);
    expect(em(feed, 'properties', 'header').required).toEqual(
      expect.arrayContaining(['sellerId', 'version']),
    );
    expect(em(feed, 'properties', 'header', 'properties', 'version').const).toBe(
      VERSAO_FEED_LISTINGS,
    );
    const messageId = em(mensagemDoEsquema, 'properties', 'messageId');
    expect(messageId).toMatchObject({ type: 'integer', minimum: 1, maximum: 2147483647 });
    expect(em(mensagemDoEsquema, 'properties', 'operationType').enum).toContain('PATCH');
    expect(mensagemDoEsquema.required).toEqual(['messageId', 'sku', 'operationType']);
    expect(ramoPatch).toBeDefined();
    expect(ramoPatch?.required).toEqual(['productType', 'patches']);
    expect(em(ramoPatch, 'properties').attributes).toBe(false);
    expect(em(ramoPatch, 'properties').requirements).toBe(false);
    expect(
      em(mensagemDoEsquema, 'properties', 'patches', 'items', 'properties', 'op').enum,
    ).toContain('merge');
  });

  it('every built message satisfies those rules (a hand-written structural check)', () => {
    const r = montarDocumentoListingsFeed({
      sellerId: SELLER,
      mensagens: [
        mensagem('A', 0),
        mensagem('B', 5),
        { sku: 'C', patches: [{ op: 'delete', path: '/x' }] },
      ],
    });
    const doc = JSON.parse(textoDe(r.bytes)) as { header: EsquemaJson; messages: EsquemaJson[] };
    const cabecalho = em(feed, 'properties', 'header');
    for (const k of cabecalho.required as string[]) expect(doc.header).toHaveProperty(k);
    expect(Object.keys(doc.header).every((k) => k in em(cabecalho, 'properties'))).toBe(true);
    const permitidas = Object.keys(em(mensagemDoEsquema, 'properties'));
    const ops = em(mensagemDoEsquema, 'properties', 'patches', 'items', 'properties', 'op')
      .enum as string[];
    const ids = new Set<unknown>();
    for (const m of doc.messages) {
      for (const k of [
        ...(mensagemDoEsquema.required as string[]),
        ...(ramoPatch?.required as string[]),
      ]) {
        expect(m).toHaveProperty(k);
      }
      expect(Object.keys(m).every((k) => permitidas.includes(k))).toBe(true);
      expect(m).not.toHaveProperty('attributes');
      expect(m).not.toHaveProperty('requirements');
      expect(m.operationType).toBe('PATCH');
      const id = m.messageId as number;
      expect(Number.isInteger(id) && id >= 1 && id <= 2147483647).toBe(true);
      ids.add(id);
      expect(typeof m.sku === 'string' && m.sku.length >= 1).toBe(true);
      expect(typeof m.productType === 'string' && m.productType.length >= 1).toBe(true);
      const patches = m.patches as EsquemaJson[];
      expect(patches.length).toBeGreaterThanOrEqual(1);
      for (const p of patches) {
        expect(ops).toContain(p.op);
        expect(typeof p.path).toBe('string');
        if ('value' in p) expect(Array.isArray(p.value)).toBe(true);
      }
    }
    expect(ids.size).toBe(doc.messages.length);
  });

  it('pins what the report parser relies on: summary’s five counts required, an issue needs only severity and message', () => {
    const relatorio = ler(ESQUEMA_RELATORIO);
    expect(relatorio.required).toEqual(['header', 'issues', 'summary']);
    expect(em(relatorio, 'properties', 'summary').required).toEqual([
      'errors',
      'warnings',
      'messagesProcessed',
      'messagesAccepted',
      'messagesInvalid',
    ]);
    const issue = em(relatorio, 'properties', 'issues', 'items');
    expect(issue.required).toEqual(['severity', 'message']);
    expect(Object.keys(em(issue, 'properties')).sort()).toEqual([
      'attributeName',
      'code',
      'message',
      'messageId',
      'severity',
      'sku',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                           The processing report                            */
/* -------------------------------------------------------------------------- */

describe('lerRelatorioProcessamentoListings', () => {
  const SENTINELA = 'SENTINELA-DO-RELATORIO-nunca-no-erro';
  const relatorio = {
    header: { sellerId: SELLER, version: '2.0', feedId: '3485934' },
    issues: [
      {
        messageId: 1,
        sku: 'A',
        code: '90220',
        severity: 'ERROR',
        message: 'x',
        attributeName: 'size',
      },
      // An issue tied to no message (a feed formatting issue): no messageId, sku or code.
      { severity: 'ERROR', message: `${SENTINELA} formato` },
    ],
    summary: {
      errors: 2,
      warnings: 0,
      messagesProcessed: 3,
      messagesAccepted: 2,
      messagesInvalid: 1,
    },
  };

  it('★ parses a report whose issue lacks messageId, sku and code', () => {
    const r = lerRelatorioProcessamentoListings(JSON.stringify(relatorio));
    expect(r.summary).toMatchObject({ errors: 2, messagesAccepted: 2, messagesInvalid: 1 });
    expect(r.issues?.[0]).toMatchObject({ messageId: 1, sku: 'A', code: '90220' });
    expect(r.issues?.[1]?.sku).toBeUndefined();
    expect(r.issues?.[1]?.messageId).toBeUndefined();
  });

  it.each([
    'errors',
    'warnings',
    'messagesProcessed',
    'messagesAccepted',
    'messagesInvalid',
  ] as const)(
    'every count goes through wireInt: a quoted "3" in %s reads 3, a fractional one fails',
    (campo) => {
      const quoted = { ...relatorio, summary: { ...relatorio.summary, [campo]: '3' } };
      expect(lerRelatorioProcessamentoListings(JSON.stringify(quoted)).summary[campo]).toBe(3);
      const fracionado = { ...relatorio, summary: { ...relatorio.summary, [campo]: 1.5 } };
      expect(() => lerRelatorioProcessamentoListings(JSON.stringify(fracionado))).toThrow(
        AmazonDocumentoFeedError,
      );
    },
  );

  it('an issue’s messageId goes through wireInt too: a quoted "7" reads 7', () => {
    const quoted = { ...relatorio, issues: [{ ...relatorio.issues[0], messageId: '7' }] };
    expect(lerRelatorioProcessamentoListings(JSON.stringify(quoted)).issues?.[0]?.messageId).toBe(
      7,
    );
  });

  it.each<[string, string, string]>([
    ['a report without summary', JSON.stringify({ header: {}, issues: [] }), 'relatorio-invalido'],
    [
      'a summary missing a count',
      JSON.stringify({ ...relatorio, summary: { errors: 0, warnings: 0 } }),
      'relatorio-invalido',
    ],
    ['an array', '[]', 'relatorio-invalido'],
    ['not JSON', `${SENTINELA} <html>`, 'json-invalido'],
    ['empty', '', 'json-invalido'],
  ])('★ refuses %s with its motivo, echoing no byte of it', (_caso, texto, motivo) => {
    let err: unknown;
    try {
      lerRelatorioProcessamentoListings(texto);
    } catch (e) {
      if (!(e instanceof AmazonDocumentoFeedError)) throw e;
      err = e;
    }
    expect(err).toBeInstanceOf(AmazonDocumentoFeedError);
    expect(err).toMatchObject({ motivo });
    expect(JSON.stringify(err)).not.toContain(SENTINELA);
    expect((err as Error).message).not.toContain(SENTINELA);
  });

  it('NEAR-MISS: a report with an empty issue list and no header parses', () => {
    const r = lerRelatorioProcessamentoListings(JSON.stringify({ summary: relatorio.summary }));
    expect(r.summary.messagesProcessed).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*            A message's product type, the report header, the items          */
/* -------------------------------------------------------------------------- */

const FAIXA: FaixaOfertaAmazon = { base: 129.9, minimo: 119.9, maximo: 129.9 };

/** Refused by the document builder: the thrown config error, or a failure. */
function recusaDoDocumento(entrada: Parameters<typeof montarDocumentoListingsFeed>[0]) {
  try {
    montarDocumentoListingsFeed(entrada);
  } catch (e) {
    if (e instanceof AmazonConfigError) return e;
    throw e;
  }
  throw new Error('esperava uma recusa');
}

interface DocumentoLido {
  readonly header: EsquemaJson;
  readonly messages: EsquemaJson[];
}

const documentoDe = (entrada: Parameters<typeof montarDocumentoListingsFeed>[0]): DocumentoLido =>
  JSON.parse(textoDe(montarDocumentoListingsFeed(entrada).bytes)) as DocumentoLido;

/** The stock document of one message, byte for byte: a golden, since a change here moves every stock feed. */
const DOCUMENTO_ESTOQUE_A3 =
  '{"header":{"sellerId":"SELLER-TESTE","version":"2.0","issueLocale":"pt_BR"},"messages":[{"messageId":1,"sku":"A","operationType":"PATCH","productType":"PRODUCT","patches":[{"op":"merge","path":"/attributes/fulfillment_availability","value":[{"fulfillment_channel_code":"DEFAULT","quantity":3}]}]}]}';

describe('montarDocumentoListingsFeed: a message’s product type', () => {
  it('★ a message with productType carries it; one without carries PRODUCT', () => {
    const doc = documentoDe({
      sellerId: SELLER,
      mensagens: [
        { sku: 'A', productType: 'LUGGAGE', patches: [patchOfertaAmazon(FAIXA)] },
        mensagem('B', 2),
      ],
    });
    expect(doc.messages.map((m) => [m.sku, m.productType])).toEqual([
      ['A', 'LUGGAGE'],
      ['B', 'PRODUCT'],
    ]);
  });

  it('★ the stock document’s bytes did not move, and the package’s stock builder builds the same bytes', () => {
    const bytes = (patches: readonly PatchListingAmazon[]) =>
      textoDe(
        montarDocumentoListingsFeed({ sellerId: SELLER, mensagens: [{ sku: 'A', patches }] }).bytes,
      );
    expect(bytes(patchEstoque(3))).toBe(DOCUMENTO_ESTOQUE_A3);
    expect(bytes([patchDisponibilidadeAmazon(3)])).toBe(DOCUMENTO_ESTOQUE_A3);
    // NEAR-MISS: another quantity is other bytes.
    expect(bytes([patchDisponibilidadeAmazon(4)])).not.toBe(DOCUMENTO_ESTOQUE_A3);
  });

  it('★ an offer message carries the offer patch whole, under the listing’s type', () => {
    const doc = documentoDe({
      sellerId: SELLER,
      mensagens: [{ sku: 'A', productType: 'LUGGAGE', patches: [patchOfertaAmazon(FAIXA)] }],
    });
    expect(doc.messages).toStrictEqual([
      {
        messageId: 1,
        sku: 'A',
        operationType: 'PATCH',
        productType: 'LUGGAGE',
        patches: [patchOfertaAmazon(FAIXA)],
      },
    ]);
  });

  it.each<[string, unknown]>([
    ['lower case', 'luggage'],
    ['empty', ''],
    ['padded', ' LUGGAGE'],
    ['a hyphen', 'SHOE-X'],
    ['65 characters', `A${'B'.repeat(64)}`],
    ['null (a cast)', null],
    ['a number (a cast)', 1],
    // A regex test would coerce this to "LUGGAGE": only a string is a product type.
    ['an array (a cast)', ['LUGGAGE']],
  ])('★ NEAR-MISS: a product type %s refuses the document whole (feed)', (_caso, productType) => {
    const err = recusaDoDocumento({
      sellerId: SELLER,
      mensagens: [mensagem('A'), { ...mensagem('B'), productType: productType as string }],
    });
    expect(err).toMatchObject({ motivo: 'feed', refCredencial: null });
  });
});

describe('montarDocumentoListingsFeed: the report header', () => {
  it('★ relatorio asks the report for each item’s issues: { includedData: [issues], apiVersion }', () => {
    const doc = documentoDe({
      sellerId: SELLER,
      mensagens: [mensagem('A')],
      relatorio: { incluir: [DADOS_RELATORIO_FEED.issues] },
    });
    expect(doc.header).toStrictEqual({
      sellerId: SELLER,
      version: '2.0',
      issueLocale: 'pt_BR',
      report: { includedData: ['issues'], apiVersion: '2021-08-01' },
    });
    expect(VERSAO_API_LISTINGS).toBe('2021-08-01');
    expect(DADOS_RELATORIO_FEED).toStrictEqual({ issues: 'issues' });
  });

  it('★ NEAR-MISS: no relatorio, no report key at all (the bytes are the stock document’s)', () => {
    const doc = documentoDe({ sellerId: SELLER, mensagens: [mensagem('A')] });
    expect(Object.keys(doc.header)).toEqual(['sellerId', 'version', 'issueLocale']);
    expect(
      textoDe(
        montarDocumentoListingsFeed({ sellerId: SELLER, mensagens: [mensagem('A', 3)] }).bytes,
      ),
    ).toBe(DOCUMENTO_ESTOQUE_A3);
  });

  it.each<[string, readonly DadoRelatorioFeed[]]>([
    ['an empty list (the schema’s minItems is 1)', []],
    ['only a dataset the closed set does not name (a cast)', ['offers' as DadoRelatorioFeed]],
  ])('★ NEAR-MISS: relatorio with %s refuses the document (feed)', (_caso, incluir) => {
    expect(
      recusaDoDocumento({ sellerId: SELLER, mensagens: [mensagem('A')], relatorio: { incluir } }),
    ).toMatchObject({ motivo: 'feed' });
  });

  it('a repeated or a cast dataset beside a known one is written once, from the constants', () => {
    const doc = documentoDe({
      sellerId: SELLER,
      mensagens: [mensagem('A')],
      relatorio: { incluir: ['offers' as DadoRelatorioFeed, 'issues', 'issues'] },
    });
    expect(doc.header.report).toStrictEqual({ includedData: ['issues'], apiVersion: '2021-08-01' });
  });
});

describe('★ the committed feed schemas: the report header, the offer message, the report items', () => {
  const feed = ler(ESQUEMA_FEED);
  const cabecalho = em(feed, 'properties', 'header');
  const report = em(cabecalho, 'properties', 'report');
  const mensagemDoEsquema = em(feed, 'properties', 'messages', 'items');
  const ramoPatch = (mensagemDoEsquema.oneOf as readonly EsquemaJson[]).find(
    (r) => em(r, 'properties', 'operationType').const === 'PATCH',
  );

  it('pins what the header builder relies on: report’s two required keys, includedData’s minItems and enum, apiVersion’s enum', () => {
    expect(report.type).toBe('object');
    expect(report.required).toEqual(['includedData', 'apiVersion']);
    const includedData = em(report, 'properties', 'includedData');
    expect(includedData).toMatchObject({ type: 'array', minItems: 1 });
    expect(em(includedData, 'items').enum).toEqual(
      expect.arrayContaining(Object.values(DADOS_RELATORIO_FEED)),
    );
    expect(em(report, 'properties', 'apiVersion').enum).toEqual([VERSAO_API_LISTINGS]);
    expect(em(mensagemDoEsquema, 'properties', 'productType')).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(ramoPatch?.required).toEqual(['productType', 'patches']);
  });

  it('a header with a report and offer messages satisfy those rules (a hand-written structural check)', () => {
    const doc = documentoDe({
      sellerId: SELLER,
      mensagens: [
        { sku: 'A', productType: 'LUGGAGE', patches: [patchOfertaAmazon(FAIXA)] },
        {
          sku: 'B',
          productType: 'HOME_BED_AND_BATH',
          patches: [patchOfertaAmazon({ base: 10, minimo: 10, maximo: 10 })],
        },
        mensagem('C', 1),
      ],
      relatorio: { incluir: [DADOS_RELATORIO_FEED.issues] },
    });
    for (const k of cabecalho.required as string[]) expect(doc.header).toHaveProperty(k);
    expect(Object.keys(doc.header).every((k) => k in em(cabecalho, 'properties'))).toBe(true);
    const lido = em(doc.header, 'report');
    for (const k of report.required as string[]) expect(lido).toHaveProperty(k);
    expect(Object.keys(lido).every((k) => k in em(report, 'properties'))).toBe(true);
    const permitidos = em(report, 'properties', 'includedData', 'items').enum as string[];
    const dados = lido.includedData as string[];
    expect(dados.length).toBeGreaterThanOrEqual(1);
    for (const d of dados) expect(permitidos).toContain(d);
    expect(em(report, 'properties', 'apiVersion').enum).toContain(lido.apiVersion);

    const permitidas = Object.keys(em(mensagemDoEsquema, 'properties'));
    const ops = em(mensagemDoEsquema, 'properties', 'patches', 'items', 'properties', 'op')
      .enum as string[];
    for (const m of doc.messages) {
      for (const k of [
        ...(mensagemDoEsquema.required as string[]),
        ...(ramoPatch?.required as string[]),
      ]) {
        expect(m).toHaveProperty(k);
      }
      expect(Object.keys(m).every((k) => permitidas.includes(k))).toBe(true);
      expect(typeof m.productType === 'string' && m.productType.length >= 1).toBe(true);
      for (const p of m.patches as EsquemaJson[]) {
        expect(ops).toContain(p.op);
        expect(typeof p.path).toBe('string');
        expect(Array.isArray(p.value)).toBe(true);
        for (const v of p.value as unknown[]) {
          expect(typeof v === 'object' && v !== null && !Array.isArray(v)).toBe(true);
        }
      }
    }
  });

  it('pins what the report parser relies on for items: a list of objects, none of whose keys is required', () => {
    const relatorio = ler(ESQUEMA_RELATORIO);
    expect(relatorio.required).not.toContain('items');
    const items = em(relatorio, 'properties', 'items');
    expect(items.type).toBe('array');
    const item = em(items, 'items');
    expect(item).toMatchObject({ type: 'object', additionalProperties: true });
    expect(item.required).toBeUndefined();
  });
});

describe('lerRelatorioProcessamentoListings: the items', () => {
  const resumo = {
    errors: 0,
    warnings: 1,
    messagesProcessed: 1,
    messagesAccepted: 1,
    messagesInvalid: 0,
  };

  it('★ a report whose item carries price issues parses, categories kept', () => {
    const r = lerRelatorioProcessamentoListings(
      JSON.stringify({
        header: { sellerId: SELLER, version: '2.0', feedId: '3485934' },
        issues: [],
        summary: resumo,
        items: [
          {
            sku: 'A',
            issues: [
              {
                code: '19037',
                message: 'x',
                severity: 'ERROR',
                attributeNames: ['purchasable_offer'],
                categories: ['INVALID_PRICE'],
              },
            ],
            status: ['BUYABLE'],
          },
        ],
      }),
    );
    expect(r.items).toHaveLength(1);
    expect(r.items?.[0]).toMatchObject({
      sku: 'A',
      issues: [{ code: '19037', severity: 'ERROR', categories: ['INVALID_PRICE'] }],
    });
    // `.passthrough()`: a key the package does not read is kept.
    expect(r.items?.[0]).toHaveProperty('status', ['BUYABLE']);
  });

  it('★ NEAR-MISS: a report without items parses, with items absent', () => {
    const r = lerRelatorioProcessamentoListings(JSON.stringify({ issues: [], summary: resumo }));
    expect(r.items).toBeUndefined();
  });

  it('an item without sku or issues parses (Amazon requires no key of an item)', () => {
    const r = lerRelatorioProcessamentoListings(
      JSON.stringify({ summary: resumo, items: [{ attributes: {} }, { sku: 'B' }] }),
    );
    expect(r.items?.map((i) => i.sku)).toEqual([undefined, 'B']);
  });

  it('★ an explicit null for items, or for an item’s issues, parses as null (both are nullish)', () => {
    expect(
      lerRelatorioProcessamentoListings(JSON.stringify({ summary: resumo, items: null })).items,
    ).toBeNull();
    const r = lerRelatorioProcessamentoListings(
      JSON.stringify({ summary: resumo, items: [{ sku: 'A', issues: null }] }),
    );
    expect(r.items).toStrictEqual([{ sku: 'A', issues: null }]);
  });

  it.each<[string, unknown]>([
    ['items as an object', { a: 1 }],
    ['an item whose sku is a number', [{ sku: 123 }]],
    ['an item issue whose categories is a string', [{ sku: 'A', issues: [{ categories: 'X' }] }]],
    ['an item whose issues is not a list', [{ sku: 'A', issues: { code: '1' } }]],
  ])('★ %s is relatorio-invalido, never a silent drop', (_caso, items) => {
    let err: unknown;
    try {
      lerRelatorioProcessamentoListings(JSON.stringify({ summary: resumo, items }));
    } catch (e) {
      if (!(e instanceof AmazonDocumentoFeedError)) throw e;
      err = e;
    }
    expect(err).toMatchObject({ motivo: 'relatorio-invalido' });
  });
});
