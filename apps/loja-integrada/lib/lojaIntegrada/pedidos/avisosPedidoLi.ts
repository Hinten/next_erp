/**
 * The avisos of the order import (master plan step 5, PR 5-c, import step 11,
 * and the pipeline's exhaustion signal), each raised AND resolved by a named
 * machine resolver — the contract of each tipo is documented on
 * `tipoAvisoSchema` (`packages/schemas/src/aviso.ts`), and this module is its
 * producer:
 *
 * | Tipo | Key (`entidade`) | Clock | Raised when | Resolved when |
 * |---|---|---|---|---|
 * | `lojaIntegradaSituacaoDesconhecida` | the pedido id | the order's stamp | the codigo is unknown to the table | the codigo is known |
 * | `lojaIntegradaPedidoContestado` | the pedido id | the order's stamp | the decision names a motivo | any import that raises none |
 * | `lojaIntegradaPedidoHub` | the pedido id | the order's stamp | a hub marker, on a live sale | no marker, or a dead sale |
 * | `lojaIntegradaFreteNaoSuportado` | `sha256Hex(chave)` | the routing read's `readTime` | the routing says so | the routing says so |
 * | `lojaIntegradaPedidoPagoSemEndereco` | the pedido id | the order's stamp | a paid order carrying no CEP ran out of retries (`pedidoPagoSemEndereco.ts`, from the pipeline's park) | any import that reaches the avisos |
 * | `lojaIntegradaReversaoComEtiqueta` | the pedido id | the order's stamp | a reversal codigo on a pedido that holds a bought label | any import that raises none |
 *
 * `lojaIntegradaPedidoPagoSemEndereco` is the one `critico` tipo; every other
 * one is `atencao`. It and `lojaIntegradaPedidoHub` open on the conta page (on
 * a first import there is no pedido page), and so does the freight tipo (it
 * is about the conta's `mapa`); the rest open on the pedido.
 *
 * ## The clocks (root `CLAUDE.md` rule 7, tier 2)
 *
 * The order-clocked tipos carry the order's Loja Integrada stamp in µs,
 * as the import converted it (`dataLiParaMicros`): `escreverAviso` drops a
 * raise whose clock is `<=` the stored one, and a clocked `resolverAviso`
 * stamps its clock — seeding a RESOLVED row when none exists — so a late import
 * of an older observation can neither reopen nor close a row. ⚠️ Per-order µs:
 * never compare it with another tipo's clock. The import calls this only on
 * `importado` and `sem-mudanca` (and on `hub`), never on `obsoleto`, so a retry
 * after a crash between the batch and the avisos (an equal stamp, an empty
 * patch) still raises what the first run did not: an equal clock on a stored
 * raise is a no-op.
 *
 * The freight tipo records an observation of the mapping's STATE, so its clock
 * is the µs `readTime` of the read the routing decided from — the target's
 * read, else the conta's `int_frete` read (`registrarFormaEnvioNoMapaLi`'s).
 * ⚠️ It is NEVER resolved clockless: the reprocess sweep runs inline beside the
 * serial queue, so an import that read the `mapa` before the operator re-mapped
 * the key could otherwise close the row a newer read had just raised. With no
 * read to clock it (the conta's lookup found no Loja Integrada `int_frete`, so
 * nothing was read by id) the aviso is left alone: a raised row then stands
 * until the key's next routed import, never closed by a guess.
 *
 * The paid-without-address tipo is raised at a different MOMENT — by the
 * notification pipeline's exhaustion signal, after the sweep parked the
 * notification — but with the same clock: the stamp of the order that exhausted
 * run read. So the import that later finds the address (a newer stamp)
 * resolves it, and a late exhaustion of an older observation is dropped by
 * the seed every resolve leaves behind.
 *
 * Every write goes through `escreverAviso` / `resolverAviso`
 * (`@delfrance/data/admin/avisos`), with "now" converted in `avisos/avisos.ts`
 * (`agoraUsDe`). Structured params only — the wording lives in
 * `apps/web/lib/avisos/mensagens.ts`. Canal `lojaIntegrada`, in-app only.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  escreverAviso,
  resolverAviso,
  type PlanoAviso,
  type ResultadoAviso,
} from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  type MotivoPedidoContestadoLi,
  type MotivoReversaoComEtiquetaLi,
} from '@delfrance/schemas';

import { agoraUsDe, type AvisoDepsLi } from '../avisos/avisos';
import { entidadeAvisoFreteLi, type AvisoFreteLi } from './freteMapeamento';

/** The motivos the machine resolutions of this module's tipos are stamped with. */
export const MOTIVO_RESOLUCAO_PEDIDO_LI = {
  /** The order came back with a codigo the shared table knows. */
  situacaoConhecida: 'situacao-conhecida',
  /** An import whose decision names no contestation motivo. */
  semContestacao: 'sem-contestacao',
  /** The order came back without a hub marker. */
  semMarcaDeHub: 'sem-marca-de-hub',
  /** A hub-marked order in a dead-sale codigo: nothing is left to import. */
  vendaEncerrada: 'venda-encerrada',
  /** The key's routing raised no aviso. */
  freteRoteado: 'frete-roteado',
  /** An import got past the paid-without-address check: the order reached the ERP. */
  pedidoImportado: 'pedido-importado',
  /** An import whose order is no reversal, or whose pedido holds no bought label. */
  semReversaoComEtiqueta: 'sem-reversao-com-etiqueta',
} as const;

