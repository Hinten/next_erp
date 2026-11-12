import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as modulo from './feedAmazon';
import {
  DESFECHO_FEED_AMAZON,
  ESTADO_VEZ_FEED_AMAZON,
  FEED_ID_REGISTRO_AMAZON_REGEX,
  FLUXO_FEED_AMAZON,
  ID_LOTE_FEED_AMAZON_REGEX,
  ORIGEM_LOTE_FEED_AMAZON_REGEX,
  STATUS_REGISTRO_FEED_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  desfechoFeedAmazonSchema,
  estadoVezFeedAmazonSchema,
  fluxoFeedAmazonSchema,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
  janelaFeedAmazonSchema,
  registroFeedAmazonSchema,
  statusRegistroFeedAmazonSchema,
  tipoLoteFeedAmazonSchema,
  vezFeedAmazonSchema,
} from './feedAmazon';
import * as barrel from './index';
import { ALL_DOMAINS } from './registry';
import { millisSinceEpoch } from './shared/datetime';
import {
  RETENCAO_FEED_AMAZON_DIAS,
  TTL_FIELD,
  TTL_POLICIES,
  expiraEmApos,
  ttlExpiry,
} from './shared/ttl';

const DIA_MS = 86_400_000;
const ANTES = 1_800_000_000_000;
const CRIADO = ANTES + 4_000;

/** Shaped like `firebase-admin`'s and `firebase/firestore`'s `Timestamp` alike. */
function timestampFalso(ms: number) {
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

const JANELA = {
  desdeMs: ANTES - 600_000,
  ateMs: ANTES - 60_000,
  manterDesdeMs: ANTES - 600_000,
  commitAposMs: null,
  depositoId: 'deposito-1',
};

/** The fields a record is created with (the rest default). */
const CRIACAO = {
  contaId: 'conta-teste',
  feedId: '3485934',
  fluxo: FLUXO_FEED_AMAZON.estoque,
  execucaoId: 'a'.repeat(64),
  origem: 'delta',
  tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
  janela: JANELA,
  snapshotEmMs: ANTES - 30_000,
  antesDoEnvioMs: ANTES,
  mensagens: 42,
  bytes: 9_876,
  status: STATUS_REGISTRO_FEED_AMAZON.enviado,
  criadoEmMs: CRIADO,
  atualizadoEmMs: CRIADO,
  prazoEmMs: ANTES + 12 * 3_600_000,
};

/** The fields a lease is first written with (the rest default). */
const VEZ = {
  estado: ESTADO_VEZ_FEED_AMAZON.montando,
  execucaoId: 'run-1',
  ateMs: ANTES + 600_000,
  atualizadoEmMs: ANTES,
};

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find pnpm-workspace.yaml above ' + startDir);
}

interface IndiceDeclarado {
  collectionGroup?: unknown;
  fieldPath?: unknown;
  ttl?: unknown;
  indexes?: unknown;
}

const indices = JSON.parse(
  readFileSync(
    resolve(findRepoRoot(dirname(fileURLToPath(import.meta.url))), 'firestore.indexes.json'),
    'utf8',
  ),
) as { indexes?: IndiceDeclarado[]; fieldOverrides?: IndiceDeclarado[] };

describe('the closed vocabularies (each with its prefer-schema-enum companion)', () => {
  it.each([
    ['FLUXO_FEED_AMAZON', FLUXO_FEED_AMAZON, fluxoFeedAmazonSchema.options],
    ['TIPO_LOTE_FEED_AMAZON', TIPO_LOTE_FEED_AMAZON, tipoLoteFeedAmazonSchema.options],
    [
      'STATUS_REGISTRO_FEED_AMAZON',
      STATUS_REGISTRO_FEED_AMAZON,
      statusRegistroFeedAmazonSchema.options,
    ],
    ['ESTADO_VEZ_FEED_AMAZON', ESTADO_VEZ_FEED_AMAZON, estadoVezFeedAmazonSchema.options],
    ['DESFECHO_FEED_AMAZON', DESFECHO_FEED_AMAZON, desfechoFeedAmazonSchema.options],
  ])('%s is exactly its schema’s options', (_nome, constante, opcoes) => {
    expect(Object.values(constante).sort()).toEqual([...opcoes].sort());
  });

  it('the members, as the core names them', () => {
    expect(fluxoFeedAmazonSchema.options).toEqual(['estoque', 'preco']);
    expect(statusRegistroFeedAmazonSchema.options).toEqual([
      'enviado',
      'processando',
      'concluido',
      'falhou',
      'cancelado',
      'abandonado',
    ]);
    expect(estadoVezFeedAmazonSchema.options).toEqual(['livre', 'montando', 'enviando', 'enviado']);
    // `incerto` is an outcome with no record: a lost createFeed answer.
    expect(desfechoFeedAmazonSchema.options).toEqual([
      'concluido',
      'falhou',
      'cancelado',
      'abandonado',
      'incerto',
    ]);
  });
});

