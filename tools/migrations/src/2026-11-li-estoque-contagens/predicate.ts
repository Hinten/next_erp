import { dataCivilNoFuso, microsDeDataHoraNoFuso, somarDiasCivis } from '@delfrance/core/datetime';
import { componentesNaoResolvidos } from '@delfrance/data/admin/estoque';
import { contaRefForms } from '@delfrance/data/admin/produtos';
import {
  FUSO_FISCAL,
  INTEGRACAO_TIPO,
  MAX_KITS_EM_LINHA_ESTOQUE_LI,
  MAX_KITS_POR_FATIA_ESTOQUE_LI,
  caminhoEstoqueLi,
  componentesKitEntries,
  contaIdFromRef,
  depositoDaContaLi,
  estoqueNoDepositoLi,
  formasDoDepositoLi,
  makeEstoqueUid,
  segmentoDeCaminhoLi,
  toDocPathOrNull,
  vinculoDaContaLi,
  vinculoLiConta,
  type ComponentesKit,
  type DocEstoqueLi,
} from '@delfrance/schemas';

/**
 * Pure half of the Loja Integrada stock COUNTS: the step-12 stock plan's ERP counts, measured on
 * the legacy project before PR 12-f (the trigger and the kit fan-out) merges, because that PR's
 * thresholds — the eager-versus-deferred kit split at {@link MAX_KITS_EM_LINHA_ESTOQUE_LI} kits
 * per component, the expected trigger volume, the >5% no-record gate — are only as good as these
 * numbers. Runbook: `tools/migrations/li-estoque-contagens.README.md`.
 *
 * No Firestore here: `audit.ts` reads, this module decides and counts (`tools/migrations/README.md`,
 * contract point 5). No clock either: `agoraMs` and `dias` are parameters.
 *
 * ## The run's own definitions, never a second copy
 *
 * Every "same / different" decision is the stock run's own reader from `@delfrance/schemas`: the
 * conta of a link (`contaIdFromRef`, both stored forms), whether a link counts (`vinculoLiConta`),
 * the conta's verdict on one produto (`vinculoDaContaLi`: `vinculado` is a LINKED CHILD), the
 * conta's depósito and its two exact stored forms (`depositoDaContaLi`, `formasDoDepositoLi`), the
 * record the run reads at that depósito (`estoqueNoDepositoLi`: the canonical `makeEstoqueUid` id
 * wins, two others are ambiguous), the stock path (`caminhoEstoqueLi`). The set of components that
 * CONSTRAIN a kit comes only through the shared fold (`componentesNaoResolvidos` over no record:
 * `limitarEstoque !== false` and a finite quantity above 0), never a reader of the deprecated flag
 * of its own; the "every component limits" variant reads the quantity alone.
 *
 * ## What the app sees, and what only a fold sees
 *
 * The run's queries match a depósito ref only in its two EXACT forms. A record whose ref folds to
 * the depósito through `toOuterRefOrNull` but matches neither form (a leading slash, a doubled
 * slash) is `dobrada`: counted apart, never as "at the depósito", because the run does not see it.
 *
 * ## Lower bounds, said so
 *
 * Every per-day figure is a LOWER bound. A record or produto is bucketed by its LAST
 * `ultimaModificacao`, so one touched on several days counts once, on its last; a stamp that is
 * absent or not a safe integer is invisible to a numeric range and counted apart. The ledger
 * (`historicoEstoque`) rows per day are the closer measure of writes, and still miss a writer that
 * appends no row.
 *
 * ## Privacy
 *
 * {@link Resumo} is the ONE output meant to be pasted back. It carries counts, booleans, civil
 * dates and pseudonyms (`loja-1`, `dep-1`) only — by construction no produto, conta, depósito,
 * record or store id, and no ref. The pseudonym map and every per-document finding go to the local
 * JSONL alone ({@link Achado}, {@link Ignorado}).
 */

/* -------------------------------------------------------------------------- */
/*                                 Constants                                   */
/* -------------------------------------------------------------------------- */

/** The runner's log name: `out/<stamp>-li-estoque-contagens-dryrun.jsonl`. */
export const NOME_DA_CONTAGEM = 'li-estoque-contagens';

/** The default per-day window, in civil days ending today (São Paulo). */
export const DIAS_PADRAO = 14;
/** The widest window `--dias` accepts. */
export const DIAS_MAX = 60;

/** The plan's no-record gate: above this share of linked children, fix the depósito mapping. */
export const LIMITE_SEM_REGISTRO = 0.05;

/** The upper edges of the F histogram's buckets; the last bucket is everything above. */
export const FAIXAS_F = [
  1,
  5,
  10,
  MAX_KITS_EM_LINHA_ESTOQUE_LI,
  100,
  300,
  MAX_KITS_POR_FATIA_ESTOQUE_LI,
] as const;

/* -------------------------------------------------------------------------- */
/*                                   Inputs                                    */
/* -------------------------------------------------------------------------- */

/** One `integracao` doc, masked. */
export interface ContaLida {
  readonly id: string;
  readonly tipo: unknown;
  readonly depositoOuterRef: unknown;
  readonly operacaoOuterRef: unknown;
  readonly operacaoDevolucaoOuterRef: unknown;
  readonly ativo: unknown;
}

/** One `operacao` point read, masked to the two stock flags. */
export interface OperacaoLida {
  readonly existe: boolean;
  readonly dados: Readonly<Record<string, unknown>>;
}

/** One `produtolojaintegrada` doc: its full path and its masked fields. */
export interface VinculoLido {
  readonly caminho: string;
  readonly dados: Readonly<Record<string, unknown>>;
}

/** One produto point read, masked. */
export interface ProdutoLido {
  readonly existe: boolean;
  readonly dados: Readonly<Record<string, unknown>>;
}

/** One `estoques` doc from the collection-group walk: its full path and its masked fields. */
export interface EstoqueLido {
  readonly caminho: string;
  readonly dados: Readonly<Record<string, unknown>>;
}

/** One produto the window query returned. */
export interface ProdutoTocado {
  readonly id: string;
  readonly ultimaModificacao: unknown;
}

/** What one read leg cost: documents returned (every ref, for a `getAll`) and queries sent. */
export interface LeituraDaPerna {
  readonly documentos: number;
  readonly consultas: number;
  /** Queries that returned nothing: Standard bills one read for each. */
  readonly consultasVazias: number;
}

export type Perna =
  | 'contas'
  | 'operacoes'
  | 'vinculos'
  | 'produtos'
  | 'estoques'
  | 'produtosTocados'
  | 'razao';

export interface EntradaDaContagem {
  readonly agoraMs: number;
  readonly dias: number;
  readonly contas: readonly ContaLida[];
  /** Bare path (`operacao/<id>`) → its read. */
  readonly operacoes: ReadonlyMap<string, OperacaoLida>;
  readonly vinculos: readonly VinculoLido[];
  /** Produto id → its read, for every id {@link produtosDosVinculos} named. */
  readonly produtos: ReadonlyMap<string, ProdutoLido>;
  readonly estoques: readonly EstoqueLido[];
  readonly produtosTocados: readonly ProdutoTocado[];
  /**
   * Record path → the ledger `timestamp`s read in the window, for every path
   * {@link registrosParaRazao} named; `null` when the ledger leg could not run (the query was
   * refused for a missing index).
   */
  readonly razao: ReadonlyMap<string, readonly unknown[]> | null;
  readonly leituras: Readonly<Record<Perna, LeituraDaPerna>>;
}

/* -------------------------------------------------------------------------- */
/*                                  Outputs                                    */
/* -------------------------------------------------------------------------- */

/** A per-document finding: one JSONL `change` row (`field` = `classe`). Local only: carries ids. */
export interface Achado {
  readonly caminho: string;
  readonly classe: string;
  readonly valor: unknown;
}

/** A shape the counts could not read: one JSONL `skip` row. Local only. */
export interface Ignorado {
  readonly caminho: string;
  readonly campo: string;
  readonly valor: unknown;
  readonly motivo: string;
}

export type FormaDeRef = 'canonica' | 'nua' | 'dobrada' | 'ilegivel' | 'ausente';

export type ClasseDoFlag =
  | 'true'
  | 'false'
  | 'nulo'
  | 'ausente'
  | 'outro-tipo'
  | 'operacao-inexistente'
  | 'ref-ilegivel'
  | 'ref-ausente';

