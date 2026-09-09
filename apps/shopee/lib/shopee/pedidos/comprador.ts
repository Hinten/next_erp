/**
 * Shopee's buyer block → the ERP's cliente/endereço inputs, plus the capture
 * diary that records what a masked delivery refused.
 *
 * ## The rule this module implements
 *
 * Shopee redacts buyer data outside an "unmask window" and the redaction is
 * IN PLACE: `name` and `phone` came back as `"****"` on a sandbox order whose
 * `full_address` and `zipcode` were clear in the same object. So masking is
 * per FIELD, every truthiness check passes, and the only safe reading is the
 * shared predicate in `@delfrance/schemas` (`valorMascarado.ts`). Nothing here
 * re-implements it.
 *
 * The capture rule, in four lines:
 *
 *  - a masked or absent value is written NOWHERE — not partially, not as a
 *    placeholder, not "for an operator to fix";
 *  - fill-once per FIELD, so a later unmasked delivery can still complete what
 *    an earlier masked one could not;
 *  - a refusal is recorded as a field NAME plus a verdict, never as a value;
 *  - once the order leaves the window with nothing captured, the record says
 *    `expirado` and no further attempt is made — an operator's queue, not an
 *    infinite retry.
 *
 * ## ⚠️ Three things that look like fallbacks and are not
 *
 *  - **`buyer_username` is NEVER a name.** It is a buyer-chosen handle. It is
 *    requested only so the wire fixture records whether Shopee masks it.
 *  - **The telefone is never stored, masked or clear.** {@link clienteDeShopee}
 *    returns `telefone: null` explicitly, and `sanitizeTelefone` is not imported
 *    here on purpose: there is no path that could store one.
 *  - **A non-BR order captures nothing at all.** `buyer_cpf_id` is documented
 *    "Only for Brazil" and the detail carries no foreign document, so
 *    `TIPO_CLIENTE.estrangeiro` would have nothing to key on — `idEstrangeiro`
 *    null, every strong leg of `findOrCreateCliente`'s cascade skipped, and the
 *    blind create minting one junk cliente per import. The pedido's
 *    `bloquearEmissaoNFe` carries the fact instead.
 *
 * ## ⚠️ The region read is the ORDER-level one
 *
 * `recipient_address.region` is inside exactly the block masking hides, and an
 * unnamed optional field comes back ABSENT rather than empty — so
 * `undefined !== 'BR'` would mark every masked BR order foreign. The order-level
 * `region` is one of the eleven fields `get_order_detail` returns by DEFAULT and
 * is never masking-gated. That is the one this module reads, and the one the
 * caller must pass to {@link enderecoDeShopee}.
 *
 * ## ⚠️ No Shopee buyer-id identity key
 *
 * `CLIENTE_MATCH_KEY` gains nothing here. `buyer_user_id` sits in the
 * masking-gated optional set — a strong identity key that is absent exactly
 * when identity matters is not a key — and CPF is the identity the NF-e is
 * emitted against. Step 16 (chat) may revisit it with its own evidence: a
 * pre-sale question carries no CPF, which is what earned `idMercadoLivre` its
 * place.
 *
 * Pure: no Firestore, no wire calls, no clock. The IO — `findOrCreateCliente`,
 * `ensureEndereco`, the ViaCEP recovery on `uf-desconhecida` — is the importer's
 * (step 5's write path), which also owns the fill-once transaction guards.
 */

import {
  TIPO_CLIENTE,
  buildEnderecoForcado,
  cpfCnpjUtilizavel,
  motivoDaRecusa,
  nomeUtilizavel,
  valorUtilizavel,
  type ClienteResolveFields,
  type EnderecoBuildOutcome,
  type MotivoRecusa,
  TIPO_DE_VALOR,
} from '@delfrance/schemas';

/* --------------------------------- inputs ---------------------------------- */

/**
 * The `recipient_address` fields this module reads.
 *
 * ⚠️ Declared STRUCTURALLY rather than imported from
 * `@delfrance/integrations-shopee`. Two reasons, and the second is the one that
 * matters: the wire schema is being built in parallel with this file, and this
 * module has no business depending on Shopee's full row shape when it reads ten
 * strings from it. The parsed row satisfies this type structurally.
 */
export interface EnderecoShopee {
  readonly name: string | null;
  readonly phone: string | null;
  readonly town: string | null;
  readonly district: string | null;
  readonly city: string | null;
  readonly state: string | null;
  /** ⚠️ Masking-gated. Use the ORDER-level region — see the module header. */
  readonly region: string | null;
  readonly zipcode: string | null;
  readonly full_address: string | null;
}

/** The `get_order_detail` fields this module reads. Structural, see {@link EnderecoShopee}. */
export interface DetalheCompradorShopee {
  /** ORDER-level region — returned by default, never masking-gated. */
  readonly region: string | null;
  readonly order_status: string;
  /** "Only for Brazil". Masked outside the unmask window. */
  readonly buyer_cpf_id: string | null;
  readonly recipient_address: EnderecoShopee | null;
}

