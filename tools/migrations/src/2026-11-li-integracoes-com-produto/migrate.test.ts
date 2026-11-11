import { FieldPath, FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import {
  adicionarContaSeViva,
  sobrevivemVinculosDoProdutoLi,
  type SentinelasDeArray,
} from '@delfrance/data/admin/produtos';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationContext } from '../runner';
import {
  CAMPOS_DO_PRODUTO,
  CAMPOS_DO_VINCULO_LI,
  CAMPOS_PRODSHOPEE,
  CAMPOS_PRODUTO_ML,
  CAMPOS_VARIACAO_ML,
  CensoNaoAvaliado,
  DEPENDENCIAS_DO_CENSO,
  NOME_DO_CENSO,
  SENTINELAS,
  criarCenso,
  type DependenciasDoCenso,
} from './migrate';
import { CLASSE, censar, produtosDosVinculosLi, type VinculoLido } from './transform';

/**
 * The census's I/O, driven against a hand-written fake Firestore.
 *
 * `transform.test.ts` covers the decisions. This covers what the pure module cannot see: the
 * exact shape of every read (the key walk on its declared index, the masked point reads, the
 * three UNFILTERED per-produto reads), that a dry run and `--report-only` write nothing and call
 * no core, that `--apply` calls the core's guarded add once per Loja Integrada gap and never for
 * another channel, the two refusals, and the agreement between the census's verdict and the REAL
 * shared survivor read the guarded add re-checks.
 *
 * The fake APPLIES every `select` / `fieldMask`, so a mask missing a field the readers need would
 * change a verdict here, and a field outside the masks (a name, a SKU) can never reach a row.
 *
 * Importing `migrate.ts` is safe under vitest: its entrypoint guard compares `import.meta.url` to
 * `process.argv[1]`, which is the vitest binary here, so `runMigration` does not fire.
 */

type Dados = Record<string, unknown>;

/** One `get()` the run sent, with everything it asked of the query. */
interface Leitura {
  readonly tipo: 'colecao' | 'grupo';
  readonly caminho: string;
  readonly select: readonly string[] | null;
  readonly orderBy: readonly unknown[];
  readonly limit: number | null;
  readonly startAfter: string | null;
  /** Every other narrowing method called (`where`, `offset`, `endAt`…). */
  readonly outros: readonly string[];
}

const OUTROS_ESTREITAMENTOS = [
  'where',
  'limitToLast',
  'offset',
  'startAt',
  'endAt',
  'endBefore',
] as const;

class MundoFake {
  /** Full document path → stored data. */
  readonly docs = new Map<string, Dados>();
  readonly leituras: Leitura[] = [];
  readonly getAlls: Array<{ caminhos: string[]; fieldMask: unknown }> = [];

  seed(caminho: string, dados: Dados): this {
    this.docs.set(caminho, dados);
    return this;
  }

  private snapshot(caminho: string, mascara: readonly string[] | null) {
    const bruto = this.docs.get(caminho) ?? {};
    const dados =
      mascara === null
        ? bruto
        : Object.fromEntries(Object.entries(bruto).filter(([k]) => mascara.includes(k)));
    return {
      id: caminho.split('/').at(-1)!,
      ref: { path: caminho },
      data: () => dados,
      get: (campo: string) => dados[campo],
    };
  }

