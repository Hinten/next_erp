import type { WriteStream } from 'node:fs';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BatchWriter, ChangeSink, type MigrationContext } from '../runner';
import {
  executarTokenoautLegado,
  NOME_DA_PASSAGEM,
  TokenoautForaDaListagemError,
  TokenoautRemanescenteError,
} from './migrate';
import {
  COLECAO_PAI,
  ContagemTokenoautInvalidaError,
  contarPorTipo,
  descreverRemocao,
  planoDaConta,
  ROTULO_DO_REGISTRO,
  SUBCOLECAO_LEGADA,
  TAMANHO_DA_PAGINA,
} from './transform';

// Sentinel credential value, deliberately NOT shaped like a real LWA token: if
// it ever shows up in a log row, a census line or an error, the migration is
// leaking the credential it exists to delete.
const SENTINELA = 'sentinela-nao-e-um-token-0000';

/** The models' sandbox seller-id placeholder; never a real seller. */
const SPID = 'AXXXXXXXXXXXXX';

/** Every sibling a careless matcher could take for the legacy store. Some are live. */
const VIZINHAS = ['tokenOaut', 'tokenoauth', 'token6h', 'tokenDuravel', 'credenciais'] as const;

/* ------------------------------ transform.ts ------------------------------ */

describe('SUBCOLECAO_LEGADA', () => {
  it('is exactly the legacy name, and no near-miss equals it', () => {
    expect(SUBCOLECAO_LEGADA).toBe('tokenoaut');
    expect(COLECAO_PAI).toBe('integracao');
    for (const vizinha of VIZINHAS) expect(vizinha).not.toBe(SUBCOLECAO_LEGADA);
  });

  it('pages within one Firestore batch (≤ 500 writes)', () => {
    expect(TAMANHO_DA_PAGINA).toBeGreaterThan(0);
    expect(TAMANHO_DA_PAGINA).toBeLessThanOrEqual(500);
  });
});

describe('planoDaConta', () => {
  it('deletes when the subcollection holds anything, reporting the parent tipo', () => {
    expect(planoDaConta({ existe: true, tipo: 8, contagem: 3 })).toEqual({
      acao: 'apagar',
      tipoRelatorio: 8,
    });
  });

  it('does nothing when the subcollection is empty — and so is idempotent', () => {
    expect(planoDaConta({ existe: true, tipo: 8, contagem: 0 })).toEqual({
      acao: 'nada',
      tipoRelatorio: 8,
    });
  });

  it('deletes under a MISSING parent, reported as an orphan', () => {
    expect(planoDaConta({ existe: false, tipo: undefined, contagem: 1 })).toEqual({
      acao: 'apagar',
      tipoRelatorio: 'orfa',
    });
    // A tipo leaking in for a missing parent must not be believed.
    expect(planoDaConta({ existe: false, tipo: 8, contagem: 1 }).tipoRelatorio).toBe('orfa');
  });

  it('near-miss: the decision does not depend on the tipo — any parent loses its tokenoaut', () => {
    for (const tipo of [0, 1, 3, 7, 8, 9]) {
      expect(planoDaConta({ existe: true, tipo, contagem: 1 })).toEqual({
        acao: 'apagar',
        tipoRelatorio: tipo,
      });
    }
  });

  it('reports a tipo that is not a finite number as desconhecido', () => {
    for (const tipo of ['8', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, { v: 8 }]) {
      expect(planoDaConta({ existe: true, tipo, contagem: 2 })).toEqual({
        acao: 'apagar',
        tipoRelatorio: 'desconhecido',
      });
    }
  });

  it('refuses a count that no count() can return', () => {
    for (const contagem of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => planoDaConta({ existe: true, tipo: 8, contagem })).toThrow(
        ContagemTokenoautInvalidaError,
      );
    }
  });
});

