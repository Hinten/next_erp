/**
 * Cliente find-or-create + endereço resolution for the Mercado Livre
 * order-import (Step 9). Ports:
 *
 *  - `BillingInfoResponse.toCliente`/`.toEndereco`/`.canMakeAdress`
 *    (`.old/packages/canais_de_venda/mercado_livre/lib/src/api_types/billing_info.dart:74-113`)
 *  - `MercadoLivreShipping.toEndereco`
 *    (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:5328-5338`)
 *  - `normalizePhoneNumber` / `_shouldUpdateName` / `Cliente.getOrCreateOrUpdate`
 *    (`.old/packages/clientes/lib/src/models.dart:63-129,254-419`)
 *  - `Endereco.generateUid`
 *    (`.old/packages/clientes/lib/src/models.dart:841-866`)
 *  - `UFS` / `UFS.fromValue` / `UFS.stateMap`
 *    (`.old/packages/global/lib/src/constantes.dart:97-245`)
 *
 * Pure mapping (`billingInfoToClienteFields`/`billingInfoToEnderecoFields`/
 * `shipmentToEnderecoFields`/`makeEnderecoId`) is separated from the IO layer
 * (`findOrCreateCliente`/`ensureEndereco`), mirroring `orderMapping.ts`.
 *
 * Deviations from the legacy source (see also the Step 9 task's "Approved
 * deviations" list):
 *  - `userPath` dedup + vector-embedding generation are both skipped (approved
 *    deviations #5/#2 — ML buyers carry no `userPath`, and `nome_embedding`/
 *    `telefone_embedding` are server-managed opaque fields in this schema).
 *  - Telefone is normalized with this repo's `normalizeTelefone`/
 *    `telefoneQueryShapes` (`@delfrance/core/phone`) instead of porting
 *    legacy's `dlibphonenumber`-based `normalizePhoneNumber` — the project's
 *    own canonical wire-format normalizer, already used for the identical
 *    purpose elsewhere (`apps/whatsapp/lib/whatsapp/discoverUser.ts`,
 *    `apps/web/lib/clientes/dedup.ts`).
 *  - The CNPJ branch of `toCliente()` strips punctuation with a MISTYPED Dart
 *    regex (`RegExp('r[.,-]')`, matching the literal characters "r." / "r,"
 *    / "r-" — not the intended punctuation class; effectively a no-op since
 *    ML's `identification.number` never contains an "r"). This port strips
 *    every non-alphanumeric character instead (matching the evident intent,
 *    like the CPF branch's digit-strip) — reproducing the typo would risk
 *    punctuation reaching `clienteSchema.cpf_cnpj` (`/^[0-9A-Z]*$/`) and
 *    throwing at write time instead of silently being a no-op like in Dart.
 *  - `ie` stores the CANONICAL `IE_SENTINELA.naoContribuinte` token
 *    (`NAO CONTRIBUINTE`, uppercase + unaccented) where legacy stored ML's raw
 *    `'Não contribuinte'` (billing_info.dart:105), and the comparison that
 *    picks it goes through `normalizarIe` instead of being exact. Legacy's
 *    exact match let one casing variant from ML fall through to a null
 *    `state_registration`, leaving the destinatário unclassified rather than
 *    marked não-contribuinte — the NF-e reader then has to default it. Dual-run
 *    safe: the
 *    Flutter NF-e reader normalizes before comparing
 *    (`pedido_nfe_base.dart:675`), so the canonical token matches it verbatim.
 *  - An unmappable (non-empty, unrecognized) `estado` name/code makes the
 *    whole endereço unbuildable (`null` return) instead of legacy's thrown
 *    `Exception` — consistent with the `canMakeAdress`-style "skip, don't
 *    crash the import" disposition this port already uses. A genuinely
 *    ABSENT estado still defaults to `AC`, matching `forceEndereco`'s
 *    null-branch (models.dart:925,953) exactly.
 *  - `numero`'s legacy fallback text ("NAO INFORMADO" / "Não informado", 13
 *    chars) does not fit `enderecoSchema.numero` (`max(10)`) — this port uses
 *    "S/N" (the standard Brazilian "sem número" shorthand) for BOTH the
 *    billing and shipment fallback paths instead. Every other field's
 *    fallback text is unchanged.
 *  - A shipment with no usable `postal_code` returns `null` (can't build a
 *    valid address) rather than legacy's 7-digit `'0000000'` filler, which
 *    would fail `enderecoSchema.cep`'s exact-8-digit regex anyway.
 */
