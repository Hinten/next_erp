/**
 * The committed Amazon (SP-API) fixture corpus: the envelope every file in
 * `__wire__/` holds, and its reader.
 *
 * A fixture is an Amazon response (or an `ORDER_CHANGE` notification) that went
 * through the offline capture sanitizer (`scripts/sanitizar.ts`): the `fixture`
 * profile of `core/redacao.ts`, the keyed id faker (`sanitizacao/falsificacao.ts`)
 * and the two-layer scan (`piiScan.ts`). Nothing here calls Amazon (D11).
 *
 * ## Self-describing, so there is no manifest
 *
 * Each envelope carries its own (redacted) request, status, body policy and
 * form, credential, roles and capture date; a test reads the directory.
 *
 * - `credencial` is mandatory and closed: a fact proven under one credential is
 *   never assumed under another (`modelo-sandbox` is the models' own
 *   `x-amzn-api-sandbox` examples, never production).
 * - `papeis` records the roles the capture was made under: a capture without
 *   DTC and Tax Invoicing silently LACKS the buyer's PII, so a fixture that shows
 *   none proves nothing about a capture that would.
 * - `bytes` is the raw body's UTF-8 length.
 * - Never a host, a header, a file path, an alias or a time of day.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type LeituraResposta, lerRespostaJson } from '@delfrance/core/wire';
import { z } from 'zod';

import type { ValorJsonAmazon } from '../core/redacao';

/** The credential a capture declares (its sidecar's `credencial:` line). */
export const CREDENCIAIS_CAPTURA_AMAZON = [
  /** The owner's own curl with the legacy app's access token: GET only. */
  'token-legado-curl',
  /** Copied from the legacy app's own traffic or logs: mandatory for a write endpoint. */
  'copia-do-legado',
  /** A model's `x-amzn-api-sandbox` example (`amazon-doc.mjs exemplo`). */
  'modelo-sandbox',
  /** An example from Amazon's or AWS's documentation (the Pipe envelope). */
  'documentacao-aws',
] as const;
export type CredencialCapturaAmazon = (typeof CREDENCIAIS_CAPTURA_AMAZON)[number];

/** The credentials whose capture is a DOCUMENT, made under no seller's roles. */
export const CREDENCIAIS_DE_DOCUMENTACAO_AMAZON: ReadonlySet<CredencialCapturaAmazon> = new Set([
  'modelo-sandbox',
  'documentacao-aws',
]);

/**
 * The roles a capture was made under (`papeis:`). `nenhum` (a real capture under
 * no restricted role) and `nao-se-aplica` (a document) each stand alone.
 */
export const PAPEIS_CAPTURA_AMAZON = [
  'dtc',
  'tax-invoicing',
  'tax-remittance',
  'nenhum',
  'nao-se-aplica',
] as const;
export type PapelCapturaAmazon = (typeof PAPEIS_CAPTURA_AMAZON)[number];

/** Metadata only: nothing is ever sent. */
export const METODOS_CAPTURA_AMAZON = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export type MetodoCapturaAmazon = (typeof METODOS_CAPTURA_AMAZON)[number];

/** How an `ORDER_CHANGE` notification arrived: the raw SQS message body, or the Pipe's record. */
export const TRANSPORTES_NOTIFICACAO_AMAZON = ['sqs', 'pipe'] as const;
export type TransporteNotificacaoAmazon = (typeof TRANSPORTES_NOTIFICACAO_AMAZON)[number];

const ehObjetoSimples = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether `v` is a JSON value (what `JSON.parse` can return), bounded in depth.
 * A validator rather than a recursive Zod record ON PURPOSE: a Zod record COPIES
 * its keys into a new object, and an own `__proto__` key (which `JSON.parse`
 * creates and the redactor keeps) would vanish in the copy — the scan would then
 * read a different body than the one on disk.
 */
export function ehValorJson(v: unknown, profundidade = 0): v is ValorJsonAmazon {
  if (profundidade > 512) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => ehValorJson(x, profundidade + 1));
  if (ehObjetoSimples(v)) return Object.values(v).every((x) => ehValorJson(x, profundidade + 1));
  return false;
}

/** The request of an HTTP capture, after the path and query redactor. */
export interface RequisicaoHttpFixtureAmazon {
  readonly tipo: 'http';
  readonly metodo: MetodoCapturaAmazon;
  /** The redacted path; a trailing slash as captured. */
  readonly caminho: string;
  /** `[chave, valor]` after the redactor, in order, duplicates kept. */
  readonly query: readonly (readonly [string, string])[];
  /** The sanitized `<nome>.req.json`; `null` when there was none. */
  readonly corpo: ValorJsonAmazon;
}

