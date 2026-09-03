/**
 * The operator-driven PAUSE / REACTIVATE run — one hand-picked listing from the
 * produto's Mercado Livre tab, or a whole selection from the produtos table.
 *
 * ONE orchestrator serves both, because they differ only in how the target set
 * is discovered: the tab names a `linkDocId`, the table names produtos. The
 * envelope is deliberately the SHAPE `enviar-estoque` answers in
 * (`PushEstoqueResponse`), so `apps/web`'s channel-neutral push machinery
 * dispatches it without learning anything new, and a second marketplace's
 * `POST /api/marketplace/<canal>/anuncio-status` can answer the same way.
 *
 * Per-listing failure is DATA, not an HTTP error: a valid request answers 200
 * even when every listing was refused. The 4xx ladder in the route is only for
 * what stops the whole request.
 *
 * ⚠️ Whether a listing is eligible at all is `acaoStatusAnuncio` in
 * `packages/schemas` — the SAME predicate `apps/web` uses to decide whether to
 * render the button. A second copy here is the failure mode #1239 and #786 were
 * extracted to avoid: an operator offered a control the backend refuses, or a
 * backend refusing what the UI presents as available.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type AcaoStatusAnuncio,
  ACAO_STATUS_ANUNCIO,
  ESTADO_PUBLICACAO_ML,
  acaoStatusAnuncio,
} from '@delfrance/schemas';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { resolverAnchors } from '../core/anchors';
import { runPool } from '../core/pool';
import { refMatchesIntegracao } from '../core/linkRefs';
import {
  type AnuncioStatusApi,
  AnuncioStatusFamiliaSemMembrosError,
  definirStatusAnuncio,
} from './anuncioStatus';

/** Legacy parity with the other two produto-scoped pushes; the route rejects past it. */
export const ANUNCIO_STATUS_MAX_PRODUTOS = 50;

/** How many listings are moved at once across the whole selection. */
const LISTING_CONCURRENCY = 4;

export type AnuncioStatusOutcome = 'enviado' | 'pulado' | 'falha' | 'nao-tentado';

export interface AnuncioStatusListing {
  /** The family ANCHOR produto this listing hangs off. */
  produtoId: string;
  produtoNome: string | null;
  /** ML item id (or the family key). Null when never published. */
  anuncioId: string | null;
  /** The ERP link doc id — the UI's key back into the produto's anúncios tab. */
  linkDocId: string | null;
  outcome: AnuncioStatusOutcome;
  /** Machine-readable code; null only on `'enviado'`. */
  motivo: string | null;
  /** Operator-facing pt-BR text — always present, always safe to render. */
  mensagem: string;
  /** What ML reports for the listing NOW. Null when nothing was confirmed. */
  statusFinal: string | null;
  /** Member tally for a User-Products family; null for a simple listing. */
  membros: { total: number; aplicados: number } | null;
}

export interface AnuncioStatusSemAnuncio {
  produtoId: string;
  produtoNome: string | null;
  motivo: string;
  mensagem: string;
}

export interface AnuncioStatusResponse {
  canal: 'mercado-livre';
  integracaoId: string;
  acao: AcaoStatusAnuncio;
  /** Deduped request size. */
  solicitados: number;
  /** Anchors actually discovered. */
  familias: number;
  resumo: { aplicados: number; pulados: number; falhas: number; naoTentados: number };
  listings: AnuncioStatusListing[];
  /** Requested produtos that produced no listing at all, and why. */
  produtosSemAnuncio: AnuncioStatusSemAnuncio[];
  /** ISO-8601 — set when ML rate-limited us; the rest was not attempted. */
  pausadoAte: string | null;
}

/**
 * pt-BR for every reason a listing comes back unchanged. This run is the ONLY
 * surface where these reach a human, so each names the cause AND the remedy.
 */
const MENSAGEM_POR_MOTIVO: Record<string, string> = {
  'sem-id-externo': 'O anúncio ainda não foi publicado no Mercado Livre.',
  'anuncio-cancelado':
    'Anúncio encerrado no Mercado Livre — um anúncio encerrado não pode ser pausado nem reativado.',
  'status-indefinido':
    'O Mercado Livre ainda está avaliando este anúncio. Use "Reverificar anúncio" antes de alterar o status.',
  'anuncio-em-migracao':
    'Anúncio em migração para o modelo User Products — o Mercado Livre recusa qualquer alteração ' +
    'até concluir. Aguarde e tente novamente.',
  'ja-pausado': 'Este anúncio já está pausado.',
  'ja-ativo': 'Este anúncio já está ativo.',
  'familia-sem-membros':
    'Anúncio publicado como família do Mercado Livre, mas nenhuma variação está vinculada — ' +
    'importe ou publique o anúncio novamente.',
  'nao-tentado': 'Não tentado — o Mercado Livre limitou as requisições desta conta.',
};