describe('the grammars', () => {
  it('feedId: digits only, 1 to 20', () => {
    expect(FEED_ID_REGISTRO_AMAZON_REGEX.test('1')).toBe(true);
    expect(FEED_ID_REGISTRO_AMAZON_REGEX.test('9'.repeat(20))).toBe(true);
    // NEAR-MISSES: one digit more, a letter, a path separator, empty.
    expect(FEED_ID_REGISTRO_AMAZON_REGEX.test('9'.repeat(21))).toBe(false);
    expect(FEED_ID_REGISTRO_AMAZON_REGEX.test('FEED1')).toBe(false);
    expect(FEED_ID_REGISTRO_AMAZON_REGEX.test('12/34')).toBe(false);
    expect(FEED_ID_REGISTRO_AMAZON_REGEX.test('')).toBe(false);
  });

  it('a core id: letters, digits, `_` and `-`, 1 to 128 — a UUID and a sha256 digest fit', () => {
    expect(ID_LOTE_FEED_AMAZON_REGEX.test('0b6f3c5e-6a0e-4a8e-9f2d-1c2b3a4d5e6f')).toBe(true);
    expect(ID_LOTE_FEED_AMAZON_REGEX.test('f'.repeat(64))).toBe(true);
    expect(ID_LOTE_FEED_AMAZON_REGEX.test('x'.repeat(129))).toBe(false);
    expect(ID_LOTE_FEED_AMAZON_REGEX.test('a/b')).toBe(false);
    expect(ID_LOTE_FEED_AMAZON_REGEX.test('a:b')).toBe(false);
  });

  it('origem: a lowercase token, never free text', () => {
    for (const ok of ['delta', 'recuperacao', 'reconciliacao', 'manual-2']) {
      expect(ORIGEM_LOTE_FEED_AMAZON_REGEX.test(ok), ok).toBe(true);
    }
    for (const nao of ['', 'Delta', '1delta', 'a b', 'a'.repeat(33), 'delta\n']) {
      expect(ORIGEM_LOTE_FEED_AMAZON_REGEX.test(nao), JSON.stringify(nao)).toBe(false);
    }
  });
});

describe('the window', () => {
  it('a window with a stamp rule, a commit rule or both parses', () => {
    expect(janelaFeedAmazonSchema.parse(JANELA)).toEqual(JANELA);
    const soCommit = { ...JANELA, manterDesdeMs: null, commitAposMs: ANTES - 20_000 };
    expect(janelaFeedAmazonSchema.parse(soCommit)).toEqual(soCommit);
    const ambas = { ...JANELA, commitAposMs: ANTES - 20_000 };
    expect(janelaFeedAmazonSchema.parse(ambas)).toEqual(ambas);
  });

  it('refuses an empty or reversed window (NEAR-MISS: one ms wide is a window)', () => {
    expect(janelaFeedAmazonSchema.safeParse({ ...JANELA, ateMs: JANELA.desdeMs }).success).toBe(
      false,
    );
    expect(janelaFeedAmazonSchema.safeParse({ ...JANELA, ateMs: JANELA.desdeMs - 1 }).success).toBe(
      false,
    );
    expect(janelaFeedAmazonSchema.safeParse({ ...JANELA, ateMs: JANELA.desdeMs + 1 }).success).toBe(
      true,
    );
  });

  it('refuses a window that keeps nothing (both keep fields null)', () => {
    expect(
      janelaFeedAmazonSchema.safeParse({ ...JANELA, manterDesdeMs: null, commitAposMs: null })
        .success,
    ).toBe(false);
  });

  it('refuses a depósito id outside the core id grammar', () => {
    expect(janelaFeedAmazonSchema.safeParse({ ...JANELA, depositoId: 'deposito/1' }).success).toBe(
      false,
    );
  });
});

