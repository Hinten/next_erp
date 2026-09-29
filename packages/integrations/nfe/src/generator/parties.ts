/**
 * `infNFe.emit` (from Filial), `infNFe.dest` (from Cliente + Endereco) and
 * `infNFe.entrega` (the delivery address, when it differs — #422).
 *
 * Sanitisation is owned here — callers hand raw domain strings; the generator
 * is the SEFAZ-safety boundary. Homologação override of `dest.xNome` lives
 * here too (see `.claude/skills/nfe/references/homologacao.md`).
 */
import { normalizeDocumento, validateCNPJ, validateCPF } from '@delfrance/core/documents';
import type { Cliente, Endereco, Filial } from '@delfrance/schemas';
import { IE_SENTINELA, ISUF_EMIT_REGEX, TIPO_CLIENTE, normalizarIe } from '@delfrance/schemas';

import { sanitizeNFeEmail, sanitizeNFeText, temTextoCorrompido } from '../sanitize';
import type {
  TEnderEmi,
  TEndereco,
  TLocal,
  TNFe_infNFe_dest,
  TNFe_infNFe_emit,
} from '../types/nfe-schema';
import { UF_TO_IBGE } from './tz';
import type { Ambiente } from './types';

export const HOMOLOGACAO_XNOME = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

/**
 * CRT default — Simples Nacional. Phase A's tribute engine is SN-only
 * (it builds CSOSN variants and throws on CRT=3/4 — see
 * `src/tribute/imposto.ts:75`), so the `<emit><CRT>` value MUST match
 * to keep the XML internally consistent. SEFAZ rejects with cStat=591
 * ("Informado CSOSN para emissor que não é do Simples Nacional") when
 * a CRT=3 emit contains a CSOSN item. Production target (DEL FRANCE)
 * is SN, so this is also the correct value for live emissions until
 * a per-Filial `crt` field lands (Phase D).
 */
const DEFAULT_CRT: TNFe_infNFe_emit['CRT'] = '1';

export class NFePartiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFePartiesError';
  }
}

/**
 * `emit`. `isufEmit` is `emit/ISUFEmit` (NT 2025.002 C22, #331) — the caller
 * passes it only with the Reforma Tributária on; absent, `emit` is unchanged.
 */
export function buildEmit(filial: Filial, isufEmit?: string): TNFe_infNFe_emit {
  if (isufEmit != null && !ISUF_EMIT_REGEX.test(isufEmit)) {
    throw new NFePartiesError(`emit/ISUFEmit must be 8 or 9 digits, got '${isufEmit}'`);
  }
  if (!filial.cnpj) throw new NFePartiesError('filial.cnpj is required');
  if (!filial.razaoSocial) throw new NFePartiesError('filial.razaoSocial is required');

  const enderEmit: TEnderEmi = {
    xLgr: requireSanitized('filial.sede.logradouro', filial.sede.logradouro, 60),
    // nro flows through the same sanitiser as the rest of endereço:
    // marketplace imports occasionally land decorative chars (`Nº`,
    // `[unid]`) in numero, and SEFAZ rejects them on emission.
    nro: requireSanitized('filial.sede.numero', filial.sede.numero, 60),
    xCpl: sanitizeOptional('filial.sede.complemento', filial.sede.complemento, 60),
    xBairro: requireSanitized('filial.sede.bairro', filial.sede.bairro, 60),
    cMun: requireCMun('filial.sede.codigoMunicipio', filial.sede.codigoMunicipio),
    xMun: requireSanitized('filial.sede.cidade', filial.sede.cidade, 60),
    UF: filial.sede.estado as TEnderEmi['UF'],
    CEP: filial.sede.cep,
    cPais: '1058',
    xPais: 'BRASIL',
  };

  return {
    CNPJ: filial.cnpj,
    xNome: requireSanitized('filial.razaoSocial', filial.razaoSocial, 60),
    xFant: sanitizeOptional('filial.fantasia', filial.fantasia, 60),
    enderEmit,
    IE: filial.ie,
    IEST: filial.iest ?? undefined,
    IM: filial.imun ?? undefined,
    CNAE: filial.cnae ?? undefined,
    CRT: DEFAULT_CRT,
    ...(isufEmit != null ? { ISUFEmit: isufEmit } : {}),
  };
}

