/**
 * The status write-back's ONE aviso tipo, `lojaIntegradaRastreioDivergente`
 * (master plan step 7, PR 7-d) — raised and resolved by the write-back run
 * (`rastreio/processarRastreio.ts`). Its contract is documented on
 * `tipoAvisoSchema` (`packages/schemas/src/aviso.ts`).
 *
 *  - **Key:** one row per pedido of the conta (`entidade: pedidoId`).
 *  - **Clock (root `CLAUDE.md` rule 7, tier 2):** the freight EVENT's own stamp,
 *    ms → µs through the order import's ONE conversion site
 *    (`pedidos/dataLi.ts`, `microsDeMillisLi`): `escreverAviso` drops a raise
 *    whose clock is `<=` the stored one, and a clocked `resolverAviso` stamps its
 *    clock — seeding a RESOLVED row when none exists — so an older event can
 *    neither reopen nor close a row a newer event wrote. Every raise and resolve
 *    of one run carries the same clock, which is why a run raises at most ONCE.
 *  - **Severity per call site:** `atencao`, except a `situacao-sobrescrita` the
 *    run flags `critico` (a codigo the write-back never writes onto was
 *    overwritten). A `critico` flag on any other motivo is ignored.
 *  - **Route:** the pedido. Canal `lojaIntegrada`, in-app only. Structured params
 *    only — the wording lives in `apps/web/lib/avisos/mensagens.ts`.
 *
 * ⚠️ Raised only by a run whose write decision was `on` — the caller decides
 * that; this module writes what it is asked to.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type PlanoAviso,
  type ResultadoAviso,
  escreverAviso,
  resolverAviso,
} from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  MOTIVO_RASTREIO_DIVERGENTE_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  type MotivoRastreioDivergenteLi,
} from '@delfrance/schemas';

import { type AvisoDepsLi, agoraUsDe } from '../avisos/avisos';
import { microsDeMillisLi } from '../pedidos/dataLi';

/** The motivo every machine resolution of this tipo is stamped with. */
export const MOTIVO_RESOLUCAO_RASTREIO_LI = {
  /** A clean run under `on`: the write landed and was read back, or LI already showed it all. */
  refletido: 'rastreio-refletido',
} as const;

/** One pedido, as the aviso names it. */
export interface PedidoDoAvisoRastreioLi {
  readonly integracaoId: string;
  /** The conta's `nome` — the operator-facing store name. */
  readonly lojaNome: string;
  readonly pedidoId: string;
  /** The order `numero`, as text. */
  readonly numero: string;
  /** The freight event's own stamp, in MILLISECONDS: the clock. */
  readonly eventoEmMs: number;
}

/** What one raise says, beyond the pedido. */
export interface AvisoRastreioLi {
  readonly motivo: MotivoRastreioDivergenteLi;
  /** A situação CODIGO (the five situação motivos). */
  readonly situacao?: string | null;
  /** The ERP freight estado (`transicao-lateral`, `situacao-nao-paga`). */
  readonly estado?: string | null;
  /** The HTTP status (`escrita-recusada`). */
  readonly status?: number | null;
  /** `situacao-sobrescrita` over a never-write codigo: `critico`. Ignored on any other motivo. */
  readonly critico?: boolean;
}

/** The dedup identity — and the document id — of one pedido's row. */
export function chaveDoAvisoRastreioLi(integracaoId: string, pedidoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.lojaIntegradaRastreioDivergente,
    conta: integracaoId,
    entidade: pedidoId,
  });
}

/** The metadata every write of the tipo carries (the seed, minus what a raise alone knows). */
function base(p: PedidoDoAvisoRastreioLi): Omit<PlanoAviso, 'relogioEvento'> {
  return {
    tipo: TIPO_AVISO.lojaIntegradaRastreioDivergente,
    conta: p.integracaoId,
    entidade: p.pedidoId,
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.lojaIntegrada,
    params: { loja: p.lojaNome, pedido: p.numero },
    urlInterna: { rota: ROTAS_AVISO.pedido.build(p.pedidoId), campo: null },
  };
}

/** The params of one raise: only what the motivo's wording reads, never an absent key. */
function paramsDo(
  p: PedidoDoAvisoRastreioLi,
  aviso: AvisoRastreioLi,
): Record<string, string | number> {
  return {
    loja: p.lojaNome,
    pedido: p.numero,
    motivo: aviso.motivo,
    ...(aviso.situacao == null ? {} : { situacao: aviso.situacao }),
    ...(aviso.estado == null ? {} : { estado: aviso.estado }),
    ...(aviso.status == null ? {} : { status: aviso.status }),
  };
}

/** Raise (or refresh) the pedido's row, clocked by the event (module header). */
export async function avisarRastreioDivergenteLi(
  db: Firestore,
  pedido: PedidoDoAvisoRastreioLi,
  aviso: AvisoRastreioLi,
  deps: AvisoDepsLi,
): Promise<ResultadoAviso> {
  const critico =
    aviso.critico === true && aviso.motivo === MOTIVO_RASTREIO_DIVERGENTE_LI.situacaoSobrescrita;
  const { resultado } = await escreverAviso(
    db,
    {
      ...base(pedido),
      severidade: critico ? SEVERIDADE_AVISO.critico : SEVERIDADE_AVISO.atencao,
      params: paramsDo(pedido, aviso),
      motivo: aviso.motivo,
      relogioEvento: microsDeMillisLi(pedido.eventoEmMs),
    },
    { increment: deps.increment, agoraUs: agoraUsDe(deps), logger: deps.logger },
  );
  return resultado;
}

/**
 * Close the pedido's row — ALWAYS clocked by the event: a resolve seeds a
 * resolved row when none exists, so a late raise of an older event is dropped.
 * `true` only on a real open → resolved transition.
 */
export function resolverRastreioDivergenteLi(
  db: Firestore,
  pedido: PedidoDoAvisoRastreioLi,
  deps: Pick<AvisoDepsLi, 'nowMs'>,
): Promise<boolean> {
  const b = base(pedido);
  return resolverAviso(
    db,
    chaveDeAviso(b),
    MOTIVO_RESOLUCAO_RASTREIO_LI.refletido,
    { agoraUs: agoraUsDe(deps) },
    { ...b, relogioEvento: microsDeMillisLi(pedido.eventoEmMs) },
  );
}
