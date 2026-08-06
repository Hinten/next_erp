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
 * The endereço force-fill itself is NOT here — it is
 * `buildEnderecoForcado`/`recoverEnderecoFromCep` in `@delfrance/schemas`
 * (#789), shared so the next marketplace channel does not re-derive it. The two
 * functions below are thin adapters: each pulls the eight raw values out of its
 * own ML payload shape and hands them over. They stay synchronous — the ViaCEP
 * recovery is IO and happens once, at their single call site in
 * `orderImport.ts`.
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
 *  - An unmappable (non-empty, unrecognized) `estado` name/code no longer
 *    discards the endereço. It yields `uf-desconhecida`, and the call site
 *    resolves the real UF from the CEP through ViaCEP — legacy's own recovery
 *    arm (`forceEndereco` caught the `UFS.fromValue` throw and rebuilt from
 *    `Endereco.buscarCEP`, models.dart:955-977), which the first cut of this
 *    port dropped. A genuinely ABSENT estado still defaults to `AC`, matching
 *    `forceEndereco`'s null-branch (models.dart:925,953) exactly.
 *  - `numero`'s legacy fallback text ("NAO INFORMADO" / "Não informado", 13
 *    chars) does not fit `enderecoSchema.numero` (`max(10)`) — the shared
 *    builder uses "S/N" (the standard Brazilian "sem número" shorthand). See
 *    `ENDERECO_FALLBACKS`.
 *  - The shipment path's fallback text is UNIFIED with the billing path's, i.e.
 *    with `forceEndereco`'s: legacy's `MercadoLivreShipping.toEndereco`
 *    pre-filled "Não informado" for logradouro/bairro/complemento before force
 *    ever saw them (models.dart:5328-5338), so force's own fallbacks never
 *    fired on that path. One text for one meaning is worth the divergence; the
 *    cost is that a shipment-sourced endereço hitting a fallback — and every
 *    one WITHOUT a complemento, now `null` instead of "Não informado" — hashes
 *    to a different `makeEnderecoId` than the still-running Flutter writer
 *    produces. `ensureEndereco` creates and never overwrites, so the effect is
 *    a duplicate document, never a lost one.
 *  - Every field is clamped to `NFE_ENDERECO_LIMITES` at import. `enderecoSchema`
 *    is looser than the NF-e `TEndereco` XSD in both directions, so an
 *    unclamped ML value could store fine and then fail the pre-send XSD gate
 *    (1-char `xLgr`/`xBairro`) or be silently truncated at emission (>60), which
 *    would mean the stored endereço is not the signed endereço.
 *  - A shipment with no usable `postal_code` returns `sem-cep` (can't build a
 *    valid address) rather than legacy's 7-digit `'0000000'` filler, which
 *    would fail `enderecoSchema.cep`'s exact-8-digit regex anyway. Unlike the
 *    first cut of this port, that outcome is now LOGGED at the call site rather
 *    than silently dropping the pedido's endereço.
 */
