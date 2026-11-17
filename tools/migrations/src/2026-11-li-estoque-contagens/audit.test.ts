import { FieldPath } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationArgError, type MigrationContext } from '../runner';
import {
  CAMPOS_DA_CONTA,
  CAMPOS_DA_OPERACAO,
  CAMPOS_DO_ESTOQUE,
  CAMPOS_DO_PRODUTO,
  CAMPOS_DO_VINCULO,
  CONCORRENCIA,
  ContagemNaoAvaliada,
  criarContagem,
  parseArgsDaContagem,
} from './audit';
import { NOME_DA_CONTAGEM, type Resumo } from './predicate';

/**
 * The walk, driven against a fake Firestore. `predicate.test.ts` covers the decisions; this
 * covers what the runbook promises about HOW they are reached: `--apply` refused before anything
 * exists, nothing ever written, the two key walks where-less on the document key, the window and
 * ledger queries on one field each, the ledger read only for the records it is about, the two
 * refusals, and the summary written.
 *
 * Importing `audit.ts` is safe under vitest: its entrypoint guard compares `import.meta.url` to
 * `process.argv[1]`, which is the vitest binary here, so nothing runs.
 */

/** One query or point read the walk sent. */
interface Leitura {
  readonly tipo: 'colecao' | 'grupo' | 'getAll';
  readonly alvo: string;
  readonly select: readonly string[] | null;
  readonly where: readonly (readonly [string, string, unknown])[];
  readonly orderBy: readonly (readonly [string, string])[];
  readonly limit: number | null;
  readonly startAfter: string | null;
  readonly fieldMask?: readonly string[];
}

interface Estado {
  readonly escopo: { readonly tipo: 'colecao' | 'grupo'; readonly alvo: string };
  readonly select: readonly string[] | null;
  readonly where: readonly (readonly [string, string, unknown])[];
  readonly orderBy: readonly (readonly [string, string])[];
  readonly limit: number | null;
  readonly startAfter: string | null;
}

type Docs = Record<string, Record<string, unknown>>;

const pai = (caminho: string): string => caminho.split('/').slice(0, -1).join('/');
const ultimo = (caminho: string): string => caminho.split('/').at(-1) ?? '';
const projetar = (dados: Record<string, unknown>, campos: readonly string[] | null) =>
  campos === null
    ? { ...dados }
    : Object.fromEntries(campos.filter((c) => Object.hasOwn(dados, c)).map((c) => [c, dados[c]]));

/**
 * Enough of the Admin SDK for the walk, with NO write method at all: a `set`, `update`, `batch`
 * or transaction would throw a TypeError. Every query and `getAll` is logged with what it asked.
 * `falhaNaRazao` makes every `historicoEstoque` query reject with that error.
 */