/* --------------------------------- vocabulary ------------------------------- */

/** The region code that makes an order fiscally Brazilian. */
export const REGIAO_BR = 'BR';

/** Where the buyer capture stands for one pedido. */
export type CapturaCompradorEstado = 'pendente' | 'capturado' | 'expirado';

/**
 * Named members of {@link CapturaCompradorEstado}.
 *
 * ⚠️ A DIARY, never a GUARD. The capture decision is re-derived from the fresh
 * wire payload on every delivery; nothing may branch on the stored estado. Any
 * later step that wants to gate on it must first move the field into
 * `serverOwnedFields` and pay the ruleset regeneration.
 */
export const CAPTURA_COMPRADOR_ESTADO = {
  /** Nothing captured yet, and the window may still open. */
  pendente: 'pendente',
  /** Name and document captured. */
  capturado: 'capturado',
  /** The window closed (or never existed) with nothing captured. */
  expirado: 'expirado',
} as const satisfies Record<string, CapturaCompradorEstado>;

/**
 * The order statuses at which the unmask window is over.
 *
 * Shopee's three masking guides (382 / 743 / 290) disagree about which states
 * unmask, and all three agree the window is BOUNDED — so this set is the
 * pessimistic reading of "past this point, waiting achieves nothing".
 *
 * ⚠️ `TO_RETURN` is in the list even though guide 290 calls it an UNMASK state:
 * an order that reached a return with no buyer captured is one an operator has
 * to handle by hand anyway, and step 5 keeps the estado and flags it rather than
 * driving it.
 */
export const STATUS_SHOPEE_FORA_DA_JANELA: readonly string[] = [
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
  'TO_RETURN',
];

/**
 * The field names a refusal may name. NAMES only — a `camposRecusados` entry is
 * `<campo>:<verdito>` and carries no value, no length and no prefix.
 */
export const CAMPO_CAPTURA = {
  nome: 'nome',
  cpfCnpj: 'cpf_cnpj',
  regiao: 'regiao',
} as const satisfies Record<string, string>;

/**
 * The verdict for a non-Brazilian order.
 *
 * Deliberately NOT one of {@link MotivoRecusa}'s three: the buyer data was
 * neither absent, nor masked, nor invalid — the field does not exist for this
 * order and never will. Folding it into `ausente` would read as "wait for the
 * next delivery", which is exactly wrong.
 */
export const MOTIVO_NAO_BR = 'nao-br';

/* --------------------------------- cliente ---------------------------------- */

/**
 * The buyer's fiscal identity, or `null`.
 *
 * `null` unless BOTH the name and the document pass. One of the two is not a
 * partial capture: `findOrCreateCliente` has no strong key to match a
 * name-without-document on, so it would `add` blind — and the next delivery
 * would add again, one junk cliente per push.
 *
 * ⚠️ The name is `recipient_address.name`. Shopee's detail carries no buyer
 * LEGAL name at all; for a BR order Shopee requires the recipient's CPF, so
 * recipient and buyer coincide except on a gift order.
 *
 * ⚠️ `tipo` comes from the document's LENGTH, never asserted as pessoaFísica: a
 * BR Shopee buyer can be a company, and storing tipo `'0'` beside a CNPJ reds
 * the cliente form the moment an operator opens it
 * (`refineClienteTipoDocumento`).
 */
export function clienteDeShopee(detalhe: DetalheCompradorShopee): ClienteResolveFields | null {
  if (detalhe.region !== REGIAO_BR) return null;

  const nome = nomeUtilizavel(detalhe.recipient_address?.name);
  const documento = cpfCnpjUtilizavel(detalhe.buyer_cpf_id);
  if (nome === null || documento === null) return null;

  return {
    tipo: documento.length === 11 ? TIPO_CLIENTE.pessoaFisica : TIPO_CLIENTE.pessoaJuridica,
    nome,
    cpf_cnpj: documento,
    idEstrangeiro: null,
    ie: null,
    // ⚠️ Explicit, and the assertion is the point: there is no phone to store.
    // A masked one would fail `clienteSchema.telefone`'s refine inside the
    // write; a clear one is buyer data this ERP has no use for.
    telefone: null,
    // Shopee's order detail carries no e-mail.
    email: null,
    // `idMercadoLivre` deliberately OMITTED: the key means "no evidence", and
    // writing `null` would assert we looked.
  };
}

/* --------------------------------- endereço --------------------------------- */