describe('descreverRemocao', () => {
  it('carries the parent tipo and nothing else', () => {
    expect(descreverRemocao(8)).toEqual({ from: { tipo: 8 }, to: 'apagado' });
    expect(descreverRemocao('orfa')).toEqual({ from: { tipo: 'orfa' }, to: 'apagado' });
  });
});

describe('contarPorTipo', () => {
  it('counts contas and documents per tipo, orphans and unknowns apart, skipping empty parents', () => {
    const tally = contarPorTipo([
      { plano: { acao: 'apagar', tipoRelatorio: 8 }, contagem: 4 },
      { plano: { acao: 'apagar', tipoRelatorio: 8 }, contagem: 1 },
      { plano: { acao: 'apagar', tipoRelatorio: 'orfa' }, contagem: 2 },
      { plano: { acao: 'apagar', tipoRelatorio: 'desconhecido' }, contagem: 1 },
      { plano: { acao: 'nada', tipoRelatorio: 1 }, contagem: 0 },
    ]);
    expect(Object.fromEntries(tally)).toEqual({
      '8': { contas: 2, documentos: 5 },
      orfa: { contas: 1, documentos: 2 },
      desconhecido: { contas: 1, documentos: 1 },
    });
  });

  it('is empty when no parent carries the subcollection — the post-apply census', () => {
    expect(
      contarPorTipo([
        { plano: { acao: 'nada', tipoRelatorio: 8 }, contagem: 0 },
        { plano: { acao: 'nada', tipoRelatorio: 'orfa' }, contagem: 0 },
      ]).size,
    ).toBe(0);
  });
});

/* ------------------------- migrate.ts — the I/O ------------------------- */

type Dados = Record<string, unknown>;

interface Consulta {
  caminho: string;
  ordemPorChave: boolean;
  projecao: string[] | null;
  limite: number | null;
  depoisDe: string | null;
}

interface Op {
  op: 'delete' | 'set' | 'update' | 'create';
  caminho: string;
}

interface Registro {
  listagens: string[];
  leiturasDePai: Array<{ caminhos: string[]; mascara: unknown }>;
  contagens: string[];
  contagensDeGrupo: string[];
  consultas: Consulta[];
  ops: Op[];
  commits: number;
}

interface OpcoesDoBanco {
  /** The commit "succeeds" but deletes nothing: a lost delete. */
  perdeDeletes?: boolean;
  /** Called when a key page comes back empty — a concurrent writer can add a doc there. */
  aoEsvaziar?: (caminhoDaColecao: string, docs: Map<string, Dados>) => void;
  /** Parent ids `listDocuments()` leaves out: a listing that misses a parent. */
  ocultaPais?: readonly string[];
  /** The Nth `commit()` (1-based) rejects with this error and applies nothing. */
  falhaNoCommit?: { n: number; erro: Error };
}

/**
 * Just enough Admin Firestore for this script: `collection().listDocuments()`,
 * `getAll(...refs, { fieldMask })`, `ref.collection(c).count().get()`,
 * `collectionGroup(c).count().get()`, `.orderBy().select().limit().startAfter().get()`
 * and `batch()`. Documents live in one flat path map; a parent "exists" only when
 * its own path is in it, so a subcollection doc with no parent doc is the orphan
 * shape `listDocuments()` still returns.
 *
 * ⚠️ A token document's `data()` THROWS: the script must never read a field of
 * one. `select()` records its projection so the tests can pin it as empty.
 */
