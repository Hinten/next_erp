/**
 * The produto's Shopee tab — the listing draft's LOGISTICS EDITOR model (#1911
 * P16): which mode the draft is in ({@link modoDaLogisticaShopee}), which rows
 * the «Logística (canais de envio)» section shows ({@link linhasDaLogisticaShopee}),
 * which stored channels the shop no longer offers
 * ({@link canaisGravadosForaDaLojaShopee}), what «Escolher canais» puts in the
 * form ({@link escolhaAoEscolherCanaisShopee}, {@link escolhaInicialShopee}),
 * which of a row's two controls cannot move ({@link interruptorTravadoShopee},
 * {@link freteGratisTravadoShopee}), what one switch or checkbox does to the
 * value ({@link comCanalShopee}), and why a value cannot be saved
 * ({@link motivoDaLogisticaInvalidaShopee}).
 * `./rascunho.ts` keeps `logistic_info` as a generic form field; the tab's
 * `LogisticaRascunhoShopee.tsx` renders the rows and owns every sentence — this
 * module answers DATA only (a row carries its verdicts, never their text).
 *
 * ⚠️ PURE: no React, no clock, no I/O, no copy.
 *
 * ## Every decision is the DTO's or the schemas' (#1369)
 *
 * The browser re-derives no fit, no fulfillment mask, no fee and no provenance
 * rule. What a channel IS for this produto arrives in `apps/shopee`'s channels
 * answer (`RespostaCanaisShopee`, `@delfrance/schemas`), computed by the same
 * per-channel decision a publish takes, and this file reads those verdicts as
 * they come:
 *
 * - `selecionavel` — whether the channel gets a row at all;
 * - `obrigatorio` — the row is ON and cannot be switched off;
 * - `bloqueiaFreteGratisDoVendedor` — free shipping is `false` and cannot be
 *   ticked;
 * - `indisponivel` — an OFF row cannot be switched on, nor its free shipping
 *   ticked or unticked (an ON one can be switched off, and its free shipping
 *   still moves);
 * - `automatica` — the entry «Automática» would send, the prefill of
 *   «Escolher canais».
 *
 * The rest is the schemas' own: the ONE ordering of a channel list
 * (`ordenadosPorCanalLogisticaShopee`, the projection's and the write
 * whitelist's), the write whitelist's verdict on a value
 * (`conteudoRascunhoShopeeSchema`, read by its exported messages), and the
 * draft projection (`camposDoRascunhoShopee`) for "did the ERP choose this
 * list". Nothing here orders a list by hand or compares two values: whether a
 * value is DIRTY is `./rascunho.ts`'s write question, untouched here.
 *
 * ## The value this file writes
 *
 * Any interaction answers the FULL list of the shop's selectable channels,
 * each `{logistic_id, enabled, is_free}`, sorted by the schemas' ordering —
 * never only the row that moved:
 *
 * - a stored channel the shop no longer offers (no selectable row) is DROPPED;
 * - an `obrigatorio` channel is written ON, whatever the value held (D16-3) —
 *   the switch says «fica sempre ligado», and every list this file builds
 *   keeps that true;
 * - a channel turned ON from no entry gets `is_free: false` — never the
 *   «Automática» flag, never the produto's;
 * - a blocked channel is always `is_free: false`;
 * - a held `is_free: null` is written `false` (D16-4): the whitelist demands a
 *   boolean, and the checkbox showed it unticked. Unreachable on a draft (only
 *   the draft edit stamps a draft list, always with booleans).
 *
 * A REFUSED change answers the value ITSELF (the same reference), so a caller
 * can tell "nothing to do" from "a new value": switching off an `obrigatorio`
 * row, switching on an `indisponivel` OFF row, an id with no row, free
 * shipping on a blocked row, and free shipping — ticked OR unticked — on an
 * `indisponivel` OFF row: the editor never CHANGES free shipping on a channel
 * it cannot switch on (Lucas 2026-11-16, Q-F1 (b)). A tick the value already
 * holds there is carried as it is by every rebuild — inert, since `enabled:
 * false` never reaches the wire (`apps/shopee`'s `logisticaPublicacao.ts`),
 * and movable again once the channel fits.
 *
 * ## What decides "the same" here (fold scope)
 *
 * - **The display folds the two OFF shapes.** A channel with an `enabled:
 *   false` entry and a channel with NO entry both render OFF, so the list a
 *   publish read back (shape B, the absent channel) and the list this editor
 *   wrote (shape A, the explicit off) show identical rows. DISTINCT: an entry
 *   with `enabled: true` is ON. Only the DISPLAY folds — a round trip on a
 *   shape-B list writes the explicit off, an edit (documented, residual R4).
 * - **The join is by id, exactly.** Rows are the DTO's, in the DTO's order
 *   (`get_channel_list`'s), each joined to the value through a `Map` on
 *   `logistic_id` — never by position. `90003` never matches `900030`.
 * - **A repeated id** (in the value: the projection keeps it, the write never
 *   stores one; in the DTO: never sent) — the FIRST sighting speaks, in the
 *   rows and in the rebuild alike, and the rebuild writes the id once.
 * - **Two query keys are the same read only element by element, exactly**
 *   ({@link mesmaChaveCanaisShopee}): revision `2` never matches `1`, `null`
 *   never matches `0`. No fold.
 *
 * ## The query key
 *
 * {@link chaveCanaisShopee} carries the STORED produto's revision (its
 * `ultimaModificacao`): the route answers from the stored produto, and the app
 * never refetches on focus, so a produto save must read the channels again
 * (D16-10) — and an answer read for another revision never becomes the
 * prefill ({@link mesmaChaveCanaisShopee}).
 */
