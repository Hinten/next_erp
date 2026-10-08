/**
 * The monthly link audit (#1200), offline.
 *
 * Every Firestore surface the audit OWNS runs against a small FakeDb — the
 * integração enumeration and the avisos key-range read, the two queries written
 * in this module — and every surface it BORROWS is an injected seam: the shared
 * walk (`fetchPage`), the tier-1 heal (`curar`), the aviso writer/resolver and the
 * pre-resolve re-read (`reconfirmar`). Those have their own suites; what is pinned
 * here is the audit's DECISIONS: what heals, what alerts, what is capped, what is
 * resolved and only when, and how one conta's failure stays one conta's.
 *
 * The real queries, the real heal and the real aviso writes against a real
 * Firestore are `auditoriaNaoEnumerados.firestore.test.ts` (the emulator lane).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/logger';
import type { PlanoAviso, ResultadoAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  INTEGRACAO_TIPO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';
import { avisoCollection, integracaoCollection } from '@delfrance/data/admin/collections';

import {
  CODIGO_NAO_ENUMERADO,
  type CodigoNaoEnumerado,
  type FetchLinksNaoEnumeradosArgs,
  type LinkNaoEnumerado,
  type LinksNaoEnumeradosPage,
} from '../anuncios/linksNaoEnumerados';
import { STOCK_SYNC_FLAG_ENV } from './bulkEstoquePlan';
import {
  AMOSTRA_MAX,
  AUDITORIA_LOG_PREFIX,
  AUDITORIA_MAX_PAGINAS_POR_CONTA,
  AUDITORIA_ORCAMENTO_MS,
  AUDITORIA_PAGE_LIMIT,
  type AuditoriaDeps,
  type AuditoriaResult,
  type AvisoExistente,
  type AvisosAuditoria,
  MAX_AVISOS_NOVOS_POR_CONTA,
  RESOLUCAO_AUDITORIA,
  listarAvisosDaConta,
  listarAvisosDoTipo,
  mesmosParams,
  planoDoAviso,
  resumirAuditoria,
  runAuditoriaNaoEnumerados,
} from './auditoriaNaoEnumerados';

/* ------------------------------ fake Firestore ----------------------------- */
// The two query shapes the audit itself issues: `where('==')` chains (the conta
// enumeration) and the KEY-RANGE read (`select` + `orderBy(documentId)` +
// `startAt`/`startAfter` + `endBefore` + `limit`). Queries are IMMUTABLE, like
// the real SDK — each builder call returns a new query, and a later
// `startAfter` replaces an earlier `startAt` (a query holds one start cursor).
// Range bounds compare document ids as JS strings, which agrees with Firestore's
// key order for the ASCII ids used here.

type DocData = Record<string, unknown>;

interface EstadoQuery {
  where: Array<[string, unknown]>;
  select: string[] | null;
  orderBy: unknown;
  startAt: string | null;
  startAfter: string | null;
  endBefore: string | null;
  limit: number | null;
}