describe('registroFeedAmazonSchema', () => {
  it('a record at creation parses to the defaults: no report, no problem, no rung, not concluded', () => {
    expect(registroFeedAmazonSchema.parse(CRIACAO)).toEqual({
      ...CRIACAO,
      processingStatus: null,
      resultado: null,
      problemasSemSku: { erros: 0, avisos: 0 },
      skusComProblema: 0,
      skusGravados: 0,
      rodadas: 0,
      concluidoEmMs: null,
      relogioDesfecho: null,
    });
  });

  it('a block batch has no window', () => {
    const bloco = { ...CRIACAO, tipoLote: TIPO_LOTE_FEED_AMAZON.blocos, janela: null };
    expect(registroFeedAmazonSchema.parse(bloco).janela).toBeNull();
    const { janela: _janela, ...semJanela } = bloco;
    expect(registroFeedAmazonSchema.parse(semJanela).janela).toBeNull();
  });

  it('a concluded record round-trips', () => {
    const relogio = timestampFalso(ANTES + 7_200_000);
    const doc = {
      ...CRIACAO,
      status: STATUS_REGISTRO_FEED_AMAZON.concluido,
      processingStatus: 'DONE',
      resultado: { erros: 3, avisos: 1, processadas: 42, aceitas: 39, invalidas: 0 },
      problemasSemSku: { erros: 1, avisos: 0 },
      skusComProblema: 2,
      skusGravados: 2,
      rodadas: 5,
      atualizadoEmMs: ANTES + 7_200_000,
      concluidoEmMs: ANTES + 7_200_500,
      relogioDesfecho: relogio,
      expiraEm: expiraEmApos(CRIADO, RETENCAO_FEED_AMAZON_DIAS),
    };
    const lido = registroFeedAmazonSchema.parse(doc);
    expect(lido).toEqual(doc);
    expect(lido.relogioDesfecho).toBe(relogio);
  });

  it('processingStatus is an OPEN string: a value Amazon adds later is stored as read', () => {
    expect(
      registroFeedAmazonSchema.parse({ ...CRIACAO, processingStatus: 'IN_REVIEW' })
        .processingStatus,
    ).toBe('IN_REVIEW');
  });

  it.each([
    ['a non-digit feedId', { feedId: 'F1' }],
    ['a conta outside its grammar', { contaId: 'integracao/x' }],
    ['a fluxo outside the batch fluxos', { fluxo: 'nfe' }],
    ['an origem that is free text', { origem: 'Delta run' }],
    ['zero messages (a feed is never built empty)', { mensagens: 0 }],
    ['a status outside the closed set', { status: 'DONE' }],
    ['a negative ms stamp', { antesDoEnvioMs: -1 }],
    ['a fractional ms stamp', { criadoEmMs: CRIADO + 0.5 }],
    ['a ms stamp written as a digit string (no coercion)', { snapshotEmMs: String(ANTES) }],
  ])('refuses %s', (_nome, troca) => {
    expect(registroFeedAmazonSchema.safeParse({ ...CRIACAO, ...troca }).success).toBe(false);
  });

  it('NEAR-MISS: an ISO stamp that the tolerant millisSinceEpoch would coerce is REFUSED here', () => {
    const iso = new Date(ANTES).toISOString();
    expect(millisSinceEpoch().safeParse(iso).success).toBe(true);
    expect(registroFeedAmazonSchema.safeParse({ ...CRIACAO, antesDoEnvioMs: iso }).success).toBe(
      false,
    );
  });

  it('relogioDesfecho is a Firestore Timestamp: a number or a Date is refused', () => {
    const ms = ANTES + 7_200_000;
    expect(
      registroFeedAmazonSchema.safeParse({ ...CRIACAO, relogioDesfecho: timestampFalso(ms) })
        .success,
    ).toBe(true);
    expect(registroFeedAmazonSchema.safeParse({ ...CRIACAO, relogioDesfecho: ms }).success).toBe(
      false,
    );
    expect(
      registroFeedAmazonSchema.safeParse({ ...CRIACAO, relogioDesfecho: new Date(ms) }).success,
    ).toBe(false);
  });

  it('NEAR-MISS: relogioDesfecho needs the whole Timestamp shape (toMillis, seconds and nanoseconds)', () => {
    const ms = ANTES + 7_200_000;
    const { seconds, nanoseconds, toMillis } = timestampFalso(ms);
    // Another library's instant may answer toMillis() too; it is not a Firestore clock.
    expect(
      registroFeedAmazonSchema.safeParse({ ...CRIACAO, relogioDesfecho: { toMillis } }).success,
    ).toBe(false);
    expect(
      registroFeedAmazonSchema.safeParse({ ...CRIACAO, relogioDesfecho: { toMillis, seconds } })
        .success,
    ).toBe(false);
    expect(
      registroFeedAmazonSchema.safeParse({ ...CRIACAO, relogioDesfecho: { toMillis, nanoseconds } })
        .success,
    ).toBe(false);
    expect(
      registroFeedAmazonSchema.safeParse({ ...CRIACAO, relogioDesfecho: { seconds, nanoseconds } })
        .success,
    ).toBe(false);
    expect(
      registroFeedAmazonSchema.safeParse({
        ...CRIACAO,
        relogioDesfecho: { toMillis, seconds, nanoseconds },
      }).success,
    ).toBe(true);
  });

  it('relogioDesfecho recognises a Timestamp EXACTLY as the TTL field does (one shape, two readers)', () => {
    const ms = ANTES + 7_200_000;
    const { seconds, nanoseconds, toMillis } = timestampFalso(ms);
    // Every shape but a Date, which only the TTL field (a writer's stamp) takes.
    const candidatos: unknown[] = [
      timestampFalso(ms),
      { toMillis, seconds, nanoseconds },
      { toMillis },
      { toMillis, seconds },
      { toMillis, nanoseconds },
      { seconds, nanoseconds },
      { toMillis: ms, seconds, nanoseconds },
      { toMillis, seconds: String(seconds), nanoseconds },
      { toMillis, seconds, nanoseconds: String(nanoseconds) },
      ms,
      String(ms),
      [],
      {},
    ];
    for (const valor of candidatos) {
      expect(
        registroFeedAmazonSchema.shape.relogioDesfecho.safeParse(valor).success,
        JSON.stringify(valor),
      ).toBe(ttlExpiry().safeParse(valor).success);
    }
  });

  it('never stores the input document: an extra key is stripped', () => {
    const lido = registroFeedAmazonSchema.parse({ ...CRIACAO, documento: '{"messages":[]}' });
    expect('documento' in lido).toBe(false);
  });
});