/**
 * The shipping address as {@link buildEnderecoForcado}'s outcome, or `null` when
 * the block is masked or incomplete.
 *
 * `null` unless the name, the `full_address` and the `zipcode` all pass — the
 * name because the endereço row carries it (and feeds the content-addressed
 * endereço id), the other two because an address without a street or a CEP is
 * not an address.
 *
 * ⚠️ `full_address` goes in WHOLE as `logradouro` (trimmed, nothing else).
 * **Never re-split it on `', '`**: the legacy did, assumed four parts, and
 * mis-assigned every three- and five-part address — while `district`, `town`
 * and `zipcode` already arrive in their own fields, so a split recovers
 * nothing it does not also corrupt.
 *
 * `numero` is passed `null` on purpose: Shopee has no street-number field and
 * `full_address` already contains it, so the builder fills
 * `ENDERECO_FALLBACKS.numero` (`'S/N'`).
 *
 * The `sem-cep` and `uf-desconhecida` outcomes are RETURNED, not swallowed —
 * `uf-desconhecida` carries a complete, storable endereço whose UF the caller
 * recovers from the CEP (`recoverEnderecoFromCep`), exactly as the Mercado
 * Livre importer does.
 *
 * @param regiao the ORDER-level `region` (see the module header), used as
 *               `paisId`; the builder stores `'BR'` as `null`.
 */
export function enderecoDeShopee(
  addr: EnderecoShopee | null,
  regiao: string | null,
): EnderecoBuildOutcome | null {
  if (addr == null) return null;

  const nome = nomeUtilizavel(addr.name);
  const logradouro = valorUtilizavel(addr.full_address);
  const cep = valorUtilizavel(addr.zipcode);
  if (nome === null || logradouro === null || cep === null) return null;

  return buildEnderecoForcado({
    cepRaw: cep,
    logradouro,
    numero: null,
    complemento: null,
    // `district` is the finer of the two; `town` is the coarser fallback. Both
    // are legitimately empty by region, and both can be masked — hence the
    // predicate on each rather than a `??` on the raw values.
    bairro: valorUtilizavel(addr.district) ?? valorUtilizavel(addr.town),
    cidade: valorUtilizavel(addr.city),
    estadoRaw: valorUtilizavel(addr.state),
    paisId: regiao,
  });
}

/* --------------------------------- diary ------------------------------------ */

/** What {@link avaliarCapturaComprador} concluded. */
export interface CapturaComprador {
  readonly estado: CapturaCompradorEstado;
  /**
   * `<campo>:<verdito>` entries — e.g. `'nome:mascarado'`, `'cpf_cnpj:invalido'`,
   * `'regiao:nao-br'`. **Field NAMES and verdicts only.** Empty when the capture
   * succeeded.
   */
  readonly camposRecusados: readonly string[];
}

function recusa(campo: string, motivo: MotivoRecusa | typeof MOTIVO_NAO_BR): string {
  return `${campo}:${motivo}`;
}

/**
 * The capture diary for one delivery: what was captured, and — when it was not —
 * which fields refused and why.
 *
 * @param statusObservado the order status from the RE-FETCHED detail. Step 5
 *        never trusts the push body, so the caller passes
 *        `detalhe.order_status`; the parameter exists so the window decision is
 *        visible at the call site rather than buried here.
 *
 * Three outcomes:
 *
 *  - **`capturado`** — name and document both usable.
 *  - **`expirado`** — nothing captured and nothing left to wait for: either the
 *    status already left the unmask window, or the order is not Brazilian and
 *    therefore has no document to unmask in the first place.
 *  - **`pendente`** — nothing captured, but a later delivery may still carry it.
 */
export function avaliarCapturaComprador(args: {
  detail: DetalheCompradorShopee;
  statusObservado: string;
}): CapturaComprador {
  const { detail: detalhe, statusObservado } = args;

  // A non-BR order short-circuits: there is no document on the wire, so the
  // name/document verdicts below would describe fields that do not exist and
  // would read as "masked, try again".
  if (detalhe.region !== REGIAO_BR) {
    return {
      estado: CAPTURA_COMPRADOR_ESTADO.expirado,
      camposRecusados: [recusa(CAMPO_CAPTURA.regiao, MOTIVO_NAO_BR)],
    };
  }

  if (clienteDeShopee(detalhe) !== null) {
    return { estado: CAPTURA_COMPRADOR_ESTADO.capturado, camposRecusados: [] };
  }

  const camposRecusados: string[] = [];
  const motivoNome = motivoDaRecusa(detalhe.recipient_address?.name, TIPO_DE_VALOR.nome);
  if (motivoNome !== null) camposRecusados.push(recusa(CAMPO_CAPTURA.nome, motivoNome));
  const motivoDocumento = motivoDaRecusa(detalhe.buyer_cpf_id, TIPO_DE_VALOR.documento);
  if (motivoDocumento !== null) {
    camposRecusados.push(recusa(CAMPO_CAPTURA.cpfCnpj, motivoDocumento));
  }

  return {
    estado: STATUS_SHOPEE_FORA_DA_JANELA.includes(statusObservado)
      ? CAPTURA_COMPRADOR_ESTADO.expirado
      : CAPTURA_COMPRADOR_ESTADO.pendente,
    camposRecusados,
  };
}
