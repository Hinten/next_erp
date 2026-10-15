/**
 * The write valves, the canary lists and the read switch of the Loja Integrada
 * (LI) channel (master plan step 2b, D4 and D17).
 *
 * ## The polarity fails safe
 *
 * One valve per write flow, `LOJA_INTEGRADA_MODO_<FLUXO>`, each `off | dry-run |
 * on`. Only the EXACT string `on` writes and only the exact `dry-run` diffs:
 * `ON`, ` on`, `on `, `true`, `1`, a typo, blank and unset are all `off`.
 * Nothing is trimmed and nothing is case-folded, so a value that merely looks
 * right never writes to a live store.
 *
 * ## Canary lists: `*` is the only widening
 *
 * `LOJA_INTEGRADA_CANARIO_<FLUXO>` decides which targets an `on` valve really
 * writes to; every other target dry-runs. Four lists — the webhook
 * registration has none, because a person picks its conta per call.
 *
 * | value | meaning |
 * | --- | --- |
 * | unset, or blank | no target: under `on`, everything dry-runs (`sem-canario`) |
 * | exactly `*` | every target — the ONLY way to widen |
 * | anything else | a list split on `,`; each entry must be exactly `<conta>:<n>` |
 *
 * `<conta>` is `[A-Za-z0-9_-]{1,128}` and `<n>` is a positive integer with no
 * leading zero (`[1-9][0-9]*`, a safe integer). Whitespace, a second `:`, a
 * leading zero or a `*` inside a list make that entry malformed, and a
 * malformed entry is simply not listed: the decision is a set lookup on the
 * target's canonical key ({@link chaveDoAlvo}), which a malformed entry can
 * never equal. Removing the variable, a typo in its name, or setting it on only
 * one of the two env surfaces therefore narrows — it never becomes a
 * fleet-wide write.
 *
 * ## The read switch
 *
 * `LOJA_INTEGRADA_CHAMADAS`: only the exact `on` lets this code call LI at all
 * (D17, mock only until the cutover). The two credential routes check it
 * before their validating GET; step 3's context loader checks it too. It stays
 * unset everywhere until the window sets it on both surfaces.
 *
 * ## The environment is a parameter
 *
 * Nothing under `lib/lojaIntegrada` reads the process environment
 * (`estrutura.test.ts`): the entry point — a route, or a step-3 function — passes
 * it in. {@link lerValvula} is pure and is THE first statement of a write flow;
 * it reads the environment once, so every target of one run gets the same
 * decision. {@link registrarValvulaLi} writes the run-start line.
 *
 * ⚠️ No caller of the write valves exists yet: the first is step 7.
 */
import {
  type CampoLogLi,
  type OpcoesRegistroLi,
  type SeveridadeLi,
  registrarEventoLi,
} from './log';

/** The process environment, as the entry point passes it in. */
export type AmbienteLi = Readonly<Record<string, string | undefined>>;

/** Every write flow, by the value `jsonPayload.fluxo` filters on. */
export const FLUXO_LI = {
  estoque: 'estoque',
  preco: 'preco',
  /** Publish, edit, pause, alias and images of a produto (step 11). */
  anuncio: 'anuncio',
  /** Tracking code and situação of a pedido (step 7). */
  rastreio: 'rastreio',
  webhookRegistro: 'webhook-registro',
} as const;
export type FluxoLi = (typeof FLUXO_LI)[keyof typeof FLUXO_LI];

/** One valve per flow. */
export const VALVULA_ENV_LI = {
  estoque: 'LOJA_INTEGRADA_MODO_ESTOQUE',
  preco: 'LOJA_INTEGRADA_MODO_PRECO',
  anuncio: 'LOJA_INTEGRADA_MODO_ANUNCIO',
  rastreio: 'LOJA_INTEGRADA_MODO_RASTREIO',
  webhookRegistro: 'LOJA_INTEGRADA_MODO_WEBHOOK_REGISTRO',
} as const satisfies Record<keyof typeof FLUXO_LI, string>;

/** One canary list per flow that writes to a resource; none for the webhook registration. */
export const CANARIO_ENV_LI = {
  estoque: 'LOJA_INTEGRADA_CANARIO_ESTOQUE',
  preco: 'LOJA_INTEGRADA_CANARIO_PRECO',
  anuncio: 'LOJA_INTEGRADA_CANARIO_ANUNCIO',
  rastreio: 'LOJA_INTEGRADA_CANARIO_RASTREIO',
} as const satisfies Record<Exclude<keyof typeof FLUXO_LI, 'webhookRegistro'>, string>;

/** The read switch: only the exact `on` lets this code call Loja Integrada. */
export const CHAMADAS_ENV_LI = 'LOJA_INTEGRADA_CHAMADAS';

export type ModoLi = 'off' | 'dry-run' | 'on';

export const MODO_LI = {
  off: 'off',
  dryRun: 'dry-run',
  on: 'on',
} as const satisfies Record<string, ModoLi>;

