/**
 * **The publish LOCK of a DRAFT** (#1911, D4 + D15) — how one run of the item
 * publish takes a draft (`ehRascunhoShopee`) for its FIRST `add_item`, sends
 * under it, and hands it back.
 *
 * A draft's first create is the one write of a publish that is NOT safe to
 * repeat: `add_item` is not idempotent, so two runs that both send it create two
 * listings. The lock is what makes "two runs both send" impossible, and every
 * step below exists to keep it honest:
 *
 *  1. **Reserve** ({@link reservarRascunhoShopee}) BEFORE the run reads the
 *     content it will send — rule 7 tier 1: `update({publicacaoEmCurso},
 *     {lastUpdateTime})` against the snapshot that decided, ≤ 3 re-derives
 *     (never a re-apply). A live lock (incl. its post-expiry grace) ⇒ 409
 *     `EM_ANDAMENTO`; a lock past the grace, or a recorded uncertain create ⇒
 *     409 `CRIACAO_INCERTA` (#1911's P5 turns that branch into a search); the
 *     document is no longer a draft ⇒ 409 `JA_PUBLICADO`; gone ⇒ the route's 404.
 *     Then, **lock-then-scan** (D15): the produto's other links of this conta —
 *     one subcollection read, no index ({@link lerVinculosDaConta}). Any of
 *     them locked or uncertain ⇒ release ours, 409 `EM_ANDAMENTO` (confirmed or
 *     not); `vinculosQueExigemConfirmacaoShopee` non-empty and the request did
 *     not confirm a SECOND listing ⇒ release ours, 409 `CONTA_JA_TEM_ANUNCIO`.
 *     Two reservations of one produto cannot both pass: each WRITES before it
 *     READS, so the later scanner sees the earlier lock (both may abort — a
 *     liveness cost only; the operator retries).
 *  2. **Re-read before the send** ({@link conferirTravaAntesDoEnvio}): the
 *     stored token must still be OURS, or nothing is sent.
 *  3. **The per-leg send gate** ({@link portaoDeEnvio}) — SYNCHRONOUS, run
 *     immediately before EACH `client.addItem` call (both legs of the fiscal
 *     retry): send only while `agora() + MARGEM_ENVIO_SHOPEE_MS <
 *     min(expiraEm, prazoDaRequisicao)`. So no create STARTS at or after
 *     `expiraEm − MARGEM`, and none starts that the route's own ceiling could
 *     cut off mid-send. That bound is what the post-expiry grace of
 *     `estadoPublicacaoRascunhoShopee` is measured from.
 *  4. **Write-back #1 on a draft is a CLAIM** ({@link reivindicarRascunhoShopee}):
 *     still a draft ⇒ `update({…the item, publicacaoEmCurso: null},
 *     {lastUpdateTime})`; already ours (a replay) ⇒ the plain merge; claimed
 *     by ANOTHER item or deleted ⇒ `add` a fresh link — two LINKED listings,
 *     never an orphan. The claim ignores the token on purpose: the listing
 *     exists and needs its link, and clearing a foreign lock makes its holder's
 *     re-read refuse to send.
 *  5. **Release** ({@link liberarTravaShopee}) — token-guarded: the stored
 *     token must be OURS, else NOTHING is written (a foreign lock is never
 *     cleared, a winner is never overwritten — not even by a failure stamp).
 *     A way out that is already REPORTING an error releases through
 *     {@link liberarTravaShopeeSemSubstituirErro}, so a failed release never
 *     replaces that error.
 *
 * ⚠️ **What happens to the lock on each way out** is the caller's half
 * (`publicarAnuncio.ts`), tracked on {@link ReservaDeRascunhoShopee.fase}:
 * nothing outstanding ⇒ released, no stamp; an `add_item` Shopee refused for
 * good (`nao-criado`, `criacaoIncerta.ts`'s classifier) ⇒ released WITH the
 * `falhaPublicacao` stamp in the same guarded write; an outcome nobody can know
 * (`incerto`, or any non-Shopee error once a send began) ⇒ the lock is KEPT —
 * it expires, then the grace, then reads `incerta`, and the next publish is
 * refused rather than sent again.
 *
 * Clock-free and Next-free like the rest of `anuncios/`: every instant comes
 * from the route's clock through `agora`, a REQUIRED parameter with no
 * fallback — a constant clock would make the send gate vacuous. Every Firestore
 * access goes through a `@delfrance/data/admin/collections` handle, and nothing
 * here opens a multi-document atomic write: every guard is a single-document
 * precondition.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  CODIGO_RASCUNHO_SHOPEE,
  MARGEM_ENVIO_SHOPEE_MS,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  ehRascunhoShopee,
  estadoPublicacaoRascunhoShopee,
  publicacaoEmCursoShopeeSchema,
  vinculoShopeeEhDaConta,
  vinculosQueExigemConfirmacaoShopee,
  type CodigoRascunhoShopee,
  type PublicacaoEmCursoShopee,
  type VinculoConflitanteShopee,
} from '@delfrance/schemas';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';

import { aplicarLinkDaListagem } from '../produtos/links';
import { lerVinculosDaConta } from './linkAnuncio';

/* -------------------------------------------------------------------------- */
/*                                 the inputs                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a LIVE run (the `publicar` route, `publicar:anuncio --live`) supplies
 * and a dry run never has. Carried on `PublicarAnuncioDeps.aoVivo`.
 *
 * ⚠️ `agora` is REQUIRED, and there is deliberately no `() => deps.nowMs`
 * fallback anywhere: `nowMs` is the run's ONE constant instant, so a gate fed by
 * it compares a frozen number against a deadline and passes for ever — the CLI
 * that spent six minutes uploading photos would still send.
 */
