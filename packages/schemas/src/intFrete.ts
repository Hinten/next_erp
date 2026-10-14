import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { millisSinceEpoch } from './shared/datetime';
import { outerRefSchema } from './shared/outerRef';
import { enderecoSchema } from './endereco';
import { integracoesFreteSchema } from './shared/frete';

const PERM_FRETE_READ = 1n << 88n;
const PERM_FRETE_WRITE = 1n << 89n;
const PERM_FRETE_DELETE = 1n << 90n;

/**
 * IntegracaoFrete (`int_frete` collection) — shipping integration configs,
 * ported from `.old/packages/integracao_frete/lib/src/models.dart` and its
 * subtype packages under `.old/packages/integracoes_frete/`.
 *
 * One collection, discriminated by the string `tipo` field (the
 * `INTEGRACOES_FRETE` slug from `frete.ts`). Flutter subtypes only ADD
 * fields on top of the base — `prazoExtra` (Motoboy / RetirarNaLoja /
 * FretePorContaDestinatario) and `client_id` / `client_secret`
 * (ContaMelhorEnvios) — so a single Zod object with defaulted extras keeps
 * TableView/ObjectView happy and stays byte-compatible (same approach as
 * `integracaoSchema`).
 *
 * Wire conventions (must match the shapes the migrated corpus stores):
 *   - `dataCadastro` is a **required** ms-since-epoch int — this schema
 *     declares it required, so a missing or null value fails the read here.
 *     (The original reason was that it crashed the Flutter read; that is void,
 *     rule 8. The rule survives on its own terms.) Always stamp it on create.
 *   - `prazoExtra` is a **non-nullable** Dart `int` (constructor default 0).
 *     Write the number, never null. Extra key on tipos that don't use it is
 *     ignored by `json_serializable`.
 *   - `filialIntegracaoFreteOuterRef` is a **string** doc path in the
 *     Flutter ODM format `documents/<collection>/<id>` —
 *     `OuterRefField.toJson()` returns `docId.pathWithDocuments`
 *     (`.old/packages/backend/database/database_all/lib/src/types.dart:1378`).
 *   - `mapa` / `faixaCep` / `horarioDeCorte` / `enderecoDeOrigem` /
 *     `client_id` / `client_secret` are `includeIfNull: false` on the
 *     Flutter side but their `fromJson` helpers all tolerate explicit null,
 *     so `.nullable().default(null)` is read-safe against migrated docs.
 */

/* -------------------------------------------------------------------------- */
/*                              DIA_DA_SEMANA                                 */
/* -------------------------------------------------------------------------- */

/**
 * Weekday for `horarioDeCorte`. Stored as the int 1 (segunda) … 7 (domingo),
 * matching Dart's `DateTime.weekday` and the `DIA_DA_SEMANA` enum at
 * `.old/packages/integracao_frete/lib/src/models.dart:437`.
 */
export const diaDaSemanaSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);
export type DiaDaSemana = z.infer<typeof diaDaSemanaSchema>;

export const DIA_DA_SEMANA_LABELS: Record<DiaDaSemana, string> = {
  1: 'Segunda-feira',
  2: 'Terça-feira',
  3: 'Quarta-feira',
  4: 'Quinta-feira',
  5: 'Sexta-feira',
  6: 'Sábado',
  7: 'Domingo',
};

/* -------------------------------------------------------------------------- */
/*                                FaixaDeCep                                  */
/* -------------------------------------------------------------------------- */

/**
 * CEP price band (motoboy pricing). Mirrors `FaixaDeCep` at
 * `.old/packages/integracao_frete/lib/src/models.dart:290` — every key is
 * written non-null by Flutter.
 */
export const faixaDeCepSchema = z
  .object({
    cepInicial: z
      .string()
      .regex(/^\d{8}$/, 'CEP deve ter 8 dígitos')
      .describe('CEP Inicial'),
    cepFinal: z
      .string()
      .regex(/^\d{8}$/, 'CEP deve ter 8 dígitos')
      .describe('CEP Final'),
    custo: z.number().min(0).default(0).describe('Custo'),
    valor: z.number().min(0).describe('Preço'),
    prazo: z.number().int().min(0).describe('Prazo de Entrega (dias)'),
  })
  .passthrough();