/** The canary value that widens to every target. Exactly this, nothing trimmed. */
export const CANARIO_TODOS = '*';

/** Where each flow's variables live. Keyed by the flow value, so a new flow fails to compile here. */
const NOMES_DO_FLUXO: Readonly<
  Record<FluxoLi, { readonly modo: string; readonly canario: string | null }>
> = {
  [FLUXO_LI.estoque]: { modo: VALVULA_ENV_LI.estoque, canario: CANARIO_ENV_LI.estoque },
  [FLUXO_LI.preco]: { modo: VALVULA_ENV_LI.preco, canario: CANARIO_ENV_LI.preco },
  [FLUXO_LI.anuncio]: { modo: VALVULA_ENV_LI.anuncio, canario: CANARIO_ENV_LI.anuncio },
  [FLUXO_LI.rastreio]: { modo: VALVULA_ENV_LI.rastreio, canario: CANARIO_ENV_LI.rastreio },
  [FLUXO_LI.webhookRegistro]: { modo: VALVULA_ENV_LI.webhookRegistro, canario: null },
};

/**
 * A canary list as read:
 *  - `nenhum`: unset or blank — no target;
 *  - `todos`: exactly `*`;
 *  - `lista`: the canonical keys of the well-formed entries, how many entries
 *    there were, and the 1-based POSITIONS of the malformed ones (never their
 *    text: an operator may paste anything into the variable).
 */
export type CanarioLi =
  | { readonly tipo: 'nenhum' }
  | { readonly tipo: 'todos' }
  | {
      readonly tipo: 'lista';
      readonly chaves: ReadonlySet<string>;
      readonly entradas: number;
      readonly malformadas: readonly number[];
    };

/** One flow's valve, read once at the start of a run. */
export interface ValvulaLi {
  readonly fluxo: FluxoLi;
  readonly modo: ModoLi;
  /**
   * `false` when the variable holds something other than `off`, `dry-run` or
   * `on` (a typo, `ON`, `true`). Unset and blank are expected — the env
   * template ships the line blank — so they count as recognised.
   */
  readonly modoReconhecido: boolean;
  /**
   * `null` for the webhook registration, which has no list: a person picks the
   * conta per call, so its route reads `modo` alone. {@link decidirAlvo} never
   * answers `on` for it (fail closed).
   */
  readonly canario: CanarioLi | null;
}

/**
 * A write target: the conta and the Loja Integrada resource — the LI produto
 * id for stock, price and an existing anúncio; the pedido `numero` for
 * rastreio (one key covers every envio of the order).
 */
export interface AlvoLi {
  readonly contaId: string;
  readonly recurso: number;
}

export type MotivoDryRunLi = 'valvula' | 'sem-canario' | 'fora-do-canario' | 'alvo-invalido';
export type MotivoOnLi = 'todos' | 'no-canario';

/** What one target gets under a valve. */
export type DecisaoAlvoLi =
  | { readonly modo: 'off' }
  | { readonly modo: 'dry-run'; readonly motivo: MotivoDryRunLi }
  | { readonly modo: 'on'; readonly motivo: MotivoOnLi };

/** The conta part of a canary key. Its own grammar: `core/contas.ts` imports Firestore. */
const CONTA_DO_CANARIO = /^[A-Za-z0-9_-]{1,128}$/;
/** One canary entry, whole: `<conta>:<n>`, `n` with no leading zero and at most 16 digits. */
const ENTRADA_DO_CANARIO = /^[A-Za-z0-9_-]{1,128}:([1-9][0-9]{0,15})$/;

/** Whether `entrada` is exactly a canonical key — the only form a lookup can ever match. */
function ehEntradaDoCanario(entrada: string): boolean {
  const m = ENTRADA_DO_CANARIO.exec(entrada);
  // 16 digits can pass 2^53: such an entry could never equal a key built from a number.
  return m !== null && Number.isSafeInteger(Number(m[1]));
}

/** `off` by name, by absence or by the template's blank line: none of them is a typo. */
function ehAusenteOuOff(valor: string | undefined): boolean {
  return valor === undefined || valor === '' || valor === MODO_LI.off;
}

function lerModo(valor: string | undefined): { modo: ModoLi; reconhecido: boolean } {
  if (valor === MODO_LI.on) return { modo: MODO_LI.on, reconhecido: true };
  if (valor === MODO_LI.dryRun) return { modo: MODO_LI.dryRun, reconhecido: true };
  return { modo: MODO_LI.off, reconhecido: ehAusenteOuOff(valor) };
}

function lerCanario(valor: string | undefined): CanarioLi {
  if (valor === undefined || valor === '') return { tipo: 'nenhum' };
  if (valor === CANARIO_TODOS) return { tipo: 'todos' };
  const entradas = valor.split(',');
  const chaves = new Set<string>();
  const malformadas: number[] = [];
  entradas.forEach((entrada, i) => {
    if (ehEntradaDoCanario(entrada)) chaves.add(entrada);
    else malformadas.push(i + 1);
  });
  return { tipo: 'lista', chaves, entradas: entradas.length, malformadas };
}