export interface Histograma {
  /** Components constraining at least one linked kit. */
  readonly componentes: number;
  /** Distinct linked kits with at least one such component. */
  readonly kits: number;
  readonly faixas: Readonly<Record<string, number>>;
  /** The ten largest F values, descending. Values only. */
  readonly top10: readonly number[];
  readonly maximo: number;
  readonly componentesAcimaDoLimiteEmLinha: number;
  readonly kitsComComponenteAcimaDoLimiteEmLinha: number;
  readonly componentesAcimaDaFatia: number;
  readonly limiteEmLinha: number;
  readonly limiteDaFatia: number;
}

export interface Resumo {
  readonly contagem: string;
  readonly versao: 1;
  readonly geradoEm: string;
  readonly fuso: string;
  readonly dias: number;
  readonly janela: { readonly de: string; readonly ate: string };
  readonly medida: string;
  readonly contas: unknown;
  readonly vinculos: unknown;
  readonly kits: unknown;
  readonly escritasPorDia: unknown;
  readonly produtosTocados: unknown;
  readonly semRegistro: unknown;
  readonly duplicados: unknown;
  readonly semParentId: unknown;
  readonly formasDoDeposito: unknown;
  readonly ignorados: Readonly<Record<string, number>>;
  readonly leituras: unknown;
}

export interface ResultadoDaContagem {
  readonly resumo: Resumo;
  readonly achados: readonly Achado[];
  readonly ignorados: readonly Ignorado[];
}

/* -------------------------------------------------------------------------- */
/*                                  Readers                                    */
/* -------------------------------------------------------------------------- */

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Readonly<Record<string, unknown>>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/** Codepoint order, never locale order: the output must not depend on the machine. */
function comparar(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const CAMINHO_VINCULO_LI = /^produtos\/([^/]+)\/produtolojaintegrada\/[^/]+$/;

/** The produto a link doc belongs to, from its path: exactly `produtos/<p>/produtolojaintegrada/<d>`. */
export function produtoDoVinculo(caminho: string): string | null {
  return CAMINHO_VINCULO_LI.exec(caminho)?.[1] ?? null;
}

/** Every produto id the walked links name, unique and sorted: what the produto leg point-reads. */
export function produtosDosVinculos(vinculos: readonly VinculoLido[]): string[] {
  const ids = new Set<string>();
  for (const v of vinculos) {
    const id = produtoDoVinculo(v.caminho);
    if (id !== null) ids.add(id);
  }
  return [...ids].sort(comparar);
}

/**
 * How a link stores its conta ref, and the conta it names. `canonica` / `nua` are the two exact
 * forms (`contaRefForms`); `dobrada` folds to a conta (`contaIdFromRef`) but is neither, so the
 * run's own reader sees it and an equality query on the field does not.
 *
 * Equal (⇒ `C1`): `documents/integracao/C1` (canonica), `integracao/C1` (nua),
 * `/documents/integracao/C1` (dobrada). Distinct: `documents/integracao/C2` ⇒ `C2`;
 * `documents/categorias/C1` ⇒ ilegivel; `null` or absent ⇒ ausente.
 */
export function formaDaRefDaConta(raw: unknown): {
  readonly forma: FormaDeRef;
  readonly contaId: string | null;
} {
  if (raw === undefined || raw === null) return { forma: 'ausente', contaId: null };
  const contaId = contaIdFromRef(raw);
  if (contaId === null) return { forma: 'ilegivel', contaId: null };
  const [canonica, nua] = contaRefForms(contaId);
  return { forma: raw === canonica ? 'canonica' : raw === nua ? 'nua' : 'dobrada', contaId };
}

/**
 * How a record (or a conta) stores its depósito ref, and the BARE depósito id it names, read as
 * the run reads a conta's (`depositoDaContaLi`). `canonica` / `nua` are the two exact forms the
 * run's queries match (`formasDoDepositoLi`); `dobrada` folds to the depósito but matches neither.
 *
 * Equal (⇒ `D1`): `documents/depositos/D1` ≡ `depositos/D1` (both exact, both "at D1").
 * Distinct: `documents/depositos/D2` ⇒ `D2`; `/documents/depositos/D1` ⇒ `D1` but `dobrada`;
 * `documents/filiais/D1` ⇒ ilegivel.
 */
export function formaDaRefDoDeposito(raw: unknown): {
  readonly forma: FormaDeRef;
  readonly depositoId: string | null;
} {
  if (raw === undefined || raw === null) return { forma: 'ausente', depositoId: null };
  const depositoId = depositoDaContaLi({ depositoOuterRef: raw });
  if (depositoId === null) return { forma: 'ilegivel', depositoId: null };
  const [canonica, nua] = formasDoDepositoLi(depositoId);
  return { forma: raw === canonica ? 'canonica' : raw === nua ? 'nua' : 'dobrada', depositoId };
}

/** Whether a form is one the run's queries match. */
function exata(forma: FormaDeRef): boolean {
  return forma === 'canonica' || forma === 'nua';
}

export type RefDeOperacao =
  | { readonly tipo: 'ok'; readonly caminho: string }
  | { readonly tipo: 'ausente' }
  | { readonly tipo: 'ilegivel' };

/** A conta's operação ref as the bare path `operacao/<id>`, either stored form. */
export function refDaOperacao(raw: unknown): RefDeOperacao {
  if (raw === undefined || raw === null) return { tipo: 'ausente' };
  const caminho = toDocPathOrNull(raw);
  if (caminho === null) return { tipo: 'ilegivel' };
  const partes = caminho.split('/');
  if (partes.length !== 2 || partes[0] !== 'operacao') return { tipo: 'ilegivel' };
  return { tipo: 'ok', caminho };
}

/** The Loja Integrada contas, sorted. Strict `===` on the stored number. */
export function contasLojaIntegrada(contas: readonly ContaLida[]): ContaLida[] {
  return contas
    .filter((c) => c.tipo === INTEGRACAO_TIPO.lojaIntegrada)
    .sort((a, b) => comparar(a.id, b.id));
}

/** Every operação path the Loja Integrada contas name (outbound and returns), unique, sorted. */
export function operacoesDasContasLi(contas: readonly ContaLida[]): string[] {
  const caminhos = new Set<string>();
  for (const conta of contasLojaIntegrada(contas)) {
    for (const raw of [conta.operacaoOuterRef, conta.operacaoDevolucaoOuterRef]) {
      const ref = refDaOperacao(raw);
      if (ref.tipo === 'ok') caminhos.add(ref.caminho);
    }
  }
  return [...caminhos].sort(comparar);
}

/** The Loja Integrada contas' depósitos, as bare ids. */
export function depositosDasContasLi(contas: readonly ContaLida[]): Set<string> {
  const ids = new Set<string>();
  for (const conta of contasLojaIntegrada(contas)) {
    const id = depositoDaContaLi(conta);
    if (id !== null) ids.add(id);
  }
  return ids;
}

/** Why the counts refuse to report at all. */
export type MotivoDeRecusa = 'sem-contas-li' | 'sem-vinculos-que-contam';

/** The first refusal, decidable from the contas alone, before the walk is paid for. */
export function recusaSemContasLi(contas: readonly ContaLida[]): MotivoDeRecusa | null {
  return contasLojaIntegrada(contas).length === 0 ? 'sem-contas-li' : null;
}

/**
 * The second refusal, after the link walk: no counting link names a Loja Integrada conta. On the
 * wrong project or database every count reads zero, and zeros must never read as a measurement.
 */
export function recusaSemVinculos(
  contas: readonly ContaLida[],
  vinculos: readonly VinculoLido[],
): MotivoDeRecusa | null {
  const contasLi = new Set(contasLojaIntegrada(contas).map((c) => c.id));
  const algum = vinculos.some((v) => {
    if (produtoDoVinculo(v.caminho) === null) return false;
    const { contaId } = formaDaRefDaConta(proprio(v.dados, 'contaLojaIntegrada'));
    return contaId !== null && contasLi.has(contaId) && vinculoLiConta(v.dados);
  });
  return algum ? null : 'sem-vinculos-que-contam';
}

/* -------------------------------------------------------------------------- */
/*                                The window                                   */
/* -------------------------------------------------------------------------- */

export interface Janela {
  /** The civil days of the window, ascending; the last is today. */
  readonly dias: readonly string[];
  /** São Paulo midnight that opens the first day, epoch ms: the read legs' lower bound. */
  readonly inicioMs: number;
  readonly agoraMs: number;
}

/**
 * The last `dias` civil days in São Paulo, today included. Throws `RangeError` on a `dias`
 * outside 1..{@link DIAS_MAX} or a clock that is not a safe integer (the caller's bug).
 */
export function janelaDeDias(agoraMs: number, dias: number): Janela {
  if (!Number.isSafeInteger(dias) || dias < 1 || dias > DIAS_MAX) {
    throw new RangeError(`dias must be an integer in 1..${String(DIAS_MAX)}`);
  }
  if (!Number.isSafeInteger(agoraMs)) throw new RangeError('agoraMs must be a safe integer');
  const hoje = dataCivilNoFuso(agoraMs, FUSO_FISCAL);
  const lista: string[] = [];
  for (let i = dias - 1; i >= 0; i -= 1) {
    const dia = somarDiasCivis(hoje, -i);
    if (dia === null) throw new RangeError('janelaDeDias: civil date out of range');
    lista.push(dia);
  }
  const inicioUs = microsDeDataHoraNoFuso(`${lista[0]!}T00:00:00`, FUSO_FISCAL);
  if (inicioUs === null) throw new RangeError('janelaDeDias: window start out of range');
  return { dias: lista, inicioMs: inicioUs / 1000, agoraMs };
}

export type Balde =
  | { readonly tipo: 'dia'; readonly dia: string }
  | { readonly tipo: 'futuro' }
  | { readonly tipo: 'antes' }
  | { readonly tipo: 'invalido' };

/**
 * The civil day (São Paulo) a stored ms stamp falls on, inside the window. A stamp after the
 * clock is `futuro` (the legacy writer stamps a few seconds ahead); one that is not a safe integer
 * — absent, `null`, text, a fraction — is `invalido`, the shape a numeric range never returns.
 */
export function baldeDoCarimbo(valor: unknown, janela: Janela): Balde {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor)) return { tipo: 'invalido' };
  if (valor > janela.agoraMs) return { tipo: 'futuro' };
  if (valor < janela.inicioMs) return { tipo: 'antes' };
  return { tipo: 'dia', dia: dataCivilNoFuso(valor, FUSO_FISCAL) };
}

