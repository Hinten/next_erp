import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FieldPath,
  type DocumentSnapshot,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import {
  MigrationArgError,
  isMainModule,
  parseArgs,
  runMigration,
  type MigrationArgs,
  type MigrationContext,
  type MigrationSummary,
} from '../runner';
import {
  DIAS_MAX,
  DIAS_PADRAO,
  NOME_DA_CONTAGEM,
  contar,
  depositosDasContasLi,
  janelaDeDias,
  operacoesDasContasLi,
  produtosDosVinculos,
  recusaSemContasLi,
  recusaSemVinculos,
  registrosParaRazao,
  type ContaLida,
  type EstoqueLido,
  type LeituraDaPerna,
  type MotivoDeRecusa,
  type OperacaoLida,
  type Perna,
  type ProdutoLido,
  type ProdutoTocado,
  type Resumo,
  type VinculoLido,
} from './predicate';

/**
 * AUDIT (read-only): the step-12 stock plan's ERP counts for Loja Integrada, measured on the
 * LEGACY project before PR 12-f merges. The decisions are `predicate.ts`; this file is Firestore
 * I/O and nothing else. Runbook: `tools/migrations/li-estoque-contagens.README.md`.
 *
 *   FIREBASE_DATABASE_ID='(default)' pnpm --filter @delfrance/migrations audit:li-estoque-contagens --project <id> --dias 14
 *
 * ## No `--apply`, by construction
 *
 * `--apply` is REJECTED before any credential is read or any handle built, never ignored, so
 * nobody can believe it did something. There is no write path in this file: no writer, no `set`,
 * no `update`, no batch, no transaction.
 *
 * ## What it reads, in order (every query where-less or on an automatic single-field index)
 *
 * 1. `integracao`, masked: the contas, their depósito and operação refs. No Loja Integrada conta
 *    ⇒ a REFUSAL before anything else is read.
 * 2. The Loja Integrada contas' operações: one `getAll`, masked to the two stock flags.
 * 3. Every `produtolojaintegrada` doc by document KEY (collection group, `__name__` order), masked.
 *    No counting link of a Loja Integrada conta ⇒ a REFUSAL before the produtos are read.
 * 4. The produtos those links name: `getAll` in chunks of {@link GET_ALL_CHUNK}, masked.
 * 5. Every `estoques` doc by document KEY (collection group, `__name__` order), masked. A filter
 *    on the group (`ultimaModificacao`, `depositoOuterRef`, `parentId`) would need a
 *    collection-group single-field index Standard does not create; the walk answers the
 *    duplicate, parentId, no-record and per-day counts in one pass.
 * 6. `produtos` with `ultimaModificacao >= <window start>`, newest first, masked: Standard's
 *    automatic collection-scope single-field index.
 * 7. For each record at a Loja Integrada depósito touched in the window: its own
 *    `historicoEstoque` rows with `timestamp >= <window start>` (the automatic collection-scope
 *    index), {@link CONCORRENCIA} records at a time. If the project refuses that query for a
 *    missing index (gRPC 9), the ledger is reported unavailable and the walk-based bound stands.
 *
 * On Enterprise (a staging rehearsal) the two key walks ride the declared `__name__` collection
 * group indexes (`key-walks.json`) and reads 6 and 7 the declared single-field indexes.
 *
 * ## Output
 *
 * The runner's JSONL (`out/<stamp>-li-estoque-contagens-dryrun.jsonl`, local, gitignored) holds
 * every per-document finding and every skipped shape, with ids; `--report-only` writes none of
 * those rows. The summary (`out/<stamp>-li-estoque-contagens-resumo.json`, also printed as the
 * `RESUMO` line) holds counts and pseudonyms only: it is the one thing to paste back.
 *
 * ## ⛔ Agents never run this. The owner runs it on the legacy project — runbook.
 */

/** Documents per key-walk page. */
const PAGE_SIZE = 300;
/** Documents per window or ledger page. */
const PAGE_SIZE_JANELA = 500;
/** Documents per `getAll`: Firestore accepts more, this keeps a request small. */
const GET_ALL_CHUNK = 200;
/** Ledger reads in flight at once. */
export const CONCORRENCIA = 8;

