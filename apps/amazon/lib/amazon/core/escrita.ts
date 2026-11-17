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
 * ## The batch entry (step 12a)
 *
 * {@link executarLoteEscritaAmazon} is the engine's SECOND entry: one
 * `JSON_LISTINGS_FEED` for a whole batch of stock or price, where the first
 * entry writes one target. Its ONE caller is the feed send
 * (`feeds/enviarFeed.ts`, PR 12-c): `estrutura.test.ts` keeps its caller
 * roster apart from the first entry's, and pins it to that caller. It decides
 * nothing about the batch's data either — which SKUs belong to it is the
 * caller's `membros`, what the document holds is the caller's `montar`, the
 * submission is the caller's `escrever` — and gates it in this exact order:
 *
 *  1. The conta: a batch of another conta than the context's is a `TypeError`,
 *     as above.
 *  2. The batch under the valve, `decidirLote`: `off` returns at once, nothing
 *     built.
 *  3. Every member under the valve, `decidirAlvo`: the members deciding `on`
 *     are the batch's `on` members; every other member is counted by its
 *     dry-run motivo (under `feed` an invalid SKU never reaches `montar`; the
 *     dry-run, step 5, hands `montar` every member as given).
 *  4. `so-patches-do-canario` (`on` under a canary LIST): nothing is built and
 *     nothing written; the answer names exactly the `on` members, which the
 *     CALLER hands to the per-SKU path.
 *  5. `dry-run`: `montar` with EVERY member (the dry-run shows the whole
 *     document) and ONE line (`evento` = the fluxo's,
 *     {@link EVENTO_DO_LOTE_AMAZON}; `fase: 'feed'`; the message and byte
 *     counts), a zero-message document included. Nothing is posted.
 *  6. `feed` (`on` under exactly `*`): `montar` with the `on` members only; a
 *     document with no message writes nothing; otherwise `escrever` runs ONCE,
 *     through the same client and the same forced-refresh-once rule as the
 *     first entry (one private helper serves both, so the engine still names
 *     the write-client builder at exactly three places and keeps its one
 *     observer site). A 401/403 re-runs the WHOLE `escrever` once — a new
 *     document, a new submission — because an auth refusal was not processed.
 *  7. A `montar` that refuses to build (`abortado`, in step 5 or 6) ends the
 *     run there: nothing built further, nothing posted, no line; the refusal
 *     comes back whole, for the caller to answer.
 *
 * Its valve is typed by the fluxos a batch can carry, not by the first entry's
 * event map: a price batch type-checks here before price has a single-target
 * writer.
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
  type FluxoComLoteAmazon,
  MODO_AMAZON,
  type MotivoDryRunAmazon,
  type ValvulaAmazon,
  decidirAlvo,
  decidirLote,
} from './valvulas';

/**
 * The log event of each write flow's lines. A flow without a row cannot run
 * through the engine (its valve does not type-check), so every write flow has
 * an event before it has a writer.
 */
export const EVENTO_DA_ESCRITA_AMAZON = {
  [FLUXO_AMAZON.nfe]: 'nfe',
  [FLUXO_AMAZON.agendamento]: 'agendamento',
  [FLUXO_AMAZON.estoque]: 'estoque',
} as const satisfies Partial<Record<FluxoAmazon, EventoAvulsoAmazon>>;

/** The write flows the engine runs today. */
export type FluxoDeEscritaAmazon = keyof typeof EVENTO_DA_ESCRITA_AMAZON;

/**
 * The log event of each batch fluxo's lines (module header, "The batch
 * entry"): its OWN map, total over the fluxos a batch can carry, so the batch
 * entry's valve is typed by them and never by {@link EVENTO_DA_ESCRITA_AMAZON}.
 */
export const EVENTO_DO_LOTE_AMAZON = {
  [FLUXO_AMAZON.estoque]: 'estoque',
  [FLUXO_AMAZON.preco]: 'preco',
} as const satisfies Record<FluxoComLoteAmazon, EventoAvulsoAmazon>;

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

/** What a write client is built from: the same three fields in both entries. */
interface OrigemDoClienteAmazon {
  readonly contexto: Pick<ContextoAmazon, 'integracaoId' | 'obterAcesso'>;
  readonly deps: DepsEscritaAmazon;
  readonly registro?: RegistroDeChamadaAmazon;
}

/**
 * The engine's ONE client builder: the only place here that names the package's
 * write-client constructor and builds a call-line observer. Every client gets
 * its OWN observer, labelled the loader's way (the caller's `registro` first,
 * then the logger and the context's conta).
 */