import { createHash } from 'node:crypto';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { clienteCollection, enderecoCollection } from '@delfrance/data/admin/collections';
import { normalizeTelefone, telefoneQueryShapes } from '@delfrance/core/phone';
import {
  IE_SENTINELA,
  UF_SIGLA,
  TIPO_CLIENTE,
  normalizarIe,
  type Cliente,
  type TipoCliente,
  type UF,
  ufSchema,
} from '@delfrance/schemas';
import type { MlBillingInfo, MlShipment } from '@delfrance/integrations-mercado-livre';
import { isAlreadyExists } from '@delfrance/data/admin';

/* --------------------------------- errors ---------------------------------- */

/**
 * `identification.type` other than CPF/CNPJ (legacy `UnimplementedError`,
 * billing_info.dart:109-111). ML billing info in the wild is always one of
 * the two; anything else means an ML API shape this port doesn't understand.
 */
export class MlBillingInfoUnsupportedError extends Error {
  constructor(readonly identificationType: string | null) {
    super(`Tipo de identificação ${identificationType ?? '(ausente)'} não implementado`);
    this.name = 'MlBillingInfoUnsupportedError';
  }
}

/* ------------------------------- field shapes ------------------------------ */

/** Cliente fields resolvable from ML billing info — see `billingInfoToClienteFields`. */
export interface ClienteImportFields {
  tipo: TipoCliente;
  nome: string;
  cpf_cnpj: string | null;
  idEstrangeiro: string | null;
  ie: string | null;
  telefone: string | null;
  email: string | null;
}

/** Endereço fields mirroring `enderecoSchema` (`packages/schemas/src/endereco.ts`). */
export interface EnderecoImportFields {
  idExterno: string | null;
  cep: string;
  logradouro: string;
  numero: string;
  bairro: string;
  complemento: string | null;
  codigoMunicipio: string | null;
  cidade: string;
  estado: UF;
  cPais: string | null;
  pais: string | null;
  nome: string | null;
  cpf_cnpj: string | null;
  rg: string | null;
  ie: string | null;
  imun: string | null;
  email: string | null;
  telefone: string | null;
}

/* ------------------------------ small helpers ------------------------------ */

function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/** `null`/`undefined`/`''` all collapse to `null` — the schema's own "unset" shape. */
function nonEmpty(value: string | null | undefined): string | null {
  return value != null && value !== '' ? value : null;
}

/**
 * `forceEndereco`'s `cep.replaceAll(RegExp(r'\D'), '')` (models.dart:930) —
 * plus an 8-digit gate our `enderecoSchema.cep` regex demands: legacy's
 * exception-safe `forceEndereco` never threw on a bad CEP (it fell back), but
 * here a non-8-digit value would ZodError inside `ensureEndereco` and abort
 * the whole order import as if transient. Returning `null` lets the caller
 * skip the endereço (billing → shipment fallback → none), the same
 * degrade-not-abort disposition as the `canMakeAdress` guard.
 */
