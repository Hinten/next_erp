/**
 * The Amazon WRITE ENGINE (step-2b plan §3 decision 18; step 14, PR 14-b): the
 * ONE module of this app that builds an SP-API write client, and so the one
 * place a write to Amazon can be sent from. `estrutura.test.ts` refuses the
 * package's write-client constructor named in any other production file.
 *
 * It decides NOTHING about a flow's data: whether a write is due is the
 * flow's `planejar`, what it sends is the flow's `escrever`. It owns HOW a write
 * is gated and made, in this exact order:
 *
 *  1. **The target under the valve.** `decidirAlvo(valvula, contaId, alvo)`,
 *     with the valve the flow read ONCE at its start (`lerValvula`, the run's
 *     first statement, and its run-start line, the second — both the
 *     caller's). `off` returns at once: nothing is read, nothing is planned.
 *     The engine refuses a target of another conta than the context's (a
 *     `TypeError`, a programming error): the canary key and the credential the
 *     write would carry must name the same conta.
 *  2. **The current state.** `lerAtual()` — the flow's read of Amazon's state,
 *     both the dry-run's baseline and the idempotency read (a write already
 *     reflected is never planned).
 *  3. **The plan.** `planejar(atual)`, pure: `escrever` and the `diff` campos
 *     (primitives and closed codes only).
 *  4. **Dry-run** (the valve's `dry-run`, or `on` outside the canary): ONE
 *     diff line (`evento` = the flow's, {@link EVENTO_DA_ESCRITA_AMAZON}), and
 *     NO write.
 *  5. **One write.** Under `on` and a plan that writes: the write client is
 *     built from the SAME deps the caller handed the context loader (its
 *     `fetch`, clock and correlation ids), with the context's credential getter
 *     re-read per request and the call line labelled exactly as the loader
 *     labels its own (the caller's `registro` first, then the logger and the
 *     context's conta, so a `registro` can never relabel the line); then
 *     `escrever` runs ONCE through the forced-refresh-once rule
 *     (`renovacaoUnica.ts`): a 401/403 refreshes once and retries once — it
 *     was not processed — and a second one propagates.
 *
 * ## The restricted client (step 15, PR 15-b)
 *
 * `escrever`'s third argument is a FACTORY ({@link FabricaClienteRestritoAmazon}):
 * handed a Restricted Data Token the flow minted through the write client, it
 * answers a write client that sends THAT token as its access token — the Easy
 * Ship bulk is a restricted operation. The factory reads the context's current
 * credential once (`obterAcesso`: the cached LWA credential, no network unless
 * it went stale) only for its `ref`, the label every call line carries, and
 * builds the client through the SAME local builder as the LWA write client
 * ({@link construirClienteEscrita}): one place names the package's constructor
 * and one place builds the call-line observer, and each client built gets its
 * OWN observer (a stateless closure over the logger, the conta and the run's
 * `registro`). The forced-refresh-once rule wraps the WHOLE `escrever`, so a
 * 401/403 on the mint OR on the restricted call refreshes the LWA token once
 * and runs `escrever` again — which mints a NEW token: a restricted token is
 * never kept across calls of `escrever`, runs or retries. The NF-e flow ignores
 * the factory.
 *
 * The write's outcome is the flow's: any error `escrever` throws propagates
 * untouched. ⚠️ A cut, 5xx or schema-failing write MAY HAVE LANDED, and this
 * engine never repeats one — there is exactly one call to `escrever` per run
 * (two only on the refresh rule's 401/403). The read-back is the flow's too
 * (asynchronous for the NF-e: a verification chain), and there is no restore
 * snapshot here: an invoice has none (steps 12 and 13 add theirs).
 *
 * The NF-e upload uses this engine for a PLANNED SUBMIT only (fase `envio`); a
 * verification read never enters it — it writes nothing, and the valve governs
 * writes (step-14 plan §3 decision 25).
 *
 * ⚠️ D11: nothing here runs while the read switch is off — the flow builds its
 * context first (`loadAmazonContext` refuses before any read), and this engine
 * takes that context. Before the window no flow calls it at all.
 */
