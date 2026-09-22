/**
 * **The link write-backs** (#1520, step 12) — the ONE module that records a
 * stock outcome on a Shopee link document.
 *
 * Four functions for four outcomes: a CLEAN send, a PARTIAL send, a
 * listing-level refusal and a per-MODEL refusal. The sender
 * (`./enviarEstoque`) is their only caller and nothing else in this app may
 * touch these fields, so "what does the stored diagnosis mean" is answerable by
 * reading one file instead of by reconciling four call sites that each remember
 * half the rule.
 *
 * ## ⚠️ ONE clearer, and it is the CLEAN send
 *
 * {@link registrarEnvioLimpo} is the only function that writes `null` to the
 * six `estoqueRecusa*` fields, and it writes ALL six: its patch is TOTAL over
 * {@link CAMPOS_DO_PATCH_DE_ESTOQUE} and the compiler checks that — a name
 * added to the list without a value here does not compile, and a value whose
 * name is not on the list does not compile either.
 *
 * Nothing else clears anything. A refusal expires against the READING that
 * caused it — the fingerprint `./podeEnviarEstoque` compares — never against a
 * clock and never against a second writer that could disagree with the first.
 * The listing's existing status writers lift the skip by doing their own job.
 *
 * ## ⚠️ A PARTIAL send does NOT stamp `estoqueEnviadoEm`
 *
 * `estoqueEnviadoEm` means "the last time this listing was FULLY in sync", and
 * it is also the anchor a child row's visibility is compared against: a
 * per-model refusal is legible exactly while
 * `child.estoqueRecusaEm >= (parent.estoqueEnviadoEm ?? 0)`. Stamping it on a
 * partial would hide the very diagnosis the partial just produced — every child
 * row would read as stale the instant it was written, and the operator would be
 * told "refused" with no way to learn which of up to fifty models.
 *
 * ## ⚠️ The child rows self-expire — there are ZERO clearing writes for them
 *
 * {@link registrarRecusaDeModelo} writes three keys and there is deliberately
 * no counterpart that nulls them. Clearing on success would cost one update per
 * model per send, on every listing, several times an hour, for two fields
 * nothing reads to decide anything. The comparison above does the expiry for
 * free, and the absence of a clearer is what keeps it free.
 *
 * ## ⚠️ Every patch is FLAT, and every write is `mergeIfExists`
 *
 * The handles' `mergeIfExists` is `update()` plus a NOT_FOUND narrow. It throws
 * a `TypeError` on a nested plain object or on a dotted key, because `update()`
 * REPLACES a map where set-merge deep-merges it — so the two verbs can never
 * diverge silently for the same input. It is also **not** an upsert: a link
 * deleted between the plan and the write answers `false` and STAYS deleted,
 * where the plain merge would resurrect it as a ghost carrying only these
 * eleven keys and none of the schema's required ones. `false` is not a failure
 * — one `console.warn` naming the conta and the document, and the caller
 * carries on with its own accounting.
 *
 * ## ⚠️ The code is stored VERBATIM
 *
 * `estoqueRecusaCodigo` keeps Shopee's string exactly as it arrived, module
 * prefix and all. The stripped form exists for CLASSIFICATION only — two
 * modules share suffixes, and a code rewritten at the write side can never be
 * matched back against the provider's own documentation. When the refusal is
 * ours rather than Shopee's the value is {@link codigoDoErp}'s, which is the
 * one place that spelling lives.
 *
 * ## ⚠️ NAMED RESIDUAL — a listing split into PARTS has several writers
 *
 * The chunker emits one task per `parte`, and every part runs the sender end to
 * end, so a listing with more models than one call may carry produces several
 * independent callers of these functions against the SAME link document. Two
 * consequences, neither of which this module can fix on its own:
 *
 *  - `estoqueEnviado` and `estoqueModelosEnviados` describe the part that
 *    landed LAST, not the listing. That matches the fields' own declared
 *    meaning ("how many models the last call carried") and is fine.
 *  - a CLEAN part and a REFUSED part interleave, and the clean one clears the
 *    refused one's fingerprint. Last writer wins, and the loser is dropped
 *    silently. It is bounded — the next tick re-derives both halves from
 *    scratch, because nothing here is read back to decide what to send — but a
 *    caller that splits a listing owes a decision about which part is allowed
 *    to declare the listing clean. `parte` / `totalDePartes` are on the task
 *    payload precisely so that decision is expressible.
 *
 * ## Clock-free, framework-free, and no concurrency machinery
 *
 * `nowMs` is a PARAMETER — the tick's instant, read once by the caller and
 * threaded through every write, in MILLISECONDS like every other stamp in this
 * folder. Nothing here reads a clock, builds a server-framework response, or
 * reaches for the repo's optimistic-concurrency helper: each patch is a set of
 * scalars derived from what the sender has just observed, and none of them is
 * derived from a value read back out of the document it patches.
 *
 * ⚠️ `ultimaModificacao` rides every write, and that is safe by measurement
 * rather than by hope: `onProdutoShopeeLinkChanged` decides from the event
 * payload alone and reads only `item_id`, `estadoAnuncio` and the conta ref, so
 * a patch touching none of the three plans zero reads and zero writes. There is
 * no `variashopee` trigger at all.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  MOTIVO_ESTOQUE_SHOPEE,
  type MotivoEstoqueShopee,
  limitarMensagemEstoque,
} from './errosEstoque';

/* -------------------------------------------------------------------------- */
/*                              the field lists                                */
/* -------------------------------------------------------------------------- */

