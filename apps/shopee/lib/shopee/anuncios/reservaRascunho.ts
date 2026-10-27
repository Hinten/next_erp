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
 *     `EM_ANDAMENTO`; the document is no longer a draft ⇒ 409 `JA_PUBLICADO`;
 *     gone ⇒ the route's 404. A lock past the grace, or a recorded uncertain
 *     create (`incerta`) is TAKEN OVER — and the takeover carries the attempt
 *     window's start (`janelaDaCriacaoIncertaShopee`, read from the document
 *     BEFORE the new lock replaces the old one) into `criacaoIncertaDesde` —
 *     and the SKU that attempt sent into `criacaoIncertaSku` — in the SAME
 *     write, so a lock handed back later never loses the record; a
 *     document whose window is unreadable on both keys keeps P3's 409
 *     `CRIACAO_INCERTA` (nothing says WHEN — never "proceed").
 *     Then, **lock-then-scan** (D15): the produto's other links of this conta —
 *     one subcollection read, no index ({@link lerVinculosDaConta}). Any of
 *     them locked or uncertain ⇒ release ours, 409 `EM_ANDAMENTO` (confirmed or
 *     not); `vinculosQueExigemConfirmacaoShopee` non-empty and the request did
 *     not confirm a SECOND listing ⇒ release ours, 409 `CONTA_JA_TEM_ANUNCIO`.
 *     Two reservations of one produto cannot both pass: each WRITES before it
 *     READS, so the later scanner sees the earlier lock (both may abort — a
 *     liveness cost only; the operator retries).
 *     Then, for an `incerta` draft only, **ENSURE** (`criacaoIncerta.ts`,
 *     `localizarAnuncioIncerto`) — AFTER the sibling check, so a sibling's
 *     create in flight can never be mistaken for this draft's: a refusal ⇒
 *     release ours (the record STAYS), the 422; one listing found ⇒ ADOPT it on
 *     this very document (token-guarded: `item_id`, the canonical conta ref,
 *     lock + record + `falhaPublicacao` cleared) and the run continues as an
 *     UPDATE; a COMPLETE scan that found nothing ⇒ clear the record
 *     (token-guarded, and it must land — else nothing is sent) and go on to
 *     `add_item`. An attested SKU-less produto goes on with the record KEPT
 *     (no scan proved anything). A `livre` draft runs no ENSURE: its FIRST
 *     create's same-SKU look-up (#1911 P5b, `verificarAnuncioExistenteShopee`)
 *     runs later, in `publicarAnuncio.ts`'s `aplicarPublicacao`, still under
 *     this lock, on the SKU the planned body sends — the reservation only
 *     reports which of the two this run is ({@link DesfechoDaReserva}'s
 *     `buscouCriacaoIncerta`).
 *  2. **Re-read before the send, and stamp what it sends**
 *     ({@link conferirTravaAntesDoEnvio}): the stored token must still be
 *     OURS, or nothing is sent — then ONE token-guarded write records the
 *     folded SKU of the create body on the lock (`publicacaoEmCurso.sku`), so
 *     the look-up of an uncertain create compares against what the attempt
 *     SENT, never against the produto's SKU at re-publish time (batch-A
 *     review).
 *  3. **The per-leg send gate** ({@link portaoDeEnvio}) — SYNCHRONOUS, run
 *     immediately before EACH `client.addItem` call (both legs of the fiscal
 *     retry), right AFTER that leg's credential warm
 *     ({@link ControlesDaPublicacaoAoVivo.aquecerCredencial}): send only while
 *     `agora() + MARGEM_ENVIO_SHOPEE_MS < min(expiraEm, prazoDaRequisicao)`.
 *     The one await left between the gate and the request is the client's own
 *     token ask, which the warm made a single credential read — so MARGEM
 *     covers it, no create's request STARTS at or after `expiraEm`, and none
 *     starts that the route's own ceiling could cut off mid-send. That bound is
 *     what the post-expiry grace of `estadoPublicacaoRascunhoShopee` is
 *     measured from. ⚠️ The residual: a warmed token whose life crosses
 *     `REFRESH_SKEW_MS` in the instants between the warm and the client's ask
 *     still refreshes there, unbounded — only a deadline on the TRANSPORT
 *     (`shopeeCall`, #1094), not on `add_item` alone, closes it
 *     (`anuncios/README.md`, accepted residual (vi)).
 *  4. **Write-back #1 on a draft is a CLAIM** ({@link reivindicarRascunhoShopee}):
 *     still a draft ⇒ `update({…the item, publicacaoEmCurso: null,
 *     criacaoIncertaDesde: null}, {lastUpdateTime})` — the listing is recorded,
 *     so no uncertainty is left; already ours (a replay) ⇒ the plain merge; claimed
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
 * `falhaPublicacao` stamp in the same guarded write (the app's token step,
 * which never reached Shopee, without one); an outcome nobody can know
 * (`incerto`) ⇒ {@link registrarCriacaoIncerta}: the lock KEPT live for
 * `AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS` and the attempt recorded, in ONE
 * token-guarded write, so the next publish waits, then looks before it sends;
 * any non-Shopee error once a send began ⇒ the lock is KEPT as it is — it
 * expires, then the grace, then reads `incerta`.
 *
 * Clock-free and Next-free like the rest of `anuncios/`: every instant comes
 * from the route's clock through `agora`, a REQUIRED parameter with no
 * fallback — a constant clock would make the send gate vacuous. Every Firestore
 * access goes through a `@delfrance/data/admin/collections` handle, and nothing
 * here opens a multi-document atomic write: every guard is a single-document
 * precondition.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ShopeeClient } from '@delfrance/integrations-shopee';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  CODIGO_RASCUNHO_SHOPEE,
  MARGEM_ENVIO_SHOPEE_MS,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  ehRascunhoShopee,
  estadoPublicacaoRascunhoShopee,
  itemIdEnderecavelShopee,
  janelaDaCriacaoIncertaShopee,
  publicacaoEmCursoShopeeSchema,
  toOuterRef,
  vinculoShopeeEhDaConta,
  vinculosQueExigemConfirmacaoShopee,
  type CodigoRascunhoShopee,
  type JanelaDaCriacaoIncertaShopee,
  type PublicacaoEmCursoShopee,
  type VinculoConflitanteShopee,
} from '@delfrance/schemas';
import {
  integracaoCollection,
  produtoCollection,
  produtoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';

import { aplicarLinkDaListagem } from '../produtos/links';
import { localizarAnuncioIncerto } from './criacaoIncerta';
import { ShopeePublishBlockedError } from './errosPublicacao';
import { lerVinculosDaConta, type VinculoLidoDaConta } from './linkAnuncio';

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
   * Warms the shop client's access token — awaited IMMEDIATELY BEFORE each
   * `add_item` leg's send gate ({@link portaoDeEnvio}). The route and the CLI
   * wire the context's own `getAccessToken`, the function the client signs
   * with; the token is discarded (it never reaches `anuncios/`).
   *
   * Why (batch-A review): `client.addItem` asks for the token BEFORE it builds
   * the request, and when the stored token is inside `REFRESH_SKEW_MS` that
   * ask is a provider REFRESH with no deadline (`shopeeCall` sets none). Run
   * after the gate, it could start the `add_item` long past the gate's reading
   * — past `expiraEm`, after a takeover's ENSURE already scanned. Warmed first,
   * the refresh runs BEFORE the gate reads the clock, and the client's own ask
   * is the fast path (one credential read), which `MARGEM_ENVIO_SHOPEE_MS`
   * covers.
   *
   * REQUIRED, like `agora`. A throw means nothing was sent: the lock is handed
   * back, unstamped — a Shopee error of the refresh is about the TOKEN, never
   * the listing.
   */
  readonly aquecerCredencial: () => Promise<void>;
  /**
   * The operator confirmed that this publish may create a SECOND listing of
   * the produto on the conta (D15). Re-checked at the reservation, where the
   * duplicate actually happens; it never overrides a sibling that is busy.
   */
  readonly confirmarSegundoAnuncio: boolean;
  /**
   * The operator attested in Seller Centre that the earlier, UNCERTAIN create
   * of this draft made nothing it has to import (#1911, D5). Honoured for
   * EXACTLY two ENSURE verdicts — `criacao-incerta-sem-sku` and
   * `criacao-incerta-ja-vinculada` (K1-11) — and ignored everywhere else: it
   * never skips the scan of a produto that has a SKU, and never overrides an
   * ambiguous or incomplete one.
   */
  readonly confirmarCriacaoIncerta: boolean;
}

