/**
 * The PURE decisions of the Loja Integrada stock sync (master plan step 12, PR 12-c). No clock,
 * no network, no Firestore, no environment read: every input is a value the caller read, and the
 * configured cap arrives as a parameter (an entry point reads `LOJA_INTEGRADA_ESTOQUE_MAX`).
 * Nothing here decides WHAT number is sent beyond model A; S is `quantidadeEstoqueLi.ts`'s.
 *
 * ## What is decided here
 *
 *  1. **The send** ({@link decidirEnvioEstoqueLi}), after the deciding GET: model A's target,
 *     the "reflected" rule ({@link refletidoLi}: all four fields, exactly), or a refusal when the
 *     store's reservation cannot be read.
 *  2. **The trigger's relevance** ({@link relevanciaEventoEstoqueLi}), from the event payload
 *     alone: whether a stock-record write can move ANY store quantity (then the trigger pays its
 *     reads), and whether it can move the produto's OWN one (then it enqueues the direct task).
 *  3. **The run's plan** ({@link planoEstoqueLi}): which of the nine outcomes a child produto of a
 *     conta is in — skip reasons first, S last.
 *  4. **Kits** with at most 30 store kits per component ({@link kitsSinalizadosLi}): the
 *     tie-inclusive, fail-open filter, and the zero-cost skip ({@link irmaosParaLerLi}).
 *  5. **Kits** beyond 30 ({@link disparaKitsZeradosLi}, {@link cruzaParaZeroLi}): only a kit
 *     going from positive to 0 is sent at once; everything else waits for the nightly reconcile.
 *  6. **The reconcile's diff** of one store row against the snapshot ({@link diffLinhaEstoqueLi})
 *     and the order the candidates are enqueued in ({@link ordenarCandidatosEstoqueLi}).
 *
 * ## The cap
 *
 * Every function that takes `cap` applies it to S itself — at diff and send time, never stored —
 * and refuses (`RangeError`) anything but `+∞` (no cap) or a positive safe integer. Never `0`:
 * zero is a legal quantity, so a `0` cap would zero every row it touched and nothing would flag it.
 *
 * ## The kit filter, and why ties count
 *
 * With τ_c = ⌊available_c / q_c⌋ for each constraining component c of kit K (its quantity in the
 * kit q_c, the RAW available — fractional quantities divide unrounded, as the core does), the
 * trigger handling an event of component p flags K iff
 *
 *     min(τ_p(before), τ_p(after)) ≤ min(min over c ≠ p of τ_c(now), cap)
 *
 * and a sibling it cannot read (no record id in the map, the record gone, at another depósito, or
 * unreadable) flags K too: a stale map never hides a change.
 *
 * ⚠️ "K changed" — min(τ_p(before), m) ≠ min(τ_p(after), m) — is UNSOUND. A kit sale moves every
 * component in ONE commit: blank and print both go 5 → 4, so each event sees the other already
 * at 4, computes 4 → 4, and both skip, while the kit went 5 → 4. The tie rule flags both.
 *
 * Why the rule never loses a change (pinned by a property test over random interleavings): take
 * the last kit task to run and suppose the final K differs from what it read. Every event of a
 * later commit went unflagged. If K fell to V, the minimiser's last event ends at V; unflagged, it
 * saw a sibling strictly below it, which must rise later, through an unflagged event that saw a
 * sibling strictly lower still — an infinite chain of later commits. If K rose, the symmetric
 * chain starts from the old minimiser's first later event. The cap is a constant pseudo-component.
 *
 * ## Fail open
 *
 * Wherever a value cannot be read, the cheap direction is taken: an unreadable stock record is
 * relevant, an unknown sibling flags, an unreadable kit quantity fires. One wasted run costs one
 * store read; a hidden change is a stale number on the storefront until the next reconcile.
 */
import {
  type CandidatoReconcileEstoqueLi,
  type EntradaSnapshotEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  type FlagEntradaEstoqueLi,
  type KitsComponenteEstoqueLi,
  contaDoLinkLi,
  estoqueDisponivel,
  inteiroPositivoCanonicoLi,
  kitEstoqueDisponivel,
  makeEstoqueUid,
  vinculoLiConta,
} from '@delfrance/schemas';
import { kitNaoVerificavel } from '@delfrance/data/admin/estoque';

