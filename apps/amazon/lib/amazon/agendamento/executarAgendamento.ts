/**
 * ONE Easy Ship scheduling run (step 15, PR 15-b): the ONE caller of the write
 * engine (`core/escrita.ts`) for this flow, shared by the scheduling task
 * (`modo: 'tarefa'`, 15-c: `processarAgendamento.ts`) and the label route
 * (`modo: 'impressao'`, 15-d: `etiquetaAmazon.ts`).
 *
 * Inside the engine, in its order: the target under the valve (`off` reads
 * nothing); the LIVE order through `pedidos/lerPedidoAmazon.ts` (the one
 * `getOrder` caller), floored by the stored watermark; the pure decision and
 * plan (`decisaoAgendamento.ts`, the caller's NF-e gate applied); the dry-run's
 * one diff line; else the token mint and the bulk, ONCE
 * (`easyShipAmazon.ts`), through the forced-refresh-once rule.
 *
 * ## The PHASE of a failure
 *
 * The engine lets the read's and the write's errors out through the SAME
 * throw, so a `getOrder` 404 and a bulk 404 would be one class. The run tells
 * them apart with a flag set when the engine hands `escrever` its plan: every
 * failure before that is `fase: 'leitura'` (nothing was sent — never a
 * scheduling refusal), every one after it `fase: 'escrita'`, with the plan the
 * write was made on (step-15 plan §3 decision 11). An `escrita` failure is not
 * necessarily the bulk's: the token mint, or an LWA refresh a credential getter
 * makes, fails inside the same `escrever`. Each HTTP error carries the call that
 * raised it, and only the bulk's speaks for the order
 * (`easyShipAmazon.ts`'s `ehFalhaHttpDoBulkEasyShip`).
 *
 * The failures it answers as `{ tipo: 'falha', fase, erro }`, by class (root
 * `CLAUDE.md` rule 6):
 *
 * - the package's `AmazonError` family (every package error roots there);
 * - the order read's own refusals, `PedidoAmazonIlegivelError` and
 *   `AmazonLeituraDefasadaError`;
 * - the context's conta and credential classes, which the credential getter
 *   throws DURING the run when a credential is parked or removed between the
 *   context load and a request (`ChamadasAmazonDesligadasError`,
 *   `ContaAmazonNaoEncontradaError`, `ContaAmazonInativaError`,
 *   `ContaAmazonNaoConectadaError`, `ContaAmazonParadaError`,
 *   `CredencialAmazonAusenteError`, `CredencialAmazonInvalidaError`).
 *
 * Anything else — a Firestore error, a `TypeError`, the engine's conta mismatch
 * — PROPAGATES. Each caller maps the failure onto its own answers (a read-side
 * one through `pedidos/falhaLeituraAmazon.ts`).
 */
import {
  AmazonError,
  type RespostaAgendamentoEasyShip,
} from '@delfrance/integrations-amazon-sp-api';

import type { ContextoAmazon } from '../core/contexto';
import {
  ChamadasAmazonDesligadasError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
} from '../core/erros';
import {
  type DepsEscritaAmazon,
  type ResultadoEscritaAmazon,
  executarEscritaAmazon,
} from '../core/escrita';
import type { RegistroDeChamadaAmazon } from '../core/log';
import type { FLUXO_AMAZON, ValvulaAmazon } from '../core/valvulas';
import { AmazonLeituraDefasadaError, PedidoAmazonIlegivelError } from '../pedidos/erros';
import { type LeituraPedidoAmazon, lerPedidoAmazon } from '../pedidos/lerPedidoAmazon';
import {
  type DecisaoAgendamentoAmazon,
  type GateNotasAgendamentoAmazon,
  type ModoAgendamentoAmazon,
  type PlanoAgendamentoAmazon,
  decidirAgendamentoAmazon,
  planoAgendamentoAmazon,
} from './decisaoAgendamento';
import { agendarNaAmazon } from './easyShipAmazon';

/** Which half of the run failed (module header). */
export type FaseFalhaAgendamentoAmazon = 'leitura' | 'escrita';

export const FASE_FALHA_AGENDAMENTO_AMAZON = {
  leitura: 'leitura',
  escrita: 'escrita',
} as const satisfies Record<string, FaseFalhaAgendamentoAmazon>;

/** The order the run schedules, as the caller PROVED it. */
export interface AlvoAgendamentoAmazon {
  /** The conta the pedido belongs to: the canary key, and the context's own. */
  readonly contaId: string;
  /** The Amazon order id (3-7-7). */
  readonly orderId: string;
  /** The stored watermark a live read must reach, µs (`pisoDoPedidoAmazon`); `null` = none. */
  readonly pisoUs: number | null;
}

