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
  CAPTURA_COMPRADOR_ESTADO,
  MOTIVO_RECUSA,
  TIPO_CLIENTE,
  buildEnderecoForcado,
  cpfCnpjUtilizavel,
  motivoDaRecusa,
  nomeUtilizavel,
  valorUtilizavel,
  type CapturaCompradorEstado,
  type ClienteResolveFields,
  type EnderecoBuildOutcome,
  type MotivoRecusa,
  type TipoDeValor,
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

/**
 * Where the buyer capture stands for one pedido — the SAME vocabulary the
 * pedido's `capturaComprador.estado` stores.
 *
 * ⚠️ **Re-exported from `@delfrance/schemas`, never re-declared.** These three
 * tokens exist in exactly one place (`capturaCompradorEstadoSchema`), so this
 * adapter and the Zod enum that has to accept its output cannot drift: a fourth
 * verdict added here without the schema, or vice versa, would otherwise surface
 * only as a `ZodError` inside the pedido write — i.e. at the one moment the
 * pedido must not fail. They are re-exported rather than merely imported
 * because this module is where every reader of the capture rule looks.
 *
 * ⚠️ A DIARY, never a GUARD. The capture decision is re-derived from the fresh
 * wire payload on every delivery; nothing may branch on the stored estado. Any
 * later step that wants to gate on it must first move the field into
 * `serverOwnedFields` and pay the ruleset regeneration.
 *
 *  - `pendente` — nothing captured yet, and the window may still open;
 *  - `capturado` — name and document captured;
 *  - `expirado` — the window closed (or never existed) with nothing captured.
 */
export { CAPTURA_COMPRADOR_ESTADO, type CapturaCompradorEstado };

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
 * name-without-document on and refuses a new cliente for it. Returning `null`
 * here keeps that permanent provider-data gap out of the write path entirely.
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
 * `null` unless the name, the `full_address` and the `zipcode` all pass. The
 * last two because an address without a street or a CEP is not an address; the
 * NAME because it is R4's capture policy — an unusable recipient name means this
 * delivery captured nothing, address included.
 *
 * ⚠️ The name gate does INDEPENDENT work, and the reason is the module header's
 * own sandbox finding: masking is per FIELD. The SG order came back with `name`
 * and `phone` as `"****"` while `full_address` and `zipcode` were CLEAR in the
 * same object, so on that observed shape the name is the ONLY field that refuses.
 *
 * ⚠️ It is NOT because the row stores the name. It does not:
 * `buildEnderecoForcado` has no `nome` input (`rawEnderecoInputSchema` declares
 * eight keys and none is a name) and hardcodes `nome: null`, so the stored
 * endereço's name is always null and `makeEnderecoId`'s name slot is always the
 * empty string. Storing it would change the content-addressed id for every
 * marketplace and needs its own decision.
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
  const { entrada } = portoesDoEnderecoShopee(addr, regiao);
  if (entrada === null) return null;
  return buildEnderecoForcado({ ...entrada, numero: null, complemento: null });
}

/** The builder input {@link enderecoDeShopee} hands `buildEnderecoForcado`, gates passed. */
export interface EntradaEnderecoShopee {
  readonly cepRaw: string;
  readonly logradouro: string;
  readonly bairro: string | null;
  readonly cidade: string | null;
  /** `null` when Shopee sent no usable state — the builder's `AC` by ABSENCE, not a lookup miss. */
  readonly estadoRaw: string | null;
  readonly paisId: string | null;
}

/** What {@link enderecoDeShopee}'s three gates answered for one block. */
export interface PortoesEnderecoShopee {
  /** `<campo>:<verdito>` per refusing gate (`nome`, `logradouro`, `cep`) — names, never values. */
  readonly recusados: readonly string[];
  /** The builder input, or `null` when any gate refused. */
  readonly entrada: EntradaEnderecoShopee | null;
}

/**
 * {@link enderecoDeShopee}'s gates and its builder input, as ONE function — the
 * import reads `entrada`, and the CLI's TEST buyer preview reads `recusados`
 * and `entrada.estadoRaw` off the same answer rather than re-deriving them
 * (the #1369 drift: two copies that read correct while disagreeing).
 */