import {
  type CorpoEstoqueLi,
  type DocEstoqueLi,
  type ProdutoEstoqueLi,
  caminhoEstoqueLi,
  corpoEstoqueLi,
  membroEstoqueLi,
  quantidadeEstoqueLi,
} from './quantidadeEstoqueLi';

/* -------------------------------------------------------------------------- */
/*                                  Readers                                    */
/* -------------------------------------------------------------------------- */

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Readonly<Record<string, unknown>>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/** A kit quantity or a header's `qMax`: positive and finite. */
function quantidadeDeKit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * The cap, validated: `+∞` (none) or a positive safe integer. Throws `RangeError` otherwise —
 * it is configuration read at an entry point, so a bad one is a bug there, never data.
 */
function tetoValido(cap: number): number {
  if (cap === Number.POSITIVE_INFINITY || (Number.isSafeInteger(cap) && cap > 0)) return cap;
  throw new RangeError('teto de estoque inválido: +∞ ou um inteiro positivo, nunca 0');
}

/* -------------------------------------------------------------------------- */
/*                     1. The send, after the deciding GET                     */
/* -------------------------------------------------------------------------- */

/**
 * One store stock row as the plan reads it — structural, every field `unknown`, compared
 * EXACTLY (a `'5'` is not `5`). `quantidade_disponivel` is declared only to say it is never read:
 * the reservation is `quantidade_reservada`, and the store's derived figure is not an input.
 */
export interface EstoqueNaLojaLi {
  readonly gerenciado?: unknown;
  readonly quantidade?: unknown;
  readonly quantidade_reservada?: unknown;
  /** Never read (module header of `quantidadeEstoqueLi.ts`). */
  readonly quantidade_disponivel?: unknown;
  readonly situacao_em_estoque?: unknown;
  readonly situacao_sem_estoque?: unknown;
}

/**
 * The store row already shows the body that would be sent for `quantidade`: ALL FOUR fields
 * exactly — `gerenciado === true`, `quantidade === quantidade`, `situacao_em_estoque === 0`,
 * `situacao_sem_estoque === -1`. Any one off is a write: an unmanaged row reads back as all
 * zeros (`spec tag Estoque`), so a `gerenciado: false` row at quantity 0 is NOT a reflected 0.
 */
export function refletidoLi(linha: EstoqueNaLojaLi, quantidade: number): boolean {
  return (
    linha.gerenciado === true &&
    linha.quantidade === quantidade &&
    linha.situacao_em_estoque === 0 &&
    linha.situacao_sem_estoque === -1
  );
}

/** What one send run does once it holds S and the store's row. */
export type DecisaoEnvioEstoqueLi =
  /** The row's `quantidade_reservada` is not a safe integer: nothing is sent. */
  | { readonly tipo: 'recusa'; readonly motivo: 'reserva-ilegivel' }
  /** The row already shows the target body: nothing is sent. */
  | { readonly tipo: 'refletido'; readonly quantidade: number }
  /** PUT this body. */
  | { readonly tipo: 'escrever'; readonly corpo: CorpoEstoqueLi };

/**
 * Model A on the deciding GET's row: the target is `min(S, cap) + max(0, quantidade_reservada)`
 * ({@link corpoEstoqueLi}); a row that already shows it ({@link refletidoLi}) is left alone, a
 * row whose reservation cannot be read is refused, and anything else gets the four-field body.
 *
 * Throws `RangeError` on an S that is not a non-negative safe integer or a bad cap (both ours).
 */
export function decidirEnvioEstoqueLi(args: {
  readonly S: number;
  readonly cap: number;
  readonly linha: EstoqueNaLojaLi;
}): DecisaoEnvioEstoqueLi {
  const S = Math.min(args.S, tetoValido(args.cap));
  const corpo = corpoEstoqueLi(S, args.linha.quantidade_reservada);
  if (corpo === null) return { tipo: 'recusa', motivo: 'reserva-ilegivel' };
  if (refletidoLi(args.linha, corpo.quantidade)) {
    return { tipo: 'refletido', quantidade: corpo.quantidade };
  }
  return { tipo: 'escrever', corpo };
}

/* -------------------------------------------------------------------------- */
/*                       2. The trigger's relevance gate                       */
/* -------------------------------------------------------------------------- */

/** A stock record's raw data as the event payload carries it. */
export type DadosEstoqueLi = Readonly<Record<string, unknown>>;