/** The masked fields of each read. `predicate.ts` reads nothing else. */
export const CAMPOS_DA_CONTA = [
  'tipo',
  'depositoOuterRef',
  'operacaoOuterRef',
  'operacaoDevolucaoOuterRef',
  'ativo',
] as const;
export const CAMPOS_DA_OPERACAO = ['movimentaIndisponivelEstoque', 'movimentaEstoque'] as const;
export const CAMPOS_DO_VINCULO = [
  'contaLojaIntegrada',
  'id',
  'removido',
  'paiProdutoIntegradaId',
  'grades',
] as const;
export const CAMPOS_DO_PRODUTO = [
  'ehKit',
  'ehKitVirtual',
  'componentesKit',
  'paiId',
  'ultimaModificacao',
] as const;
export const CAMPOS_DO_ESTOQUE = ['depositoOuterRef', 'parentId', 'ultimaModificacao'] as const;

/* -------------------------------------------------------------------------- */
/*                                  The flags                                  */
/* -------------------------------------------------------------------------- */

export interface ArgsDaContagem {
  /** The shared contract's parse of what remains (`--project`, `--service-account`, …). */
  readonly args: MigrationArgs;
  readonly dias: number;
  /** The arguments handed on to the runner: everything but `--dias`. */
  readonly resto: readonly string[];
}

const DIAS_CANONICO = /^[1-9]\d*$/;

function lerDias(valor: string | undefined): number {
  if (valor === undefined || valor.startsWith('--')) {
    throw new MigrationArgError('--dias requires a value.');
  }
  const n = Number(valor);
  if (!DIAS_CANONICO.test(valor) || !Number.isSafeInteger(n) || n > DIAS_MAX) {
    throw new MigrationArgError(`--dias must be an integer from 1 to ${String(DIAS_MAX)}.`);
  }
  return n;
}

/**
 * Parse this audit's flags. Pure: it runs BEFORE any credential or handle exists.
 *
 *  - `--apply` (any spelling) is REJECTED — read-only, by construction;
 *  - `--target` is rejected: there is nothing to select;
 *  - `--dias N` / `--dias=N` (1..{@link DIAS_MAX}, default {@link DIAS_PADRAO}) is taken out;
 *  - everything else goes to the shared `parseArgs`: `--project` stays required, an unknown
 *    flag is refused, `--report-only` and `--service-account` keep their meaning.
 */
export function parseArgsDaContagem(argv: readonly string[]): ArgsDaContagem {
  const resto: string[] = [];
  let dias = DIAS_PADRAO;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply' || arg.startsWith('--apply=')) {
      throw new MigrationArgError(
        'This is a read-only COUNT, not a migration: it has no --apply path and writes nothing ' +
          '(runbook: li-estoque-contagens.README.md).',
      );
    }
    if (arg === '--target' || arg.startsWith('--target=')) {
      throw new MigrationArgError('--target is not supported by this count.');
    }
    if (arg === '--dias') {
      dias = lerDias(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--dias=')) {
      dias = lerDias(arg.slice('--dias='.length));
    } else {
      resto.push(arg);
    }
  }
  return { args: parseArgs(resto), dias, resto };
}

/* -------------------------------------------------------------------------- */
/*                                 The refusal                                 */
/* -------------------------------------------------------------------------- */