interface QueryLog extends EstadoQuery {
  path: string;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly queries: QueryLog[] = [];

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }

  collection(path: string) {
    return this.query(path, {
      where: [],
      select: null,
      orderBy: null,
      startAt: null,
      startAfter: null,
      endBefore: null,
      limit: null,
    });
  }

  private query(path: string, st: EstadoQuery) {
    const next = (patch: Partial<EstadoQuery>) => this.query(path, { ...st, ...patch });
    return {
      where: (field: string, op: string, value: unknown) => {
        if (op !== '==') throw new Error(`FakeDb: unsupported operator ${op}`);
        return next({ where: [...st.where, [field, value]] });
      },
      select: (...fields: string[]) => next({ select: fields }),
      orderBy: (fp: unknown) => next({ orderBy: fp }),
      startAt: (id: string) => next({ startAt: id, startAfter: null }),
      startAfter: (id: string) => next({ startAfter: id, startAt: null }),
      endBefore: (id: string) => next({ endBefore: id }),
      limit: (n: number) => next({ limit: n }),
      get: async () => {
        this.queries.push({ ...st, path });
        const comCursor = st.startAt != null || st.startAfter != null || st.endBefore != null;
        if (
          comCursor &&
          !(st.orderBy instanceof FieldPath && st.orderBy.isEqual(FieldPath.documentId()))
        ) {
          throw new Error('FakeDb: a key cursor needs orderBy(FieldPath.documentId())');
        }
        let rows = [...this.col(path).entries()]
          .filter(([, d]) => st.where.every(([f, v]) => d[f] === v))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (st.startAt != null) rows = rows.filter(([id]) => id >= st.startAt!);
        if (st.startAfter != null) rows = rows.filter(([id]) => id > st.startAfter!);
        if (st.endBefore != null) rows = rows.filter(([id]) => id < st.endBefore!);
        if (st.limit != null) rows = rows.slice(0, st.limit);
        return {
          docs: rows.map(([id, d]) => ({
            id,
            data: () =>
              st.select == null
                ? d
                : Object.fromEntries(st.select.filter((f) => f in d).map((f) => [f, d[f]])),
          })),
        };
      },
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;
const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const AVISOS_PATH = avisoCollection.resolvePath({});
const TIPO = TIPO_AVISO.anuncioForaDaSincronizacao;

function seedContas(db: FakeDb, ids: string[], over: DocData = {}): void {
  for (const id of ids) {
    db.seed(INTEGRACAO_PATH, id, { tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true, ...over });
  }
}

/* --------------------------------- builders -------------------------------- */

/**
 * 02:30 on the 1st of January 2027 in São Paulo (fixed UTC-3) — the cron's slot.
 * Its month index (2027 × 12 + 0 = 24 324) is a multiple of 2 and 3, so with two
 * or three contas the rotation starts at the FIRST id: every multi-conta spec
 * below reads in id order, and only the rotation spec moves the clock.
 */
const T0 = Date.parse('2027-01-01T05:30:00.000Z');

const chave = (conta: string, produtoId: string) =>
  chaveDeAviso({ tipo: TIPO, conta, entidade: produtoId });

function achado(
  produtoId: string,
  code: CodigoNaoEnumerado,
  itemId: string | null = `MLB-${produtoId}`,
): LinkNaoEnumerado {
  return { produtoId, itemId, code };
}

function pagina(
  naoEnumerados: LinkNaoEnumerado[],
  next: string | null,
  extra: Partial<LinksNaoEnumeradosPage> = {},
): LinksNaoEnumeradosPage {
  return {
    naoEnumerados,
    inspecionados: naoEnumerados.length,
    lidos: naoEnumerados.length + 1,
    produtosLidos: new Set(naoEnumerados.map((f) => f.produtoId)).size,
    limpos: [],
    nextAfterLinkPath: next,
    ...extra,
  };
}

type Roteiro = LinksNaoEnumeradosPage[] | ((n: number) => LinksNaoEnumeradosPage);

/** An open (or resolved) row as the key-range read would return it. */
function linha(
  conta: string,
  produtoId: string,
  over: Partial<AvisoExistente> = {},
): AvisoExistente {
  return {
    chave: chave(conta, produtoId),
    aberto: true,
    canal: CANAL_AVISO.mercadoLivre,
    params: {
      situacao: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao,
      anuncio: `MLB-${produtoId}`,
      anuncios: 1,
    },
    ...over,
  };
}

/**
 * An in-memory avisos port with the writer's three outcomes and the resolver's
 * transition semantics (an already-resolved row answers false).
 */
function fakeAvisos(seed: AvisoExistente[] = []) {
  const rows = new Map(seed.map((a) => [a.chave, { ...a }]));
  const escritos: PlanoAviso[] = [];
  const resolvidos: Array<{ chave: string; motivo: string }> = [];
  const port: AvisosAuditoria = {
    listarDaConta: vi.fn(async (_db: Firestore, conta: string) =>
      [...rows.values()].filter((a) => a.chave.startsWith(`${TIPO}:${conta}:`)),
    ),
    listarDoTipo: vi.fn(async () => [...rows.values()]),
    escrever: vi.fn(async (_db: Firestore, plano: PlanoAviso): Promise<ResultadoAviso> => {
      escritos.push(plano);
      const k = chaveDeAviso(plano);
      const ex = rows.get(k);
      rows.set(k, {
        chave: k,
        aberto: true,
        canal: plano.canal ?? null,
        params: { ...plano.params },
      });
      return ex == null ? 'criado' : ex.aberto ? 'repetido' : 'reaberto';
    }),
    resolver: vi.fn(async (_db: Firestore, k: string, motivo: string) => {
      const ex = rows.get(k);
      if (ex == null || !ex.aberto) return false;
      rows.set(k, { ...ex, aberto: false });
      resolvidos.push({ chave: k, motivo });
      return true;
    }),
  };
  return { port, rows, escritos, resolvidos };
}

interface Montagem {
  contas?: string[];
  roteiros?: Record<string, Roteiro>;
  avisos?: AvisoExistente[];
  curar?: AuditoriaDeps['curar'];
  reconfirmar?: AuditoriaDeps['reconfirmar'];
  /** ms the clock advances on every walk page (per conta). */
  msPorPagina?: Record<string, number>;
  /** Throw from the walk of this conta instead of returning a page. */
  falhas?: Record<string, unknown>;
  t0?: number;
  pageLimit?: number;
}

function montar(m: Montagem = {}) {
  const db = new FakeDb();
  seedContas(db, m.contas ?? ['c1']);
  const relogio = { t: m.t0 ?? T0 };
  const agora = vi.fn(() => relogio.t);
  const eventos: string[] = [];
  const chamadas: Array<FetchLinksNaoEnumeradosArgs & { conta: string }> = [];
  const contagem = new Map<string, number>();
  const fetchPage = vi.fn(async (_db: Firestore, args: FetchLinksNaoEnumeradosArgs) => {
    const conta = args.integracaoId;
    eventos.push(`page:${conta}`);
    chamadas.push({ ...args, conta });
    if (m.falhas?.[conta] !== undefined) throw m.falhas[conta];
    const n = contagem.get(conta) ?? 0;
    contagem.set(conta, n + 1);
    relogio.t += m.msPorPagina?.[conta] ?? 0;
    const roteiro = m.roteiros?.[conta] ?? [pagina([], null)];
    if (typeof roteiro === 'function') return roteiro(n);
    const page = roteiro[n];
    if (page == null) throw new Error(`roteiro de ${conta} sem página ${String(n)}`);
    return page;
  });
  const avisos = fakeAvisos(m.avisos);
  const curar = vi.fn<NonNullable<AuditoriaDeps['curar']>>(m.curar ?? (async () => true));
  const reconfirmar = vi.fn<NonNullable<AuditoriaDeps['reconfirmar']>>(
    m.reconfirmar ?? (async () => null),
  );
  const deps: AuditoriaDeps = {
    agora,
    fetchPage,
    curar,
    avisos: avisos.port,
    reconfirmar,
    ...(m.pageLimit !== undefined ? { pageLimit: m.pageLimit } : {}),
  };
  vi.mocked(logger.info).mockImplementation((msg: unknown) => {
    eventos.push(`info:${String(msg)}`);
  });
  return {
    db,
    deps,
    relogio,
    agora,
    eventos,
    chamadas,
    fetchPage,
    curar,
    reconfirmar,
    avisos,
    run: () => runAuditoriaNaoEnumerados(asDb(db), deps),
  };
}

/** The messages `logger.warn` was called with. */
function avisosDeLog(): string[] {
  return vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  process.env[STOCK_SYNC_FLAG_ENV] = '1';
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[STOCK_SYNC_FLAG_ENV];
  vi.restoreAllMocks();
});

/* ---------------------------------- the gate -------------------------------- */

describe('runAuditoriaNaoEnumerados — the master flag', () => {
  it('off → { enabled: false } before ANY read, clock or seam', async () => {
    delete process.env[STOCK_SYNC_FLAG_ENV];
    const t = montar({
      roteiros: { c1: [pagina([achado('p1', 'NAO_ENUMERADO_PRODUTO_AUSENTE')], null)] },
    });

    const result = await t.run();

    expect(result).toEqual({ enabled: false, contas: [], naoAuditadas: [], inativasResolvidas: 0 });
    expect(t.db.queries).toHaveLength(0);
    expect(t.agora).not.toHaveBeenCalled();
    expect(t.fetchPage).not.toHaveBeenCalled();
    expect(t.curar).not.toHaveBeenCalled();
    expect(t.reconfirmar).not.toHaveBeenCalled();
    expect(t.avisos.port.listarDaConta).not.toHaveBeenCalled();
    expect(t.avisos.port.listarDoTipo).not.toHaveBeenCalled();
  });

  it('a value other than "1" stays off', async () => {
    process.env[STOCK_SYNC_FLAG_ENV] = 'true';
    const t = montar();
    expect((await t.run()).enabled).toBe(false);
    expect(t.db.queries).toHaveLength(0);
  });
});

/* ------------------------------- enumeration ------------------------------- */

describe('runAuditoriaNaoEnumerados — which contas, in which order', () => {
  it('enumerates ACTIVE Mercado Livre integrações only, exactly like the stock sweep', async () => {
    const t = montar({ contas: ['c1'] });
    seedContas(t.db, ['c-off'], { ativo: false });
    seedContas(t.db, ['c-shopee'], { tipo: INTEGRACAO_TIPO.shopee });

    const result = await t.run();

    expect(result.contas.map((c) => c.integracaoId)).toEqual(['c1']);
    expect(t.db.queries[0]).toMatchObject({
      path: INTEGRACAO_PATH,
      where: [
        ['tipo', INTEGRACAO_TIPO.mercadoLivre],
        ['ativo', true],
      ],
    });
  });

  it('rotates the starting conta by the CALENDAR MONTH in São Paulo', async () => {
    const ordem = async (agoraMs: number) => {
      const t = montar({ contas: ['c3', 'c1', 'c2'], t0: agoraMs });
      return (await t.run()).contas.map((c) => c.integracaoId);
    };
    // (2026 × 12 + month − 1) mod 3: October → 0, November → 1, December → 2.
    expect(await ordem(Date.parse('2026-10-01T05:30:00Z'))).toEqual(['c1', 'c2', 'c3']);
    expect(await ordem(Date.parse('2026-11-01T05:30:00Z'))).toEqual(['c2', 'c3', 'c1']);
    expect(await ordem(Date.parse('2026-12-01T05:30:00Z'))).toEqual(['c3', 'c1', 'c2']);
    // 01:30 UTC on Nov 1st is still 22:30 on Oct 31st in São Paulo: the month is
    // October's, never the host's UTC November.
    expect(await ordem(Date.parse('2026-11-01T01:30:00Z'))).toEqual(['c1', 'c2', 'c3']);
  });

  it('walks with AUDITORIA_PAGE_LIMIT unless overridden, threading the cursor', async () => {
    const roteiro = [pagina([], 'produtos/a/produtoMercadoLivre/1'), pagina([], null)];
    const t = montar({ roteiros: { c1: roteiro } });
    await t.run();
    expect(t.chamadas).toEqual([
      { conta: 'c1', integracaoId: 'c1', afterLinkPath: null, pageLimit: AUDITORIA_PAGE_LIMIT },
      {
        conta: 'c1',
        integracaoId: 'c1',
        afterLinkPath: 'produtos/a/produtoMercadoLivre/1',
        pageLimit: AUDITORIA_PAGE_LIMIT,
      },
    ]);

    const t2 = montar({ pageLimit: 2 });
    await t2.run();
    expect(t2.chamadas[0]!.pageLimit).toBe(2);
  });
});

/* ---------------------------------- the heal -------------------------------- */

describe('class 2 — healed, never an aviso', () => {
  it('heals CONTA_FORA_DO_PRODUTO once per produto and raises no aviso for it', async () => {
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            [
              achado('p1', CODIGO_NAO_ENUMERADO.contaForaDoProduto, 'MLB1'),
              achado('p1', CODIGO_NAO_ENUMERADO.contaForaDoProduto, 'MLB2'),
              achado('p2', CODIGO_NAO_ENUMERADO.produtoAusente),
            ],
            null,
          ),
        ],
      },
    });

    const [conta] = (await t.run()).contas;

    expect(t.curar).toHaveBeenCalledTimes(1);
    expect(t.curar).toHaveBeenCalledWith(expect.anything(), 'p1', 'c1');
    expect(t.avisos.escritos.map((p) => p.entidade)).toEqual(['p2']);
    expect(conta).toMatchObject({
      curados: 1,
      curasSemEfeito: 0,
      amostraCurados: ['p1'],
      porSituacao: {
        [CODIGO_NAO_ENUMERADO.contaForaDoProduto]: 1,
        [CODIGO_NAO_ENUMERADO.produtoAusente]: 1,
        [CODIGO_NAO_ENUMERADO.linkEmVariacao]: 0,
        [CODIGO_NAO_ENUMERADO.paiIdInvalido]: 0,
      },
    });
  });

  it('a heal that found no live link is counted apart, and the sample is capped', async () => {
    const ids = Array.from({ length: AMOSTRA_MAX + 5 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            ids.map((id) => achado(id, CODIGO_NAO_ENUMERADO.contaForaDoProduto)),
            null,
          ),
        ],
      },
      curar: async (_db, produtoId) => produtoId !== 'p00',
    });

    const [conta] = (await t.run()).contas;

    expect(conta!.curados).toBe(AMOSTRA_MAX + 4);
    expect(conta!.curasSemEfeito).toBe(1);
    expect(conta!.amostraCurados).toHaveLength(AMOSTRA_MAX);
    expect(conta!.amostraCurados).not.toContain('p00');
  });

  it.each([
    [
      'the page cap',
      'paginas',
      (n: number) =>
        pagina(
          n === 0 ? [achado('p1', CODIGO_NAO_ENUMERADO.contaForaDoProduto)] : [],
          `cursor-${String(n)}`,
        ),
    ],
    [
      'a stuck cursor',
      'cursor-parado',
      (n: number) =>
        pagina(n === 0 ? [achado('p1', CODIGO_NAO_ENUMERADO.contaForaDoProduto)] : [], 'cursor-x'),
    ],
  ] as const)('still heals what a walk truncated by %s saw', async (_n, motivo, roteiro) => {
    const t = montar({ roteiros: { c1: roteiro } });

    const [conta] = (await t.run()).contas;

    expect(conta!.truncada).toBe(motivo);
    expect(t.curar).toHaveBeenCalledWith(expect.anything(), 'p1', 'c1');
    expect(conta!.curados).toBe(1);
    if (motivo === 'paginas') expect(conta!.paginas).toBe(AUDITORIA_MAX_PAGINAS_POR_CONTA);
    if (motivo === 'cursor-parado') expect(conta!.paginas).toBe(2);
  });

  it('still heals what a walk cut short by its FAIR SHARE saw (the run budget remains)', async () => {
    // Two contas: c1's share is half the budget. Each c1 page costs 150 s, so
    // the third page would start at 300 s — past c1's 200 s share — while 100 s
    // of the RUN budget is still left for c1's writes.
    const t = montar({
      contas: ['c1', 'c2'],
      roteiros: {
        c1: (n) =>
          pagina(
            n === 0 ? [achado('p1', CODIGO_NAO_ENUMERADO.contaForaDoProduto)] : [],
            `cursor-${String(n)}`,
          ),
      },
      msPorPagina: { c1: 150_000 },
    });

    const result = await t.run();
    const c1 = result.contas.find((c) => c.integracaoId === 'c1')!;

    expect(c1.truncada).toBe('orcamento');
    expect(c1.paginas).toBe(2);
    expect(c1.curados).toBe(1);
  });
});