function bancoFalso(inicial: Record<string, Dados>, opcoes: OpcoesDoBanco = {}) {
  const docs = new Map<string, Dados>(Object.entries(inicial));
  const registro: Registro = {
    listagens: [],
    leiturasDePai: [],
    contagens: [],
    contagensDeGrupo: [],
    consultas: [],
    ops: [],
    commits: 0,
  };

  const filhos = (colecao: string): string[] =>
    [...docs.keys()]
      .filter((p) => p.startsWith(`${colecao}/`) && !p.slice(colecao.length + 1).includes('/'))
      .map((p) => p.slice(colecao.length + 1))
      .sort();

  function ref(caminho: string) {
    return {
      path: caminho,
      id: caminho.split('/').at(-1)!,
      collection: (nome: string) => colecao(`${caminho}/${nome}`),
    };
  }

  function consulta(caminho: string, estado: Omit<Consulta, 'caminho'>) {
    return {
      select: (...campos: string[]) => consulta(caminho, { ...estado, projecao: campos }),
      limit: (n: number) => consulta(caminho, { ...estado, limite: n }),
      startAfter: (snap: { ref: { path: string } }) =>
        consulta(caminho, { ...estado, depoisDe: snap.ref.path }),
      get: async () => {
        registro.consultas.push({ caminho, ...estado });
        // Microtask-only promises never yield to vitest's timer, so a key walk
        // that never ends would hang the run instead of timing out: cap it.
        if (registro.consultas.length > 1_000) throw new Error('laço de páginas sem fim');
        let ids = filhos(caminho);
        if (estado.depoisDe !== null) {
          const depois = estado.depoisDe.split('/').at(-1)!;
          ids = ids.filter((id) => id > depois);
        }
        if (estado.limite !== null) ids = ids.slice(0, estado.limite);
        if (ids.length === 0) opcoes.aoEsvaziar?.(caminho, docs);
        const lidos = ids.map((id) => ({
          id,
          ref: ref(`${caminho}/${id}`),
          data: (): never => {
            throw new Error(`${caminho}/${id}: um campo de documento de token foi lido`);
          },
        }));
        return { docs: lidos, size: lidos.length, empty: lidos.length === 0 };
      },
    };
  }

  function colecao(caminho: string) {
    return {
      path: caminho,
      listDocuments: async () => {
        registro.listagens.push(caminho);
        const ids = new Set(
          [...docs.keys()]
            .filter((p) => p.startsWith(`${caminho}/`))
            .map((p) => p.slice(caminho.length + 1).split('/')[0]!),
        );
        return [...ids]
          .filter((id) => !(opcoes.ocultaPais ?? []).includes(id))
          .map((id) => ref(`${caminho}/${id}`));
      },
      count: () => ({
        get: async () => {
          registro.contagens.push(caminho);
          const n = filhos(caminho).length;
          return { data: () => ({ count: n }) };
        },
      }),
      orderBy: (campo: unknown) =>
        consulta(caminho, {
          ordemPorChave: campo instanceof FieldPath && campo.isEqual(FieldPath.documentId()),
          projecao: null,
          limite: null,
          depoisDe: null,
        }),
    };
  }

  const db = {
    collection: (nome: string) => colecao(nome),
    // Every document whose immediate collection is `nome`, at any depth and
    // whatever its parent: the listing plays no part in it.
    collectionGroup: (nome: string) => ({
      count: () => ({
        get: async () => {
          registro.contagensDeGrupo.push(nome);
          const n = [...docs.keys()].filter((p) => {
            const partes = p.split('/');
            return partes.length % 2 === 0 && partes.at(-2) === nome;
          }).length;
          return { data: () => ({ count: n }) };
        },
      }),
    }),
    getAll: async (...args: unknown[]) => {
      const ultimo = args.at(-1) as { fieldMask?: unknown; path?: unknown } | undefined;
      const temOpcoes = ultimo !== undefined && ultimo.path === undefined;
      const refs = (temOpcoes ? args.slice(0, -1) : args) as Array<ReturnType<typeof ref>>;
      const mascara = temOpcoes ? ultimo.fieldMask : undefined;
      registro.leiturasDePai.push({ caminhos: refs.map((r) => r.path), mascara });
      return refs.map((r) => {
        const dados = docs.get(r.path);
        return {
          ref: r,
          exists: dados !== undefined,
          get: (campo: string) => {
            if (!Array.isArray(mascara) || !mascara.includes(campo)) {
              throw new Error(`${r.path}: campo '${campo}' lido fora da máscara`);
            }
            return dados?.[campo];
          },
        };
      });
    },
    batch: () => {
      const pendentes: Op[] = [];
      const anota = (op: Op['op']) => (r: { path: string }) => {
        pendentes.push({ op, caminho: r.path });
      };
      return {
        delete: anota('delete'),
        set: anota('set'),
        update: anota('update'),
        create: anota('create'),
        commit: async () => {
          registro.commits += 1;
          if (opcoes.falhaNoCommit?.n === registro.commits) throw opcoes.falhaNoCommit.erro;
          for (const p of pendentes) {
            registro.ops.push(p);
            if (p.op === 'delete' && !opcoes.perdeDeletes) docs.delete(p.caminho);
          }
        },
      };
    },
  };
  return { db: db as unknown as Firestore, docs, registro };
}