export type FaixaDeCep = z.infer<typeof faixaDeCepSchema>;

/**
 * Legacy `FaixaDeCep.optionString` — the serialized form the Flutter motoboy
 * widget stores in `freteInicial.externalOptionId` when a band is picked
 * (`'$cepInicial - $cepFinal - $custo - $valor - $prazo'`). Dart interpolates
 * doubles with a mandatory decimal part (`15.0`, not `15`), so integral
 * custo/valor get a `.0` suffix to stay byte-identical.
 */
export function faixaCepOptionString(faixa: FaixaDeCep): string {
  const dartDouble = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
  return `${faixa.cepInicial} - ${faixa.cepFinal} - ${dartDouble(faixa.custo)} - ${dartDouble(faixa.valor)} - ${faixa.prazo}`;
}

/* -------------------------------------------------------------------------- */
/*                              HorarioDeCorte                                */
/* -------------------------------------------------------------------------- */

/**
 * Cut-off schedule entry. Mirrors `HorarioDeCorte` at
 * `.old/packages/integracao_frete/lib/src/models.dart:374`. All keys are
 * written by Flutter (nulls included — the class has no `includeIfNull:
 * false`).
 */
export const horarioDeCorteSchema = z
  .object({
    diaDaSemana: diaDaSemanaSchema.describe('Dia da Semana'),
    horaDeCorte: z.number().int().min(0).max(23).nullable().default(null).describe('Hora (24h)'),
    minutosDeCorte: z.number().int().min(0).max(59).nullable().default(null).describe('Minutos'),
    prazoDePostagem: z.number().int().min(0).nullable().default(null).describe('Dias úteis'),
    horaPostagem: z
      .number()
      .int()
      .min(0)
      .max(23)
      .nullable()
      .default(null)
      .describe('Hora da postagem (24h)'),
    minutosPostagem: z
      .number()
      .int()
      .min(0)
      .max(59)
      .nullable()
      .default(null)
      .describe('Minutos da postagem'),
  })
  .passthrough();
export type HorarioDeCorte = z.infer<typeof horarioDeCorteSchema>;

/* -------------------------------------------------------------------------- */
/*                            MapaDeIntegracoes                               */
/* -------------------------------------------------------------------------- */

/**
 * Marketplace → internal freight routing entry. Mirrors `MapaDeIntegracoes`
 * at `.old/packages/integracao_frete/lib/src/models.dart:233`: translates a
 * marketplace shipping option (`nomeOriginal` / `idOriginal`) into a target
 * internal integration (`integracaoUid` + `targetTipoIntegracao` +
 * provider-specific `targetData`). Not surfaced in the UI yet — kept for
 * read/write parity with Flutter-authored docs.
 */
export const mapaDeIntegracoesSchema = z
  .object({
    nomeOriginal: z.string().describe('Nome original'),
    idOriginal: z.string().nullable().default(null).describe('ID original'),
    observacao: z.string().nullable().default(null).describe('Observação'),
    nomeTarget: z.string().nullable().default(null).describe('Nome target'),
    targetData: z.record(z.string(), z.unknown()).nullable().default(null).describe('Dados'),
    integracaoUid: z.string().nullable().default(null).describe('Integração target'),
    targetTipoIntegracao: integracoesFreteSchema.default('outros').describe('Tipo target'),
  })
  .passthrough();
export type MapaDeIntegracoes = z.infer<typeof mapaDeIntegracoesSchema>;

/* -------------------------------------------------------------------------- */
/*                           IntFrete — main schema                           */
/* -------------------------------------------------------------------------- */