import {
  MSG_LOGISTICA_CANAL_REPETIDO_RASCUNHO_SHOPEE,
  MSG_LOGISTICA_SEM_CANAL_LIGADO_RASCUNHO_SHOPEE,
  camposDoRascunhoShopee,
  conteudoRascunhoShopeeSchema,
  ordenadosPorCanalLogisticaShopee,
  type CanalDaLojaShopeeDto,
  type CanalLogisticaRascunhoShopee,
  type MotivoIndisponivelCanalShopee,
  type RespostaCanaisShopee,
} from '@delfrance/schemas';

/** One channel of a draft's logistics value — the form's and the projection's shape. */
type Canal = CanalLogisticaRascunhoShopee;

/* -------------------------------------------------------------------------- */
/*                                   The mode                                  */
/* -------------------------------------------------------------------------- */

/** «Automática» (`logistic_info: null`) or «Escolher canais» (a list). */
export type ModoLogisticaShopee = 'automatica' | 'escolhida';

/** The companion of {@link ModoLogisticaShopee} (`prefer-schema-enum`). */
export const MODO_LOGISTICA_SHOPEE = {
  automatica: 'automatica',
  escolhida: 'escolhida',
} as const satisfies Record<string, ModoLogisticaShopee>;

/**
 * The mode of a value: `null` is «Automática»; ANY list — `[]` included — is
 * «Escolher canais» (a stamped empty list is not «Automática», the
 * projection's own rule).
 */
export function modoDaLogisticaShopee(valor: readonly Canal[] | null): ModoLogisticaShopee {
  return valor === null ? MODO_LOGISTICA_SHOPEE.automatica : MODO_LOGISTICA_SHOPEE.escolhida;
}

/* -------------------------------------------------------------------------- */
/*                                 The query key                               */
/* -------------------------------------------------------------------------- */

/**
 * `['shopee','canais',contaId,produtoId,revisaoDoProduto]` — one answer per
 * conta, produto and STORED revision of that produto (`ultimaModificacao`, or
 * `null` while unknown): another revision is another key, so the channels are
 * read again after a produto save (D16-10).
 */
export function chaveCanaisShopee(
  contaId: string,
  produtoId: string,
  revisaoDoProduto: number | null,
): readonly unknown[] {
  return ['shopee', 'canais', contaId, produtoId, revisaoDoProduto];
}

/**
 * Whether two {@link chaveCanaisShopee} keys name the SAME read: the same
 * length and `===` element by element over the key's primitives. EQUAL: two
 * keys built from the same three values. DISTINCT: any element apart — another
 * revision (by one too), `null` (unknown) and `0`, another produto, another
 * conta. «Escolher canais» drops an answer whose key is no longer the
 * section's: the stored produto moved, or the conta changed, during the read.
 */
export function mesmaChaveCanaisShopee(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((parte, i) => parte === b[i]);
}

/* -------------------------------------------------------------------------- */
/*                                   The rows                                  */
/* -------------------------------------------------------------------------- */

