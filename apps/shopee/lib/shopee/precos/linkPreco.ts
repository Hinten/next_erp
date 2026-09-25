/**
 * **The price write-backs** (#1521, step 13) — the ONE module that records a
 * price outcome on a Shopee link document.
 *
 * Four functions for four outcomes, two per document: the listing's CLEAN send
 * and its REFUSAL on `prodshopee`, and one MODEL's accepted price and its
 * refusal on `variashopee`. The price sender (`./enviarPreco`) is their only
 * caller and nothing else in this app may touch the ten `preco*` fields, so
 * "what does the stored diagnosis mean" is answerable by reading one file
 * rather than by reconciling call sites that each remember half the rule. The
 * decision of WHICH outcome to record — including whether a refusal stamps at
 * all (`MOTIVOS_QUE_CARIMBAM`) — is the sender's; this module writes what it is
 * handed and decides nothing.
 *
 * ## ⚠️ ONE clearer, and it is the CLEAN send
 *
 * {@link registrarPrecoLimpo} is the only function that writes `null` to the
 * four `precoRecusa*` fields of the item, and it writes ALL four: its patch is
 * TOTAL over {@link CAMPOS_DO_PATCH_DE_PRECO} and the compiler checks that — a
 * name added to the list without a value here does not compile, a value whose
 * name is not on the list does not compile, and a name on the list that the
 * link schema does not declare does not compile either.
 *
 * ## ⚠️ What writes NOTHING — the sender's rules, restated so no one "fixes" them here
 *
 * An equal price (Shopee already shows the target, so nothing was sent) never
 * stamps a success: `precoEnviado` means "the price THIS ERP sent", and an
 * equal reading may be a Seller Centre edit that happens to match — stamping it
 * would attribute the seller's price to us (reconcile C-n). A promotion lock
 * never stamps a refusal (the listing is not wrong, the price is frozen). An
 * echo or read-back mismatch never stamps either side. A skip, a pause and a
 * rethrown error leave every field alone. There is therefore no function here
 * for any of them, and adding one is the regression.
 *
 * ## ⚠️ A refusal does NOT touch the success pair, and a partial does NOT clear
 *
 * {@link registrarRecusaDePreco} writes the four refusal fields and leaves
 * `precoEnviado` / `precoEnviadoEm` as they were: a refused send sent nothing,
 * and the previous `precoEnviado` is still the honest answer to "what did this
 * ERP last get accepted". A PARTIAL send uses the same writer for the item —
 * the item-level success stamp means "the WHOLE item was in sync", and a
 * partial must not claim it.
 *
 * ## ⚠️ The model rows self-expire — there are ZERO clearing writes on a child
 *
 * A model's refusal is compared against its OWN success stamp on the SAME
 * `variashopee` doc: a reader shows it only while
 * `precoRecusaEm >= (precoEnviadoEm ?? 0)` (the schema's docblock pins that
 * rule). Every accepted send of the model stamps a fresh `precoEnviadoEm`, so a
 * stale refusal vanishes the moment the model is next accepted, and no child
 * write here ever carries a `null`. Unlike step 12's stock rows, the comparison
 * is NOT against the parent's stamp.
 *
 * ## ⚠️ Every patch is FLAT, and every write is `mergeIfExists`
 *
 * The handles' `mergeIfExists` is `update()` plus a NOT_FOUND narrow, and it
 * throws a `TypeError` on a nested plain object or a dotted key. It is **not**
 * an upsert: a link deleted between the plan and the write answers `false` and
 * STAYS deleted, where the plain merge would resurrect it as a ghost carrying
 * only these keys and none of the schema's required ones. `false` is not a
 * failure — one `console.warn` naming the conta and the document (never a
 * body), and the caller carries on with its own accounting. The writes are
 * SEQUENTIAL and per document on purpose: a batch of `update`s fails WHOLE on
 * one deleted doc, while `mergeIfExists` answers per doc.
 *
 * ## ⚠️ The code is stored VERBATIM; the message is capped
 *
 * `precoRecusaCodigo` keeps Shopee's string exactly as it arrived — module
 * prefix and all, or a model's free-text `failed_reason` — or the sender's
 * `erp:<motivo>` when the refusal is ours. The stripped form exists for
 * CLASSIFICATION only. `precoRecusaMensagem` goes through the app's ONE message
 * cap (the publish problema's, which stock also delegates to), and a refusal
 * with no provider message stores `null` PRESENT, so an earlier refusal's text
 * can never survive beside a newer code.
 *
 * ## Rule 7 — the race tier
 *
 * None of the ten fields is ever read to DECIDE a send: the sender decides from
 * Shopee's own reading of the listing, taken for that send (a no-model
 * listing's base row is the request's batch — `./leitorDeBase` states that
 * bound). That is tier (0) by design (the race is made irrelevant to the
 * DECISION, not survived): no transaction, no precondition, and no row in the
 * transaction inventory. A future reader that DECIDES from these fields (the
 * push-22 correlation, register 142) must re-decide the tier.
 *
 * ⚠️ What a lost race — the manual push and the job on one item, two
 * operators, a retry — CAN leave is a stale DIAGNOSTIC, and it stays stale
 * until the next send that CHANGES the price: a `preco-igual` send writes
 * nothing here, so a late write-back (a success pair of 15 landing after a
 * newer send of 12 already did) stands for as long as the price holds. And the
 * item's refusal fields are cleared by a `null` write rather than expired by a
 * stamp, so a refusal that lands AFTER a newer clean clear stands beside the
 * newer `precoEnviadoEm`. The step-21 reader therefore shows the item's refusal
 * only while `precoRecusaEm >= (precoEnviadoEm ?? 0)` — the model rows' rule
 * (above), which survives this race where the `null` clear does not.
 *
 * ## Clock-free, framework-free
 *
 * `nowMs` is a PARAMETER — the instant the caller read once — in MILLISECONDS
 * like every stamp in this folder. `ultimaModificacao` rides every write in the
 * same unit; it is an UNDECLARED pass-through on both link docs (register 141:
 * publish and pause already write it in ms, the legacy wrote a Dart DateTime).
 * The listing-link trigger decides from its event payload alone and none of
 * the keys written here is a membership field it reads, so these patches cost
 * it zero reads (step 12 measured the same for its stock patches); there is no
 * `variashopee` trigger at all.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import type { produtoShopeeLinkSchema, variacaoShopeeLinkSchema } from '@delfrance/schemas';

import { limitarMensagemProblema } from '../anuncios/errosPublicacao';
import type { MotivoPrecoShopee } from './errosPreco';

/* -------------------------------------------------------------------------- */
/*                              the field lists                                */
/* -------------------------------------------------------------------------- */

