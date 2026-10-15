/**
 * A Loja Integrada order's buyer and delivery address → the inputs of the
 * shared cliente and endereço seams (master plan step 5, PR 5-b):
 * `findOrCreateCliente`'s `ClienteResolveFields`, and `buildEnderecoForcado`'s
 * channel-agnostic raw address, plus the recipient's name on the endereço.
 *
 * PURE: no Firestore, no network. The ViaCEP recovery of an unknown estado
 * (`recoverEnderecoFromCep`) is the importer's call, between
 * {@link enderecoDoPedidoLi} and {@link comRecebedorLi}.
 *
 * ## The fiscal identity is the BUYER, read from `cliente.*` only
 *
 *  - **Document:** `cliente.cnpj` when it carries anything, else `cliente.cpf`
 *    — punctuation stripped, check digits validated, and the CNPJ field must
 *    hold a CNPJ (14) and the CPF field a CPF (11); anything else is NO
 *    document. A CNPJ field that is present but invalid does NOT fall back to
 *    the CPF: which of the two the buyer meant is a fiscal fact this mapper
 *    will not guess.
 *  - **`tipo`:** PJ for a valid CNPJ, PF for a valid CPF, `null` without one.
 *  - **`nome`:** for PJ the `razao_social`, else (or when it is unusable) the
 *    `nome`; a masked or placeholder value (`nomeUtilizavel`) is dropped. The
 *    seam's field is a string, so "no name" is `''`, which it reads as none.
 *  - **Contact:** the e-mail, and `telefone_celular`, else `telefone_principal`
 *    (the seam sanitises both). No `ie`: the buyer block carries none.
 *
 * ⚠️ `endereco_entrega`'s document is NEVER offered. `findOrCreateCliente`
 * fills a matched cliente's MISSING document from its input, so a recipient's
 * CPF offered for a buyer without one would be written onto the buyer's
 * cliente, and the NF-e would then name the recipient.
 *
 * ## The endereço
 *
 *  - `cep`, `endereco` (the street), `numero`, `complemento`, `bairro`,
 *    `cidade`, `estado` map one to one; `referencia` is not an address field
 *    and is not mapped.
 *  - `pais` counts only as a two-letter code other than `BR`; a country NAME is
 *    not an id, and `BR` is the default the builder stores as nothing.
 *  - The builder force-fills (its `ENDERECO_FALLBACKS`, `AC` for an absent
 *    estado) and nulls the person fields. {@link comRecebedorLi} then puts the
 *    RECIPIENT's name on it — `razao_social`, else `nome` — so the label names
 *    whoever receives; its document and phone stay `null`.
 */
import {
  TIPO_CLIENTE,
  buildEnderecoForcado,
  cpfCnpjUtilizavel,
  nomeUtilizavel,
  valorUtilizavel,
  type ClienteResolveFields,
  type EnderecoBuildOutcome,
  type EnderecoForcado,
  type RawEnderecoInput,
} from '@delfrance/schemas';
import type { PedidoLi } from '@delfrance/integrations-loja-integrada';

/** The buyer block, as the wire schema reads it. */
export type ClienteLi = NonNullable<PedidoLi['cliente']>;

/** The delivery block, as the wire schema reads it. */
export type EnderecoEntregaLi = NonNullable<PedidoLi['endereco_entrega']>;

/** `clienteSchema.nome` / `enderecoSchema.nome`'s cap: a longer name would refuse the write. */
const MAX_NOME = 255;

const COMPRIMENTO_CPF = 11;
const COMPRIMENTO_CNPJ = 14;

/** A usable name, capped at the schema's length, or `null`. */
function nomeOuNulo(valor: unknown): string | null {
  const nome = nomeUtilizavel(valor);
  return nome === null ? null : nome.slice(0, MAX_NOME);
}

/** The buyer's document (module header): the canonical CPF or CNPJ, or `null`. */
export function documentoDoClienteLi(cliente: ClienteLi | null | undefined): string | null {
  if (cliente == null) return null;
  if (valorUtilizavel(cliente.cnpj) !== null) {
    const cnpj = cpfCnpjUtilizavel(cliente.cnpj);
    return cnpj !== null && cnpj.length === COMPRIMENTO_CNPJ ? cnpj : null;
  }
  const cpf = cpfCnpjUtilizavel(cliente.cpf);
  return cpf !== null && cpf.length === COMPRIMENTO_CPF ? cpf : null;
}

export interface ClienteDoPedidoLi {
  readonly campos: ClienteResolveFields;
  /** A valid document was found: the only identity that may CREATE a cliente. */
  readonly identidadeForte: boolean;
}

/** The buyer, as `findOrCreateCliente`'s input (module header). */
export function clienteDoPedidoLi(cliente: ClienteLi | null | undefined): ClienteDoPedidoLi {
  const documento = documentoDoClienteLi(cliente);
  const pj = documento !== null && documento.length === COMPRIMENTO_CNPJ;
  const tipo =
    documento === null ? null : pj ? TIPO_CLIENTE.pessoaJuridica : TIPO_CLIENTE.pessoaFisica;
  const nome = (pj ? nomeOuNulo(cliente?.razao_social) : null) ?? nomeOuNulo(cliente?.nome) ?? '';
  return {
    campos: {
      tipo,
      nome,
      cpf_cnpj: documento,
      idEstrangeiro: null,
      ie: null,
      telefone:
        valorUtilizavel(cliente?.telefone_celular) ?? valorUtilizavel(cliente?.telefone_principal),
      email: valorUtilizavel(cliente?.email),
      // `idMercadoLivre` OMITTED: the key means "no evidence".
    },
    identidadeForte: documento !== null,
  };
}

/** `pais` as a provider country code: two uppercase letters, never `BR`; else `null`. */
export function paisIdLi(pais: string | null | undefined): string | null {
  return typeof pais === 'string' && /^[A-Z]{2}$/.test(pais) && pais !== 'BR' ? pais : null;
}

/** The delivery block as the endereço builder's raw input (module header). */
export function enderecoBrutoLi(endereco: EnderecoEntregaLi | null | undefined): RawEnderecoInput {
  return {
    cepRaw: endereco?.cep ?? null,
    logradouro: endereco?.endereco ?? null,
    numero: endereco?.numero ?? null,
    complemento: endereco?.complemento ?? null,
    bairro: endereco?.bairro ?? null,
    cidade: endereco?.cidade ?? null,
    estadoRaw: endereco?.estado ?? null,
    paisId: paisIdLi(endereco?.pais),
  };
}

/**
 * The endereço the builder makes of the delivery block: `ok`, `uf-desconhecida`
 * (storable; the importer recovers the UF through ViaCEP first) or `sem-cep`.
 */
export function enderecoDoPedidoLi(
  endereco: EnderecoEntregaLi | null | undefined,
): EnderecoBuildOutcome {
  return buildEnderecoForcado(enderecoBrutoLi(endereco));
}

/** The recipient's name: `razao_social`, else `nome`, usable only; else `null`. */
export function nomeDoRecebedorLi(endereco: EnderecoEntregaLi | null | undefined): string | null {
  return nomeOuNulo(endereco?.razao_social) ?? nomeOuNulo(endereco?.nome);
}

/**
 * The built (and, when needed, recovered) endereço with the RECIPIENT's name on
 * it. Document and phone stay `null`: the recipient's document is never stored.
 */
export function comRecebedorLi(
  campos: EnderecoForcado,
  endereco: EnderecoEntregaLi | null | undefined,
): EnderecoForcado {
  return { ...campos, nome: nomeDoRecebedorLi(endereco), cpf_cnpj: null, telefone: null };
}