export interface ControlesDaPublicacaoAoVivo {
  /** The route's clock — a LIVE reading in MILLISECONDS on every call. */
  readonly agora: () => number;
  /**
   * MILLISECONDS — the instant past which the request may be cut off
   * (`nowMs + TETO_ROTA_SHOPEE_MS` on the route). `null` = no request ceiling
   * (the CLI): the lock's own `expiraEm` is then the only bound.
   */
  readonly prazoDaRequisicao: number | null;
  /**
   * The operator confirmed that this publish may create a SECOND listing of
   * the produto on the conta (D15). Re-checked at the reservation, where the
   * duplicate actually happens; it never overrides a sibling that is busy.
   */
  readonly confirmarSegundoAnuncio: boolean;
}

/** The draft one publish addresses — always a NAMED link (the dispatcher's). */
export interface AlvoDaReserva {
  readonly integracaoId: string;
  readonly produtoId: string;
  readonly linkDocId: string;
}

/**
 * Where a held lock stands, from this run's point of view.
 *
 *  - `travada` — ours, and nothing that may have reached Shopee is
 *    outstanding: a throw RELEASES it (no stamp).
 *  - `enviando` — an `add_item` leg is in flight or its failure is not yet
 *    classified: the `add_item` handler decides.
 *  - `criada` — Shopee answered the create with success: the listing EXISTS,
 *    and only the write-back #1 claim may clear the lock.
 *  - `encerrada` — no longer this run's to touch: claimed, released, or KEPT on
 *    purpose for an outcome nobody can know.
 */
export type FaseDaReserva = 'travada' | 'enviando' | 'criada' | 'encerrada';

/** One run's lock on one draft. `fase` is the ONE mutable field. */
export interface ReservaDeRascunhoShopee {
  readonly produtoId: string;
  readonly linkDocId: string;
  /** This run's nonce — a fresh `newDocId`, no IO and no clock. */
  readonly token: string;
  /** MILLISECONDS — `agora()` when the lock was written. */
  readonly desde: number;
  /** MILLISECONDS — `desde + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS`, as written. */
  readonly expiraEm: number;
  fase: FaseDaReserva;
}