/**
 * A field the ITEM link schema declares. Read off the schema's `shape`, never
 * off its inferred type: the schema is `.passthrough()`, so its inferred type
 * carries a string index signature and `keyof` would accept any spelling.
 */
type CampoDeclaradoDoItem = keyof (typeof produtoShopeeLinkSchema)['shape'];

/** A field the MODEL link schema declares — same reason as above. */
type CampoDeclaradoDoModelo = keyof (typeof variacaoShopeeLinkSchema)['shape'];

/**
 * The undeclared pass-through every write carries (register 141) — the one
 * name on these lists the schema does not own.
 */
type CampoNaoDeclarado = 'ultimaModificacao';

/**
 * The COMPLETE list of item-link fields this module may write — the six
 * `preco*` scalars plus `ultimaModificacao`, and nothing more. It is what a
 * test compares a clean send's patch against.
 *
 * ⚠️ It is not decoration. {@link registrarPrecoLimpo}'s patch is typed TOTAL
 * over this list and {@link registrarRecusaDePreco}'s over the list minus the
 * success pair, so the list and both writers move together or nothing compiles;
 * and the `satisfies` binds every name to the schema's own spelling.
 */
export const CAMPOS_DO_PATCH_DE_PRECO = [
  'precoEnviado',
  'precoEnviadoEm',
  'precoRecusaEm',
  'precoRecusaCodigo',
  'precoRecusaMotivo',
  'precoRecusaMensagem',
  'ultimaModificacao',
] as const satisfies readonly (CampoDeclaradoDoItem | CampoNaoDeclarado)[];

type CampoDoPatchDePreco = (typeof CAMPOS_DO_PATCH_DE_PRECO)[number];

/** The success pair — what a refusal must never touch. */
type CampoDeSucesso = 'precoEnviado' | 'precoEnviadoEm';

/**
 * Any item patch: a SUBSET of the listed fields, scalars only. The type makes
 * "FLAT" a compile-time property — a nested object or an invented name is
 * rejected here, long before `mergeIfExists` would throw at run time.
 */
type PatchDePreco = Partial<Record<CampoDoPatchDePreco, number | string | null>>;

/** The clean send's patch: TOTAL over the list. */
type PatchDePrecoLimpo = Record<CampoDoPatchDePreco, number | null>;

/** The refusal's patch: TOTAL over the list minus the success pair. */
type PatchDeRecusaDePreco = Record<
  Exclude<CampoDoPatchDePreco, CampoDeSucesso>,
  number | string | null