describe('★ expiraEm — the TTL stamp of the record', () => {
  it('PAIR — a Date parses and comes back as the SAME instance (no coercion)', () => {
    const data = expiraEmApos(CRIADO, RETENCAO_FEED_AMAZON_DIAS);
    expect(registroFeedAmazonSchema.parse({ ...CRIACAO, expiraEm: data }).expiraEm).toBe(data);
  });

  it('a stored Timestamp (duck-typed) parses as the SAME object', () => {
    const ts = timestampFalso(CRIADO + RETENCAO_FEED_AMAZON_DIAS * DIA_MS);
    expect(registroFeedAmazonSchema.parse({ ...CRIACAO, expiraEm: ts }).expiraEm).toBe(ts);
  });

  it('NEAR-MISS — the SAME instant as a numeric epoch is REFUSED (a TTL ignores a number)', () => {
    const ms = expiraEmApos(CRIADO, RETENCAO_FEED_AMAZON_DIAS).getTime();
    expect(registroFeedAmazonSchema.safeParse({ ...CRIACAO, expiraEm: ms }).success).toBe(false);
    expect(
      registroFeedAmazonSchema.safeParse({ ...CRIACAO, expiraEm: new Date(ms).toISOString() })
        .success,
    ).toBe(false);
  });

  it('null and absent read as "never expires"', () => {
    expect(registroFeedAmazonSchema.parse({ ...CRIACAO, expiraEm: null }).expiraEm).toBeNull();
    expect('expiraEm' in registroFeedAmazonSchema.parse(CRIACAO)).toBe(false);
  });

  it('the record is kept 180 days from criadoEmMs', () => {
    expect(RETENCAO_FEED_AMAZON_DIAS).toBe(180);
    expect(expiraEmApos(CRIADO, RETENCAO_FEED_AMAZON_DIAS).getTime() - CRIADO).toBe(180 * DIA_MS);
  });

  it('TTL_POLICIES names the record’s group, its writer, its retention and the never-stamped lease', () => {
    const motivo = new Map(TTL_POLICIES.map((p) => [p.collectionGroup, p.motivo])).get(
      'feedsAmazon',
    );
    expect(motivo).toContain('apps/amazon feeds');
    expect(motivo).toContain('180 days');
    expect(motivo).toContain('feedsAmazonEmCurso');
    expect(motivo).toContain('never stamped');
    // The lease has its own group and NO policy: it is never stamped.
    expect(TTL_POLICIES.map((p) => p.collectionGroup)).not.toContain('feedsAmazonEmCurso');
  });
});