import { createHash } from 'node:crypto';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { clienteCollection, enderecoCollection } from '@delfrance/data/admin/collections';
import { normalizeTelefone, telefoneQueryShapes } from '@delfrance/core/phone';
import { z } from 'zod';
import {
  IE_SENTINELA,
  TIPO_CLIENTE,
  buildEnderecoForcado,
  normalizarIe,
  normalizeDocumento,
  type Cliente,
  type EnderecoBuildOutcome,
  type EnderecoForcado,
  type TipoCliente,
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

/**
 * Endereço fields mirroring `enderecoSchema`. The shared builder owns this
 * shape now (`EnderecoForcado`); the alias stays because `makeEnderecoId` and
 * `ensureEndereco` are named after it throughout this channel.
 */
export type EnderecoImportFields = EnderecoForcado;

/* ------------------------------ small helpers ------------------------------ */

function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
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
 * `BillingInfoResponse.canMakeAdress` + `.toEndereco()` (billing_info.dart:74-91),
 * as an adapter over the shared `buildEnderecoForcado`.
 *
 * The `canMakeAdress` guard is now folded into the builder's CEP-essential
 * rule: an absent `zip_code` and an unusable one are the same `sem-cep`
 * outcome, which is what the caller has to report either way.
 */
export function billingInfoToEnderecoFields(info: MlBillingInfo): EnderecoBuildOutcome {
  const address = info.buyer?.billing_info?.address;
  return buildEnderecoForcado({
    cepRaw: address?.zip_code,
    logradouro: address?.street_name,
    numero: address?.street_number,
    complemento: address?.comment,
    bairro: address?.neighborhood,
    cidade: address?.city_name,
    estadoRaw: address?.state?.name,
    paisId: address?.country_id,
  });
}

/**
 * `shipment.receiver_address` — untyped on `MlShipment` (see the plugin's
 * `mlShipmentSchema` doc), so it is PARSED rather than cast. The previous
 * `as unknown as {…}` asserted a shape nothing had checked, on a payload that
 * is not Zod-validated at the webhook either (#810).
 *
 * Leaf values stay `unknown` on purpose: the shared builder coerces scalars and
 * discards the rest, so this schema only has to describe the nesting.
 *
 * ⚠️ Every key is explicitly `.optional()`. In Zod 4 a bare `z.unknown()` does
 * NOT make its key optional, so a payload merely *missing* `complement` would
 * fail the whole object — and the recovery below would discard a perfectly good
 * address, turning a present CEP into `sem-cep`.
 */

/**
 * A `{ name }` holder — `neighborhood` / `city` / `state`.
 *
 * ML sometimes sends a bare string where the object belongs. That is "this
 * field was not supplied in the shape we understand", not a malformed payload,
 * so it is normalised to `null` BEFORE validation rather than recovered from a
 * parse failure afterwards. Normalising here also keeps the damage local: one
 * unusable `city` costs the city, not the whole endereço.
 */
const nomeado = z.preprocess(
  (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null),
  z.object({ name: z.unknown().optional() }).nullable(),
);

const receiverAddressObject = z.object({
  street: z.unknown().optional(),
  number: z.unknown().optional(),
  complement: z.unknown().optional(),
  neighborhood: nomeado,
  city: nomeado,
  state: nomeado,
  postal_code: z.unknown().optional(),
});

const receiverAddressSchema = receiverAddressObject.nullish();

type ReceiverAddress = z.infer<typeof receiverAddressObject>;

/**
 * Parse `shipment.receiver_address`, or conclude there is no address to read.
 *
 * **Why a `ZodError` becomes `null` rather than propagating.** Every key above
 * is optional and every leaf is `unknown`, so validation can now fail for
 * exactly one reason: `receiver_address` is not an object at all — a scalar, an
 * array. There is no address in that payload to recover, and `null` is the
 * honest answer: the caller reports `sem-cep`, which `applyEnderecoStep` logs
 * loudly with the order id. Nothing is swallowed silently.
 *
 * The narrowing is the point (CLAUDE.md rule 6). Anything that is NOT a
 * `ZodError` reaching this frame is a bug in this module, not a shape we
 * decided to tolerate, so it is rethrown and the order import fails as
 * transient — which is what a bug deserves.
 */
function parseReceiverAddress(raw: unknown): ReceiverAddress | null {
  try {
    return receiverAddressSchema.parse(raw) ?? null;
  } catch (err) {
    if (err instanceof z.ZodError) return null;
    throw err;
  }
}

/**
 * `MercadoLivreShipping.toEndereco` (models.dart:5328-5338) — the fallback
 * source used only when `billingInfoToEnderecoFields` yields no CEP but a
 * shipment exists.
 *
 * Legacy pre-filled "Não informado" for logradouro/bairro/complemento here,
 * which meant `forceEndereco`'s own fallbacks never fired on this path. This
 * adapter passes the raw values through and lets the shared fallbacks apply —
 * see the unified-fallback deviation in this module's header. The 30-char
 * complemento cut stays, because it is a property of the ML payload
 * (`complement?.substring(0, 30)`, models.dart:5332) rather than of the
 * endereço.
 */
export function shipmentToEnderecoFields(shipment: MlShipment): EnderecoBuildOutcome {
  const addr = parseReceiverAddress((shipment as { receiver_address?: unknown }).receiver_address);
  const complemento = typeof addr?.complement === 'string' ? addr.complement.slice(0, 30) : null;

  return buildEnderecoForcado({
    cepRaw: addr?.postal_code,
    logradouro: addr?.street,
    numero: addr?.number,
    complemento,
    bairro: addr?.neighborhood?.name,
    cidade: addr?.city?.name,
    estadoRaw: addr?.state?.name,
    paisId: null,
  });
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
  const cpfCnpjDigits = fields.cpf_cnpj != null ? normalizeDocumento(fields.cpf_cnpj) : null;
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