import {
  type CredencialSpApi,
  criarClienteEscritaSpApi,
  type SpApiEscritaClient,
} from '@delfrance/integrations-amazon-sp-api';

import { AGENTE_USUARIO_AMAZON } from './agente';
import type { ContextoAmazon, ContextoAmazonDeps } from './contexto';
import {
  type CamposLogAmazon,
  type EventoAvulsoAmazon,
  type RegistroDeChamadaAmazon,
  criarObservadorAmazon,
  registrarEventoAmazon,
} from './log';
import { executarComRenovacaoUnica } from './renovacaoUnica';
import {
  FLUXO_AMAZON,
  type FluxoAmazon,
  MODO_AMAZON,
  type MotivoDryRunAmazon,
  type ValvulaAmazon,
  decidirAlvo,
} from './valvulas';

/**
 * The log event of each write flow's lines. A flow without a row cannot run
 * through the engine (its valve does not type-check), so every write flow has
 * an event before it has a writer.
 */
export const EVENTO_DA_ESCRITA_AMAZON = {
  [FLUXO_AMAZON.nfe]: 'nfe',
  [FLUXO_AMAZON.agendamento]: 'agendamento',
} as const satisfies Partial<Record<FluxoAmazon, EventoAvulsoAmazon>>;

/** The write flows the engine runs today. */
export type FluxoDeEscritaAmazon = keyof typeof EVENTO_DA_ESCRITA_AMAZON;

/** What a flow's `planejar` answers. */
export interface PlanoEscritaAmazon {
  /** Whether this plan sends a write. */
  readonly escrever: boolean;
  /**
   * The dry-run line's own campos — what would be written, as primitives and
   * CLOSED codes only: never a payload, an identifier of a buyer, or Amazon's
   * text.
   */
  readonly diff: CamposLogAmazon;
}

/**
 * What the engine needs of the caller's deps: the SAME object it handed
 * `loadAmazonContext` (the context itself carries only the conta, the read
 * client and the credential getter).
 */
export type DepsEscritaAmazon = Pick<
  ContextoAmazonDeps,
  'logger' | 'fetch' | 'agora' | 'gerarCorrelationId'
>;

/**
 * A restricted client, on demand (module header): the Restricted Data Token in,
 * a write client that sends it as the access token out. Every call builds a NEW
 * client with its own observer; nothing is kept.
 */
export type FabricaClienteRestritoAmazon = (token: string) => Promise<SpApiEscritaClient>;

export interface EntradaEscritaAmazon<A, P extends PlanoEscritaAmazon, R> {
  /** The flow's valve, read ONCE at the run's start by the caller. */
  readonly valvula: ValvulaAmazon<FluxoDeEscritaAmazon>;
  /** The conta the target belongs to — the context's own. */
  readonly contaId: string;
  /** The target, as the canary list names it (an order id for the NF-e). */
  readonly alvo: string;
  /** The loaded context: its conta id and its credential getter. */
  readonly contexto: Pick<ContextoAmazon, 'integracaoId' | 'obterAcesso'>;
  readonly deps: DepsEscritaAmazon;
  /** What the call lines say about the run (flow, attempt, task id). */
  readonly registro?: RegistroDeChamadaAmazon;
  /** The read of the current state (module header, step 2). */
  readonly lerAtual: () => Promise<A>;
  /** The plan, pure (step 3). */
  readonly planejar: (atual: A) => P;
  /**
   * The ONE write (step 5), through the client the engine built; `restrito`
   * builds a restricted client for a token the flow minted (module header).
   */
  readonly escrever: (
    cliente: SpApiEscritaClient,
    plano: P,
    restrito: FabricaClienteRestritoAmazon,
  ) => Promise<R>;
}

/** What one run did. */
export type ResultadoEscritaAmazon<A, P, R> =
  /** The valve is `off`: nothing was read. */
  | { readonly tipo: 'desligado' }
  /** Dry-run (the valve, or `on` outside the canary): read, planned, one diff line, no write. */
  | {
      readonly tipo: 'simulado';
      readonly motivo: MotivoDryRunAmazon;
      readonly atual: A;
      readonly plano: P;
    }
  /** `on`, and the plan writes nothing (already reflected, or not due). */
  | { readonly tipo: 'sem-escrita'; readonly atual: A; readonly plano: P }
  /** `on`, and the one write resolved. */
  | { readonly tipo: 'escrito'; readonly atual: A; readonly plano: P; readonly resposta: R };