/**
 * What `cliente.ie` actually holds, once normalized. The field is free text and
 * carries two sentinels alongside real inscrições estaduais — see
 * `IE_SENTINELA` in `@delfrance/schemas`. Comparison goes through
 * `normalizarIe`, so `Não contribuinte`, `NÃO CONTRIBUINTE` and
 * `nao  contribuinte` all land on the same token: the existing cliente base
 * holds years of hand-typed values and the cadastro screen still accepts free
 * text, so the reader cannot assume the stored value is canonical.
 */
type IeToken = 'ausente' | 'naoContribuinte' | 'isento' | 'numero';

function classifyIe(ie: string | null): IeToken {
  const normalized = normalizarIe(ie);
  if (normalized == null) return 'ausente';
  if (normalized === IE_SENTINELA.naoContribuinte) return 'naoContribuinte';
  if (normalized === IE_SENTINELA.isento) return 'isento';
  return 'numero';
}

/**
 * `dest.IE` is XSD type `TIeDestNaoIsento` — `[0-9]{2,14}`, DIGITS ONLY. The
 * stored value is hand-typed and routinely punctuated (`123.456.789.00`), so
 * strip to digits the way legacy did (`removerNaoAlfaNumericos`,
 * `.old/packages/nfe_client/lib/src/schemas/utils.dart:119`) — except legacy
 * kept spaces, which this XSD does not accept.
 *
 * A value with no usable digits throws rather than degrading: this is only ever
 * called on the `indIEDest='1'` branch, where SEFAZ *obliges* a valid IE.
 * Silently falling back to `'2'` would mis-declare the destinatário in a note
 * SEFAZ accepts — worse than one it rejects — and emitting the raw value just
 * moves the failure to the pre-send XSD gate with a far worse message.
 */
function requireIeDigits(ie: string | null): string {
  const digits = (ie ?? '').replace(/\D/g, '');
  if (!/^\d{2,14}$/.test(digits)) {
    throw new NFePartiesError(
      `cliente.ie='${ie ?? ''}' is not a valid inscrição estadual ` +
        `(expected 2 to 14 digits, got '${digits}'). Fix the cadastro, or set it to ` +
        `'${IE_SENTINELA.isento}' / '${IE_SENTINELA.naoContribuinte}'.`,
    );
  }
  return digits;
}

