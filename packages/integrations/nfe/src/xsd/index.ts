/**
 * XSD validation — the SEFAZ-ban kill switch.
 *
 * SEFAZ rejects schema-invalid requests with `cStat=215`/`225`. **Repeating
 * those rejections trips `cStat=656 Consumo Indevido`**, which leads to
 * throttling and ultimately a CNPJ / certificate ban. Every wire-bound XML
 * must pass through this module first, so the only way to learn about a
 * schema mistake is locally, not from SEFAZ.
 *
 * Uses `xmllint-wasm` (a WebAssembly port of libxml2 — the same validation
 * engine SEFAZ uses, but with zero native deps so the same code runs on
 * Windows, Linux, macOS and CI without a build toolchain).
 *
 * Server-only: ships a ~3MB WASM blob; never include from a client bundle.
 *
 * See `.claude/skills/nfe/references/cstat-rejeicoes.md` for the ban path,
 * and `.claude/skills/nfe/references/webservices.md` for SEFAZ's abuse rules.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateXML, type XMLFileInfo } from 'xmllint-wasm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, '..', '..', 'schemas');

/** Root XML name → XSD file that defines that root. */
const XSD_BY_ROOT = {
  // outbound
  enviNFe: 'enviNFe_v4.00.xsd',
  consReciNFe: 'consReciNFe_v4.00.xsd',
  consSitNFe: 'consSitNFe_v4.00.xsd',
  consStatServ: 'consStatServ_v4.00.xsd',
  inutNFe: 'inutNFe_v4.00.xsd',
  NFe: 'nfe_v4.00.xsd',
  // inbound — validate what SEFAZ sends us too (catches captive-portal HTML,
  // proxy junk, parser drift)
  retEnviNFe: 'retEnviNFe_v4.00.xsd',
  retConsReciNFe: 'retConsReciNFe_v4.00.xsd',
  retConsSitNFe: 'retConsSitNFe_v4.00.xsd',
  retConsStatServ: 'retConsStatServ_v4.00.xsd',
  retInutNFe: 'retInutNFe_v4.00.xsd',
  // archived bundles
  nfeProc: 'procNFe_v4.00.xsd',
  ProcInutNFe: 'procInutNFe_v4.00.xsd',
} as const;

export type XsdRootKey = keyof typeof XSD_BY_ROOT;

export interface XsdError {
  readonly message: string;
  readonly line: number;
}

export class NFeXsdValidationError extends Error {
  constructor(
    public readonly rootKey: XsdRootKey,
    public readonly errors: ReadonlyArray<XsdError>,
  ) {
    const first = errors[0]?.message ?? '(no detail)';
    const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
    super(`XSD validation failed for <${rootKey}>: ${first}${more}`);
    this.name = 'NFeXsdValidationError';
  }
}

/**
 * Lazy-load every XSD in `schemas/` once and cache as xmllint-wasm preload
 * entries. Required because the NF-e XSDs chain `xs:include` and
 * `xs:import` — xmllint needs every referenced file mounted in its
 * in-memory FS, even ones we don't directly target.
 */
let preloadCache: ReadonlyArray<XMLFileInfo> | null = null;
function loadPreload(): ReadonlyArray<XMLFileInfo> {
  if (preloadCache) return preloadCache;
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.xsd'));
  preloadCache = files.map((fileName) => ({
    fileName,
    contents: readFileSync(join(SCHEMA_DIR, fileName), 'utf8'),
  }));
  return preloadCache;
}

/**
 * Validate an XML document against the SEFAZ XSD for its root element.
 *
 * Throws `NFeXsdValidationError` with line numbers if invalid. Returns
 * silently on success.
 *
 * @example
 *   await validateXsd('consStatServ', consStatXml);
 *   await validateXsd('NFe', signedNfeXml);
 */
export async function validateXsd(rootKey: XsdRootKey, xml: string): Promise<void> {
  const schemaFile = XSD_BY_ROOT[rootKey];
  const preload = loadPreload();
  const schema = preload.find((f) => f.fileName === schemaFile);
  if (!schema) {
    throw new NFeXsdValidationError(rootKey, [
      { message: `XSD file not found in vendored schemas/: ${schemaFile}`, line: 0 },
    ]);
  }

  const result = await validateXML({
    xml: { fileName: 'doc.xml', contents: xml },
    schema: schema.contents as string,
    preload,
  });

  if (result.valid) return;
  const errors: XsdError[] = result.errors.map((e) => ({
    message: e.message,
    line: e.loc?.lineNumber ?? 0,
  }));
  throw new NFeXsdValidationError(rootKey, errors);
}

/** Test helper — list the roots wired to an XSD today. */
export function supportedRoots(): ReadonlyArray<XsdRootKey> {
  return Object.keys(XSD_BY_ROOT) as XsdRootKey[];
}