/** One order, as its avisos name it. */
export interface PedidoDoAvisoLi {
  readonly integracaoId: string;
  /** The conta's `nome` — the operator-facing store name. */
  readonly lojaNome: string;
  /** The deterministic pedido id (the one a hub order WOULD have). */
  readonly pedidoId: string;
  /** The order's numero, as text. */
  readonly numero: string;
  /** The order's Loja Integrada stamp, µs: every order-clocked tipo's clock (module header). */
  readonly relogioUs: number;
}

/** What one tipo's sync did. */
export type EfeitoAvisoLi =
  | { readonly acao: 'levantado'; readonly resultado: ResultadoAviso }
  | { readonly acao: 'resolvido'; readonly fechou: boolean }
  /** No clock to act on (the freight tipo only — module header). */
  | { readonly acao: 'nenhum' };

type TipoDoPedido =
  | typeof TIPO_AVISO.lojaIntegradaSituacaoDesconhecida
  | typeof TIPO_AVISO.lojaIntegradaPedidoContestado
  | typeof TIPO_AVISO.lojaIntegradaPedidoHub
  | typeof TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco
  | typeof TIPO_AVISO.lojaIntegradaReversaoComEtiqueta;

/** The order-keyed tipos whose row opens on the conta page: no pedido page may exist. */
const TIPOS_NA_CONTA: ReadonlySet<TipoDoPedido> = new Set<TipoDoPedido>([
  TIPO_AVISO.lojaIntegradaPedidoHub,
  TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
]);

/** The key of an order-keyed tipo: one row per pedido of the conta. */
export function chaveDoAvisoDoPedidoLi(
  tipo: TipoDoPedido,
  integracaoId: string,
  pedidoId: string,
): string {
  return chaveDeAviso({ tipo, conta: integracaoId, entidade: pedidoId });
}

/** The key of the freight tipo: one row per shipping-method KEY of the conta, digested. */
export function chaveDoAvisoDeFreteLi(integracaoId: string, chave: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.lojaIntegradaFreteNaoSuportado,
    conta: integracaoId,
    entidade: entidadeAvisoFreteLi(chave),
  });
}

function rotaDoPedido(pedidoId: string): { rota: string; campo: null } {
  return { rota: ROTAS_AVISO.pedido.build(pedidoId), campo: null };
}

function rotaDaConta(integracaoId: string): { rota: string; campo: null } {
  return { rota: ROTAS_AVISO.canalLojaIntegrada.build(integracaoId), campo: null };
}

/** The metadata every write of an order-keyed tipo carries (its seed, minus what it alone knows). */
function baseDoPedido(tipo: TipoDoPedido, p: PedidoDoAvisoLi): Omit<PlanoAviso, 'relogioEvento'> {
  return {
    tipo,
    conta: p.integracaoId,
    entidade: p.pedidoId,
    // A paid sale that never reached the ERP is critical; the rest is about one order.
    severidade:
      tipo === TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco
        ? SEVERIDADE_AVISO.critico
        : SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.lojaIntegrada,
    params: { loja: p.lojaNome, pedido: p.numero },
    urlInterna: TIPOS_NA_CONTA.has(tipo) ? rotaDaConta(p.integracaoId) : rotaDoPedido(p.pedidoId),
  };
}

