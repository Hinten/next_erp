/**
 * Re-read a listing from Mercado Livre and record its real state on the link
 * doc — the operator's way out of a stock latch (#781).
 *
 * The stock sender stops sending to a listing whose link carries `estado 'E'`,
 * which it writes only after ML confirmed the anúncio itself is healthy, i.e.
 * our payload was the problem. An `items` webhook normally re-arms it, but a
 * listing nobody touches never fires one.
 *
 * Extracted from `app/api/marketplace/mercado-livre/reverificar-anuncio/route.ts`
 * so the manual stock push (#819) re-arms through the SAME code rather than a
 * second copy — the discipline that produced `applyItemStatusToLink` itself.
 * The route is now a thin wrapper around this.
 *
 * ⚠️ **A User-Products FAMILY is re-read member by member, never as one listing**
 * (#1142). `target.itemId` comes from the parent link's `id`, which under User
 * Products is `familyId ?? itemIds[0]` (`publish.ts`) — so it is either ML's
 * numeric family key, which `GET /items/{id}` answers **404** for, or member 0's
 * own item id, which answers for ONE of N listings. Both were catastrophic here
 * and silently so: this module's 404 branch records `closed`, on a family that
 * is `estado 'c'`, which fails `linkHasLiveListing`, drops the conta from
 * `produtos.integracoesComProduto` and takes the produto out of BOTH ML sweeps
 * with nothing logged — an operator pressing a button to diagnose one listing
 * would have stopped every variation of it selling. So the family path fetches
 * every member (`getItemsByIds`), records each on its OWN
 * `variacaoMercadoLivre` link, and lets `foldFamilyStatus` decide what the
 * family is. It is also the ONLY way the un-concludable backlog clears: a family
 * concludes only once every member is observed, and a listing that never changes
 * never fires the `items` notification that would observe it.
 */
