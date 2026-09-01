/**
 * PAUSE or REACTIVATE a listing on Mercado Livre, on the operator's command.
 *
 * Until this module there was no way to stop a sale from inside the ERP: the tab
 * offered Publicar / Republicar / Reverificar and rendered `paused`/`closed` as
 * read-only labels, so an operator who needed a listing off the air had to leave
 * the app and do it on mercadolivre.com.br. The only remote close in the repo
 * was `publishUserProduct`'s orphan sweep, which no UI can reach.
 *
 * ⚠️ **This is NOT a delist-on-delete cascade** (#476, closed by decision).
 * Deleting a produto in the ERP leaves the marketplace untouched; the listing's
 * lifecycle moves only when a human says so, which is exactly what this is.
 *
 * Modelled on `reverificarAnuncio.ts`, and deliberately so — the two share every
 * structural hazard. Four rules, each load-bearing:
 *
 *  1. ⚠️ **The family is resolved FIRST, before anything reaches ML.**
 *     `target.itemId` comes from the parent link's `id`, which under User
 *     Products is `familyId ?? itemIds[0]` (`publish.ts`) — so it is either ML's
 *     numeric family key, which `PUT /items/{id}` answers 404 for, or member 0's
 *     own item id, which would pause **one** listing while this function
 *     reported the whole family paused. That is #1142's rule; it applies to a
 *     write at least as sharply as it applied to a read.
 *  2. ⚠️ **A family id with no member links on disk THROWS** rather than falling
 *     back to `PUT /items/{familyId}` — see {@link AnuncioStatusFamiliaSemMembrosError}.
 *  3. ⚠️ **The writeback records ML's RESPONSE, never our request.** `updateItem`
 *     answers with the fresh item; that is what reaches the link doc, the way
 *     `estoqueSend`'s writeback does. Recording `paused` because we ASKED for
 *     `paused` would manufacture a reading ML never confirmed — and reactivation
 *     is precisely where the two diverge, because ML refuses to reactivate a
 *     zero-stock listing and answers `paused` + `out_of_stock` on a 200.
 *  4. **The body is `{ status }` and nothing else.** Same discipline as the price
 *     sender's price-only body: a status bundled with other fields is silently
 *     ignored on some listings, and here that would report a pause that never
 *     happened.
 *
 * `moderacoes` follows the "writer that merely holds a fresh status" rule
 * (#1252): `[]` when `precisaConsultarModeracao` says ML reports none, the key
 * OMITTED otherwise. No `/moderations` call — the predicate is pure — so a
 * moderated listing keeps the reason it was paused for.
 *
 * `errors`/`causas` ARE cleared on a write that lands, on both paths: those
 * record OUR last failed write to this listing, and ours just succeeded. That is
 * `estoqueSend`'s rule verbatim, and it is why the family path passes
 * `limparFalhaSempre` — without it the clear would be gated on the fold saying
 * stock can flow again, which after a deliberate pause it never does.
 *
 * A per-member failure is DATA: that member keeps its stored reading, the others
 * are recorded, and the result reports which ones ML refused. A failure on the
 * SINGLE-listing path throws instead — there is no partial state to report, and
 * the caller (route or bulk orchestrator) owns how a refusal is rendered.
 */