/**
 * What ENSURE (`criacaoIncerta.ts`) needs beyond the controls — supplied by
 * the publisher from its own deps, never by the route.
 */
export interface BuscaDaCriacaoIncerta {
  /** The shop-signed client the look-up reads Shopee with. */
  readonly client: ShopeeClient;
  /** MILLISECONDS — the run's ONE instant; an adoption stamps it as `ultimaModificacao`. */
  readonly nowMs: number;
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
  | {
      readonly tipo: 'travada';
      readonly reserva: ReservaDeRascunhoShopee;
      /**
       * `true` ⇔ this reservation TOOK OVER an `incerta` draft and ENSURE
       * searched the attempt's window before handing the lock over (#1911
       * P5b): the publish then skips the first create's same-SKU look-up
       * (`criacaoIncerta.ts`, `verificarAnuncioExistenteShopee`), which runs
       * for a `livre` draft only. Lucas, 2026-10-26: ENSURE already scans.
       */
      readonly buscouCriacaoIncerta: boolean;
    }
  /**
   * ENSURE found the listing the earlier, uncertain create made, and recorded
   * it on THIS draft (now a listing link, lock and record cleared): the run
   * goes on as an UPDATE, with no lock.
   */
  | { readonly tipo: 'adotada'; readonly itemId: number };

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
 * @param busca what ENSURE reads Shopee with — used only for an `incerta` draft.
 * @returns `adotada` when ENSURE recorded the earlier attempt's listing on the
 *   draft (the run goes on as an update, lock-free).
 * @throws ConflitoDeRascunhoShopeeError for every 409 above;
 *   ShopeePublishBlockedError for an ENSURE refusal (the 422; the record kept);
 *   any Shopee or Firestore failure of the look-up, with our lock handed back.
 */
export async function reservarRascunhoShopee(
  db: Firestore,
  alvo: AlvoDaReserva,
  controles: ControlesDaPublicacaoAoVivo | null,
  busca: BuscaDaCriacaoIncerta,
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
    // ⚠️ `incerta`: the attempt window is read from the document AS IT STANDS,
    // BEFORE the lock below replaces the stored one (whose `desde` may be the
    // only record of when the attempt began). No window ⇒ nothing says WHEN:
    // refused, never "no evidence, so proceed".
    let janela: JanelaDaCriacaoIncertaShopee | null = null;
    if (estado.tipo === 'incerta') {
      janela = janelaDaCriacaoIncertaShopee(raw);
      if (janela === null) throw criacaoIncerta(alvo.linkDocId);
    }

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
      // The takeover KEEPS the record in the same write: our lock's `desde` is
      // LATER, and a lock handed back after a refused look-up must leave the
      // draft reading `incerta`, never `livre`. The SKU that attempt SENT
      // rides with it (batch-A review): our lock replaces the one that may be
      // its only record, and `null` (unknown) is carried as unknown.
      ...(janela === null
        ? {}
        : { criacaoIncertaDesde: janela.desdeMs, criacaoIncertaSku: janela.sku }),
    });
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
    } catch (err) {
      // Another writer landed between the read and the write: re-read and
      // RE-DECIDE from what is there now — never re-apply this decision.
      if (!isFailedPrecondition(err)) throw err;
      continue;
    }

    // ⚠️ LOCK-THEN-SCAN: the lock is written BEFORE the siblings are read —
    // and the look-up runs AFTER them, so a sibling's create in flight is a
    // 409, never a listing this draft adopts.
    try {
      const vinculos = await recusarSegundoAnuncio(db, alvo, controles);
      if (janela !== null) {
        const itemId = await garantirCriacaoIncerta(db, reserva, {
          alvo,
          controles,
          busca,
          janela,
          vinculos,
        });
        if (itemId !== null) return { tipo: 'adotada', itemId };
      }
    } catch (err) {
      // ⚠️ EVERY error is rethrown: this catch exists only to hand our lock
      // back first — a 409 from the scan, a refusal of the look-up, and
      // equally a failed read, all happen with NOTHING sent, and a lock left
      // behind would later read as an uncertain create that never happened.
      // (An adoption that landed closed the reservation: nothing to hand back.)
      // The hand-back is best-effort: a Firestore failure of the RELEASE must
      // not turn the answer the operator acts on into a 500.
      if (reserva.fase === 'travada') await liberarTravaShopeeSemSubstituirErro(db, reserva);
      throw err;
    }
    return { tipo: 'travada', reserva, buscouCriacaoIncerta: janela !== null };
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
 * conta refuses (the caller releases the lock); otherwise answers the links it
 * read — ENSURE's "this produto's own listings", read AFTER our lock.
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
): Promise<readonly VinculoLidoDaConta[]> {
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
      itemId: itemIdEnderecavelShopee(v.raw.item_id),
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
  return vinculos;
}