/** What an ERP stock-record write means to the sync. */
export interface RelevanciaEventoEstoqueLi {
  /** It can move some store quantity (the produto's own, or a kit's): worth the trigger's reads. */
  readonly relevante: boolean;
  /** It can move the produto's OWN published quantity: the direct task. Implies `relevante`. */
  readonly direta: boolean;
}

const IRRELEVANTE: RelevanciaEventoEstoqueLi = { relevante: false, direta: false };
const DIRETA: RelevanciaEventoEstoqueLi = { relevante: true, direta: true };

/**
 * A counter as the schema defaults it: absent or `null` ⇒ 0; a finite number ⇒ itself;
 * anything else ⇒ `NaN` (unreadable).
 */
function contador(v: unknown): number {
  if (v === undefined || v === null) return 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
}

/** The record's available quantity (`estoqueDisponivel`, the repo's one derivation), or `NaN`. */
function disponivelDoRegistro(dados: DadosEstoqueLi): number {
  const quantidade = contador(proprio(dados, 'quantidade'));
  const quantidadeReservada = contador(proprio(dados, 'quantidadeReservada'));
  if (Number.isNaN(quantidade) || Number.isNaN(quantidadeReservada)) return Number.NaN;
  return estoqueDisponivel({ quantidade, quantidadeReservada });
}

/** Two `depositoOuterRef` values are the same only when they are the same primitive. */
function mesmoDeposito(a: unknown, b: unknown): boolean {
  return a === b && (a === null || typeof a !== 'object');
}

/** What a produto's own available quantity publishes: floored, clamped to 0..cap. */
function publicado(disponivel: number, cap: number): number {
  return Math.min(Math.max(Math.floor(disponivel), 0), cap);
}

/**
 * The trigger's first gate, from the event payload ALONE (0 reads). `antes` / `depois` are the
 * record's data before and after the write, `null` on the side where it did not exist.
 *
 * Relevant: a create, a delete, a `depositoOuterRef` change (any spelling change too), an
 * unreadable counter on either side (fail open), or a change of the available quantity. Direct,
 * in addition: a create, a delete, a depósito change, an unreadable counter, or a change of what
 * the produto's own quantity PUBLISHES — ⌊available⌋ clamped to 0..cap — so −3 → −2 is relevant
 * (a component's quotient may move) but sends nothing of its own, while 0 → 1 does.
 *
 * Irrelevant: a write that moves no counter — a `localizacao` edit, the kit stamp (an
 * `ultimaModificacao`-only update) and the paid → shipped pair, which lowers `quantidade` and
 * `quantidadeReservada` by the same k and leaves the available quantity where it was.
 */
export function relevanciaEventoEstoqueLi(args: {
  readonly antes: DadosEstoqueLi | null;
  readonly depois: DadosEstoqueLi | null;
  readonly cap: number;
}): RelevanciaEventoEstoqueLi {
  const cap = tetoValido(args.cap);
  const { antes, depois } = args;
  if (antes === null && depois === null) return IRRELEVANTE;
  if (antes === null || depois === null) return DIRETA;
  if (!mesmoDeposito(proprio(antes, 'depositoOuterRef'), proprio(depois, 'depositoOuterRef'))) {
    return DIRETA;
  }
  const dAntes = disponivelDoRegistro(antes);
  const dDepois = disponivelDoRegistro(depois);
  if (Number.isNaN(dAntes) || Number.isNaN(dDepois)) return DIRETA;
  if (dAntes === dDepois) return IRRELEVANTE;
  return { relevante: true, direta: publicado(dAntes, cap) !== publicado(dDepois, cap) };
}

/* -------------------------------------------------------------------------- */
/*                              3. The run's plan                              */
/* -------------------------------------------------------------------------- */

/** The produto's own stock records at the conta's depósito, resolved to at most one. */
export type EstoqueNoDepositoLi =
  | { readonly tipo: 'nenhum' }
  | { readonly tipo: 'um'; readonly registro: DocEstoqueLi }
  /** Two or more, none of them the canonical id: which one to read is not ours to guess. */
  | { readonly tipo: 'ambiguo' };

/**
 * One produto's records at the conta's depósito (the caller's query already filtered the
 * depósito) → the one to read: none; the only one; the canonical `est-<produto>-<depósito>`
 * (`makeEstoqueUid`) among several, since a legacy auto-id record may sit beside it; else
 * `ambiguo`. The same path read twice counts once.
 *
 * Throws `RangeError` on a path that does not parse or a record of another produto (a bug).
 */