async function levantar(
  db: Firestore,
  plano: PlanoAviso,
  deps: AvisoDepsLi,
): Promise<EfeitoAvisoLi> {
  const { resultado } = await escreverAviso(db, plano, {
    increment: deps.increment,
    agoraUs: agoraUsDe(deps),
    logger: deps.logger,
  });
  return { acao: 'levantado', resultado };
}

/** A CLOCKED resolve, seeding a resolved row when none exists (module header). */
async function resolver(
  db: Firestore,
  base: Omit<PlanoAviso, 'relogioEvento'>,
  motivo: string,
  relogioUs: number,
  deps: AvisoDepsLi,
): Promise<EfeitoAvisoLi> {
  const fechou = await resolverAviso(
    db,
    chaveDeAviso(base),
    motivo,
    { agoraUs: agoraUsDe(deps) },
    { ...base, relogioEvento: relogioUs },
  );
  return { acao: 'resolvido', fechou };
}

export interface DecisaoDosAvisosLi {
  /** The unknown codigo, or `null` (resolve). */
  readonly situacaoDesconhecida: string | null;
  /** The contestation motivo, or `null` (resolve). */
  readonly contestacao: MotivoPedidoContestadoLi | null;
  /** The reversal that landed on a pedido with a bought label, or `null` (resolve). */
  readonly reversaoComEtiqueta: MotivoReversaoComEtiquetaLi | null;
}

/**
 * The order-clocked tipos of an import that got past the hub guard
 * (`importado` or `sem-mudanca`): the situação, the contestation and the
 * reversal-after-the-label follow the decision, the hub row resolves (the
 * order carries no marker), and so does the paid-without-address row (the
 * order got past that check and reached the ERP).
 */
export async function sincronizarAvisosDoPedidoLi(
  db: Firestore,
  pedido: PedidoDoAvisoLi,
  decisao: DecisaoDosAvisosLi,
  deps: AvisoDepsLi,
): Promise<{
  readonly situacao: EfeitoAvisoLi;
  readonly contestado: EfeitoAvisoLi;
  readonly hub: EfeitoAvisoLi;
  readonly pagoSemEndereco: EfeitoAvisoLi;
  readonly reversaoComEtiqueta: EfeitoAvisoLi;
}> {
  const relogio = pedido.relogioUs;

  const baseSituacao = baseDoPedido(TIPO_AVISO.lojaIntegradaSituacaoDesconhecida, pedido);
  const situacao =
    decisao.situacaoDesconhecida === null
      ? await resolver(
          db,
          baseSituacao,
          MOTIVO_RESOLUCAO_PEDIDO_LI.situacaoConhecida,
          relogio,
          deps,
        )
      : await levantar(
          db,
          {
            ...baseSituacao,
            params: { ...baseSituacao.params, codigo: decisao.situacaoDesconhecida },
            relogioEvento: relogio,
          },
          deps,
        );

  const baseContestado = baseDoPedido(TIPO_AVISO.lojaIntegradaPedidoContestado, pedido);
  const contestado =
    decisao.contestacao === null
      ? await resolver(db, baseContestado, MOTIVO_RESOLUCAO_PEDIDO_LI.semContestacao, relogio, deps)
      : await levantar(
          db,
          {
            ...baseContestado,
            params: { ...baseContestado.params, motivo: decisao.contestacao },
            motivo: decisao.contestacao,
            relogioEvento: relogio,
          },
          deps,
        );

  const hub = await resolver(
    db,
    baseDoPedido(TIPO_AVISO.lojaIntegradaPedidoHub, pedido),
    MOTIVO_RESOLUCAO_PEDIDO_LI.semMarcaDeHub,
    relogio,
    deps,
  );
  const pagoSemEndereco = await resolver(
    db,
    baseDoPedido(TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco, pedido),
    MOTIVO_RESOLUCAO_PEDIDO_LI.pedidoImportado,
    relogio,
    deps,
  );

  const baseReversao = baseDoPedido(TIPO_AVISO.lojaIntegradaReversaoComEtiqueta, pedido);
  const reversaoComEtiqueta =
    decisao.reversaoComEtiqueta === null
      ? await resolver(
          db,
          baseReversao,
          MOTIVO_RESOLUCAO_PEDIDO_LI.semReversaoComEtiqueta,
          relogio,
          deps,
        )
      : await levantar(
          db,
          {
            ...baseReversao,
            params: { ...baseReversao.params, motivo: decisao.reversaoComEtiqueta },
            motivo: decisao.reversaoComEtiqueta,
            relogioEvento: relogio,
          },
          deps,
        );
  return { situacao, contestado, hub, pagoSemEndereco, reversaoComEtiqueta };
}