/** One row of the «Escolher canais» list — a selectable channel of the shop. */
export interface LinhaLogisticaShopee {
  /** Shopee's channel id — the row's key and the join. */
  readonly logisticId: number;
  /** The DTO's name; `null` ⇒ the component names the channel by its id. */
  readonly nome: string | null;
  /** `obrigatorio`, or an entry with `enabled: true`. No entry and `enabled: false` both read OFF. */
  readonly ligado: boolean;
  /** Not blocked, and an entry with `is_free: true`. */
  readonly freteGratis: boolean;
  readonly obrigatorio: boolean;
  readonly bloqueiaFreteGratis: boolean;
  /** The DTO's reason this produto cannot take the channel, or `null`. */
  readonly indisponivel: MotivoIndisponivelCanalShopee | null;
  /** OFF and available. */
  readonly podeLigar: boolean;
  /** ON and not `obrigatorio`. */
  readonly podeDesligar: boolean;
}

/** The DTO's selectable channels, in its order; a repeated id keeps its FIRST row. */
function canaisSelecionaveis(resposta: RespostaCanaisShopee): readonly CanalDaLojaShopeeDto[] {
  const vistos = new Set<number>();
  const canais: CanalDaLojaShopeeDto[] = [];
  for (const canal of resposta.canais) {
    if (!canal.selecionavel || vistos.has(canal.logisticsChannelId)) continue;
    vistos.add(canal.logisticsChannelId);
    canais.push(canal);
  }
  return canais;
}

/** The value's entries by `logistic_id`; a repeated id keeps its FIRST entry. */
function entradasPorCanal(valor: readonly Canal[]): ReadonlyMap<number, Canal> {
  const porId = new Map<number, Canal>();
  for (const entrada of valor) {
    if (!porId.has(entrada.logistic_id)) porId.set(entrada.logistic_id, entrada);
  }
  return porId;
}

/** One row: the DTO's verdicts over the entry the value holds for it (if any). */
function linhaDoCanal(
  canal: CanalDaLojaShopeeDto,
  entrada: Canal | undefined,
): LinhaLogisticaShopee {
  const ligado = canal.obrigatorio || entrada?.enabled === true;
  return {
    logisticId: canal.logisticsChannelId,
    nome: canal.nome,
    ligado,
    freteGratis: !canal.bloqueiaFreteGratisDoVendedor && entrada?.is_free === true,
    obrigatorio: canal.obrigatorio,
    bloqueiaFreteGratis: canal.bloqueiaFreteGratisDoVendedor,
    indisponivel: canal.indisponivel,
    podeLigar: !ligado && canal.indisponivel === null,
    podeDesligar: ligado && !canal.obrigatorio,
  };
}

/**
 * The section's rows: every SELECTABLE channel of the answer, in the answer's
 * order (never the value's), each joined to the value by `logistic_id`. A
 * non-selectable channel has no row, even when the value holds it ON — it is
 * in {@link canaisGravadosForaDaLojaShopee}.
 */
export function linhasDaLogisticaShopee(
  valor: readonly Canal[],
  resposta: RespostaCanaisShopee,
): readonly LinhaLogisticaShopee[] {
  const entradas = entradasPorCanal(valor);
  return canaisSelecionaveis(resposta).map((canal) =>
    linhaDoCanal(canal, entradas.get(canal.logisticsChannelId)),
  );
}

/** OFF and cannot be switched on (an `indisponivel` row): neither of its controls moves. */
function desligadaIndisponivel(linha: LinhaLogisticaShopee): boolean {
  return !linha.ligado && !linha.podeLigar;
}

/**
 * The row's «Ligado» cannot move: ON and `obrigatorio`, or OFF and
 * `indisponivel`. The section disables the switch on it and
 * {@link comCanalShopee} refuses that move.
 */
export function interruptorTravadoShopee(linha: LinhaLogisticaShopee): boolean {
  return (linha.ligado && !linha.podeDesligar) || desligadaIndisponivel(linha);
}

/**
 * The row's free shipping cannot move: the shop blocks it, or the row is OFF
 * and `indisponivel` — the editor never changes free shipping on a channel it
 * cannot switch on (Lucas 2026-11-16, Q-F1 (b)); a held tick there is carried
 * as it is. Q-F1 (b) adds no lock to an ON `indisponivel` row. The section
 * disables the checkbox on it and {@link comCanalShopee} refuses that move
 * (on a blocked row, the tick; on an OFF `indisponivel` one, either way).
 */
export function freteGratisTravadoShopee(linha: LinhaLogisticaShopee): boolean {
  return linha.bloqueiaFreteGratis || desligadaIndisponivel(linha);
}

/** A stored channel with no row: the shop does not offer it (selectable) any more. */
export interface CanalForaDaLojaShopee {
  readonly logisticId: number;
  /** The DTO's name when the answer still lists the channel; `null` when it does not (or has none). */
  readonly nome: string | null;
}