  private consulta(
    tipo: Leitura['tipo'],
    caminho: string,
    estado: Omit<Leitura, 'tipo' | 'caminho'>,
  ) {
    const proximo = (mudanca: Partial<Omit<Leitura, 'tipo' | 'caminho'>>) =>
      this.consulta(tipo, caminho, { ...estado, ...mudanca });
    const outros = Object.fromEntries(
      OUTROS_ESTREITAMENTOS.map((nome) => [
        nome,
        () => proximo({ outros: [...estado.outros, nome] }),
      ]),
    );
    return {
      ...outros,
      path: caminho,
      select: (...campos: string[]) => proximo({ select: campos }),
      orderBy: (campo: unknown) => proximo({ orderBy: [...estado.orderBy, campo] }),
      limit: (n: number) => proximo({ limit: n }),
      startAfter: (cursor: { ref: { path: string } }) => proximo({ startAfter: cursor.ref.path }),
      get: async () => {
        this.leituras.push({ tipo, caminho, ...estado });
        let caminhos = [...this.docs.keys()]
          .filter((p) => {
            const segs = p.split('/');
            if (tipo === 'grupo') return segs.length % 2 === 0 && segs.at(-2) === caminho;
            return p.startsWith(`${caminho}/`) && !p.slice(caminho.length + 1).includes('/');
          })
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        if (estado.startAfter !== null) caminhos = caminhos.filter((p) => p > estado.startAfter!);
        if (estado.limit !== null) caminhos = caminhos.slice(0, estado.limit);
        const docs = caminhos.map((p) => this.snapshot(p, estado.select));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }

  private inicial = {
    select: null,
    orderBy: [],
    limit: null,
    startAfter: null,
    outros: [],
  } as const;

  collection(caminho: string) {
    return {
      ...this.consulta('colecao', caminho, this.inicial),
      doc: (id: string) => ({ id, path: `${caminho}/${id}` }),
    };
  }

  collectionGroup(id: string) {
    return this.consulta('grupo', id, this.inicial);
  }

  async getAll(...args: unknown[]) {
    const ultimo = args.at(-1) as { fieldMask?: unknown; path?: string } | undefined;
    const opcoes =
      ultimo && ultimo.path === undefined ? (args.pop() as { fieldMask?: unknown }) : {};
    const refs = args as Array<{ path: string }>;
    const mascara = (opcoes.fieldMask as string[] | undefined) ?? null;
    this.getAlls.push({ caminhos: refs.map((r) => r.path), fieldMask: opcoes.fieldMask });
    return refs.map((r) => ({
      ...this.snapshot(r.path, mascara),
      exists: this.docs.has(r.path),
      data: () => (this.docs.has(r.path) ? this.snapshot(r.path, mascara).data() : undefined),
    }));
  }

  /** A read-only `tx` for a survivor closure, which only reads through it. */
  tx(): Transaction {
    return { get: (alvo: { get: () => Promise<unknown> }) => alvo.get() } as unknown as Transaction;
  }

  get db(): Firestore {
    return this as unknown as Firestore;
  }
}

interface Linha {
  readonly kind: 'change' | 'skip';
  readonly path: string;
  readonly field: string;
  readonly a: unknown;
  readonly b: unknown;
}

/** A `writer` that fails the test on ANY access: the census never writes through it. */
const writerProibido = new Proxy(
  {},
  {
    get(_alvo, prop) {
      throw new Error(`o censo tocou o writer (${String(prop)})`);
    },
  },
) as MigrationContext['writer'];

function contexto(
  mundo: MundoFake,
  modo: { apply?: boolean; reportOnly?: boolean } = {},
): { ctx: MigrationContext; linhas: Linha[] } {
  const linhas: Linha[] = [];
  const apply = modo.apply ?? false;
  const reportOnly = modo.reportOnly ?? false;
  return {
    linhas,
    ctx: {
      db: mundo.db,
      apply,
      reportOnly,
      sink: {
        changes: 0,
        skips: 0,
        change: (path: string, field: string, from: unknown, to: unknown) =>
          linhas.push({ kind: 'change', path, field, a: from, b: to }),
        skip: (path: string, field: string, value: unknown, reason: string) =>
          linhas.push({ kind: 'skip', path, field, a: value, b: reason }),
      } as unknown as MigrationContext['sink'],
      writer: writerProibido,
      args: { projectId: 'p', apply, reportOnly, targets: [] },
    },
  };
}

/** The core, as a spy: answers `true` unless `falsos` names the pair. */
function nucleoEspiao(falsos: ReadonlyArray<readonly [string, string]> = []) {
  const chamadas: Array<{
    produtoId: string;
    contaId: string;
    sentinelas: unknown;
    sobrevivem: unknown;
  }> = [];
  const sobreviventes: Array<{ produtoId: string; contaId: string; closure: unknown }> = [];
  const deps: DependenciasDoCenso = {
    sentinelas: SENTINELAS,
    sobrevivemVinculosDoProdutoLi: (db, produtoId, contaId) => {
      const closure = sobrevivemVinculosDoProdutoLi(db, produtoId, contaId);
      sobreviventes.push({ produtoId, contaId, closure });
      return closure;
    },
    adicionarContaSeViva: async (_db, produtoId, contaId, sobrevivem, sentinelas) => {
      chamadas.push({ produtoId, contaId, sentinelas, sobrevivem });
      return !falsos.some(([p, c]) => p === produtoId && c === contaId);
    },
  };
  return { deps, chamadas, sobreviventes };
}

/* --------------------------------- the world ------------------------------ */

const ID_LI = 182904918;

/**
 * Two Loja Integrada contas (A, B), one Mercado Livre (M), one Shopee (S). Gaps: p1 lacks A
 * (field absent), p2 lacks B (null), p4's field is a map. p3 is healthy. Each link and produto
 * also carries a name and a SKU the masks must keep out of every row.
 */
function mundo(): MundoFake {
  const m = new MundoFake()
    .seed('integracao/A', { tipo: 3, nome: 'NOME-SECRETO' })
    .seed('integracao/B', { tipo: 3 })
    .seed('integracao/M', { tipo: 1 })
    .seed('integracao/S', { tipo: 5 });
  const link = (over: Dados = {}): Dados => ({
    contaLojaIntegrada: 'documents/integracao/A',
    id: ID_LI,
    removido: false,
    nome: 'NOME-SECRETO',
    sku: 'SKU-SECRETO',
    ...over,
  });
  const prod = (over: Dados = {}): Dados => ({
    nome: 'NOME-SECRETO',
    sku: 'SKU-SECRETO',
    paiId: null,
    ...over,
  });
  m.seed('produtos/p1', prod())
    .seed('produtos/p1/produtolojaintegrada/1', link({ id: 1 }))
    .seed('produtos/p1/produtoMercadoLivre/x', {
      contaOuterRef: 'documents/integracao/M',
      id: 'MLB1',
      estado: 'a',
      nome: 'NOME-SECRETO',
    })
    .seed('produtos/p1/prodshopee/y', {
      contaProdutoShopeeOuterRef: 'documents/integracao/S',
      item_id: 12,
    })
    .seed('produtos/p1/variashopee/z', { contaVariacaoShopeeOuterRef: 'documents/integracao/S' })
    .seed('produtos/p1/prodAmazon/w', { contaAmazonOuterRef: 'documents/integracao/Z' })
    .seed('produtos/p2', prod({ integracoesComProduto: null }))
    .seed('produtos/p2/produtolojaintegrada/2', link({ contaLojaIntegrada: 'integracao/B', id: 2 }))
    .seed('produtos/p3', prod({ integracoesComProduto: ['A'] }))
    .seed('produtos/p3/produtolojaintegrada/3', link({ id: 3 }))
    .seed('produtos/p4', prod({ integracoesComProduto: { A: true } }))
    .seed('produtos/p4/produtolojaintegrada/4', link({ id: 4 }))
    // A trashed link, a non-canonical id and another collection's ref: none counts for an add.
    .seed('produtos/p5', prod({ integracoesComProduto: [] }))
    .seed('produtos/p5/produtolojaintegrada/5', link({ id: 5, removido: true }))
    .seed('produtos/p5/produtolojaintegrada/6', link({ id: '07' }))
    .seed(
      'produtos/p5/produtolojaintegrada/7',
      link({ id: 7, contaLojaIntegrada: 'documents/categorias/A' }),
    )
    // An orphan link: its produto is gone.
    .seed('produtos/sumiu/produtolojaintegrada/8', link({ id: 8 }));
  return m;
}

let saida: string[] = [];
beforeEach(() => {
  saida = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    saida.push(args.map(String).join(' '));
  });
});

