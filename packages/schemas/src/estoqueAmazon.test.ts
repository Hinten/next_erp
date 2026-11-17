import { describe, expect, it } from 'vitest';
import * as modulo from './estoqueAmazon';
import {
  CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX,
  CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON,
  CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON,
  CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX,
  FASE_RECONCILIACAO_ESTOQUE_AMAZON,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON,
  MAX_ITENS_DIVERGENCIA_ESTOQUE_AMAZON,
  MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON,
  REF_DEPOSITO_ESTOQUE_AMAZON_REGEX,
  contagensReconciliacaoEstoqueAmazonSchema,
  cursorVarreduraEstoqueAmazonSchema,
  divergenciaEstoqueAmazonSchema,
  faseReconciliacaoEstoqueAmazonSchema,
  idDivergenciaEstoqueAmazon,
  itemDivergenciaEstoqueAmazonSchema,
  pedidoReconciliacaoEstoqueAmazonSchema,
  reconciliacaoEstoqueAmazonSchema,
  sincronizacaoEstoqueAmazonSchema,
  vezSincronizacaoEstoqueAmazonSchema,
} from './estoqueAmazon';
import { ID_LOTE_FEED_AMAZON_REGEX, registroFeedAmazonSchema } from './feedAmazon';
import * as barrel from './index';
import { produtoAmazonLinkSchema } from './produto/collection/amazonLink';
import { estoqueProdutoSchema } from './produto/collection/estoque';
import { ALL_DOMAINS } from './registry';
import { millisSinceEpoch } from './shared/datetime';
import { TTL_FIELD, TTL_POLICIES, expiraEmApos, ttlExpiry } from './shared/ttl';

const AGORA = 1_800_000_000_000;
const DEPOSITO = 'documents/depositos/dep-1';

