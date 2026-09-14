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

// MOC version of the XSDs we validate against. Must stay in sync with
// the `src/types/nfe-schema.ts` shim and the `ACTIVE_MOC` constant in
// `src/codegen/generate.mjs`. The XSDs themselves live under
// `generated/moc${ACTIVE_MOC}/schemas/` — keeping them next to the
// types they generated lets old MOC versions coexist when SEFAZ
// ships a new one. See `CLAUDE.md` for the upgrade playbook.
const ACTIVE_MOC = '7.0';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The vendored XSD schema directory. Resolved lazily (read at first
 * `validateXsd`, not at import) and **overridable via `NFE_SCHEMA_DIR`** — a
 * consumer that esbuild-bundles this package into a single file (e.g.
 * `apps/nfe/functions`) loses the package's `generated/.../schemas/` dir layout
 * at runtime, so it ships the schemas alongside the bundle and points
 * `NFE_SCHEMA_DIR` at them. Mirrors `runtime.ts`'s `NFE_CA_DIR` for the TLS
 * chains. Unset → the in-repo vendored path.
 */
function schemaDir(): string {
  return (
    process.env.NFE_SCHEMA_DIR ?? join(HERE, '..', '..', 'generated', `moc${ACTIVE_MOC}`, 'schemas')
  );
}

/** Root XML name → XSD file that defines that root. */
const XSD_BY_ROOT = {
  // outbound
  enviNFe: 'enviNFe_v4.00.xsd',
  consReciNFe: 'consReciNFe_v4.00.xsd',
  consSitNFe: 'consSitNFe_v4.00.xsd',
  consStatServ: 'consStatServ_v4.00.xsd',
  inutNFe: 'inutNFe_v4.00.xsd',
  envEvento: 'envEvento_v1.00.xsd',
  // The generic envEvento has `<detEvento>` as xs:any (skip) — so detEvento's
  // inner structure is validated separately against the tpEvento-specific
  // schema before it's embedded + sent. Cancelamento (e110111) and CC-e
  // (e110110) both declare a root `<detEvento>`; they're registered under
  // distinct keys here because the codegen can only own one `detEvento` META
  // (cancelamento's) — see `src/codegen/generate.mjs`.
  detEvento: 'e110111_v1.00.xsd',
  detEventoCCe: 'e110110_v1.00.xsd',
  detEventoEpec: 'e110140_v1.00.xsd',
  NFe: 'nfe_v4.00.xsd',
  // inbound — validate what SEFAZ sends us too (catches captive-portal HTML,
  // proxy junk, parser drift)
  retEnviNFe: 'retEnviNFe_v4.00.xsd',
  retConsReciNFe: 'retConsReciNFe_v4.00.xsd',
  retConsSitNFe: 'retConsSitNFe_v4.00.xsd',
  retConsStatServ: 'retConsStatServ_v4.00.xsd',
  retInutNFe: 'retInutNFe_v4.00.xsd',
  retEnvEvento: 'retEnvEvento_v1.00.xsd',
  // archived bundles
  nfeProc: 'procNFe_v4.00.xsd',
  ProcInutNFe: 'procInutNFe_v4.00.xsd',
  procEventoNFe: 'procEventoNFe_v1.00.xsd',
} as const;

export type XsdRootKey = keyof typeof XSD_BY_ROOT;

export interface XsdError {
  readonly message: string;
  readonly line: number;
}

export class NFeXsdValidationError extends Error {
  constructor(
    public readonly rootKey: XsdRootKey | 'consCad' | 'retConsCad',
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
  const dir = schemaDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.xsd'));
  preloadCache = files.map((fileName) => ({
    fileName,
    contents: readFileSync(join(dir, fileName), 'utf8'),
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

// --- Consulta Cadastro (consCad / retConsCad v2.00) --------------------------
// The Consulta Cadastro schemas are layout v2.00, a separate pack from the v4.00
// MOC. They live in their OWN dir (`generated/conscad/`, NOT `moc7.0/schemas/`),
// which is also its own codegen pack: both leiautes declare a `TEndereco`, so
// they must never share a codegen run (`generated/conscad/README.md`, issue
// #251). Same `NFE_SCHEMA_DIR`-style override for esbuild-bundled consumers.
const CONSCAD_DIR = join(HERE, '..', '..', 'generated', 'conscad');

let consCadPreloadCache: ReadonlyArray<XMLFileInfo> | null = null;
function loadConsCadPreload(): ReadonlyArray<XMLFileInfo> {
  if (consCadPreloadCache) return consCadPreloadCache;
  const dir = process.env.NFE_CONSCAD_SCHEMA_DIR ?? CONSCAD_DIR;
  const files = readdirSync(dir).filter((f) => f.endsWith('.xsd'));
  consCadPreloadCache = files.map((fileName) => ({
    fileName,
    contents: readFileSync(join(dir, fileName), 'utf8'),
  }));
  return consCadPreloadCache;
}

/**
 * Validate a `consCad` (Consulta Cadastro request) against the v2.00 schema
 * **before** sending it to SEFAZ. Consulta Cadastro doesn't go through
 * `postSoapValidated` (layout 2.00 isn't in `XSD_BY_ROOT`), so this is its pre-send
 * gate — **mandatory**: repeated `cStat=215/225` schema rejections trip
 * `cStat=656` (Consumo Indevido) → throttling → CNPJ/certificate ban. Throws
 * `NFeXsdValidationError` (with line numbers) on failure; returns on success.
 */
export async function validateConsCad(xml: string): Promise<void> {
  await validateAgainstConsCadPack('consCad', 'consCad_v2.00.xsd', xml);
}

/**
 * Validate a `retConsCad` (Consulta Cadastro reply) against the v2.00 schema
 * **before** parsing it — the Consulta Cadastro counterpart of the response
 * check `postSoapValidated` runs for every v4.00 operation. It stops what the
 * parser would otherwise read as data: a captive-portal or proxy HTML page, a
 * truncated body, a reply missing a required field. The route answers a failure
 * with a 500, not the degraded 200 (#1602). Throws `NFeXsdValidationError`
 * (`rootKey: 'retConsCad'`) on failure; returns on success.
 */
export async function validateRetConsCad(xml: string): Promise<void> {
  await validateAgainstConsCadPack('retConsCad', 'retConsCad_v2.00.xsd', xml);
}

async function validateAgainstConsCadPack(
  rootKey: 'consCad' | 'retConsCad',
  rootFile: string,
  xml: string,
): Promise<void> {
  const preload = loadConsCadPreload();
  const schema = preload.find((f) => f.fileName === rootFile);
  if (!schema) {
    throw new NFeXsdValidationError(rootKey, [
      { message: `${rootKey} schema not found in vendored conscad/: ${rootFile}`, line: 0 },
    ]);
  }
  const result = await validateXML({
    xml: { fileName: `${rootKey}.xml`, contents: xml },
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