/**
 * The COMPLETE list of parent-link fields this module may write — what a test
 * compares a clean send's patch against, and nothing more.
 *
 * ⚠️ It is not decoration. {@link registrarEnvioLimpo}'s patch is typed TOTAL
 * over this list, so the list and the clearer move together or neither
 * compiles: adding a field to the schema and to this list without deciding what
 * a clean send writes to it is a compile error rather than a field that quietly
 * survives the one write that is supposed to clear everything.
 */
export const CAMPOS_DO_PATCH_DE_ESTOQUE = [
  'estoqueEnviadoEm',
  'estoqueEnviado',
  'estoqueModelosEnviados',
  'estoqueRecusaEm',
  'estoqueRecusaCodigo',
  'estoqueRecusaMotivo',
  'estoqueRecusaMensagem',
  'estoqueRecusaEstado',
  'estoqueRecusaItemStatus',
  'estoqueRecusaAte',
  'ultimaModificacao',
] as const;

type CampoDoPatchDeEstoque = (typeof CAMPOS_DO_PATCH_DE_ESTOQUE)[number];

/**
 * A parent patch: a SUBSET of the declared fields, scalars only.
 *
 * The type is what makes "FLAT" a compile-time property rather than a comment —
 * a nested object or an invented field name is rejected here, long before
 * `mergeIfExists` would have thrown at run time.
 */
type PatchDeEstoque = Partial<Record<CampoDoPatchDeEstoque, number | string | null>>;

/** The clean send's patch: TOTAL over the list above. */
type PatchDeEnvioLimpo = Record<CampoDoPatchDeEstoque, number | null>;

/**
 * The child link's three fields, TOTAL: a per-model refusal always writes all
 * three and only these three.
 *
 * ⚠️ A type rather than an exported list, unlike the parent's, and the
 * asymmetry is the point: the parent list exists because a CLEARER has to stay
 * in step with it, and the child has no clearer to keep in step with — see
 * {@link registrarRecusaDeModelo}. A second list here would be a list with one
 * reader and an invitation to grow the counterpart it deliberately lacks.
 */
type PatchDoModelo = Record<
  'estoqueRecusaEm' | 'estoqueRecusaCodigo' | 'ultimaModificacao',
  number | string
>;

/* -------------------------------------------------------------------------- */
/*                                  the targets                                */
/* -------------------------------------------------------------------------- */

/**
 * One parent listing link — `produtos/{produtoId}/prodshopee/{linkDocId}`.
 *
 * ⚠️ `integracaoId` identifies nothing about the document (the pair
 * `produtoId` + `linkDocId` already does) and is REQUIRED anyway: it is what
 * the "the link vanished" warning names, and one produto legitimately carries
 * one link per conta, so a log line without it cannot say whose sync lost the
 * write.
 */