/**
 * One flow's valve and canary list, read ONCE from `ambiente`. Pure. THE first
 * statement of a write flow: nothing is read from Loja Integrada and no payload
 * is built before it.
 */
export function lerValvula(fluxo: FluxoLi, ambiente: AmbienteLi): ValvulaLi {
  const nomes = NOMES_DO_FLUXO[fluxo];
  const { modo, reconhecido } = lerModo(ambiente[nomes.modo]);
  return {
    fluxo,
    modo,
    modoReconhecido: reconhecido,
    canario: nomes.canario === null ? null : lerCanario(ambiente[nomes.canario]),
  };
}

/** The canonical key of a target, `<contaId>:<recurso>`, or `null` unless both parts are valid. */
export function chaveDoAlvo(a: AlvoLi): string | null {
  if (!CONTA_DO_CANARIO.test(a.contaId)) return null;
  if (!Number.isSafeInteger(a.recurso) || a.recurso < 1) return null;
  return `${a.contaId}:${String(a.recurso)}`;
}

/**
 * What one target gets. Pure. The canary list is consulted only under `on`;
 * under `on`, a target whose key is invalid dry-runs (`alvo-invalido`) even
 * with `*`, so a conta id outside the grammar can never be written by accident.
 */
export function decidirAlvo(v: ValvulaLi, a: AlvoLi): DecisaoAlvoLi {
  switch (v.modo) {
    case MODO_LI.off:
      return { modo: MODO_LI.off };
    case MODO_LI.dryRun:
      return { modo: MODO_LI.dryRun, motivo: 'valvula' };
    case MODO_LI.on:
      break;
  }
  const chave = chaveDoAlvo(a);
  if (chave === null) return { modo: MODO_LI.dryRun, motivo: 'alvo-invalido' };
  const canario = v.canario;
  if (canario === null) return { modo: MODO_LI.dryRun, motivo: 'sem-canario' };
  switch (canario.tipo) {
    case 'nenhum':
      return { modo: MODO_LI.dryRun, motivo: 'sem-canario' };
    case 'todos':
      return { modo: MODO_LI.on, motivo: 'todos' };
    case 'lista':
      return canario.chaves.has(chave)
        ? { modo: MODO_LI.on, motivo: 'no-canario' }
        : { modo: MODO_LI.dryRun, motivo: 'fora-do-canario' };
  }
}

/** The run-start line's own campos. Primitives only; malformed entries by position, never by text. */
export function camposDaValvula(v: ValvulaLi): Readonly<Record<string, CampoLogLi>> {
  const lista = v.canario?.tipo === 'lista' ? v.canario : null;
  const malformadas = lista?.malformadas ?? [];
  return {
    modo: v.modo,
    modoReconhecido: v.modoReconhecido,
    canario: v.canario === null ? null : v.canario.tipo,
    canarioEntradas: v.canario === null ? null : (lista?.entradas ?? 0),
    canarioMalformadas: malformadas.length,
    posicoesMalformadas: malformadas.length === 0 ? null : malformadas.join(','),
  };
}

/** WARNING when the mode is not recognised or any canary entry is malformed; INFO otherwise. */
export function severidadeDaValvula(v: ValvulaLi): SeveridadeLi {
  const malformadas = v.canario?.tipo === 'lista' ? v.canario.malformadas.length : 0;
  return !v.modoReconhecido || malformadas > 0 ? 'WARNING' : 'INFO';
}

/**
 * The run-start line (`evento: 'valvula'`): the second statement of a write
 * flow. `fluxo` always comes from the valve, so the line cannot be mislabelled.
 */
export function registrarValvulaLi(v: ValvulaLi, o: Omit<OpcoesRegistroLi, 'fluxo'>): void {
  registrarEventoLi('valvula', severidadeDaValvula(v), camposDaValvula(v), {
    ...o,
    fluxo: v.fluxo,
  });
}

/** Whether this code may call Loja Integrada at all: only the exact `on`. Pure. */
export function lerChaveDeChamadas(ambiente: AmbienteLi): boolean {
  return ambiente[CHAMADAS_ENV_LI] === MODO_LI.on;
}

/**
 * The line of a call the read switch refused (`evento: 'chamada-bloqueada'`):
 * INFO while the switch is simply off (unset, blank or `off` — the expected
 * state before the window), WARNING when it holds anything else (`ON`, `true`,
 * a stray space), which is a misconfiguration to fix. The value itself is never
 * logged.
 */
export function registrarChamadaBloqueadaLi(
  operacao: string,
  ambiente: AmbienteLi,
  o: OpcoesRegistroLi,
): void {
  const reconhecido = ehAusenteOuOff(ambiente[CHAMADAS_ENV_LI]);
  registrarEventoLi(
    'chamada-bloqueada',
    reconhecido ? 'INFO' : 'WARNING',
    { operacao, chave: CHAMADAS_ENV_LI, valorReconhecido: reconhecido },
    o,
  );
}