export function buildDest(
  cliente: Cliente,
  endereco: Endereco,
  ambiente: Ambiente,
  ehExterior: boolean,
): TNFe_infNFe_dest {
  // Checked on the REAL name, before the homologação override swaps it out — a
  // corrupted cadastro must surface in homologação too, which is exactly where
  // there is still time to fix it.
  requireIntegro('cliente.nome', cliente.nome);
  const xNomeReal = sanitizeNFeText(cliente.nome, 60) ?? '';
  const xNome = ambiente === 'homologacao' ? HOMOLOGACAO_XNOME : xNomeReal;

  // `indIEDest` ladder, ported from `.old/packages/pedido_nfe/lib/src/
  // pedido_nfe_base.dart:675-683,720`. First match wins:
  //
  //   ehExterior                          → '9'  (operação com o exterior)
  //   not pessoaJurídica (PF/estrangeiro)  → '9'  Não Contribuinte
  //   PJ, ie says "não contribuinte"       → '9'
  //   PJ, ie is ABSENT                     → '9'  (deviation — see below)
  //   PJ, ie says "isento"                 → '2'  Contribuinte isento de inscrição
  //   PJ, ie is anything else              → '1'  Contribuinte ICMS
  //
  // Deriving this from the mere TRUTHINESS of `cliente.ie` (as this did before)
  // reads the sentinels as real inscrições: a `'Não contribuinte'` cliente got
  // `indIEDest='1'`, which obliges a valid IE, and SEFAZ rejected the note.
  //
  // ⚠️ DEVIATION from the legacy ladder, decided by the owner: legacy maps an
  // ABSENT ie on a PJ to '2', and that value is barely emittable. NT 2025.001
  // (v1.03) rule E16a-30 made "destinatário isento de IE" a REJECTION
  // (cStat=805) on internal AND interstate operations (idDest=1 or 2) whenever
  // the DESTINATÁRIO's UF is one of 17 — AL, AM, BA, CE, DF, ES, GO, MG, MS, MT,
  // PB, PE, RJ, RN, RS, SE, SP — and rule E16a-35 lets any other UF reject it on
  // internal operations too; both exempt only a note with ICMS-ST on some item
  // or an isenta / imune / não tributada operation. Our own homologação lane
  // caught it live. A cliente nobody ever filled an IE for would therefore be
  // unemittable — in-state or interstate — whenever it sits in one of those UFs,
  // which is a worse outcome than defaulting the classification.
  //
  // So '2' is now reachable ONLY by an explicit `ISENTO` in the cadastro — it is
  // a claim the operator makes, never one inferred from a blank field. ⚠️ Legacy
  // note: the legacy reader mapped the same blank field to '2', so a MIGRATED
  // cliente with a blank `ie` is classified differently here than it was before
  // the cutover. That divergence was accepted (#787) — it is about how this app
  // reads inherited data, not two apps disagreeing at runtime.
  const ehPJ = cliente.tipo === TIPO_CLIENTE.pessoaJuridica;
  const ieToken = classifyIe(cliente.ie);
  const indIEDest: TNFe_infNFe_dest['indIEDest'] =
    ehExterior || !ehPJ || ieToken === 'naoContribuinte' || ieToken === 'ausente'
      ? '9'
      : ieToken === 'isento'
        ? '2'
        : '1';

  const dest: TNFe_infNFe_dest = {
    xNome: xNome.length > 0 ? xNome : undefined,
    indIEDest,
    enderDest: buildEnderDest(endereco),
    // Emitted ONLY for indIEDest='1' — that is what keeps a sentinel (or a
    // stray IE on a pessoa física) out of the signed XML.
    IE: indIEDest === '1' ? requireIeDigits(cliente.ie) : undefined,
    // Inscrição SUFRAMA. Obrigatória nas operações com as áreas de livre
    // comércio / Zona Franca sob controle da SUFRAMA (MOC, grupo E); omitting
    // it on such an operation forfeits the incentive on a note SEFAZ otherwise
    // ACCEPTS, so the loss is silent. `clienteSchema.isUF` is already
    // `[0-9]{8,9}` — exactly the XSD facet — so this needs no strip, unlike IE.
    //
    // Not to be confused with `ISUFEmit` (C22), the EMITTER's SUFRAMA
    // inscription, which belongs to the RTC/gALCZFMCBS work.
    ISUF: cliente.isUF ?? undefined,
    IM: cliente.imun ?? undefined,
    // Emails MUST keep `@` — sanitizeNFeText would strip it (the `@` is
    // in the restricted-char set for free-text descriptive fields).
    email: sanitizeNFeEmail(cliente.email) ?? undefined,
  };

  // Each tipo picks its own document field: pessoaFisica → CPF,
  // pessoaJuridica → CNPJ, estrangeiro → idEstrangeiro.
  if (cliente.tipo === TIPO_CLIENTE.pessoaJuridica && cliente.cpf_cnpj) {
    return { ...dest, CNPJ: cliente.cpf_cnpj };
  }
  if (cliente.tipo === TIPO_CLIENTE.pessoaFisica && cliente.cpf_cnpj) {
    return { ...dest, CPF: cliente.cpf_cnpj };
  }
  if (cliente.tipo === TIPO_CLIENTE.estrangeiro) {
    if (!cliente.idEstrangeiro) {
      throw new NFePartiesError('cliente.tipo=2 (Estrangeiro) requires idEstrangeiro');
    }
    return { ...dest, idEstrangeiro: cliente.idEstrangeiro };
  }
  throw new NFePartiesError(`cliente.tipo='${cliente.tipo}' missing cpf_cnpj / idEstrangeiro`);
}

function buildEnderDest(endereco: Endereco): TEndereco {
  return {
    xLgr: requireSanitized('endereco.logradouro', endereco.logradouro, 60),
    nro: requireSanitized('endereco.numero', endereco.numero, 60),
    xCpl: sanitizeOptional('endereco.complemento', endereco.complemento, 60),
    xBairro: requireSanitized('endereco.bairro', endereco.bairro, 60),
    cMun: requireCMun('endereco.codigoMunicipio', endereco.codigoMunicipio),
    xMun: requireSanitized('endereco.cidade', endereco.cidade, 60),
    UF: endereco.estado as TEndereco['UF'],
    CEP: endereco.cep,
    cPais: endereco.cPais ?? '1058',
    xPais: sanitizeOptional('endereco.pais', endereco.pais, 60) ?? 'BRASIL',
  };
}