export function portoesDoEnderecoShopee(
  addr: EnderecoShopee,
  regiao: string | null,
): PortoesEnderecoShopee {
  const nome = nomeUtilizavel(addr.name);
  const logradouro = valorUtilizavel(addr.full_address);
  const cep = valorUtilizavel(addr.zipcode);
  if (nome === null || logradouro === null || cep === null) {
    const portoes: ReadonlyArray<readonly [string, string | null, unknown, TipoDeValor]> = [
      ['nome', nome, addr.name, TIPO_DE_VALOR.nome],
      ['logradouro', logradouro, addr.full_address, TIPO_DE_VALOR.texto],
      ['cep', cep, addr.zipcode, TIPO_DE_VALOR.texto],
    ];
    // One reason per gate that REFUSED, so the list cannot come back empty.
    // `motivoDaRecusa` is non-null exactly where its `*Utilizavel` twin is
    // null; the `invalido` fallback only keeps a refusal from losing its name.
    const recusados = portoes
      .filter(([, valor]) => valor === null)
      .map(([campo, , bruto, tipo]) =>
        recusa(campo, motivoDaRecusa(bruto, tipo) ?? MOTIVO_RECUSA.invalido),
      );
    return { recusados, entrada: null };
  }
  return {
    recusados: [],
    entrada: {
      cepRaw: cep,
      logradouro,
      // `district` is the finer of the two; `town` is the coarser fallback. Both
      // are legitimately empty by region, and both can be masked — hence the
      // predicate on each rather than a `??` on the raw values.
      bairro: valorUtilizavel(addr.district) ?? valorUtilizavel(addr.town),
      cidade: valorUtilizavel(addr.city),
      estadoRaw: valorUtilizavel(addr.state),
      paisId: regiao,
    },
  };
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

/* ------------------------ the TEST buyer simulation ------------------------- */

/**
 * The repo's sanctioned FAKE CPF — check digits valid, never a real document
 * (the same literal the CLI tests and the dev seed use). The ONE place
 * production code spells a CPF.
 */
export const CPF_FALSO_DE_TESTE = '12345678909';

/** A CPF's length in the canonical stored form (`normalizeDocumento`'s output). */
const DIGITOS_CPF = 11;

/**
 * A `--cpf-teste` value in the canonical stored form (11 digits) — or `null`.
 *
 * The capture's own predicate, `cpfCnpjUtilizavel` (`normalizeDocumento`, then
 * `validateCpfCnpj`'s mod-11, which also refuses an all-same-digit CPF), narrowed
 * to a CPF: the mode simulates a PESSOA FÍSICA, so a valid CNPJ is refused too.
 * ONE function, read by the CLI parser AND re-checked by
 * {@link simularCompradorShopee} — no second copy of the check-digit rule.
 */
export function cpfDeTesteUtilizavel(raw: unknown): string | null {
  const documento = cpfCnpjUtilizavel(raw);
  return documento !== null && documento.length === DIGITOS_CPF ? documento : null;
}

/**
 * Where the document on the simulated buyer row came from — reported by NAME,
 * never by its digits.
 */
export const FONTE_CPF_SIMULADO = {
  /** Shopee sent a usable CPF/CNPJ: the real data wins, always. */
  shopee: 'shopee',
  /** The operator's own `--cpf-teste`. */
  cpfTeste: 'cpf-teste',
  /** {@link CPF_FALSO_DE_TESTE}, the repo's fake. */
  cpfFalso: 'cpf-falso',
} as const satisfies Record<string, string>;

export type FonteCpfSimulado = (typeof FONTE_CPF_SIMULADO)[keyof typeof FONTE_CPF_SIMULADO];

/**
 * What the `importar:pedido` CLI's TEST buyer mode asks for (`--importar-cliente`
 * and its four dependents). Nothing else builds one: the importer takes it as
 * an optional dependency, and a test greps that no route, sweep, trigger or
 * notification arm names it.
 */
export interface SimulacaoCompradorShopee {
  /** `--nome-teste`: replaces ONLY `recipient_address.name`. `null` keeps Shopee's. */
  readonly nomeTeste: string | null;
  /** `--cep-teste` (8 digits): replaces ONLY `recipient_address.zipcode`. */
  readonly cepTeste: string | null;
  /**
   * `--cpf-teste`, canonical (11 digits, check digits valid — the parser runs
   * {@link cpfDeTesteUtilizavel}): used INSTEAD of {@link CPF_FALSO_DE_TESTE}
   * when Shopee sends no usable document. `null` keeps the fake.
   *
   * ⚠️ Printed, logged and echoed NOWHERE — only its source
   * ({@link FONTE_CPF_SIMULADO}) is reported.
   */
  readonly cpfTeste: string | null;
  /** `--importar-endereco`: without it the cliente is linked and no endereço is written. */
  readonly importarEndereco: boolean;
}

/**
 * A refused simulation — always BEFORE any buyer or pedido write, so a CLI
 * exits 1 with nothing to undo. (A Shopee read before the refusal may still
 * renew the conta's access token; that write is the token store's, not ours.)
 */
export class SimulacaoCompradorRecusadaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulacaoCompradorRecusadaError';
  }
}

/**
 * The buyer mode runs only against the SANDBOX — `overrideDeSandboxAtivo`'s
 * verdict (`SHOPEE_SANDBOX=1` AND the resolved sandbox host), passed in so this
 * module stays free of the environment.
 */