export function estoqueNoDepositoLi(args: {
  readonly produtoId: string;
  readonly depositoId: string;
  readonly registros: readonly DocEstoqueLi[];
}): EstoqueNoDepositoLi {
  const porId = new Map<string, DocEstoqueLi>();
  for (const registro of args.registros) {
    const partes = caminhoEstoqueLi(registro.caminho);
    if (partes === null || partes.produtoId !== args.produtoId) {
      throw new RangeError('estoqueNoDepositoLi: registro de outro produto ou caminho inválido');
    }
    porId.set(partes.estoqueId, registro);
  }
  const unicos = [...porId.values()];
  const [primeiro] = unicos;
  if (primeiro === undefined) return { tipo: 'nenhum' };
  if (unicos.length === 1) return { tipo: 'um', registro: primeiro };
  const canonico = porId.get(makeEstoqueUid(args.produtoId, args.depositoId));
  return canonico === undefined ? { tipo: 'ambiguo' } : { tipo: 'um', registro: canonico };
}

/**
 * A kit whose quantity comes from its components: `ehKit` or `ehKitVirtual` (the core's own
 * branch), with at least one component that constrains it — exactly when the shared kit minimum
 * is not `null`. Its own stock record never feeds its quantity (the channel pins
 * `incluirEstoqueProprioDoKit` off), so the never-had-stock hold and an ambiguous own record do
 * not apply to it. A kit NO component constrains falls back to its own record, like a non-kit.
 */
export function kitRestritoLi(produto: ProdutoEstoqueLi): boolean {
  if (produto.ehKit !== true && produto.ehKitVirtual !== true) return false;
  return kitEstoqueDisponivel(produto.componentesKit, {}) !== null;
}

/**
 * The parity skip: the CHILD's own entry `statusProdutosMarketplace['<contaId>_<idLi>']` holds
 * `enviarEstoque` exactly `false`. A `'false'` text, an absent field, `true`, another conta's or
 * another store id's entry, or an inherited key all SEND.
 */
export function envioDeEstoqueDesligadoLi(
  statusProdutosMarketplace: unknown,
  contaId: string,
  idLi: string,
): boolean {
  if (!ehObjeto(statusProdutosMarketplace)) return false;
  const entrada = proprio(statusProdutosMarketplace, `${contaId}_${idLi}`);
  return ehObjeto(entrada) && proprio(entrada, 'enviarEstoque') === false;
}

/** Everything the plan of one (conta, produto) needs, read by the caller. */
export interface EntradaPlanoEstoqueLi {
  readonly contaId: string;
  readonly produtoId: string;
  readonly produto: ProdutoEstoqueLi;
  /** The produto's OWN `produtolojaintegrada` documents, raw, every conta's. */
  readonly links: readonly unknown[];
  /** Its own record at the conta's depósito ({@link estoqueNoDepositoLi}). */
  readonly estoque: EstoqueNoDepositoLi;
  /** One record per kit component at the same depósito (none for a non-kit). */
  readonly componentes: readonly DocEstoqueLi[];
  /** The task came from that record's DELETE: proof a record existed. */
  readonly apagado: boolean;
  /**
   * Whether the produto has a stock record at ANY depósito, or `null` when not read. Read only
   * when the plan answers `consultar-estoques` (one where-less listing, limit 1).
   */
  readonly temEstoqueEmQualquerDeposito: boolean | null;
  /** The duplicate-link probe found this store id linked from another ERP produto. */
  readonly duplicado: boolean;
}

/** The plan of one (conta, child produto). */
export type PlanoEstoqueLi =
  /** No counting link of the conta on this produto. */
  | { readonly tipo: 'sem-vinculo' }
  /** Only parent links (a root with grades): a parent's row is never sent. */
  | { readonly tipo: 'pai' }
  /** A root link with no grades (a simple store product): unsupported by this step. */
  | { readonly tipo: 'nao-suportado' }
  /** Two store products of the conta linked to this produto. */
  | { readonly tipo: 'vinculo-ambiguo' }
  /** This store product is also linked from another ERP produto: neither is sent. */
  | { readonly tipo: 'vinculo-duplicado'; readonly idLi: string }
  /** The parity skip ({@link envioDeEstoqueDesligadoLi}). */
  | { readonly tipo: 'paridade'; readonly idLi: string }
  /** The hold hinges on a read not made yet: list one record at any depósito, then plan again. */
  | { readonly tipo: 'consultar-estoques'; readonly idLi: string }
  /** The produto never had an ERP stock record anywhere: the store keeps its own number. */
  | { readonly tipo: 'retido'; readonly idLi: string }
  /** Two non-canonical records at the depósito ({@link estoqueNoDepositoLi}). */
  | { readonly tipo: 'estoque-ambiguo'; readonly idLi: string }
  /** Send S, uncapped (the caller caps); `kitNaoVerificavel`: a kit none of whose constraining
   * components resolved, so S is the safe 0 and the caller logs a warning. */
  | {
      readonly tipo: 'enviar';
      readonly idLi: string;
      readonly S: number;
      readonly kitNaoVerificavel: boolean;
    };