/**
 * `infNFe.entrega` — Grupo G, "Identificação do Local de Entrega" (`TLocal`),
 * for a delivery address that is a different document from the fiscal one
 * (#422). The caller decides "different"; this only builds the group.
 *
 * Why it must exist at all: once the delivery UF decides `idDest`
 * (`ufDestinoOperacao`), a SP-registered buyer receiving in RJ gets `idDest=2`
 * with `enderDest/UF = SP` — rejected with 772 unless `entrega/UF` differs from
 * the emitente's (MOC 7.0 E12-30 exceptions), and 523/773 carry the same
 * exception. Legacy never emitted this group and relied on luck.
 *
 * Identity (the XSD's CNPJ|CPF choice is MANDATORY): the endereço's own
 * recebedor fields when a document is filled in, else the pedido's cliente.
 * Name and document always come from the SAME source — a recebedor's CPF next
 * to the cliente's name would describe nobody. A filled-in recebedor document
 * that does not validate throws instead of falling back: the operator typed
 * it, and silently replacing it with the cliente's would sign a different
 * recebedor than the one on the cadastro.
 *
 * Deliberately minimal: no `fone`/`email`/`IE`/`cPais`/`xPais` — each is one
 * more rejection surface, and none is required for a Brazilian delivery. The
 * name is the REAL one even in homologação: the fictitious-name rule (598) is
 * `dest/xNome` only.
 */
export function buildEntrega(cliente: Cliente, endereco: Endereco): TLocal {
  const cMun = requireCMun('entrega.codigoMunicipio', endereco.codigoMunicipio);
  // Rule 279: cMun must belong to the UF. A mismatch here is a cadastro whose
  // CEP was resolved to another state's município — refuse it with the values.
  const cUF = UF_TO_IBGE[endereco.estado];
  if (!cMun.startsWith(cUF)) {
    throw new NFePartiesError(
      `entrega.codigoMunicipio='${cMun}' is not a município of UF '${endereco.estado}' ` +
        `(IBGE codes there start with '${cUF}'). Fix the delivery address.`,
    );
  }
  const cep = (endereco.cep ?? '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(cep)) {
    throw new NFePartiesError(
      `entrega.cep=${JSON.stringify(endereco.cep ?? null)} must have 8 digits`,
    );
  }
  return {
    ...recebedorDaEntrega(cliente, endereco),
    xLgr: requireSanitizedMin2('entrega.logradouro', endereco.logradouro),
    nro: requireSanitized('entrega.numero', endereco.numero, 60),
    xCpl: sanitizeOptional('entrega.complemento', endereco.complemento, 60),
    xBairro: requireSanitizedMin2('entrega.bairro', endereco.bairro),
    cMun,
    xMun: requireSanitizedMin2('entrega.cidade', endereco.cidade),
    UF: endereco.estado as TLocal['UF'],
    CEP: cep,
  };
}

type RecebedorDaEntrega = Pick<TLocal, 'CNPJ' | 'CPF' | 'xNome'>;

function recebedorDaEntrega(cliente: Cliente, endereco: Endereco): RecebedorDaEntrega {
  const docRecebedor = normalizeDocumento(endereco.cpf_cnpj ?? '');
  if (docRecebedor.length > 0) {
    requireIntegro('entrega.nome', endereco.nome);
    const nome = sanitizeNFeText(endereco.nome, 60);
    return {
      ...documentoValido('entrega.cpf_cnpj (recebedor)', docRecebedor),
      // xNome is optional in TLocal but 2–60 when present: a blank or
      // one-character recebedor name is omitted, never replaced by the cliente's.
      ...(nome && nome.length >= 2 ? { xNome: nome } : {}),
    };
  }

  const docCliente = normalizeDocumento(cliente.cpf_cnpj ?? '');
  if (
    docCliente.length === 0 ||
    (cliente.tipo !== TIPO_CLIENTE.pessoaFisica && cliente.tipo !== TIPO_CLIENTE.pessoaJuridica)
  ) {
    throw new NFePartiesError(
      `the delivery address needs an identified recebedor (CPF or CNPJ) and the cliente has ` +
        `none to fall back on (tipo='${cliente.tipo}'). Fill in "Recebedor (NF-e)" on the ` +
        `delivery address.`,
    );
  }
  requireIntegro('cliente.nome', cliente.nome);
  const nome = sanitizeNFeText(cliente.nome, 60);
  return {
    ...documentoValido('cliente.cpf_cnpj', docCliente),
    ...(nome && nome.length >= 2 ? { xNome: nome } : {}),
  };
}

