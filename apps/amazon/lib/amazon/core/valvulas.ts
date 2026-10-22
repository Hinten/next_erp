/**
 * The Amazon channel's switches: the READ SWITCH (step-2 plan §3 decision 2)
 * and, beside it, the four WRITE VALVES with their CANARY LISTS (step 2b-c;
 * master plan §4.26, window item W8).
 *
 * ## The read switch
 *
 * `AMAZON_CHAMADAS`: only the EXACT string `on` lets this code call Amazon at
 * all (D11, mock only until the cutover). `ON`, ` on`, `on `, `true`, `1`, a
 * typo, blank and unset are all OFF — nothing is trimmed and nothing is
 * case-folded, so a value that merely looks right never reaches a live seller.
 *
 * It ships with the first code able to reach Amazon, and gates:
 *
 *  - the OAuth start route — a 503 `AMAZON_CHAMADAS_DESLIGADAS`, with no
 *    Firestore read and no fetch;
 *  - the OAuth callback — a redirect with `integracao_desligada`, consuming
 *    nothing and fetching nothing;
 *  - the context loader (`contexto.ts`) — refused before any Firestore read;
 *  - the expiry sweep's app-secret pass (c).
 *
 * It does NOT gate the status route (no Amazon call) nor sweep passes (a)/(b)
 * (the reauthorization clock runs whatever the switch says).
 *
 * ## The write valves: the polarity fails safe
 *
 * One valve per write flow, `AMAZON_MODO_<FLUXO>`, each `off | dry-run | on`.
 * Only the EXACT `on` writes and only the exact `dry-run` diffs; every other
 * value is `off`, by the switch's rule (nothing trimmed, nothing folded). A
 * write also needs the read switch: every Amazon call goes through the context
 * loader, which refuses while `AMAZON_CHAMADAS` is not `on`.
 *
 * ## Canary lists: `*` is the only widening
 *
 * `AMAZON_CANARIO_<FLUXO>` decides which targets an `on` valve really writes
 * to; every other target dry-runs.
 *
 * | value | meaning |
 * | --- | --- |
 * | unset, or empty (`''`) | NO target: under `on`, everything dry-runs (`sem-canario`) |
 * | exactly `*` | every valid target — the ONLY way to widen |
 * | anything else | a list split on `,`, each entry `<contaId>:<alvo>` |
 *
 * Only unset and `''` are empty: nothing is trimmed, so a value of spaces only
 * is a one-entry list whose entry is malformed (no target, and a WARNING).
 *
 * The entry splits at its FIRST `:` (a conta id holds none; a SKU may). The
 * conta is {@link idDeContaValido}; the alvo is a SKU for stock and price —
 * printable ASCII without a space or a comma, 1 to 40, and not exactly `*` —
 * or an Amazon order id (`000-0000000-0000000`) for the NF-e and the
 * scheduling. An empty entry, a `*` inside a list, an entry `<contaId>:*`
 * (there is no per-conta wildcard: it reads as one and is not), or anything
 * outside that grammar is MALFORMED: it is recorded by its 1-based POSITION,
 * never by its text, and simply lists nothing. The decision is an exact
 * `Set.has` on the target's key ({@link chaveDoAlvo}), so a malformed entry can
 * never equal one, and nothing is a prefix match. Removing the variable, a typo
 * in its name, or setting it on only one of the two surfaces therefore NARROWS
 * — it never becomes a fleet-wide write.
 *
 * A SKU the list grammar cannot name (a space, a comma, a non-ASCII letter, or
 * exactly `*`) is still a valid target: it is reached only at `*`, and under a
 * list it dry-runs with its own reason (`alvo-nao-listavel`).
 *
 * ## A batch is a feed only under exactly `*`
 *
 * Stock and price can also go as one `JSON_LISTINGS_FEED`. {@link decidirLote}
 * allows that ONLY when the valve is `on` and the list is exactly `*`; under a
 * list, a batch sends patches for the canary targets alone (§4.26). Either way
 * {@link decidirLote} decides the batch, never its members: every member, of a
 * feed or of patches, still goes through {@link decidirAlvo}, and only the
 * members deciding `on` are sent.
 *
 * ## The environment is a parameter
 *
 * Like everywhere under `lib/amazon`. {@link lerValvula} is pure and is THE first
 * statement of a write flow: it reads its two names ONCE, so every target of one
 * run gets the same decision. {@link registrarValvulaAmazon} writes the
 * run-start line, the second statement. No write flow exists yet: the write
 * engine (step 14, PR a) is the first caller.
 */