export const intFreteSchema = z
  .object({
    tipo: integracoesFreteSchema.default('outros').describe('Tipo'),
    nome: z.string().min(1).max(255).describe('Nome'),
    ativo: z.boolean().default(true).describe('Ativo'),
    /** String doc path `documents/filiais/<id>` (Flutter ODM format). */
    filialIntegracaoFreteOuterRef: outerRefSchema.describe('Filial'),
    /**
     * Back-reference to the Mercado Livre conta (`integracao`) this Mercado
     * Envios freight doc belongs to — `documents/integracao/<id>`. Legacy
     * `MercadoEnvios.contaMercadoLivreMercadoEnviosOuterRef`
     * (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:332`),
     * which the order importer matches on to find the account's freight config.
     *
     * **Server-owned** (#782): the sole writer is the
     * `onIntegracaoMercadoLivreChanged` trigger in the `mercado-livre` functions
     * codebase, which keeps this doc in sync with the conta. Null on every other
     * `tipo` — hence nullable, despite being mandatory for `mercadoLivre`.
     */
    contaMercadoLivreMercadoEnviosOuterRef: outerRefSchema
      .nullable()
      .default(null)
      .describe('Conta Mercado Livre'),
    enderecoDeOrigem: enderecoSchema
      .passthrough()
      .nullable()
      .default(null)
      .describe('Endereço de origem'),
    /** Required ms since epoch — Flutter crashes on null (late final DateTime). */
    dataCadastro: millisSinceEpoch('Data de cadastro'),
    // System stamp — stamped by `saveRecord` on every write so the TableView
    // update-monitor sees edits.
    // `.default(null)`, never a bare `.optional()`: the TableView update-
    // monitor runs a CLASSIC `orderBy(ultimaModificacao, 'desc').limit(1)`,
    // which EXCLUDES documents missing the key — so a dropped key hides the
    // row from the staleness check, silently. Pinned by
    // `defaultQuery.sortKeyPresence.test.ts`.
    ultimaModificacao: millisSinceEpoch('Última modificação').nullable().default(null),

    mapa: z.array(mapaDeIntegracoesSchema).nullable().default(null).describe('Mapa de integrações'),
    faixaCep: z.array(faixaDeCepSchema).nullable().default(null).describe('Faixas de CEP'),
    horarioDeCorte: z
      .array(horarioDeCorteSchema)
      .superRefine((rows, ctx) => {
        // One entry per weekday — `getPrazoDespacho` silently uses only the
        // first match, so a duplicate is always a configuration mistake.
        // Legacy docs with duplicates still read (parseSoftRead tolerates);
        // editing one forces the cleanup.
        const seen = new Set<number>();
        rows.forEach((row, i) => {
          if (seen.has(row.diaDaSemana)) {
            ctx.addIssue({
              code: 'custom',
              path: [i, 'diaDaSemana'],
              message: 'Dia da semana duplicado',
            });
          } else {
            seen.add(row.diaDaSemana);
          }
        });
      })
      .nullable()
      .default(null)
      .describe('Horários de corte'),

    // Subtype extras — see header. Always written; ignored by tipos that
    // don't use them.
    /** Extra days on top of the computed deadline (motoboy/retirada/fob). */
    prazoExtra: z.number().int().default(0).describe('Prazo extra (dias)'),
    /** Melhor Envios OAuth app credentials (tipo='melhorEnvios' only). */
    client_id: z.string().nullable().default(null).describe('Client ID'),
    client_secret: z.string().nullable().default(null).describe('Client Secret'),
  })
  .passthrough();
export type IntFrete = z.infer<typeof intFreteSchema>;

export const intFreteMeta: CollectionMetadata = {
  collectionPath: 'int_frete',
  permissions: {
    read: PERM_FRETE_READ,
    write: PERM_FRETE_WRITE,
    delete: PERM_FRETE_DELETE,
  },
  // `oauthState` holds the per-attempt OAuth connect record (#1034); it frees on
  // delete for the same reason `tokenMelEnv` does — it is credential material.
  cascade: [
    { path: 'int_frete/{intFreteId}/oauthState', onDelete: 'cascade' },
    { path: 'int_frete/{intFreteId}/tokenMelEnv', onDelete: 'cascade' },
  ],
  // Like `integracao`, this collection mixes freight-integration types; each
  // logistics slice lists one `tipo` via TableView's `queryParams`.
  defaultQuery: {
    where: [{ field: 'tipo', param: true }],
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
    columns: ['nome', 'ativo', 'prazoExtra'],
  },
};

export const intFrete = { schema: intFreteSchema, meta: intFreteMeta };

/* -------------------------------------------------------------------------- */
/*                         TokenMelEnv (subcollection)                        */
/* -------------------------------------------------------------------------- */