function construirClienteEscrita(
  e: OrigemDoClienteAmazon,
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

/**
 * The ONE write of a run, for BOTH entries (module header, step 5 and the batch
 * entry's step 6): the clients are built here and nowhere else, then
 * `escrever` runs ONCE through the forced-refresh-once rule. The LWA client
 * re-reads the context's getter on every request, as the context's own read
 * client does; a restricted one sends the token it was handed, labelled with
 * the CURRENT LWA credential's ref. Nothing is built before a run reaches its
 * write.
 */
async function escreverUmaVez<R>(
  e: OrigemDoClienteAmazon,
  escrever: (cliente: SpApiEscritaClient, restrito: FabricaClienteRestritoAmazon) => Promise<R>,
): Promise<R> {
  const cliente = construirClienteEscrita(e, () => e.contexto.obterAcesso());
  const restrito: FabricaClienteRestritoAmazon = async (token) => {
    const { ref } = await e.contexto.obterAcesso();
    return construirClienteEscrita(e, () => ({ accessToken: token, ref }));
  };
  return executarComRenovacaoUnica(e.contexto, () => escrever(cliente, restrito));
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

  // 5. One write, through the shared helper.
  const resposta = await escreverUmaVez(e, (cliente, restrito) =>
    e.escrever(cliente, plano, restrito),
  );
  return { tipo: 'escrito', atual, plano, resposta };
}

/* ------------------------------------------------------------------------------ */
/*                       The batch entry (step 12a, PR 12-b)                      */
/* ------------------------------------------------------------------------------ */

/** What a batch's `montar` answers when it built (module header, "The batch entry"). */
export interface PlanoLoteAmazon {
  /** The feed document's bytes; empty when it holds no message. */
  readonly bytes: Uint8Array;
  /** How many messages the document holds; 0 writes nothing. */
  readonly mensagens: number;
  /**
   * The dry-run line's own campos — what the document would change, as
   * primitives and CLOSED codes only: never a SKU list, a quantity per SKU or
   * Amazon's text.
   */
  readonly diff: CamposLogAmazon;
  /** Never set on a plan: `abortado` is what tells a refusal from a plan. */
  readonly abortado?: never;
}

/** What a batch's `montar` answers when it refuses to build: nothing is posted. */
export interface AbortoLoteEscritaAmazon {
  /** The closed refusal motivo (the provider's). */
  readonly abortado: string;
}

/** Why a member of a batch is not one of its `on` members: its own valve decision. */
export type MotivoForaDoLoteAmazon = MotivoDryRunAmazon | typeof MODO_AMAZON.off;

/** How the members of a batch decided, one by one (step 3). */
export interface ContagemMembrosLoteAmazon {
  /** Every member the caller handed in. */
  readonly total: number;
  /** The members deciding `on`. */
  readonly on: number;
  /** Every other member, by the motivo it decided. */
  readonly fora: Readonly<Partial<Record<MotivoForaDoLoteAmazon, number>>>;
}

export interface EntradaLoteEscritaAmazon<
  P extends PlanoLoteAmazon,
  X extends AbortoLoteEscritaAmazon,
  R,
> extends OrigemDoClienteAmazon {
  /**
   * The batch fluxo's valve, read ONCE at the run's start by the caller — typed
   * by the fluxos a batch can carry ({@link EVENTO_DO_LOTE_AMAZON}).
   */
  readonly valvula: ValvulaAmazon<FluxoComLoteAmazon>;
  /** The conta the batch belongs to — the context's own. */
  readonly contaId: string;
  /** The batch's SKUs, deduplicated by the caller. */
  readonly membros: readonly string[];
  /** The document for exactly the SKUs handed in, or a refusal to build. */
  readonly montar: (membrosOn: readonly string[]) => Promise<P | X>;
  /** The ONE submission, through the LWA write client the engine built. */
  readonly escrever: (cliente: SpApiEscritaClient, plano: P) => Promise<R>;
}

/** What one batch run did. Every arm past `desligado` carries how the members decided. */
export type ResultadoLoteEscritaAmazon<P, X extends AbortoLoteEscritaAmazon, R> =
  /** The valve is `off`: nothing was built. */
  | { readonly tipo: 'desligado' }
  /** `on` under a canary LIST: nothing built or written; `membros` go per SKU. */
  | {
      readonly tipo: 'so-patches';
      readonly membros: readonly string[];
      readonly contagem: ContagemMembrosLoteAmazon;
    }
  /** Dry-run: the whole document built, one line, nothing posted. */
  | {
      readonly tipo: 'simulado';
      readonly motivo: 'valvula' | 'sem-canario';
      readonly plano: P;
      readonly contagem: ContagemMembrosLoteAmazon;
    }
  /** `feed`, and the document holds no message: nothing posted. */
  | {
      readonly tipo: 'sem-escrita';
      readonly plano: P;
      readonly contagem: ContagemMembrosLoteAmazon;
    }
  /** `feed`, and the one submission resolved. */
  | {
      readonly tipo: 'escrito';
      readonly plano: P;
      readonly resposta: R;
      readonly contagem: ContagemMembrosLoteAmazon;
    }
  /** `montar` refused to build: nothing built further, nothing posted. */
  | {
      readonly tipo: 'abortado';
      readonly motivo: X['abortado'];
      /** The refusal, whole: what the caller raises comes with it. */
      readonly aborto: X;
      readonly contagem: ContagemMembrosLoteAmazon;
    };

/** Whether `montar` refused to build (step 7). */
function ehAbortoDoLote<P extends PlanoLoteAmazon, X extends AbortoLoteEscritaAmazon>(
  r: P | X,
): r is X {
  return Object.hasOwn(r, 'abortado');
}

/** Every member under the valve (step 3): the `on` ones, in order, and the counts. */
function decidirMembros(
  valvula: ValvulaAmazon<FluxoComLoteAmazon>,
  contaId: string,
  membros: readonly string[],
): { readonly membrosOn: readonly string[]; readonly contagem: ContagemMembrosLoteAmazon } {
  const membrosOn: string[] = [];
  const fora: Partial<Record<MotivoForaDoLoteAmazon, number>> = {};
  for (const sku of membros) {
    const decisao = decidirAlvo(valvula, contaId, sku);
    if (decisao.modo === MODO_AMAZON.on) {
      membrosOn.push(sku);
      continue;
    }
    const motivo = decisao.modo === MODO_AMAZON.off ? MODO_AMAZON.off : decisao.motivo;
    fora[motivo] = (fora[motivo] ?? 0) + 1;
  }
  return { membrosOn, contagem: { total: membros.length, on: membrosOn.length, fora } };
}

/** The counts as one campo: `<motivo>:<n>` joined with `,`, sorted; `null` when none. */
function camposDaContagem(c: ContagemMembrosLoteAmazon): CamposLogAmazon {
  const fora = Object.entries(c.fora)
    .map(([motivo, n]) => `${motivo}:${String(n)}`)
    .sort();
  return {
    membros: c.total,
    membrosOn: c.on,
    foraDoLote: fora.length === 0 ? null : fora.join(','),
  };
}

/**
 * The batch's dry-run line (step 5): the plan's diff, then the engine's own
 * campos LAST — the counts of the document and of the members.
 */
function registrarSimulacaoDoLote(
  e: Pick<
    EntradaLoteEscritaAmazon<PlanoLoteAmazon, AbortoLoteEscritaAmazon, unknown>,
    'valvula' | 'contexto' | 'deps' | 'registro'
  >,
  motivo: 'valvula' | 'sem-canario',
  plano: PlanoLoteAmazon,
  contagem: ContagemMembrosLoteAmazon,
): void {
  const fluxo = e.valvula.fluxo;
  registrarEventoAmazon(
    e.deps.logger,
    EVENTO_DO_LOTE_AMAZON[fluxo],
    'INFO',
    `[amazon] ${fluxo}: feed dry-run (${motivo})`,
    {
      ...plano.diff,
      fase: 'feed',
      modo: MODO_AMAZON.dryRun,
      motivoDryRun: motivo,
      mensagens: plano.mensagens,
      bytes: plano.bytes.byteLength,
      ...camposDaContagem(contagem),
    },
    { ...e.registro, conta: e.contexto.integracaoId, fluxo },
  );
}

/** One batch run (module header, "The batch entry"). */
export async function executarLoteEscritaAmazon<
  P extends PlanoLoteAmazon,
  X extends AbortoLoteEscritaAmazon,
  R,
>(e: EntradaLoteEscritaAmazon<P, X, R>): Promise<ResultadoLoteEscritaAmazon<P, X, R>> {
  // 1. The conta.
  if (e.contaId !== e.contexto.integracaoId) {
    throw new TypeError('escrita.ts: o lote e o contexto nomeiam contas diferentes');
  }

  // 2. The batch under the valve; `off` builds nothing.
  const lote = decidirLote(e.valvula);
  if (lote.modo === MODO_AMAZON.off) return { tipo: 'desligado' };

  // 3. Every member under the valve.
  const { membrosOn, contagem } = decidirMembros(e.valvula, e.contaId, e.membros);

  // 4. A canary list: the `on` members go per SKU, through the caller.
  if (lote.modo === 'so-patches-do-canario') {
    return { tipo: 'so-patches', membros: membrosOn, contagem };
  }

  // 5. Dry-run: the WHOLE document, one line, no write.
  if (lote.modo === MODO_AMAZON.dryRun) {
    const simulado = await e.montar(e.membros);
    if (ehAbortoDoLote<P, X>(simulado)) {
      return { tipo: 'abortado', motivo: simulado.abortado, aborto: simulado, contagem };
    }
    registrarSimulacaoDoLote(e, lote.motivo, simulado, contagem);
    return { tipo: 'simulado', motivo: lote.motivo, plano: simulado, contagem };
  }

  // 6. A feed: the `on` members only; one submission, through the shared helper.
  const plano = await e.montar(membrosOn);
  if (ehAbortoDoLote<P, X>(plano)) {
    return { tipo: 'abortado', motivo: plano.abortado, aborto: plano, contagem };
  }
  if (plano.mensagens === 0) return { tipo: 'sem-escrita', plano, contagem };
  const resposta = await escreverUmaVez(e, (cliente) => e.escrever(cliente, plano));
  return { tipo: 'escrito', plano, resposta, contagem };
}