import {
  type MlItem,
  MercadoLivreHttpError,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import {
  type AcaoStatusAnuncio,
  STATUS_ML_DA_ACAO,
  precisaConsultarModeracao,
} from '@delfrance/schemas';
import type { Firestore } from 'firebase-admin/firestore';

import {
  type LinkStatusTarget,
  type ObservedMember,
  applyFamilyStatusAndFold,
  applyItemStatusToLink,
} from './itemsStatusSync';
import { type MembroDaFamilia, membrosDaFamilia } from './upMemberLink';
import { clearFalha } from '../core/publishFalhas';
import { isFamilyId } from '../core/linkRefs';
import { runPool } from '../core/pool';

/** How many members of one family are written at once. */
const MEMBER_CONCURRENCY = 4;

/** The minimal ML surface a status change needs (injectable for tests). */
export interface AnuncioStatusApi {
  updateItem(id: string, payload: Record<string, unknown>): Promise<MlItem>;
}

/** One member of a family whose status was changed. */
export interface AnuncioStatusMembro {
  /** This member's own ML item id. */
  itemId: string;
  /** The `variacaoMercadoLivre` doc the reading was recorded on. */
  memberDocId: string;
  /**
   * Did ML accept the change for this member? `false` means its STORED reading
   * still stands — nothing was overwritten, and nothing was assumed.
   */
  aplicado: boolean;
  /** What ML ANSWERED, not what was asked. Null when it refused. */
  status: string | null;
  subStatus: string[] | null;
  /** ML's refusal, operator-facing. Null when applied. */
  erro: string | null;
}

export interface AnuncioStatusResultado {
  /** Old-shape estado code derived from what ML reports NOW. */
  estado: string;
  /** Raw ML `status` after the change (`active`/`paused`/`closed`/…). */
  status: string | null;
  subStatus: string[] | null;
  /** Listings ML accepted the change for. */
  aplicados: number;
  /** Listings attempted — 1 for a simple listing, N for a User-Products family. */
  total: number;
  /**
   * Present only for a User-Products FAMILY, one entry per member — the level at
   * which a family actually HAS a status. The three fields above are the FOLD
   * over these (`upFamilyStatus.ts`), which is all the parent link can carry.
   */
  membros?: AnuncioStatusMembro[];
}

/**
 * The link stores a FAMILY id but this ERP holds no member links for it, so
 * there is nothing to address and no way to learn the members from what is on
 * disk.
 *
 * ⚠️ Its own class, and NOT a fallback to `PUT /items/{familyId}`: that call
 * answers 404, and the 404 handler below records `closed` — which on a family
 * means `estado 'c'`, the conta dropped from `integracoesComProduto`, and the
 * produto silently out of both ML sweeps. An operator pressing "Pausar" on one
 * listing would have taken every variation of it out of the sweeps instead. The
 * message names the action that rebuilds the member links.
 */
export class AnuncioStatusFamiliaSemMembrosError extends Error {
  constructor() {
    super(
      'Anúncio publicado como família do Mercado Livre, mas nenhuma variação está ' +
        'vinculada neste produto — importe ou publique o anúncio novamente antes de ' +
        'pausar ou reativar.',
    );
    this.name = 'AnuncioStatusFamiliaSemMembrosError';
  }
}

/**
 * Move ONE listing (or every member of one family) to the action's ML status.
 *
 * Transient failures (5xx / network / Firestore) and ML refusals THROW on the
 * single-listing path: nothing was confirmed, so nothing may be recorded. The
 * one exception is a **404**, which is not a failure but a fact — the listing is
 * gone — and is recorded as `closed` so the sweeps stop trying, exactly as
 * `reverificarAnuncio` does.
 */
export async function definirStatusAnuncio(
  db: Firestore,
  integracaoId: string,
  target: LinkStatusTarget,
  acao: AcaoStatusAnuncio,
  api: AnuncioStatusApi,
  nowMs: number,
): Promise<AnuncioStatusResultado> {
  const statusAlvo = STATUS_ML_DA_ACAO[acao];

  // ⚠️ ONE indexed group query, before anything reaches ML — rule 1 above.
  const membros = await membrosDaFamilia(db, target);
  if (membros.length > 0) {
    return await definirStatusFamilia(db, integracaoId, target, membros, statusAlvo, api, nowMs);
  }

  // A family id with no member links on disk. Refuse LOUDLY — see the class.
  if (isFamilyId(target.itemId)) throw new AnuncioStatusFamiliaSemMembrosError();

  let item: MlItem;
  try {
    item = await api.updateItem(target.itemId, { status: statusAlvo });
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      await applyItemStatusToLink(
        db,
        integracaoId,
        target,
        { status: 'closed', sub_status: [] },
        // `moderacoes: []` is spelled out: the listing is GONE, so any moderation
        // on it explains nothing and `/moderations` would 404 for it too. Same
        // reasoning, same shape, as `reverificarAnuncio`'s 404 branch.
        { nowMs, extra: { ...clearFalha(), moderacoes: [] } },
      );
      return {
        estado: estadoFromMlStatus('closed'),
        status: 'closed',
        subStatus: [],
        aplicados: 0,
        total: 1,
      };
    }
    throw err;
  }

  // ⚠️ Rule 3: `item` is ML's answer. On a reactivate of a zero-stock listing it
  // comes back `paused` + `out_of_stock` on a 200, and THAT is what gets stored.
  await applyItemStatusToLink(db, integracaoId, target, item, {
    nowMs,
    extra: {
      ...clearFalha(),
      // #1252 — gated on ML's own reading, never on the fact that our write
      // landed. A `poor_quality_thumbnail` listing is moderated AND writable, so
      // the predicate returns true, the key is omitted and the reason survives.
      ...(precisaConsultarModeracao(item.status, item.sub_status) ? {} : { moderacoes: [] }),
    },
  });

  return {
    estado: estadoFromMlStatus(item.status),
    status: item.status ?? null,
    subStatus: item.sub_status ?? null,
    aplicados: 1,
    total: 1,
  };
}