/* -------------------------------------------------------------------------- */

describe('the reads', () => {
  it('the contas: integracao masked to tipo, no filter, no order', async () => {
    const m = mundo();
    await criarCenso(nucleoEspiao().deps)(contexto(m).ctx);
    const contas = m.leituras.filter((l) => l.caminho === 'integracao');
    expect(contas).toEqual([
      {
        tipo: 'colecao',
        caminho: 'integracao',
        select: ['tipo'],
        orderBy: [],
        limit: null,
        startAfter: null,
        outros: [],
      },
    ]);
  });

  it('the walk: collectionGroup produtolojaintegrada, masked, by document key, limit 300, startAfter the last doc', async () => {
    const m = new MundoFake().seed('integracao/A', { tipo: 3 });
    for (let i = 0; i < 301; i += 1) {
      const id = `p${String(i).padStart(3, '0')}`;
      m.seed(`produtos/${id}`, { integracoesComProduto: ['A'] });
      m.seed(`produtos/${id}/produtolojaintegrada/l`, {
        contaLojaIntegrada: 'documents/integracao/A',
        id: i + 1,
      });
    }
    await criarCenso(nucleoEspiao().deps)(contexto(m).ctx);

    const paginas = m.leituras.filter((l) => l.tipo === 'grupo');
    expect(paginas).toHaveLength(2);
    for (const p of paginas) {
      expect(p).toMatchObject({
        caminho: 'produtolojaintegrada',
        select: [...CAMPOS_DO_VINCULO_LI],
        limit: 300,
        outros: [],
      });
      expect(p.orderBy).toEqual([FieldPath.documentId()]);
    }
    expect(paginas[0]!.startAfter).toBeNull();
    expect(paginas[1]!.startAfter).toBe('produtos/p299/produtolojaintegrada/l');
    expect(saida.join('\n')).toContain('vinculos-que-contam=301');
    expect(saida.join('\n')).toContain('=> PASSA');
  });

  it('the produtos: getAll masked to integracoesComProduto + paiId, in chunks of at most 200', async () => {
    const m = new MundoFake().seed('integracao/A', { tipo: 3 });
    for (let i = 0; i < 250; i += 1) {
      m.seed(`produtos/q${i}`, { integracoesComProduto: ['A'] });
      m.seed(`produtos/q${i}/produtolojaintegrada/l`, {
        contaLojaIntegrada: 'documents/integracao/A',
        id: i + 1,
      });
    }
    await criarCenso(nucleoEspiao().deps)(contexto(m).ctx);
    expect(m.getAlls.map((g) => g.caminhos.length)).toEqual([200, 50]);
    for (const g of m.getAlls) expect(g.fieldMask).toEqual([...CAMPOS_DO_PRODUTO]);
    expect(new Set(m.getAlls.flatMap((g) => g.caminhos)).size).toBe(250);
  });

  it('the other channels: three UNFILTERED, unordered reads per existing produto, masked; never variashopee or prodAmazon', async () => {
    const m = mundo();
    await criarCenso(nucleoEspiao().deps)(contexto(m).ctx);
    const porProduto = m.leituras.filter(
      (l) => l.tipo === 'colecao' && l.caminho.startsWith('produtos/'),
    );
    const esperadas = ['p1', 'p2', 'p3', 'p4', 'p5'].flatMap((p) => [
      `produtos/${p}/prodshopee`,
      `produtos/${p}/produtoMercadoLivre`,
      `produtos/${p}/variacaoMercadoLivre`,
    ]);
    expect(porProduto.map((l) => l.caminho).sort()).toEqual(esperadas.sort());
    for (const l of porProduto) {
      expect(l).toMatchObject({ orderBy: [], limit: null, startAfter: null, outros: [] });
      const folha = l.caminho.split('/').at(-1);
      expect(l.select).toEqual(
        folha === 'produtoMercadoLivre'
          ? [...CAMPOS_PRODUTO_ML]
          : folha === 'variacaoMercadoLivre'
            ? [...CAMPOS_VARIACAO_ML]
            : [...CAMPOS_PRODSHOPEE],
      );
    }
    const todas = m.leituras.map((l) => l.caminho);
    expect(todas.some((c) => c.includes('variashopee') || c.includes('prodAmazon'))).toBe(false);
    // The orphan's produto is gone: no other-channel read for it.
    expect(todas.some((c) => c.startsWith('produtos/sumiu/'))).toBe(false);
  });
});