>;

/** Binds a model field name to the model schema's own spelling. */
type DoModelo<K extends CampoDeclaradoDoModelo> = K;

/**
 * A model's accepted price — TOTAL: always all three, and only these three.
 *
 * ⚠️ Types rather than an exported list, unlike the item's, and the asymmetry
 * is the point: the item list exists because a CLEARER has to stay in step with
 * it, and the model has no clearer.
 */
type PatchDePrecoDoModelo = Record<
  DoModelo<'precoEnviado' | 'precoEnviadoEm'> | CampoNaoDeclarado,
  number
>;

/** A model's refusal — TOTAL: always all three, and only these three. */
type PatchDeRecusaDoModelo = Record<
  DoModelo<'precoRecusaEm' | 'precoRecusaCodigo'> | CampoNaoDeclarado,
  number | string
>;

/* -------------------------------------------------------------------------- */
/*                                  the targets                                */
/* -------------------------------------------------------------------------- */

/**
 * One item link — `produtos/{produtoId}/prodshopee/{linkDocId}`.
 *
 * ⚠️ `integracaoId` addresses nothing (the pair `produtoId` + `linkDocId`
 * already does) and is REQUIRED anyway: it is what the "the link vanished"
 * warning names, and one produto legitimately carries one link per conta, so a
 * log line without it cannot say whose sync lost the write.
 */
export interface AlvoDoLinkPreco {
  readonly integracaoId: string;
  readonly produtoId: string;
  readonly linkDocId: string;
}

/**
 * One model link — `produtos/{produtoId}/variashopee/{varLinkDocId}`.
 *
 * ⚠️ `produtoId` is the CHILD produto's — the one the model belongs to — never
 * the family anchor's. A model link doc lives under the child.
 */
export interface AlvoDaVariacaoPreco {
  readonly integracaoId: string;
  readonly produtoId: string;
  readonly varLinkDocId: string;
}

/* -------------------------------------------------------------------------- */
/*                               the four inputs                               */
/* -------------------------------------------------------------------------- */

/** The whole item is in sync: every sent model accepted and verified. */
export interface PrecoLimpo {
  /**
   * The price sent and accepted for a NO-MODEL item; `null` for a HAS-MODEL
   * item, whose prices live one per model. Written as handed — the sender
   * already `roundReais`'d what it sent.
   */
  readonly precoEnviado: number | null;
  /** MILLISECONDS — the instant the caller read once. */
  readonly nowMs: number;
}

/** A refusal recorded on the item (a deterministic `falha`, or a partial). */
export interface RecusaDePreco {
  /** Shopee's code VERBATIM, or the sender's `erp:<motivo>` when it is ours. */
  readonly codigo: string;
  /** This app's own vocabulary for WHY — rendered to pt-BR at read time. */
  readonly motivo: MotivoPrecoShopee;
  /** Shopee's message when Shopee gave one (capped here); `null` otherwise. */
  readonly mensagem: string | null;
  /** MILLISECONDS. */
  readonly nowMs: number;
}

/** One model's price, sent and accepted. */
export interface PrecoDeModelo {
  /** The price sent for this model, as handed (already `roundReais`'d). */
  readonly preco: number;
  /** MILLISECONDS. */
  readonly nowMs: number;
}

/** One model's refusal, of a stamping class. */
export interface RecusaDeModeloPreco {
  /**
   * Shopee's `failed_reason` or refusal code VERBATIM, or the sender's
   * `erp:<motivo>` when the refusal is ours — a child is also stamped with the
   * call's top-level code or a refused read's, not only with its own row's
   * reason.
   */
  readonly codigo: string;
  /** MILLISECONDS. */
  readonly nowMs: number;
}

/* -------------------------------------------------------------------------- */
/*                                  the writes                                 */
/* -------------------------------------------------------------------------- */

/**
 * `update()` through the item handle, with the NOT_FOUND narrow
 * `mergeIfExists` already owns. `false` ⇒ the link was deleted between the plan
 * and the write: one warning with IDENTIFIERS and never a body — a patch
 * printed into a log is a second copy of a stored value, free to outlive it.
 */
async function escreverNoLink(
  db: Firestore,
  alvo: AlvoDoLinkPreco,
  patch: PatchDePreco,
): Promise<boolean> {
  const escrito = await produtoShopeeLinkCollection.mergeIfExists(
    db,
    { produtoId: alvo.produtoId },
    alvo.linkDocId,
    patch,
  );
  if (!escrito) {
    console.warn('[shopee/precos] vínculo de listagem desapareceu antes da escrita', {
      integracaoId: alvo.integracaoId,
      produtoId: alvo.produtoId,
      linkDocId: alvo.linkDocId,
    });
  }
  return escrito;
}