/* ------------------------------ the aviso shape ----------------------------- */

describe('the aviso — one per produto, per situação', () => {
  it('builds the documented plano for every code, with no relogioEvento and no prazo', async () => {
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            [
              achado('pA', CODIGO_NAO_ENUMERADO.produtoAusente, 'MLB7'),
              achado('pP', CODIGO_NAO_ENUMERADO.paiIdInvalido, 'MLB5'),
              achado('pV', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB9'),
              achado('pV', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB10'),
            ],
            'cursor-1',
          ),
          // The same listing again on a later page, plus one more: counted once.
          pagina(
            [
              achado('pV', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB10'),
              achado('pV', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB2'),
            ],
            null,
          ),
        ],
      },
    });

    await t.run();

    const porEntidade = new Map(t.avisos.escritos.map((p) => [p.entidade, p]));
    expect(porEntidade.get('pA')).toEqual({
      tipo: TIPO,
      conta: 'c1',
      entidade: 'pA',
      severidade: 'atencao',
      canal: 'mercadoLivre',
      params: { situacao: 'produto-ausente', anuncio: 'MLB7', anuncios: 1 },
      motivo: 'produto-ausente',
      // A produto that no longer exists has no page: the conta's channel page.
      urlInterna: { rota: '/canais/mercado-livre/c1', campo: null },
    });
    expect(porEntidade.get('pP')).toEqual({
      tipo: TIPO,
      conta: 'c1',
      entidade: 'pP',
      severidade: 'atencao',
      canal: 'mercadoLivre',
      params: { situacao: 'pai-id-invalido', anuncio: 'MLB5', anuncios: 1 },
      motivo: 'pai-id-invalido',
      urlInterna: { rota: '/produtos/pP', campo: null },
    });
    // Three DISTINCT listings; `anuncio` is the lexicographically first id.
    expect(porEntidade.get('pV')).toEqual({
      tipo: TIPO,
      conta: 'c1',
      entidade: 'pV',
      severidade: 'atencao',
      canal: 'mercadoLivre',
      params: { situacao: 'link-em-variacao', anuncio: 'MLB10', anuncios: 3 },
      motivo: 'link-em-variacao',
      urlInterna: { rota: '/produtos/pV', campo: null },
    });
    for (const plano of t.avisos.escritos) {
      // OMITTED, not nulled: a null would RESET a stored watermark.
      expect('relogioEvento' in plano).toBe(false);
      expect('prazo' in plano).toBe(false);
    }
  });

  it('a finding with no item id still raises, with an empty `anuncio`', () => {
    expect(
      planoDoAviso('c1', 'p1', SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao, new Set()),
    ).toMatchObject({ params: { situacao: 'link-em-variacao', anuncio: '', anuncios: 0 } });
  });

  it('the LATEST page classifies a produto seen on two pages', async () => {
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            [
              achado('p1', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB1'),
              achado('p2', CODIGO_NAO_ENUMERADO.contaForaDoProduto, 'MLB2'),
              achado('p3', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB3'),
            ],
            'cursor-1',
          ),
          pagina(
            [
              // Deleted between the two pages' produto reads.
              achado('p1', CODIGO_NAO_ENUMERADO.produtoAusente, 'MLB4'),
              // Became a child — no longer healable, now an aviso.
              achado('p2', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB5'),
              // Its paiId was fixed but the denorm lost the conta — heal, no aviso.
              achado('p3', CODIGO_NAO_ENUMERADO.contaForaDoProduto, 'MLB6'),
            ],
            null,
          ),
        ],
      },
    });

    const [conta] = (await t.run()).contas;

    expect(t.curar.mock.calls.map((c) => c[1])).toEqual(['p3']);
    const porEntidade = new Map(t.avisos.escritos.map((p) => [p.entidade, p.params]));
    expect([...porEntidade.keys()].sort()).toEqual(['p1', 'p2']);
    expect(porEntidade.get('p1')).toEqual({
      situacao: 'produto-ausente',
      anuncio: 'MLB1',
      anuncios: 2,
    });
    expect(porEntidade.get('p2')).toMatchObject({ situacao: 'link-em-variacao' });
    expect(conta!.porSituacao).toEqual({
      [CODIGO_NAO_ENUMERADO.produtoAusente]: 1,
      [CODIGO_NAO_ENUMERADO.linkEmVariacao]: 1,
      [CODIGO_NAO_ENUMERADO.paiIdInvalido]: 0,
      [CODIGO_NAO_ENUMERADO.contaForaDoProduto]: 1,
    });
  });

  it('a later CLEAN read drops the finding — no heal, no aviso, and its open row becomes a resolve candidate', async () => {
    // The walk reports a clean produto only in `limpos`. Folding `naoEnumerados`
    // alone would keep page 1's stale codes: a heal on nothing for p2, and a
    // refresh of p1's open row that keeps it standing for another month.
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            [
              achado('p1', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB1'),
              achado('p2', CODIGO_NAO_ENUMERADO.contaForaDoProduto, 'MLB2'),
              achado('p3', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB3'),
            ],
            'cursor-1',
          ),
          // Every cadastro fixed between the two pages' produto reads.
          pagina([], 'cursor-2', { limpos: ['p1', 'p2', 'p3'] }),
          // …and p3 broken AGAIN before the third: the latest read wins both
          // ways, and the finding restarts from what the later reads saw.
          pagina([achado('p3', CODIGO_NAO_ENUMERADO.paiIdInvalido, 'MLB9')], null),
        ],
      },
      avisos: [linha('c1', 'p1')],
    });

    const [conta] = (await t.run()).contas;

    expect(t.curar).not.toHaveBeenCalled();
    expect(t.avisos.escritos.map((p) => [p.entidade, p.params])).toEqual([
      ['p3', { situacao: 'pai-id-invalido', anuncio: 'MLB9', anuncios: 1 }],
    ]);
    // p1 left `vistos`: re-confirmed, then resolved.
    expect(t.reconfirmar.mock.calls.map((c) => c[1])).toEqual(['p1']);
    expect(t.avisos.resolvidos).toEqual([
      { chave: chave('c1', 'p1'), motivo: RESOLUCAO_AUDITORIA.naoEncontrado },
    ]);
    expect(conta!.porSituacao).toEqual({
      [CODIGO_NAO_ENUMERADO.produtoAusente]: 0,
      [CODIGO_NAO_ENUMERADO.linkEmVariacao]: 0,
      [CODIGO_NAO_ENUMERADO.paiIdInvalido]: 1,
      [CODIGO_NAO_ENUMERADO.contaForaDoProduto]: 0,
    });
  });
});