/**
 * Melhor Envios OAuth token doc — `int_frete/{id}/tokenMelEnv`. Mirrors
 * `TokenMelhorEnvio` at
 * `.old/packages/integracoes_frete/melhor_envio/lib/src/models.dart:80`.
 * Single-token semantics: the writer deletes older docs so at most one
 * lives. Server-side only — the browser never reads or writes these.
 */
export const tokenMelEnvSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    /** Required ms since epoch (`now + expires_in`). Server-side only. */
    expirationDate: millisSinceEpoch(),
  })
  .passthrough();
export type TokenMelEnv = z.infer<typeof tokenMelEnvSchema>;

export const tokenMelEnvMeta: CollectionMetadata = {
  collectionPath: 'int_frete/{intFreteId}/tokenMelEnv',
  // Tokens carry live credentials — reads require frete.write (not mere
  // frete.read); the real consumers run through the Admin SDK in
  // apps/integrations anyway.
  permissions: {
    read: PERM_FRETE_WRITE,
    write: PERM_FRETE_WRITE,
    delete: PERM_FRETE_DELETE,
  },
};

export const tokenMelEnv = { schema: tokenMelEnvSchema, meta: tokenMelEnvMeta };

/* -------------------------------------------------------------------------- */
/*                              getPrazoDespacho                              */
/* -------------------------------------------------------------------------- */

/**
 * The wall-clock components the cut-off rule actually reads — the input to
 * {@link calcularPrazoDespachoCivil}, and the seam that makes the rule usable
 * OFF the caller's own timezone.
 *
 * A "civil" date-time is a calendar reading with no zone attached: `2021-01-04
 * 13:59, a Monday`. Which INSTANT that is depends on the zone, and that
 * conversion is the caller's half (see {@link getPrazoDespacho} for the local
 * one and {@link getPrazoDespachoNoFuso} for an explicit zone).
 */
export interface PartesCivis {
  /** Dart's weekday: 1 = segunda … 7 = domingo. */
  readonly diaDaSemana: number;
  /** Full year, e.g. `2021`. */
  readonly ano: number;
  /** ZERO-BASED month, like `Date#getMonth` — the arithmetic below feeds `Date.UTC`. */
  readonly mes: number;
  readonly dia: number;
  /** 0–23. */
  readonly hora: number;
  readonly minuto: number;
}

/**
 * The dispatch deadline as civil components.
 *
 * ⚠️ `dia` is deliberately **NOT normalised**: it is literally
 * `agora.dia + c + prazoDePostagem` and may overflow its month (`2021-01-33`).
 * Both bindings feed it to a `Date` constructor, which normalises exactly as
 * Dart's `DateTime(...)` does — that overflow IS the ported behaviour, so
 * normalising here would silently change it.
 */
export interface PrazoDespachoCivil {
  readonly ano: number;
  /** Zero-based, like {@link PartesCivis.mes}. */
  readonly mes: number;
  /** May exceed the month's length — see the note above. */
  readonly dia: number;
  readonly hora: number;
  readonly minuto: number;
}

/**
 * The cut-off rule itself: pure, zone-free, over civil components.
 *
 * Characterization port of `IntegracaoFrete.getPrazoDespacho` at
 * `.old/packages/integracao_frete/lib/src/models.dart:147-197`, preserving its
 * quirks:
 *
 *   - `prazoDePostagem` is read **once** from *today's* entry (0 when today
 *     has no entry) and applied to every candidate day.
 *   - Same-day cut-off passes when `hour < horaDeCorte` OR
 *     (`hour == horaDeCorte` AND `minute <= minutosDeCorte`) — note the
 *     inclusive minute. Null hora/minutos count as 0.
 *   - The target weekday wraps once past 7 (`targetDia -= 7`), so a
 *     `prazoDePostagem > 7` is undefined behavior, same as Dart.
 *   - The result is `agora + (c + prazoDePostagem) days` at
 *     `horaPostagem:minutosPostagem` (defaulting 00:00).
 *
 * ⚠️ Extracted from {@link getPrazoDespacho} rather than copied. The rule now
 * runs on two surfaces — an operator's browser (their own zone, correct) and a
 * server importing a marketplace order (`America/Sao_Paulo`, explicit) — and a
 * rule written twice is a rule that drifts, silently, toward two plausible
 * answers three hours apart.
 */