interface LinhaJsonl {
  kind: string;
  path: string;
  field: string;
  from: unknown;
  to: unknown;
}

function contexto(
  db: Firestore,
  modo: { apply?: boolean; reportOnly?: boolean } = {},
): { ctx: MigrationContext; linhas: LinhaJsonl[]; brutas: string[] } {
  const linhas: LinhaJsonl[] = [];
  const brutas: string[] = [];
  const stream = {
    write: (s: string) => {
      brutas.push(s);
      linhas.push(JSON.parse(s) as LinhaJsonl);
    },
  };
  const apply = modo.apply ?? false;
  const reportOnly = modo.reportOnly ?? false;
  return {
    linhas,
    brutas,
    ctx: {
      db,
      apply,
      reportOnly,
      sink: new ChangeSink(stream as unknown as WriteStream),
      // The runner's writer has no delete, and this pass never touches it.
      writer: {} as BatchWriter,
      args: { projectId: 'demo-erp', apply, reportOnly, targets: [] },
    },
  };
}

const token = (revoked: boolean): Dados => ({
  access_token: SENTINELA,
  refresh_token: SENTINELA,
  token_type: 'bearer',
  expires_in: 0,
  revoked,
});

/**
 * - `amz-1` (tipo 8): two tokenoaut docs, one revoked and one not, plus every
 *   near-miss sibling holding a credential-shaped value;
 * - `amz-2` (tipo 8): five tokenoaut docs, so a page of 2 crosses boundaries;
 * - `ml-1` (tipo 1): no tokenoaut at all, only its own token6h;
 * - `orfa-1`: NO parent document, one tokenoaut doc left behind;
 * - `estranha` (tipo '8' as text): one tokenoaut doc, reported desconhecido.
 */
function corpus(): Record<string, Dados> {
  const base: Record<string, Dados> = {
    'integracao/amz-1': { tipo: 8, nome: 'Conta A', ativo: true, selling_partner_id: SPID },
    'integracao/amz-1/tokenoaut/t-revogado': token(true),
    'integracao/amz-1/tokenoaut/t-vivo': token(false),
    'integracao/amz-2': { tipo: 8, nome: 'Conta B', ativo: false, selling_partner_id: null },
    'integracao/ml-1': { tipo: 1, nome: 'Conta C', ativo: true },
    'integracao/ml-1/token6h/atual': { access_token: SENTINELA },
    'integracao/orfa-1/tokenoaut/t-orfao': token(false),
    'integracao/estranha': { tipo: '8', nome: 'Conta D' },
    'integracao/estranha/tokenoaut/t-1': token(false),
  };
  for (let i = 1; i <= 5; i += 1) base[`integracao/amz-2/tokenoaut/t-${i}`] = token(i % 2 === 0);
  for (const vizinha of VIZINHAS) {
    base[`integracao/amz-1/${vizinha}/current`] = { refresh_token: SENTINELA };
  }
  return base;
}

const TOKENOAUT = Object.keys(corpus())
  .filter((p) => p.split('/')[2] === SUBCOLECAO_LEGADA)
  .sort();