/* ------------------------------- refresh / cap ------------------------------ */

describe('open rows are refreshed only on change; NEW rows are capped', () => {
  it('an open row whose params are already current is not written', async () => {
    const t = montar({
      roteiros: { c1: [pagina([achado('p1', CODIGO_NAO_ENUMERADO.linkEmVariacao)], null)] },
      avisos: [linha('c1', 'p1')],
    });

    const [conta] = (await t.run()).contas;

    expect(t.avisos.port.escrever).not.toHaveBeenCalled();
    expect(conta!.inalterados).toBe(1);
    // Still SEEN: an unchanged row is not a resolve candidate.
    expect(t.avisos.port.resolver).not.toHaveBeenCalled();
    expect(t.reconfirmar).not.toHaveBeenCalled();
  });

  it('an open row whose params changed is refreshed (repetido)', async () => {
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            [
              achado('p1', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB-p1'),
              achado('p1', CODIGO_NAO_ENUMERADO.linkEmVariacao, 'MLB-z'),
            ],
            null,
          ),
        ],
      },
      avisos: [linha('c1', 'p1')],
    });

    const [conta] = (await t.run()).contas;

    expect(t.avisos.escritos).toHaveLength(1);
    expect(t.avisos.escritos[0]!.params).toEqual({
      situacao: 'link-em-variacao',
      anuncio: 'MLB-p1',
      anuncios: 2,
    });
    expect(conta!.avisos).toEqual({ criado: 0, repetido: 1, reaberto: 0, ignorado: 0 });
  });

  it('caps NEW rows at MAX in produtoId order — an OPEN row past the cap is still refreshed and not resolved', async () => {
    const novos = Array.from({ length: MAX_AVISOS_NOVOS_POR_CONTA + 1 }, (_, i) =>
      achado(`a${String(i).padStart(2, '0')}`, CODIGO_NAO_ENUMERADO.linkEmVariacao),
    );
    const t = montar({
      roteiros: {
        c1: [pagina([...novos, achado('z99', CODIGO_NAO_ENUMERADO.produtoAusente)], null)],
      },
      // Open, and its situação changed: it needs a refresh, and sorts LAST.
      avisos: [linha('c1', 'z99')],
    });

    const [conta] = (await t.run()).contas;

    const escritos = t.avisos.escritos.map((p) => p.entidade);
    expect(escritos).toHaveLength(MAX_AVISOS_NOVOS_POR_CONTA + 1);
    expect(escritos).toContain('z99');
    expect(escritos).not.toContain('a20');
    expect(conta!.suprimidos).toBe(1);
    expect(conta!.amostraSuprimidos).toEqual(['a20']);
    expect(conta!.avisos).toEqual({
      criado: MAX_AVISOS_NOVOS_POR_CONTA,
      repetido: 1,
      reaberto: 0,
      ignorado: 0,
    });
    // Suppressed is still SEEN, and so is the refreshed open row.
    expect(t.avisos.port.resolver).not.toHaveBeenCalled();
    expect(avisosDeLog().some((m) => m.includes('suprimidos'))).toBe(true);
  });

  it('refreshing OPEN rows spends none of the NEW-row budget, even when they sort first', async () => {
    // The mirror of the spec above: there the open row sorts LAST and must not
    // be capped; here two open rows sort FIRST and must not COUNT. A cap that
    // tallies every write — not only the new ones — would hold back two genuine
    // new alerts behind refreshes the operator already sees.
    const novos = Array.from({ length: MAX_AVISOS_NOVOS_POR_CONTA }, (_, i) =>
      achado(`b${String(i).padStart(2, '0')}`, CODIGO_NAO_ENUMERADO.linkEmVariacao),
    );
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            [
              achado('a00', CODIGO_NAO_ENUMERADO.produtoAusente),
              achado('a01', CODIGO_NAO_ENUMERADO.paiIdInvalido),
              ...novos,
            ],
            null,
          ),
        ],
      },
      // Both open with a stale situação (`linha` stores link-em-variacao): refreshes.
      avisos: [linha('c1', 'a00'), linha('c1', 'a01')],
    });

    const [conta] = (await t.run()).contas;

    expect(t.avisos.escritos.map((p) => p.entidade)).toEqual([
      'a00',
      'a01',
      ...novos.map((f) => f.produtoId),
    ]);
    expect(conta!.avisos).toEqual({
      criado: MAX_AVISOS_NOVOS_POR_CONTA,
      repetido: 2,
      reaberto: 0,
      ignorado: 0,
    });
    expect(conta!.suprimidos).toBe(0);
    expect(conta!.amostraSuprimidos).toEqual([]);
  });

  it('a RESOLVED row counts as new: reopening it re-alerts, so it is capped too', async () => {
    const novos = Array.from({ length: MAX_AVISOS_NOVOS_POR_CONTA }, (_, i) =>
      achado(`a${String(i).padStart(2, '0')}`, CODIGO_NAO_ENUMERADO.linkEmVariacao),
    );
    const t = montar({
      roteiros: {
        c1: [pagina([...novos, achado('z99', CODIGO_NAO_ENUMERADO.linkEmVariacao)], null)],
      },
      avisos: [linha('c1', 'z99', { aberto: false })],
    });

    const [conta] = (await t.run()).contas;

    expect(t.avisos.escritos.map((p) => p.entidade)).not.toContain('z99');
    expect(conta!.suprimidos).toBe(1);
    expect(conta!.amostraSuprimidos).toEqual(['z99']);
  });

  it('under the cap, a resolved row is REOPENED', async () => {
    const t = montar({
      roteiros: { c1: [pagina([achado('p1', CODIGO_NAO_ENUMERADO.linkEmVariacao)], null)] },
      avisos: [linha('c1', 'p1', { aberto: false })],
    });
    const [conta] = (await t.run()).contas;
    expect(conta!.avisos.reaberto).toBe(1);
  });
});