/** The model twin of {@link escreverNoLink}, over the variation handle. */
async function escreverNaVariacao(
  db: Firestore,
  alvo: AlvoDaVariacaoPreco,
  patch: PatchDePrecoDoModelo | PatchDeRecusaDoModelo,
): Promise<boolean> {
  const escrito = await variacaoShopeeLinkCollection.mergeIfExists(
    db,
    { produtoId: alvo.produtoId },
    alvo.varLinkDocId,
    patch,
  );
  if (!escrito) {
    console.warn('[shopee/precos] vínculo de variação desapareceu antes da escrita', {
      integracaoId: alvo.integracaoId,
      produtoId: alvo.produtoId,
      varLinkDocId: alvo.varLinkDocId,
    });
  }
  return escrito;
}

/**
 * A CLEAN send: the whole item is in sync.
 *
 * ⚠️ **The one clearer.** It stamps `precoEnviadoEm` and nulls all four
 * `precoRecusa*` fields — `null`, never absent, because a reader must tell
 * "diagnosed and then fixed" from "never diagnosed". `precoEnviado` is the
 * caller's: the sent price for a no-model item, `null` for a has-model one
 * (which also retires a no-model price left behind by an earlier shape).
 *
 * Resolves `false` when the link was already gone.
 */
export async function registrarPrecoLimpo(
  db: Firestore,
  alvo: AlvoDoLinkPreco,
  v: PrecoLimpo,
): Promise<boolean> {
  // TOTAL over CAMPOS_DO_PATCH_DE_PRECO by TYPE: a field added to the list and
  // forgotten here does not compile.
  const patch: PatchDePrecoLimpo = {
    precoEnviado: v.precoEnviado,
    precoEnviadoEm: v.nowMs,
    precoRecusaEm: null,
    precoRecusaCodigo: null,
    precoRecusaMotivo: null,
    precoRecusaMensagem: null,
    ultimaModificacao: v.nowMs,
  };
  return escreverNoLink(db, alvo, patch);
}

/**
 * A refusal recorded on the ITEM — a deterministic `falha` of a stamping
 * class, or a partial send whose refused model was one.
 *
 * It writes the four refusal fields and deliberately NOT the success pair (see
 * the module docblock). `mensagem: null` is written as a PRESENT `null`: the
 * new code must never sit beside an earlier refusal's provider text.
 *
 * Resolves `false` when the link was already gone.
 */
export async function registrarRecusaDePreco(
  db: Firestore,
  alvo: AlvoDoLinkPreco,
  v: RecusaDePreco,
): Promise<boolean> {
  const patch: PatchDeRecusaDePreco = {
    precoRecusaEm: v.nowMs,
    precoRecusaCodigo: v.codigo,
    precoRecusaMotivo: v.motivo,
    precoRecusaMensagem: v.mensagem === null ? null : limitarMensagemProblema(v.mensagem),
    ultimaModificacao: v.nowMs,
  };
  return escreverNoLink(db, alvo, patch);
}

/**
 * One MODEL's price, sent and accepted — its own success pair, on the child.
 *
 * Written on every accepted model of a send, clean or partial: the pair is what
 * expires that model's earlier refusal (the comparison is on this same doc).
 *
 * Resolves `false` when the model link was already gone.
 */
export async function registrarPrecoDeModelo(
  db: Firestore,
  alvo: AlvoDaVariacaoPreco,
  v: PrecoDeModelo,
): Promise<boolean> {
  const patch: PatchDePrecoDoModelo = {
    precoEnviado: v.preco,
    precoEnviadoEm: v.nowMs,
    ultimaModificacao: v.nowMs,
  };
  return escreverNaVariacao(db, alvo, patch);
}

/**
 * One MODEL's refusal, of a stamping class — three keys on the child, and no
 * counterpart that clears them: the model's next accepted send expires the row
 * by comparison, at the cost of no second writer at all.
 *
 * Resolves `false` when the model link was already gone.
 */
export async function registrarRecusaDeModelo(
  db: Firestore,
  alvo: AlvoDaVariacaoPreco,
  v: RecusaDeModeloPreco,
): Promise<boolean> {
  const patch: PatchDeRecusaDoModelo = {
    precoRecusaEm: v.nowMs,
    precoRecusaCodigo: v.codigo,
    ultimaModificacao: v.nowMs,
  };
  return escreverNaVariacao(db, alvo, patch);
}