/**
 * ENSURE at the reservation (#1911, D5 + K1-7), our lock held and the record
 * already carried over: run the look-up and act on its verdict. Throws a
 * refusal (the caller releases our lock — the record stays); answers the
 * ADOPTED `item_id`, or `null` when the publish may go on to `add_item`.
 *
 *  - `recusar` ⇒ `ShopeePublishBlockedError` with the look-up's ONE problema;
 *  - `adotar` ⇒ the token-guarded adoption on this document (`item_id`, the
 *    canonical conta ref, lock + record + failure stamp cleared) — the run is
 *    then an UPDATE of that listing;
 *  - `prosseguir` after a COMPLETE scan ⇒ the token-guarded clear of the
 *    record, which MUST land (a record left behind would let a crash after the
 *    send read `incerta` with no grace); after an attested SKU-less produto ⇒
 *    nothing written, the record kept (no scan proved anything).
 */
async function garantirCriacaoIncerta(
  db: Firestore,
  reserva: ReservaDeRascunhoShopee,
  a: {
    readonly alvo: AlvoDaReserva;
    readonly controles: ControlesDaPublicacaoAoVivo;
    readonly busca: BuscaDaCriacaoIncerta;
    readonly janela: JanelaDaCriacaoIncertaShopee;
    readonly vinculos: readonly VinculoLidoDaConta[];
  },
): Promise<number | null> {
  const produtoSnap = await produtoCollection.docRef(db, {}, a.alvo.produtoId).get();
  const produto = produtoSnap.exists ? ((produtoSnap.data() ?? {}) as Record<string, unknown>) : {};
  const veredicto = await localizarAnuncioIncerto(a.busca.client, db, {
    integracaoId: a.alvo.integracaoId,
    produtoId: a.alvo.produtoId,
    sku: typeof produto.sku === 'string' ? produto.sku : null,
    janela: a.janela,
    vinculosDoProduto: a.vinculos,
    confirmarCriacaoIncerta: a.controles.confirmarCriacaoIncerta,
  });

  if (veredicto.tipo === 'recusar') {
    throw new ShopeePublishBlockedError({
      produtoId: a.alvo.produtoId,
      itemId: null,
      problemas: [veredicto.problema],
    });
  }

  if (veredicto.tipo === 'adotar') {
    const contaRef = toOuterRef(integracaoCollection.docPath({}, a.alvo.integracaoId));
    const desfecho = await gravarSobATrava(db, reserva, (raw) =>
      // Still a draft — anything that wrote an `item_id` cleared our lock too,
      // so a lock we still hold sits on a draft; checked anyway.
      ehRascunhoShopee(raw)
        ? {
            item_id: veredicto.itemId,
            contaProdutoShopeeOuterRef: contaRef,
            publicacaoEmCurso: null,
            criacaoIncertaDesde: null,
            criacaoIncertaSku: null,
            falhaPublicacao: null,
            ultimaModificacao: a.busca.nowMs,
          }
        : null,
    );
    if (desfecho !== 'gravada') throw perdeuATrava(reserva, desfecho, 'a adoção do anúncio');
    reserva.fase = 'encerrada';
    return veredicto.itemId;
  }

  if (!veredicto.resumo.varreu) return null;
  const desfecho = await gravarSobATrava(db, reserva, () => ({
    criacaoIncertaDesde: null,
    criacaoIncertaSku: null,
  }));
  if (desfecho !== 'gravada') throw perdeuATrava(reserva, desfecho, 'a limpeza do registro');
  return null;
}