/** A parent link: a root whose `grades` is a non-empty list. */
function ehLinkPai(link: Readonly<Record<string, unknown>>): boolean {
  const grades = proprio(link, 'grades');
  return Array.isArray(grades) && grades.length > 0;
}

/**
 * The run's plan for one CHILD produto of one conta, in this order, the first match winning:
 *
 *  1. no counting link of the conta (`contaDoLinkLi` + `vinculoLiConta`, the anchor's readers)
 *     ⇒ `sem-vinculo`;
 *  2. no counting CHILD link (`paiProdutoIntegradaId` set): only parent roots ⇒ `pai`, any root
 *     without grades ⇒ `nao-suportado`;
 *  3. child links naming two store ids ⇒ `vinculo-ambiguo` (two documents of ONE id are one
 *     store product);
 *  4. `duplicado` ⇒ `vinculo-duplicado`;
 *  5. the parity skip ⇒ `paridade`;
 *  6. when the produto's own record feeds S (not a constrained kit, {@link kitRestritoLi}): no
 *     record at the depósito, no delete as proof, and no record at ANY depósito ⇒ `retido` (the
 *     never-had-stock hold, read literally: a record elsewhere means the depósito's real 0 is
 *     pushed); that last fact unread ⇒ `consultar-estoques`; two non-canonical records ⇒
 *     `estoque-ambiguo`;
 *  7. otherwise `enviar` with S ({@link quantidadeEstoqueLi}).
 *
 * The store id is the child link's `id` through `inteiroPositivoCanonicoLi`, so a number and its
 * canonical text are one id (`3` and `'3'` ⇒ `'3'`); text the reader refuses (`'03'`) never
 * counted in the first place.
 *
 * ⚠️ The send run classifies with `duplicado: false` and pays the duplicate probe only when the
 * answer is `enviar`, then classifies again with what it found.
 */
export function planoEstoqueLi(entrada: EntradaPlanoEstoqueLi): PlanoEstoqueLi {
  const daConta = entrada.links
    .filter(ehObjeto)
    .filter((link) => contaDoLinkLi(link) === entrada.contaId && vinculoLiConta(link));
  if (daConta.length === 0) return { tipo: 'sem-vinculo' };

  const filhos = daConta.filter((link) => proprio(link, 'paiProdutoIntegradaId') != null);
  if (filhos.length === 0) {
    return daConta.every(ehLinkPai) ? { tipo: 'pai' } : { tipo: 'nao-suportado' };
  }
  const ids = new Set<string>();
  for (const link of filhos) {
    const id = inteiroPositivoCanonicoLi(proprio(link, 'id'));
    if (id !== null) ids.add(id);
  }
  const [idLi] = ids;
  // Unreachable: `vinculoLiConta` counts a link only when the same reader reads its id.
  if (idLi === undefined) return { tipo: 'sem-vinculo' };
  if (ids.size > 1) return { tipo: 'vinculo-ambiguo' };

  if (entrada.duplicado) return { tipo: 'vinculo-duplicado', idLi };
  if (envioDeEstoqueDesligadoLi(entrada.produto.statusProdutosMarketplace, entrada.contaId, idLi)) {
    return { tipo: 'paridade', idLi };
  }

  const usaEstoqueProprio = !kitRestritoLi(entrada.produto);
  if (usaEstoqueProprio && entrada.estoque.tipo === 'nenhum' && !entrada.apagado) {
    if (entrada.temEstoqueEmQualquerDeposito === null) return { tipo: 'consultar-estoques', idLi };
    if (!entrada.temEstoqueEmQualquerDeposito) return { tipo: 'retido', idLi };
  }
  if (usaEstoqueProprio && entrada.estoque.tipo === 'ambiguo') {
    return { tipo: 'estoque-ambiguo', idLi };
  }

  const membro = membroEstoqueLi({
    produtoId: entrada.produtoId,
    produto: entrada.produto,
    estoque: entrada.estoque.tipo === 'um' ? entrada.estoque.registro : null,
    componentes: entrada.componentes,
  });
  return {
    tipo: 'enviar',
    idLi,
    S: quantidadeEstoqueLi(membro),
    kitNaoVerificavel: kitNaoVerificavel(membro),
  };
}