describe('vezFeedAmazonSchema', () => {
  it('a first take parses to the defaults: no feed, no pending start, no failure, no clocks', () => {
    expect(vezFeedAmazonSchema.parse(VEZ)).toEqual({
      ...VEZ,
      feedId: null,
      snapshotEmMs: null,
      antesDoEnvioMs: null,
      mensagens: null,
      bytes: null,
      origem: null,
      tipoLote: null,
      janela: null,
      pendenteDesdeMs: null,
      falhasSeguidas: 0,
      ultimaFalhaEmMs: null,
      ultimoEnvioMs: null,
      ultimoFeedConcluidoEmMs: null,
    });
  });

  it('an `enviado` lease round-trips, every lease field included', () => {
    const doc = {
      estado: ESTADO_VEZ_FEED_AMAZON.enviado,
      execucaoId: 'run-1',
      feedId: '3485934',
      snapshotEmMs: ANTES - 30_000,
      antesDoEnvioMs: ANTES,
      mensagens: 42,
      bytes: 9_876,
      ateMs: ANTES + 49 * 3_600_000,
      atualizadoEmMs: ANTES + 1_000,
      origem: 'delta',
      tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
      janela: JANELA,
      pendenteDesdeMs: ANTES - 900_000,
      falhasSeguidas: 2,
      ultimaFalhaEmMs: ANTES - 7_200_000,
      ultimoEnvioMs: ANTES,
      ultimoFeedConcluidoEmMs: ANTES - 3_600_000,
    };
    expect(vezFeedAmazonSchema.parse(doc)).toEqual(doc);
  });

  it('the lease is NEVER TTL-stamped: it has no expiraEm field, so a stray stamp is stripped', () => {
    expect(TTL_FIELD in vezFeedAmazonSchema.shape).toBe(false);
    const lido = vezFeedAmazonSchema.parse({ ...VEZ, expiraEm: new Date(ANTES) });
    expect(TTL_FIELD in lido).toBe(false);
    // NEAR-MISS: the record does carry it.
    expect(TTL_FIELD in registroFeedAmazonSchema.shape).toBe(true);
  });

  it.each([
    ['an estado outside the closed set', { estado: 'processando' }],
    ['a non-digit feedId', { feedId: 'F1' }],
    ['a negative falhasSeguidas', { falhasSeguidas: -1 }],
    ['a fractional pendenteDesdeMs', { pendenteDesdeMs: 1.5 }],
    ['a reversed window', { janela: { ...JANELA, ateMs: JANELA.desdeMs } }],
  ])('refuses %s', (_nome, troca) => {
    expect(vezFeedAmazonSchema.safeParse({ ...VEZ, ...troca }).success).toBe(false);
  });

  // The Admin handle's merge validation runs `.partial()`, which Zod refuses on
  // an object carrying its own refinement: the window's checks sit on the
  // nested window, never on either document.
  it('a partial merge patch of either document validates (no top-level refinement blocks .partial())', () => {
    expect(vezFeedAmazonSchema.partial().parse({ pendenteDesdeMs: 1 }).pendenteDesdeMs).toBe(1);
    expect(registroFeedAmazonSchema.partial().parse({ rodadas: 3 }).rodadas).toBe(3);
    expect(
      vezFeedAmazonSchema.partial().safeParse({ janela: { ...JANELA, ateMs: JANELA.desdeMs } })
        .success,
    ).toBe(false);
  });
});