export interface AnuncioStatusManualInput {
  integracaoId: string;
  produtoIds: readonly string[];
  acao: AcaoStatusAnuncio;
  /**
   * Narrows the run to ONE listing — the produto tab's per-anúncio button. Only
   * meaningful with a single produtoId; the route enforces that.
   */
  linkDocId?: string | null;
}

export interface AnuncioStatusManualDeps {
  api: AnuncioStatusApi;
  /** Injected so tests never reach the real writer. */
  definir?: typeof definirStatusAnuncio;
  /** The ONE clock read of this request. */
  nowMs: number;
}

/** One link doc this run will try to move. */
interface AlvoDeLink {
  anchorId: string;
  linkDocId: string;
  itemId: string | null;
  raw: Record<string, unknown>;
}

/**
 * Move every eligible listing of the selected produtos.
 *
 * Cost: one masked point read per selected produto (`resolverAnchors`), one
 * subcollection read per anchor, then one ML `PUT` per listing — or per family
 * MEMBER, which `definirStatusAnuncio` owns.
 */
export async function definirStatusAnunciosManual(
  db: Firestore,
  input: AnuncioStatusManualInput,
  deps: AnuncioStatusManualDeps,
): Promise<AnuncioStatusResponse> {
  const definir = deps.definir ?? definirStatusAnuncio;
  const solicitados = [...new Set(input.produtoIds)];
  const resolved = await resolverAnchors(db, solicitados);

  const produtosSemAnuncio: AnuncioStatusSemAnuncio[] = [];
  const nomeDe = (id: string) => resolved.nomePorProdutoId.get(id) ?? null;

  for (const id of resolved.naoEncontrados) {
    produtosSemAnuncio.push({
      produtoId: id,
      produtoNome: null,
      motivo: 'produto-nao-encontrado',
      mensagem: 'Produto não encontrado.',
    });
  }

  // ---- Discover the link docs, one subcollection read per anchor.
  const alvos: AlvoDeLink[] = [];
  for (const anchorId of resolved.anchorIds) {
    const snap = await produtoMercadoLivreLinkCollection.ref(db, { produtoId: anchorId }).get();
    const daConta = snap.docs.filter((d) =>
      // The conta check reads `contaOuterRef`, the same field and the same
      // helper every other ML surface proves ownership with.
      refMatchesIntegracao((d.data() as Record<string, unknown>).contaOuterRef, input.integracaoId),
    );
    const escolhidos =
      input.linkDocId != null ? daConta.filter((d) => d.id === input.linkDocId) : daConta;

    if (escolhidos.length === 0) {
      produtosSemAnuncio.push({
        produtoId: anchorId,
        produtoNome: nomeDe(anchorId),
        motivo: 'sem-anuncio',
        mensagem:
          input.linkDocId != null
            ? 'Anúncio não encontrado neste produto para esta conta.'
            : 'Este produto não tem anúncio nesta conta.',
      });
      continue;
    }
    for (const d of escolhidos) {
      const raw = (d.data() ?? {}) as Record<string, unknown>;
      alvos.push({
        anchorId,
        linkDocId: d.id,
        itemId: typeof raw.id === 'string' && raw.id !== '' ? raw.id : null,
        raw,
      });
    }
  }

  // ---- Gate locally, then move what remains.
  const listings: AnuncioStatusListing[] = [];
  const paraEnviar: AlvoDeLink[] = [];
  for (const alvo of alvos) {
    const motivo = motivoRecusaLocal(alvo.raw, input.acao);
    if (motivo != null) {
      listings.push(linhaPulada(alvo, nomeDe(alvo.anchorId), motivo));
      continue;
    }
    paraEnviar.push(alvo);
  }

  let pausadoAte: string | null = null;
  await runPool(paraEnviar, LISTING_CONCURRENCY, async (alvo) => {
    if (pausadoAte != null) {
      // ML rate-limited this conta; stop asking rather than hammering it. The
      // row says so instead of leaving the listing unaccounted for.
      listings.push(linhaPulada(alvo, nomeDe(alvo.anchorId), 'nao-tentado', 'nao-tentado'));
      return;
    }
    try {
      const res = await definir(
        db,
        input.integracaoId,
        { produtoId: alvo.anchorId, linkDocId: alvo.linkDocId, itemId: alvo.itemId! },
        input.acao,
        deps.api,
        deps.nowMs,
      );
      const parcial = res.aplicados > 0 && res.aplicados < res.total;
      listings.push({
        produtoId: alvo.anchorId,
        produtoNome: nomeDe(alvo.anchorId),
        anuncioId: alvo.itemId,
        linkDocId: alvo.linkDocId,
        outcome: res.aplicados === 0 ? 'falha' : 'enviado',
        motivo: res.aplicados === 0 ? 'nenhum-anuncio-alterado' : parcial ? 'parcial' : null,
        mensagem: mensagemDoResultado(input.acao, res.aplicados, res.total, res.status),
        statusFinal: res.status,
        membros: res.membros ? { total: res.total, aplicados: res.aplicados } : null,
      });
    } catch (err) {
      if (err instanceof AnuncioStatusFamiliaSemMembrosError) {
        listings.push(linhaPulada(alvo, nomeDe(alvo.anchorId), 'familia-sem-membros'));
        return;
      }
      // ⚠️ Narrow, never generic (repo rule 6): anything that is not an ML HTTP
      // refusal is a bug or an outage, and flattening it into a row would report
      // a per-listing problem for a request that failed as a whole.
      if (!(err instanceof MercadoLivreHttpError)) throw err;
      if (err.status === 429) {
        pausadoAte = new Date(deps.nowMs + 60_000).toISOString();
      }
      listings.push({
        produtoId: alvo.anchorId,
        produtoNome: nomeDe(alvo.anchorId),
        anuncioId: alvo.itemId,
        linkDocId: alvo.linkDocId,
        outcome: 'falha',
        motivo: err.status === 429 ? 'rate-limit' : 'erro-mercado-livre',
        // ML's own message is more specific than anything invented here.
        mensagem: err.message,
        statusFinal: null,
        membros: null,
      });
    }
  });

  return {
    canal: 'mercado-livre',
    integracaoId: input.integracaoId,
    acao: input.acao,
    solicitados: solicitados.length,
    familias: resolved.anchorIds.length,
    resumo: {
      aplicados: listings.filter((l) => l.outcome === 'enviado').length,
      pulados: listings.filter((l) => l.outcome === 'pulado').length,
      falhas: listings.filter((l) => l.outcome === 'falha').length,
      naoTentados: listings.filter((l) => l.outcome === 'nao-tentado').length,
    },
    listings,
    produtosSemAnuncio,
    pausadoAte,
  };
}

