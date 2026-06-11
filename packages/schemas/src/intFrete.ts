import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { enderecoSchema } from './endereco';
import { integracoesFreteSchema } from './frete';

const PERM_FRETE_READ = 1n << 88n;
const PERM_FRETE_WRITE = 1n << 89n;

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
 * Wire conventions (must match the still-running Flutter app):
 *   - `dataCadastro` is a **required** ms-since-epoch int. Flutter declares
 *     it `late final DateTime` with `dateTimeFromJson(int)` — a missing or
 *     null value crashes the Flutter read. Always stamp it on create.
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
 *     so `.nullable().default(null)` is read-safe for both apps.
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
    filialIntegracaoFreteOuterRef: z.string().min(1).describe('Filial'),
    enderecoDeOrigem: enderecoSchema
      .passthrough()
      .nullable()
      .default(null)
      .describe('Endereço de origem'),
    /** Required ms since epoch — Flutter crashes on null (late final DateTime). */
    dataCadastro: z.number().int().describe('Data de cadastro'),

    mapa: z.array(mapaDeIntegracoesSchema).nullable().default(null).describe('Mapa de integrações'),
    faixaCep: z.array(faixaDeCepSchema).nullable().default(null).describe('Faixas de CEP'),
    horarioDeCorte: z
      .array(horarioDeCorteSchema)
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
    delete: PERM_FRETE_WRITE,
  },
  cascade: [{ path: 'int_frete/{intFreteId}/tokenMelEnv', onDelete: 'cascade' }],
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
    /** Required ms since epoch (`now + expires_in`). */
    expirationDate: z.number().int(),
  })
  .passthrough();
export type TokenMelEnv = z.infer<typeof tokenMelEnvSchema>;

export const tokenMelEnvMeta: CollectionMetadata = {
  collectionPath: 'int_frete/{intFreteId}/tokenMelEnv',
  // Tokens carry live credentials — every action gated on frete.write; the
  // real consumers run through the Admin SDK in apps/integrations anyway.
  permissions: {
    read: PERM_FRETE_WRITE,
    write: PERM_FRETE_WRITE,
    delete: PERM_FRETE_WRITE,
  },
};

export const tokenMelEnv = { schema: tokenMelEnvSchema, meta: tokenMelEnvMeta };

/* -------------------------------------------------------------------------- */
/*                              getPrazoDespacho                              */
/* -------------------------------------------------------------------------- */

/**
 * Compute the dispatch deadline from a cut-off schedule. Characterization
 * port of `IntegracaoFrete.getPrazoDespacho` at
 * `.old/packages/integracao_frete/lib/src/models.dart:147-197`, preserving
 * its quirks:
 *
 *   - `prazoDePostagem` is read **once** from *today's* entry (0 when today
 *     has no entry) and applied to every candidate day.
 *   - Same-day cut-off passes when `hour < horaDeCorte` OR
 *     (`hour == horaDeCorte` AND `minute <= minutosDeCorte`) — note the
 *     inclusive minute. Null hora/minutos count as 0.
 *   - The target weekday wraps once past 7 (`targetDia -= 7`), so a
 *     `prazoDePostagem > 7` is undefined behavior, same as Dart.
 *   - The result is `agora + (c + prazoDePostagem) days` at
 *     `horaPostagem:minutosPostagem` (defaulting 00:00); JS `new Date(y, m,
 *     d + n)` overflows months exactly like Dart's `DateTime(...)`.
 *
 * Times are interpreted in the caller's local timezone — identical to the
 * legacy Flutter client, which computed this on the user's machine
 * (America/Sao_Paulo in production). Pass an explicit `agora` for
 * determinism; the function never reads the wall clock.
 */
export function getPrazoDespacho(
  horarios: ReadonlyArray<HorarioDeCorte> | null | undefined,
  agora: Date,
): Date | null {
  if (!horarios || horarios.length === 0) return null;

  // Dart weekday: Mon=1 … Sun=7. JS getDay: Sun=0 … Sat=6.
  const weekdayOf = (d: Date): number => (d.getDay() === 0 ? 7 : d.getDay());

  let encontrado: HorarioDeCorte | null = null;
  let c = 0;
  const max = 7;
  let currentDia = weekdayOf(agora);
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
            agora.getHours() < (h.horaDeCorte ?? 0) ||
            (agora.getHours() === (h.horaDeCorte ?? 0) &&
              agora.getMinutes() <= (h.minutosDeCorte ?? 0)))
        );
      }) ?? null;
    if (encontrado !== null) break;
    currentDia++;
    if (currentDia > 7) currentDia = 1;
    c++;
  }

  if (encontrado === null) return null;

  return new Date(
    agora.getFullYear(),
    agora.getMonth(),
    agora.getDate() + c + prazoDePostagem,
    encontrado.horaPostagem ?? 0,
    encontrado.minutosPostagem ?? 0,
  );
}
