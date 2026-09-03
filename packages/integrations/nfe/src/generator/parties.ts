/**
 * `infNFe.emit` (from Filial) and `infNFe.dest` (from Cliente + Endereco).
 *
 * Sanitisation is owned here — callers hand raw domain strings; the generator
 * is the SEFAZ-safety boundary. Homologação override of `dest.xNome` lives
 * here too (see `.claude/skills/nfe/references/homologacao.md`).
 */
import type { Cliente, Endereco, Filial } from '@delfrance/schemas';
import { IE_SENTINELA, TIPO_CLIENTE, normalizarIe } from '@delfrance/schemas';

import { sanitizeNFeEmail, sanitizeNFeText, temTextoCorrompido } from '../sanitize';
import type { TEnderEmi, TEndereco, TNFe_infNFe_dest, TNFe_infNFe_emit } from '../types/nfe-schema';
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

export function buildEmit(filial: Filial): TNFe_infNFe_emit {
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
  // rule E16a-30 made "destinatário isento de IE" a REJECTION (cStat=805) on an
  // internal operation (idDest=1) in 17 UFs — AL, AM, BA, CE, DF, ES, GO, MG,
  // MS, MT, PB, PE, RJ, RN, RS, SE and SP included. Our own homologação lane
  // caught it live. A cliente nobody ever filled an IE for would therefore be
  // emittable interstate but not in-state, which is a worse outcome than
  // defaulting the classification.
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