/**
 * The records the ledger leg reads: at a Loja Integrada depósito in an EXACT form, with a numeric
 * `ultimaModificacao` at or after the window's start. Sorted, unique.
 */
export function registrosParaRazao(
  estoques: readonly EstoqueLido[],
  depositosLi: ReadonlySet<string>,
  janela: Janela,
): string[] {
  const caminhos = new Set<string>();
  for (const e of estoques) {
    if (caminhoEstoqueLi(e.caminho) === null) continue;
    const { forma, depositoId } = formaDaRefDoDeposito(proprio(e.dados, 'depositoOuterRef'));
    if (!exata(forma) || depositoId === null || !depositosLi.has(depositoId)) continue;
    const balde = baldeDoCarimbo(proprio(e.dados, 'ultimaModificacao'), janela);
    if (balde.tipo === 'dia' || balde.tipo === 'futuro') caminhos.add(e.caminho);
  }
  return [...caminhos].sort(comparar);
}

/* -------------------------------------------------------------------------- */
/*                              Kits and the F                                 */
/* -------------------------------------------------------------------------- */

/** What the counts need of one linked produto. */
interface ProdutoAnalisado {
  readonly ehKit: boolean;
  readonly ehKitVirtual: boolean;
  /** Components that constrain the kit in the shared fold's sense, one path segment each. */
  readonly restritivos: readonly string[];
  /** Components with a finite quantity above 0, whatever their flag (the planned rule change). */
  readonly todosLimitam: readonly string[];
  readonly semComponentes: boolean;
  readonly componentesIlegiveis: boolean;
  readonly descartados: number;
  readonly idsInvalidos: number;
}

/**
 * One produto's kit reading. Kit flags strictly `=== true` (a stored `'true'` or `1` is not a
 * kit, as the run reads them). A non-kit has no components here.
 */
export function analisarProduto(dados: Readonly<Record<string, unknown>>): ProdutoAnalisado {
  const ehKit = proprio(dados, 'ehKit') === true;
  const ehKitVirtual = proprio(dados, 'ehKitVirtual') === true;
  const bruto = proprio(dados, 'componentesKit');
  const componentesKit = (bruto ?? null) as ComponentesKit | null;
  if (!ehKit && !ehKitVirtual) {
    return {
      ehKit,
      ehKitVirtual,
      restritivos: [],
      todosLimitam: [],
      semComponentes: false,
      componentesIlegiveis: false,
      descartados: 0,
      idsInvalidos: 0,
    };
  }
  const ehMapa = typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto);
  const entradas = componentesKitEntries(componentesKit);
  const descartados = ehMapa ? Object.keys(bruto).length - entradas.length : 0;
  const naFold = componentesNaoResolvidos({
    produtoId: '',
    ehKit,
    ehKitVirtual,
    publicado: true,
    componentesKit,
    timestampMs: null,
    estoque: null,
    componentEstoques: [],
  });
  const todos = entradas
    .filter(([, kit]) => Number.isFinite(kit.quantidade) && kit.quantidade > 0)
    .map(([id]) => id);
  const idsInvalidos = new Set([...naFold, ...todos].filter((id) => !segmentoDeCaminhoLi(id)));
  return {
    ehKit,
    ehKitVirtual,
    restritivos: naFold.filter(segmentoDeCaminhoLi),
    todosLimitam: todos.filter(segmentoDeCaminhoLi),
    semComponentes: ehMapa
      ? Object.keys(bruto).length === 0
      : bruto === undefined || bruto === null,
    componentesIlegiveis: bruto !== undefined && bruto !== null && !ehMapa,
    descartados,
    idsInvalidos: idsInvalidos.size,
  };
}

/** The bucket label of one F value. */
function faixaDe(f: number): string {
  let anterior = 0;
  for (const limite of FAIXAS_F) {
    if (f <= limite) return anterior + 1 === limite ? String(limite) : `${anterior + 1}-${limite}`;
    anterior = limite;
  }
  return `>${anterior}`;
}

/** Every bucket label, in order, so an empty bucket still prints 0. */
function faixasVazias(): Record<string, number> {
  const faixas: Record<string, number> = {};
  let anterior = 0;
  for (const limite of FAIXAS_F) {
    faixas[anterior + 1 === limite ? String(limite) : `${anterior + 1}-${limite}`] = 0;
    anterior = limite;
  }
  faixas[`>${anterior}`] = 0;
  return faixas;
}

/**
 * The F histogram: component → the linked kits it constrains. Values only: no id leaves.
 */
export function histogramaF(
  kitsPorComponente: ReadonlyMap<string, ReadonlySet<string>>,
): Histograma {
  const faixas = faixasVazias();
  const valores: number[] = [];
  const kits = new Set<string>();
  const kitsAcima = new Set<string>();
  let acimaDaFatia = 0;
  for (const conjunto of kitsPorComponente.values()) {
    const f = conjunto.size;
    if (f === 0) continue;
    valores.push(f);
    const faixa = faixaDe(f);
    faixas[faixa] = (faixas[faixa] ?? 0) + 1;
    for (const kit of conjunto) kits.add(kit);
    if (f > MAX_KITS_EM_LINHA_ESTOQUE_LI) for (const kit of conjunto) kitsAcima.add(kit);
    if (f > MAX_KITS_POR_FATIA_ESTOQUE_LI) acimaDaFatia += 1;
  }
  valores.sort((a, b) => b - a);
  return {
    componentes: valores.length,
    kits: kits.size,
    faixas,
    top10: valores.slice(0, 10),
    maximo: valores[0] ?? 0,
    componentesAcimaDoLimiteEmLinha: valores.filter((f) => f > MAX_KITS_EM_LINHA_ESTOQUE_LI).length,
    kitsComComponenteAcimaDoLimiteEmLinha: kitsAcima.size,
    componentesAcimaDaFatia: acimaDaFatia,
    limiteEmLinha: MAX_KITS_EM_LINHA_ESTOQUE_LI,
    limiteDaFatia: MAX_KITS_POR_FATIA_ESTOQUE_LI,
  };
}

function adicionarAoMapa(
  mapa: Map<string, Set<string>>,
  componentes: readonly string[],
  kit: string,
): void {
  for (const componente of componentes) {
    const conjunto = mapa.get(componente) ?? new Set<string>();
    conjunto.add(kit);
    mapa.set(componente, conjunto);
  }
}

/* -------------------------------------------------------------------------- */
/*                                The counts                                   */
/* -------------------------------------------------------------------------- */

type ClasseDoParentId = 'ok' | 'ausente' | 'nulo' | 'vazio' | 'diverge' | 'outro-tipo';

function classeDoParentId(
  dados: Readonly<Record<string, unknown>>,
  dono: string,
): ClasseDoParentId {
  if (!Object.hasOwn(dados, 'parentId')) return 'ausente';
  const v = dados.parentId;
  if (v === null) return 'nulo';
  if (typeof v !== 'string') return 'outro-tipo';
  if (v === '') return 'vazio';
  return v === dono ? 'ok' : 'diverge';
}