/**
 * A normalized CPF (11 digits) or CNPJ (14, alphanumeric body allowed) with a
 * valid check digit, as the matching TLocal field — anything else throws.
 * Length picks the field; the check digit keeps a typo out of a signed nota
 * (optional-per-UF rules 514/541 would otherwise catch it only in some UFs).
 */
function documentoValido(name: string, doc: string): Pick<TLocal, 'CNPJ' | 'CPF'> {
  if (doc.length === 11 && validateCPF(doc)) return { CPF: doc };
  if (doc.length === 14 && validateCNPJ(doc)) return { CNPJ: doc };
  throw new NFePartiesError(`${name}='${doc}' is not a valid CPF or CNPJ`);
}

/**
 * {@link requireSanitized} plus the 2-character minimum TLocal puts on
 * `xLgr`/`xBairro`/`xMun`. Without it a one-letter value passes here and dies
 * at the pre-send XSD gate with a message that names no field.
 */
function requireSanitizedMin2(name: string, value: string | null | undefined): string {
  const cleaned = requireSanitized(name, value, 60);
  if (cleaned.length < 2) {
    throw new NFePartiesError(`${name}=${JSON.stringify(cleaned)} must have at least 2 characters`);
  }
  return cleaned;
}

/**
 * `cMun` — the 7-digit IBGE município code.
 *
 * Deliberately stricter than a bare `== null` rejection.
 * `enderecoSchema.codigoMunicipio` is `z.string().max(8).regex(/^\d*$/)`, so an
 * empty string is perfectly storable — and it used to sail through here and
 * emit `<cMun></cMun>`, a malformed XML rejected by SEFAZ with no hint of which
 * field was to blame. `ide.ts`'s `cMunFG` check already used a falsy test, so
 * the two disagreed. Name the field and show what arrived (#785).
 *
 * This package stays synchronous and network-free: resolution belongs to
 * `apps/nfe/lib/nfe/orchestrator/cmun.ts`, which fills the value in before the
 * generator ever sees it.
 */
function requireCMun(name: string, value: string | null | undefined): string {
  if (!value || !/^\d{7}$/.test(value)) {
    throw new NFePartiesError(
      `${name} must be the 7-digit IBGE município code (got ${JSON.stringify(value ?? null)})`,
    );
  }
  return value;
}

/**
 * Reject a value whose encoding was lost somewhere upstream, BEFORE the
 * sanitiser can launder it into plausible ASCII.
 *
 * The legacy Flutter app mis-decoded some UTF-8 responses as latin1 and wrote the
 * result to Firestore, where it still sits (issue #788). Sanitisation turns that
 * into pure, non-blank, in-length ASCII — the mojibake `São Paulo` becomes
 * `SAo Paulo`, a U+FFFD-bearing one becomes `So Paulo` — so every downstream gate
 * passes and a wrong address is signed, authorised by SEFAZ and printed on the
 * DANFE at the buyer's door. Fixing it after authorisation needs a CC-e or a
 * cancelamento, which is why this fails loudly here instead.
 *
 * Repair is deliberately not attempted: U+FFFD is unrecoverable by definition,
 * and guessing at the digraph form would put a *guess* in a fiscal document.
 *
 * The offending value is `JSON.stringify`'d, matching {@link requireCMun}: a
 * latin1 mis-decode routinely carries C1 control characters (U+0080..U+009F),
 * which would otherwise go into the message unprintable and break structured
 * log parsing. Escaped, the message names the exact bad codepoints.
 */
function requireIntegro(name: string, value: string | null | undefined): void {
  if (temTextoCorrompido(value)) {
    throw new NFePartiesError(
      `${name}=${JSON.stringify(value)} has corrupted text (a lost character-encoding ` +
        `round-trip). Fix the cadastro — emitting it would sign a wrong value.`,
    );
  }
}

function requireSanitized(name: string, value: string | null | undefined, maxLen?: number): string {
  requireIntegro(name, value);
  const cleaned = sanitizeNFeText(value, maxLen);
  if (!cleaned) throw new NFePartiesError(`${name} is required (got blank after sanitize)`);
  return cleaned;
}

/**
 * {@link requireSanitized} for an OPTIONAL tag — blank stays `undefined` (the tag
 * is omitted) but corrupted text still throws. An optional field is no safer than
 * a required one: `xCpl` is printed on the DANFE like the rest of the address.
 */
function sanitizeOptional(
  name: string,
  value: string | null | undefined,
  maxLen?: number,
): string | undefined {
  requireIntegro(name, value);
  return sanitizeNFeText(value, maxLen) ?? undefined;
}