describe('mesmosParams — the refresh decision, both directions', () => {
  const novo = { situacao: 'link-em-variacao', anuncio: 'MLB1', anuncios: 2 };

  it('equal: the same keys with strictly equal values, in any order', () => {
    expect(mesmosParams({ anuncios: 2, anuncio: 'MLB1', situacao: 'link-em-variacao' }, novo)).toBe(
      true,
    );
  });

  it.each([
    ['a number stored as a string', { ...novo, anuncios: '2' }],
    ['a different item', { ...novo, anuncio: 'MLB2' }],
    ['another situação', { ...novo, situacao: 'produto-ausente' }],
    ['an extra stored key (a write replaces params wholesale)', { ...novo, extra: 1 }],
    ['a missing key', { situacao: 'link-em-variacao', anuncio: 'MLB1' }],
    [
      'an inherited key does not count',
      Object.assign(Object.create({ anuncios: 2 }) as object, {
        situacao: 'link-em-variacao',
        anuncio: 'MLB1',
        outro: 0,
      }),
    ],
  ])('distinct: %s', (_n, armazenado) => {
    expect(mesmosParams(armazenado as Record<string, unknown>, novo)).toBe(false);
  });
});

/* ------------------------------- the resolver ------------------------------- */

describe('resolving — complete walks only, re-confirmed', () => {
  it('a complete walk resolves EXACTLY the re-confirmed open rows it no longer saw', async () => {
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            [
              achado('p-ainda', CODIGO_NAO_ENUMERADO.linkEmVariacao),
              achado('p-curado', CODIGO_NAO_ENUMERADO.contaForaDoProduto),
            ],
            null,
          ),
        ],
      },
      avisos: [
        linha('c1', 'p-ainda'),
        // Raised last month as a child link; this month it is class 2 — healed.
        linha('c1', 'p-curado'),
        linha('c1', 'p-sumiu'),
        linha('c1', 'p-sujo'),
        linha('c1', 'p-velho', { aberto: false }),
        // Another conta's row: never c1's to resolve.
        linha('c2', 'p-sumiu'),
      ],
      reconfirmar: async (_db, produtoId) =>
        produtoId === 'p-sujo' ? CODIGO_NAO_ENUMERADO.linkEmVariacao : null,
    });

    const [conta] = (await t.run()).contas;

    expect(
      t.avisos.resolvidos.filter((r) => r.motivo === RESOLUCAO_AUDITORIA.naoEncontrado),
    ).toEqual([
      { chave: chave('c1', 'p-curado'), motivo: 'nao-encontrado-na-auditoria' },
      { chave: chave('c1', 'p-sumiu'), motivo: 'nao-encontrado-na-auditoria' },
    ]);
    expect(t.reconfirmar.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['p-curado', 'c1'],
      ['p-sujo', 'c1'],
      ['p-sumiu', 'c1'],
    ]);
    expect(conta).toMatchObject({ truncada: null, resolvidos: 2, mantidos: 1, curados: 1 });
  });

  it('the re-read finding a live child link (link created mid-walk) blocks the resolve', async () => {
    const t = montar({
      avisos: [linha('c1', 'p1')],
      reconfirmar: async () => CODIGO_NAO_ENUMERADO.linkEmVariacao,
    });

    const [conta] = (await t.run()).contas;

    expect(t.reconfirmar).toHaveBeenCalledWith(expect.anything(), 'p1', 'c1');
    expect(t.avisos.port.resolver).not.toHaveBeenCalled();
    expect(conta!.mantidos).toBe(1);
  });

  it('a re-read that finds only class 2 still resolves — the next walk heals it', async () => {
    const t = montar({
      avisos: [linha('c1', 'p1')],
      reconfirmar: async () => CODIGO_NAO_ENUMERADO.contaForaDoProduto,
    });
    const [conta] = (await t.run()).contas;
    expect(conta!.resolvidos).toBe(1);
  });

  it.each([
    [
      'the page cap',
      'paginas',
      { roteiros: { c1: (n: number) => pagina([], `cursor-${String(n)}`) } },
    ],
    ['a stuck cursor', 'cursor-parado', { roteiros: { c1: () => pagina([], 'cursor-x') } }],
    [
      'its fair share of the budget',
      'orcamento',
      {
        contas: ['c1', 'c2'],
        roteiros: { c1: (n: number) => pagina([], `cursor-${String(n)}`) },
        msPorPagina: { c1: 150_000 },
      },
    ],
  ] as const)('a walk truncated by %s resolves NOTHING, and says so', async (_n, motivo, m) => {
    const t = montar({
      ...m,
      avisos: [linha('c1', 'p-sumiu')],
    } as Montagem);

    const result = await t.run();
    const c1 = result.contas.find((c) => c.integracaoId === 'c1')!;

    expect(c1.truncada).toBe(motivo);
    expect(t.reconfirmar).not.toHaveBeenCalledWith(expect.anything(), 'p-sumiu', 'c1');
    expect(t.avisos.resolvidos).toEqual([]);
    expect(avisosDeLog().some((msg) => msg.includes('TRUNCADA'))).toBe(true);
  });

  it('⛔ never re-reads or resolves ANOTHER channel’s row, even inside this conta’s key range', async () => {
    // The tipo is channel-neutral: "not found by an ML walk" says nothing about a
    // row another channel's producer raised and owns.
    const t = montar({
      avisos: [linha('c1', 'p-shopee', { canal: CANAL_AVISO.shopee }), linha('c1', 'p-ml')],
    });

    const [conta] = (await t.run()).contas;

    expect(t.reconfirmar.mock.calls.map((c) => c[1])).toEqual(['p-ml']);
    expect(t.avisos.resolvidos.map((r) => r.chave)).toEqual([chave('c1', 'p-ml')]);
    expect(conta!.resolvidos).toBe(1);
  });

  it('a row id outside the producer shape is never handed to the re-read', async () => {
    const t = montar({
      avisos: [{ chave: `${TIPO}:c1:`, aberto: true, canal: CANAL_AVISO.mercadoLivre, params: {} }],
    });
    await t.run();
    expect(t.reconfirmar).not.toHaveBeenCalled();
    expect(t.avisos.port.resolver).not.toHaveBeenCalled();
  });
});