import type { AmbienteAmazon } from '../env';
import { idDeContaValido } from './idConta';
import {
  type CamposLogAmazon,
  type EnvelopeEventoAmazon,
  INVALIDO,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from './log';

/* -------------------------------------------------------------------------- */
/*                                The read switch                              */
/* -------------------------------------------------------------------------- */

/** The read switch's variable. */
export const CHAMADAS_ENV_AMAZON = 'AMAZON_CHAMADAS';

/** The one value that switches calls on. Exactly this, nothing trimmed. */
export const CHAMADAS_LIGADAS = 'on';

/** Whether this code may call Amazon at all: only the exact `on`. Pure. */
export function lerChaveDeChamadasAmazon(ambiente: AmbienteAmazon): boolean {
  return ambiente[CHAMADAS_ENV_AMAZON] === CHAMADAS_LIGADAS;
}

/**
 * The switch's value as a log line may carry it — a CLOSED classification,
 * never the raw text (an operator may paste anything into a variable):
 *
 *  - `ausente` — unset or the empty string, the expected state before W5;
 *  - `off` — exactly `off`;
 *  - `outro` — anything else (`ON`, ` on`, `true`, whitespace, `on` itself).
 */
export type ClasseDoValorDeChamadas = 'ausente' | 'off' | 'outro';

export function classificarValorDeChamadas(valor: string | undefined): ClasseDoValorDeChamadas {
  if (valor === undefined || valor === '') return 'ausente';
  if (valor === 'off') return 'off';
  return 'outro';
}

/**
 * The ONE line a refused call writes (`evento: 'chamada-bloqueada'`): INFO while
 * the switch is simply off (`ausente` / `off`), WARNING when it holds anything
 * else — a misconfiguration to fix (`ON`, a stray space). The value itself is
 * never logged, only its {@link ClasseDoValorDeChamadas}.
 */
export function registrarChamadaBloqueadaAmazon(
  logger: LoggerAmazon,
  entrada: { readonly rota: string; readonly valor: string | undefined },
): void {
  const classe = classificarValorDeChamadas(entrada.valor);
  registrarEventoAmazon(
    logger,
    'chamada-bloqueada',
    classe === 'outro' ? 'WARNING' : 'INFO',
    '[amazon] chamada-bloqueada: AMAZON_CHAMADAS não é exatamente "on"',
    { rota: entrada.rota, chave: CHAMADAS_ENV_AMAZON, valor: classe },
  );
}

/* -------------------------------------------------------------------------- */
/*                         The write valves and canaries                       */
/* -------------------------------------------------------------------------- */

/** Every write flow, by the value `jsonPayload.fluxo` filters on (§4.26). */
export const FLUXO_AMAZON = {
  /** `patchListingsItem` fulfillment availability, and its feed (steps 12, 12a). */
  estoque: 'estoque',
  /** `patchListingsItem` purchasable offer, and its feed (steps 13, 12a). */
  preco: 'preco',
  /** `submitInvoice`, the NF-e upload (step 14). */
  nfe: 'nfe',
  /** `createScheduledPackageBulk`: the scheduling and every label fetch (step 15). */
  agendamento: 'agendamento',
} as const;
export type FluxoAmazon = (typeof FLUXO_AMAZON)[keyof typeof FLUXO_AMAZON];

/** One valve per flow. Keyed by the flow value, so a new flow fails to compile here. */
export const VALVULA_ENV_AMAZON = {
  [FLUXO_AMAZON.estoque]: 'AMAZON_MODO_ESTOQUE',
  [FLUXO_AMAZON.preco]: 'AMAZON_MODO_PRECO',
  [FLUXO_AMAZON.nfe]: 'AMAZON_MODO_NFE',
  [FLUXO_AMAZON.agendamento]: 'AMAZON_MODO_AGENDAMENTO',
} as const satisfies Record<FluxoAmazon, string>;

/** One canary list per flow. Keyed by the flow value, like the valves. */
export const CANARIO_ENV_AMAZON = {
  [FLUXO_AMAZON.estoque]: 'AMAZON_CANARIO_ESTOQUE',
  [FLUXO_AMAZON.preco]: 'AMAZON_CANARIO_PRECO',
  [FLUXO_AMAZON.nfe]: 'AMAZON_CANARIO_NFE',
  [FLUXO_AMAZON.agendamento]: 'AMAZON_CANARIO_AGENDAMENTO',
} as const satisfies Record<FluxoAmazon, string>;

/** Where each flow's two variables live. */
const NOMES_DO_FLUXO: Readonly<
  Record<FluxoAmazon, { readonly modo: string; readonly canario: string }>
> = {
  [FLUXO_AMAZON.estoque]: {
    modo: VALVULA_ENV_AMAZON.estoque,
    canario: CANARIO_ENV_AMAZON.estoque,
  },
  [FLUXO_AMAZON.preco]: { modo: VALVULA_ENV_AMAZON.preco, canario: CANARIO_ENV_AMAZON.preco },
  [FLUXO_AMAZON.nfe]: { modo: VALVULA_ENV_AMAZON.nfe, canario: CANARIO_ENV_AMAZON.nfe },
  [FLUXO_AMAZON.agendamento]: {
    modo: VALVULA_ENV_AMAZON.agendamento,
    canario: CANARIO_ENV_AMAZON.agendamento,
  },
};

/** What a flow writes to: a listing (by SKU) or an order (by Amazon order id). */
export type TipoDeAlvoAmazon = 'sku' | 'pedido';

export const TIPO_DE_ALVO = {
  [FLUXO_AMAZON.estoque]: 'sku',
  [FLUXO_AMAZON.preco]: 'sku',
  [FLUXO_AMAZON.nfe]: 'pedido',
  [FLUXO_AMAZON.agendamento]: 'pedido',
} as const satisfies Record<FluxoAmazon, TipoDeAlvoAmazon>;

/** The flows a batch (`JSON_LISTINGS_FEED`) can carry. */
export const FLUXOS_COM_LOTE = [FLUXO_AMAZON.estoque, FLUXO_AMAZON.preco] as const;
export type FluxoComLoteAmazon = (typeof FLUXOS_COM_LOTE)[number];

export type ModoAmazon = 'off' | 'dry-run' | 'on';

export const MODO_AMAZON = {
  off: 'off',
  dryRun: 'dry-run',
  on: 'on',
} as const satisfies Record<string, ModoAmazon>;

/** The canary value that widens to every target. Exactly this, nothing trimmed. */
export const CANARIO_TODOS = '*';

/** A SKU Amazon can carry: 1 to 40 code points, no control character, no lone surrogate. */
const SKU_VALIDO = /^[^\p{Cc}\p{Cs}]{1,40}$/u;
/** A SKU a canary list can NAME: printable ASCII without a space or a comma (the separator). */
const SKU_LISTAVEL = /^[\x21-\x2B\x2D-\x7E]{1,40}$/;
/** An Amazon order id: 3-7-7 digits. */
const PEDIDO_AMAZON = /^[0-9]{3}-[0-9]{7}-[0-9]{7}$/;

/**
 * A canary list as read:
 *  - `nenhum`: unset or `''` — no target (a value of spaces only is a `lista`
 *    with one malformed entry: nothing is trimmed);
 *  - `todos`: exactly `*`;
 *  - `lista`: the keys of the well-formed entries, how many entries there were
 *    (duplicates and malformed ones included), and the 1-based POSITIONS of the
 *    malformed ones — never their text: an operator may paste anything here.
 */
export type CanarioAmazon =
  | { readonly tipo: 'nenhum' }
  | { readonly tipo: 'todos' }
  | {
      readonly tipo: 'lista';
      readonly chaves: ReadonlySet<string>;
      readonly entradas: number;
      readonly malformadas: readonly number[];
    };

/** One flow's valve, read ONCE at the start of a run. */
export interface ValvulaAmazon<F extends FluxoAmazon = FluxoAmazon> {
  readonly fluxo: F;
  readonly modo: ModoAmazon;
  /**
   * `false` when the variable holds something other than `off`, `dry-run` or
   * `on` (a typo, `ON`, ` on`, `true`). Unset and `''` are expected — the
   * template ships the line blank — so they count as recognised.
   */
  readonly modoReconhecido: boolean;
  readonly canario: CanarioAmazon;
}

export type MotivoDryRunAmazon =
  | 'valvula'
  | 'sem-canario'
  | 'fora-do-canario'
  | 'alvo-invalido'
  | 'alvo-nao-listavel';
export type MotivoOnAmazon = 'todos' | 'no-canario';

/** What one target gets under a valve. */
export type DecisaoAlvoAmazon =
  | { readonly modo: 'off' }
  | { readonly modo: 'dry-run'; readonly motivo: MotivoDryRunAmazon }
  | { readonly modo: 'on'; readonly motivo: MotivoOnAmazon };

/**
 * What one batch gets (§4.26): a whole feed only under `on` and exactly `*`;
 * under `on` and a list, patches for the canary targets only.
 *
 * It decides the batch's FORM, never its members: every member of a batch, of a
 * feed or of patches alike, still goes through {@link decidirAlvo}, and only
 * the members deciding `on` are sent. Under `*`, a member deciding
 * `alvo-invalido` (a bad conta id, a SKU with a control character) is left out
 * of the feed and dry-runs.
 */
export type DecisaoLoteAmazon =
  | { readonly modo: 'off' }
  | { readonly modo: 'dry-run'; readonly motivo: 'valvula' | 'sem-canario' }
  | { readonly modo: 'feed' }
  | { readonly modo: 'so-patches-do-canario' };

/** The target type of a flow, or `null` for a value outside {@link FLUXO_AMAZON} (a cast). */
function tipoDoFluxo(fluxo: unknown): TipoDeAlvoAmazon | null {
  return typeof fluxo === 'string' && Object.hasOwn(TIPO_DE_ALVO, fluxo)
    ? TIPO_DE_ALVO[fluxo as FluxoAmazon]
    : null;
}

/**
 * Whether a canary list can name `alvo`: the list grammar, which never holds
 * `,` or a space. A SKU of exactly `*` is not listable either: the entry
 * `<contaId>:*` reads as a per-conta wildcard, which does not exist, so it is
 * malformed (a WARNING) rather than quietly naming one literal SKU.
 */
function alvoListavel(tipo: TipoDeAlvoAmazon, alvo: string): boolean {
  if (tipo === 'pedido') return PEDIDO_AMAZON.test(alvo);
  return alvo !== CANARIO_TODOS && SKU_LISTAVEL.test(alvo);
}

/**
 * The mode as read: only the exact `on` and `dry-run` count, everything else
 * is `off`. `reconhecido` is false unless the value is unset, `''` or `off`.
 */
export function lerModo(valor: string | undefined): {
  readonly modo: ModoAmazon;
  readonly reconhecido: boolean;
} {
  if (valor === MODO_AMAZON.on) return { modo: MODO_AMAZON.on, reconhecido: true };
  if (valor === MODO_AMAZON.dryRun) return { modo: MODO_AMAZON.dryRun, reconhecido: true };
  return {
    modo: MODO_AMAZON.off,
    reconhecido: valor === undefined || valor === '' || valor === MODO_AMAZON.off,
  };
}

/**
 * A canary list as read for a target type. Nothing is trimmed and nothing is
 * case-folded; each entry splits at its FIRST `:`.
 */
export function lerCanario(valor: string | undefined, tipo: TipoDeAlvoAmazon): CanarioAmazon {
  if (typeof valor !== 'string' || valor === '') return { tipo: 'nenhum' };
  if (valor === CANARIO_TODOS) return { tipo: 'todos' };
  const entradas = valor.split(',');
  const chaves = new Set<string>();
  const malformadas: number[] = [];
  entradas.forEach((entrada, i) => {
    const doisPontos = entrada.indexOf(':');
    const conta = doisPontos === -1 ? '' : entrada.slice(0, doisPontos);
    const alvo = doisPontos === -1 ? '' : entrada.slice(doisPontos + 1);
    if (idDeContaValido(conta) && alvoListavel(tipo, alvo)) chaves.add(`${conta}:${alvo}`);
    else malformadas.push(i + 1);
  });
  return { tipo: 'lista', chaves, entradas: entradas.length, malformadas };
}

/**
 * One flow's valve and canary list, read ONCE from `ambiente` — each of its two
 * names exactly once, no other name at all. Pure. THE first statement of a
 * write flow: nothing is read from Amazon and no payload is built before it.
 */
export function lerValvula<F extends FluxoAmazon>(
  fluxo: F,
  ambiente: AmbienteAmazon,
): ValvulaAmazon<F> {
  const tipo = tipoDoFluxo(fluxo);
  // Only a cast reaches this: the flow is a compile-time constant at every call site.
  if (tipo === null) throw new TypeError('valvulas.ts: fluxo fora de FLUXO_AMAZON');
  const nomes = NOMES_DO_FLUXO[fluxo];
  const { modo, reconhecido } = lerModo(ambiente[nomes.modo]);
  return {
    fluxo,
    modo,
    modoReconhecido: reconhecido,
    canario: lerCanario(ambiente[nomes.canario], tipo),
  };
}

/**
 * Whether `alvo` is a target the flow can write at all: for a SKU, 1 to 40
 * code points with no control character (a space, a comma or a non-ASCII
 * letter is valid — only not listable); for an order, the 3-7-7 grammar.
 *
 * A plain `boolean`, not a type predicate: a predicate would narrow a `string`
 * caller's false branch to `never`, and a valid string can still be the wrong
 * shape for this flow.
 */
export function alvoValido(fluxo: FluxoAmazon, alvo: unknown): boolean {
  const tipo = tipoDoFluxo(fluxo);
  if (tipo === null || typeof alvo !== 'string') return false;
  return tipo === 'sku' ? SKU_VALIDO.test(alvo) : PEDIDO_AMAZON.test(alvo);
}

/**
 * The key a canary list names a target by, `<contaId>:<alvo>` — or `null` when
 * the conta or the target is invalid, or the target is valid but no list could
 * name it (it is reached only at `*`).
 */
export function chaveDoAlvo(fluxo: FluxoAmazon, contaId: unknown, alvo: unknown): string | null {
  const tipo = tipoDoFluxo(fluxo);
  if (tipo === null || typeof alvo !== 'string') return null;
  if (!idDeContaValido(contaId) || !alvoValido(fluxo, alvo)) return null;
  return alvoListavel(tipo, alvo) ? `${contaId}:${alvo}` : null;
}

/**
 * What one target gets. Pure. The canary list is consulted only under `on`;
 * under `on`, an invalid conta or target dry-runs (`alvo-invalido`) even with
 * `*`, so a value outside the grammar is never written by accident.
 */
export function decidirAlvo(v: ValvulaAmazon, contaId: unknown, alvo: unknown): DecisaoAlvoAmazon {
  if (v.modo === MODO_AMAZON.dryRun) return { modo: MODO_AMAZON.dryRun, motivo: 'valvula' };
  if (v.modo !== MODO_AMAZON.on) return { modo: MODO_AMAZON.off };
  if (!idDeContaValido(contaId) || !alvoValido(v.fluxo, alvo)) {
    return { modo: MODO_AMAZON.dryRun, motivo: 'alvo-invalido' };
  }
  const canario = v.canario;
  if (canario.tipo === 'todos') return { modo: MODO_AMAZON.on, motivo: 'todos' };
  if (canario.tipo !== 'lista') return { modo: MODO_AMAZON.dryRun, motivo: 'sem-canario' };
  const chave = chaveDoAlvo(v.fluxo, contaId, alvo);
  if (chave === null) return { modo: MODO_AMAZON.dryRun, motivo: 'alvo-nao-listavel' };
  return canario.chaves.has(chave)
    ? { modo: MODO_AMAZON.on, motivo: 'no-canario' }
    : { modo: MODO_AMAZON.dryRun, motivo: 'fora-do-canario' };
}

/**
 * What one batch of stock or price gets (§4.26): a feed ONLY under `on` and
 * exactly `*`. Under `dry-run` the step-12/13 dry-run builds the feed document
 * and diffs it, sending nothing.
 *
 * Per batch, then {@link decidirAlvo} per member: a `feed` carries only the
 * members deciding `on`, and `so-patches-do-canario` patches only those.
 */
export function decidirLote(v: ValvulaAmazon<FluxoComLoteAmazon>): DecisaoLoteAmazon {
  if (v.modo === MODO_AMAZON.dryRun) return { modo: MODO_AMAZON.dryRun, motivo: 'valvula' };
  if (v.modo !== MODO_AMAZON.on) return { modo: MODO_AMAZON.off };
  if (v.canario.tipo === 'todos') return { modo: 'feed' };
  if (v.canario.tipo === 'lista') return { modo: 'so-patches-do-canario' };
  return { modo: MODO_AMAZON.dryRun, motivo: 'sem-canario' };
}

/** Every mode and every canary kind, at run time. */
const MODOS: readonly ModoAmazon[] = Object.values(MODO_AMAZON);
const TIPOS_DE_CANARIO: readonly CanarioAmazon['tipo'][] = ['nenhum', 'todos', 'lista'];

/** `valor` when it is one of `fechados`, else {@link INVALIDO}: a line never carries a raw value. */
function fechado<T extends string>(fechados: readonly T[], valor: unknown): T | typeof INVALIDO {
  return fechados.find((f) => f === valor) ?? INVALIDO;
}

/**
 * The run-start line's own campos. Primitives only; the canary list as counts,
 * and its malformed entries by POSITION only (joined with `,`), never by text.
 * `modo` and `canario` go through their closed sets, so a hand-built valve (a
 * cast) logs `<invalido>` there and never its raw text.
 */
export function camposDaValvula(v: ValvulaAmazon): CamposLogAmazon {
  const modo = fechado(MODOS, v.modo);
  const lista = v.canario.tipo === 'lista' ? v.canario : null;
  return {
    modo,
    modoReconhecido: modo !== INVALIDO && v.modoReconhecido === true,
    canario: fechado(TIPOS_DE_CANARIO, v.canario.tipo),
    entradas: lista === null ? null : lista.entradas,
    chavesValidas: lista === null ? null : lista.chaves.size,
    malformadas:
      lista === null || lista.malformadas.length === 0 ? null : lista.malformadas.join(','),
  };
}

/**
 * WARNING when the mode is not recognised (or, on a hand-built valve, outside
 * the union), the canary kind is outside its set, or a canary entry is
 * malformed; INFO otherwise.
 */
export function severidadeDaValvula(v: ValvulaAmazon): SeveridadeAmazon {
  const modoValido = fechado(MODOS, v.modo) !== INVALIDO;
  const canarioValido = fechado(TIPOS_DE_CANARIO, v.canario.tipo) !== INVALIDO;
  const malformadas = v.canario.tipo === 'lista' ? v.canario.malformadas.length : 0;
  return !modoValido || v.modoReconhecido !== true || !canarioValido || malformadas > 0
    ? 'WARNING'
    : 'INFO';
}

/**
 * The run-start line (`evento: 'valvula'`): the SECOND statement of a write
 * flow. `fluxo` always comes from the valve, written over anything `o` holds,
 * so the line cannot be relabelled; the message and the envelope name only the
 * closed flow and mode — `<invalido>` for a hand-built valve outside them —
 * never a raw value.
 */
export function registrarValvulaAmazon(
  logger: LoggerAmazon,
  v: ValvulaAmazon,
  o: Omit<EnvelopeEventoAmazon, 'fluxo'> = {},
): void {
  const fluxo = tipoDoFluxo(v.fluxo) === null ? INVALIDO : v.fluxo;
  const modo = fechado(MODOS, v.modo);
  registrarEventoAmazon(
    logger,
    'valvula',
    severidadeDaValvula(v),
    `[amazon] valvula ${fluxo}: ${modo}`,
    camposDaValvula(v),
    { ...o, fluxo },
  );
}