/** What one token-guarded write ({@link gravarSobATrava}) did. */
type DesfechoDaGravacaoSobATrava =
  | 'gravada'
  /** The stored lock is not ours (or there is none): NOTHING was written. */
  | 'nao-e-nossa'
  /** The document is gone. */
  | 'ausente'
  /** `montar` refused the document as it stands (e.g. no longer a draft). */
  | 'recusada'
  /** Lost the precondition on every attempt. */
  | 'contencao';

/**
 * ONE token-guarded `update(patch, {lastUpdateTime})` that KEEPS the lock
 * unless `montar` names it: re-read, our token or NOTHING is written, `montar`
 * re-derives the patch from each reading (never re-applied), ≤
 * {@link TENTATIVAS_DA_TRAVA} attempts. A non-precondition Firestore error
 * propagates (rule 6).
 */
async function gravarSobATrava(
  db: Firestore,
  reserva: ReservaDeRascunhoShopee,
  montar: (raw: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<DesfechoDaGravacaoSobATrava> {
  const ref = produtoShopeeLinkCollection.docRef(
    db,
    { produtoId: reserva.produtoId },
    reserva.linkDocId,
  );
  for (let tentativa = 1; tentativa <= TENTATIVAS_DA_TRAVA; tentativa += 1) {
    const snap = await ref.get();
    if (!snap.exists) return 'ausente';
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    if (!travaEhNossa(raw, reserva.token)) return 'nao-e-nossa';
    const dados = montar(raw);
    if (dados === null) return 'recusada';
    const patch = produtoShopeeLinkCollection.parseMerge(dados);
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return 'gravada';
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
    }
  }
  return 'contencao';
}

/** A token-guarded write of the look-up that did not land: nothing may be sent. */
function perdeuATrava(
  reserva: ReservaDeRascunhoShopee,
  desfecho: Exclude<DesfechoDaGravacaoSobATrava, 'gravada'>,
  oQue: string,
): ConflitoDeRascunhoShopeeError {
  console.warn('[shopee/anuncios] a gravação sob a trava não aconteceu; nada enviado', {
    produtoId: reserva.produtoId,
    linkDocId: reserva.linkDocId,
    desfecho,
  });
  if (desfecho === 'recusada') return jaPublicado(reserva.linkDocId);
  if (desfecho === 'contencao') {
    return new ConflitoDeRascunhoShopeeError({
      code: CODIGO_RASCUNHO_SHOPEE.contencao,
      linkDocId: reserva.linkDocId,
      mensagem:
        `${oQue} do rascunho ${reserva.linkDocId} perdeu para gravações concorrentes ` +
        `${String(TENTATIVAS_DA_TRAVA)} vezes seguidas. Nada foi enviado à Shopee; tente de novo.`,
    });
  }
  return expirada(reserva.linkDocId, `${oQue} encontrou a trava fora desta execução`);
}

/**
 * An `add_item` of this draft ended `incerto` (#1911, D5): ONE token-guarded
 * write keeps the lock LIVE for {@link AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS} —
 * so every tab, operator and the CLI hear 409 `EM_ANDAMENTO` until the listing
 * the attempt may have made can show up in `get_item_list` — and records the
 * attempt: `criacaoIncertaDesde = stored ?? lock.desde`
 * (`janelaDaCriacaoIncertaShopee` of the document as it stands — an EARLIER
 * start is kept, never moved later). No `falhaPublicacao`: nothing "falhou".
 *
 * `criacaoIncertaSku` (batch-A review) = the SKU this attempt SENT (the lock's
 * pre-send stamp) — unless an EARLIER attempt is already on record with a
 * different (or unknown) one, and then `null`: two attempts that sent two
 * SKUs have no one SKU to be looked up by, and the look-up then fails closed.
 *
 * Marks the reservation `encerrada` whatever happened. A lock that is no
 * longer ours (or three lost preconditions) writes NOTHING — the foreign lock
 * is never touched, and ours, left as it is, still expires into `incerta`.
 *
 * @returns MILLISECONDS until the lock stops reading `em-andamento` — the
 *   202's `aguardarMs`.
 */
export async function registrarCriacaoIncerta(
  db: Firestore,
  reserva: ReservaDeRascunhoShopee,
  controles: Pick<ControlesDaPublicacaoAoVivo, 'agora'>,
): Promise<number> {
  const expiraEm = controles.agora() + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS;
  const desfecho = await gravarSobATrava(db, reserva, (raw) => {
    const trava = travaLegivel(raw);
    if (trava === null) return null;
    const janela = janelaDaCriacaoIncertaShopee(raw);
    const skuDaTrava = typeof trava.sku === 'string' ? trava.sku : null;
    return {
      publicacaoEmCurso: { ...trava, expiraEm },
      criacaoIncertaDesde: janela?.desdeMs ?? reserva.desde,
      // With no record the window IS this lock, so the two agree.
      criacaoIncertaSku: janela === null || janela.sku === skuDaTrava ? skuDaTrava : null,
    };
  });
  reserva.fase = 'encerrada';
  if (desfecho !== 'gravada') {
    console.warn('[shopee/anuncios] o registro da criação incerta não foi gravado', {
      produtoId: reserva.produtoId,
      linkDocId: reserva.linkDocId,
      desfecho,
    });
  }
  return AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS;
}

/* -------------------------------------------------------------------------- */
/*                       2. + 3. before (and at) the send                      */
/* -------------------------------------------------------------------------- */

/**
 * The PRE-SEND re-read (step 2) — and the STAMP of what the create sends: the
 * stored token must still be ours, or NOTHING is sent; then ONE token-guarded
 * `update({publicacaoEmCurso: {…lock, sku}}, {lastUpdateTime})` records
 * `skuEnviado` on the lock BEFORE the first `add_item` leg. Returns the lock as
 * written — its `expiraEm` is what the send gate measures against.
 *
 * Why it WRITES (batch-A review): the look-up of an uncertain create
 * (`criacaoIncerta.ts`, ENSURE) must compare against the SKU the attempt SENT —
 * the produto's SKU can be set, cleared or renamed before the re-publish, and a
 * look-up by the CURRENT one skips the attempt's listing and creates a second.
 * Stamped before the send, it survives every way out: the `incerto` re-arm
 * and a takeover carry it into `criacaoIncertaSku`, and a crash after the send
 * leaves it on the lock that expires into `incerta`.
 *
 * ⚠️ A lock that is no longer ours belongs to someone else, and NOTHING is
 * written over it (the caller's release is token-guarded too). A lost
 * precondition re-reads and re-decides, ≤ {@link TENTATIVAS_DA_TRAVA} times.
 *
 * @param skuEnviado the create body's `item_sku` FOLDED (`skuDaBuscaShopee`);
 *   `''` when the body carries none.
 * @throws ConflitoDeRascunhoShopeeError — `JA_PUBLICADO` when another run's
 *   create already claimed the draft, `PUBLICACAO_EXPIRADA` for any other loss
 *   of the lock, `CONTENCAO` after the last lost precondition — nothing sent.
 */
export async function conferirTravaAntesDoEnvio(
  db: Firestore,
  reserva: ReservaDeRascunhoShopee,
  skuEnviado: string,
): Promise<PublicacaoEmCursoShopee> {
  const ref = produtoShopeeLinkCollection.docRef(
    db,
    { produtoId: reserva.produtoId },
    reserva.linkDocId,
  );
  for (let tentativa = 1; tentativa <= TENTATIVAS_DA_TRAVA; tentativa += 1) {
    const snap = await ref.get();
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
    if (raw !== null && itemIdEnderecavelShopee(raw.item_id) !== null) {
      throw jaPublicado(reserva.linkDocId);
    }
    const trava = raw === null ? null : travaLegivel(raw);
    if (trava === null || trava.token !== reserva.token) {
      console.warn('[shopee/anuncios] a trava do rascunho já não é desta execução; nada enviado', {
        produtoId: reserva.produtoId,
        linkDocId: reserva.linkDocId,
        existe: raw !== null,
      });
      throw expirada(reserva.linkDocId, 'a trava da publicação já não é desta execução');
    }
    const carimbada: PublicacaoEmCursoShopee = { ...trava, sku: skuEnviado };
    const patch = produtoShopeeLinkCollection.parseMerge({ publicacaoEmCurso: carimbada });
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return carimbada;
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
    }
  }
  throw perdeuATrava(reserva, 'contencao', 'o registro do SKU antes do envio');
}

/**
 * The per-leg send gate (step 3) — SYNCHRONOUS, so nothing of OURS runs between
 * it and the `client.addItem` call it guards; the client's own token ask does,
 * and the caller warms the credential first
 * ({@link ControlesDaPublicacaoAoVivo.aquecerCredencial}) so that ask is one
 * credential read inside the margin. Sends only while
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
 * re-applied); the claim adds `publicacaoEmCurso: null` and
 * `criacaoIncertaDesde: null` when it takes the draft.
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
          outroItemId: raw === null ? null : itemIdEnderecavelShopee(raw.item_id),
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
      // The listing is recorded: no uncertainty is left about this draft.
      criacaoIncertaDesde: null,
      criacaoIncertaSku: null,
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