export interface EntradaAgendamentoAmazon {
  /** The scheduling valve, read ONCE at the run's start by the caller. */
  readonly valvula: ValvulaAmazon<typeof FLUXO_AMAZON.agendamento>;
  readonly alvo: AlvoAgendamentoAmazon;
  /** The loaded context: its conta id, its read client and its credential getter. */
  readonly contexto: Pick<ContextoAmazon, 'integracaoId' | 'cliente' | 'obterAcesso'>;
  /** The SAME deps the caller handed the context loader. */
  readonly deps: DepsEscritaAmazon;
  /**
   * What the call lines say about the run. `tentativa` is REQUIRED: a queue
   * attempt (a number) refuses a read older than the floor
   * (`AmazonLeituraDefasadaError`); `null` (the route) returns it, flagged, and
   * the plan never writes on it.
   */
  readonly registro: RegistroDeChamadaAmazon & { readonly tentativa: number | null };
  readonly modo: ModoAgendamentoAmazon;
  /** Whether the caller may make a FIRST schedule (the route's `frete.write`; the task: always). */
  readonly podeAgendar: boolean;
  /** The NF-e gate over the caller's one `nfev4` listing. */
  readonly notas: GateNotasAgendamentoAmazon;
}

/** The engine's own result, for this flow. */
type ResultadoMotorAgendamentoAmazon = ResultadoEscritaAmazon<
  LeituraPedidoAmazon,
  PlanoAgendamentoAmazon,
  RespostaAgendamentoEasyShip
>;

/** What one run did (module header). */
export type ResultadoAgendamentoAmazon =
  | Extract<ResultadoMotorAgendamentoAmazon, { readonly tipo: 'desligado' }>
  | (Exclude<ResultadoMotorAgendamentoAmazon, { readonly tipo: 'desligado' }> & {
      /** The live order's decision (the plan's, repeated for the caller). */
      readonly decisao: DecisaoAgendamentoAmazon;
    })
  | {
      readonly tipo: 'falha';
      readonly fase: typeof FASE_FALHA_AGENDAMENTO_AMAZON.leitura;
      readonly erro: unknown;
    }
  | {
      readonly tipo: 'falha';
      readonly fase: typeof FASE_FALHA_AGENDAMENTO_AMAZON.escrita;
      readonly erro: unknown;
      /** The plan the write was made on, and so its decision. */
      readonly plano: PlanoAgendamentoAmazon;
      readonly decisao: DecisaoAgendamentoAmazon;
    };

/** Whether `err` is one of the classes the run answers (module header). */
function ehFalhaDoAgendamentoAmazon(err: unknown): boolean {
  return (
    err instanceof AmazonError ||
    err instanceof PedidoAmazonIlegivelError ||
    err instanceof AmazonLeituraDefasadaError ||
    err instanceof ChamadasAmazonDesligadasError ||
    err instanceof ContaAmazonNaoEncontradaError ||
    err instanceof ContaAmazonInativaError ||
    err instanceof ContaAmazonNaoConectadaError ||
    err instanceof ContaAmazonParadaError ||
    err instanceof CredencialAmazonAusenteError ||
    err instanceof CredencialAmazonInvalidaError
  );
}

/** One scheduling run (module header). */
export async function executarAgendamentoAmazon(
  e: EntradaAgendamentoAmazon,
): Promise<ResultadoAgendamentoAmazon> {
  // The phase flag: the plan `escrever` was handed, or `null` while nothing
  // has been sent. An object, so the closures below write what the catch reads.
  const fase: { escrita: PlanoAgendamentoAmazon | null } = { escrita: null };
  let r: ResultadoMotorAgendamentoAmazon;
  try {
    r = await executarEscritaAmazon({
      valvula: e.valvula,
      contaId: e.alvo.contaId,
      alvo: e.alvo.orderId,
      contexto: e.contexto,
      deps: e.deps,
      registro: e.registro,
      lerAtual: () =>
        lerPedidoAmazon(
          e.contexto,
          { amazonOrderId: e.alvo.orderId, pisoUs: e.alvo.pisoUs },
          { tentativa: e.registro.tentativa },
        ),
      planejar: (leitura) =>
        planoAgendamentoAmazon(
          decidirAgendamentoAmazon(leitura),
          e.modo,
          e.podeAgendar,
          e.notas,
          leitura.tipo === 'lido' && leitura.defasadaAceita,
        ),
      escrever: (cliente, plano, restrito) => {
        fase.escrita = plano;
        return agendarNaAmazon(cliente, restrito, e.alvo.orderId);
      },
    });
  } catch (err) {
    if (!ehFalhaDoAgendamentoAmazon(err)) throw err;
    const plano = fase.escrita;
    if (plano === null) {
      return { tipo: 'falha', fase: FASE_FALHA_AGENDAMENTO_AMAZON.leitura, erro: err };
    }
    return {
      tipo: 'falha',
      fase: FASE_FALHA_AGENDAMENTO_AMAZON.escrita,
      erro: err,
      plano,
      decisao: plano.decisao,
    };
  }
  if (r.tipo === 'desligado') return r;
  return { ...r, decisao: r.plano.decisao };
}