/* -------------------------------------------------------------------------- */
/*                         4. Kits, at most 30 per component                   */
/* -------------------------------------------------------------------------- */

/**
 * A component's available quantity on one side of its event: the number, or `null` when the
 * record did not exist at the conta's depósito on that side (a create's before, a delete's
 * after) — which the kit minimum counts as 0 (#238). `NaN` (unreadable) fails open.
 */
export type DisponivelDoEventoLi = number | null;

/** One kit's components and their quantities, as the kits map stores it. */
export interface KitDoMapaLi {
  readonly q: Readonly<Record<string, number>>;
}

/** The header fields the eager filter reads. */
export type CabecalhoKitsLi = Pick<KitsComponenteEstoqueLi, 'qMax' | 'comps' | 'kits'>;

/**
 * The zero-cost skip: even the kit that needs the most of this component (`qMax`) keeps a
 * quotient above the cap on both sides, so no kit's published quantity can move and no sibling
 * needs reading. Never skips on an unreadable side.
 */
function dispensaIrmaos(
  antes: DisponivelDoEventoLi,
  depois: DisponivelDoEventoLi,
  qMax: number,
  cap: number,
): boolean {
  const menor = Math.min(antes ?? 0, depois ?? 0);
  if (!Number.isFinite(menor) || !quantidadeDeKit(qMax)) return false;
  return Math.floor(menor / qMax) > cap;
}

/**
 * The sibling stock records the eager filter must read for an event of `componenteId`: every
 * other component's record id in the header's `comps`, deduplicated, sorted — or NONE when the
 * zero-cost skip applies (⌊min(before, after) / qMax⌋ above the cap). A sibling with no record id
 * is not read: it flags its kits as unknown.
 */
export function irmaosParaLerLi(args: {
  readonly cabecalho: Pick<CabecalhoKitsLi, 'qMax' | 'comps'>;
  readonly componenteId: string;
  readonly antes: DisponivelDoEventoLi;
  readonly depois: DisponivelDoEventoLi;
  readonly cap: number;
}): string[] {
  const cap = tetoValido(args.cap);
  if (dispensaIrmaos(args.antes, args.depois, args.cabecalho.qMax, cap)) return [];
  const ids = new Set<string>();
  for (const [componente, estoqueId] of Object.entries(args.cabecalho.comps)) {
    if (componente !== args.componenteId && typeof estoqueId === 'string') ids.add(estoqueId);
  }
  return [...ids].sort();
}

/**
 * One kit, the tie-inclusive and fail-open rule (module header): flag iff
 * `min(τ_p(before), τ_p(after)) ≤ min(min over c ≠ p of τ_c(now), cap)`, with
 * τ = ⌊available / q⌋ over the RAW available. `disponivelDe(c)` answers a sibling's available
 * quantity NOW at the conta's depósito, or `undefined` when unknown — which flags, as does an
 * unreadable value, a kit quantity that is not positive and finite, or a kit that does not list
 * `componenteId` at all.
 */
export function kitSinalizadoLi(args: {
  readonly kit: KitDoMapaLi;
  readonly componenteId: string;
  readonly antes: DisponivelDoEventoLi;
  readonly depois: DisponivelDoEventoLi;
  readonly cap: number;
  readonly disponivelDe: (componenteId: string) => number | undefined;
}): boolean {
  const cap = tetoValido(args.cap);
  const qProprio = proprio(args.kit.q, args.componenteId);
  if (!quantidadeDeKit(qProprio)) return true;
  const antes = args.antes ?? 0;
  const depois = args.depois ?? 0;
  if (!Number.isFinite(antes) || !Number.isFinite(depois)) return true;
  const doComponente = Math.min(Math.floor(antes / qProprio), Math.floor(depois / qProprio));

  let limite = cap;
  for (const [componente, q] of Object.entries(args.kit.q)) {
    if (componente === args.componenteId) continue;
    const disponivel = args.disponivelDe(componente);
    if (!quantidadeDeKit(q) || disponivel === undefined || !Number.isFinite(disponivel)) {
      return true;
    }
    limite = Math.min(limite, Math.floor(disponivel / q));
  }
  return doComponente <= limite;
}