describe('dry run and --report-only', () => {
  it('the dry run writes one sorted row per finding, li-ausente as a change, and calls no core', async () => {
    const m = mundo();
    const { deps, chamadas } = nucleoEspiao();
    const { ctx, linhas } = contexto(m);
    const resumo = await criarCenso(deps)(ctx);

    expect(chamadas).toEqual([]);
    expect(linhas.filter((l) => l.kind === 'change')).toEqual([
      { kind: 'change', path: 'produtos/p1', field: 'integracoesComProduto', a: null, b: 'A' },
      { kind: 'change', path: 'produtos/p2', field: 'integracoesComProduto', a: null, b: 'B' },
    ]);
    expect(linhas.filter((l) => l.kind === 'skip').map((l) => [l.path, l.b])).toEqual([
      ['produtos/p1', CLASSE.mlAusente],
      ['produtos/p1', CLASSE.shopeeAusente],
      ['produtos/p4', CLASSE.liCampoInvalido],
      ['produtos/p5/produtolojaintegrada/7', CLASSE.liContaIlegivel],
      ['produtos/sumiu/produtolojaintegrada/8', CLASSE.liProdutoAusente],
    ]);
    expect(resumo.docsChanged).toBe(2);
    const texto = saida.join('\n');
    expect(texto).toContain(
      'GATE li: ausente=2 campo-invalido=1 contas-li=2 vinculos-que-contam=4 produtos=5 => BLOQUEIA',
    );
    expect(texto).toContain('DRY-RUN: nada foi escrito');
  });

  it('two dry runs over the same data write identical rows', async () => {
    const a = contexto(mundo());
    const b = contexto(mundo());
    await criarCenso(nucleoEspiao().deps)(a.ctx);
    await criarCenso(nucleoEspiao().deps)(b.ctx);
    expect(b.linhas).toEqual(a.linhas);
  });

  it('--report-only writes no row and calls no core, and still prints the gate', async () => {
    const { deps, chamadas } = nucleoEspiao();
    const { ctx, linhas } = contexto(mundo(), { reportOnly: true });
    await criarCenso(deps)(ctx);
    expect(linhas).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(saida.join('\n')).toContain('GATE li: ausente=2 campo-invalido=1');
  });

  it('log hygiene: contas by id only; no name or SKU reaches a row or a log line', async () => {
    const { ctx, linhas } = contexto(mundo(), { apply: true });
    await criarCenso(nucleoEspiao().deps)(ctx);
    const tudo = JSON.stringify(linhas) + saida.join('\n');
    expect(tudo).not.toContain('NOME-SECRETO');
    expect(tudo).not.toContain('SKU-SECRETO');
    expect(saida.join('\n')).toContain('li conta=A vinculos-que-contam=3');
    expect(saida.join('\n')).toContain('li conta=B vinculos-que-contam=1');
  });
});