describe('the ids', () => {
  it('the record: <contaId>_<feedId>, split at its LAST `_`', () => {
    const id = idRegistroFeedAmazon('conta_a', '123');
    expect(id).toBe('conta_a_123');
    const corte = id.lastIndexOf('_');
    expect([id.slice(0, corte), id.slice(corte + 1)]).toEqual(['conta_a', '123']);
  });

  it('two contas with one feedId give two record ids (a feedId is unique only per seller)', () => {
    expect(idRegistroFeedAmazon('conta-a', '7')).not.toBe(idRegistroFeedAmazon('conta-b', '7'));
  });

  it('the lease: <fluxo>-<contaId>, split at its FIRST `-`; one per fluxo and conta', () => {
    const id = idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, 'conta-a');
    expect(id).toBe('estoque-conta-a');
    const corte = id.indexOf('-');
    expect([id.slice(0, corte), id.slice(corte + 1)]).toEqual(['estoque', 'conta-a']);
    expect(idVezFeedAmazon(FLUXO_FEED_AMAZON.preco, 'conta-a')).toBe('preco-conta-a');
  });

  it('an id outside its grammar throws a RangeError naming the grammar, never the value', () => {
    expect(() => idRegistroFeedAmazon('conta/x', '1')).toThrow(/CONTA_ID_AMAZON_REGEX/);
    expect(() => idRegistroFeedAmazon('conta', 'F1')).toThrow(/FEED_ID_REGISTRO_AMAZON_REGEX/);
    expect(() => idRegistroFeedAmazon('conta', 'F1')).not.toThrow(/F1/);
    expect(() => idVezFeedAmazon('nfe' as typeof FLUXO_FEED_AMAZON.estoque, 'conta')).toThrow(
      RangeError,
    );
    expect(() => idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, 'a b')).toThrow(RangeError);
  });
});

describe('firestore.indexes.json', () => {
  it('★ declares NO composite index on either collection: nothing queries them (the lease names the in-flight feed, each poll rung names its record)', () => {
    const nossos = (indices.indexes ?? []).filter(
      (i) => i.collectionGroup === 'feedsAmazon' || i.collectionGroup === 'feedsAmazonEmCurso',
    );
    expect(nossos).toEqual([]);
    // Anti-vacuity: the file has composites, so the scan read it.
    expect((indices.indexes ?? []).length).toBeGreaterThan(10);
  });

  it('declares the record’s TTL override on expiraEm, with no single-field index, and none for the lease', () => {
    const overrides = indices.fieldOverrides ?? [];
    expect(overrides.filter((o) => o.collectionGroup === 'feedsAmazon')).toEqual([
      { collectionGroup: 'feedsAmazon', fieldPath: TTL_FIELD, ttl: true, indexes: [] },
    ]);
    expect(overrides.filter((o) => o.collectionGroup === 'feedsAmazonEmCurso')).toEqual([]);
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
    expect(Reflect.get(barrel, 'RETENCAO_FEED_AMAZON_DIAS')).toBe(RETENCAO_FEED_AMAZON_DIAS);
  });

  it('is NOT registered in ALL_DOMAINS (no rules block, no client access)', () => {
    const esquemas = ALL_DOMAINS.map((d) => d.schema);
    expect(esquemas).not.toContain(registroFeedAmazonSchema);
    expect(esquemas).not.toContain(vezFeedAmazonSchema);
    const caminhos = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(caminhos).not.toContain('feedsAmazon');
    expect(caminhos).not.toContain('feedsAmazonEmCurso');
  });
});