/* ------------------------------ inactive contas ----------------------------- */

describe('rows of contas that are no longer active', () => {
  it('resolves every OPEN row whose conta was not enumerated — and nothing else', async () => {
    const t = montar({
      contas: ['c1'],
      roteiros: { c1: [pagina([achado('p1', CODIGO_NAO_ENUMERADO.linkEmVariacao)], null)] },
      avisos: [
        linha('c1', 'p1'),
        linha('c-off', 'p2'),
        linha('c-apagada', 'p3'),
        linha('c-apagada', 'p4', { aberto: false }),
        // Not this producer's shape: no conta, no entidade, an extra segment.
        linha('c-apagada', 'x', { chave: `${TIPO}::p5` }),
        linha('c-apagada', 'x', { chave: `${TIPO}:c-apagada` }),
        linha('c-apagada', 'x', { chave: `${TIPO}:c-apagada:p6:x` }),
      ],
    });
    seedContas(t.db, ['c-off'], { ativo: false });

    const result = await t.run();

    expect(result.inativasResolvidas).toBe(2);
    expect(t.avisos.resolvidos).toEqual([
      { chave: chave('c-off', 'p2'), motivo: RESOLUCAO_AUDITORIA.contaInativa },
      { chave: chave('c-apagada', 'p3'), motivo: RESOLUCAO_AUDITORIA.contaInativa },
    ]);
  });

  it('⛔ leaves ANOTHER channel’s rows of this channel-neutral tipo alone — and rows with no canal', async () => {
    // The tipo is shared by design (`aviso.ts`). A Shopee twin's conta is never an
    // ACTIVE ML integração, so without the canal test this pass would close its
    // open rows every month and the Shopee producer would re-open them.
    const t = montar({
      contas: ['c1'],
      avisos: [
        linha('shp1', 'p1', { canal: CANAL_AVISO.shopee }),
        linha('c-apagada', 'p2', { canal: null }),
        linha('c-apagada', 'p3'),
      ],
    });

    const result = await t.run();

    expect(result.inativasResolvidas).toBe(1);
    expect(t.avisos.resolvidos).toEqual([
      { chave: chave('c-apagada', 'p3'), motivo: RESOLUCAO_AUDITORIA.contaInativa },
    ]);
  });

  it('a conta that is enumerated but ERRORED keeps its rows — inactive means not enumerated', async () => {
    const grpc = Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
    const t = montar({
      contas: ['c1', 'c2'],
      falhas: { c1: grpc },
      avisos: [linha('c1', 'p1')],
    });

    const result = await t.run();

    expect(result.contas.find((c) => c.integracaoId === 'c1')!.error).toBe('14 UNAVAILABLE');
    // The inactive pass DID run (c2 left budget) — it just has nothing to close.
    expect(t.avisos.port.listarDoTipo).toHaveBeenCalledTimes(1);
    expect(result.inativasResolvidas).toBe(0);
    expect(t.avisos.resolvidos).toEqual([]);
  });

  it('a conta that no longer matches `ativo == true` is resolved even with ZERO active contas', async () => {
    const t = montar({ contas: [], avisos: [linha('c1', 'p1')] });
    const result = await t.run();
    expect(result.contas).toEqual([]);
    expect(result.inativasResolvidas).toBe(1);
  });
});