function sanitizeCep(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

const UF_CODES = new Set<string>(ufSchema.options);

/**
 * `UFS.stateMap` (`.old/packages/global/lib/src/constantes.dart:195-225`) —
 * accented, uppercase Portuguese state names → UF code. The corrupted
 * mojibake duplicate key in the Dart source (a `PARANÁ` encoding artifact) is
 * not reproduced — it carries no additional information over the correct key.
 */
const UF_NAME_MAP: Record<string, UF> = {
  'SÃO PAULO': 'SP',
  'RIO DE JANEIRO': 'RJ',
  'MINAS GERAIS': 'MG',
  'ESPÍRITO SANTO': 'ES',
  PARANÁ: 'PR',
  'RIO GRANDE DO SUL': 'RS',
  'SANTA CATARINA': 'SC',
  'MATO GROSSO DO SUL': 'MS',
  'MATO GROSSO': 'MT',
  GOIÁS: 'GO',
  'DISTRITO FEDERAL': 'DF',
  BAHIA: 'BA',
  CEARÁ: 'CE',
  PARÁ: 'PA',
  PERNAMBUCO: 'PE',
  TOCANTINS: 'TO',
  ALAGOAS: 'AL',
  AMAZONAS: 'AM',
  AMAPÁ: 'AP',
  MARANHÃO: 'MA',
  PIAUÍ: 'PI',
  'RIO GRANDE DO NORTE': 'RN',
  RONDÔNIA: 'RO',
  SERGIPE: 'SE',
  RORAIMA: 'RR',
  ACRE: 'AC',
  PARAÍBA: 'PB',
  EXTERIOR: 'EX',
};

/**
 * `UFS.fromValue` (constantes.dart:227-245), restricted to the string branch
 * (a UF is never passed in already-typed here). `raw == null` mirrors
 * `forceEndereco`'s `estado != null ? UFS.fromValue(estado) : UFS.AC` — see
 * this module's doc for the "present but unmappable" deviation.
 */
function resolveUf(raw: string | null): UF | null {
  if (raw == null) return UF_SIGLA.AC;
  const target = raw.trim().toUpperCase();
  const byName = UF_NAME_MAP[target];
  if (byName) return byName;
  if (UF_CODES.has(target)) return target as UF;
  return null;
}

/* ------------------------------ cliente mapping ----------------------------- */

/**
 * `BillingInfoResponse.toCliente` (billing_info.dart:93-113). Throws
 * {@link MlBillingInfoUnsupportedError} for any `identification.type` other
 * than CPF/CNPJ. `telefone`/`email`/`idEstrangeiro` are never set by this
 * mapping (legacy's `toCliente()` never sets them either) — they ride through
 * as `null` for `findOrCreateCliente`'s generic dedup surface.
 */
export function billingInfoToClienteFields(info: MlBillingInfo): ClienteImportFields {
  const billingInfo = info.buyer?.billing_info;
  const identification = billingInfo?.identification;
  const type = identification?.type?.toUpperCase() ?? null;
  const number = identification?.number ?? '';

  if (type === 'CPF') {
    const nome = `${billingInfo?.name ?? ''} ${billingInfo?.last_name ?? ''}`.trim();
    return {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome,
      cpf_cnpj: number.replace(/\D/g, '').trim(),
      idEstrangeiro: null,
      ie: null,
      telefone: null,
      email: null,
    };
  }

  if (type === 'CNPJ') {
    // ML's `taxpayer_type.description` is free-form prose, and the documented
    // MLB vocabulary is exactly "Contribuinte" / "Não contribuinte" (there is
    // no stable id to key off — the MLB examples carry `description` only).
    // Match it through `normalizarIe` so a casing or accent variant
    // (`NÃO CONTRIBUINTE`, `Nao contribuinte`) still resolves: an exact
    // comparison silently fell through to `state_registration`, which for a
    // não-contribuinte is null — leaving the destinatário with no fiscal
    // classification at all, for the NF-e reader to default.
    //
    // The stored value is the canonical IE_SENTINELA token, never ML's raw
    // phrasing, so it also matches the still-running Flutter reader verbatim.
    // A real `state_registration` is stored unchanged — the NF-e generator
    // strips it to digits at emission.
    const contribuinte = normalizarIe(billingInfo?.taxes?.taxpayer_type?.description);
    const ie =
      contribuinte === IE_SENTINELA.naoContribuinte
        ? IE_SENTINELA.naoContribuinte
        : (billingInfo?.taxes?.inscriptions?.state_registration ?? null);
    return {
      tipo: TIPO_CLIENTE.pessoaJuridica,
      nome: billingInfo?.name ?? '',
      // See this module's header doc — fixes legacy's mistyped strip regex.
      cpf_cnpj: number
        .replace(/[^0-9A-Za-z]/g, '')
        .toUpperCase()
        .trim(),
      idEstrangeiro: null,
      ie,
      telefone: null,
      email: null,
    };
  }

  throw new MlBillingInfoUnsupportedError(identification?.type ?? null);
}

/**
 * `BillingInfoResponse.canMakeAdress` + `.toEndereco()` (billing_info.dart:74-91).
 * `null` when the billing address has no zip code (`canMakeAdress` false) or
 * its state name/code doesn't resolve to a UF.
 */
export function billingInfoToEnderecoFields(info: MlBillingInfo): EnderecoImportFields | null {
  const address = info.buyer?.billing_info?.address;
  const zipCode = address?.zip_code ?? null;
  if (zipCode == null || zipCode === '') return null; // canMakeAdress guard.

  const estado = resolveUf(address?.state?.name ?? null);
  if (estado == null) return null;

  const cep = sanitizeCep(zipCode);
  if (cep == null) return null; // non-8-digit CEP → skip (see sanitizeCep doc).

  const countryId = address?.country_id ?? null;

  return {
    idExterno: null,
    cep,
    logradouro: nonEmpty(address?.street_name) ?? 'NAO INFORMADO',
    // See this module's header doc — legacy's fallback text overflows numero's max(10).
    numero: nonEmpty(address?.street_number) ?? 'S/N',
    bairro: nonEmpty(address?.neighborhood) ?? 'SEM BAIRRO',
    complemento: nonEmpty(address?.comment),
    codigoMunicipio: null,
    cidade: nonEmpty(address?.city_name) ?? 'NAO INFORMADA',
    estado,
    cPais: null,
    pais: countryId != null && countryId !== 'BR' ? countryId : null,
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
  };
}

/** Untyped `shipment.receiver_address` — see plugin `types.ts`'s `mlShipmentSchema` doc. */
interface MlShipmentReceiverAddress {
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: { name?: string | null } | null;
  city?: { name?: string | null } | null;
  state?: { name?: string | null } | null;
  postal_code?: string | null;
}

function receiverAddress(shipment: MlShipment): MlShipmentReceiverAddress | null {
  return (
    (shipment as unknown as { receiver_address?: MlShipmentReceiverAddress }).receiver_address ??
    null
  );
}

/**
 * `MercadoLivreShipping.toEndereco` (models.dart:5328-5338) — the fallback
 * source used only when `billingInfoToEnderecoFields` returns `null` but a
 * shipment exists. `null` when the shipment carries no `receiver_address`, no
 * usable `postal_code`, or an unmappable `estado`.
 */
export function shipmentToEnderecoFields(shipment: MlShipment): EnderecoImportFields | null {
  const addr = receiverAddress(shipment);
  if (addr == null) return null;

  const postalCode = addr.postal_code ?? null;
  if (postalCode == null || postalCode === '') return null;

  const estado = resolveUf(addr.state?.name ?? null);
  if (estado == null) return null;

  const cep = sanitizeCep(postalCode);
  if (cep == null) return null; // non-8-digit postal_code → skip (see sanitizeCep doc).

  const complementRaw = addr.complement ?? null;

  return {
    idExterno: null,
    cep,
    logradouro: nonEmpty(addr.street) ?? 'Não informado',
    // See this module's header doc — legacy's fallback text overflows numero's max(10).
    numero: nonEmpty(addr.number) ?? 'S/N',
    bairro: nonEmpty(addr.neighborhood?.name) ?? 'Não informado',
    // `receiver_address.complement?.substring(0, 30) ?? 'Não informado'` (models.dart:5332).
    complemento: complementRaw != null ? complementRaw.slice(0, 30) : 'Não informado',
    codigoMunicipio: null,
    cidade: nonEmpty(addr.city?.name) ?? 'NAO INFORMADA',
    estado,
    cPais: null,
    pais: null,
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
  };
}

/**
 * `Endereco.generateUid` (models.dart:841-866) — sha1 over the exact legacy
 * field concatenation order, nulls → `''`. `estado` uses the UF CODE (Dart's
 * `estado.value`, e.g. `'SP'`) — this schema already stores that code
 * directly, so `fields.estado` needs no further extraction.
 */
export function makeEnderecoId(fields: EnderecoImportFields): string {
  const parts = [
    'endereco',
    fields.idExterno ?? '',
    fields.logradouro,
    fields.numero,
    fields.complemento ?? '',
    fields.bairro,
    fields.cep,
    fields.codigoMunicipio ?? '',
    fields.cidade,
    fields.estado,
    fields.cPais ?? '',
    fields.pais ?? '',
    fields.nome ?? '',
    fields.cpf_cnpj ?? '',
    fields.rg ?? '',
    fields.ie ?? '',
    fields.imun ?? '',
    fields.email ?? '',
    fields.telefone ?? '',
  ];
  return sha1Hex(parts.join(''));
}

/* --------------------------------- cliente IO ------------------------------- */

interface ExistingCliente {
  id: string;
  data: Cliente;
}

async function findByEqual(
  db: Firestore,
  field: string,
  value: string,
): Promise<ExistingCliente | null> {
  const snap = await clienteCollection.ref(db, {}).where(field, '==', value).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return null;
  return {
    id: doc.id,
    data: clienteCollection.parseRead(doc.data(), clienteCollection.docPath({}, doc.id)),
  };
}

async function findByIn(
  db: Firestore,
  field: string,
  values: readonly string[],
): Promise<ExistingCliente | null> {
  if (values.length === 0) return null;
  const snap = await clienteCollection
    .ref(db, {})
    .where(field, 'in', [...values])
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (!doc) return null;
  return {
    id: doc.id,
    data: clienteCollection.parseRead(doc.data(), clienteCollection.docPath({}, doc.id)),
  };
}

/**
 * `_shouldUpdateName` (clientes/models.dart:117-129) — a lone-word new name
 * never overwrites an existing multi-word name (guards against a webhook
 * payload's truncated/first-name-only field clobbering a fuller one already
 * on file). Empty new name never updates either.
 */
function shouldUpdateName(oldName: string | null, newName: string): boolean {
  if (newName === '') return false;
  if (newName.split(' ').length === 1 && oldName != null && oldName.split(' ').length > 1) {
    return false;
  }
  return true;
}

/**
 * Update-only-changed patch (`Cliente.getOrCreateOrUpdate`'s hit branch,
 * clientes/models.dart:319-418, minus the `userPath`/embedding steps — see
 * this module's header doc). Empty result = no write needed.
 */
function buildUpdatePatch(
  old: Cliente,
  fields: ClienteImportFields,
  normalizedTelefone: string | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (shouldUpdateName(old.nome, fields.nome)) {
    patch.nome = fields.nome;
  }

  if (fields.cpf_cnpj != null && old.cpf_cnpj !== fields.cpf_cnpj) {
    patch.cpf_cnpj = fields.cpf_cnpj;
  }

  if (fields.idEstrangeiro != null && old.idEstrangeiro !== fields.idEstrangeiro) {
    patch.idEstrangeiro = fields.idEstrangeiro;
  }

  if (fields.telefone != null) {
    if (fields.telefone.includes('*')) {
      // Masked telefone (redacted digits) — never stored, matching legacy's log-only skip.
    } else if (normalizedTelefone != null && old.telefone !== normalizedTelefone) {
      patch.telefone = normalizedTelefone;
    }
  }

  if (fields.email != null && old.email !== fields.email) {
    patch.email = fields.email;
  }

  if (old.tipo !== fields.tipo) {
    patch.tipo = fields.tipo;
  }

  if (fields.ie != null && old.ie !== fields.ie) {
    patch.ie = fields.ie;
  }

  return patch;
}

/**
 * `Cliente.getOrCreateOrUpdate` (clientes/models.dart:254-419), `userPath`
 * dedup + vector-embedding generation dropped (see this module's header doc).
 * Dedup order: `cpf_cnpj` (digits-only equality) → `idEstrangeiro` → `telefone`
 * (`telefoneQueryShapes`, both wire shapes) → `email`. `nowMs` stamps
 * `timestamp`+`ultimaModificacao` on create, `ultimaModificacao` only on an
 * update that actually changes a field (mirrors `saveRecord`'s stamp, done by
 * hand here since this write bypasses the client SDK).
 */
export async function findOrCreateCliente(
  db: Firestore,
  fields: ClienteImportFields,
  nowMs: number,
): Promise<{ clienteId: string; created: boolean }> {
  // Dedup-query normalization only — the STORED field keeps the caller's
  // value. Legacy stripped to digits (clientes/models.dart:272), but our
  // clienteSchema accepts the ALPHANUMERIC CNPJ (`[0-9A-Z]*`) — a digits-only
  // strip would mangle those and query the wrong key, silently duplicating
  // the cliente. Use the repo-standard normalization instead (punctuation/
  // whitespace stripped, uppercased — same as apps/web/lib/clientes/dedup.ts).
  const cpfCnpjDigits =
    fields.cpf_cnpj != null ? fields.cpf_cnpj.replace(/[.\-/\s]/g, '').toUpperCase() : null;
  const normalizedTelefone = fields.telefone != null ? normalizeTelefone(fields.telefone) : null;

  let existing: ExistingCliente | null = null;
  if (cpfCnpjDigits) existing = await findByEqual(db, 'cpf_cnpj', cpfCnpjDigits);
  if (!existing && fields.idEstrangeiro) {
    existing = await findByEqual(db, 'idEstrangeiro', fields.idEstrangeiro);
  }
  // userPath dedup step intentionally skipped — see this module's header doc.
  if (!existing && fields.telefone) {
    const shapes = telefoneQueryShapes(fields.telefone);
    if (shapes.length > 0) existing = await findByIn(db, 'telefone', shapes);
  }
  if (!existing && fields.email) {
    existing = await findByEqual(db, 'email', fields.email);
  }

  if (existing) {
    const patch = buildUpdatePatch(existing.data, fields, normalizedTelefone);
    if (Object.keys(patch).length > 0) {
      await clienteCollection.merge(db, {}, existing.id, {
        ...patch,
        ultimaModificacao: nowMs,
      });
    }
    return { clienteId: existing.id, created: false };
  }

  const ref = await clienteCollection.add(
    db,
    {},
    {
      tipo: fields.tipo,
      nome: fields.nome !== '' ? fields.nome : null,
      cpf_cnpj: fields.cpf_cnpj,
      idEstrangeiro: fields.idEstrangeiro,
      ie: fields.ie,
      telefone: normalizedTelefone,
      email: fields.email,
      timestamp: nowMs,
      ultimaModificacao: nowMs,
    },
  );
  return { clienteId: ref.id, created: true };
}

/* -------------------------------- endereço IO -------------------------------- */

/**
 * Create-if-absent at the deterministic `makeEnderecoId` doc under
 * `clientes/{clienteId}/enderecos` (legacy's `.save(forceAdd: true,
 * docIdString: generateUid())`, tasks.dart:452-457/472-477). A concurrent
 * create racing to the same id is not an error — both converge on the same
 * doc (`isAlreadyExists`, gRPC ALREADY_EXISTS).
 */
export async function ensureEndereco(
  db: Firestore,
  clienteId: string,
  fields: EnderecoImportFields,
): Promise<string> {
  const id = makeEnderecoId(fields);
  const data = enderecoCollection.parse(fields) as DocumentData;
  try {
    await enderecoCollection.docRef(db, { clienteId }, id).create(data);
  } catch (err) {
    if (isAlreadyExists(err)) return id;
    throw err;
  }
  return id;
}