function fakeDb(docs: Docs, leituras: Leitura[], falhaNaRazao?: unknown) {
  const snapshotDoc = (caminho: string, campos: readonly string[] | null) => {
    const dados = docs[caminho];
    return {
      id: ultimo(caminho),
      exists: dados !== undefined,
      ref: { path: caminho },
      data: () => (dados === undefined ? undefined : projetar(dados, campos)),
      get: (campo: string) => dados?.[campo],
    };
  };

  const consulta = (estado: Estado): Record<string, unknown> => ({
    select: (...campos: string[]) => consulta({ ...estado, select: campos }),
    where: (campo: string, op: string, valor: unknown) =>
      consulta({ ...estado, where: [...estado.where, [campo, op, valor]] }),
    orderBy: (campo: unknown, direcao: string = 'asc') =>
      consulta({
        ...estado,
        orderBy: [
          ...estado.orderBy,
          [campo instanceof FieldPath ? '__name__' : String(campo), direcao],
        ],
      }),
    limit: (n: number) => consulta({ ...estado, limit: n }),
    startAfter: (snap: { ref: { path: string } }) =>
      consulta({ ...estado, startAfter: snap.ref.path }),
    get: async () => {
      leituras.push({ tipo: estado.escopo.tipo, alvo: estado.escopo.alvo, ...estado });
      if (falhaNaRazao !== undefined && estado.escopo.alvo.endsWith('/historicoEstoque')) {
        throw falhaNaRazao;
      }
      let caminhos = Object.keys(docs).filter((c) =>
        estado.escopo.tipo === 'colecao'
          ? pai(c) === estado.escopo.alvo
          : pai(c).split('/').at(-1) === estado.escopo.alvo,
      );
      for (const [campo, op, valor] of estado.where) {
        if (op !== '>=') throw new Error(`fake: operator ${op} not supported`);
        caminhos = caminhos.filter((c) => {
          const v = docs[c]![campo];
          return typeof v === 'number' && typeof valor === 'number' && v >= valor;
        });
      }
      const [ordem] = estado.orderBy;
      caminhos.sort((a, b) => {
        if (ordem !== undefined && ordem[0] !== '__name__') {
          const va = docs[a]![ordem[0]] as number;
          const vb = docs[b]![ordem[0]] as number;
          if (va !== vb) return ordem[1] === 'desc' ? vb - va : va - vb;
        }
        return a < b ? -1 : a > b ? 1 : 0;
      });
      if (estado.startAfter !== null) {
        caminhos = caminhos.slice(caminhos.indexOf(estado.startAfter) + 1);
      }
      if (estado.limit !== null) caminhos = caminhos.slice(0, estado.limit);
      const snaps = caminhos.map((c) => snapshotDoc(c, estado.select));
      return { size: snaps.length, empty: snaps.length === 0, docs: snaps };
    },
  });

  const inicial = (tipo: 'colecao' | 'grupo', alvo: string): Estado => ({
    escopo: { tipo, alvo },
    select: null,
    where: [],
    orderBy: [],
    limit: null,
    startAfter: null,
  });

  const docRef = (caminho: string) => ({
    path: caminho,
    id: ultimo(caminho),
    collection: (sub: string) => consulta(inicial('colecao', `${caminho}/${sub}`)),
  });

  return {
    databaseId: 'fake-db',
    collection: (caminho: string) => ({
      ...consulta(inicial('colecao', caminho)),
      doc: (id: string) => docRef(`${caminho}/${id}`),
    }),
    collectionGroup: (id: string) => consulta(inicial('grupo', id)),
    doc: (caminho: string) => docRef(caminho),
    getAll: async (...args: unknown[]) => {
      const opcoes = args.at(-1) as { fieldMask?: string[] };
      const refs = args.slice(0, -1) as { path: string }[];
      leituras.push({
        tipo: 'getAll',
        alvo: refs.map((r) => r.path).join(','),
        select: null,
        where: [],
        orderBy: [],
        limit: null,
        startAfter: null,
        fieldMask: opcoes.fieldMask,
      });
      return refs.map((r) => snapshotDoc(r.path, opcoes.fieldMask ?? null));
    },
  } as unknown as MigrationContext['db'];
}

/** A `writer` that fails the test on ANY access: the script has no write path. */
const writerProibido = new Proxy(
  {},
  {
    get(_alvo, prop) {
      throw new Error(`the count touched the writer (${String(prop)})`);
    },
  },
) as MigrationContext['writer'];

interface Linha {
  readonly kind: 'change' | 'skip';
  readonly path: string;
  readonly field: string;
}