describe(`migrate.ts — ${NOME_DA_PASSAGEM}`, () => {
  let saida: string[];

  beforeEach(() => {
    saida = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      saida.push(String(m));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('report-only: counts per tipo, writes nothing, walks no key and logs no row', async () => {
    const { db, registro } = bancoFalso(corpus());
    const { ctx, linhas } = contexto(db, { reportOnly: true });
    const resumo = await executarTokenoautLegado(ctx, { tamanhoDaPagina: 2 });

    expect(resumo).toEqual({ docsScanned: 5, docsChanged: 0 });
    expect(registro.ops).toEqual([]);
    expect(registro.consultas).toEqual([]);
    expect(linhas).toEqual([]);
    const censo = saida.join('\n');
    expect(censo).toContain('5 pai(s) em integracao (1 sem documento)');
    expect(censo).toContain(`4 com tokenoaut, ${TOKENOAUT.length} documento(s) de tokenoaut`);
    expect(censo).toMatch(/tipo 8\s+contas\s+2\s+documentos\s+7/);
    expect(censo).toMatch(/tipo orfa\s+contas\s+1\s+documentos\s+1/);
    expect(censo).toMatch(/tipo desconhecido\s+contas\s+1\s+documentos\s+1/);
    // The independent total agrees with the listed parents: no divergence line.
    expect(censo).toContain(`grupo tokenoaut (sem a listagem): ${TOKENOAUT.length} documento(s)`);
    expect(censo).not.toContain('DIVERGÊNCIA');
    expect(registro.contagensDeGrupo).toEqual([SUBCOLECAO_LEGADA]);
    expect(censo).not.toContain(SENTINELA);
  });

  it('walks parents with listDocuments() — the orphan is found — and reads only their tipo', async () => {
    const { db, registro } = bancoFalso(corpus());
    await executarTokenoautLegado(contexto(db, { reportOnly: true }).ctx, { tamanhoDaPagina: 2 });

    expect(registro.listagens).toEqual([COLECAO_PAI]);
    const lidos = registro.leiturasDePai.flatMap((l) => l.caminhos);
    expect(lidos).toContain('integracao/orfa-1');
    expect(lidos).toHaveLength(5);
    for (const leitura of registro.leiturasDePai) expect(leitura.mascara).toEqual(['tipo']);
    // Counts touch the exact subcollection and nothing else.
    expect(registro.contagens.every((c) => c.endsWith(`/${SUBCOLECAO_LEGADA}`))).toBe(true);
  });

  it('dry run: one row per document it would delete, across pages, and no write at all', async () => {
    const { db, docs, registro } = bancoFalso(corpus());
    const antes = new Map(docs);
    const { ctx, linhas } = contexto(db);
    const resumo = await executarTokenoautLegado(ctx, { tamanhoDaPagina: 2 });

    expect(registro.ops).toEqual([]);
    expect(docs).toEqual(antes);
    expect(linhas.map((l) => l.path).sort()).toEqual(TOKENOAUT);
    expect(resumo).toEqual({ docsScanned: TOKENOAUT.length, docsChanged: TOKENOAUT.length });
    // amz-2 holds five names: pages of 2, 2, 1, walked by cursor.
    const amz2 = registro.consultas.filter((c) => c.caminho === 'integracao/amz-2/tokenoaut');
    expect(amz2.map((c) => c.depoisDe)).toEqual([
      null,
      'integracao/amz-2/tokenoaut/t-2',
      'integracao/amz-2/tokenoaut/t-4',
    ]);
  });

  it('apply: deletes every tokenoaut document — revoked and live alike, orphans included', async () => {
    const { db, docs, registro } = bancoFalso(corpus());
    const { ctx, linhas } = contexto(db, { apply: true });
    const resumo = await executarTokenoautLegado(ctx, { tamanhoDaPagina: 2 });

    expect(resumo).toEqual({ docsScanned: TOKENOAUT.length, docsChanged: TOKENOAUT.length });
    for (const caminho of TOKENOAUT) expect(docs.has(caminho)).toBe(false);
    expect(registro.ops.map((o) => o.caminho).sort()).toEqual(TOKENOAUT);
    expect(linhas.map((l) => l.path).sort()).toEqual(TOKENOAUT);
    expect(saida.join('\n')).toContain(`APAGADOS: ${TOKENOAUT.length} documento(s)`);
    expect(saida.join('\n')).toContain('0 restante(s) no grupo');
    // The group was counted again after the deletes, independently of the listing.
    expect(registro.contagensDeGrupo).toEqual([SUBCOLECAO_LEGADA, SUBCOLECAO_LEGADA]);
  });

  it('apply walks by CURSOR — never re-reads the first page over what it just deleted', async () => {
    const { db, registro } = bancoFalso(corpus());
    await executarTokenoautLegado(contexto(db, { apply: true }).ctx, { tamanhoDaPagina: 2 });

    // amz-2 holds five names: pages of 2, 2, 1, each one after the last key of
    // the page before it, deleted or not. A re-read from the start would show
    // `null` on every page.
    const amz2 = registro.consultas.filter((c) => c.caminho === 'integracao/amz-2/tokenoaut');
    expect(amz2.map((c) => c.depoisDe)).toEqual([
      null,
      'integracao/amz-2/tokenoaut/t-2',
      'integracao/amz-2/tokenoaut/t-4',
    ]);
  });

  it('apply: every operation is a document DELETE — never a set, update or create', async () => {
    const { db, registro } = bancoFalso(corpus());
    await executarTokenoautLegado(contexto(db, { apply: true }).ctx, { tamanhoDaPagina: 2 });

    expect(registro.ops.length).toBeGreaterThan(0);
    expect(new Set(registro.ops.map((o) => o.op))).toEqual(new Set(['delete']));
  });

  it('near-miss: sibling subcollections and the conta document are never touched', async () => {
    const { db, docs, registro } = bancoFalso(corpus());
    await executarTokenoautLegado(contexto(db, { apply: true }).ctx, { tamanhoDaPagina: 2 });

    for (const vizinha of VIZINHAS) {
      expect(docs.get(`integracao/amz-1/${vizinha}/current`)).toEqual({ refresh_token: SENTINELA });
    }
    expect(docs.get('integracao/ml-1/token6h/atual')).toEqual({ access_token: SENTINELA });
    expect(docs.get('integracao/amz-1')).toEqual({
      tipo: 8,
      nome: 'Conta A',
      ativo: true,
      selling_partner_id: SPID,
    });
    expect(docs.get('integracao/amz-2')).toBeDefined();
    expect(docs.has('integracao/orfa-1')).toBe(false); // never minted
    const tocados = [
      ...registro.ops.map((o) => o.caminho),
      ...registro.consultas.map((c) => c.caminho),
      ...registro.contagens,
    ];
    for (const caminho of tocados) expect(caminho.split('/')[2]).toBe(SUBCOLECAO_LEGADA);
    // The group total names the exact collection id too, never a near-miss.
    expect(registro.contagensDeGrupo.length).toBeGreaterThan(0);
    for (const grupo of registro.contagensDeGrupo) expect(grupo).toBe(SUBCOLECAO_LEGADA);
  });

  it.each([
    ['dry run', { apply: false }],
    ['apply', { apply: true }],
  ])(
    'never reads a field of a token document (%s): an empty projection on every key page',
    async (_modo, modo) => {
      const { db, registro } = bancoFalso(corpus());
      // The fake's data() throws on any token doc, so a field read fails this run.
      await executarTokenoautLegado(contexto(db, modo).ctx, { tamanhoDaPagina: 2 });

      expect(registro.consultas.length).toBeGreaterThan(0);
      for (const c of registro.consultas) {
        expect(c.projecao, c.caminho).toEqual([]);
        expect(c.ordemPorChave, c.caminho).toBe(true);
        expect(c.limite, c.caminho).toBe(2);
      }
    },
  );

  it('a JSONL row carries the path and the parent tipo only — never a value', async () => {
    const { db } = bancoFalso(corpus());
    const { ctx, linhas, brutas } = contexto(db, { apply: true });
    await executarTokenoautLegado(ctx, { tamanhoDaPagina: 2 });

    expect(brutas.join('')).not.toContain(SENTINELA);
    expect(brutas.join('')).not.toContain(SPID);
    for (const linha of linhas) {
      expect(Object.keys(linha).sort()).toEqual(['field', 'from', 'kind', 'path', 'to']);
      expect(linha.kind).toBe('change');
      expect(linha.field).toBe(ROTULO_DO_REGISTRO);
      expect(Object.keys(linha.from as object)).toEqual(['tipo']);
      expect(linha.to).toBe('apagado');
    }
    const porCaminho = new Map(linhas.map((l) => [l.path, (l.from as { tipo: unknown }).tipo]));
    expect(porCaminho.get('integracao/amz-1/tokenoaut/t-vivo')).toBe(8);
    expect(porCaminho.get('integracao/orfa-1/tokenoaut/t-orfao')).toBe('orfa');
    expect(porCaminho.get('integracao/estranha/tokenoaut/t-1')).toBe('desconhecido');
  });

  it('is IDEMPOTENT: a second apply deletes nothing and the census reads 0', async () => {
    const { db, registro } = bancoFalso(corpus());
    await executarTokenoautLegado(contexto(db, { apply: true }).ctx, { tamanhoDaPagina: 2 });
    const opsDaPrimeira = registro.ops.length;

    const segunda = contexto(db, { apply: true });
    expect(await executarTokenoautLegado(segunda.ctx, { tamanhoDaPagina: 2 })).toEqual({
      docsScanned: 0,
      docsChanged: 0,
    });
    expect(registro.ops).toHaveLength(opsDaPrimeira);
    expect(segunda.linhas).toEqual([]);

    saida = [];
    const censo = contexto(db, { reportOnly: true });
    await executarTokenoautLegado(censo.ctx, { tamanhoDaPagina: 2 });
    expect(saida.join('\n')).toContain('0 com tokenoaut, 0 documento(s) de tokenoaut');
    expect(saida.join('\n')).toContain('grupo tokenoaut (sem a listagem): 0 documento(s)');
  });

  it('a delete that does not land fails the final count, naming every parent left non-empty', async () => {
    const { db } = bancoFalso(corpus(), { perdeDeletes: true });
    const erro = await executarTokenoautLegado(contexto(db, { apply: true }).ctx, {
      tamanhoDaPagina: 2,
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(TokenoautRemanescenteError);
    expect((erro as TokenoautRemanescenteError).remanescentes).toEqual([
      { caminho: 'integracao/amz-1', restantes: 2 },
      { caminho: 'integracao/amz-2', restantes: 5 },
      { caminho: 'integracao/estranha', restantes: 1 },
      { caminho: 'integracao/orfa-1', restantes: 1 },
    ]);
  });

  it('a JSONL row is written only after its batch commits — a failed commit logs nothing of its page', async () => {
    // gRPC ABORTED, the shape the Admin SDK rejects a commit with.
    const falha = Object.assign(new Error('10 ABORTED: commit recusado'), { code: 10 });
    // Pages of 2, parents in path order: commit 1 = amz-1 (t-revogado, t-vivo),
    // commit 2 = amz-2 (t-1, t-2), commit 3 = amz-2 (t-3, t-4) fails.
    const { db, docs } = bancoFalso(corpus(), { falhaNoCommit: { n: 3, erro: falha } });
    const { ctx, linhas } = contexto(db, { apply: true });

    await expect(executarTokenoautLegado(ctx, { tamanhoDaPagina: 2 })).rejects.toBe(falha);
    expect(linhas.map((l) => l.path)).toEqual([
      'integracao/amz-1/tokenoaut/t-revogado',
      'integracao/amz-1/tokenoaut/t-vivo',
      'integracao/amz-2/tokenoaut/t-1',
      'integracao/amz-2/tokenoaut/t-2',
    ]);
    // The failed page is still there, and no row claims it went.
    for (const id of ['t-3', 't-4']) {
      expect(docs.has(`integracao/amz-2/tokenoaut/${id}`)).toBe(true);
    }
  });

  it('a document landing behind the cursor fails the final count — paths only in the error', async () => {
    let escrito = false;
    const { db } = bancoFalso(corpus(), {
      aoEsvaziar: (colecao, docs) => {
        if (escrito || colecao !== 'integracao/amz-1/tokenoaut') return;
        escrito = true;
        docs.set(`${colecao}/t-tardio`, token(false));
      },
    });
    const erro = await executarTokenoautLegado(contexto(db, { apply: true }).ctx, {
      tamanhoDaPagina: 2,
    }).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(TokenoautRemanescenteError);
    const { remanescentes, message } = erro as TokenoautRemanescenteError;
    expect(remanescentes).toEqual([{ caminho: 'integracao/amz-1', restantes: 1 }]);
    expect(message).not.toContain(SENTINELA);
  });

  describe('a parent the listing does not return', () => {
    // `orfa-1` holds a live token document, but listDocuments() leaves it out:
    // every per-parent count reads 0 for what remains, so only the group total
    // can see it.
    const oculto = 'integracao/orfa-1/tokenoaut/t-orfao';

    it('report-only flags the divergence between the group and the listed parents', async () => {
      const { db } = bancoFalso(corpus(), { ocultaPais: ['orfa-1'] });
      await executarTokenoautLegado(contexto(db, { reportOnly: true }).ctx, {
        tamanhoDaPagina: 2,
      });

      const censo = saida.join('\n');
      expect(censo).toContain(
        `4 pai(s) em integracao (0 sem documento), 3 com tokenoaut, ${TOKENOAUT.length - 1} documento(s)`,
      );
      expect(censo).toContain(`grupo tokenoaut (sem a listagem): ${TOKENOAUT.length} documento(s)`);
      expect(censo).toContain('DIVERGÊNCIA');
      expect(censo).not.toContain(SENTINELA);
    });

    it('apply fails after deleting what it can reach, the unreached document untouched', async () => {
      const { db, docs } = bancoFalso(corpus(), { ocultaPais: ['orfa-1'] });
      const { ctx, linhas } = contexto(db, { apply: true });
      const erro = await executarTokenoautLegado(ctx, { tamanhoDaPagina: 2 }).catch(
        (e: unknown) => e,
      );

      expect(erro).toBeInstanceOf(TokenoautForaDaListagemError);
      expect((erro as TokenoautForaDaListagemError).restantes).toBe(1);
      expect((erro as Error).message).not.toContain(SENTINELA);
      expect(docs.has(oculto)).toBe(true);
      expect(linhas.map((l) => l.path).sort()).toEqual(TOKENOAUT.filter((p) => p !== oculto));
    });

    it('a re-run with nothing left under the listed parents still fails on the group', async () => {
      const { db } = bancoFalso(corpus(), { ocultaPais: ['orfa-1'] });
      await executarTokenoautLegado(contexto(db, { apply: true }).ctx, {
        tamanhoDaPagina: 2,
      }).catch((e: unknown) => e);

      // No listed parent has an alvo now; the group is the only thing left to say so.
      await expect(
        executarTokenoautLegado(contexto(db, { apply: true }).ctx, { tamanhoDaPagina: 2 }),
      ).rejects.toThrow(TokenoautForaDaListagemError);
    });
  });
});
