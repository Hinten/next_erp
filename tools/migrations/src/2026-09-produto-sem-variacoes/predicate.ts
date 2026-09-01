import { estoqueDisponivel, makeEstoqueUid, parseRef, reservaEfetiva } from '@delfrance/schemas';

/**
 * Pure classification for the #1402 census: which produtos hold their OWN stock
 * because they have no variation children — the legacy "Produto Simples" shape.
 *
 * No Firestore here; `audit.ts` owns the walk. Keeping the decision pure is what
 * makes it unit-testable in `ci.yml`, and `estoqueDisponivel` / `reservaEfetiva`
 * / `makeEstoqueUid` are imported rather than re-implemented so this census and
 * the ERP agree on what "available" and "canonical" mean.
 *
 * ## What it is counting, and why the count matters
 *
 * #1398 settles that **a produto never holds available stock — the sellable
 * unit is always a child**. New produtos are born as a family and the ML
 * importer already writes that shape (`import.ts:371-374` skips the parent's
 * stock when it owns children). The legacy Flutter corpus does not:
 * `.old/lib/produtos/pages/entradaEstoque.dart:81-86` has a first-class
 * `// Produto Simples (Sem variações)` branch, and `models.dart:2137-2156`
 * (`criarEstoques`) writes stock under whichever produto the operator is
 * standing on — the root, for those.
 *
 * So every legacy Produto Simples arrives holding stock that, after #1398, no
 * ERP surface reads. This counts them **before** the one-time conversion script
 * is written, because the count is what tells that script what it has to handle.
 *
 * ⚠️ It is deliberately WIDER than `apps/mercado-livre/scripts/census-up-single.ts`,
 * whose universe is `produtoMercadoLivre` links carrying `isUserProductModel`.
 * A Produto Simples that was never sold on Mercado Livre is invisible to that
 * script and in scope here.
 *
 * ## Why a zero-quantity estoque row proves nothing
 *
 * ⚠️ **Every** legacy root produto has an `estoques` subcollection, variations or
 * not: Flutter's `criarEstoques` fires unconditionally on produto create AND
 * update (`produtoTableProvider.dart:423,447`), one zero row per depósito, and
 * a Cloud Function did the same (`tasks.dart:84-92`). So "does it have an
 * `estoques` subcollection" is **not** a discriminator — the question has to be
 * asked of the quantities.
 */

/* -------------------------------------------------------------------------- */
/*                                  Verdicts                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a produto turned out to be. Only `simples-com-estoque` is conversion
 * work; every other bucket is reported so the totals add up and a surprising
 * distribution is visible rather than rounded away — the same discipline
 * `census-up-single.ts:104-112` uses.
 */
export type VereditoProduto =
  /** Root produto, no children, holds non-zero stock. **The conversion's work.** */
  | 'simples-com-estoque'
  /**
   * Root produto, no children, every estoque row is zero (or there are none).
   * Still needs a sole child under #1398, but nothing has to move — so it is a
   * cheaper, safer sub-population and worth counting apart.
   */
  | 'simples-sem-estoque'
  /** Root produto that already owns children: nothing to do. */
  | 'ja-familia'
  /** Carries a `paiId` naming a produto that exists — a variation child. */
  | 'filho'
  /**
   * Carries a `paiId` naming a produto that is NOT in the corpus. A real defect,
   * found for free by the same pass, and one the conversion must not trip over:
   * such a document is neither a parent nor a reachable child.
   */
  | 'orfao';

/* -------------------------------------------------------------------------- */
/*                                   Estoque                                  */
/* -------------------------------------------------------------------------- */

/** One estoque document, exactly as stored — no coercion applied yet. */
export interface EstoqueBruto {
  docId: string;
  depositoOuterRef: unknown;
  quantidade: unknown;
  quantidadeReservada: unknown;
}

/** Why a stored value could not be used as read. Forensic, never fatal. */
export type SinalEstoque =
  /** `depositoOuterRef` names no depósito — neither encoding parsed. */
  | 'deposito-irreconhecivel'
  /** The doc id is not `est-<produtoId>-<depositoId>` (see the ⚠️ below). */
  | 'id-nao-canonico'
  /** `quantidade` was absent or non-finite; read as 0. */
  | 'quantidade-nao-numerica'
  /** `quantidadeReservada` was absent or non-finite; `reservaEfetiva` reads it as 0. */
  | 'reservada-nao-numerica'
  /** A stored negative reservation — the #931 defect, surfaced here in passing. */
  | 'reservada-negativa';

export interface LinhaDeposito {
  docId: string;
  /** `null` when `depositoOuterRef` resolves to no depósito. */
  depositoId: string | null;
  quantidade: number;
  quantidadeReservada: number;
  /** `estoqueDisponivel` — what a reader sees today. May be negative. */
  disponivel: number;
  /**
   * What the conversion would MOVE onto the sole child: available units only,
   * `max(0, quantidade − reservaEfetiva)`. Byte-for-byte the rule
   * `upSoleMember.ts:258-260` already applies.
   */
  moveria: number;
  /**
   * What the conversion would LEAVE on the parent: the effective reserve.
   *
   * ⚠️ Not a rounding artefact — a deliberate residual. A reservation is keyed on
   * the produto the pedido LINE names, so the eventual release decrements the
   * parent's row. `upSoleMember.ts:243-257`: *"Move the reserve with the rest and
   * that release lands on a document we emptied, while the child keeps a phantom
   * reserve for ever."* Sum this across the report: it sizes the manual cleanup
   * the window leaves behind.
   */
  ficaNoPai: number;
  sinais: SinalEstoque[];
}