/** What {@link reservarRascunhoShopee} answers when it does not throw. */
export type DesfechoDaReserva =
  /** The named link is not a draft: a republish, which takes no lock. */
  | { readonly tipo: 'nao-e-rascunho' }
  /** The named link does not exist (or is not this conta's): the route's 404. */
  | { readonly tipo: 'inexistente' }
  | { readonly tipo: 'travada'; readonly reserva: ReservaDeRascunhoShopee };

/* -------------------------------------------------------------------------- */
/*                                 the refusal                                 */
/* -------------------------------------------------------------------------- */

/**
 * A draft operation refused by the LOCK — the route's **409**, with `code` from
 * `CODIGO_RASCUNHO_SHOPEE` (`@delfrance/schemas`, the ONE vocabulary the web
 * reads too).
 *
 * ⚠️ An APP class, deliberately NOT a `ShopeeError`: nothing here is a Shopee
 * answer, so no `falhaPublicacao` stamp may ever be written for it and no
 * Shopee-error ladder may read it. The route tests it with `instanceof` BEFORE
 * `isShopeeError`; the CLI prints it.
 *
 * `message` is a pt-BR mechanism sentence — ids and counts, never content.
 */
export class ConflitoDeRascunhoShopeeError extends Error {
  readonly code: CodigoRascunhoShopee;
  /** The draft the request addressed. */
  readonly linkDocId: string;
  /** MILLISECONDS until the holder's reading can change, when waiting can help; else `null`. */
  readonly aguardarMs: number | null;
  /** The sibling links behind the refusal (D15), when a sibling is the cause; else `null`. */
  readonly vinculos: readonly VinculoConflitanteShopee[] | null;

  constructor(args: {
    readonly code: CodigoRascunhoShopee;
    readonly linkDocId: string;
    readonly mensagem: string;
    readonly aguardarMs?: number | null;
    readonly vinculos?: readonly VinculoConflitanteShopee[] | null;
  }) {
    super(args.mensagem);
    this.name = 'ConflitoDeRascunhoShopeeError';
    this.code = args.code;
    this.linkDocId = args.linkDocId;
    this.aguardarMs = args.aguardarMs ?? null;
    this.vinculos = args.vinculos ?? null;
  }
}

/** Whole seconds, rounded UP, for a sentence — never for a decision. */
function segundos(ms: number): string {
  return String(Math.max(Math.ceil(ms / 1000), 0));
}

function listaDeVinculos(vinculos: readonly VinculoConflitanteShopee[]): string {
  return vinculos
    .map((v) =>
      v.rascunho ? `${v.linkDocId} (rascunho)` : `${v.linkDocId} (item ${String(v.itemId)})`,
    )
    .join(', ');
}

function emAndamento(
  linkDocId: string,
  aguardarMs: number,
  posExpiracao: boolean,
): ConflitoDeRascunhoShopeeError {
  return new ConflitoDeRascunhoShopeeError({
    code: CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
    linkDocId,
    aguardarMs,
    mensagem: posExpiracao
      ? `a publicação anterior do rascunho ${linkDocId} expirou, mas ainda pode estar terminando ` +
        `na Shopee — aguarde ${segundos(aguardarMs)} s e confira antes de tentar de novo. ` +
        'Nada foi enviado agora.'
      : `o rascunho ${linkDocId} já está sendo publicado por outra execução — aguarde ` +
        `${segundos(aguardarMs)} s e confira o resultado antes de tentar de novo. Nada foi ` +
        'enviado agora.',
  });
}

function criacaoIncerta(linkDocId: string): ConflitoDeRascunhoShopeeError {
  return new ConflitoDeRascunhoShopeeError({
    code: CODIGO_RASCUNHO_SHOPEE.criacaoIncerta,
    linkDocId,
    mensagem:
      `a última tentativa de publicar o rascunho ${linkDocId} pode ter criado o anúncio na ` +
      'Shopee (resultado desconhecido). Confira no Seller Centre e importe o anúncio se ele ' +
      'existir — publicar de novo poderia criar um segundo. Nada foi enviado agora.',
  });
}