export function calcularPrazoDespachoCivil(
  horarios: ReadonlyArray<HorarioDeCorte> | null | undefined,
  agora: PartesCivis,
): PrazoDespachoCivil | null {
  if (!horarios || horarios.length === 0) return null;

  let encontrado: HorarioDeCorte | null = null;
  let c = 0;
  const max = 7;
  let currentDia = agora.diaDaSemana;
  const diaDeHoje = horarios.find((h) => h.diaDaSemana === currentDia);
  const prazoDePostagem = diaDeHoje?.prazoDePostagem ?? 0;

  while (encontrado === null && c < max) {
    const cIter = c;
    const diaIter = currentDia;
    encontrado =
      horarios.find((h) => {
        let targetDia = diaIter + prazoDePostagem;
        if (targetDia > 7) targetDia = targetDia - 7;
        return (
          h.diaDaSemana === targetDia &&
          (cIter > 0 ||
            agora.hora < (h.horaDeCorte ?? 0) ||
            (agora.hora === (h.horaDeCorte ?? 0) && agora.minuto <= (h.minutosDeCorte ?? 0)))
        );
      }) ?? null;
    if (encontrado !== null) break;
    currentDia++;
    if (currentDia > 7) currentDia = 1;
    c++;
  }

  if (encontrado === null) return null;

  return {
    ano: agora.ano,
    mes: agora.mes,
    dia: agora.dia + c + prazoDePostagem,
    hora: encontrado.horaPostagem ?? 0,
    minuto: encontrado.minutosPostagem ?? 0,
  };
}

/**
 * Compute the dispatch deadline from a cut-off schedule, in the caller's LOCAL
 * timezone.
 *
 * The rule lives in {@link calcularPrazoDespachoCivil}; this function is the
 * local-zone binding of it — it reads `agora`'s components with the local
 * getters and rebuilds the answer with the local `Date` constructor, so
 * `new Date(y, m, d + n)` overflows months exactly like Dart's `DateTime(...)`.
 *
 * Times are interpreted in the caller's local timezone — identical to the
 * legacy Flutter client, which computed this on the user's machine
 * (America/Sao_Paulo in production). Pass an explicit `agora` for
 * determinism; the function never reads the wall clock.
 *
 * ⚠️ **This binding is for the BROWSER.** On a server the ambient zone is
 * whichever container happened to run the code — `apps/nfe` runs
 * `TZ=America/Sao_Paulo` while every other backend is UTC, and the test runner
 * has a third zone — so a server surface must call
 * {@link getPrazoDespachoNoFuso} with the zone named out loud.
 */
export function getPrazoDespacho(
  horarios: ReadonlyArray<HorarioDeCorte> | null | undefined,
  agora: Date,
): Date | null {
  const alvo = calcularPrazoDespachoCivil(horarios, {
    // Dart weekday: Mon=1 … Sun=7. JS getDay: Sun=0 … Sat=6.
    diaDaSemana: agora.getDay() === 0 ? 7 : agora.getDay(),
    ano: agora.getFullYear(),
    mes: agora.getMonth(),
    dia: agora.getDate(),
    hora: agora.getHours(),
    minuto: agora.getMinutes(),
  });
  if (alvo === null) return null;
  return new Date(alvo.ano, alvo.mes, alvo.dia, alvo.hora, alvo.minuto);
}

/* ----------------------------- zoned binding ------------------------------ */

/**
 * The civil components of an instant in a NAMED timezone, plus the seconds the
 * offset arithmetic needs.
 *
 * `weekday` is derived from the civil DATE rather than parsed from the locale's
 * weekday name: `Date.UTC(ano, mes, dia)` names the same calendar day and
 * `getUTCDay()` is exact, whereas a `weekday: 'short'` part is an ICU string
 * whose spelling is not part of any contract we control.
 */
function partesCivisNoFuso(
  instanteMs: number,
  timeZone: string,
): PartesCivis & { segundo: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instanteMs));
  const get = (type: string): number =>
    Number(partes.find((p) => p.type === type)?.value ?? Number.NaN);

  const ano = get('year');
  const mes = get('month') - 1;
  const dia = get('day');
  // ⚠️ Some ICU versions emit hour '24' for midnight under `hour12: false`.
  // The same normalisation `estoqueSweep.ts` carries, and here it is
  // load-bearing: hour 24 would sail past every `horaDeCorte` comparison.
  const hora = get('hour') % 24;
  const diaSemanaJs = new Date(Date.UTC(ano, mes, dia)).getUTCDay();

  return {
    diaDaSemana: diaSemanaJs === 0 ? 7 : diaSemanaJs,
    ano,
    mes,
    dia,
    hora,
    minuto: get('minute'),
    segundo: get('second'),
  };
}