export function exigirSandboxParaSimulacao(overrideSandboxAtivo: boolean): void {
  if (overrideSandboxAtivo) return;
  throw new SimulacaoCompradorRecusadaError(
    'O modo comprador de TESTE só roda no sandbox da Shopee: exige SHOPEE_SANDBOX=1 e o host ' +
      'de sandbox resolvido.',
  );
}

/**
 * A REAL order-level region the TEST mode accepts: exactly two UPPERCASE
 * letters, and not `BR`.
 *
 * ⚠️ Deliberately STRICTER than `pedidoForaDoBrasil`, which reads a blank, a
 * padded or a lowercase `'br'` as foreign — the SAFE direction for the NF-e
 * block it feeds, and the unsafe one here, where "foreign" is what lets a fake
 * CPF in. Blank = absent (the `valorUtilizavel` convention), and an absent
 * region is not proof of a foreign one.
 */
export function regiaoEstrangeiraParaSimulacao(regiaoReal: string | null): boolean {
  return regiaoReal !== null && /^[A-Z]{2}$/.test(regiaoReal) && regiaoReal !== REGIAO_BR;
}

/**
 * …and only on an order whose REAL order-level region is foreign
 * ({@link regiaoEstrangeiraParaSimulacao}). A fake CPF must never pair with a
 * real Brazilian buyer.
 */
export function exigirRegiaoForaDoBrasilParaSimulacao(regiaoReal: string | null): void {
  if (regiaoEstrangeiraParaSimulacao(regiaoReal)) return;
  throw new SimulacaoCompradorRecusadaError(
    `O modo comprador de TESTE recusa um pedido de região ` +
      `${regiaoReal === null ? '(ausente)' : JSON.stringify(regiaoReal)}: um CPF de teste nunca ` +
      'se junta a um comprador brasileiro de verdade.',
  );
}

/**
 * The row the buyer adapter reads in buyer mode: region `'BR'` (so
 * {@link clienteDeShopee} and {@link avaliarCapturaComprador} run at all), the
 * document by precedence — Shopee's own when it is usable (the real data wins),
 * else `--cpf-teste`, else {@link CPF_FALSO_DE_TESTE} — and the recipient's name
 * and zipcode replaced only when a substitute was given.
 *
 * ⚠️ The caller keeps the REAL row for everything else: the region it hands
 * {@link enderecoDeShopee} as `paisId`, `bloquearEmissaoNFe` and every fiscal
 * flag. A `null` `recipient_address` stays `null` — no partial address is
 * invented around a substitute name.
 *
 * ⚠️ A `cpfTeste` that is not a usable CPF is REFUSED, never replaced by the
 * fake: the operator asked for that document, and a silent fallback would run
 * the collision check on a different one. The parser refuses it first; this is
 * the defence for any other caller.
 */
export function simularCompradorShopee<T extends DetalheCompradorShopee>(
  linha: T,
  simulacao: SimulacaoCompradorShopee,
): {
  readonly linha: T;
  /** `true` whenever the document is not Shopee's — i.e. {@link fonteDoCpf} is not `shopee`. */
  readonly cpfDeTesteAplicado: boolean;
  readonly fonteDoCpf: FonteCpfSimulado;
  /** A substitute counts as APPLIED only where there was a block to put it in. */
  readonly nomeTesteAplicado: boolean;
  readonly cepTesteAplicado: boolean;
} {
  const cpfTeste = simulacao.cpfTeste === null ? null : cpfDeTesteUtilizavel(simulacao.cpfTeste);
  if (simulacao.cpfTeste !== null && cpfTeste === null) {
    // The value is deliberately NOT in the message.
    throw new SimulacaoCompradorRecusadaError(
      '--cpf-teste não é um CPF utilizável (11 dígitos, dígitos verificadores válidos). ' +
        'Nada foi gravado.',
    );
  }
  const documentoDaShopee = cpfCnpjUtilizavel(linha.buyer_cpf_id);
  const fonteDoCpf: FonteCpfSimulado =
    documentoDaShopee !== null
      ? FONTE_CPF_SIMULADO.shopee
      : cpfTeste !== null
        ? FONTE_CPF_SIMULADO.cpfTeste
        : FONTE_CPF_SIMULADO.cpfFalso;
  const endereco = linha.recipient_address;
  return {
    nomeTesteAplicado: endereco != null && simulacao.nomeTeste !== null,
    cepTesteAplicado: endereco != null && simulacao.cepTeste !== null,
    linha: {
      ...linha,
      region: REGIAO_BR,
      buyer_cpf_id: documentoDaShopee ?? cpfTeste ?? CPF_FALSO_DE_TESTE,
      recipient_address:
        endereco == null
          ? null
          : {
              ...endereco,
              name: simulacao.nomeTeste ?? endereco.name,
              zipcode: simulacao.cepTeste ?? endereco.zipcode,
            },
    },
    cpfDeTesteAplicado: fonteDoCpf !== FONTE_CPF_SIMULADO.shopee,
    fonteDoCpf,
  };
}