/**
 * Why this stored link cannot take the action — or `null` when it can.
 *
 * ⚠️ The eligibility half delegates to `acaoStatusAnuncio`; only the "already
 * there" rung is decided here, because it depends on WHICH action was asked for
 * and the shared predicate answers what the listing SUPPORTS. Re-deriving
 * eligibility locally is exactly the drift this arrangement exists to prevent.
 */
function motivoRecusaLocal(raw: Record<string, unknown>, acao: AcaoStatusAnuncio): string | null {
  const disponivel = acaoStatusAnuncio(raw);
  if (disponivel === acao) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return 'sem-id-externo';
  if (disponivel === null) {
    if (raw.status === 'closed' || raw.estado === ESTADO_PUBLICACAO_ML.cancelado) {
      return 'anuncio-cancelado';
    }
    // ⚠️ Its OWN motivo, not `status-indefinido`. The two look alike and the
    // REMEDY is opposite: a mid-decision listing is what "Reverificar anúncio"
    // exists for, while a migrating one is not stale at all — ML is rebuilding
    // it and re-reading changes nothing. Telling the operator to press
    // Reverificar there sends them to a button that cannot help.
    if (raw.estado === ESTADO_PUBLICACAO_ML.aguardandoMigracao) return 'anuncio-em-migracao';
    return 'status-indefinido';
  }
  // The listing supports the OTHER direction — it is already where the operator
  // is trying to take it. A skip, never a failure.
  return acao === ACAO_STATUS_ANUNCIO.pausar ? 'ja-pausado' : 'ja-ativo';
}

function linhaPulada(
  alvo: AlvoDeLink,
  produtoNome: string | null,
  motivo: string,
  outcome: AnuncioStatusOutcome = 'pulado',
): AnuncioStatusListing {
  return {
    produtoId: alvo.anchorId,
    produtoNome,
    anuncioId: alvo.itemId,
    linkDocId: alvo.linkDocId,
    outcome,
    motivo,
    mensagem: MENSAGEM_POR_MOTIVO[motivo] ?? 'Anúncio não alterado.',
    statusFinal: typeof alvo.raw.status === 'string' ? alvo.raw.status : null,
    membros: null,
  };
}

/**
 * ⚠️ The wording reports what ML CONFIRMED, never the action requested. A
 * reactivate ML answered `paused` + `out_of_stock` for is a listing that is
 * still not selling, and saying "reativado" there would be a green row over a
 * dead listing.
 */
function mensagemDoResultado(
  acao: AcaoStatusAnuncio,
  aplicados: number,
  total: number,
  status: string | null,
): string {
  const verbo = acao === ACAO_STATUS_ANUNCIO.pausar ? 'pausado' : 'reativado';
  if (aplicados === 0) return `O Mercado Livre não aceitou ${verbo} nenhum anúncio.`;
  const alcance =
    total > 1
      ? aplicados === total
        ? `Todas as ${String(total)} variações foram alteradas`
        : `${String(aplicados)} de ${String(total)} variações foram alteradas`
      : `Anúncio ${verbo}`;
  const esperado = acao === ACAO_STATUS_ANUNCIO.pausar ? 'paused' : 'active';
  if (status != null && status !== esperado) {
    // The honest case: our write landed but ML settled somewhere else.
    return `${alcance}, mas o Mercado Livre reporta o anúncio como "${status}".`;
  }
  return `${alcance}.`;
}