/**
 * The eager fan-out of one component's header (kits inline, F ≤ 30): the kit produto ids to
 * enqueue, sorted. `leituras` maps a sibling's stock record id (from {@link irmaosParaLerLi}) to
 * its available quantity NOW at the conta's depósito; a record not found, at another depósito or
 * unreadable is simply absent, and its kits flag. Nothing when the zero-cost skip applies.
 *
 * Throws `RangeError` for a header whose kits live in shards (`kits: null`): that component takes
 * the zero-crossing path ({@link disparaKitsZeradosLi}), never this one.
 */
export function kitsSinalizadosLi(args: {
  readonly cabecalho: CabecalhoKitsLi;
  readonly componenteId: string;
  readonly antes: DisponivelDoEventoLi;
  readonly depois: DisponivelDoEventoLi;
  readonly cap: number;
  readonly leituras: ReadonlyMap<string, number>;
}): string[] {
  const cap = tetoValido(args.cap);
  const { kits, comps, qMax } = args.cabecalho;
  if (kits === null) {
    throw new RangeError('kitsSinalizadosLi: os kits deste componente estão em fatias');
  }
  if (dispensaIrmaos(args.antes, args.depois, qMax, cap)) return [];
  const disponivelDe = (componente: string): number | undefined => {
    const estoqueId = proprio(comps, componente);
    return typeof estoqueId === 'string' ? args.leituras.get(estoqueId) : undefined;
  };
  return Object.entries(kits)
    .filter(([, kit]) =>
      kitSinalizadoLi({
        kit,
        componenteId: args.componenteId,
        antes: args.antes,
        depois: args.depois,
        cap,
        disponivelDe,
      }),
    )
    .map(([kitId]) => kitId)
    .sort();
}

/* -------------------------------------------------------------------------- */
/*                       5. Kits beyond 30: the zero-crossing                  */
/* -------------------------------------------------------------------------- */

/**
 * ONE kit's quotient for this component goes from positive to 0: ⌊before / q⌋ > 0 and
 * ⌊after / q⌋ ≤ 0 (a negative available publishes 0 as well). That is the only change of such a
 * kit sent at once; 0 → positive and every positive → positive change wait for the nightly
 * reconcile. An unreadable side or kit quantity fires (fail open: over-advertising is the
 * direction that cannot wait).
 */
export function cruzaParaZeroLi(
  antes: DisponivelDoEventoLi,
  depois: DisponivelDoEventoLi,
  q: number,
): boolean {
  const a = antes ?? 0;
  const d = depois ?? 0;
  if (!quantidadeDeKit(q) || !Number.isFinite(a) || !Number.isFinite(d)) return true;
  return Math.floor(a / q) > 0 && Math.floor(d / q) <= 0;
}

/**
 * The trigger's decision for a component with MORE than 30 store kits, from its header alone
 * (the per-kit quantities live in the shards): fire the ONE `estoque-kits` fan-out iff some kit
 * with a quantity in (0, qMax] can cross to 0 ({@link cruzaParaZeroLi}) — i.e. before > 0,
 * after < before and after < qMax. A superset of the per-kit rule (a component going 3 → 1 fires
 * for a kit that needs 2 even though the component itself still shows 1); the fan-out task then
 * picks the kits from the map. Fails open like the per-kit rule.
 */
export function disparaKitsZeradosLi(args: {
  readonly antes: DisponivelDoEventoLi;
  readonly depois: DisponivelDoEventoLi;
  readonly qMax: number;
}): boolean {
  const a = args.antes ?? 0;
  const d = args.depois ?? 0;
  if (!quantidadeDeKit(args.qMax) || !Number.isFinite(a) || !Number.isFinite(d)) return true;
  return a > 0 && d < a && d < args.qMax;
}

/* -------------------------------------------------------------------------- */
/*                         6. The reconcile's diff                             */
/* -------------------------------------------------------------------------- */