/** The zone's offset from UTC, in ms, AT the given instant (negative west of Greenwich). */
function deslocamentoDoFusoMs(instanteMs: number, timeZone: string): number {
  const p = partesCivisNoFuso(instanteMs, timeZone);
  const comoUtc = Date.UTC(p.ano, p.mes, p.dia, p.hora, p.minuto, p.segundo);
  // Drop sub-second precision on both sides: the formatter has none.
  return comoUtc - Math.floor(instanteMs / 1000) * 1000;
}

/**
 * A civil date-time in a named zone → the instant, in ms.
 *
 * Two passes, the same shape `simplesNacional/competencia.ts` uses for the
 * fiscal-month boundary: the first guesses the offset by reading the civil time
 * as if it were UTC, the second re-measures it AT the instant that guess lands
 * on and corrects once.
 *
 * ⚠️ The offset is asked of `Intl`, never assumed. São Paulo has been a fixed
 * UTC−3 since Brazil abolished DST in 2019, but a hardcoded −3 h is exactly the
 * legacy Shopee importer's defect, it is wrong for any pre-2019 instant, and it
 * would be wrong again the day the rule changes. On a zone that DOES observe
 * DST the second pass is what lands the answer on the right side of the
 * transition; inside a spring-forward gap (a civil time that does not exist)
 * the result is the instant one offset-step away, which is defined and stable
 * rather than correct — nothing here needs more.
 */
function instanteDoCivilNoFuso(civil: PrazoDespachoCivil, timeZone: string): number {
  // `Date.UTC` normalises the deliberately-unnormalised `dia` (see
  // {@link PrazoDespachoCivil}) exactly as the local `Date` constructor does.
  const comoUtc = Date.UTC(civil.ano, civil.mes, civil.dia, civil.hora, civil.minuto);
  const primeiroChute = comoUtc - deslocamentoDoFusoMs(comoUtc, timeZone);
  return comoUtc - deslocamentoDoFusoMs(primeiroChute, timeZone);
}

/**
 * Compute the dispatch deadline from a cut-off schedule in an EXPLICIT
 * timezone, returning the resulting instant in ms since epoch.
 *
 * Same rule, same quirks and the same schedule shape as
 * {@link getPrazoDespacho} — it is the same {@link calcularPrazoDespachoCivil}
 * core — with the two zone-dependent halves named out loud instead of inherited
 * from the process:
 *
 *   1. `agoraMs` → civil components in `timeZone` (`Intl.DateTimeFormat` with
 *      the zone in the options, the `estoqueSweep.ts` shape);
 *   2. the civil answer → an instant in `timeZone` (two-pass offset).
 *
 * This is the binding a SERVER must use. The ambient process zone differs
 * across this repo's own backends — `apps/nfe` runs `TZ=America/Sao_Paulo`,
 * every other backend is UTC, and the test runner has a third one — so the same
 * cut-off answers different days depending on which service ran it, which is
 * what `delfrance/no-ambient-timezone` exists to say. An explicit `timeZone`
 * option is that rule's documented escape.
 *
 * @param agoraMs  the reference instant (a marketplace `pay_time`, a clock read)
 * @param timeZone an IANA zone id, e.g. `'America/Sao_Paulo'`
 * @returns the deadline as ms since epoch, or `null` when the schedule answers
 *          nothing (empty, or no weekday matched inside the 7-day scan)
 */
export function getPrazoDespachoNoFuso(
  horarios: ReadonlyArray<HorarioDeCorte> | null | undefined,
  agoraMs: number,
  timeZone: string,
): number | null {
  if (!horarios || horarios.length === 0) return null;
  const alvo = calcularPrazoDespachoCivil(horarios, partesCivisNoFuso(agoraMs, timeZone));
  if (alvo === null) return null;
  return instanteDoCivilNoFuso(alvo, timeZone);
}