describe('--apply', () => {
  it('calls the core once per li-ausente pair, bound to the shared survivor read, and never for another channel', async () => {
    const m = mundo();
    const { deps, chamadas, sobreviventes } = nucleoEspiao();
    const { ctx, linhas } = contexto(m, { apply: true });
    const resumo = await criarCenso(deps)(ctx);

    expect(chamadas.map((c) => [c.produtoId, c.contaId]).sort()).toEqual([
      ['p1', 'A'],
      ['p2', 'B'],
    ]);
    // Each call carries the closure the shared survivor read built for that very pair.
    for (const c of chamadas) {
      const s = sobreviventes.find((x) => x.produtoId === c.produtoId && x.contaId === c.contaId);
      expect(c.sobrevivem).toBe(s?.closure);
      expect(c.sentinelas).toBe(SENTINELAS);
    }
    expect(
      linhas
        .filter((l) => l.field === 'aplicado')
        .map((l) => [l.path, l.b])
        .sort(),
    ).toEqual([
      ['produtos/p1', 'A'],
      ['produtos/p2', 'B'],
    ]);
    expect(resumo.docsChanged).toBe(2);
    const texto = saida.join('\n');
    expect(texto).toContain('adicionados=2 divergentes=0');
    expect(texto).toContain('o "0 writes" abaixo é esperado');
  });

  it('a core false is a divergente row, never a change', async () => {
    const { deps } = nucleoEspiao([['p2', 'B']]);
    const { ctx, linhas } = contexto(mundo(), { apply: true });
    const resumo = await criarCenso(deps)(ctx);
    expect(linhas.filter((l) => l.b === 'divergente')).toEqual([
      {
        kind: 'skip',
        path: 'produtos/p2',
        field: 'integracoesComProduto',
        a: 'B',
        b: 'divergente',
      },
    ]);
    expect(linhas.filter((l) => l.field === 'aplicado').map((l) => l.path)).toEqual([
      'produtos/p1',
    ]);
    expect(resumo.docsChanged).toBe(1);
    expect(saida.join('\n')).toContain('adicionados=1 divergentes=1');
  });

  it('anything the core throws aborts the run as is', async () => {
    const erro = new Error('UNAVAILABLE');
    const deps: DependenciasDoCenso = {
      ...nucleoEspiao().deps,
      adicionarContaSeViva: async () => {
        throw erro;
      },
    };
    await expect(criarCenso(deps)(contexto(mundo(), { apply: true }).ctx)).rejects.toBe(erro);
  });

  it("one produto's contas run in sequence, never at once", async () => {
    const m = new MundoFake()
      .seed('integracao/A', { tipo: 3 })
      .seed('integracao/B', { tipo: 3 })
      .seed('produtos/p', {})
      .seed('produtos/p/produtolojaintegrada/1', { contaLojaIntegrada: 'integracao/A', id: 1 })
      .seed('produtos/p/produtolojaintegrada/2', { contaLojaIntegrada: 'integracao/B', id: 2 });
    let emVoo = 0;
    let maximo = 0;
    const deps: DependenciasDoCenso = {
      ...nucleoEspiao().deps,
      adicionarContaSeViva: async () => {
        emVoo += 1;
        maximo = Math.max(maximo, emVoo);
        await new Promise((r) => setTimeout(r, 1));
        emVoo -= 1;
        return true;
      },
    };
    await criarCenso(deps)(contexto(m, { apply: true }).ctx);
    expect(maximo).toBe(1);
  });
});