/**
 * The `delta` of a row whose store keeps selling past its quantity — unmanaged
 * (`gerenciado` not `true`), or still purchasable at zero (`situacao_sem_estoque` not `-1`) —
 * or whose quantity cannot be read: unbounded over-advertising, so it sorts first.
 */
export const DELTA_SEM_LIMITE_LI = Number.MAX_SAFE_INTEGER;

/** One store row against the snapshot. */
export type DiffLinhaEstoqueLi =
  /** No snapshot entry: the reconcile looks the store id up among the links. */
  | { readonly tipo: 'sem-entrada' }
  /** An entry that is never sent (held, parity, ambiguous, duplicate, unsupported, unlinked). */
  | { readonly tipo: 'nao-enviavel'; readonly flag: FlagEntradaEstoqueLi }
  | { readonly tipo: 'em-dia' }
  /** A send candidate; `delta` = the store's effective quantity − S, used only to order. */
  | {
      readonly tipo: 'candidato';
      readonly idLi: string;
      readonly produtoId: string;
      readonly delta: number;
    };

/** The store's effective quantity minus S (both bounded), or {@link DELTA_SEM_LIMITE_LI}. */
function deltaDaLinha(linha: EstoqueNaLojaLi, S: number): number {
  const { quantidade, quantidade_reservada: reservada } = linha;
  if (
    linha.gerenciado !== true ||
    linha.situacao_sem_estoque !== -1 ||
    typeof quantidade !== 'number' ||
    !Number.isSafeInteger(quantidade) ||
    typeof reservada !== 'number' ||
    !Number.isSafeInteger(reservada)
  ) {
    return DELTA_SEM_LIMITE_LI;
  }
  const delta = quantidade - Math.max(0, reservada) - S;
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, delta));
}

/**
 * The reconcile's verdict on one row of the store's stock list (store id `idLi`, already parsed)
 * against its snapshot entry, with the cap applied HERE: a cap change moves verdicts without one
 * ERP read.
 *
 * In sync exactly when the send run would find the row reflected ({@link decidirEnvioEstoqueLi}
 * with the entry's S): `gerenciado === true`, situações (0, −1) and
 * `quantidade − max(0, quantidade_reservada) === min(S, cap)`. Anything else on a `v` entry is a
 * candidate — a `gerenciado: false` row (all zeros, not "zero stock"), a negative row, a row whose
 * reservation cannot be read — and the send run re-derives everything it sends.
 *
 * Throws `RangeError` for a `v` entry without S or produto (the snapshot schema forbids both) or a
 * bad cap.
 */
export function diffLinhaEstoqueLi(args: {
  readonly idLi: string;
  readonly linha: EstoqueNaLojaLi;
  readonly entrada: EntradaSnapshotEstoqueLi | undefined;
  readonly cap: number;
}): DiffLinhaEstoqueLi {
  const cap = tetoValido(args.cap);
  const { entrada } = args;
  if (entrada === undefined) return { tipo: 'sem-entrada' };
  if (entrada.f !== FLAG_ENTRADA_ESTOQUE_LI.valido) {
    return { tipo: 'nao-enviavel', flag: entrada.f };
  }
  if (entrada.s === null || entrada.p === null) {
    throw new RangeError('diffLinhaEstoqueLi: entrada válida sem S ou produto');
  }
  const decisao = decidirEnvioEstoqueLi({ S: entrada.s, cap, linha: args.linha });
  if (decisao.tipo === 'refletido') return { tipo: 'em-dia' };
  return {
    tipo: 'candidato',
    idLi: args.idLi,
    produtoId: entrada.p,
    delta: deltaDaLinha(args.linha, Math.min(entrada.s, cap)),
  };
}

/** Canonical store ids in numeric order: shorter text first, then by text. */
function compararIdLi(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order the queue phase enqueues the run's candidates in: `d` DESCENDING, so the worst
 * over-advertising goes first (an unmanaged row, {@link DELTA_SEM_LIMITE_LI}, before any bounded
 * one) and under-advertising last; ties by conta index, then store id, then produto — a total,
 * deterministic order. Returns a new array.
 */
export function ordenarCandidatosEstoqueLi(
  candidatos: readonly CandidatoReconcileEstoqueLi[],
): CandidatoReconcileEstoqueLi[] {
  return [...candidatos].sort(
    (a, b) =>
      b.d - a.d || a.c - b.c || compararIdLi(a.i, b.i) || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0),
  );
}