/** The counts could not judge the corpus: thrown after the refusal line is printed. */
export class ContagemNaoAvaliada extends Error {
  constructor(readonly motivo: MotivoDeRecusa) {
    super(
      `${NOME_DA_CONTAGEM}: NAO-AVALIADO ${motivo}. Nothing was counted. Check --project and ` +
        'FIREBASE_DATABASE_ID (the legacy project is "(default)") — on the wrong project or ' +
        'database every count reads zero (runbook: li-estoque-contagens.README.md).',
    );
    this.name = 'ContagemNaoAvaliada';
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Reads                                     */
/* -------------------------------------------------------------------------- */

function log(message: string): void {
  // eslint-disable-next-line no-console -- operator-facing run output
  console.log(message);
}

/** gRPC FAILED_PRECONDITION (code 9): a query the project has no index for. */
function semIndice(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 9;
}

/** The read tally, one entry per leg. */
function leiturasZeradas(): Record<
  Perna,
  { documentos: number; consultas: number; consultasVazias: number }
> {
  const zero = () => ({ documentos: 0, consultas: 0, consultasVazias: 0 });
  return {
    contas: zero(),
    operacoes: zero(),
    vinculos: zero(),
    produtos: zero(),
    estoques: zero(),
    produtosTocados: zero(),
    razao: zero(),
  };
}

type Tally = ReturnType<typeof leiturasZeradas>;

function contarConsulta(tally: Tally, perna: Perna, documentos: number): void {
  tally[perna].documentos += documentos;
  tally[perna].consultas += 1;
  if (documentos === 0) tally[perna].consultasVazias += 1;
}

/**
 * Run `fn` over `itens`, at most `limite` at a time. The first rejection rejects the whole call,
 * and no further item starts after it.
 */
async function emPiscina<T>(
  itens: readonly T[],
  limite: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let proximo = 0;
  let falhou = false;
  async function trabalhador(): Promise<void> {
    while (!falhou && proximo < itens.length) {
      const item = itens[proximo]!;
      proximo += 1;
      let concluiu = false;
      try {
        await fn(item);
        concluiu = true;
      } finally {
        // No handler: a rejection propagates as is, and stops the others taking new items.
        if (!concluiu) falhou = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, () => trabalhador()));
}

async function lerContas(ctx: MigrationContext, tally: Tally): Promise<ContaLida[]> {
  const snap = await ctx.db
    .collection('integracao')
    .select(...CAMPOS_DA_CONTA)
    .get();
  contarConsulta(tally, 'contas', snap.size);
  return snap.docs.map((d) => {
    const dados = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      tipo: dados.tipo,
      depositoOuterRef: dados.depositoOuterRef,
      operacaoOuterRef: dados.operacaoOuterRef,
      operacaoDevolucaoOuterRef: dados.operacaoDevolucaoOuterRef,
      ativo: dados.ativo,
    };
  });
}

async function lerOperacoes(
  ctx: MigrationContext,
  caminhos: readonly string[],
  tally: Tally,
): Promise<Map<string, OperacaoLida>> {
  const operacoes = new Map<string, OperacaoLida>();
  if (caminhos.length === 0) return operacoes;
  const snaps = await ctx.db.getAll(...caminhos.map((c) => ctx.db.doc(c)), {
    fieldMask: [...CAMPOS_DA_OPERACAO],
  });
  tally.operacoes.documentos += caminhos.length;
  tally.operacoes.consultas += 1;
  for (const snap of snaps) {
    operacoes.set(snap.ref.path, {
      existe: snap.exists,
      dados: (snap.data() ?? {}) as Record<string, unknown>,
    });
  }
  return operacoes;
}

/** Every `produtolojaintegrada` doc, page by page in document-key order. */
async function lerVinculos(
  ctx: MigrationContext,
  tally: Tally,
  pagina: number,
): Promise<VinculoLido[]> {
  const vinculos: VinculoLido[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = ctx.db
      .collectionGroup('produtolojaintegrada')
      .select(...CAMPOS_DO_VINCULO)
      .orderBy(FieldPath.documentId())
      .limit(pagina);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    contarConsulta(tally, 'vinculos', snap.size);
    for (const doc of snap.docs) {
      vinculos.push({ caminho: doc.ref.path, dados: doc.data() as Record<string, unknown> });
    }
    if (snap.size < pagina) return vinculos;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

function lerProduto(snap: DocumentSnapshot): ProdutoLido {
  return { existe: snap.exists, dados: (snap.data() ?? {}) as Record<string, unknown> };
}

async function lerProdutos(
  ctx: MigrationContext,
  ids: readonly string[],
  tally: Tally,
): Promise<Map<string, ProdutoLido>> {
  const produtos = new Map<string, ProdutoLido>();
  for (let i = 0; i < ids.length; i += GET_ALL_CHUNK) {
    const fatia = ids.slice(i, i + GET_ALL_CHUNK);
    const snaps = await ctx.db.getAll(...fatia.map((id) => ctx.db.collection('produtos').doc(id)), {
      fieldMask: [...CAMPOS_DO_PRODUTO],
    });
    tally.produtos.documentos += fatia.length;
    tally.produtos.consultas += 1;
    for (const snap of snaps) produtos.set(snap.id, lerProduto(snap));
  }
  return produtos;
}

/** Every `estoques` doc, page by page in document-key order. */
async function lerEstoques(
  ctx: MigrationContext,
  tally: Tally,
  pagina: number,
): Promise<EstoqueLido[]> {
  const estoques: EstoqueLido[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = ctx.db
      .collectionGroup('estoques')
      .select(...CAMPOS_DO_ESTOQUE)
      .orderBy(FieldPath.documentId())
      .limit(pagina);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    contarConsulta(tally, 'estoques', snap.size);
    for (const doc of snap.docs) {
      estoques.push({ caminho: doc.ref.path, dados: doc.data() as Record<string, unknown> });
    }
    if (snap.size < pagina) return estoques;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/** The produtos whose numeric `ultimaModificacao` is at or after the window start. */
async function lerProdutosTocados(
  ctx: MigrationContext,
  inicioMs: number,
  tally: Tally,
  pagina: number,
): Promise<ProdutoTocado[]> {
  const tocados: ProdutoTocado[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = ctx.db
      .collection('produtos')
      .where('ultimaModificacao', '>=', inicioMs)
      .orderBy('ultimaModificacao', 'desc')
      .select('ultimaModificacao')
      .limit(pagina);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    contarConsulta(tally, 'produtosTocados', snap.size);
    for (const doc of snap.docs) {
      tocados.push({ id: doc.id, ultimaModificacao: doc.get('ultimaModificacao') as unknown });
    }
    if (snap.size < pagina) return tocados;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/** One record's ledger rows in the window: their `timestamp`s only. */
async function lerRazaoDoRegistro(
  ctx: MigrationContext,
  caminho: string,
  inicioMs: number,
  tally: Tally,
  pagina: number,
): Promise<unknown[]> {
  const carimbos: unknown[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = ctx.db
      .doc(caminho)
      .collection('historicoEstoque')
      .where('timestamp', '>=', inicioMs)
      .orderBy('timestamp', 'desc')
      .select('timestamp')
      .limit(pagina);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    contarConsulta(tally, 'razao', snap.size);
    for (const doc of snap.docs) carimbos.push(doc.get('timestamp') as unknown);
    if (snap.size < pagina) return carimbos;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/**
 * The ledger leg. `null` when the project refuses the query for a missing index (gRPC 9): the
 * walk-based bound then stands alone. Any other failure is rethrown.
 */
async function lerRazao(
  ctx: MigrationContext,
  caminhos: readonly string[],
  inicioMs: number,
  tally: Tally,
  pagina: number,
): Promise<Map<string, unknown[]> | null> {
  const razao = new Map<string, unknown[]>();
  let indisponivel = false;
  await emPiscina(caminhos, CONCORRENCIA, async (caminho) => {
    if (indisponivel) return;
    try {
      razao.set(caminho, await lerRazaoDoRegistro(ctx, caminho, inicioMs, tally, pagina));
    } catch (err) {
      if (!semIndice(err)) throw err;
      indisponivel = true;
    }
  });
  return indisponivel ? null : razao;
}

/* -------------------------------------------------------------------------- */
/*                                  The body                                   */
/* -------------------------------------------------------------------------- */

export interface OpcoesDaContagem {
  readonly dias: number;
  /** The run's clock, read ONCE. */
  readonly agoraMs: () => number;
  /** Writes the summary file; returns where. */
  readonly gravarResumo: (resumo: Resumo) => string;
  /** Page sizes, overridable so a test walks more than one page. */
  readonly paginas?: { readonly chave?: number; readonly janela?: number };
}

/** The default summary writer: `out/<stamp>-li-estoque-contagens-resumo.json`. */
export function gravarResumoEmOut(resumo: Resumo): string {
  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = resumo.geradoEm.replace(/[:.]/g, '-');
  const caminho = resolve(outDir, `${stamp}-${NOME_DA_CONTAGEM}-resumo.json`);
  writeFileSync(caminho, `${JSON.stringify(resumo, null, 2)}\n`, 'utf8');
  return caminho;
}

function recusar(motivo: MotivoDeRecusa): never {
  log(`[${NOME_DA_CONTAGEM}] NAO-AVALIADO ${motivo}`);
  throw new ContagemNaoAvaliada(motivo);
}

/** The body, bound to its options. */
export function criarContagem(
  opcoes: OpcoesDaContagem,
): (ctx: MigrationContext) => Promise<MigrationSummary> {
  const paginaChave = opcoes.paginas?.chave ?? PAGE_SIZE;
  const paginaJanela = opcoes.paginas?.janela ?? PAGE_SIZE_JANELA;
  return async function run(ctx: MigrationContext): Promise<MigrationSummary> {
    if (ctx.apply) {
      // `parseArgsDaContagem` already refused it; this guards a caller that skipped it.
      throw new MigrationArgError('This is a read-only COUNT: it has no --apply path.');
    }
    const agoraMs = opcoes.agoraMs();
    const janela = janelaDeDias(agoraMs, opcoes.dias);
    const tally = leiturasZeradas();
    log(
      `[${NOME_DA_CONTAGEM}] database=${ctx.db.databaseId} janela=${janela.dias[0]!}..` +
        `${janela.dias[janela.dias.length - 1]!} (${String(opcoes.dias)} dia(s), America/Sao_Paulo)`,
    );

    /* -- 1. Contas -------------------------------------------------------- */
    const contas = await lerContas(ctx, tally);
    const semContas = recusaSemContasLi(contas);
    if (semContas !== null) recusar(semContas);

    /* -- 2. Their operações ----------------------------------------------- */
    const operacoes = await lerOperacoes(ctx, operacoesDasContasLi(contas), tally);

    /* -- 3. Every link, by key -------------------------------------------- */
    const vinculos = await lerVinculos(ctx, tally, paginaChave);
    log(`[${NOME_DA_CONTAGEM}] ${String(vinculos.length)} vínculo(s) lido(s)`);
    const semVinculos = recusaSemVinculos(contas, vinculos);
    if (semVinculos !== null) recusar(semVinculos);

    /* -- 4. The produtos they name ---------------------------------------- */
    const produtos = await lerProdutos(ctx, produtosDosVinculos(vinculos), tally);

    /* -- 5. Every stock record, by key ------------------------------------ */
    const estoques = await lerEstoques(ctx, tally, paginaChave);
    log(`[${NOME_DA_CONTAGEM}] ${String(estoques.length)} registro(s) de estoque lido(s)`);

    /* -- 6. Produtos touched in the window -------------------------------- */
    const produtosTocados = await lerProdutosTocados(ctx, janela.inicioMs, tally, paginaJanela);

    /* -- 7. The ledger of the records touched at a Loja Integrada depósito  */
    const paraRazao = registrosParaRazao(estoques, depositosDasContasLi(contas), janela);
    const razao = await lerRazao(ctx, paraRazao, janela.inicioMs, tally, paginaJanela);
    if (razao === null) {
      log(
        `[${NOME_DA_CONTAGEM}] AVISO: historicoEstoque recusou a consulta por timestamp ` +
          '(índice ausente): a razão fica indisponível e vale só o limite inferior da varredura.',
      );
    }

    const leituras = Object.fromEntries(
      Object.entries(tally).map(([perna, l]) => [perna, { ...l } satisfies LeituraDaPerna]),
    ) as Record<Perna, LeituraDaPerna>;
    const resultado = contar({
      agoraMs,
      dias: opcoes.dias,
      contas,
      operacoes,
      vinculos,
      produtos,
      estoques,
      produtosTocados,
      razao,
      leituras,
    });

    if (!ctx.reportOnly) {
      for (const a of resultado.achados) ctx.sink.change(a.caminho, a.classe, null, a.valor);
      for (const i of resultado.ignorados) ctx.sink.skip(i.caminho, i.campo, i.valor, i.motivo);
    }
    const caminhoDoResumo = opcoes.gravarResumo(resultado.resumo);
    log(`[${NOME_DA_CONTAGEM}] resumo (counts only, paste this one) → ${caminhoDoResumo}`);
    log(`[${NOME_DA_CONTAGEM}] somente leitura: nenhum documento foi alterado.`);
    log(`RESUMO ${JSON.stringify(resultado.resumo)}`);

    const docsScanned = Object.values(tally).reduce((n, l) => n + l.documentos, 0);
    return { docsScanned, docsChanged: 0 };
  };
}

if (isMainModule(import.meta.url)) {
  const { dias, resto } = parseArgsDaContagem(process.argv.slice(2));
  await runMigration(
    NOME_DA_CONTAGEM,
    criarContagem({ dias, agoraMs: () => Date.now(), gravarResumo: gravarResumoEmOut }),
    resto,
  );
}