export interface AlvoDoLink {
  readonly integracaoId: string;
  readonly produtoId: string;
  readonly linkDocId: string;
}

/**
 * One child variation link — `produtos/{produtoId}/variashopee/{varLinkDocId}`.
 *
 * ⚠️ `produtoId` is the CHILD produto's — the one that owns the stock — never
 * the family anchor's. A child link doc lives under the child.
 */
export interface AlvoDaVariacao {
  readonly integracaoId: string;
  readonly produtoId: string;
  readonly varLinkDocId: string;
}

/* -------------------------------------------------------------------------- */
/*                              the four outcomes                              */
/* -------------------------------------------------------------------------- */

/** A send in which every model Shopee answered about was accepted. */
export interface EnvioLimpo {
  /** MILLISECONDS — the tick's instant, read once by the caller. */
  readonly nowMs: number;
  /**
   * What was SENT: the no-model listing's quantity, or the **SUM** across the
   * accepted models.
   *
   * ⚠️ A sum, not a maximum — it is `ResultadoEnvioEstoqueShopee.quantidadeEnviada`
   * verbatim, which accumulates over the accepted models, and the total is what
   * a diff against the ledger wants. A twenty-model family at 5 each stores
   * 100, never 5.
   */
  readonly quantidade: number;
  /** How many models this `update_stock` call carried. */
  readonly modelos: number;
}

/** A send in which some models were accepted and at least one was refused. */
export interface EnvioParcial {
  /** MILLISECONDS — the tick's instant. */
  readonly nowMs: number;
  /** What was SENT, over the models that were accepted. */
  readonly quantidade: number;
  /** How many models this `update_stock` call carried — accepted and refused. */
  readonly modelos: number;
  /**
   * The FIRST refused model's `failed_reason`, VERBATIM.
   *
   * ⚠️ The first, not a join: the parent field is a pointer at the diagnosis,
   * and the per-model rows are the diagnosis. Concatenating fifty reasons into
   * one capped string would truncate the one that mattered.
   */
  readonly codigo: string;
  /** Rendered pt-BR for the operator — capped here, never at a call site. */
  readonly mensagem: string;
}

/** A refusal that applies to the whole listing. */
export interface RecusaDeEstoque {
  /** MILLISECONDS — the tick's instant. */
  readonly nowMs: number;
  /** This app's own vocabulary for WHY. */
  readonly motivo: MotivoEstoqueShopee;
  /** Shopee's code VERBATIM, or {@link codigoDoErp}'s when the refusal is ours. */
  readonly codigo: string;
  /** Rendered pt-BR for the operator — capped here, never at a call site. */
  readonly mensagem: string;
  /**
   * The folded `estadoAnuncio` AT REFUSAL TIME — half the fingerprint.
   *
   * ⚠️ Carried exactly as read, `null` included: `null` is what a column that
   * was never written looks like, and the skip set compares two RECORDED
   * READINGS for identity. Inventing a value here arms a skip against a reading
   * nobody took.
   */
  readonly estadoAnuncio: string | null;
  /** The raw `item_status` at refusal time — the other half, same rule. */
  readonly itemStatus: string | null;
  /**
   * MILLISECONDS. The TIME half of the skip set — omit it for every refusal a
   * future reading can lift.
   *
   * ⚠️ Only the promotion arm supplies it, and only because a promotion ending
   * moves no `item_status`: a fingerprint-based skip would latch for ever on a
   * listing whose reserved stock simply expired.
   */
  readonly ate?: number | null;
}

/** A refusal that applies to ONE model of a listing. */
export interface RecusaDeModelo {
  /** MILLISECONDS — the tick's instant. */
  readonly nowMs: number;
  /** This model's own `failed_reason`, VERBATIM. */
  readonly codigo: string;
}

/* -------------------------------------------------------------------------- */
/*                                   the code                                  */
/* -------------------------------------------------------------------------- */

/**
 * The stored code for a refusal that is OURS rather than Shopee's.
 *
 * One spelling, in one place. The sender refuses on its own account in several
 * arms, and `erp:` re-typed at each of them is how the same fact ends up stored
 * under `erp-`, `erp/` and `erp:` in the same collection — with nothing failing,
 * because the field is a loose string that no reader parses today.
 */
