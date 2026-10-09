/**
 * The committed Loja Integrada (LI) fixture corpus: the envelope every file in
 * `__wire__/` holds, and its reader.
 *
 * A fixture is a real LI response, captured by the store owner OUTSIDE every
 * repository checkout and converted offline by `scripts/sanitizar.ts` through the
 * `fixture` redaction profile (`core/redacao.ts`), the two-layer scan
 * (`piiScan.ts`) and the owner's local store-name list. Nothing here calls LI.
 *
 * ## Self-describing, so there is no manifest
 *
 * Each envelope carries its own request line (already redacted), status, body
 * class, body form, credential type and capture date. A test reads the
 * directory; there is no index file to keep in step with it.
 *
 * - `credencial` is mandatory: a fact proven under one credential is never
 *   assumed under another (`chave-api-aplicacao` is for legacy logs older than
 *   2026-10-07, `sessao-painel` for a capture the store's admin panel
 *   authenticated).
 * - `bytes` is the raw body's UTF-8 length: step 11 sizes restore snapshots
 *   with it.
 * - Never an alias, a time of day, a file path or a header.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type LeituraResposta, lerRespostaJson } from '@delfrance/core/wire';
import { z } from 'zod';

import type { ValorJsonLi } from '../core/redacao';

/** The credential types a capture may declare (its sidecar's `credencial:` line). */
export const CREDENCIAIS_CAPTURA_LI = [
  'personal-token',
  'personal-token-invalido',
  'chave-api-aplicacao',
  'sessao-painel',
] as const;
export type CredencialCapturaLi = (typeof CREDENCIAIS_CAPTURA_LI)[number];

/** Metadata only: nothing is ever sent. A PUT is a write echo copied from the legacy logs. */
export const METODOS_CAPTURA_LI = ['GET', 'PUT', 'POST', 'DELETE'] as const;
export type MetodoCapturaLi = (typeof METODOS_CAPTURA_LI)[number];

/** A capture's name, and so a fixture's file name without `.json`. */
export const NOME_DE_CAPTURA_LI = /^[a-z0-9-]{1,40}$/;

const ehObjetoSimples = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether `v` is a JSON value (what `JSON.parse` can return), bounded in depth.
 * A validator rather than a recursive Zod schema on purpose: a Zod record COPIES
 * its keys into a new object, and an own `__proto__` key (which `JSON.parse`
 * creates and the redactor keeps) would vanish in the copy — the scan would then
 * read a different body than the one on disk.
 */
function ehValorJson(v: unknown, profundidade = 0): v is ValorJsonLi {
  if (profundidade > 512) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => ehValorJson(x, profundidade + 1));
  if (ehObjetoSimples(v)) {
    return Object.values(v).every((x) => ehValorJson(x, profundidade + 1));
  }
  return false;
}

const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;

/** The envelope of one committed fixture. */
export interface EnvelopeFixtureLi {
  readonly versao: 1;
  readonly perfil: 'fixture';
  readonly credencial: CredencialCapturaLi;
  /** `AAAA-MM-DD`, UTC. */
  readonly capturadoEm: string;
  readonly requisicao: {
    readonly metodo: MetodoCapturaLi;
    /** The path after the path redactor; the trailing slash as captured. */
    readonly caminho: string;
    /** `[chave, valorBruto]`, in order, duplicates kept; a kept value is its raw substring. */
    readonly query: readonly (readonly [string, string])[];
  };
  readonly resposta: {
    readonly status: number;
    readonly politica: 'estrutural' | 'configuracao' | 'catalogo';
    readonly forma: 'json' | 'texto' | 'vazio';
    readonly bytes: number;
    /** The sanitized body; `null` for a body that is not JSON or is empty. */
    readonly corpo: ValorJsonLi;
  };
}

export const envelopeFixtureLiSchema: z.ZodType<EnvelopeFixtureLi> = z.strictObject({
  versao: z.literal(1),
  perfil: z.literal('fixture'),
  credencial: z.enum(CREDENCIAIS_CAPTURA_LI),
  capturadoEm: z.string().regex(DATA_CIVIL),
  requisicao: z.strictObject({
    metodo: z.enum(METODOS_CAPTURA_LI),
    caminho: z.string().startsWith('/'),
    query: z.array(z.tuple([z.string(), z.string()]).readonly()).readonly(),
  }),
  resposta: z.strictObject({
    status: z.number().int().min(100).max(599),
    politica: z.enum(['estrutural', 'configuracao', 'catalogo']),
    forma: z.enum(['json', 'texto', 'vazio']),
    bytes: z.number().int().nonnegative(),
    corpo: z.custom<ValorJsonLi>((v) => ehValorJson(v)),
  }),
});

/** `lib/lojaIntegrada/fixtures/__wire__/`: where the sanitizer writes, and the only place. */
export const DIRETORIO_WIRE_LI = fileURLToPath(new URL('./__wire__/', import.meta.url));

/** The provenance note that sits beside the fixtures; it is not one. */
export const LEIAME_WIRE_LI = 'README.md';

/** Every file in `__wire__/` other than the README, sorted. */
export function listarArquivosDoCorpusLi(diretorio: string = DIRETORIO_WIRE_LI): string[] {
  return readdirSync(diretorio)
    .filter((nome) => nome !== LEIAME_WIRE_LI)
    .sort();
}

/**
 * A fixture's text, validated. ⚠️ Never serialise a failed result: its
 * `nao-json` arm carries the raw text.
 */
export function lerFixtureLi(texto: string): LeituraResposta<EnvelopeFixtureLi> {
  return lerRespostaJson(texto, envelopeFixtureLiSchema);
}

/** `JSON.stringify(v, null, 2) + '\n'`: the one serialisation every fixture uses. */
export function serializarFixtureLi(envelope: EnvelopeFixtureLi): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}