/** Shaped like `firebase-admin`'s and `firebase/firestore`'s `Timestamp` alike. */
function timestampFalso(ms: number) {
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

/** The fields a reconcile run is claimed with (the rest default). */
const RUN = {
  execucaoId: 'f'.repeat(64),
  fase: FASE_RECONCILIACAO_ESTOQUE_AMAZON.varrendo,
  depositoOuterRef: DEPOSITO,
  iniciadaEmMs: AGORA,
};

const ITEM = { sku: 'SKU-1', unidadeId: 'prod-1', quantidadeAmazon: 3, quantidadeErp: 5 };

/** A drift block as its page writes it. */
const BLOCO = {
  execucaoId: 'run-1',
  depositoOuterRef: DEPOSITO,
  itens: [ITEM],
  expiraEm: expiraEmApos(AGORA, 7),
};

describe('★ the batch numbers', () => {
  it('THE SWITCH is 30: the largest batch sent as patches (NEAR-MISS: the old 1,500 reds)', () => {
    expect(LIMIAR_FEED_ESTOQUE_AMAZON).toBe(30);
    expect(LIMIAR_FEED_ESTOQUE_AMAZON).not.toBe(1_500);
  });

  it('the window-batch bound is 3,000: the tick’s own cap of 10 pages of 300 rows', () => {
    expect(MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON).toBe(3_000);
    expect(MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON).toBe(10 * MAX_ITENS_DIVERGENCIA_ESTOQUE_AMAZON);
  });

  it('the catalogue-zero floor is 1,500, pinned APART from the switch (a change to one never moves the other)', () => {
    expect(LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON).toBe(1_500);
    expect(LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON).not.toBe(LIMIAR_FEED_ESTOQUE_AMAZON);
  });

  it('a drift block holds at most 300 SKUs, one walk page', () => {
    expect(MAX_ITENS_DIVERGENCIA_ESTOQUE_AMAZON).toBe(300);
  });
});

describe('the index-field tuples (typed against the schemas; pinned to firestore.indexes.json by their readers)', () => {
  it('the tick’s window: the depósito, then the stamp', () => {
    expect(CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON).toEqual(['depositoOuterRef', 'ultimaModificacao']);
    for (const campo of CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON) {
      expect(Object.keys(estoqueProdutoSchema.shape), campo).toContain(campo);
    }
  });

  it('the reconcile’s walk: the conta ref alone (paged by key)', () => {
    expect(CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON).toEqual(['contaAmazonOuterRef']);
    for (const campo of CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON) {
      expect(Object.keys(produtoAmazonLinkSchema.shape), campo).toContain(campo);
    }
  });
});

describe('the grammars', () => {
  it('a depósito ref is stored CANONICAL: the bare form, another collection or a sub-path is refused', () => {
    expect(REF_DEPOSITO_ESTOQUE_AMAZON_REGEX.test(DEPOSITO)).toBe(true);
    expect(REF_DEPOSITO_ESTOQUE_AMAZON_REGEX.test('documents/depositos/AbC_09-x')).toBe(true);
    for (const nao of [
      'depositos/dep-1',
      '/documents/depositos/dep-1',
      'documents/depositos/',
      'documents/deposito/dep-1',
      'documents/integracao/dep-1',
      'documents/depositos/dep-1/estoques/x',
      'documents/depositos/dep 1',
      `documents/depositos/${'x'.repeat(129)}`,
    ]) {
      expect(REF_DEPOSITO_ESTOQUE_AMAZON_REGEX.test(nao), nao).toBe(false);
    }
  });

  it('the ref’s id is exactly the id grammar a stock task’s depositoId carries', () => {
    for (const id of ['dep-1', 'A_b-9', 'x'.repeat(128), 'x'.repeat(129), 'a/b', 'a:b', '']) {
      expect(REF_DEPOSITO_ESTOQUE_AMAZON_REGEX.test(`documents/depositos/${id}`), id).toBe(
        ID_LOTE_FEED_AMAZON_REGEX.test(id),
      );
    }
  });

  it('a walk cursor is a link doc path: produtos/<id>/prodAmazon/<id>, no prefix', () => {
    expect(CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX.test('produtos/p1/prodAmazon/l1')).toBe(true);
    for (const nao of [
      'documents/produtos/p1/prodAmazon/l1',
      'produtos/p1/prodShopee/l1',
      'produtos/p1/prodAmazon',
      'produtos/p1/prodAmazon/l1/x/y',
      'produtos//prodAmazon/l1',
    ]) {
      expect(CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX.test(nao), nao).toBe(false);
    }
  });

  it('a counter key is a token: a motivo or a camelCase counter, never free text', () => {
    for (const ok of ['pai-do-vinculo-ilegivel', 'confirmadoPorGet', 'afn']) {
      expect(CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX.test(ok), ok).toBe(true);
    }
    for (const nao of ['', '1afn', 'a b', 'a.b', 'a/b', 'x'.repeat(65)]) {
      expect(CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX.test(nao), nao).toBe(false);
    }
  });
});

describe('sincronizacaoEstoqueAmazonSchema', () => {
  it('an empty document parses to the defaults: no cursor, no depósito, no lease, no failure', () => {
    expect(sincronizacaoEstoqueAmazonSchema.parse({})).toEqual({
      cursorMs: null,
      depositoDoCursor: null,
      vez: null,
      ultimoTickMs: null,
      falhasSeguidas: 0,
      semDeposito: false,
    });
  });

  it('a full document round-trips', () => {
    const doc = {
      cursorMs: AGORA - 300_000,
      depositoDoCursor: DEPOSITO,
      vez: { execucaoId: 'tick-1', ateMs: AGORA + 270_000 },
      ultimoTickMs: AGORA - 290_000,
      falhasSeguidas: 2,
      semDeposito: true,
    };
    expect(sincronizacaoEstoqueAmazonSchema.parse(doc)).toEqual(doc);
  });

  it.each([
    ['a µs-looking fractional cursor', { cursorMs: AGORA + 0.5 }],
    ['a negative cursor', { cursorMs: -1 }],
    ['a cursor written as a digit string (no coercion)', { cursorMs: String(AGORA) }],
    ['a bare depósito ref', { depositoDoCursor: 'depositos/dep-1' }],
    ['a lease without its expiry', { vez: { execucaoId: 'tick-1' } }],
    ['a lease whose run id is not an id', { vez: { execucaoId: 'a/b', ateMs: AGORA } }],
    ['a lease expiring at a fractional ms', { vez: { execucaoId: 'tick-1', ateMs: AGORA + 0.5 } }],
    ['a lease expiring at a negative ms', { vez: { execucaoId: 'tick-1', ateMs: -1 } }],
    [
      'a lease expiry written as a digit string',
      { vez: { execucaoId: 'tick-1', ateMs: String(AGORA) } },
    ],
    ['a string flag', { semDeposito: 'false' }],
  ])('refuses %s', (_nome, troca) => {
    expect(sincronizacaoEstoqueAmazonSchema.safeParse(troca).success).toBe(false);
  });

  it('NEAR-MISS: an ISO stamp the tolerant millisSinceEpoch would coerce is REFUSED here', () => {
    const iso = new Date(AGORA).toISOString();
    expect(millisSinceEpoch().safeParse(iso).success).toBe(true);
    expect(sincronizacaoEstoqueAmazonSchema.safeParse({ cursorMs: iso }).success).toBe(false);
  });
});

describe('reconciliacaoEstoqueAmazonSchema', () => {
  it('a claimed run parses to the defaults: both forms unwalked, page 0, zero counters, no clock', () => {
    expect(reconciliacaoEstoqueAmazonSchema.parse(RUN)).toEqual({
      ...RUN,
      cursores: {
        canonica: { ultimoCaminho: null, concluida: false },
        nua: { ultimoCaminho: null, concluida: false },
      },
      proximaPagina: 0,
      paginas: 0,
      contagens: {
        vinculosLidos: 0,
        skusAvaliados: 0,
        enviaveis: 0,
        divergencias: 0,
        zeroSemLinha: 0,
        recusasHumanas: 0,
        recusadosEmDivergencia: 0,
        porChave: {},
      },
      progressoEmMs: null,
      relogioInicio: null,
      concluidaEmMs: null,
    });
  });

  it('the defaults are fresh objects: two parses never share a counter map or a cursor', () => {
    const a = reconciliacaoEstoqueAmazonSchema.parse(RUN);
    const b = reconciliacaoEstoqueAmazonSchema.parse(RUN);
    expect(a.contagens).not.toBe(b.contagens);
    expect(a.contagens.porChave).not.toBe(b.contagens.porChave);
    expect(a.cursores.canonica).not.toBe(b.cursores.canonica);
    a.contagens.porChave.afn = 1;
    expect(b.contagens.porChave).toEqual({});
  });

  it('the run phases, in order, each with its companion', () => {
    expect(faseReconciliacaoEstoqueAmazonSchema.options).toEqual([
      'varrendo',
      'decidindo',
      'enviando',
      'concluida',
      'truncada',
    ]);
    expect(Object.values(FASE_RECONCILIACAO_ESTOQUE_AMAZON).sort()).toEqual(
      [...faseReconciliacaoEstoqueAmazonSchema.options].sort(),
    );
  });

  it('a run mid-walk round-trips, every field included', () => {
    const relogio = timestampFalso(AGORA + 1_234);
    const doc = {
      ...RUN,
      fase: FASE_RECONCILIACAO_ESTOQUE_AMAZON.decidindo,
      cursores: {
        canonica: { ultimoCaminho: 'produtos/p9/prodAmazon/l9', concluida: true },
        nua: { ultimoCaminho: null, concluida: true },
      },
      proximaPagina: 4,
      paginas: 4,
      contagens: {
        vinculosLidos: 1_150,
        skusAvaliados: 1_100,
        enviaveis: 1_040,
        divergencias: 37,
        zeroSemLinha: 2,
        recusasHumanas: 3,
        recusadosEmDivergencia: 1,
        porChave: { afn: 4, 'pai-do-vinculo-ilegivel': 1, confirmadoPorGet: 6 },
      },
      progressoEmMs: AGORA + 400_000,
      relogioInicio: relogio,
      concluidaEmMs: null,
    };
    const lido = reconciliacaoEstoqueAmazonSchema.parse(doc);
    expect(lido).toEqual(doc);
    expect(lido.relogioInicio).toBe(relogio);
  });

  it('★ relogioInicio round-trips as a Timestamp: the SAME object, never a number or a Date', () => {
    const ms = AGORA + 1_234;
    const ts = timestampFalso(ms);
    expect(
      reconciliacaoEstoqueAmazonSchema.parse({ ...RUN, relogioInicio: ts }).relogioInicio,
    ).toBe(ts);
    expect(reconciliacaoEstoqueAmazonSchema.safeParse({ ...RUN, relogioInicio: ms }).success).toBe(
      false,
    );
    expect(
      reconciliacaoEstoqueAmazonSchema.safeParse({ ...RUN, relogioInicio: new Date(ms) }).success,
    ).toBe(false);
  });

  it('relogioInicio recognises a Timestamp EXACTLY as the feed record’s outcome clock does', () => {
    const ms = AGORA + 1_234;
    const { seconds, nanoseconds, toMillis } = timestampFalso(ms);
    const candidatos: unknown[] = [
      timestampFalso(ms),
      { toMillis, seconds, nanoseconds },
      { toMillis },
      { toMillis, seconds },
      { toMillis, nanoseconds },
      { seconds, nanoseconds },
      { toMillis: ms, seconds, nanoseconds },
      { toMillis, seconds: String(seconds), nanoseconds },
      new Date(ms),
      ms,
      String(ms),
      [],
      {},
    ];
    for (const valor of candidatos) {
      expect(
        reconciliacaoEstoqueAmazonSchema.shape.relogioInicio.safeParse(valor).success,
        JSON.stringify(valor),
      ).toBe(registroFeedAmazonSchema.shape.relogioDesfecho.safeParse(valor).success);
    }
    // Anti-vacuity: both sides accept one shape and refuse another.
    expect(
      reconciliacaoEstoqueAmazonSchema.shape.relogioInicio.safeParse(candidatos[0]).success,
    ).toBe(true);
    expect(reconciliacaoEstoqueAmazonSchema.shape.relogioInicio.safeParse(ms).success).toBe(false);
  });

  it.each([
    ['a phase outside the closed set', { fase: 'decidida' }],
    ['a bare depósito ref', { depositoOuterRef: 'depositos/dep-1' }],
    ['no depósito at all (a run is pinned to the one its walk read)', { depositoOuterRef: null }],
    ['a run id that is not an id', { execucaoId: 'a b' }],
    [
      'a cursor that is not a link doc path',
      { cursores: { canonica: { ultimoCaminho: 'documents/produtos/p/prodAmazon/l' } } },
    ],
    ['a negative counter', { contagens: { divergencias: -1 } }],
    ['a free-text counter key', { contagens: { porChave: { 'a b': 1 } } }],
    ['a fractional page', { proximaPagina: 1.5 }],
    ['a µs-looking fractional progress stamp', { progressoEmMs: AGORA + 0.25 }],
  ])('refuses %s', (_nome, troca) => {
    expect(reconciliacaoEstoqueAmazonSchema.safeParse({ ...RUN, ...troca }).success).toBe(false);
  });

  it('requires its claim fields: the run, the phase, the depósito and the start', () => {
    for (const campo of Object.keys(RUN)) {
      const semCampo: Record<string, unknown> = { ...RUN };
      delete semCampo[campo];
      expect(reconciliacaoEstoqueAmazonSchema.safeParse(semCampo).success, campo).toBe(false);
    }
  });

  it('a partial merge patch validates (no top-level refinement blocks .partial())', () => {
    expect(
      reconciliacaoEstoqueAmazonSchema.partial().parse({ proximaPagina: 3 }).proximaPagina,
    ).toBe(3);
  });

  it('never stores a request: `pendente` on the run’s own document is stripped', () => {
    const lido = reconciliacaoEstoqueAmazonSchema.parse({ ...RUN, pendente: true });
    expect('pendente' in lido).toBe(false);
  });
});

describe('pedidoReconciliacaoEstoqueAmazonSchema', () => {
  it('an empty document parses to "nothing requested"', () => {
    expect(pedidoReconciliacaoEstoqueAmazonSchema.parse({})).toEqual({
      pendente: false,
      pedidoEmMs: null,
      reexecucaoAutomaticaEmMs: null,
    });
  });

  it('a pending automatic request round-trips', () => {
    const doc = { pendente: true, pedidoEmMs: AGORA, reexecucaoAutomaticaEmMs: AGORA };
    expect(pedidoReconciliacaoEstoqueAmazonSchema.parse(doc)).toEqual(doc);
  });

  it.each([
    ['a string flag', { pendente: 'true' }],
    ['a fractional stamp', { pedidoEmMs: AGORA + 0.5 }],
    ['a stamp as a digit string', { reexecucaoAutomaticaEmMs: String(AGORA) }],
  ])('refuses %s', (_nome, troca) => {
    expect(pedidoReconciliacaoEstoqueAmazonSchema.safeParse(troca).success).toBe(false);
  });
});

describe('divergenciaEstoqueAmazonSchema', () => {
  it('a block round-trips, its TTL stamp the SAME Date', () => {
    const lido = divergenciaEstoqueAmazonSchema.parse(BLOCO);
    expect(lido).toEqual(BLOCO);
    expect(lido.expiraEm).toBe(BLOCO.expiraEm);
  });

  it('an absent Amazon quantity is stored as null (it counts as different)', () => {
    const bloco = { ...BLOCO, itens: [{ ...ITEM, quantidadeAmazon: null }] };
    expect(divergenciaEstoqueAmazonSchema.parse(bloco).itens[0]?.quantidadeAmazon).toBeNull();
  });

  it('holds 300 SKUs, never 301', () => {
    const itens = Array.from({ length: 300 }, (_, i) => ({ ...ITEM, sku: `SKU-${String(i)}` }));
    expect(divergenciaEstoqueAmazonSchema.safeParse({ ...BLOCO, itens }).success).toBe(true);
    expect(
      divergenciaEstoqueAmazonSchema.safeParse({ ...BLOCO, itens: [...itens, ITEM] }).success,
    ).toBe(false);
  });

  it('keeps a SKU the patch path cannot carry: a feed sends it, so the block must hold it', () => {
    for (const sku of ['a/b', 'a\\b', '..', '.', 'com espaço', 'açúcar']) {
      const bloco = { ...BLOCO, itens: [{ ...ITEM, sku }] };
      expect(divergenciaEstoqueAmazonSchema.safeParse(bloco).success, sku).toBe(true);
    }
  });

  it.each([
    ['an empty SKU', { itens: [{ ...ITEM, sku: '' }] }],
    ['a unit id that is a path', { itens: [{ ...ITEM, unidadeId: 'produtos/p1' }] }],
    ['a negative ERP quantity', { itens: [{ ...ITEM, quantidadeErp: -1 }] }],
    ['a fractional ERP quantity', { itens: [{ ...ITEM, quantidadeErp: 2.5 }] }],
    ['a null ERP quantity', { itens: [{ ...ITEM, quantidadeErp: null }] }],
    ['a bare depósito ref', { depositoOuterRef: 'depositos/dep-1' }],
  ])('refuses %s', (_nome, troca) => {
    expect(divergenciaEstoqueAmazonSchema.safeParse({ ...BLOCO, ...troca }).success).toBe(false);
  });

  it('★ expiraEm is REQUIRED: a block without its stamp, or with null, fails its parse', () => {
    const { expiraEm: _expiraEm, ...semCarimbo } = BLOCO;
    expect(divergenciaEstoqueAmazonSchema.safeParse(semCarimbo).success).toBe(false);
    expect(divergenciaEstoqueAmazonSchema.safeParse({ ...BLOCO, expiraEm: null }).success).toBe(
      false,
    );
  });

  it('NEAR-MISS: the SAME instant as a numeric epoch is REFUSED (a TTL ignores a number)', () => {
    const ms = BLOCO.expiraEm.getTime();
    expect(divergenciaEstoqueAmazonSchema.safeParse({ ...BLOCO, expiraEm: ms }).success).toBe(
      false,
    );
    // A stored Timestamp, as a read returns it, is the field's other accepted shape.
    const ts = timestampFalso(ms);
    expect(divergenciaEstoqueAmazonSchema.parse({ ...BLOCO, expiraEm: ts }).expiraEm).toBe(ts);
    expect(ttlExpiry().safeParse(ms).success).toBe(false);
  });

  it('the field is the TTL field, and its policy is NOT declared yet (it lands with the blocks’ writer)', () => {
    expect(TTL_FIELD in divergenciaEstoqueAmazonSchema.shape).toBe(true);
    expect(TTL_POLICIES.map((p) => p.collectionGroup)).not.toContain('divergenciasEstoqueAmazon');
  });

  it('the run and the tick documents are never TTL-stamped: a stray stamp is stripped', () => {
    for (const esquema of [
      sincronizacaoEstoqueAmazonSchema,
      reconciliacaoEstoqueAmazonSchema,
      pedidoReconciliacaoEstoqueAmazonSchema,
    ]) {
      expect(TTL_FIELD in esquema.shape).toBe(false);
    }
    const lido = reconciliacaoEstoqueAmazonSchema.parse({ ...RUN, expiraEm: new Date(AGORA) });
    expect(TTL_FIELD in lido).toBe(false);
  });
});

describe('★ every stored number is a strict non-negative safe integer (each field, derived from the schemas)', () => {
  /** Documents that set EVERY field, a number wherever a field may hold one. */
  const SINC = {
    cursorMs: AGORA,
    depositoDoCursor: DEPOSITO,
    vez: { execucaoId: 'tick-1', ateMs: AGORA },
    ultimoTickMs: AGORA,
    falhasSeguidas: 2,
    semDeposito: false,
  };
  const REC = {
    ...RUN,
    cursores: {
      canonica: { ultimoCaminho: 'produtos/p1/prodAmazon/l1', concluida: false },
      nua: { ultimoCaminho: null, concluida: true },
    },
    proximaPagina: 3,
    paginas: 3,
    contagens: {
      vinculosLidos: 9,
      skusAvaliados: 8,
      enviaveis: 7,
      divergencias: 6,
      zeroSemLinha: 5,
      recusasHumanas: 4,
      recusadosEmDivergencia: 3,
      porChave: { afn: 2 },
    },
    progressoEmMs: AGORA,
    relogioInicio: timestampFalso(AGORA),
    concluidaEmMs: AGORA,
  };
  const PED = { pendente: true, pedidoEmMs: AGORA, reexecucaoAutomaticaEmMs: AGORA };
  const DIV = { ...BLOCO, itens: [{ ...ITEM }] };

  type Esquema = { safeParse(valor: unknown): { success: boolean } };
  const CHEIOS: readonly (readonly [string, Esquema, Record<string, unknown>])[] = [
    ['sincronizacao', sincronizacaoEstoqueAmazonSchema, SINC],
    ['reconciliacao', reconciliacaoEstoqueAmazonSchema, REC],
    ['pedidoReconciliacao', pedidoReconciliacaoEstoqueAmazonSchema, PED],
    ['divergencia', divergenciaEstoqueAmazonSchema, DIV],
  ];

  type Caminho = readonly (string | number)[];
  /** Every numeric leaf of a document (a stored clock or a TTL stamp is not one). */
  function folhasNumericas(valor: unknown, caminho: Caminho = []): Caminho[] {
    if (typeof valor === 'number') return [caminho];
    if (Array.isArray(valor)) return valor.flatMap((v, i) => folhasNumericas(v, [...caminho, i]));
    if (typeof valor !== 'object' || valor === null || valor instanceof Date) return [];
    if (typeof Reflect.get(valor, 'toMillis') === 'function') return [];
    return Object.entries(valor).flatMap(([k, v]) => folhasNumericas(v, [...caminho, k]));
  }
  /** The document with `valor` at `caminho`, every other field unchanged. */
  function comValor(doc: unknown, caminho: Caminho, valor: unknown): unknown {
    const [cabeca, ...resto] = caminho;
    if (cabeca === undefined) return valor;
    if (Array.isArray(doc))
      return doc.map((v, i) => (i === cabeca ? comValor(v, resto, valor) : v));
    const objeto = doc as Record<string, unknown>;
    return { ...objeto, [cabeca]: comValor(objeto[String(cabeca)], resto, valor) };
  }

  it('the full documents set every field of every object schema, so no number is left out', () => {
    const pares: readonly (readonly [object, object])[] = [
      [sincronizacaoEstoqueAmazonSchema.shape, SINC],
      [vezSincronizacaoEstoqueAmazonSchema.shape, SINC.vez],
      [reconciliacaoEstoqueAmazonSchema.shape, REC],
      [contagensReconciliacaoEstoqueAmazonSchema.shape, REC.contagens],
      [cursorVarreduraEstoqueAmazonSchema.shape, REC.cursores.canonica],
      [pedidoReconciliacaoEstoqueAmazonSchema.shape, PED],
      [divergenciaEstoqueAmazonSchema.shape, DIV],
      [itemDivergenciaEstoqueAmazonSchema.shape, ITEM],
    ];
    for (const [shape, doc] of pares) {
      expect(Object.keys(doc).sort()).toEqual(Object.keys(shape).sort());
    }
    for (const [nome, esquema, doc] of CHEIOS)
      expect(esquema.safeParse(doc).success, nome).toBe(true);
  });

  it('the numeric fields found are exactly the stored stamps and counts', () => {
    expect(
      CHEIOS.flatMap(([nome, , doc]) => folhasNumericas(doc).map((c) => `${nome}.${c.join('.')}`)),
    ).toEqual([
      'sincronizacao.cursorMs',
      'sincronizacao.vez.ateMs',
      'sincronizacao.ultimoTickMs',
      'sincronizacao.falhasSeguidas',
      'reconciliacao.iniciadaEmMs',
      'reconciliacao.proximaPagina',
      'reconciliacao.paginas',
      'reconciliacao.contagens.vinculosLidos',
      'reconciliacao.contagens.skusAvaliados',
      'reconciliacao.contagens.enviaveis',
      'reconciliacao.contagens.divergencias',
      'reconciliacao.contagens.zeroSemLinha',
      'reconciliacao.contagens.recusasHumanas',
      'reconciliacao.contagens.recusadosEmDivergencia',
      'reconciliacao.contagens.porChave.afn',
      'reconciliacao.progressoEmMs',
      'reconciliacao.concluidaEmMs',
      'pedidoReconciliacao.pedidoEmMs',
      'pedidoReconciliacao.reexecucaoAutomaticaEmMs',
      'divergencia.itens.0.quantidadeAmazon',
      'divergencia.itens.0.quantidadeErp',
    ]);
  });

  const CASOS = CHEIOS.flatMap(([nome, esquema, doc]) =>
    folhasNumericas(doc).map((caminho) => ({
      rotulo: `${nome}.${caminho.join('.')}`,
      esquema,
      doc,
      caminho,
    })),
  );

  it.each(CASOS)(
    'refuses a fraction, a negative and a digit string at $rotulo',
    ({ esquema, doc, caminho }) => {
      const valor = caminho.reduce<unknown>(
        (o, k) => (o as Record<string, unknown>)[String(k)],
        doc,
      );
      expect(typeof valor === 'number' && Number.isSafeInteger(valor)).toBe(true);
      if (typeof valor !== 'number') return;
      for (const ruim of [valor + 0.5, -1, String(valor)]) {
        expect(esquema.safeParse(comValor(doc, caminho, ruim)).success, String(ruim)).toBe(false);
      }
      // NEAR-MISS: 0 is a legal value for every one of them.
      expect(esquema.safeParse(comValor(doc, caminho, 0)).success).toBe(true);
    },
  );
});

describe('idDivergenciaEstoqueAmazon', () => {
  it('<execucaoId>-<n>, split at its LAST `-` (a run id may hold `-`)', () => {
    const id = idDivergenciaEstoqueAmazon('run-a-1', 12);
    expect(id).toBe('run-a-1-12');
    const corte = id.lastIndexOf('-');
    expect([id.slice(0, corte), id.slice(corte + 1)]).toEqual(['run-a-1', '12']);
  });

  it('two pages of one run, and one page of two runs, are distinct ids', () => {
    expect(idDivergenciaEstoqueAmazon('r', 1)).not.toBe(idDivergenciaEstoqueAmazon('r', 10));
    expect(idDivergenciaEstoqueAmazon('r1', 0)).not.toBe(idDivergenciaEstoqueAmazon('r2', 0));
    expect(idDivergenciaEstoqueAmazon('r', 0)).toBe('r-0');
  });

  it('refuses a run id outside its grammar or a page that is not a non-negative safe integer, naming the rule only', () => {
    expect(() => idDivergenciaEstoqueAmazon('a/b', 0)).toThrow(/ID_LOTE_FEED_AMAZON_REGEX/);
    expect(() => idDivergenciaEstoqueAmazon('a/b', 0)).not.toThrow(/a\/b/);
    for (const pagina of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => idDivergenciaEstoqueAmazon('r', pagina), String(pagina)).toThrow(RangeError);
    }
  });
});

describe('the module', () => {
  it('is barrel-exported bare, never as a { schema, meta } pair', () => {
    expect(Object.keys(modulo).length).toBeGreaterThan(0);
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });

  it('is NOT registered in ALL_DOMAINS (no rules block, no client access)', () => {
    const esquemas = ALL_DOMAINS.map((d) => d.schema);
    for (const esquema of [
      sincronizacaoEstoqueAmazonSchema,
      reconciliacaoEstoqueAmazonSchema,
      pedidoReconciliacaoEstoqueAmazonSchema,
      divergenciaEstoqueAmazonSchema,
    ]) {
      expect(esquemas).not.toContain(esquema);
    }
    const caminhos = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    for (const caminho of [
      'sincronizacaoEstoqueAmazon',
      'reconciliacaoEstoqueAmazon',
      'pedidoReconciliacaoEstoqueAmazon',
      'reconciliacaoEstoqueAmazon/{contaId}/divergenciasEstoqueAmazon',
    ]) {
      expect(caminhos).not.toContain(caminho);
    }
  });
});