export function codigoDoErp(motivo: MotivoEstoqueShopee): string {
  return `erp:${motivo}`;
}

/* -------------------------------------------------------------------------- */
/*                                  the writes                                 */
/* -------------------------------------------------------------------------- */

/**
 * `update()` through the parent handle, with the NOT_FOUND narrow
 * `mergeIfExists` already owns.
 *
 * `false` ⇒ the link was deleted between the plan and the write. That is not a
 * failure and it is never an error: one warning, and the caller decides what
 * the listing's outcome was without this write.
 *
 * ⚠️ The warning carries IDENTIFIERS and never a body. A patch printed into a
 * log is a second copy of a stored value, free to outlive it.
 */
async function escreverNoLink(
  db: Firestore,
  alvo: AlvoDoLink,
  patch: PatchDeEstoque,
): Promise<boolean> {
  const escrito = await produtoShopeeLinkCollection.mergeIfExists(
    db,
    { produtoId: alvo.produtoId },
    alvo.linkDocId,
    patch,
  );
  if (!escrito) {
    console.warn('[shopee/estoque] vínculo de listagem desapareceu antes da escrita', {
      integracaoId: alvo.integracaoId,
      produtoId: alvo.produtoId,
      linkDocId: alvo.linkDocId,
    });
  }
  return escrito;
}

/** The child twin of {@link escreverNoLink}, over the variation handle. */
async function escreverNaVariacao(
  db: Firestore,
  alvo: AlvoDaVariacao,
  patch: PatchDoModelo,
): Promise<boolean> {
  const escrito = await variacaoShopeeLinkCollection.mergeIfExists(
    db,
    { produtoId: alvo.produtoId },
    alvo.varLinkDocId,
    patch,
  );
  if (!escrito) {
    console.warn('[shopee/estoque] vínculo de variação desapareceu antes da escrita', {
      integracaoId: alvo.integracaoId,
      produtoId: alvo.produtoId,
      varLinkDocId: alvo.varLinkDocId,
    });
  }
  return escrito;
}

/**
 * A CLEAN send: every model Shopee answered about was accepted.
 *
 * ⚠️ **The one clearer.** It stamps `estoqueEnviadoEm` and nulls all six
 * `estoqueRecusa*` fields — `null`, never absent, because a reader must be able
 * to tell "diagnosed and then fixed" from "never diagnosed", and because
 * nulling all six is what clears BOTH halves of the skip set at once: the TIME
 * mechanism reads `estoqueRecusaAte`, and the STATE one needs a non-null
 * `estoqueRecusaEm` beside at least one recorded reading.
 *
 * Resolves `false` when the link was already gone.
 */
export async function registrarEnvioLimpo(
  db: Firestore,
  alvo: AlvoDoLink,
  p: EnvioLimpo,
): Promise<boolean> {
  // TOTAL over CAMPOS_DO_PATCH_DE_ESTOQUE by TYPE: a field added to the list
  // and forgotten here does not compile.
  const patch: PatchDeEnvioLimpo = {
    estoqueEnviadoEm: p.nowMs,
    estoqueEnviado: p.quantidade,
    estoqueModelosEnviados: p.modelos,
    estoqueRecusaEm: null,
    estoqueRecusaCodigo: null,
    estoqueRecusaMotivo: null,
    estoqueRecusaMensagem: null,
    estoqueRecusaEstado: null,
    estoqueRecusaItemStatus: null,
    estoqueRecusaAte: null,
    ultimaModificacao: p.nowMs,
  };
  return escreverNoLink(db, alvo, patch);
}