export interface ResumoEstoque {
  linhas: LinhaDeposito[];
  /**
   * ⚠️ The discriminator, matching `EstoqueManager`'s `residualEstoquePai`
   * (`:82-100`): a row counts when `quantidade !== 0 || quantidadeReservada !== 0`.
   * NOT `estoqueDisponivel !== 0` — a row with 5 in stock and 5 reserved is
   * genuinely holding units even though its available reads zero.
   */
  temEstoque: boolean;
  quantidadeTotal: number;
  reservadaTotal: number;
  moveriaTotal: number;
  ficariaNoPaiTotal: number;
  /** Rows whose doc id is not `est-<produtoId>-<depositoId>`. */
  nLinhasNaoCanonicas: number;
  /** Rows whose `depositoOuterRef` resolved to nothing. */
  nDepositosIrreconheciveis: number;
  /**
   * Distinct depósitos this produto actually holds stock in — counted over the
   * rows that pass the same `quantidade !== 0 || quantidadeReservada !== 0`
   * test as {@link ResumoEstoque.temEstoque}.
   *
   * ⚠️ NOT the row count. Flutter's `criarEstoques` writes a ZERO row per
   * depósito for every produto on create and on update, so counting rows
   * would report the same number for the whole legacy catalogue — the very
   * thing this module's header warns is not a discriminator.
   */
  nDepositos: number;
}