/** One member's outcome, before it is split into a fold input and a report row. */
interface ResultadoDeMembro {
  membro: MembroDaFamilia;
  item: MlItem | null;
  erro: string | null;
}

/**
 * Move every member of a User-Products family, then let the fold decide what the
 * FAMILY is.
 *
 * ⚠️ Every ML write happens BEFORE the fold's transaction. The fold re-runs its
 * callback on each OCC retry, and a network call in that window is root
 * `CLAUDE.md` rule 7's class C — it would re-issue every `PUT`.
 *
 * ⚠️ A member ML refused is left **unobserved** rather than assumed anything.
 * The fold then reads that member's stored values off disk exactly as it always
 * has, which is what makes a PARTIAL pause safe: three of four members paused
 * leaves a family the fold declines to call paused, and that is the truth.
 */
async function definirStatusFamilia(
  db: Firestore,
  integracaoId: string,
  target: LinkStatusTarget,
  membros: readonly MembroDaFamilia[],
  statusAlvo: string,
  api: AnuncioStatusApi,
  nowMs: number,
): Promise<AnuncioStatusResultado> {
  const resultados = new Map<string, ResultadoDeMembro>();
  await runPool(membros, MEMBER_CONCURRENCY, async (membro) => {
    try {
      const item = await api.updateItem(membro.itemId, { status: statusAlvo });
      resultados.set(membro.itemId, { membro, item, erro: null });
    } catch (err) {
      // ⚠️ Narrow, never generic (repo rule 6). Anything that is not an ML HTTP
      // refusal is a bug or an outage and must not be flattened into a row.
      if (!(err instanceof MercadoLivreHttpError)) throw err;
      resultados.set(membro.itemId, { membro, item: null, erro: err.message });
    }
  });

  const observados: ObservedMember[] = [];
  const relatorio: AnuncioStatusMembro[] = [];
  for (const membro of membros) {
    const r = resultados.get(membro.itemId);
    const item = r?.item ?? null;
    if (item == null) {
      relatorio.push({
        itemId: membro.itemId,
        memberDocId: membro.memberDocId,
        aplicado: false,
        status: null,
        subStatus: null,
        erro: r?.erro ?? 'não foi possível alterar este anúncio',
      });
      continue;
    }
    observados.push({
      memberProdutoId: membro.memberProdutoId,
      memberDocId: membro.memberDocId,
      status: item.status ?? null,
      subStatus: item.sub_status ?? null,
      // The "holds a fresh status" rule: `[]` when ML's own reading reports no
      // moderation, `null` ("never asked") otherwise so a stored reason stands.
      moderacoes: precisaConsultarModeracao(item.status, item.sub_status) ? null : [],
      // Not learned here — this call asks for nothing but a status change.
      userProductId: null,
    });
    relatorio.push({
      itemId: membro.itemId,
      memberDocId: membro.memberDocId,
      aplicado: true,
      status: item.status ?? null,
      subStatus: item.sub_status ?? null,
      erro: null,
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
    // Our write LANDED, so the `errors`/`causas` it recorded from a previous
    // failed write are stale. The fold's default would gate that clear on stock
    // being able to flow again — which after a deliberate pause it never can, so
    // the diagnosis would outlive the failure it describes.
    { limparFalhaSempre: true },
  );

  return {
    // ⚠️ The FOLD's answer, never one member's. `estado` feeds
    // `linkHasLiveListing` → `integracoesComProduto`, the anchor pre-filter both
    // ML sweeps open with, so one member's reading reaching it here would move a
    // produto in or out of the sweeps on the strength of a sibling.
    estado: folded.estado ?? estadoFromMlStatus(folded.status),
    status: folded.status,
    subStatus: folded.subStatus,
    aplicados: relatorio.filter((m) => m.aplicado).length,
    total: membros.length,
    membros: relatorio,
  };
}