/**
 * Raise "a PAID order's retries ran out without a CEP to deliver to" — called
 * only by the notification pipeline's exhaustion signal
 * (`pedidoPagoSemEndereco.ts`), never by an import: an import that would raise
 * it throws instead, so the queue and the sweep retry first. Clocked by the
 * order's stamp as the exhausted run read it (module header).
 */
export function avisarPedidoPagoSemEnderecoLi(
  db: Firestore,
  pedido: PedidoDoAvisoLi,
  deps: AvisoDepsLi,
): Promise<EfeitoAvisoLi> {
  return levantar(
    db,
    {
      ...baseDoPedido(TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco, pedido),
      relogioEvento: pedido.relogioUs,
    },
    deps,
  );
}

/**
 * A hub-marked order (D5): nothing is imported. Raised on a live sale; resolved
 * on a dead one (cancelled or refunded: nothing is left to import).
 */
export function sincronizarAvisoDeHubLi(
  db: Firestore,
  pedido: PedidoDoAvisoLi,
  vendaEncerrada: boolean,
  deps: AvisoDepsLi,
): Promise<EfeitoAvisoLi> {
  const base = baseDoPedido(TIPO_AVISO.lojaIntegradaPedidoHub, pedido);
  return vendaEncerrada
    ? resolver(db, base, MOTIVO_RESOLUCAO_PEDIDO_LI.vendaEncerrada, pedido.relogioUs, deps)
    : levantar(db, { ...base, relogioEvento: pedido.relogioUs }, deps);
}

export interface AvisoDeFreteDoPedidoLi {
  readonly integracaoId: string;
  readonly lojaNome: string;
  /** The routing's effect on the aviso (`rotearFreteLi`). */
  readonly aviso: AvisoFreteLi;
  /** The µs `readTime` the routing decided from, or `null` when nothing was read by id. */
  readonly relogioUs: number | null;
}

/** The freight tipo, as the routing decided (module header). */
export function sincronizarAvisoDeFreteLi(
  db: Firestore,
  entrada: AvisoDeFreteDoPedidoLi,
  deps: AvisoDepsLi,
): Promise<EfeitoAvisoLi> {
  const { integracaoId, lojaNome, aviso, relogioUs } = entrada;
  // Never clockless (module header).
  if (relogioUs === null) return Promise.resolve({ acao: 'nenhum' });
  const base: Omit<PlanoAviso, 'relogioEvento'> = {
    tipo: TIPO_AVISO.lojaIntegradaFreteNaoSuportado,
    conta: integracaoId,
    entidade: entidadeAvisoFreteLi(aviso.chave),
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.lojaIntegrada,
    params: { loja: lojaNome, chave: aviso.chave },
    urlInterna: rotaDaConta(integracaoId),
  };
  if (aviso.tipo === 'resolver') {
    return resolver(db, base, MOTIVO_RESOLUCAO_PEDIDO_LI.freteRoteado, relogioUs, deps);
  }
  return levantar(
    db,
    {
      ...base,
      // The row's display name; the raw key when the row carries none.
      params: {
        loja: lojaNome,
        formaEnvio: aviso.formaEnvio ?? aviso.chave,
        chave: aviso.chave,
        motivo: aviso.motivo,
      },
      motivo: aviso.motivo,
      relogioEvento: relogioUs,
    },
    deps,
  );
}