function jaPublicado(linkDocId: string): ConflitoDeRascunhoShopeeError {
  return new ConflitoDeRascunhoShopeeError({
    code: CODIGO_RASCUNHO_SHOPEE.jaPublicado,
    linkDocId,
    mensagem:
      `o vínculo ${linkDocId} já não é um rascunho: o anúncio já existe na Shopee. Recarregue ` +
      'e publique-o como atualização. Nada foi enviado agora.',
  });
}

function expirada(linkDocId: string, motivo: string): ConflitoDeRascunhoShopeeError {
  return new ConflitoDeRascunhoShopeeError({
    code: CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada,
    linkDocId,
    mensagem:
      `a publicação do rascunho ${linkDocId} parou ANTES do add_item: ${motivo}. Nada foi ` +
      'enviado à Shopee; tente de novo.',
  });
}

/* -------------------------------------------------------------------------- */
/*                                  reading                                    */
/* -------------------------------------------------------------------------- */

/** The stored lock, through the ONE schema (`@delfrance/schemas`), or `null`. */
function travaLegivel(raw: Record<string, unknown>): PublicacaoEmCursoShopee | null {
  const lida = publicacaoEmCursoShopeeSchema.safeParse(raw.publicacaoEmCurso);
  return lida.success ? lida.data : null;
}

/** Is the stored lock THIS run's? An unreadable or absent lock is nobody's. */
function travaEhNossa(raw: Record<string, unknown>, token: string): boolean {
  return travaLegivel(raw)?.token === token;
}

/** A positive stored `item_id`, or `null` — the shape a 409's `vinculos[]` carries. */
function itemIdDoVinculo(raw: Record<string, unknown>): number | null {
  const bruto = raw.item_id;
  return typeof bruto === 'number' && Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
}

/* -------------------------------------------------------------------------- */
/*                               1. reserve                                    */
/* -------------------------------------------------------------------------- */

/**
 * How many times the reservation (and the release, and the claim) re-reads
 * after losing its precondition before it gives up — `isFailedPrecondition`'s
 * contract: bounded, never a spin.
 */
export const TENTATIVAS_DA_TRAVA = 3;

/**
 * Take the publish lock on the named draft, then check the conta for a second
 * listing (D15) — see the module docblock, step 1.
 *
 * The FIRST read decides whether this is a draft at all: not a draft ⇒
 * `nao-e-rascunho` (a republish takes no lock, and needs no `controles`). A
 * document that STOPS being a draft between two attempts (another run claimed
 * it) ⇒ 409 `JA_PUBLICADO`.
 *
 * @param controles `null` only for a caller that never publishes a draft; a
 *   draft reached with `null` throws BEFORE any write — the composition root
 *   forgot the route's clock, which is a defect, never a fallback.
 * @throws ConflitoDeRascunhoShopeeError for every 409 above.
 */