function numeroFinito(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

function textoOuNull(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/**
 * The depósito id behind an `depositoOuterRef`, or `null`.
 *
 * ⚠️ **Both encodings are legal.** Readers tolerate the bare form, and
 * `aplicarBalanco.ts:228-233` queries for `documents/depositos/<id>` AND
 * `depositos/<id>` for exactly that reason. `parseRef` strips a leading
 * `documents` segment, so it answers both — which is why it is imported rather
 * than a `split('/').pop()` written here.
 *
 * The collection is checked, not just the last segment: a ref into some other
 * collection is a defect, and reading its trailing id as a depósito id would
 * silently attribute stock to a depósito that does not exist.
 */
export function depositoIdDoRef(raw: unknown): string | null {
  const texto = textoOuNull(raw);
  if (texto == null) return null;
  const { collection, id } = parseRef(texto);
  if (collection !== 'depositos' || id === '') return null;
  return id;
}

/**
 * One stored estoque document, reduced to what the census reports.
 *
 * ⚠️ **Nothing here re-derives the doc id.** `upSoleMember.ts:53-60` records why:
 * *"the migrated corpus also holds rows at auto-ids that are matched by
 * `depositoOuterRef` instead — so re-deriving the id here would patch a document
 * that does not exist and leave the real row untouched, **silently doubling the
 * stock**."* `.old/packages/produtos/lib/src/tasks.dart:92` makes it concrete: that
 * Cloud Function calls `makeEstoqueUid(depositoId, produtoId)` with the arguments
 * **transposed** relative to every other call site, minting
 * `est-<depositoId>-<produtoId>`. Those are presumably the non-canonical rows
 * `aplicarBalanco.ts:251` already counts as `estoquesExtras`.
 *
 * So `makeEstoqueUid` appears exactly once below, as a COMPARISON that produces
 * a count, never as a lookup key.
 */
export function resumirLinha(produtoId: string, bruto: EstoqueBruto): LinhaDeposito {
  const sinais: SinalEstoque[] = [];

  const depositoId = depositoIdDoRef(bruto.depositoOuterRef);
  if (depositoId == null) sinais.push('deposito-irreconhecivel');
  else if (bruto.docId !== makeEstoqueUid(produtoId, depositoId)) sinais.push('id-nao-canonico');

  const quantidadeLida = numeroFinito(bruto.quantidade);
  if (quantidadeLida == null) sinais.push('quantidade-nao-numerica');
  const quantidade = quantidadeLida ?? 0;

  const reservadaLida = numeroFinito(bruto.quantidadeReservada);
  if (reservadaLida == null) sinais.push('reservada-nao-numerica');
  else if (reservadaLida < 0) sinais.push('reservada-negativa');
  const quantidadeReservada = reservadaLida ?? 0;

  const disponivel = estoqueDisponivel({ quantidade, quantidadeReservada });
  const ficaNoPai = reservaEfetiva(quantidadeReservada);

  return {
    docId: bruto.docId,
    depositoId,
    quantidade,
    quantidadeReservada,
    disponivel,
    moveria: Math.max(0, disponivel),
    ficaNoPai,
    sinais,
  };
}

export function resumirEstoques(produtoId: string, brutos: readonly EstoqueBruto[]): ResumoEstoque {
  const linhas = brutos.map((b) => resumirLinha(produtoId, b));
  const temUnidades = (l: LinhaDeposito) => l.quantidade !== 0 || l.quantidadeReservada !== 0;
  const depositos = new Set(
    linhas
      .filter(temUnidades)
      .map((l) => l.depositoId)
      .filter((d): d is string => d != null),
  );

  return {
    linhas,
    temEstoque: linhas.some(temUnidades),
    quantidadeTotal: linhas.reduce((acc, l) => acc + l.quantidade, 0),
    reservadaTotal: linhas.reduce((acc, l) => acc + l.quantidadeReservada, 0),
    moveriaTotal: linhas.reduce((acc, l) => acc + l.moveria, 0),
    ficariaNoPaiTotal: linhas.reduce((acc, l) => acc + l.ficaNoPai, 0),
    nLinhasNaoCanonicas: linhas.filter((l) => l.sinais.includes('id-nao-canonico')).length,
    nDepositosIrreconheciveis: linhas.filter((l) => l.sinais.includes('deposito-irreconhecivel'))
      .length,
    nDepositos: depositos.size,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Produto verdict                               */
/* -------------------------------------------------------------------------- */

export interface EntradaClassificacao {
  paiId: string | null;
  /** Whether the produto named by `paiId` exists. Only consulted when `paiId != null`. */
  paiExiste: boolean;
  /** Whether ANY produto in the corpus carries `paiId === <this produto's id>`. */
  temFilhos: boolean;
  /** `null` when the estoque subcollection was not read (see `audit.ts`'s `--target`). */
  resumo: ResumoEstoque | null;
}

/**
 * ⚠️ Order matters. `paiId` is asked FIRST because a document carrying one is a
 * child regardless of anything else — including the pathological case of a child
 * that itself has children, which the schema does not forbid and which a
 * children-first test would silently relabel `ja-familia`.
 *
 * A root produto whose estoque was not read cannot be told apart from one whose
 * rows are all zero, so it lands in `simples-sem-estoque` — the conservative
 * bucket, since that one implies no move.
 */
export function classificarProduto(entrada: EntradaClassificacao): VereditoProduto {
  if (entrada.paiId != null) return entrada.paiExiste ? 'filho' : 'orfao';
  if (entrada.temFilhos) return 'ja-familia';
  return entrada.resumo?.temEstoque === true ? 'simples-com-estoque' : 'simples-sem-estoque';
}

/* -------------------------------------------------------------------------- */
/*                              The report row                                */
/* -------------------------------------------------------------------------- */

/** The produto fields carried into the JSONL for forensics. */
export interface ProdutoBruto {
  id: string;
  nome: unknown;
  sku: unknown;
  paiId: unknown;
  ehKit: unknown;
  publicado: unknown;
  /**
   * ⚠️ `undefined` means the KEY WAS ABSENT, and that is a finding of its own:
   * `produtoMeta.defaultQuery` sorts on `ultimaModificacao`, and Firestore's
   * `orderBy` SKIPS a document missing the ordered field — so such a produto is
   * invisible in `/produtos` with no error anywhere (#1213). A stored `null` is
   * fine. Read it with `Object.hasOwn`, never `?? null`.
   */
  ultimaModificacao: unknown;
}

export interface ProdutoSemVariacoesRow {
  produtoPath: string;
  produtoId: string;
  veredito: VereditoProduto;
  nome: string | null;
  sku: string | null;
  paiId: string | null;
  ehKit: boolean;
  publicado: boolean;
  /** The `orderBy`-invisibility finding above. */
  semUltimaModificacao: boolean;
  /** `null` when the estoque subcollection was not read. */
  estoque: ResumoEstoque | null;
  /** How many OTHER produtos name this one in `componentesKitKeys`. */
  nKitsQueReferenciam: number;
  /** `null` when the balanço pass did not run. */
  emBalancoAberto: boolean | null;
  /** `null` when the pedidos pass did not run. */
  nPedidosAbertosQueReservam: number | null;
}

export interface MontarLinhaArgs {
  produto: ProdutoBruto;
  veredito: VereditoProduto;
  resumo: ResumoEstoque | null;
  nKitsQueReferenciam: number;
  emBalancoAberto: boolean | null;
  nPedidosAbertosQueReservam: number | null;
}

export function montarLinha(args: MontarLinhaArgs): ProdutoSemVariacoesRow {
  const { produto } = args;
  return {
    produtoPath: `produtos/${produto.id}`,
    produtoId: produto.id,
    veredito: args.veredito,
    nome: textoOuNull(produto.nome),
    sku: textoOuNull(produto.sku),
    paiId: textoOuNull(produto.paiId),
    ehKit: produto.ehKit === true,
    publicado: produto.publicado === true,
    semUltimaModificacao: produto.ultimaModificacao === undefined,
    estoque: args.resumo,
    nKitsQueReferenciam: args.nKitsQueReferenciam,
    emBalancoAberto: args.emBalancoAberto,
    nPedidosAbertosQueReservam: args.nPedidosAbertosQueReservam,
  };
}
