/**
 * **The PURE price decision** (#1521, step 13) — one priced item, its FRESH
 * read and the conta's currency and ratio multiple ⇒ send (with the exact
 * `price_list`), skip, or refuse; plus ONE report row per model the planner
 * addressed.
 *
 * Nothing here calls Shopee, reads Firestore, reads the clock or writes a
 * link. The sender (`./enviarPreco`) owns the reads, the one write and the
 * write-backs; this module owns gates G2–G8 of the per-item ladder (reconcile
 * §2.6). It imports neither the write op nor the link writer, which is what
 * lets the CLI's dry run print "would send / would skip, and why" through the
 * SAME function the live push obeys (contract S8) with no write reachable.
 *
 * ## The gates, in order
 *
 * | # | reads | outcome |
 * |---|---|---|
 * | G2 | the fresh listing status | BANNED ⇒ `anuncio-banido`, REVIEWING ⇒ `anuncio-em-revisao`, either DELETE ⇒ `anuncio-removido` — item `pular`, every row the same. ANY other status SENDS (an unknown non-null one with ONE `console.warn`) |
 * | G3 | `temModelos` vs the plan's `semModelos` | they disagree ⇒ `falhar forma-de-modelo-divergente`, every row |
 * | G3b | the fresh model list | a linked model it does not hold ⇒ THAT row `pulado modelo-ausente` |
 * | G4 | every fresh model's currency | a non-null one ≠ the conta's ⇒ `falhar moeda-divergente` |
 * | G5 | per row | no target price ⇒ `preco-nao-encontrado`; the fold says equal ⇒ `preco-igual` |
 * | G6 | per row, only without `baixarPreco` | unreadable current ⇒ `preco-atual-ilegivel`; a decrease ⇒ `preco-menor-bloqueado` |
 * | G7 | EVERY fresh model | the max/min ratio after the write exceeds the multiple ⇒ `falhar razao-de-precos-excedida` on the would-be-sent rows |
 * | G8 | the surviving rows | the body |
 *
 * **A row is settled by the FIRST gate that speaks about it, and never
 * repainted.** So an absent model keeps `modelo-ausente` under a currency
 * refusal, and a ratio refusal paints only the rows it would have sent — a
 * sibling that was already equal keeps saying so.
 *
 * ⚠️ **Status BEFORE equality**, unlike Mercado Livre's order: the crash-replay
 * idempotence only needs equality before the WRITE, and a listing that became
 * banned or deleted must say so rather than "already equal". And an UNKNOWN
 * status sends: only the three states that cannot take a price skip, and
 * Shopee's own refusal classifies anything else — a status Shopee invents
 * tomorrow must fail loudly at the wire, never quietly skip forever.
 *
 * ## The comparisons
 *
 * - **Equality is `mesmoPrecoEmReais`, the shared skip-if-equal fold**, and
 *   nothing else: two prices are equal when they land on the same centavo
 *   (`10.004` ≡ `10`), and one centavo apart is a real edit (`49.99` ≠ `50`).
 *   A `null` current price never equals anything, so an unreadable listing is
 *   never "already correct" — without `baixarPreco` it is
 *   `preco-atual-ilegivel`, with it the target is sent.
 * - **The decrease guard and the ratio compare INTEGER centavos**
 *   (`centavosDeReais`, the one sanctioned conversion). A float product can
 *   land a hair under the exact value — `5 × 0.36` is `1.7999999999999998` —
 *   and refuse an item that sits exactly on the limit; `180 > 5 × 36` cannot.
 *
 * ## The ratio (G7) judges what the listing WILL look like
 *
 * Shopee refuses a write whose max/min price between variations exceeds the
 * region's multiple, and it judges that against the siblings we do NOT send at
 * their CURRENT prices (probe P11b — and it answers only a generic refusal, so
 * this pre-wire check is the only place the operator learns the real reason).
 * The input is therefore every model of the fresh read, linked or not,
 * available or not: the ones about to be sent at their target, every other one
 * at its current price. A model whose current price is unreadable cannot be
 * placed and is left out — counted in ONE `console.warn`, never silently.
 * "Cannot exceed" makes exactly `multiplo`× pass. The multiple comes from the
 * conta context (BR 4, SG 5 — the SG one measured), never a literal here.
 *
 * ## The body (G8)
 *
 * With `PRICE_LIST_SO_A_DIFERENCA` (probe P8: an unsent sibling keeps its
 * price) the body carries ONLY the models whose price changes. Flipped, every
 * linked model still in the fresh read rides — see {@link montarCorpoDePreco}
 * for why an unchanged one rides at its CURRENT price, never at its target. A
 * no-model item's body is built in its own branch from
 * `SHOPEE_PRECO_MODEL_ID_SEM_MODELO`, so the one place the no-model spelling
 * could ever flip is that constant and that branch.
 *
 * ## The rows
 *
 * EXACTLY one per `item.alvos` entry, in the same order, whatever the outcome
 * (contract S1 starts here). `precoAnterior` is the fresh price of that model
 * (`null` when the read does not hold it); `codigo` is always `null`, because
 * it carries Shopee's own text and nothing here heard Shopee. ⚠️ In a `enviar`
 * decision the rows of the models IN the body say `enviado` PROVISIONALLY —
 * the sender re-attributes each from Shopee's answer. Nothing else in a
 * decision is provisional.
 */