/* --------------------------------- the budget -------------------------------- */

describe('the time budget', () => {
  it('a conta reached with no budget left is NOT audited, loudly — and its rows stay', async () => {
    const t = montar({
      contas: ['c1', 'c2'],
      // c1 drains in one page that costs the whole run budget.
      msPorPagina: { c1: AUDITORIA_ORCAMENTO_MS },
      avisos: [linha('c2', 'p1'), linha('c-apagada', 'p2')],
    });

    const result = await t.run();

    expect(result.contas.map((c) => c.integracaoId)).toEqual(['c1']);
    expect(result.naoAuditadas).toEqual(['c2']);
    expect(t.chamadas.map((c) => c.conta)).toEqual(['c1']);
    expect(avisosDeLog().some((m) => m.includes('NÃO auditada'))).toBe(true);
    // The inactive-conta pass is skipped too: no budget, no writes.
    expect(result.inativasResolvidas).toBe(0);
    expect(t.avisos.resolvidos).toEqual([]);
  });

  it('a conta that finishes early hands its slack to the next one', async () => {
    // c1 drains at once; c2 then has the WHOLE remaining budget, not half of it:
    // three 150 s pages fit before its 400 s deadline (0 → 150 → 300 → 450).
    const t = montar({
      contas: ['c1', 'c2'],
      roteiros: { c2: (n: number) => pagina([], `cursor-${String(n)}`) },
      msPorPagina: { c2: 150_000 },
    });
    const result = await t.run();
    expect(result.contas.find((c) => c.integracaoId === 'c2')!.paginas).toBe(3);
  });

  it('a heal loop that outruns the RUN budget stops, counts what is left and resolves nothing', async () => {
    const t = montar({
      roteiros: {
        c1: [
          pagina(
            ['p1', 'p2', 'p3'].map((id) => achado(id, CODIGO_NAO_ENUMERADO.contaForaDoProduto)),
            null,
          ),
        ],
      },
      avisos: [linha('c1', 'p-sumiu')],
    });
    t.curar.mockImplementation(async () => {
      t.relogio.t += AUDITORIA_ORCAMENTO_MS;
      return true;
    });

    const [conta] = (await t.run()).contas;

    expect(conta).toMatchObject({ truncada: 'orcamento', curados: 1, curasPendentes: 2 });
    expect(t.avisos.port.listarDaConta).not.toHaveBeenCalled();
    expect(t.avisos.resolvidos).toEqual([]);
  });
});

/* ------------------------------- containment -------------------------------- */

describe('per-conta containment', () => {
  it('a gRPC-coded failure on conta A is recorded and conta B is still audited', async () => {
    const t = montar({
      contas: ['c1', 'c2'],
      falhas: { c1: Object.assign(new Error('4 DEADLINE_EXCEEDED'), { code: 4 }) },
      roteiros: { c2: [pagina([achado('p1', CODIGO_NAO_ENUMERADO.linkEmVariacao)], null)] },
    });

    const result = await t.run();

    expect(result.contas.map((c) => [c.integracaoId, c.error])).toEqual([
      ['c1', '4 DEADLINE_EXCEEDED'],
      ['c2', null],
    ]);
    expect(t.avisos.escritos.map((p) => p.conta)).toEqual(['c2']);
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a TypeError (a bug)', new TypeError('x is not a function')],
    ['an Error with no gRPC code', new Error('cursor de reconciliação de anúncios inválido')],
    ['a string-coded error', Object.assign(new Error('functions/internal'), { code: 'internal' })],
  ])('%s rethrows and stops the run', async (_n, erro) => {
    const t = montar({ contas: ['c1', 'c2'], falhas: { c1: erro } });
    await expect(t.run()).rejects.toBe(erro);
    expect(t.chamadas.map((c) => c.conta)).toEqual(['c1']);
  });

  it('logs ONE line per conta as it finishes — before the next conta starts', async () => {
    const t = montar({ contas: ['c1', 'c2'] });
    await t.run();
    expect(t.eventos).toEqual([
      'page:c1',
      `info:${AUDITORIA_LOG_PREFIX}: conta concluída`,
      'page:c2',
      `info:${AUDITORIA_LOG_PREFIX}: conta concluída`,
    ]);
  });
});

/* ------------------------------ the key range ------------------------------- */