/** The dry-run line (step 4): the plan's diff, then the engine's own campos LAST. */
function registrarSimulacao(
  e: Pick<
    EntradaEscritaAmazon<unknown, PlanoEscritaAmazon, unknown>,
    'valvula' | 'contexto' | 'deps' | 'registro'
  >,
  motivo: MotivoDryRunAmazon,
  plano: PlanoEscritaAmazon,
): void {
  const fluxo = e.valvula.fluxo;
  registrarEventoAmazon(
    e.deps.logger,
    EVENTO_DA_ESCRITA_AMAZON[fluxo],
    'INFO',
    `[amazon] ${fluxo}: dry-run (${motivo})`,
    { ...plano.diff, modo: MODO_AMAZON.dryRun, motivoDryRun: motivo, escreveria: plano.escrever },
    { ...e.registro, conta: e.contexto.integracaoId, fluxo },
  );
}

/**
 * The engine's ONE client builder: the only place here that names the package's
 * write-client constructor and builds a call-line observer. Every client gets
 * its OWN observer, labelled the loader's way (the caller's `registro` first,
 * then the logger and the context's conta).
 */
function construirClienteEscrita(
  e: Pick<
    EntradaEscritaAmazon<unknown, PlanoEscritaAmazon, unknown>,
    'contexto' | 'deps' | 'registro'
  >,
  obterCredencial: () => CredencialSpApi | Promise<CredencialSpApi>,
): SpApiEscritaClient {
  return criarClienteEscritaSpApi({
    obterCredencial,
    userAgent: AGENTE_USUARIO_AMAZON,
    fetch: e.deps.fetch,
    onChamada: criarObservadorAmazon({
      ...e.registro,
      logger: e.deps.logger,
      conta: e.contexto.integracaoId,
    }),
    gerarCorrelationId: e.deps.gerarCorrelationId,
    agora: e.deps.agora,
  });
}

/** One write run (module header). */
export async function executarEscritaAmazon<A, P extends PlanoEscritaAmazon, R>(
  e: EntradaEscritaAmazon<A, P, R>,
): Promise<ResultadoEscritaAmazon<A, P, R>> {
  if (e.contaId !== e.contexto.integracaoId) {
    throw new TypeError('escrita.ts: o alvo e o contexto nomeiam contas diferentes');
  }

  // 1. The target under the valve; `off` reads nothing.
  const decisao = decidirAlvo(e.valvula, e.contaId, e.alvo);
  if (decisao.modo === MODO_AMAZON.off) return { tipo: 'desligado' };

  // 2–3. The current state, then the plan.
  const atual = await e.lerAtual();
  const plano = e.planejar(atual);

  // 4. Dry-run: one line, no write.
  if (decisao.modo === MODO_AMAZON.dryRun) {
    registrarSimulacao(e, decisao.motivo, plano);
    return { tipo: 'simulado', motivo: decisao.motivo, atual, plano };
  }
  if (!plano.escrever) return { tipo: 'sem-escrita', atual, plano };

  // 5. One write, through clients built here and nowhere else. The LWA one
  //    re-reads the context's getter on every request, as the context's own read
  //    client does; a restricted one sends the token it was handed, labelled
  //    with the CURRENT LWA credential's ref.
  const cliente = construirClienteEscrita(e, () => e.contexto.obterAcesso());
  const restrito: FabricaClienteRestritoAmazon = async (token) => {
    const { ref } = await e.contexto.obterAcesso();
    return construirClienteEscrita(e, () => ({ accessToken: token, ref }));
  };
  const resposta = await executarComRenovacaoUnica(e.contexto, () =>
    e.escrever(cliente, plano, restrito),
  );
  return { tipo: 'escrito', atual, plano, resposta };
}