export async function reservarRascunhoShopee(
  db: Firestore,
  alvo: AlvoDaReserva,
  controles: ControlesDaPublicacaoAoVivo | null,
): Promise<DesfechoDaReserva> {
  const ref = produtoShopeeLinkCollection.docRef(db, { produtoId: alvo.produtoId }, alvo.linkDocId);
  for (let tentativa = 1; tentativa <= TENTATIVAS_DA_TRAVA; tentativa += 1) {
    const snap = await ref.get();
    if (!snap.exists) return { tipo: 'inexistente' };
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    // The dispatcher already narrowed to this conta; a document that is not
    // (or no longer) this conta's is the same 404 the resolver would answer.
    if (!vinculoShopeeEhDaConta(raw, alvo.integracaoId)) return { tipo: 'inexistente' };

    if (!ehRascunhoShopee(raw)) {
      if (tentativa === 1) return { tipo: 'nao-e-rascunho' };
      throw jaPublicado(alvo.linkDocId);
    }
    if (controles === null) {
      throw new Error(
        `[shopee/anuncios] a publicação do rascunho ${alvo.linkDocId} chegou sem o relógio da ` +
          'rota (deps.aoVivo): a composição esqueceu os controles de uma execução ao vivo. Nada ' +
          'foi gravado nem enviado.',
      );
    }

    const agora = controles.agora();
    const estado = estadoPublicacaoRascunhoShopee(raw, agora);
    if (estado.tipo === 'em-andamento') {
      throw emAndamento(alvo.linkDocId, estado.aguardarMs, estado.posExpiracao);
    }
    if (estado.tipo === 'incerta') throw criacaoIncerta(alvo.linkDocId);

    const reserva: ReservaDeRascunhoShopee = {
      produtoId: alvo.produtoId,
      linkDocId: alvo.linkDocId,
      token: produtoShopeeLinkCollection.newDocId(db, { produtoId: alvo.produtoId }),
      desde: agora,
      expiraEm: agora + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
      fase: 'travada',
    };
    const patch = produtoShopeeLinkCollection.parseMerge({
      publicacaoEmCurso: { desde: reserva.desde, expiraEm: reserva.expiraEm, token: reserva.token },
    });
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
    } catch (err) {
      // Another writer landed between the read and the write: re-read and
      // RE-DECIDE from what is there now — never re-apply this decision.
      if (!isFailedPrecondition(err)) throw err;
      continue;
    }

    // ⚠️ LOCK-THEN-SCAN: the lock is written BEFORE the siblings are read.
    try {
      await recusarSegundoAnuncio(db, alvo, controles);
    } catch (err) {
      // ⚠️ EVERY error is rethrown: this catch exists only to hand our lock
      // back first — a 409 from the scan, and equally a failed sibling read,
      // happen with NOTHING sent, and a lock left behind would later read as
      // an uncertain create that never happened. The hand-back is best-effort:
      // a Firestore failure of the RELEASE must not turn the 409 the operator
      // acts on into a 500.
      await liberarTravaShopeeSemSubstituirErro(db, reserva);
      throw err;
    }
    return { tipo: 'travada', reserva };
  }

  console.warn('[shopee/anuncios] a trava do rascunho perdeu a precondição três vezes', {
    produtoId: alvo.produtoId,
    linkDocId: alvo.linkDocId,
  });
  throw new ConflitoDeRascunhoShopeeError({
    code: CODIGO_RASCUNHO_SHOPEE.contencao,
    linkDocId: alvo.linkDocId,
    mensagem:
      `não foi possível reservar o rascunho ${alvo.linkDocId}: gravações concorrentes venceram ` +
      `${String(TENTATIVAS_DA_TRAVA)} vezes seguidas. Nada foi enviado à Shopee; tente de novo.`,
  });
}

/**
 * D15 at the reservation, with OUR lock already written (K1-4). Throws when the
 * conta refuses (the caller releases the lock); returns quietly when the
 * publish may go on.
 *
 *  1. any OTHER link of this conta under the produto whose lock reading is not
 *     `livre` (em-andamento, its grace, or incerta) ⇒ 409 `EM_ANDAMENTO` with
 *     those `vinculos` — even with the confirmation: a confirmed second listing
 *     is still two creates racing;
 *  2. `vinculosQueExigemConfirmacaoShopee` non-empty and no confirmation ⇒ 409
 *     `CONTA_JA_TEM_ANUNCIO` with the set.
 */