/**
 * The value's channels that have NO row — not selectable, or absent from the
 * answer — ON or OFF alike (each leaves the list at the next rebuild), once
 * per id, in the value's order. Named by the answer when it still lists the
 * channel, else `nome: null`.
 */
export function canaisGravadosForaDaLojaShopee(
  valor: readonly Canal[],
  resposta: RespostaCanaisShopee,
): readonly CanalForaDaLojaShopee[] {
  const comLinha = new Set(canaisSelecionaveis(resposta).map((canal) => canal.logisticsChannelId));
  const nomes = new Map<number, string | null>();
  for (const canal of resposta.canais) {
    if (!nomes.has(canal.logisticsChannelId)) nomes.set(canal.logisticsChannelId, canal.nome);
  }
  const vistos = new Set<number>();
  const fora: CanalForaDaLojaShopee[] = [];
  for (const entrada of valor) {
    if (comLinha.has(entrada.logistic_id) || vistos.has(entrada.logistic_id)) continue;
    vistos.add(entrada.logistic_id);
    fora.push({ logisticId: entrada.logistic_id, nome: nomes.get(entrada.logistic_id) ?? null });
  }
  return fora;
}

/**
 * Is any row that is ON also available (`indisponivel === null`)? `false` is
 * the section's warning that no channel switched on takes the parcel today —
 * a warning, never a block (the publisher decides with a fresh read).
 */
export function algumLigadoDisponivelShopee(
  valor: readonly Canal[],
  resposta: RespostaCanaisShopee,
): boolean {
  return linhasDaLogisticaShopee(valor, resposta).some(
    (linha) => linha.ligado && linha.indisponivel === null,
  );
}

/* -------------------------------------------------------------------------- */
/*                              «Escolher canais»                              */
/* -------------------------------------------------------------------------- */

/**
 * The prefill from the shop's answer: every selectable channel, sorted —
 * ON when `obrigatorio` (D16-3) or when «Automática» would send it
 * (`automatica !== null`), OFF otherwise; `is_free` is «Automática»'s own flag
 * when it would send the channel, else `false`, and always `false` on a
 * blocked channel. A non-selectable channel is never in it.
 */
export function escolhaInicialShopee(resposta: RespostaCanaisShopee): Canal[] {
  return ordenadosPorCanalLogisticaShopee(
    canaisSelecionaveis(resposta).map(
      (canal): Canal => ({
        logistic_id: canal.logisticsChannelId,
        enabled: canal.obrigatorio || canal.automatica !== null,
        is_free:
          !canal.bloqueiaFreteGratisDoVendedor &&
          canal.automatica !== null &&
          canal.automatica.isFree,
      }),
    ),
  );
}

/**
 * What «Escolher canais» puts in the form (D16-2):
 * - a HELD list (Automática chosen over a stored choice) ⇒ that list, the SAME
 *   reference, at once — the round trip reads clean instead of replacing the
 *   stored choice (the «put the held category back» precedent). Verbatim, an
 *   OFF `obrigatorio` entry included (residual R3: it renders ON and the next
 *   interaction writes it ON);
 * - no held list and no answer yet ⇒ `null`: read the channels first;
 * - no held list ⇒ {@link escolhaInicialShopee} of the answer.
 */
export function escolhaAoEscolherCanaisShopee(
  guardada: readonly Canal[] | null,
  resposta: RespostaCanaisShopee | null,
): readonly Canal[] | null {
  if (guardada !== null) return guardada;
  if (resposta === null) return null;
  return escolhaInicialShopee(resposta);
}

/* -------------------------------------------------------------------------- */
/*                                 One change                                  */
/* -------------------------------------------------------------------------- */

/** One operator interaction on one row: the switch, the checkbox, or both. */
export interface MudancaDoCanalShopee {
  readonly ligado?: boolean;
  readonly freteGratis?: boolean;
}

/**
 * The value after one interaction on the row `logisticId` — the FULL list of
 * the answer's selectable channels, sorted, each as its row shows it, with the
 * change applied to that row (see the module header for every rule).
 *
 * A REFUSED change answers `valor` itself (the same reference): `ligado:
 * false` on an `obrigatorio` row, `ligado: true` on an OFF `indisponivel` row,
 * an id with no row, `freteGratis: true` on a blocked row, and ANY
 * `freteGratis` on an OFF `indisponivel` row (Q-F1 (b): the section disables
 * that checkbox, {@link freteGratisTravadoShopee}). A change with one refused
 * part is refused whole.
 */