/**
 * A PARTIAL send: some models landed, at least one was refused.
 *
 * ⚠️ It stamps `estoqueRecusaEm` and deliberately does NOT stamp
 * `estoqueEnviadoEm` — see the module docblock; the child rows' visibility
 * depends on that omission, so this is a mechanism and not a nicety.
 *
 * ⚠️ It writes NO fingerprint and NO `estoqueRecusaAte`. A partial is not a
 * property of the listing's state: re-sending the same listing in the next tick
 * is what should happen, and arming a skip here would suppress the retry that
 * fixes it.
 *
 * ⚠️ **And it really does not arm one — that is a property of the GATE, not of
 * this key set.** The state mechanism never asked whether the two halves were
 * WRITTEN; it compares them. What makes the omission mean what it says is
 * `pularPorRecusaAnterior`'s requirement that at least ONE of the two RECORDED
 * readings be non-null (`podeEnviarEstoque.ts`): this patch records neither, so
 * the STATE half cannot fire whatever the link happens to read. That closes the
 * corner a merge would otherwise open — on a link whose `estadoAnuncio` and
 * `item_status` both read null or absent (every link a clean send has just
 * cleared, and every step-9 import that folded an unknown status) the stamped
 * `estoqueRecusaEm` used to meet `null === null` on both halves and latch
 * `recusa-anterior` for ever, with nothing left that could move to lift it.
 *
 * ⚠️ A STALE fingerprint left by an earlier refusal survives this merge and is
 * still compared — that is deliberate and is the same rule as everywhere else:
 * a recorded reading is lifted by the reading MOVING, and a partial moves
 * nothing. Do not "improve" this writer by nulling the two halves; the gate,
 * not the patch, is where "no recorded state" is decided.
 *
 * Resolves `false` when the link was already gone.
 */
export async function registrarEnvioParcial(
  db: Firestore,
  alvo: AlvoDoLink,
  p: EnvioParcial,
): Promise<boolean> {
  const patch: PatchDeEstoque = {
    estoqueEnviado: p.quantidade,
    estoqueModelosEnviados: p.modelos,
    estoqueRecusaEm: p.nowMs,
    estoqueRecusaCodigo: p.codigo,
    estoqueRecusaMotivo: MOTIVO_ESTOQUE_SHOPEE.envioParcial,
    estoqueRecusaMensagem: limitarMensagemEstoque(p.mensagem),
    ultimaModificacao: p.nowMs,
  };
  return escreverNoLink(db, alvo, patch);
}

/**
 * A refusal covering the whole listing.
 *
 * It records the diagnosis AND both fingerprint halves, so the gate can skip
 * this listing until one of the two readings moves. It writes no quantity: a
 * refused send sent nothing, and leaving the previous `estoqueEnviado` in place
 * keeps the honest answer to "what does Shopee currently hold".
 *
 * Resolves `false` when the link was already gone.
 */
export async function registrarRecusaDeEstoque(
  db: Firestore,
  alvo: AlvoDoLink,
  p: RecusaDeEstoque,
): Promise<boolean> {
  const patch: PatchDeEstoque = {
    estoqueRecusaEm: p.nowMs,
    estoqueRecusaCodigo: p.codigo,
    estoqueRecusaMotivo: p.motivo,
    estoqueRecusaMensagem: limitarMensagemEstoque(p.mensagem),
    estoqueRecusaEstado: p.estadoAnuncio,
    estoqueRecusaItemStatus: p.itemStatus,
    // `?? null` and never `|| null`: `0` is not a legal instant here, but the
    // habit is what matters — a falsy-but-legal value must not become an
    // omission, and this field's absence means "no time skip".
    estoqueRecusaAte: p.ate ?? null,
    ultimaModificacao: p.nowMs,
  };
  return escreverNoLink(db, alvo, patch);
}

/**
 * A refusal covering ONE model.
 *
 * Three keys, on the CHILD link document, and no counterpart that clears them:
 * the row is legible exactly while `estoqueRecusaEm` is at least the parent's
 * `estoqueEnviadoEm`, so a stale diagnosis vanishes the moment the listing next
 * syncs cleanly and a current one stays — at the cost of no second writer at
 * all.
 *
 * ⚠️ There is no `limpar…` counterpart anywhere in this module, and adding one
 * would re-introduce exactly the per-model-per-send write the comparison exists
 * to avoid.
 *
 * Resolves `false` when the child link was already gone.
 */
export async function registrarRecusaDeModelo(
  db: Firestore,
  alvo: AlvoDaVariacao,
  p: RecusaDeModelo,
): Promise<boolean> {
  const patch: PatchDoModelo = {
    estoqueRecusaEm: p.nowMs,
    estoqueRecusaCodigo: p.codigo,
    ultimaModificacao: p.nowMs,
  };
  return escreverNaVariacao(db, alvo, patch);
}