describe('the refusals (exit 1, before any write, in every mode)', () => {
  it.each([[{}], [{ apply: true }], [{ reportOnly: true }]])(
    'no Loja Integrada conta ⇒ NAO-AVALIADO sem-contas-li before the walk (%j)',
    async (modo) => {
      const m = mundo();
      m.docs.set('integracao/A', { tipo: 1 });
      m.docs.set('integracao/B', { tipo: '3' });
      const { deps, chamadas } = nucleoEspiao();
      const { ctx, linhas } = contexto(m, modo);
      const promessa = criarCenso(deps)(ctx);
      await expect(promessa).rejects.toBeInstanceOf(CensoNaoAvaliado);
      await expect(promessa).rejects.toMatchObject({ motivo: 'sem-contas-li' });
      expect(m.leituras.some((l) => l.tipo === 'grupo')).toBe(false);
      expect(linhas).toEqual([]);
      expect(chamadas).toEqual([]);
      expect(saida).toContain('GATE li: NAO-AVALIADO sem-contas-li contas-li=0');
      expect(saida.join('\n')).not.toContain('ausente=0');
    },
  );

  it.each([[{}], [{ apply: true }], [{ reportOnly: true }]])(
    'Loja Integrada contas but no counting link ⇒ NAO-AVALIADO sem-vinculos-que-contam (%j)',
    async (modo) => {
      const m = new MundoFake()
        .seed('integracao/A', { tipo: 3 })
        .seed('produtos/p', {})
        .seed('produtos/p/produtolojaintegrada/1', {
          contaLojaIntegrada: 'documents/integracao/A',
          id: 1,
          removido: true,
        });
      const { deps, chamadas } = nucleoEspiao();
      const { ctx, linhas } = contexto(m, modo);
      await expect(criarCenso(deps)(ctx)).rejects.toMatchObject({
        motivo: 'sem-vinculos-que-contam',
      });
      expect(linhas).toEqual([]);
      expect(chamadas).toEqual([]);
      expect(saida).toContain(
        'GATE li: NAO-AVALIADO sem-vinculos-que-contam contas-li=1 vinculos-que-contam=0',
      );
    },
  );
});