/** An `ORDER_CHANGE` notification: no request, no host, no status. */
export interface RequisicaoNotificacaoFixtureAmazon {
  readonly tipo: 'notificacao';
  readonly notificacao: 'ORDER_CHANGE';
  readonly transporte: TransporteNotificacaoAmazon;
}

/** The envelope of one committed fixture. */
export interface EnvelopeFixtureAmazon {
  readonly versao: 1;
  readonly perfil: 'fixture';
  readonly credencial: CredencialCapturaAmazon;
  readonly papeis: readonly PapelCapturaAmazon[];
  /** `AAAA-MM-DD`, UTC. */
  readonly capturadoEm: string;
  /** The sidecar's `limite-taxa:` (the `x-amzn-RateLimit-Limit` seen), or `null`. */
  readonly limiteTaxa: number | null;
  readonly requisicao: RequisicaoHttpFixtureAmazon | RequisicaoNotificacaoFixtureAmazon;
  readonly resposta: {
    /** `null` for a notification. */
    readonly status: number | null;
    readonly politica: 'estrutural';
    readonly forma: 'json' | 'vazio';
    readonly bytes: number;
    /** The sanitized body; `null` for an empty one. */
    readonly corpo: ValorJsonAmazon;
  };
  readonly anexos: {
    /** The C3 label zip's LAYOUT (names shape-faked, sizes kept); never its content. */
    readonly zip: {
      readonly entradas: readonly { readonly nome: string; readonly bytes: number }[];
    } | null;
  };
}

const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;
const valorJson = z.custom<ValorJsonAmazon>((v) => ehValorJson(v));

export const envelopeFixtureAmazonSchema: z.ZodType<EnvelopeFixtureAmazon> = z
  .strictObject({
    versao: z.literal(1),
    perfil: z.literal('fixture'),
    credencial: z.enum(CREDENCIAIS_CAPTURA_AMAZON),
    papeis: z.array(z.enum(PAPEIS_CAPTURA_AMAZON)).min(1).readonly(),
    capturadoEm: z.string().regex(DATA_CIVIL),
    limiteTaxa: z.number().finite().nonnegative().nullable(),
    requisicao: z.discriminatedUnion('tipo', [
      z.strictObject({
        tipo: z.literal('http'),
        metodo: z.enum(METODOS_CAPTURA_AMAZON),
        caminho: z.string().startsWith('/'),
        query: z.array(z.tuple([z.string(), z.string()]).readonly()).readonly(),
        corpo: valorJson,
      }),
      z.strictObject({
        tipo: z.literal('notificacao'),
        notificacao: z.literal('ORDER_CHANGE'),
        transporte: z.enum(TRANSPORTES_NOTIFICACAO_AMAZON),
      }),
    ]),
    resposta: z.strictObject({
      status: z.number().int().min(100).max(599).nullable(),
      politica: z.literal('estrutural'),
      forma: z.enum(['json', 'vazio']),
      bytes: z.number().int().nonnegative(),
      corpo: valorJson,
    }),
    anexos: z.strictObject({
      zip: z
        .strictObject({
          entradas: z
            .array(
              z.strictObject({ nome: z.string().min(1), bytes: z.number().int().nonnegative() }),
            )
            .readonly(),
        })
        .nullable(),
    }),
  })
  // An HTTP capture has a status; a notification has none.
  .refine((e) => (e.requisicao.tipo === 'http') === (e.resposta.status !== null), {
    path: ['resposta', 'status'],
  });

/** `lib/amazon/fixtures/__wire__/`: where the sanitizer writes, and the only place. */
export const DIRETORIO_WIRE_AMAZON = fileURLToPath(new URL('./__wire__/', import.meta.url));

/** The provenance note that sits beside the fixtures; it is not one. */
export const LEIAME_WIRE_AMAZON = 'README.md';

/** Every file in `__wire__/` other than the README, sorted. */
export function listarArquivosDoCorpusAmazon(diretorio: string = DIRETORIO_WIRE_AMAZON): string[] {
  return readdirSync(diretorio)
    .filter((nome) => nome !== LEIAME_WIRE_AMAZON)
    .sort();
}

/**
 * A fixture's text, validated. ⚠️ Never serialise a failed result: its
 * `nao-json` arm carries the raw text.
 */
export function lerFixtureAmazon(texto: string): LeituraResposta<EnvelopeFixtureAmazon> {
  return lerRespostaJson(texto, envelopeFixtureAmazonSchema);
}

/** `JSON.stringify(v, null, 2) + '\n'`: the one serialisation every fixture uses. */
export function serializarFixtureAmazon(envelope: EnvelopeFixtureAmazon): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}