import type { ShopeeUpdatePriceEntry } from '@delfrance/integrations-shopee';
import { centavosDeReais } from '@delfrance/core/money';
import { ENVIO_PRECO_RESULTADO, SHOPEE_ITEM_STATUS, mesmoPrecoEmReais } from '@delfrance/schemas';

import { PRICE_LIST_SO_A_DIFERENCA, SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import { type MotivoPrecoShopee, MOTIVO_PRECO_SHOPEE } from './errosPreco';
import type { LeituraDePreco, ModeloLido } from './leituraPreco';
import type { AlvoDeModelo, ItemDePreco } from './planoPreco';

/* -------------------------------------------------------------------------- */
/*                                 THE SHAPES                                 */
/* -------------------------------------------------------------------------- */

/**
 * What happened to one model — a subset of the price report's own enum (the
 * surfaces add `nao-tentado` for what never reached the sender). Declared
 * HERE, the first module that produces rows, and re-exported by the sender
 * under the same name, so the dependency runs sender → decision only.
 */
export type ResultadoModeloPreco = 'enviado' | 'pulado' | 'falha';

/** One report row: one model of one item (or the no-model item's single entry). */
export interface LinhaModeloPreco {
  /** The alvo's `modelId` — `SHOPEE_PRECO_MODEL_ID_SEM_MODELO` on a no-model item. */
  readonly modelId: number;
  /** The produto that priced the alvo — the CHILD, or the anchor on a no-model item. */
  readonly produtoId: string;
  /** `null` exactly on a no-model item. */
  readonly varLinkDocId: string | null;
  /** The target price, as the planner priced it; `null` when the tabela has none. */
  readonly precoAlvo: number | null;
  /** The price Shopee shows now for this model; `null` when unreadable or absent from the read. */
  readonly precoAnterior: number | null;
  readonly resultado: ResultadoModeloPreco;
  /** `null` exactly on an `enviado` row. */
  readonly motivo: MotivoPrecoShopee | null;
  /** Shopee's own text VERBATIM (≤ 300); never an `erp:` code, and always `null` here. */
  readonly codigo: string | null;
}

/** The verdict on one item. */
export type DecisaoDePreco =
  | {
      readonly tipo: 'enviar';
      readonly priceList: readonly ShopeeUpdatePriceEntry[];
      readonly linhas: readonly LinhaModeloPreco[];
    }
  | {
      readonly tipo: 'pular';
      readonly motivo: MotivoPrecoShopee;
      readonly linhas: readonly LinhaModeloPreco[];
    }
  | {
      readonly tipo: 'falhar';
      readonly motivo: MotivoPrecoShopee;
      /** The code a refusal of OURS is stamped with — see {@link codigoDoErpDePreco}. */
      readonly codigoErp: `erp:${string}`;
      readonly linhas: readonly LinhaModeloPreco[];
    };

/* -------------------------------------------------------------------------- */
/*                                  THE CODE                                  */
/* -------------------------------------------------------------------------- */

/**
 * The stored code for a price refusal that is OURS rather than Shopee's.
 *
 * One spelling, in one place (step 12's `codigoDoErp` rule): a prefix re-typed
 * at every arm that refuses on the ERP's own account is how one fact ends up
 * stored under `erp-`, `erp/` and `erp:` in one collection with nothing
 * failing. Exported so the sender's own refusals spell it the same way.
 */
export function codigoDoErpDePreco(motivo: MotivoPrecoShopee): `erp:${MotivoPrecoShopee}` {
  return `erp:${motivo}`;
}

/* -------------------------------------------------------------------------- */
/*                                 THE TABLES                                 */
/* -------------------------------------------------------------------------- */

/**
 * G2 — the listing states that cannot take a price. EXACT wire codes (a Map,
 * so an inherited key never matches); everything absent from it SENDS.
 */
const MOTIVO_POR_STATUS_QUE_PULA: ReadonlyMap<string, MotivoPrecoShopee> = new Map([
  [SHOPEE_ITEM_STATUS.banned, MOTIVO_PRECO_SHOPEE.anuncioBanido],
  [SHOPEE_ITEM_STATUS.reviewing, MOTIVO_PRECO_SHOPEE.anuncioEmRevisao],
  [SHOPEE_ITEM_STATUS.sellerDelete, MOTIVO_PRECO_SHOPEE.anuncioRemovido],
  [SHOPEE_ITEM_STATUS.shopeeDelete, MOTIVO_PRECO_SHOPEE.anuncioRemovido],
]);

/** G2 — the states that send in silence; any OTHER non-null status sends with a warning. */
const STATUS_CONHECIDOS_QUE_ENVIAM: ReadonlySet<string> = new Set([
  SHOPEE_ITEM_STATUS.normal,
  SHOPEE_ITEM_STATUS.unlist,
]);

/**
 * The item's motivo when NO row is left to send — the first of these that any
 * row carries. G6's reasons outrank G5's (the guard removed something the fold
 * had left), a decrease outranks an unreadable current price (reconcile §2.6),
 * and "already equal" outranks "no price" (G5's own order). An item whose rows
 * are all absent reads `modelo-ausente`; an item with no row at all reads
 * `preco-nao-encontrado`, the sender's own zero-price answer (G0).
 */
const DOMINANCIA_SEM_ENVIO: readonly MotivoPrecoShopee[] = [
  MOTIVO_PRECO_SHOPEE.precoMenorBloqueado,
  MOTIVO_PRECO_SHOPEE.precoAtualIlegivel,
  MOTIVO_PRECO_SHOPEE.precoIgual,
  MOTIVO_PRECO_SHOPEE.precoNaoEncontrado,
  MOTIVO_PRECO_SHOPEE.modeloAusente,
];

/* -------------------------------------------------------------------------- */
/*                                  HELPERS                                   */
/* -------------------------------------------------------------------------- */

/** One alvo, judged: either it rides in the body, or it is settled with a motivo. */
type Avaliacao =
  | {
      readonly envia: true;
      readonly alvo: AlvoDeModelo;
      readonly lido: ModeloLido;
      readonly precoAlvo: number;
    }
  | {
      readonly envia: false;
      readonly alvo: AlvoDeModelo;
      readonly lido: ModeloLido | undefined;
      readonly motivo: MotivoPrecoShopee;
    };

/**
 * The fresh read indexed by `model_id`. The read carries duplicates verbatim
 * (a projection, not a fold); the FIRST entry of an id is the one that speaks.
 */
function indexarLeitura(leitura: LeituraDePreco): ReadonlyMap<number, ModeloLido> {
  const porModelo = new Map<number, ModeloLido>();
  for (const lido of leitura.modelos) {
    if (!porModelo.has(lido.modelId)) porModelo.set(lido.modelId, lido);
  }
  return porModelo;
}

/** One report row. */
function linha(
  alvo: AlvoDeModelo,
  lido: ModeloLido | undefined,
  resultado: ResultadoModeloPreco,
  motivo: MotivoPrecoShopee | null,
): LinhaModeloPreco {
  return {
    modelId: alvo.modelId,
    produtoId: alvo.produtoId,
    varLinkDocId: alvo.varLinkDocId,
    precoAlvo: alvo.precoAlvo,
    precoAnterior: lido?.precoAnterior ?? null,
    resultado,
    motivo,
    codigo: null,
  };
}

/** A refusal of ours: the item's motivo, its one-spelling code, the rows. */
function falhar(
  motivo: MotivoPrecoShopee,
  linhas: readonly LinhaModeloPreco[],
): Extract<DecisaoDePreco, { tipo: 'falhar' }> {
  return { tipo: 'falhar', motivo, codigoErp: codigoDoErpDePreco(motivo), linhas };
}

/**
 * G2's motivo for a status that skips, or `null` when the item goes on. An
 * unknown non-null status goes on with ONE warning naming it.
 */
function motivoDoStatus(itemId: number, itemStatus: string | null): MotivoPrecoShopee | null {
  if (itemStatus === null) return null;
  const motivo = MOTIVO_POR_STATUS_QUE_PULA.get(itemStatus);
  if (motivo !== undefined) return motivo;
  if (!STATUS_CONHECIDOS_QUE_ENVIAM.has(itemStatus)) {
    console.warn('[shopee/precos] status de anúncio desconhecido; o preço segue para a Shopee', {
      itemId,
      itemStatus,
    });
  }
  return null;
}

/** G3b, G5 and G6 for one alvo — `lido` already looked up. */
function avaliarAlvo(
  alvo: AlvoDeModelo,
  lido: ModeloLido | undefined,
  baixarPreco: boolean,
): Avaliacao {
  const resolvida = (motivo: MotivoPrecoShopee): Avaliacao => ({
    envia: false,
    alvo,
    lido,
    motivo,
  });

  // G3b — a linked model the fresh read does not hold.
  if (lido === undefined) return resolvida(MOTIVO_PRECO_SHOPEE.modeloAusente);

  // G5 — no target, or already equal (the shared fold; a null current is never equal).
  const precoAlvo = alvo.precoAlvo;
  if (precoAlvo === null) return resolvida(MOTIVO_PRECO_SHOPEE.precoNaoEncontrado);
  if (mesmoPrecoEmReais(lido.precoAnterior, precoAlvo)) {
    return resolvida(MOTIVO_PRECO_SHOPEE.precoIgual);
  }

  // G6 — the decrease guard, OFF when the operator authorised the decrease.
  if (!baixarPreco) {
    if (lido.precoAnterior === null) return resolvida(MOTIVO_PRECO_SHOPEE.precoAtualIlegivel);
    if (centavosDeReais(precoAlvo) < centavosDeReais(lido.precoAnterior)) {
      return resolvida(MOTIVO_PRECO_SHOPEE.precoMenorBloqueado);
    }
  }

  return { envia: true, alvo, lido, precoAlvo };
}

/** The item's motivo when nothing is left to send — {@link DOMINANCIA_SEM_ENVIO}. */
function motivoDominante(avaliacoes: readonly Avaliacao[]): MotivoPrecoShopee {
  const presentes = new Set<MotivoPrecoShopee>();
  for (const a of avaliacoes) if (!a.envia) presentes.add(a.motivo);
  for (const motivo of DOMINANCIA_SEM_ENVIO) if (presentes.has(motivo)) return motivo;
  return MOTIVO_PRECO_SHOPEE.precoNaoEncontrado;
}

/**
 * G7 — does the listing, AFTER this write, keep its max/min price within
 * `multiplo`? Every fresh model counts: the ones about to be sent at their
 * target, every other one at its current price; an unreadable one is left out
 * with ONE warning.
 */
function razaoDentroDoLimite(
  itemId: number,
  leitura: LeituraDePreco,
  enviados: ReadonlyMap<number, number>,
  multiplo: number,
): boolean {
  let minC = Number.POSITIVE_INFINITY;
  let maxC = 0;
  let considerados = 0;
  let ilegiveis = 0;
  for (const lido of leitura.modelos) {
    const depois = enviados.get(lido.modelId) ?? lido.precoAnterior;
    if (depois === null) {
      ilegiveis += 1;
      continue;
    }
    const centavos = centavosDeReais(depois);
    considerados += 1;
    if (centavos < minC) minC = centavos;
    if (centavos > maxC) maxC = centavos;
  }
  if (ilegiveis > 0) {
    console.warn(
      '[shopee/precos] razão entre preços conferida sem as variações de preço ilegível',
      { itemId, considerados, ilegiveis },
    );
  }
  // Never an empty set: every model about to be sent is placed at its target.
  // "Cannot exceed" ⇒ exactly multiplo× passes.
  return maxC <= multiplo * minC;
}

/* -------------------------------------------------------------------------- */
/*                                  THE BODY                                  */
/* -------------------------------------------------------------------------- */

/**
 * G8 — the `price_list` for an item whose rows are already decided. PURE and
 * exported so the flipped constant is testable without flipping it:
 * {@link decidirEnvioDePreco} always passes `PRICE_LIST_SO_A_DIFERENCA`.
 *
 * - The `enviado` rows ride at their TARGET, in row order.
 * - A no-model item's single entry is built HERE, from
 *   `SHOPEE_PRECO_MODEL_ID_SEM_MODELO` — never a truthiness test on the id,
 *   which would drop the key on the simplest listing there is.
 * - `soADiferenca === false` also carries, on a has-model item, every other
 *   `pulado` row of a model still in the fresh read, at its CURRENT price (a
 *   no-model item has no sibling to preserve). ⚠️ Its current price, never
 *   its target: the flip exists to keep Shopee from resetting unsent siblings,
 *   and a sibling the decrease guard held back must not ride at the price the
 *   guard refused — that would make the flip a silent bypass of the guard. A
 *   row whose current price is unreadable cannot be preserved and stays out;
 *   so does an absent model (there is nothing on Shopee to preserve).
 *
 * @throws Error when an `enviado` row has no target — a decision that cannot
 *   exist; sending it would put an unpriced model on the wire.
 */
export function montarCorpoDePreco(
  item: Pick<ItemDePreco, 'semModelos'>,
  linhas: readonly LinhaModeloPreco[],
  soADiferenca: boolean,
): readonly ShopeeUpdatePriceEntry[] {
  const corpo: ShopeeUpdatePriceEntry[] = [];
  for (const l of linhas) {
    if (l.resultado === ENVIO_PRECO_RESULTADO.enviado) {
      if (l.precoAlvo === null) {
        throw new Error(
          `montarCorpoDePreco: a linha do modelo ${String(l.modelId)} diz enviado sem preço-alvo.`,
        );
      }
      if (item.semModelos) {
        corpo.push({ model_id: SHOPEE_PRECO_MODEL_ID_SEM_MODELO, original_price: l.precoAlvo });
      } else {
        corpo.push({ model_id: l.modelId, original_price: l.precoAlvo });
      }
      continue;
    }
    if (
      !soADiferenca &&
      !item.semModelos &&
      l.resultado === ENVIO_PRECO_RESULTADO.pulado &&
      l.motivo !== MOTIVO_PRECO_SHOPEE.modeloAusente &&
      l.precoAnterior !== null
    ) {
      corpo.push({ model_id: l.modelId, original_price: l.precoAnterior });
    }
  }
  return corpo;
}

/* -------------------------------------------------------------------------- */
/*                                THE DECISION                                */
/* -------------------------------------------------------------------------- */

/**
 * G2–G8 for one item — PURE (see the module docblock for the ladder, the
 * comparisons and the row contract).
 *
 * `ctx.moeda` is the conta's currency, compared EXACTLY with each fresh
 * model's (no case fold); `ctx.multiplo` is the region's max/min ratio.
 * `opts.baixarPreco` turns the decrease guard (G6) off, and with it the
 * refusal of an unreadable current price.
 */
export function decidirEnvioDePreco(
  item: ItemDePreco,
  leitura: LeituraDePreco,
  ctx: { readonly moeda: string; readonly multiplo: number },
  opts: { readonly baixarPreco: boolean },
): DecisaoDePreco {
  const lidos = indexarLeitura(leitura);
  const lidoDe = (alvo: AlvoDeModelo): ModeloLido | undefined => lidos.get(alvo.modelId);
  const todas = (resultado: ResultadoModeloPreco, motivo: MotivoPrecoShopee) =>
    item.alvos.map((alvo) => linha(alvo, lidoDe(alvo), resultado, motivo));

  // G2 — the fresh status.
  const doStatus = motivoDoStatus(item.itemId, leitura.itemStatus);
  if (doStatus !== null) {
    return {
      tipo: 'pular',
      motivo: doStatus,
      linhas: todas(ENVIO_PRECO_RESULTADO.pulado, doStatus),
    };
  }

  // G3 — the variation structure the plan saw is not the one Shopee holds now.
  if (leitura.temModelos !== !item.semModelos) {
    const motivo = MOTIVO_PRECO_SHOPEE.formaDeModeloDivergente;
    return falhar(motivo, todas(ENVIO_PRECO_RESULTADO.falha, motivo));
  }

  // G3b (per row), then G4 over every fresh model — absent rows stay settled.
  if (leitura.modelos.some((lido) => lido.moeda !== null && lido.moeda !== ctx.moeda)) {
    const motivo = MOTIVO_PRECO_SHOPEE.moedaDivergente;
    return falhar(
      motivo,
      item.alvos.map((alvo) => {
        const lido = lidoDe(alvo);
        return lido === undefined
          ? linha(alvo, lido, ENVIO_PRECO_RESULTADO.pulado, MOTIVO_PRECO_SHOPEE.modeloAusente)
          : linha(alvo, lido, ENVIO_PRECO_RESULTADO.falha, motivo);
      }),
    );
  }

  // G3b, G5, G6 — per row.
  const avaliacoes = item.alvos.map((alvo) => avaliarAlvo(alvo, lidoDe(alvo), opts.baixarPreco));
  const aEnviar = new Map<number, number>();
  for (const a of avaliacoes) if (a.envia) aEnviar.set(a.alvo.modelId, a.precoAlvo);

  if (aEnviar.size === 0) {
    const motivo = motivoDominante(avaliacoes);
    return {
      tipo: 'pular',
      motivo,
      linhas: avaliacoes.map((a) =>
        linha(a.alvo, a.lido, ENVIO_PRECO_RESULTADO.pulado, a.envia ? motivo : a.motivo),
      ),
    };
  }

  // G7 — the ratio over the listing as it will look after the write.
  if (!razaoDentroDoLimite(item.itemId, leitura, aEnviar, ctx.multiplo)) {
    const motivo = MOTIVO_PRECO_SHOPEE.razaoDePrecosExcedida;
    return falhar(
      motivo,
      avaliacoes.map((a) =>
        a.envia
          ? linha(a.alvo, a.lido, ENVIO_PRECO_RESULTADO.falha, motivo)
          : linha(a.alvo, a.lido, ENVIO_PRECO_RESULTADO.pulado, a.motivo),
      ),
    );
  }

  // G8 — the body.
  const linhas = avaliacoes.map((a) =>
    a.envia
      ? linha(a.alvo, a.lido, ENVIO_PRECO_RESULTADO.enviado, null)
      : linha(a.alvo, a.lido, ENVIO_PRECO_RESULTADO.pulado, a.motivo),
  );
  return {
    tipo: 'enviar',
    priceList: montarCorpoDePreco(item, linhas, PRICE_LIST_SO_A_DIFERENCA),
    linhas,
  };
}