interface RegistroLido {
  readonly caminho: string;
  readonly produtoId: string;
  readonly estoqueId: string;
  readonly forma: FormaDeRef;
  readonly depositoId: string | null;
  readonly parentId: ClasseDoParentId;
  readonly carimbo: unknown;
}

function classeDoFlagEm(
  ref: RefDeOperacao,
  operacoes: ReadonlyMap<string, OperacaoLida>,
  campo: string,
): ClasseDoFlag {
  if (ref.tipo === 'ausente') return 'ref-ausente';
  if (ref.tipo === 'ilegivel') return 'ref-ilegivel';
  const operacao = operacoes.get(ref.caminho);
  if (operacao === undefined || !operacao.existe) return 'operacao-inexistente';
  if (!Object.hasOwn(operacao.dados, campo)) return 'ausente';
  const v = operacao.dados[campo];
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === null) return 'nulo';
  return 'outro-tipo';
}

function classeDoAtivo(v: unknown): 'true' | 'false' | 'ausente' | 'outro-tipo' {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === undefined) return 'ausente';
  return 'outro-tipo';
}

function contarForma(alvo: Record<FormaDeRef, number>, forma: FormaDeRef): void {
  alvo[forma] += 1;
}

function formasZeradas(): Record<FormaDeRef, number> {
  return { canonica: 0, nua: 0, dobrada: 0, ilegivel: 0, ausente: 0 };
}

function parentIdZerado(): Record<ClasseDoParentId, number> {
  return { ok: 0, ausente: 0, nulo: 0, vazio: 0, diverge: 0, 'outro-tipo': 0 };
}

function incrementar(mapa: Map<string, number>, chave: string, n = 1): void {
  mapa.set(chave, (mapa.get(chave) ?? 0) + n);
}

function fracao(n: number, base: number): number | null {
  return base === 0 ? null : n / base;
}

/** Per conta, what its links on every produto say. */
interface VereditosDaConta {
  readonly vinculados: Map<string, string>;
  readonly pais: Set<string>;
  naoSuportados: number;
  ambiguos: number;
}

/**
 * Every count, over one corpus. Pure and total: an odd shape is counted and listed in
 * {@link Ignorado}, never thrown on (a throw is a bug in the caller's input).
 */