export function comCanalShopee(
  valor: readonly Canal[],
  resposta: RespostaCanaisShopee,
  logisticId: number,
  mudanca: MudancaDoCanalShopee,
): readonly Canal[] {
  const canais = canaisSelecionaveis(resposta);
  const alvo = canais.find((canal) => canal.logisticsChannelId === logisticId);
  if (alvo === undefined) return valor;
  const entradas = entradasPorCanal(valor);
  const atual = linhaDoCanal(alvo, entradas.get(logisticId));
  if (mudanca.ligado === true && desligadaIndisponivel(atual)) return valor;
  if (mudanca.ligado === false && atual.ligado && !atual.podeDesligar) return valor;
  if (mudanca.freteGratis === true && atual.bloqueiaFreteGratis) return valor;
  if (mudanca.freteGratis !== undefined && desligadaIndisponivel(atual)) return valor;

  return ordenadosPorCanalLogisticaShopee(
    canais.map((canal): Canal => {
      const linha = linhaDoCanal(canal, entradas.get(canal.logisticsChannelId));
      const ehAlvo = canal.logisticsChannelId === logisticId;
      return {
        logistic_id: canal.logisticsChannelId,
        enabled: ehAlvo && mudanca.ligado !== undefined ? mudanca.ligado : linha.ligado,
        is_free:
          ehAlvo && mudanca.freteGratis !== undefined ? mudanca.freteGratis : linha.freteGratis,
      };
    }),
  );
}

/* -------------------------------------------------------------------------- */
/*                          Why a value cannot be saved                        */
/* -------------------------------------------------------------------------- */

/**
 * Why the write whitelist refuses a logistics value: no channel ON (`[]`
 * included), a repeated `logistic_id`, or anything else (more than
 * `MAX_CANAIS_LOGISTICA_RASCUNHO_SHOPEE` channels, a non-boolean `is_free`).
 */
export type MotivoDaLogisticaInvalidaShopee = 'sem-canal-ligado' | 'canal-repetido' | 'invalida';

/** The companion of {@link MotivoDaLogisticaInvalidaShopee} (`prefer-schema-enum`). */
export const MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE = {
  semCanalLigado: 'sem-canal-ligado',
  canalRepetido: 'canal-repetido',
  invalida: 'invalida',
} as const satisfies Record<string, MotivoDaLogisticaInvalidaShopee>;

/**
 * THE whitelist's verdict on a value, never a second copy of its rules
 * (#1369): `conteudoRascunhoShopeeSchema.shape.logistic_info` parses it, and
 * its issues are read against the exported messages — no channel ON first,
 * then a repeated id; any other issue is `invalida`. Accepted (`null`
 * included) ⇒ `null`.
 *
 * It answers for ANY value; whether the draft's plan validates the field at
 * all (an untouched stored value is never validated) is `./rascunho.ts`'s.
 */
export function motivoDaLogisticaInvalidaShopee(
  valor: readonly Canal[] | null,
): MotivoDaLogisticaInvalidaShopee | null {
  const lido = conteudoRascunhoShopeeSchema.shape.logistic_info.safeParse(valor);
  if (lido.success) return null;
  const mensagens = new Set(lido.error.issues.map((issue) => issue.message));
  if (mensagens.has(MSG_LOGISTICA_SEM_CANAL_LIGADO_RASCUNHO_SHOPEE)) {
    return MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.semCanalLigado;
  }
  if (mensagens.has(MSG_LOGISTICA_CANAL_REPETIDO_RASCUNHO_SHOPEE)) {
    return MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.canalRepetido;
  }
  return MOTIVO_DA_LOGISTICA_INVALIDA_SHOPEE.invalida;
}

/* -------------------------------------------------------------------------- */
/*                         Did the ERP choose this list                        */
/* -------------------------------------------------------------------------- */

/**
 * Does the STORED draft hold a channel choice the ERP made? Through THE draft
 * projection (`camposDoRascunhoShopee(link).logistic_info !== null`): a list
 * the ERP never stamped — the previous system's — reads `null`, «Automática»,
 * exactly as the publisher distrusts it; a stamped `[]` reads `[]`, a choice.
 * Never `Array.isArray` on the raw field. The refusal routing of a draft's
 * «Publicar» reads it (D16-7).
 */
export function logisticaEscolhidaNoRascunhoShopee(link: Record<string, unknown>): boolean {
  return camposDoRascunhoShopee(link).logistic_info !== null;
}