describe('the census and the REAL shared survivor read agree', () => {
  /** The world's links, read back as the walk would (masked), and the census over them. */
  async function censoDoMundo(m: MundoFake) {
    const vinculosLi: VinculoLido[] = (
      await m
        .collectionGroup('produtolojaintegrada')
        .select(...CAMPOS_DO_VINCULO_LI)
        .get()
    ).docs.map((d) => ({ caminho: d.ref.path, dados: d.data() }));
    const produtos = new Map(
      produtosDosVinculosLi(vinculosLi).map((id) => {
        const dados = m.docs.get(`produtos/${id}`);
        return [
          id,
          {
            existe: dados !== undefined,
            integracoesComProduto: dados?.integracoesComProduto,
            paiId: dados?.paiId,
          },
        ] as const;
      }),
    );
    return censar({
      contas: [
        { id: 'A', tipo: 3 },
        { id: 'B', tipo: 3 },
      ],
      vinculosLi,
      produtos,
      outrosCanais: new Map(),
    });
  }

  const sobrevive = (m: MundoFake, produtoId: string, contaId: string) =>
    sobrevivemVinculosDoProdutoLi(m.db, produtoId, contaId)(m.tx());

  it('every li-ausente the census reports, the survivor confirms: every stored form', async () => {
    const m = new MundoFake()
      .seed('produtos/c1', {})
      .seed('produtos/c1/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/integracao/A',
        id: 1,
      })
      .seed('produtos/c2', {})
      .seed('produtos/c2/produtolojaintegrada/1', { contaLojaIntegrada: 'integracao/A', id: 2 })
      .seed('produtos/c3', {})
      .seed('produtos/c3/produtolojaintegrada/1', {
        contaLojaIntegrada: '/documents/integracao/A',
        id: 3,
      })
      .seed('produtos/c4', {})
      .seed('produtos/c4/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/integracao/A',
        id: String(ID_LI),
      })
      .seed('produtos/c5', { integracoesComProduto: ['integracao/B'] })
      .seed('produtos/c5/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/integracao/B',
        id: 5,
        ativo: false,
        bloqueado: true,
      });
    const r = await censoDoMundo(m);
    expect(r.plano).toHaveLength(5);
    for (const { produtoId, contaId } of r.plano) {
      expect(await sobrevive(m, produtoId, contaId), `${produtoId}/${contaId}`).toBe(true);
    }
  });

  it('⚠️ NEAR-MISS: a link the census does not count, the survivor does not count either', async () => {
    const m = new MundoFake()
      .seed('produtos/n1', {})
      .seed('produtos/n1/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/integracao/A',
        id: 1,
        removido: true,
      })
      .seed('produtos/n2', {})
      .seed('produtos/n2/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/integracao/A',
        id: '07',
      })
      .seed('produtos/n3', {})
      .seed('produtos/n3/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/integracao/A',
        id: null,
      })
      .seed('produtos/n4', {})
      .seed('produtos/n4/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/categorias/A',
        id: 4,
      })
      .seed('produtos/n5', {})
      .seed('produtos/n5/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/integracao/B',
        id: 5,
      })
      // Keeps the census evaluated; not part of the near-miss set.
      .seed('produtos/ok', { integracoesComProduto: ['B'] })
      .seed('produtos/ok/produtolojaintegrada/1', {
        contaLojaIntegrada: 'documents/integracao/B',
        id: 9,
      });
    const r = await censoDoMundo(m);
    const planejados = new Set(r.plano.map((a) => `${a.produtoId}/${a.contaId}`));
    for (const produtoId of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      expect(planejados.has(`${produtoId}/A`), produtoId).toBe(false);
      expect(await sobrevive(m, produtoId, 'A'), produtoId).toBe(false);
    }
    // n5's link is B's: the census plans B there, and the survivor agrees.
    expect(planejados.has('n5/B')).toBe(true);
    expect(await sobrevive(m, 'n5', 'B')).toBe(true);
  });
});

describe('the bindings', () => {
  it('the default dependencies are the shared core and the shared survivor read', () => {
    expect(DEPENDENCIAS_DO_CENSO.adicionarContaSeViva).toBe(adicionarContaSeViva);
    expect(DEPENDENCIAS_DO_CENSO.sobrevivemVinculosDoProdutoLi).toBe(sobrevivemVinculosDoProdutoLi);
    expect(DEPENDENCIAS_DO_CENSO.sentinelas).toBe(SENTINELAS);
  });

  it('⚠️ the sentinels are not swapped: the add path unions, the remove path removes', () => {
    const s: SentinelasDeArray = SENTINELAS;
    expect((s.arrayUnion('C') as FieldValue).isEqual(FieldValue.arrayUnion('C'))).toBe(true);
    expect((s.arrayRemove('C') as FieldValue).isEqual(FieldValue.arrayRemove('C'))).toBe(true);
    expect((s.arrayUnion('C') as FieldValue).isEqual(FieldValue.arrayRemove('C'))).toBe(false);
  });

  it('logs under the census name', () => {
    expect(NOME_DO_CENSO).toBe('li-integracoes-com-produto');
  });
});