describe('the avisos key-range read', () => {
  function seedAviso(db: FakeDb, id: string, data: DocData = {}): void {
    db.seed(AVISOS_PATH, id, {
      tipo: TIPO,
      resolvidoEm: null,
      canal: CANAL_AVISO.mercadoLivre,
      params: { situacao: 'link-em-variacao', anuncio: 'MLB1', anuncios: 1 },
      criadoEm: 1,
      ...data,
    });
  }

  it('lists exactly one conta’s rows — `c10`, the bare conta key, the range end and other tipos stay out', async () => {
    const db = new FakeDb();
    seedAviso(db, `${TIPO}:c1:p1`);
    seedAviso(db, `${TIPO}:c1:p2`, { resolvidoEm: 5, canal: CANAL_AVISO.shopee });
    seedAviso(db, `${TIPO}:c10:p3`);
    seedAviso(db, `${TIPO}:c1`);
    seedAviso(db, `${TIPO}:c1;`);
    seedAviso(db, `${TIPO_AVISO.estoqueAcimaDoDisponivel}:c1:p4`);
    seedAviso(db, `${TIPO}Z:c1:p5`);

    const linhas = await listarAvisosDaConta(asDb(db), 'c1');

    expect(linhas).toEqual([
      {
        chave: `${TIPO}:c1:p1`,
        aberto: true,
        canal: 'mercadoLivre',
        params: { situacao: 'link-em-variacao', anuncio: 'MLB1', anuncios: 1 },
      },
      {
        chave: `${TIPO}:c1:p2`,
        aberto: false,
        // The stored canal, projected — what keeps the resolvers off another
        // channel's rows of this shared tipo.
        canal: 'shopee',
        params: { situacao: 'link-em-variacao', anuncio: 'MLB1', anuncios: 1 },
      },
    ]);
    expect(db.queries[0]).toMatchObject({
      path: AVISOS_PATH,
      select: ['resolvidoEm', 'params', 'canal'],
      startAt: `${TIPO}:c1:`,
      endBefore: `${TIPO}:c1;`,
    });
  });

  it('the tipo-wide read spans every conta of this tipo and nothing else', async () => {
    const db = new FakeDb();
    seedAviso(db, `${TIPO}:c1:p1`);
    seedAviso(db, `${TIPO}:c2:p2`);
    seedAviso(db, TIPO);
    seedAviso(db, `${TIPO};`);
    seedAviso(db, `${TIPO_AVISO.estoqueAcimaDoDisponivel}:c1:p4`);

    const linhas = await listarAvisosDoTipo(asDb(db));

    expect(linhas.map((l) => l.chave)).toEqual([`${TIPO}:c1:p1`, `${TIPO}:c2:p2`]);
  });

  it('pages by id and returns every row exactly once', async () => {
    const db = new FakeDb();
    const ids = Array.from({ length: 1001 }, (_, i) => `${TIPO}:c1:p${String(i).padStart(4, '0')}`);
    for (const id of ids) seedAviso(db, id);
    seedAviso(db, `${TIPO}:c2:depois`);

    const linhas = await listarAvisosDaConta(asDb(db), 'c1');

    expect(linhas.map((l) => l.chave)).toEqual(ids);
    expect(db.queries).toHaveLength(3);
    expect(db.queries[1]).toMatchObject({ startAt: null, startAfter: ids[499] });
    expect(db.queries.every((q) => q.endBefore === `${TIPO}:c1;` && q.limit === 500)).toBe(true);
  });

  it('a malformed stored params reads as {}, an absent resolvidoEm as open, a non-string canal as null', async () => {
    const db = new FakeDb();
    db.seed(AVISOS_PATH, `${TIPO}:c1:p1`, { tipo: TIPO, params: ['x'] });
    db.seed(AVISOS_PATH, `${TIPO}:c1:p2`, { tipo: TIPO, params: {}, canal: 7 });
    expect(await listarAvisosDaConta(asDb(db), 'c1')).toEqual([
      { chave: `${TIPO}:c1:p1`, aberto: true, canal: null, params: {} },
      { chave: `${TIPO}:c1:p2`, aberto: true, canal: null, params: {} },
    ]);
  });

  it('refuses an empty conta — its "prefix" would be every conta’s rows', () => {
    expect(() => listarAvisosDaConta(asDb(new FakeDb()), '')).toThrow(RangeError);
  });
});

/* --------------------------------- summary ---------------------------------- */

describe('resumirAuditoria — the run summary line', () => {
  it('sums the contas and carries every key the #948 step reads', async () => {
    const t = montar({
      contas: ['c1', 'c2'],
      roteiros: {
        c1: [
          pagina(
            [
              achado('p1', CODIGO_NAO_ENUMERADO.contaForaDoProduto),
              achado('p2', CODIGO_NAO_ENUMERADO.linkEmVariacao),
            ],
            null,
            { lidos: 10, inspecionados: 4, produtosLidos: 3 },
          ),
        ],
        c2: (n: number) => pagina([], `cursor-${String(n)}`, { lidos: 1 }),
      },
      falhas: {},
      avisos: [linha('c-apagada', 'p9')],
    });

    const result: AuditoriaResult = await t.run();
    const resumo = resumirAuditoria(result, 1234);

    expect(resumo).toEqual({
      enabled: true,
      contas: 2,
      completas: 1,
      truncadas: 1,
      naoAuditadas: [],
      paginas: 1 + AUDITORIA_MAX_PAGINAS_POR_CONTA,
      linksLidos: 10 + AUDITORIA_MAX_PAGINAS_POR_CONTA,
      produtosLidos: 3,
      inspecionados: 4,
      porSituacao: {
        [CODIGO_NAO_ENUMERADO.produtoAusente]: 0,
        [CODIGO_NAO_ENUMERADO.linkEmVariacao]: 1,
        [CODIGO_NAO_ENUMERADO.paiIdInvalido]: 0,
        [CODIGO_NAO_ENUMERADO.contaForaDoProduto]: 1,
      },
      curados: 1,
      curasSemEfeito: 0,
      curasPendentes: 0,
      amostraCurados: ['c1/p1'],
      avisos: { criado: 1, repetido: 0, reaberto: 0, ignorado: 0 },
      inalterados: 0,
      suprimidos: 0,
      amostraSuprimidos: [],
      resolvidos: 0,
      mantidos: 0,
      inativasResolvidas: 1,
      errorCount: 0,
      duracaoMs: 1234,
    });
  });

  it('the disabled run summarises as such', () => {
    expect(
      resumirAuditoria({ enabled: false, contas: [], naoAuditadas: [], inativasResolvidas: 0 }, 0),
    ).toMatchObject({ enabled: false, contas: 0, completas: 0, errorCount: 0 });
  });
});