function ctx(over: {
  docs: Docs;
  leituras?: Leitura[];
  linhas?: Linha[];
  apply?: boolean;
  reportOnly?: boolean;
  falhaNaRazao?: unknown;
}): MigrationContext {
  const linhas = over.linhas ?? [];
  return {
    db: fakeDb(over.docs, over.leituras ?? [], over.falhaNaRazao),
    apply: over.apply ?? false,
    reportOnly: over.reportOnly ?? false,
    sink: {
      changes: 0,
      skips: 0,
      change: (path: string, field: string) => linhas.push({ kind: 'change', path, field }),
      skip: (path: string, field: string) => linhas.push({ kind: 'skip', path, field }),
    } as unknown as MigrationContext['sink'],
    writer: writerProibido,
    args: {
      projectId: 'p',
      apply: over.apply ?? false,
      reportOnly: over.reportOnly ?? false,
      targets: [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Corpus                                     */
/* -------------------------------------------------------------------------- */

/** 2026-11-17 12:00 in São Paulo. */
const AGORA = Date.UTC(2026, 10, 17, 15, 0, 0);
const INICIO_3_DIAS = Date.UTC(2026, 10, 15, 3, 0, 0);
const meioDia = (dia: number): number => Date.UTC(2026, 10, dia, 15, 0, 0);

const corpus = (): Docs => ({
  'integracao/LI-1': {
    tipo: 3,
    depositoOuterRef: 'documents/depositos/D1',
    operacaoOuterRef: 'documents/operacao/O1',
    operacaoDevolucaoOuterRef: 'operacao/O2',
    ativo: true,
    nome: 'not read',
  },
  'integracao/ML-1': { tipo: 1, depositoOuterRef: 'depositos/D1' },
  'operacao/O1': { movimentaIndisponivelEstoque: true, movimentaEstoque: true, nome: 'x' },
  'produtos/PA/produtolojaintegrada/a': {
    contaLojaIntegrada: 'documents/integracao/LI-1',
    id: 918273601,
    paiProdutoIntegradaId: 900,
    nome: 'not read',
  },
  'produtos/PB/produtolojaintegrada/a': {
    contaLojaIntegrada: 'integracao/LI-1',
    id: 918273602,
    paiProdutoIntegradaId: 900,
  },
  'produtos/PC/produtolojaintegrada/a': {
    contaLojaIntegrada: 'integracao/LI-1',
    id: 918273603,
    paiProdutoIntegradaId: 900,
  },
  'produtos/PA': { ultimaModificacao: meioDia(16), sku: 'not read' },
  'produtos/PB': { ultimaModificacao: meioDia(1) },
  'produtos/PC': { ultimaModificacao: 'texto' },
  'produtos/PA/estoques/est-PA-D1': {
    depositoOuterRef: 'documents/depositos/D1',
    parentId: 'PA',
    ultimaModificacao: meioDia(16),
    quantidade: 3,
  },
  'produtos/PB/estoques/est-PB-D1': {
    depositoOuterRef: 'depositos/D1',
    parentId: 'PB',
    ultimaModificacao: meioDia(1),
  },
  'produtos/PC/estoques/X': {
    depositoOuterRef: '/documents/depositos/D1',
    ultimaModificacao: meioDia(17),
  },
  'produtos/PZ/estoques/est-PZ-D2': {
    depositoOuterRef: 'documents/depositos/D2',
    ultimaModificacao: meioDia(17),
  },
  'produtos/PA/estoques/est-PA-D1/historicoEstoque/h1': { timestamp: meioDia(16) },
  'produtos/PA/estoques/est-PA-D1/historicoEstoque/h0': { timestamp: meioDia(1) },
});

let saida: string[] = [];
let resumos: Resumo[] = [];

const contagem = (paginas?: { chave?: number; janela?: number }) =>
  criarContagem({
    dias: 3,
    agoraMs: () => AGORA,
    gravarResumo: (r) => {
      resumos.push(r);
      return 'out/fake-resumo.json';
    },
    paginas,
  });

beforeEach(() => {
  saida = [];
  resumos = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    saida.push(args.map(String).join(' '));
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Flags                                      */
/* -------------------------------------------------------------------------- */

describe('parseArgsDaContagem — the flags, before anything exists', () => {
  it('⚠️ REJECTS --apply in any position and spelling, even before --project is checked', () => {
    expect(() => parseArgsDaContagem(['--apply'])).toThrow(MigrationArgError);
    expect(() => parseArgsDaContagem(['--project', 'x', '--apply'])).toThrow(/read-only COUNT/);
    expect(() => parseArgsDaContagem(['--apply=true', '--project', 'x'])).toThrow(
      MigrationArgError,
    );
  });

  it('rejects --target, requires --project, refuses an unknown flag', () => {
    expect(() => parseArgsDaContagem(['--project', 'x', '--target', 'a'])).toThrow(/--target/);
    expect(() => parseArgsDaContagem(['--project=x', '--target='])).toThrow(/--target/);
    expect(() => parseArgsDaContagem(['--dias', '7'])).toThrow(/--project <id> is required/);
    expect(() => parseArgsDaContagem(['--project', 'x', '--force'])).toThrow(/Unknown argument/);
  });

  it('--dias defaults to 14, takes both spellings, and leaves the runner the rest', () => {
    expect(parseArgsDaContagem(['--project', 'x'])).toMatchObject({
      dias: 14,
      resto: ['--project', 'x'],
    });
    const r = parseArgsDaContagem(['--project', 'x', '--dias', '7', '--report-only']);
    expect(r.dias).toBe(7);
    expect(r.resto).toEqual(['--project', 'x', '--report-only']);
    expect(r.args.reportOnly).toBe(true);
    expect(parseArgsDaContagem(['--dias=60', '--project=x']).dias).toBe(60);
  });

  it('⚠️ NEAR-MISS: --dias 0, 61, 07, 1.5, text, or no value is refused', () => {
    for (const v of ['0', '61', '07', '1.5', 'x', '']) {
      expect(() => parseArgsDaContagem(['--project', 'x', `--dias=${v}`]), v).toThrow(
        MigrationArgError,
      );
    }
    expect(() => parseArgsDaContagem(['--project', 'x', '--dias'])).toThrow(/requires a value/);
    expect(() => parseArgsDaContagem(['--dias', '--project', 'x'])).toThrow(/requires a value/);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The walk                                    */
/* -------------------------------------------------------------------------- */

describe('the walk — read-only, and the shape of every read', () => {
  it('refuses an --apply context too, before a single read', async () => {
    const leituras: Leitura[] = [];
    await expect(contagem()(ctx({ docs: corpus(), apply: true, leituras }))).rejects.toThrow(
      MigrationArgError,
    );
    expect(leituras).toEqual([]);
  });

  it('reads the contas masked and where-less, then their operações in one masked getAll', async () => {
    const leituras: Leitura[] = [];
    await contagem()(ctx({ docs: corpus(), leituras }));
    const [contas, operacoes] = leituras;
    expect(contas).toMatchObject({
      tipo: 'colecao',
      alvo: 'integracao',
      select: [...CAMPOS_DA_CONTA],
      where: [],
    });
    expect(operacoes).toMatchObject({
      tipo: 'getAll',
      alvo: 'operacao/O1,operacao/O2',
      fieldMask: [...CAMPOS_DA_OPERACAO],
    });
  });

  it('walks both collection groups by document key with no filter, paging with startAfter', async () => {
    const leituras: Leitura[] = [];
    await contagem({ chave: 2 })(ctx({ docs: corpus(), leituras }));
    for (const [grupo, campos, paginas] of [
      ['produtolojaintegrada', CAMPOS_DO_VINCULO, 2],
      ['estoques', CAMPOS_DO_ESTOQUE, 3],
    ] as const) {
      const walk = leituras.filter((l) => l.tipo === 'grupo' && l.alvo === grupo);
      expect(walk, grupo).toHaveLength(paginas);
      for (const l of walk) {
        expect(l.where).toEqual([]);
        expect(l.orderBy).toEqual([['__name__', 'asc']]);
        expect(l.limit).toBe(2);
        expect(l.select).toEqual([...campos]);
      }
      expect(walk[0]!.startAfter).toBeNull();
      expect(walk.slice(1).every((l) => l.startAfter !== null)).toBe(true);
    }
  });

  it('point-reads the linked produtos masked; the window is ONE field, a range and its order', async () => {
    const leituras: Leitura[] = [];
    await contagem()(ctx({ docs: corpus(), leituras }));
    const produtos = leituras.filter((l) => l.tipo === 'getAll' && l.alvo.startsWith('produtos/'));
    expect(produtos).toEqual([
      expect.objectContaining({
        alvo: 'produtos/PA,produtos/PB,produtos/PC',
        fieldMask: [...CAMPOS_DO_PRODUTO],
      }),
    ]);
    const janela = leituras.filter((l) => l.tipo === 'colecao' && l.alvo === 'produtos');
    expect(janela).toHaveLength(1);
    expect(janela[0]).toMatchObject({
      where: [['ultimaModificacao', '>=', INICIO_3_DIAS]],
      orderBy: [['ultimaModificacao', 'desc']],
      select: ['ultimaModificacao'],
      limit: 500,
    });
  });

  it('reads the ledger ONLY of records at the Loja Integrada depósito, in an exact form, touched in the window or unstamped', async () => {
    const leituras: Leitura[] = [];
    const docs = {
      ...corpus(),
      'produtos/PU/estoques/est-PU-D1': {
        depositoOuterRef: 'documents/depositos/D1',
        ultimaModificacao: 'texto',
      },
    };
    await contagem()(ctx({ docs, leituras }));
    const razao = leituras.filter((l) => l.alvo.endsWith('/historicoEstoque'));
    // PA's record is in the window and PU's has no numeric stamp; PB's is older; PC's ref is a
    // fold (not exact); PZ's is at another depósito.
    expect(razao.map((l) => l.alvo)).toEqual([
      'produtos/PA/estoques/est-PA-D1/historicoEstoque',
      'produtos/PU/estoques/est-PU-D1/historicoEstoque',
    ]);
    expect(razao[0]).toMatchObject({
      tipo: 'colecao',
      where: [['timestamp', '>=', INICIO_3_DIAS]],
      orderBy: [['timestamp', 'desc']],
      select: ['timestamp'],
    });
  });

  it('writes the summary, prints it as the RESUMO line, and logs rows through the sink only', async () => {
    const linhas: Linha[] = [];
    const resultado = await contagem()(ctx({ docs: corpus(), linhas }));
    expect(resultado.docsChanged).toBe(0);
    expect(resumos).toHaveLength(1);
    const resumo = resumos[0]!;
    expect(resumo.contagem).toBe(NOME_DA_CONTAGEM);
    expect(saida.at(-1)).toBe(`RESUMO ${JSON.stringify(resumo)}`);
    expect(saida[0]).toContain('database=fake-db');
    expect(saida.join('\n')).toContain('somente leitura');
    const escritas = (resumo.escritasPorDia as { depositos: Record<string, unknown> }).depositos;
    expect(escritas['dep-1']).toMatchObject({
      dias: {
        '2026-11-16': {
          registros: { vinculado: 1, componente: 0, outro: 0, total: 1 },
          linhasDaRazao: 1,
        },
      },
      registrosDobradosNaJanela: 1,
    });
    expect(linhas).toContainEqual({
      kind: 'change',
      path: 'integracao/LI-1',
      field: 'pseudonimo-conta',
    });
    expect(linhas).toContainEqual({
      kind: 'skip',
      path: 'produtos/PC/estoques/X',
      field: 'depositoOuterRef',
    });
  });

  it('--report-only writes the summary and no JSONL row', async () => {
    const linhas: Linha[] = [];
    await contagem()(ctx({ docs: corpus(), linhas, reportOnly: true }));
    expect(linhas).toEqual([]);
    expect(resumos).toHaveLength(1);
  });

  it('pages the window and the ledger queries too, to the same answer as one page', async () => {
    const docs = {
      ...corpus(),
      'produtos/PD': { ultimaModificacao: meioDia(17) },
      'produtos/PE': { ultimaModificacao: meioDia(15) },
      'produtos/PA/estoques/est-PA-D1/historicoEstoque/h2': { timestamp: meioDia(17) },
      'produtos/PA/estoques/est-PA-D1/historicoEstoque/h3': { timestamp: meioDia(15) },
    };
    const leituras: Leitura[] = [];
    await contagem({ janela: 2 })(ctx({ docs, leituras }));
    await contagem()(ctx({ docs }));
    const [paginado, inteiro] = resumos;

    for (const alvo of ['produtos', 'produtos/PA/estoques/est-PA-D1/historicoEstoque']) {
      const paginas = leituras.filter((l) => l.tipo === 'colecao' && l.alvo === alvo);
      // Three matches at two a page: a full page, then a short one that ends the walk.
      expect(paginas, alvo).toHaveLength(2);
      expect(paginas.every((l) => l.limit === 2)).toBe(true);
      expect(paginas[0]!.startAfter).toBeNull();
      expect(paginas[1]!.startAfter).not.toBeNull();
    }
    expect((paginado!.produtosTocados as { total: number }).total).toBe(3);
    expect(paginado!.produtosTocados).toEqual(inteiro!.produtosTocados);
    expect(paginado!.escritasPorDia).toEqual(inteiro!.escritasPorDia);
    const dias = (
      paginado!.escritasPorDia as {
        depositos: Record<string, { dias: Record<string, { linhasDaRazao: number }> }>;
      }
    ).depositos['dep-1']!.dias;
    expect(Object.values(dias).reduce((n, d) => n + d.linhasDaRazao, 0)).toBe(3);
  });

  it('tallies every read it is billed for: an empty last page, and a getAll ref with no document', async () => {
    const docs = {
      ...corpus(),
      // A link to a produto that does not exist: its point read is billed all the same.
      'produtos/PX/produtolojaintegrada/a': {
        contaLojaIntegrada: 'integracao/LI-1',
        id: 918273604,
        paiProdutoIntegradaId: 900,
      },
    };
    const resultado = await contagem({ chave: 2 })(ctx({ docs }));
    const leituras = resumos[0]!.leituras as {
      porPerna: Record<string, unknown>;
      estimativaDeLeiturasCobradas: number;
    };
    expect(leituras.porPerna).toEqual({
      contas: { documentos: 2, consultas: 1, consultasVazias: 0 },
      // operacao/O2 does not exist and is still one billed read.
      operacoes: { documentos: 2, consultas: 1, consultasVazias: 0 },
      // Four links at two a page: 2, 2, then an empty page that is billed one read.
      vinculos: { documentos: 4, consultas: 3, consultasVazias: 1 },
      produtos: { documentos: 4, consultas: 1, consultasVazias: 0 },
      estoques: { documentos: 4, consultas: 3, consultasVazias: 1 },
      produtosTocados: { documentos: 1, consultas: 1, consultasVazias: 0 },
      razao: { documentos: 1, consultas: 1, consultasVazias: 0 },
    });
    expect(leituras.estimativaDeLeiturasCobradas).toBe(18 + 2);
    expect(resultado.docsScanned).toBe(18);
  });
});

describe('the ledger leg — a missing index is reported, anything else is not swallowed', () => {
  it('FAILED_PRECONDITION (9) marks the ledger unavailable and the run still completes', async () => {
    const semIndice = Object.assign(new Error('needs an index'), { code: 9 });
    await contagem()(ctx({ docs: corpus(), falhaNaRazao: semIndice }));
    expect((resumos[0]!.escritasPorDia as { razaoDisponivel: boolean }).razaoDisponivel).toBe(
      false,
    );
    expect(saida.join('\n')).toContain('AVISO');
  });

  it('after the first refusal no further ledger query is sent: only the ones already in flight', async () => {
    const leituras: Leitura[] = [];
    const docs: Docs = { ...corpus() };
    // Ten records to read, more than the pool runs at once.
    for (let i = 1; i <= CONCORRENCIA + 1; i += 1) {
      docs[`produtos/REG-${String(i)}/estoques/est-REG-${String(i)}-D1`] = {
        depositoOuterRef: 'depositos/D1',
        ultimaModificacao: meioDia(17),
      };
    }
    const semIndice = Object.assign(new Error('needs an index'), { code: 9 });
    await contagem()(ctx({ docs, leituras, falhaNaRazao: semIndice }));
    const razao = leituras.filter((l) => l.alvo.endsWith('/historicoEstoque'));
    expect(razao).toHaveLength(CONCORRENCIA);
    expect((resumos[0]!.escritasPorDia as { razaoDisponivel: boolean }).razaoDisponivel).toBe(
      false,
    );
  });

  it('⚠️ NEAR-MISS: any other failure (code 14) is rethrown, and no summary is written', async () => {
    const indisponivel = Object.assign(new Error('unavailable'), { code: 14 });
    await expect(contagem()(ctx({ docs: corpus(), falhaNaRazao: indisponivel }))).rejects.toBe(
      indisponivel,
    );
    expect(resumos).toEqual([]);
  });
});

describe('the refusals — zeros are never a measurement', () => {
  it('no Loja Integrada conta: refused after the contas read, nothing else read', async () => {
    const leituras: Leitura[] = [];
    const docs = corpus();
    docs['integracao/LI-1'] = { ...docs['integracao/LI-1'], tipo: '3' };
    const erro = await contagem()(ctx({ docs, leituras })).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ContagemNaoAvaliada);
    expect((erro as ContagemNaoAvaliada).motivo).toBe('sem-contas-li');
    expect(leituras.map((l) => l.alvo)).toEqual(['integracao']);
    expect(saida.join('\n')).toContain('NAO-AVALIADO sem-contas-li');
    expect(resumos).toEqual([]);
  });

  it('no counting link: refused after the link walk, before any produto or stock read', async () => {
    const leituras: Leitura[] = [];
    const docs = Object.fromEntries(
      Object.entries(corpus()).map(([c, d]) =>
        c.includes('/produtolojaintegrada/') ? [c, { ...d, removido: true }] : [c, d],
      ),
    );
    const erro = await contagem()(ctx({ docs, leituras })).catch((e: unknown) => e);
    expect((erro as ContagemNaoAvaliada).motivo).toBe('sem-vinculos-que-contam');
    expect(leituras.some((l) => l.alvo === 'estoques' || l.alvo.startsWith('produtos/'))).toBe(
      false,
    );
    expect(resumos).toEqual([]);
  });
});