export function contar(entrada: EntradaDaContagem): ResultadoDaContagem {
  const janela = janelaDeDias(entrada.agoraMs, entrada.dias);
  const achados: Achado[] = [];
  const ignorados: Ignorado[] = [];
  const ignorar = (caminho: string, campo: string, valor: unknown, motivo: string): void => {
    ignorados.push({ caminho, campo, valor, motivo });
  };

  /* -- Contas ------------------------------------------------------------- */
  const tipoDaConta = new Map(entrada.contas.map((c) => [c.id, c.tipo] as const));
  const contasLi = contasLojaIntegrada(entrada.contas);

  /* -- Links -------------------------------------------------------------- */
  const linksPorProduto = new Map<string, Readonly<Record<string, unknown>>[]>();
  const porConta = new Map<
    string,
    {
      documentos: number;
      formas: Record<FormaDeRef, number>;
      removidos: number;
      contam: number;
      idTexto: number;
      idIlegivel: number;
      filhos: number;
      raizesComGrades: number;
      raizesSemGrades: number;
    }
  >();
  for (const conta of contasLi) {
    porConta.set(conta.id, {
      documentos: 0,
      formas: formasZeradas(),
      removidos: 0,
      contam: 0,
      idTexto: 0,
      idIlegivel: 0,
      filhos: 0,
      raizesComGrades: 0,
      raizesSemGrades: 0,
    });
  }
  const globais = {
    documentos: 0,
    caminhoInesperado: 0,
    contaAusente: 0,
    contaIlegivel: 0,
    contaInexistente: 0,
    contaDeOutroTipo: 0,
  };
  /** `<conta>\0<store id text>` → owner produtos, counting links only. */
  const donos = new Map<string, Set<string>>();

  for (const v of entrada.vinculos) {
    globais.documentos += 1;
    const produtoId = produtoDoVinculo(v.caminho);
    if (produtoId === null) {
      globais.caminhoInesperado += 1;
      ignorar(v.caminho, 'caminho', null, 'vinculo-caminho-inesperado');
      continue;
    }
    const lista = linksPorProduto.get(produtoId) ?? [];
    lista.push(v.dados);
    linksPorProduto.set(produtoId, lista);

    const bruto = proprio(v.dados, 'contaLojaIntegrada');
    const { forma, contaId } = formaDaRefDaConta(bruto);
    if (contaId === null) {
      if (forma === 'ausente') globais.contaAusente += 1;
      else globais.contaIlegivel += 1;
      ignorar(v.caminho, 'contaLojaIntegrada', bruto ?? null, `vinculo-conta-${forma}`);
      continue;
    }
    if (!tipoDaConta.has(contaId)) {
      globais.contaInexistente += 1;
      ignorar(v.caminho, 'contaLojaIntegrada', bruto, 'vinculo-conta-inexistente');
      continue;
    }
    const stats = porConta.get(contaId);
    if (stats === undefined) {
      globais.contaDeOutroTipo += 1;
      ignorar(v.caminho, 'contaLojaIntegrada', bruto, 'vinculo-conta-de-outro-tipo');
      continue;
    }
    stats.documentos += 1;
    contarForma(stats.formas, forma);
    const removido = proprio(v.dados, 'removido') === true;
    if (removido) stats.removidos += 1;
    if (!vinculoLiConta(v.dados)) {
      if (!removido) {
        stats.idIlegivel += 1;
        ignorar(v.caminho, 'id', proprio(v.dados, 'id') ?? null, 'vinculo-id-ilegivel');
      }
      continue;
    }
    stats.contam += 1;
    const id = proprio(v.dados, 'id');
    if (typeof id === 'string') stats.idTexto += 1;
    if (proprio(v.dados, 'paiProdutoIntegradaId') != null) stats.filhos += 1;
    else {
      const grades = proprio(v.dados, 'grades');
      if (Array.isArray(grades) && grades.length > 0) stats.raizesComGrades += 1;
      else stats.raizesSemGrades += 1;
    }
    // A counting link's id is a positive safe integer or its canonical decimal text, so its
    // `String()` IS the canonical text: a number and its text key one store product.
    const chave = `${contaId}\u0000${String(id)}`;
    const conjunto = donos.get(chave) ?? new Set<string>();
    conjunto.add(produtoId);
    donos.set(chave, conjunto);
  }

  /* -- Verdicts per (conta, produto) -------------------------------------- */
  const vereditos = new Map<string, VereditosDaConta>();
  const produtosComLinks = [...linksPorProduto.keys()].sort(comparar);
  for (const conta of contasLi) {
    const v: VereditosDaConta = {
      vinculados: new Map(),
      pais: new Set(),
      naoSuportados: 0,
      ambiguos: 0,
    };
    for (const produtoId of produtosComLinks) {
      const veredito = vinculoDaContaLi(conta.id, linksPorProduto.get(produtoId) ?? []);
      if (veredito.tipo === 'vinculado') v.vinculados.set(produtoId, veredito.idLi);
      else if (veredito.tipo === 'pai') v.pais.add(produtoId);
      else if (veredito.tipo === 'nao-suportado') v.naoSuportados += 1;
      else if (veredito.tipo === 'vinculo-ambiguo') v.ambiguos += 1;
    }
    vereditos.set(conta.id, v);
  }

  /* -- Pseudonyms: contas by linked children, descending ------------------ */
  const contasOrdenadas = [...contasLi].sort(
    (a, b) =>
      (vereditos.get(b.id)?.vinculados.size ?? 0) - (vereditos.get(a.id)?.vinculados.size ?? 0) ||
      comparar(a.id, b.id),
  );
  const loja = new Map<string, string>();
  contasOrdenadas.forEach((c, i) => {
    const pseudonimo = `loja-${String(i + 1)}`;
    loja.set(c.id, pseudonimo);
    achados.push({ caminho: `integracao/${c.id}`, classe: 'pseudonimo-conta', valor: pseudonimo });
  });
  const lojaDe = (contaId: string): string => loja.get(contaId) ?? '?';

  /* -- Estoque records ---------------------------------------------------- */
  const registrosPorProduto = new Map<string, RegistroLido[]>();
  const contagemPorDeposito = new Map<string, number>();
  const formasCorpus = formasZeradas();
  let estoqueCaminhoInesperado = 0;
  for (const e of entrada.estoques) {
    const partes = caminhoEstoqueLi(e.caminho);
    if (partes === null) {
      estoqueCaminhoInesperado += 1;
      ignorar(e.caminho, 'caminho', null, 'estoque-caminho-inesperado');
      continue;
    }
    const bruto = proprio(e.dados, 'depositoOuterRef');
    const { forma, depositoId } = formaDaRefDoDeposito(bruto);
    contarForma(formasCorpus, forma);
    if (forma === 'ilegivel' || forma === 'ausente' || forma === 'dobrada') {
      ignorar(e.caminho, 'depositoOuterRef', bruto ?? null, `estoque-deposito-${forma}`);
    }
    if (depositoId !== null) incrementar(contagemPorDeposito, depositoId);
    const registro: RegistroLido = {
      caminho: e.caminho,
      produtoId: partes.produtoId,
      estoqueId: partes.estoqueId,
      forma,
      depositoId,
      parentId: classeDoParentId(e.dados, partes.produtoId),
      carimbo: proprio(e.dados, 'ultimaModificacao'),
    };
    const lista = registrosPorProduto.get(partes.produtoId) ?? [];
    lista.push(registro);
    registrosPorProduto.set(partes.produtoId, lista);
  }
  // The walk's order must not reach the output.
  for (const lista of registrosPorProduto.values()) {
    lista.sort((a, b) => comparar(a.caminho, b.caminho));
  }

  /* -- Pseudonyms: depósitos (the Loja Integrada ones first) -------------- */
  const depositoDaConta = new Map<string, string | null>();
  for (const conta of contasOrdenadas) depositoDaConta.set(conta.id, depositoDaContaLi(conta));
  const ordemDosDepositos: string[] = [];
  for (const conta of contasOrdenadas) {
    const d = depositoDaConta.get(conta.id);
    if (d != null && !ordemDosDepositos.includes(d)) ordemDosDepositos.push(d);
  }
  const outros = new Set<string>(contagemPorDeposito.keys());
  for (const c of entrada.contas) {
    const d = depositoDaContaLi(c);
    if (d !== null) outros.add(d);
  }
  const restantes = [...outros]
    .filter((d) => !ordemDosDepositos.includes(d))
    .sort(
      (a, b) =>
        (contagemPorDeposito.get(b) ?? 0) - (contagemPorDeposito.get(a) ?? 0) || comparar(a, b),
    );
  ordemDosDepositos.push(...restantes);
  const dep = new Map<string, string>();
  ordemDosDepositos.forEach((d, i) => {
    const pseudonimo = `dep-${String(i + 1)}`;
    dep.set(d, pseudonimo);
    achados.push({ caminho: `depositos/${d}`, classe: 'pseudonimo-deposito', valor: pseudonimo });
  });
  const depDe = (d: string | null | undefined): string | null =>
    d == null ? null : (dep.get(d) ?? null);
  const depositosLi = ordemDosDepositos.filter((d) =>
    contasOrdenadas.some((c) => depositoDaConta.get(c.id) === d),
  );

  /* -- Linked produtos: existence, kits, components ----------------------- */
  const analise = new Map<string, ProdutoAnalisado | null>();
  const analisar = (produtoId: string): ProdutoAnalisado | null => {
    if (analise.has(produtoId)) return analise.get(produtoId) ?? null;
    const lido = entrada.produtos.get(produtoId);
    let resultado: ProdutoAnalisado | null = null;
    if (lido === undefined || !lido.existe) {
      ignorar(`produtos/${produtoId}`, 'existe', false, 'produto-ausente');
    } else {
      resultado = analisarProduto(lido.dados);
      const caminho = `produtos/${produtoId}`;
      if (resultado.componentesIlegiveis) {
        ignorar(caminho, 'componentesKit', null, 'kit-componentes-ilegiveis');
      }
      if (resultado.descartados > 0) {
        ignorar(caminho, 'componentesKit', resultado.descartados, 'kit-componentes-descartados');
      }
      if (resultado.idsInvalidos > 0) {
        ignorar(caminho, 'componentesKit', resultado.idsInvalidos, 'kit-componente-id-invalido');
      }
    }
    analise.set(produtoId, resultado);
    return resultado;
  };

  /** Per depósito: the linked produtos and the constraining components of its contas' kits. */
  const vinculadosEm = new Map<string, Set<string>>();
  const componentesEm = new Map<string, Set<string>>();
  for (const d of depositosLi) {
    vinculadosEm.set(d, new Set());
    componentesEm.set(d, new Set());
  }

  const kitsResumo: Record<string, unknown> = {};
  const fCombinado = new Map<string, Set<string>>();
  const fTodosCombinado = new Map<string, Set<string>>();
  for (const conta of contasOrdenadas) {
    const v = vereditos.get(conta.id)!;
    const d = depositoDaConta.get(conta.id) ?? null;
    const f = new Map<string, Set<string>>();
    const fTodos = new Map<string, Set<string>>();
    const k = {
      vinculadosExistentes: 0,
      ehKit: 0,
      ehKitVirtual: 0,
      ambos: 0,
      kits: 0,
      restritos: 0,
      semRestricao: 0,
      semComponentes: 0,
      componentesKitIlegiveis: 0,
      comComponentesDescartados: 0,
      comComponenteIdInvalido: 0,
    };
    for (const [produtoId] of [...v.vinculados].sort((a, b) => comparar(a[0], b[0]))) {
      const p = analisar(produtoId);
      if (p === null) continue;
      k.vinculadosExistentes += 1;
      if (d !== null) vinculadosEm.get(d)?.add(produtoId);
      if (!p.ehKit && !p.ehKitVirtual) continue;
      k.kits += 1;
      if (p.ehKit) k.ehKit += 1;
      if (p.ehKitVirtual) k.ehKitVirtual += 1;
      if (p.ehKit && p.ehKitVirtual) k.ambos += 1;
      if (p.semComponentes) k.semComponentes += 1;
      if (p.componentesIlegiveis) k.componentesKitIlegiveis += 1;
      if (p.descartados > 0) k.comComponentesDescartados += 1;
      if (p.idsInvalidos > 0) k.comComponenteIdInvalido += 1;
      if (p.restritivos.length > 0) {
        k.restritos += 1;
        adicionarAoMapa(f, p.restritivos, produtoId);
        adicionarAoMapa(fCombinado, p.restritivos, produtoId);
        if (d !== null) for (const c of p.restritivos) componentesEm.get(d)?.add(c);
      } else {
        k.semRestricao += 1;
      }
      adicionarAoMapa(fTodos, p.todosLimitam, produtoId);
      adicionarAoMapa(fTodosCombinado, p.todosLimitam, produtoId);
      achados.push({
        caminho: `produtos/${produtoId}`,
        classe: 'kit-vinculado',
        valor: {
          conta: lojaDe(conta.id),
          restritivos: p.restritivos,
          todosLimitam: p.todosLimitam,
        },
      });
    }
    for (const [componente, kits] of [...f].sort((a, b) => comparar(a[0], b[0]))) {
      if (kits.size > MAX_KITS_EM_LINHA_ESTOQUE_LI) {
        achados.push({
          caminho: `produtos/${componente}`,
          classe: 'componente-acima-do-limite-em-linha',
          valor: { conta: lojaDe(conta.id), F: kits.size },
        });
      }
    }
    kitsResumo[lojaDe(conta.id)] = {
      ...k,
      F: histogramaF(f),
      FSeTodosLimitarem: histogramaF(fTodos),
    };
  }

  /* -- (3) + (4): contas, depósitos and operação flags -------------------- */
  const lojasContas: Record<string, unknown> = {};
  for (const conta of contasOrdenadas) {
    const { forma } = formaDaRefDoDeposito(conta.depositoOuterRef);
    const d = depositoDaConta.get(conta.id) ?? null;
    if (d === null) {
      ignorar(
        `integracao/${conta.id}`,
        'depositoOuterRef',
        conta.depositoOuterRef ?? null,
        'conta-deposito-ilegivel',
      );
    }
    const saida = refDaOperacao(conta.operacaoOuterRef);
    const devolucao = refDaOperacao(conta.operacaoDevolucaoOuterRef);
    for (const [campo, ref] of [
      ['operacaoOuterRef', saida],
      ['operacaoDevolucaoOuterRef', devolucao],
    ] as const) {
      if (ref.tipo === 'ilegivel') {
        ignorar(`integracao/${conta.id}`, campo, null, 'operacao-ref-ilegivel');
      }
    }
    lojasContas[lojaDe(conta.id)] = {
      deposito: depDe(d),
      formaDoDeposito: forma,
      ativo: classeDoAtivo(conta.ativo),
      operacao: {
        movimentaIndisponivelEstoque: classeDoFlagEm(
          saida,
          entrada.operacoes,
          'movimentaIndisponivelEstoque',
        ),
        movimentaEstoque: classeDoFlagEm(saida, entrada.operacoes, 'movimentaEstoque'),
      },
      operacaoDevolucao: {
        movimentaIndisponivelEstoque: classeDoFlagEm(
          devolucao,
          entrada.operacoes,
          'movimentaIndisponivelEstoque',
        ),
        movimentaEstoque: classeDoFlagEm(devolucao, entrada.operacoes, 'movimentaEstoque'),
      },
      mesmaOperacaoNasDuas:
        saida.tipo === 'ok' && devolucao.tipo === 'ok' && saida.caminho === devolucao.caminho,
    };
  }
  const depositosLiDasContas = contasOrdenadas.map((c) => depositoDaConta.get(c.id) ?? null);
  const canal = (tipo: number) => {
    const contas = entrada.contas
      .filter((c) => c.tipo === tipo)
      .sort((a, b) => comparar(a.id, b.id));
    const porDeposito: Record<string, number> = {};
    let semDeposito = 0;
    let ativas = 0;
    let noDepositoLi = 0;
    for (const c of contas) {
      if (c.ativo !== false) ativas += 1;
      const d = depositoDaContaLi(c);
      if (d === null) {
        semDeposito += 1;
        continue;
      }
      const p = depDe(d) ?? '?';
      porDeposito[p] = (porDeposito[p] ?? 0) + 1;
      if (depositosLi.includes(d)) noDepositoLi += 1;
    }
    return { contas: contas.length, ativas, semDeposito, noDepositoLi, porDeposito };
  };
  const contasDosTresCanais = entrada.contas.filter(
    (c) =>
      c.tipo === INTEGRACAO_TIPO.lojaIntegrada ||
      c.tipo === INTEGRACAO_TIPO.mercadoLivre ||
      c.tipo === INTEGRACAO_TIPO.shopee,
  );
  const depositosDosTresCanais = contasDosTresCanais.map((c) => depositoDaContaLi(c));
  const contasResumo = {
    lojas: lojasContas,
    contasLiNoMesmoDeposito:
      depositosLiDasContas.length > 0 &&
      depositosLiDasContas.every((d) => d !== null && d === depositosLiDasContas[0]),
    mercadoLivre: canal(INTEGRACAO_TIPO.mercadoLivre),
    shopee: canal(INTEGRACAO_TIPO.shopee),
    todasNoMesmoDeposito:
      depositosDosTresCanais.length > 0 &&
      depositosDosTresCanais.every((d) => d !== null && d === depositosDosTresCanais[0]),
    outrasContas: entrada.contas.length - contasDosTresCanais.length,
  };

  /* -- Links per conta, with duplicates ----------------------------------- */
  const vinculosResumo: Record<string, unknown> = {};
  for (const conta of contasOrdenadas) {
    const stats = porConta.get(conta.id)!;
    const v = vereditos.get(conta.id)!;
    let idsDuplicados = 0;
    const duplicados = new Set<string>();
    for (const [chave, produtos] of [...donos].sort((a, b) => comparar(a[0], b[0]))) {
      const [contaId, idLi] = chave.split('\u0000');
      if (contaId !== conta.id || produtos.size < 2) continue;
      idsDuplicados += 1;
      duplicados.add(idLi!);
      const ordenados = [...produtos].sort(comparar);
      achados.push({
        caminho: `produtos/${ordenados[0]!}`,
        classe: 'vinculo-duplicado',
        valor: { conta: lojaDe(conta.id), idLi, donos: ordenados },
      });
    }
    let produtosComIdDuplicado = 0;
    for (const idLi of v.vinculados.values()) if (duplicados.has(idLi)) produtosComIdDuplicado += 1;
    vinculosResumo[lojaDe(conta.id)] = {
      documentos: stats.documentos,
      formasDaConta: {
        canonica: stats.formas.canonica,
        nua: stats.formas.nua,
        dobrada: stats.formas.dobrada,
      },
      removidos: stats.removidos,
      contam: stats.contam,
      idTexto: stats.idTexto,
      idIlegivel: stats.idIlegivel,
      filhos: stats.filhos,
      raizesComGrades: stats.raizesComGrades,
      raizesSemGrades: stats.raizesSemGrades,
      produtos: {
        vinculados: v.vinculados.size,
        pais: v.pais.size,
        naoSuportados: v.naoSuportados,
        ambiguos: v.ambiguos,
      },
      idsDuplicados,
      filhosComIdDuplicado: produtosComIdDuplicado,
    };
  }

  /* -- Record lookups at one depósito ------------------------------------- */
  const exatosEm = (produtoId: string, d: string): DocEstoqueLi[] =>
    (registrosPorProduto.get(produtoId) ?? [])
      .filter((r) => exata(r.forma) && r.depositoId === d)
      .map((r) => ({ caminho: r.caminho, dados: {} }));
  const dobradoEm = (produtoId: string, d: string): boolean =>
    (registrosPorProduto.get(produtoId) ?? []).some(
      (r) => r.forma === 'dobrada' && r.depositoId === d,
    );

  /* -- (6) linked children with no record at the conta's depósito --------- */
  const semRegistroResumo: Record<string, unknown> = {};
  for (const conta of contasOrdenadas) {
    const v = vereditos.get(conta.id)!;
    const d = depositoDaConta.get(conta.id) ?? null;
    const duplicadosDaConta = new Set<string>();
    for (const [chave, produtos] of donos) {
      const [contaId, idLi] = chave.split('\u0000');
      if (contaId === conta.id && produtos.size > 1) duplicadosDaConta.add(idLi!);
    }
    let base = 0;
    let comIdDuplicado = 0;
    let produtosAusentes = 0;
    let comRegistro = 0;
    let comRegistroCanonico = 0;
    let comOutros = 0;
    let semNenhum = 0;
    let soDobrada = 0;
    let ambiguo = 0;
    let kitsRestritos = 0;
    let kitsComFaltante = 0;
    let kitsComAmbiguo = 0;
    let kitsSemNenhum = 0;
    for (const [produtoId, idLi] of [...v.vinculados].sort((a, b) => comparar(a[0], b[0]))) {
      const p = analisar(produtoId);
      if (p === null) {
        produtosAusentes += 1;
        continue;
      }
      if (p.restritivos.length > 0) {
        kitsRestritos += 1;
        if (d === null) continue;
        const faltantes: string[] = [];
        let ambiguos = 0;
        for (const componente of p.restritivos) {
          const r = estoqueNoDepositoLi({
            produtoId: componente,
            depositoId: d,
            registros: exatosEm(componente, d),
          });
          if (r.tipo === 'nenhum') faltantes.push(componente);
          else if (r.tipo === 'ambiguo') ambiguos += 1;
        }
        if (faltantes.length > 0) {
          kitsComFaltante += 1;
          achados.push({
            caminho: `produtos/${produtoId}`,
            classe: 'kit-componente-sem-registro',
            valor: { conta: lojaDe(conta.id), componentes: faltantes },
          });
        }
        if (faltantes.length === p.restritivos.length) kitsSemNenhum += 1;
        if (ambiguos > 0) kitsComAmbiguo += 1;
        continue;
      }
      base += 1;
      if (duplicadosDaConta.has(idLi)) comIdDuplicado += 1;
      if (d === null) continue;
      const r = estoqueNoDepositoLi({
        produtoId,
        depositoId: d,
        registros: exatosEm(produtoId, d),
      });
      if (r.tipo === 'um') {
        comRegistro += 1;
        if (caminhoEstoqueLi(r.registro.caminho)?.estoqueId === makeEstoqueUid(produtoId, d)) {
          comRegistroCanonico += 1;
        }
      } else if (r.tipo === 'ambiguo') {
        ambiguo += 1;
        achados.push({
          caminho: `produtos/${produtoId}`,
          classe: 'estoque-ambiguo',
          valor: { conta: lojaDe(conta.id), deposito: depDe(d) },
        });
      } else {
        const dobrada = dobradoEm(produtoId, d);
        if (dobrada) soDobrada += 1;
        const temOutros = (registrosPorProduto.get(produtoId)?.length ?? 0) > 0;
        if (temOutros) comOutros += 1;
        else semNenhum += 1;
        achados.push({
          caminho: `produtos/${produtoId}`,
          classe: 'sem-registro-no-deposito',
          valor: {
            conta: lojaDe(conta.id),
            deposito: depDe(d),
            registrosEmOutroLugar: temOutros,
            soNaFormaDobrada: dobrada,
          },
        });
      }
    }
    const semRegistroNoDeposito = comOutros + semNenhum;
    const share = d === null ? null : fracao(semRegistroNoDeposito, base);
    semRegistroResumo[lojaDe(conta.id)] = {
      deposito: depDe(d),
      depositoIlegivel: d === null,
      base,
      produtosAusentes,
      comIdDuplicado,
      comRegistro: d === null ? null : comRegistro,
      comRegistroCanonico: d === null ? null : comRegistroCanonico,
      comRegistroLegado: d === null ? null : comRegistro - comRegistroCanonico,
      estoqueAmbiguo: d === null ? null : ambiguo,
      semRegistroNoDeposito: d === null ? null : semRegistroNoDeposito,
      semRegistroComRegistrosEmOutroLugar: d === null ? null : comOutros,
      semNenhumRegistro: d === null ? null : semNenhum,
      soNaFormaDobrada: d === null ? null : soDobrada,
      fracaoSemRegistro: share,
      limite: LIMITE_SEM_REGISTRO,
      acimaDoLimite: share === null ? null : share > LIMITE_SEM_REGISTRO,
      kitsRestritos,
      kitsComComponenteSemRegistro: d === null ? null : kitsComFaltante,
      kitsComComponenteAmbiguo: d === null ? null : kitsComAmbiguo,
      kitsSemNenhumComponenteNoDeposito: d === null ? null : kitsSemNenhum,
    };
  }

  /* -- (7) duplicates, parentId, ref forms -------------------------------- */
  const relevantesEm = (d: string): Set<string> =>
    new Set([...(vinculadosEm.get(d) ?? []), ...(componentesEm.get(d) ?? [])]);
  const relevantes = new Map(depositosLi.map((d) => [d, relevantesEm(d)] as const));
  const duplicadosPorDeposito = new Map<
    string,
    {
      grupos: number;
      registros: number;
      comCanonico: number;
      semCanonico: number;
      ambiguosNaLeituraDoApp: number;
      gruposRelevantes: number;
      relevantesSemCanonico: number;
    }
  >();
  const parentIdTotal = parentIdZerado();
  const parentIdLi = parentIdZerado();
  let relevantesRegistros = 0;
  let relevantesSemParentId = 0;
  let relevantesDiverge = 0;
  let componentesRegistros = 0;
  let componentesSemParentId = 0;
  const formasPorDepositoLi = new Map<string, { canonica: number; nua: number; dobrada: number }>(
    depositosLi.map((d) => [d, { canonica: 0, nua: 0, dobrada: 0 }]),
  );
  const semParent = (c: ClasseDoParentId): boolean =>
    c === 'ausente' || c === 'nulo' || c === 'vazio' || c === 'outro-tipo';

  for (const produtoId of [...registrosPorProduto.keys()].sort(comparar)) {
    const registros = registrosPorProduto.get(produtoId)!;
    const porDeposito = new Map<string, RegistroLido[]>();
    for (const r of registros) {
      parentIdTotal[r.parentId] += 1;
      if (r.depositoId === null) continue;
      const grupo = porDeposito.get(r.depositoId) ?? [];
      grupo.push(r);
      porDeposito.set(r.depositoId, grupo);
      const ehLi = relevantes.has(r.depositoId);
      if (!ehLi) continue;
      parentIdLi[r.parentId] += 1;
      const formas = formasPorDepositoLi.get(r.depositoId)!;
      if (r.forma === 'canonica' || r.forma === 'nua' || r.forma === 'dobrada')
        formas[r.forma] += 1;
      if (relevantes.get(r.depositoId)!.has(produtoId)) {
        relevantesRegistros += 1;
        if (semParent(r.parentId)) relevantesSemParentId += 1;
        if (r.parentId === 'diverge') relevantesDiverge += 1;
        if (r.parentId !== 'ok') {
          achados.push({
            caminho: r.caminho,
            classe: 'estoque-sem-parentid',
            valor: { deposito: depDe(r.depositoId), parentId: r.parentId },
          });
        }
      }
      if (componentesEm.get(r.depositoId)!.has(produtoId)) {
        componentesRegistros += 1;
        if (semParent(r.parentId)) componentesSemParentId += 1;
      }
    }
    for (const [d, grupo] of porDeposito) {
      if (grupo.length < 2) continue;
      const pseudo = depDe(d) ?? '?';
      const acc = duplicadosPorDeposito.get(pseudo) ?? {
        grupos: 0,
        registros: 0,
        comCanonico: 0,
        semCanonico: 0,
        ambiguosNaLeituraDoApp: 0,
        gruposRelevantes: 0,
        relevantesSemCanonico: 0,
      };
      const canonico = makeEstoqueUid(produtoId, d);
      const temCanonico = grupo.some((r) => r.estoqueId === canonico);
      const exatos = grupo.filter((r) => exata(r.forma));
      acc.grupos += 1;
      acc.registros += grupo.length;
      if (temCanonico) acc.comCanonico += 1;
      else acc.semCanonico += 1;
      if (exatos.length > 1 && !exatos.some((r) => r.estoqueId === canonico)) {
        acc.ambiguosNaLeituraDoApp += 1;
      }
      const relevante = relevantes.get(d)?.has(produtoId) ?? false;
      if (relevante) {
        acc.gruposRelevantes += 1;
        if (!temCanonico) acc.relevantesSemCanonico += 1;
        achados.push({
          caminho: `produtos/${produtoId}`,
          classe: 'estoque-duplicado',
          valor: {
            deposito: pseudo,
            registros: grupo.map((r) => r.estoqueId).sort(comparar),
            canonico: temCanonico,
          },
        });
      }
      duplicadosPorDeposito.set(pseudo, acc);
    }
  }
  const duplicadosResumo = {
    depositos: Object.fromEntries([...duplicadosPorDeposito].sort((a, b) => comparar(a[0], b[0]))),
    total: [...duplicadosPorDeposito.values()].reduce(
      (t, a) => ({
        grupos: t.grupos + a.grupos,
        comCanonico: t.comCanonico + a.comCanonico,
        semCanonico: t.semCanonico + a.semCanonico,
      }),
      { grupos: 0, comCanonico: 0, semCanonico: 0 },
    ),
  };
  const semParentIdResumo = {
    corpus: parentIdTotal,
    depositosLi: parentIdLi,
    relevantes: {
      registros: relevantesRegistros,
      semParentId: relevantesSemParentId,
      parentIdDiverge: relevantesDiverge,
    },
    componentesRestritivos: {
      registros: componentesRegistros,
      semParentId: componentesSemParentId,
    },
  };
  const formasResumo = {
    corpus: formasCorpus,
    caminhoInesperado: estoqueCaminhoInesperado,
    depositosLi: Object.fromEntries(
      depositosLi.map((d) => [depDe(d) ?? '?', formasPorDepositoLi.get(d)!] as const),
    ),
  };

  /* -- (2) writes per day at each Loja Integrada depósito ----------------- */
  const escritasResumo: Record<string, unknown> = {};
  const razao = entrada.razao;
  for (const d of depositosLi) {
    const porDia = new Map<
      string,
      { vinculado: number; componente: number; outro: number; linhasDaRazao: number }
    >();
    for (const dia of janela.dias) {
      porDia.set(dia, { vinculado: 0, componente: 0, outro: 0, linhasDaRazao: 0 });
    }
    let noFuturo = 0;
    let semCarimbo = 0;
    let naJanela = 0;
    let dobradosNaJanela = 0;
    let semLinha = 0;
    let linhasFuturo = 0;
    let linhasInvalidas = 0;
    for (const produtoId of [...registrosPorProduto.keys()].sort(comparar)) {
      for (const r of registrosPorProduto.get(produtoId)!) {
        if (r.depositoId !== d) continue;
        const balde = baldeDoCarimbo(r.carimbo, janela);
        if (!exata(r.forma)) {
          if (balde.tipo === 'dia' || balde.tipo === 'futuro') dobradosNaJanela += 1;
          continue;
        }
        if (balde.tipo === 'invalido') {
          semCarimbo += 1;
          continue;
        }
        if (balde.tipo === 'antes') continue;
        naJanela += 1;
        if (balde.tipo === 'futuro') noFuturo += 1;
        else {
          const linha = porDia.get(balde.dia)!;
          if (vinculadosEm.get(d)!.has(produtoId)) linha.vinculado += 1;
          else if (componentesEm.get(d)!.has(produtoId)) linha.componente += 1;
          else linha.outro += 1;
        }
        if (razao === null) continue;
        const linhas = razao.get(r.caminho) ?? [];
        if (linhas.length === 0) semLinha += 1;
        for (const ts of linhas) {
          const b = baldeDoCarimbo(ts, janela);
          if (b.tipo === 'dia') porDia.get(b.dia)!.linhasDaRazao += 1;
          else if (b.tipo === 'futuro') linhasFuturo += 1;
          else if (b.tipo === 'invalido') {
            linhasInvalidas += 1;
            ignorar(r.caminho, 'historicoEstoque.timestamp', ts, 'razao-carimbo-invalido');
          }
        }
      }
    }
    const dias: Record<string, unknown> = {};
    let maxRegistros = 0;
    let maxLinhas = 0;
    let somaRegistros = 0;
    let somaLinhas = 0;
    for (const [dia, l] of porDia) {
      const total = l.vinculado + l.componente + l.outro;
      somaRegistros += total;
      somaLinhas += l.linhasDaRazao;
      maxRegistros = Math.max(maxRegistros, total);
      maxLinhas = Math.max(maxLinhas, l.linhasDaRazao);
      dias[dia] = {
        registros: { vinculado: l.vinculado, componente: l.componente, outro: l.outro, total },
        linhasDaRazao: razao === null ? null : l.linhasDaRazao,
      };
    }
    escritasResumo[depDe(d) ?? '?'] = {
      lojas: contasOrdenadas
        .filter((c) => depositoDaConta.get(c.id) === d)
        .map((c) => lojaDe(c.id)),
      dias,
      registrosNaJanela: naJanela,
      registrosNoFuturo: noFuturo,
      registrosSemCarimboNumerico: semCarimbo,
      registrosDobradosNaJanela: dobradosNaJanela,
      registrosSemLinhaNaRazao: razao === null ? null : semLinha,
      linhasDaRazaoNoFuturo: razao === null ? null : linhasFuturo,
      linhasDaRazaoInvalidas: razao === null ? null : linhasInvalidas,
      mediaDiaria: {
        registros: somaRegistros / janela.dias.length,
        linhasDaRazao: razao === null ? null : somaLinhas / janela.dias.length,
      },
      maximoDiario: { registros: maxRegistros, linhasDaRazao: razao === null ? null : maxLinhas },
    };
  }

  /* -- (5) produtos touched per day --------------------------------------- */
  const vinculadosLi = new Set<string>();
  const paisLi = new Set<string>();
  for (const v of vereditos.values()) {
    for (const p of v.vinculados.keys()) vinculadosLi.add(p);
    for (const p of v.pais) paisLi.add(p);
  }
  const tocadosPorDia = new Map<string, { total: number; vinculadosLi: number; paisLi: number }>(
    janela.dias.map((dia) => [dia, { total: 0, vinculadosLi: 0, paisLi: 0 }]),
  );
  const tocadosPorLoja = new Map<string, { vinculados: number; pais: number }>(
    contasOrdenadas.map((c) => [c.id, { vinculados: 0, pais: 0 }]),
  );
  let tocadosTotal = 0;
  let tocadosFuturo = 0;
  let tocadosInvalidos = 0;
  let tocadosForaDaJanela = 0;
  let tocadosVinculados = 0;
  let tocadosPais = 0;
  const vistos = new Set<string>();
  for (const t of entrada.produtosTocados) {
    if (vistos.has(t.id)) continue;
    vistos.add(t.id);
    const balde = baldeDoCarimbo(t.ultimaModificacao, janela);
    if (balde.tipo === 'invalido') {
      tocadosInvalidos += 1;
      ignorar(
        `produtos/${t.id}`,
        'ultimaModificacao',
        t.ultimaModificacao ?? null,
        'produto-tocado-carimbo-invalido',
      );
      continue;
    }
    if (balde.tipo === 'antes') {
      tocadosForaDaJanela += 1;
      continue;
    }
    tocadosTotal += 1;
    const ehVinculado = vinculadosLi.has(t.id);
    const ehPai = paisLi.has(t.id);
    if (ehVinculado) tocadosVinculados += 1;
    if (ehPai) tocadosPais += 1;
    if (balde.tipo === 'futuro') tocadosFuturo += 1;
    else {
      const linha = tocadosPorDia.get(balde.dia)!;
      linha.total += 1;
      if (ehVinculado) linha.vinculadosLi += 1;
      if (ehPai) linha.paisLi += 1;
    }
    for (const conta of contasOrdenadas) {
      const v = vereditos.get(conta.id)!;
      const acc = tocadosPorLoja.get(conta.id)!;
      if (v.vinculados.has(t.id)) acc.vinculados += 1;
      if (v.pais.has(t.id)) acc.pais += 1;
    }
  }
  const semCarimboPorLoja: Record<string, number> = {};
  for (const conta of contasOrdenadas) {
    let n = 0;
    for (const produtoId of vereditos.get(conta.id)!.vinculados.keys()) {
      const lido = entrada.produtos.get(produtoId);
      if (lido === undefined || !lido.existe) continue;
      const carimbo = proprio(lido.dados, 'ultimaModificacao');
      if (typeof carimbo !== 'number' || !Number.isSafeInteger(carimbo)) n += 1;
    }
    semCarimboPorLoja[lojaDe(conta.id)] = n;
  }
  const tocadosResumo = {
    total: tocadosTotal,
    noFuturo: tocadosFuturo,
    carimboInvalido: tocadosInvalidos,
    foraDaJanela: tocadosForaDaJanela,
    vinculadosLi: tocadosVinculados,
    paisLi: tocadosPais,
    fracaoVinculadosLi: fracao(tocadosVinculados, tocadosTotal),
    mediaDiaria: tocadosTotal / janela.dias.length,
    porDia: Object.fromEntries(tocadosPorDia),
    lojas: Object.fromEntries(
      contasOrdenadas.map((c) => [lojaDe(c.id), tocadosPorLoja.get(c.id)!] as const),
    ),
    vinculadosSemCarimboNumerico: semCarimboPorLoja,
  };

  /* -- Skipped shapes, by count ------------------------------------------- */
  const porMotivo = new Map<string, number>();
  for (const i of ignorados) incrementar(porMotivo, i.motivo);
  const ignoradosResumo = Object.fromEntries([...porMotivo].sort((a, b) => comparar(a[0], b[0])));

  /* -- Reads -------------------------------------------------------------- */
  let estimativa = 0;
  for (const perna of Object.values(entrada.leituras)) {
    estimativa += perna.documentos + perna.consultasVazias;
  }

  const resumo: Resumo = {
    contagem: NOME_DA_CONTAGEM,
    versao: 1,
    geradoEm: new Date(entrada.agoraMs).toISOString(),
    fuso: FUSO_FISCAL,
    dias: entrada.dias,
    janela: { de: janela.dias[0]!, ate: janela.dias[janela.dias.length - 1]! },
    medida:
      'Every per-day figure is a LOWER bound: a record or produto counts once, on the civil day ' +
      'of its LAST ultimaModificacao; a non-numeric stamp is invisible (counted apart). ' +
      'linhasDaRazao (ledger rows) is the closer measure of stock writes.',
    contas: contasResumo,
    vinculos: { lojas: vinculosResumo, ...globais },
    kits: {
      lojas: kitsResumo,
      combinado: { F: histogramaF(fCombinado), FSeTodosLimitarem: histogramaF(fTodosCombinado) },
    },
    escritasPorDia: { razaoDisponivel: razao !== null, depositos: escritasResumo },
    produtosTocados: tocadosResumo,
    semRegistro: { lojas: semRegistroResumo },
    duplicados: duplicadosResumo,
    semParentId: semParentIdResumo,
    formasDoDeposito: formasResumo,
    ignorados: ignoradosResumo,
    leituras: { porPerna: entrada.leituras, estimativaDeLeiturasCobradas: estimativa },
  };
  // Two runs over the same data write the same rows, whatever order the reads returned.
  const chaveDoValor = (v: unknown): string => JSON.stringify(v) ?? '';
  achados.sort(
    (a, b) =>
      comparar(a.classe, b.classe) ||
      comparar(a.caminho, b.caminho) ||
      comparar(chaveDoValor(a.valor), chaveDoValor(b.valor)),
  );
  ignorados.sort(
    (a, b) =>
      comparar(a.motivo, b.motivo) ||
      comparar(a.caminho, b.caminho) ||
      comparar(a.campo, b.campo) ||
      comparar(chaveDoValor(a.valor), chaveDoValor(b.valor)),
  );
  return { resumo, achados, ignorados };
}