import {
  ML_MULTIGET_MAX_IDS,
  type MlItem,
  type MlItemsMultiget,
  type MlModeration,
  MercadoLivreHttpError,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import { precisaConsultarModeracao } from '@delfrance/schemas';
import type { Firestore } from 'firebase-admin/firestore';

import { podeEnviarEstoque } from '../estoque/bulkEstoquePlan';
import {
  type LinkStatusTarget,
  type ObservedMember,
  applyFamilyStatusAndFold,
  applyItemStatusToLink,
} from './itemsStatusSync';
import { consultarModeracoes } from './moderacoes';
import { clearFalha } from '../core/publishFalhas';
import { isFamilyId } from '../core/linkRefs';
import { type MembroDaFamilia, membrosDaFamilia } from './upMemberLink';

/** The minimal ML surface a re-verification needs (injectable for tests). */
export interface ReverificarApi {
  getItem(id: string): Promise<MlItem>;
  /**
   * `GET /moderations/last_moderation/{id}-ITM` (#1087) — called only when the
   * re-read status says a moderation exists. See {@link reverificarAnuncio} for
   * why a re-check must FETCH this rather than merely clear it.
   */
  getLastModeration(referenceId: string): Promise<MlModeration[]>;
  /**
   * ML's **Multiget** — how a User-Products FAMILY is re-read (#1142). One
   * request per {@link ML_MULTIGET_MAX_IDS} members instead of one per member.
   */
  getItemsByIds(ids: readonly string[], attributes?: readonly string[]): Promise<MlItemsMultiget>;
}

/** One member of a re-verified User-Products family. */
export interface ReverificacaoMembro {
  /** This member's own ML item id. */
  itemId: string;
  /** The `variacaoMercadoLivre` doc the reading was recorded on. */
  memberDocId: string;
  /**
   * Did ML answer for this member? `false` means its STORED status still stands
   * — nothing was overwritten. ⚠️ Not the same as `status: 'closed'`: an
   * unreadable member is unknown, never dead, and the fold treats it that way.
   */
  lido: boolean;
  status: string | null;
  subStatus: string[] | null;
  enviavel: boolean;
}

export interface ReverificacaoResultado {
  /** Old-shape estado code derived from the listing's fresh ML status. */
  estado: string;
  /** Raw ML `status` as of the re-check (`active`/`paused`/`closed`/…). */
  status: string | null;
  subStatus: string[] | null;
  /** Whether the stock sender will send to this listing again. */
  enviavel: boolean;
  /**
   * Present only for a User-Products FAMILY, one entry per member — the level at
   * which a family actually has a status. The four fields above are the FOLD
   * over these (`upFamilyStatus.ts`), which is all the parent link can carry.
   */
  membros?: ReverificacaoMembro[];
  /**
   * How many ML requests this re-verification actually issued.
   *
   * ⚠️ Load-bearing for the manual stock push's budget (#819). It caps re-arms
   * with `MERCADO_LIVRE_STOCK_MANUAL_REARM_MAX_GETS`, documented as a cap on
   * `GET /items` CALLS — an accounting that was exact while one link meant one
   * request. A família is ⌈members / {@link ML_MULTIGET_MAX_IDS}⌉ multigets plus
   * one `/moderations` read per member whose fresh status warrants one, so
   * charging it a single unit would let that cap buy an order of magnitude more
   * traffic than its name promises. The caller decrements by THIS.
   */
  chamadasMl: number;
}

/**
 * The link stores a FAMILY id but this ERP holds no member links for it, so
 * there is nothing to re-read and no way to learn the members from what is on
 * disk.
 *
 * ⚠️ Its own class, and NOT a fallback to `GET /items/{familyId}`, because that
 * call answers **404** and every 404 handler in this codebase records `closed` —
 * which on a family means `estado 'c'`, the conta dropped from
 * `integracoesComProduto`, and the produto silently out of both ML sweeps. The
 * whole point of #1142 is that a family may never be cancelled on a guess. An
 * operator gets a message telling them to re-import or re-publish the anúncio,
 * which is the action that rebuilds the member links.
 */
export class ReverificacaoFamiliaSemMembrosError extends Error {
  constructor() {
    super(
      'Anúncio publicado como família do Mercado Livre, mas nenhuma variação está ' +
        'vinculada neste produto — importe ou publique o anúncio novamente para reverificar.',
    );
    this.name = 'ReverificacaoFamiliaSemMembrosError';
  }
}

/**
 * Ask ML what the listing IS and record THAT (never derive the state from a
 * rejection alone — ML publishes no canonical cause table for `PUT /items/{id}`).
 * Always clears `errors`: a re-verification is the operator saying "tell me the
 * truth now", so a stale diagnosis must not survive it.
 *
 * ⚠️ `moderacoes` is RE-FETCHED here, not merely cleared with them (#1087), and
 * this is one of two places where "let `clearFalha()` handle it" would introduce
 * a bug — the importer is the other, for the same reason and with the same fix.
 * The clear above is unconditional, so on a listing ML has genuinely
 * moderated a clear-only re-check would erase the reason the operator pressed
 * the button to see and leave a bare "pausado" until the next `items` delivery —
 * which, for a listing nobody touches, is the delivery that never comes. That is
 * the exact gap this button exists to close for `errors`.
 *
 * A 404 means the listing is GONE. Recording `closed` explicitly is deliberate —
 * treating it as a no-op would leave a stale `status: 'active'` standing and the
 * sweep would keep trying. `moderacoes` clears there and stays cleared: a
 * moderation on a listing that no longer exists explains nothing, and ML would
 * answer 404 for it too.
 *
 * Transient failures (5xx / network / Firestore) THROW: nothing was confirmed,
 * so nothing may be recorded.
 */
export async function reverificarAnuncio(
  db: Firestore,
  integracaoId: string,
  target: LinkStatusTarget,
  api: ReverificarApi,
  nowMs: number,
): Promise<ReverificacaoResultado> {
  // ⚠️ ONE indexed group query, before anything reaches ML, and it is what makes
  // this route safe on a User-Products family (#1142). `target.itemId` comes
  // from the parent link's `id`, which under User Products is
  // `familyId ?? itemIds[0]` (`publish.ts`) — so it is EITHER ML's numeric family
  // key or member 0's item id, and neither can be re-verified as a single
  // listing. Asking the member links first answers both cases at once.
  const membros = await membrosDaFamilia(db, target);
  if (membros.length > 0) return await reverificarFamilia(db, integracaoId, target, membros, api);

  // A family id with no member links on disk. Refuse LOUDLY rather than let it
  // reach `GET /items/{id}` — see the error class for what that 404 would do.
  if (isFamilyId(target.itemId)) throw new ReverificacaoFamiliaSemMembrosError();

  let item: MlItem;
  try {
    item = await api.getItem(target.itemId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      await applyItemStatusToLink(
        db,
        integracaoId,
        target,
        { status: 'closed', sub_status: [] },
        // `moderacoes: []` is spelled out because `clearFalha()` deliberately
        // does NOT carry it — and this is one of the two places that genuinely
        // may clear it: the listing is GONE, so any moderation on it explains
        // nothing and `/moderations` would 404 for it too.
        { nowMs, extra: { ...clearFalha(), moderacoes: [] } },
      );
      return {
        estado: estadoFromMlStatus('closed'),
        status: 'closed',
        subStatus: [],
        enviavel: false,
        // The `getItem` that 404'd. `/moderations` is never reached on this arm.
        chamadasMl: 1,
      };
    }
    throw err;
  }

  // Before the write, and outside it: a transient failure here must leave the
  // link untouched rather than record "not moderated" it never confirmed.
  const moderacoes = await consultarModeracoes(api, target.itemId, item.status, item.sub_status);

  await applyItemStatusToLink(db, integracaoId, target, item, {
    nowMs,
    // Drop the stale diagnosis so the produto tab stops showing a fault the
    // listing may no longer have. `moderacoes` comes AFTER the spread: it was
    // just read from ML, so it overrides the healed `[]` rather than the reverse.
    extra: { ...clearFalha(), moderacoes },
  });

  return {
    estado: estadoFromMlStatus(item.status),
    status: item.status ?? null,
    subStatus: item.sub_status ?? null,
    enviavel: podeEnviarEstoque(item.status, item.sub_status).enviar,
    // The `getItem`, plus the `/moderations` read only when the SAME pure
    // predicate `consultarModeracoes` gates on says one was due.
    chamadasMl: precisaConsultarModeracao(item.status, item.sub_status) ? 2 : 1,
  };
}

/**
 * Re-read every member of a User-Products family and record each one on its OWN
 * link, then let the fold decide what the family is.
 *
 * This is the only path that can clear the backlog `upFamilyStatus.ts` documents:
 * a family concludes only once every member has been OBSERVED, and a member whose
 * listing never changes never fires an `items` notification. Pressing the button
 * observes them all.
 *
 * Cost: ⌈members / {@link ML_MULTIGET_MAX_IDS}⌉ requests, plus one
 * `/moderations` read for each member whose fresh status says a moderation
 * exists — a gate that is a pure predicate, so a healthy family pays nothing for
 * it.
 */
async function reverificarFamilia(
  db: Firestore,
  integracaoId: string,
  target: LinkStatusTarget,
  membros: readonly MembroDaFamilia[],
  api: ReverificarApi,
): Promise<ReverificacaoResultado> {
  const { lidos, chamadas } = await lerMembros(api, membros);
  let chamadasMl = chamadas;

  // Every ML read happens BEFORE the transaction — the fold runs inside one, and
  // a network call in that window is root `CLAUDE.md` rule 7's class C: the
  // callback re-runs on each OCC retry and would re-issue every request.
  const observados: ObservedMember[] = [];
  const relatorio: ReverificacaoMembro[] = [];
  for (const membro of membros) {
    const lido = lidos.get(membro.itemId) ?? null;
    if (!lido) {
      // ⚠️ NOT recorded as closed. ML did not answer for this member, so its
      // stored reading stands and the fold treats it as any unobserved member —
      // which may well mean the family cannot conclude, and that is the correct
      // answer. Manufacturing `closed` here would invent the one reading that
      // can cancel a whole family.
      relatorio.push({
        itemId: membro.itemId,
        memberDocId: membro.memberDocId,
        lido: false,
        status: null,
        subStatus: null,
        enviavel: false,
      });
      continue;
    }
    // Counted with the SAME pure predicate `consultarModeracoes` gates on, so
    // the tally is exact rather than an upper bound — it answers `[]` without a
    // request when the fresh status says no moderation exists.
    if (precisaConsultarModeracao(lido.status, lido.subStatus)) chamadasMl += 1;
    observados.push({
      memberProdutoId: membro.memberProdutoId,
      memberDocId: membro.memberDocId,
      status: lido.status,
      subStatus: lido.subStatus,
      // A re-check is the operator asking for the truth NOW, so it FETCHES the
      // reason rather than merely clearing it — the same rule the single-item
      // path states at length.
      moderacoes: await consultarModeracoes(api, membro.itemId, lido.status, lido.subStatus),
      userProductId: lido.userProductId,
    });
    relatorio.push({
      itemId: membro.itemId,
      memberDocId: membro.memberDocId,
      lido: true,
      status: lido.status,
      subStatus: lido.subStatus,
      enviavel: podeEnviarEstoque(lido.status, lido.subStatus).enviar,
    });
  }

  const folded = await applyFamilyStatusAndFold(
    db,
    integracaoId,
    {
      produtoId: target.produtoId,
      linkDocId: target.linkDocId,
      pmlOuterRef: membros[0]!.pmlOuterRef,
    },
    observados,
    // ⚠️ THIS function's guarantee, not the fold's default. A re-verification is
    // the operator saying "tell me the truth now", so a stale diagnosis must not
    // survive it — the single-listing path below clears unconditionally at every
    // write site. Without this the family path would inherit the WEBHOOK's rule
    // (clear only when the fold concludes AND says stock can flow again) and the
    // operator would keep reading the old fault on a família whose fold landed on
    // `paused` or could not conclude at all.
    { limparFalhaSempre: true },
  );

  return {
    // ⚠️ The FOLD's answer, never one member's. `estado` feeds
    // `linkHasLiveListing` → `integracoesComProduto`, the anchor pre-filter both
    // ML sweeps open with, so a single member's `closed` reaching it here would
    // drop a produto whose siblings are still selling.
    estado: folded.estado ?? estadoFromMlStatus(folded.status),
    status: folded.status,
    subStatus: folded.subStatus,
    enviavel: podeEnviarEstoque(folded.status, folded.subStatus).enviar,
    membros: relatorio,
    chamadasMl,
  };
}

/** One member's fresh reading from ML's multiget. */
interface LeituraDeMembro {
  status: string | null;
  subStatus: string[] | null;
  userProductId: string | null;
}

/**
 * Read every member's status from ML, chunked.
 *
 * ⚠️ Chunking is MANDATORY, not tidy: ML **truncates** an over-long multiget
 * instead of rejecting it, so an unchunked call would silently answer for the
 * first {@link ML_MULTIGET_MAX_IDS} and leave every member past that unread —
 * which the fold would then treat as never observed, forever.
 *
 * ⚠️ Only `code === 200` is a reading, and only `404` is `closed`. ML's verbose
 * envelope carries a per-entry status, so a 403 or a 5xx arrives INSIDE a 200
 * with a hollow `body`. Reading `body` without `code` would turn a transient
 * failure into "this listing has no status", and a missing status is what the
 * fold reads as never observed — the safe direction, but only if we do not
 * mistake it for `closed`.
 *
 * ⚠️ A 404 entry carries no `body`, so it cannot name the id it answers FOR.
 * ML sends one entry per requested id, so position attributes it — but only when
 * the response is exactly as long as the request. On any other shape the entry is
 * dropped and that member reports `lido: false`, because an attribution that
 * might be off by one would record `closed` against the WRONG member, and
 * `closed` is the one reading that can take a family out of both sweeps.
 */
async function lerMembros(
  api: ReverificarApi,
  membros: readonly MembroDaFamilia[],
): Promise<{ lidos: Map<string, LeituraDeMembro>; chamadas: number }> {
  const pedidos = new Set(membros.map((m) => m.itemId));
  const ids = [...pedidos];
  const out = new Map<string, LeituraDeMembro>();
  let chamadas = 0;

  for (let i = 0; i < ids.length; i += ML_MULTIGET_MAX_IDS) {
    const lote = ids.slice(i, i + ML_MULTIGET_MAX_IDS);
    chamadas += 1;
    const resposta = await api.getItemsByIds(lote, [
      'id',
      'status',
      'sub_status',
      // #706: free here, and this is one of the few surfaces that sees a
      // member's own item — the field is written fill-only.
      'user_product_id',
    ]);
    const posicional = resposta.length === lote.length;
    resposta.forEach((entrada, indice) => {
      const body = (entrada.body ?? {}) as Record<string, unknown>;
      const doBody = typeof body.id === 'string' && pedidos.has(body.id) ? body.id : null;
      const id = doBody ?? (posicional ? (lote[indice] ?? null) : null);
      if (id == null) return;
      if (entrada.code === 404) {
        // The MEMBER is gone. Recorded explicitly — treating it as unreadable
        // would leave a stale `active` standing and the sweep would keep trying.
        // It still cannot cancel the family on its own: `foldFamilyStatus` needs
        // every member closed.
        out.set(id, { status: 'closed', subStatus: [], userProductId: null });
        return;
      }
      if (entrada.code !== 200) return;
      out.set(id, {
        status: typeof body.status === 'string' ? body.status : null,
        subStatus: Array.isArray(body.sub_status) ? (body.sub_status as string[]) : null,
        userProductId: typeof body.user_product_id === 'string' ? body.user_product_id : null,
      });
    });
  }
  return { lidos: out, chamadas };
}