async function recusarSegundoAnuncio(
  db: Firestore,
  alvo: AlvoDaReserva,
  controles: ControlesDaPublicacaoAoVivo,
): Promise<void> {
  const vinculos = await lerVinculosDaConta(db, alvo.integracaoId, alvo.produtoId);
  const agora = controles.agora();

  const ocupados: VinculoConflitanteShopee[] = [];
  let aguardarMs: number | null = 0;
  for (const v of vinculos) {
    if (v.id === alvo.linkDocId) continue;
    const estado = estadoPublicacaoRascunhoShopee(v.raw, agora);
    if (estado.tipo === 'livre') continue;
    ocupados.push({
      linkDocId: v.id,
      itemId: itemIdDoVinculo(v.raw),
      rascunho: ehRascunhoShopee(v.raw),
    });
    // Waiting helps only while every holder is still inside its window; an
    // uncertain sibling is not cleared by time.
    aguardarMs =
      estado.tipo === 'em-andamento' && aguardarMs !== null
        ? Math.max(aguardarMs, estado.aguardarMs)
        : null;
  }
  if (ocupados.length > 0) {
    throw new ConflitoDeRascunhoShopeeError({
      code: CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
      linkDocId: alvo.linkDocId,
      aguardarMs,
      vinculos: ocupados,
      mensagem:
        `outro vínculo deste produto nesta conta está sendo publicado ou tem criação incerta ` +
        `(${listaDeVinculos(ocupados)}) — ` +
        (aguardarMs === null
          ? 'confira no Seller Centre antes de publicar este rascunho.'
          : `aguarde ${segundos(aguardarMs)} s e confira antes de publicar este rascunho.`) +
        ' Nada foi enviado agora.',
    });
  }

  const exigem = vinculosQueExigemConfirmacaoShopee(
    vinculos.map((v) => ({ id: v.id, data: v.raw })),
    alvo.integracaoId,
    alvo.linkDocId,
  );
  if (exigem.length > 0 && !controles.confirmarSegundoAnuncio) {
    throw new ConflitoDeRascunhoShopeeError({
      code: CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio,
      linkDocId: alvo.linkDocId,
      vinculos: exigem,
      mensagem:
        `este produto já tem anúncio ou rascunho nesta conta (${listaDeVinculos(exigem)}): ` +
        'publicar o rascunho criaria um SEGUNDO anúncio, que a Shopee pode tratar como ' +
        'duplicata. Confirme o segundo anúncio para seguir. Nada foi enviado agora.',
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                       2. + 3. before (and at) the send                      */
/* -------------------------------------------------------------------------- */

/**
 * The PRE-SEND re-read (step 2): the stored token must still be ours, or
 * NOTHING is sent. Returns the lock as stored — its `expiraEm` is what the send
 * gate measures against.
 *
 * ⚠️ Never writes. A lock that is no longer ours belongs to someone else, and
 * the caller's release is token-guarded, so it leaves that lock alone too.
 *
 * @throws ConflitoDeRascunhoShopeeError — `JA_PUBLICADO` when another run's
 *   create already claimed the draft, `PUBLICACAO_EXPIRADA` for any other loss
 *   of the lock.
 */
export async function conferirTravaAntesDoEnvio(
  db: Firestore,
  reserva: ReservaDeRascunhoShopee,
): Promise<PublicacaoEmCursoShopee> {
  const snap = await produtoShopeeLinkCollection
    .docRef(db, { produtoId: reserva.produtoId }, reserva.linkDocId)
    .get();
  const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  if (raw !== null && itemIdDoVinculo(raw) !== null) throw jaPublicado(reserva.linkDocId);
  const trava = raw === null ? null : travaLegivel(raw);
  if (trava === null || trava.token !== reserva.token) {
    console.warn('[shopee/anuncios] a trava do rascunho já não é desta execução; nada enviado', {
      produtoId: reserva.produtoId,
      linkDocId: reserva.linkDocId,
      existe: raw !== null,
    });
    throw expirada(reserva.linkDocId, 'a trava da publicação já não é desta execução');
  }
  return trava;
}

/**
 * The per-leg send gate (step 3) — SYNCHRONOUS, so nothing can run between it
 * and the `client.addItem` call it guards. Sends only while
 * `agora() + MARGEM_ENVIO_SHOPEE_MS < min(trava.expiraEm, prazoDaRequisicao)`.
 *
 * ⚠️ `agora` is read HERE, per leg — never the run's `nowMs` and never a value
 * captured before the first leg: the fiscal retry's second `add_item` may start
 * long after the first, and it is gated by its own reading.
 *
 * @throws ConflitoDeRascunhoShopeeError `PUBLICACAO_EXPIRADA` — nothing sent.
 */
export function portaoDeEnvio(
  linkDocId: string,
  trava: Pick<PublicacaoEmCursoShopee, 'expiraEm'>,
  controles: Pick<ControlesDaPublicacaoAoVivo, 'agora' | 'prazoDaRequisicao'>,
): void {
  const limite =
    controles.prazoDaRequisicao === null
      ? trava.expiraEm
      : Math.min(trava.expiraEm, controles.prazoDaRequisicao);
  const agora = controles.agora();
  // ⚠️ Written as "send only if", so a NaN clock (every comparison false)
  // refuses rather than sends.
  if (agora + MARGEM_ENVIO_SHOPEE_MS < limite) return;
  throw expirada(
    linkDocId,
    controles.prazoDaRequisicao !== null && controles.prazoDaRequisicao < trava.expiraEm
      ? 'o tempo desta requisição acabaria durante o envio'
      : 'o tempo da trava acabaria durante o envio',
  );
}

/* -------------------------------------------------------------------------- */
/*                         4. write-back #1 = the claim                        */
/* -------------------------------------------------------------------------- */

/**
 * Write-back #1 of a DRAFT's create — the tier-1 CLAIM (step 4). `montar`
 * builds the write-back's field set from the document as it stands NOW (the
 * "first time only" fields are decided per attempt — re-derived, never
 * re-applied); the claim adds `publicacaoEmCurso: null` when it takes the draft.
 *
 * Loop ≤ {@link TENTATIVAS_DA_TRAVA}: absent ⇒ `add` a fresh link · `item_id`
 * already OURS ⇒ the plain merge (a replay converges) · still a draft ⇒
 * `update(…, {lastUpdateTime})` · anything else (another item claimed it, a
 * corrupt link) ⇒ `add` a fresh link for ours, one warn. A lost precondition
 * re-reads; a third loss rethrows it — the caller then keeps the lock, which
 * expires into `incerta`, never into a second create.
 *
 * @returns the id of the link that now records the listing.
 */
export async function reivindicarRascunhoShopee(
  db: Firestore,
  alvo: { readonly produtoId: string; readonly linkDocId: string; readonly itemId: number },
  montar: (armazenado: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const ref = produtoShopeeLinkCollection.docRef(db, { produtoId: alvo.produtoId }, alvo.linkDocId);
  for (let tentativa = 1; ; tentativa += 1) {
    const snap = await ref.get();
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;

    if (raw === null || !(ehRascunhoShopee(raw) || raw.item_id === alvo.itemId)) {
      console.warn(
        '[shopee/anuncios] o rascunho já não está disponível para este item; criando um vínculo novo',
        {
          produtoId: alvo.produtoId,
          linkDocId: alvo.linkDocId,
          itemId: alvo.itemId,
          existe: raw !== null,
          outroItemId: raw === null ? null : itemIdDoVinculo(raw),
        },
      );
      return await aplicarLinkDaListagem(db, alvo.produtoId, {
        acao: 'add',
        docId: null,
        dados: montar({}),
      });
    }
    if (raw.item_id === alvo.itemId) {
      return await aplicarLinkDaListagem(db, alvo.produtoId, {
        acao: 'merge',
        docId: alvo.linkDocId,
        dados: montar(raw),
      });
    }

    const patch = produtoShopeeLinkCollection.parseMerge({
      ...montar(raw),
      publicacaoEmCurso: null,
    });
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return alvo.linkDocId;
    } catch (err) {
      if (!isFailedPrecondition(err) || tentativa >= TENTATIVAS_DA_TRAVA) throw err;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                 5. release                                  */
/* -------------------------------------------------------------------------- */

/** What one guarded release did. */
export type DesfechoDaLiberacao =
  /** Our lock was cleared (with `extra`, when given). */
  | 'liberada'
  /** The stored lock is not ours (or there is none): NOTHING was written. */
  | 'nao-e-nossa'
  /** The document is gone: nothing to write. */
  | 'ausente'
  /** Lost the precondition on every attempt: the lock is left to expire. */
  | 'contencao';

/**
 * Clear OUR lock — token-guarded (step 5): one `update({publicacaoEmCurso:
 * null, …extra}, {lastUpdateTime})` while the stored token is ours; otherwise
 * NOTHING is written and one line is logged (K1-14). `extra` is the failure
 * stamp of an `add_item` Shopee refused for good, so the stamp and the release
 * land together or not at all — never a stamp over a run that took over.
 *
 * Marks the reservation `encerrada` whatever happened: after this call the lock
 * is no longer this run's to touch.
 *
 * ⚠️ A Firestore error other than a lost precondition PROPAGATES (rule 6) —
 * this function never decides whose error wins. A caller that is already
 * reporting an error releases through
 * {@link liberarTravaShopeeSemSubstituirErro}, which keeps that error; a caller
 * with nothing to report (a run that ends without one) lets the release's own
 * failure be the answer. A third lost precondition does NOT throw — the lock
 * simply expires into the uncertainty reading, the safe direction.
 */
export async function liberarTravaShopee(
  db: Firestore,
  reserva: ReservaDeRascunhoShopee,
  extra: Record<string, unknown> = {},
): Promise<DesfechoDaLiberacao> {
  reserva.fase = 'encerrada';
  const ref = produtoShopeeLinkCollection.docRef(
    db,
    { produtoId: reserva.produtoId },
    reserva.linkDocId,
  );
  for (let tentativa = 1; tentativa <= TENTATIVAS_DA_TRAVA; tentativa += 1) {
    const snap = await ref.get();
    if (!snap.exists) return 'ausente';
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    if (!travaEhNossa(raw, reserva.token)) {
      console.warn('[shopee/anuncios] a trava do rascunho não é desta execução; nada gravado', {
        produtoId: reserva.produtoId,
        linkDocId: reserva.linkDocId,
        comCarimbo: Object.keys(extra).length > 0,
      });
      return 'nao-e-nossa';
    }
    const patch = produtoShopeeLinkCollection.parseMerge({ ...extra, publicacaoEmCurso: null });
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return 'liberada';
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
    }
  }
  console.warn('[shopee/anuncios] a liberação da trava perdeu a precondição três vezes', {
    produtoId: reserva.produtoId,
    linkDocId: reserva.linkDocId,
  });
  return 'contencao';
}

/**
 * {@link liberarTravaShopee} for a way out that is ALREADY reporting an error,
 * and rethrows it right after: the D15 refusal ({@link reservarRascunhoShopee}),
 * `publicarAnuncioShopee`'s throw before any send, and an `add_item` Shopee
 * refused for good (`nao-criado`, whose failure stamp rides `extra`). Same
 * arguments, `extra` included.
 *
 * ⚠️ The rule: **a release never replaces the error the run is reporting.** The
 * operator acts on that answer — the 409 naming the sibling, the blocked
 * plan's 422, Shopee's refusal with the field to fix — and a Firestore failure
 * of the hand-back (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, …) changed nothing the
 * operator can act on. So a gRPC-coded failure is logged once (ids and the
 * code — never a message body, never the stamp) and swallowed. The lock then
 * STAYS: it expires, serves its grace and reads `incerta` — the direction
 * {@link liberarTravaShopee}'s own `contencao` answer already takes (refused or
 * searched, never sent twice). For a `nao-criado` create the failure STAMP is
 * lost with the release — the same accepted residual; the caller still throws
 * Shopee's refusal.
 *
 * Narrowed with `isGrpcStatusError` (rule 6): the Admin SDK rejects with a
 * plain `Error` carrying a numeric `code`, so neither `instanceof Error` nor
 * `FirebaseError` is the class. Anything else — a `TypeError`, a bug —
 * rethrows: a defect must surface, never hide behind the error it would
 * otherwise have replaced.
 */
export async function liberarTravaShopeeSemSubstituirErro(
  db: Firestore,
  reserva: ReservaDeRascunhoShopee,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await liberarTravaShopee(db, reserva, extra);
  } catch (err) {
    if (!isGrpcStatusError(err)) throw err;
    console.warn(
      '[shopee/anuncios] a liberação da trava falhou no Firestore; a trava fica e expira — o erro original segue',
      { produtoId: reserva.produtoId, linkDocId: reserva.linkDocId, codigoGrpc: err.code },
    );
  }
}
