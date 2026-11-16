/**
 * The stock write of master-plan step 12, over the write client
 * (`escrita.ts`):
 *
 *  - {@link atualizarEstoqueProdutoLi} — `PUT /v1/produto_estoque/{produto id}`
 *    `{gerenciado, quantidade, situacao_em_estoque, situacao_sem_estoque}`, one
 *    product's stock. The path id is the PRODUTO's id (`estoque.ts`, module
 *    header), never the stock row's own `id`. One call per product: the API has
 *    no batch.
 *
 * It only builds and sends: no read, no retry, no decision, and no quantity of
 * its own. Which quantity is due, whether the store already shows it and
 * whether a write is safe are the app's to decide from a fresh read made just
 * before it (`buscarEstoqueProdutoLi`, or the write client's own pre-write
 * read); every error is the write client's, rethrown as-is.
 *
 * ## What the package refuses, for every stock write it can send
 *
 * The request core checks EVERY `PUT` against the write routes
 * (`rotasEscrita.ts`) before it reads the credential, so these hold for any
 * holder of a write client, not only for the function below:
 *
 *  - **Exactly the four leaves**, three of them fixed
 *    ({@link ESTOQUE_FIXO_ESCRITA_LI}: `gerenciado: true`,
 *    `situacao_em_estoque: 0`, `situacao_sem_estoque: -1`) and the quantity. A
 *    missing or extra key, an unmanaged product, another situação is
 *    `LiConfigError('corpo')` and nothing is fetched.
 *  - **A sendable quantity only:** a JSON number that is a non-negative safe
 *    integer ({@link quantidadeDeEstoqueValidaLi}). A negative number, a
 *    fraction, `NaN`, an infinity and a quoted number (`'3'`) are each
 *    `LiConfigError('corpo')`. The store's own rows may hold a negative
 *    quantity; this package never sends one. The app clamps first; this is the
 *    backstop.
 *  - **Sent unquoted:** the body is the route schema's output serialised once,
 *    so the quantity and the two situações go out as JSON numbers and
 *    `gerenciado` as a JSON boolean.
 *  - **No other path:** `/v1/produto_estoque/{id}` exactly — no trailing slash,
 *    a canonical id — else `LiConfigError('rota-nao-permitida')`.
 *  - **Ids** go through the shared path-id reader (`idsDeCaminho.ts`).
 *
 * ⚠️ The fixed leaves overwrite whatever per-product lead time the store had
 * set, on every write, by design (`rotasEscrita.ts`).
 *
 * ## Echo
 *
 * Read through `liEcoEstoqueProdutoSchema` (`types.ts`), every field optional:
 * an echo is diagnostic, and a write that landed is reported, never thrown
 * (`escrita.ts`).
 */
import type { LiEscritaClient, RespostaEscritaLi } from './escrita';
import { CAMINHO_ESTOQUE_LI } from './estoque';
import { idOuRecusa } from './idsDeCaminho';
import type { OpcoesEscritaLi } from './pedidosEscrita';
import { ESTOQUE_FIXO_ESCRITA_LI } from './rotasEscrita';
import { type EcoEstoqueProdutoLi, liEcoEstoqueProdutoSchema } from './types';

export { ESTOQUE_FIXO_ESCRITA_LI, quantidadeDeEstoqueValidaLi } from './rotasEscrita';

/**
 * `PUT /v1/produto_estoque/{produtoId}`: write ONE product's stock as
 * `quantidade`, with the three fixed leaves ({@link ESTOQUE_FIXO_ESCRITA_LI}).
 * `produtoId` is the PRODUTO's id; `quantidade` a non-negative safe integer
 * (module header), sent as a JSON number.
 */
export async function atualizarEstoqueProdutoLi(
  cliente: LiEscritaClient,
  produtoId: number | string,
  quantidade: number,
  opts: OpcoesEscritaLi = {},
): Promise<RespostaEscritaLi<EcoEstoqueProdutoLi>> {
  const operacao = 'atualizarEstoqueProduto';
  const id = idOuRecusa(produtoId, operacao);
  return cliente.enviarEscritaLi({
    operacao,
    caminho: `${CAMINHO_ESTOQUE_LI}/${id}`,
    corpo: { ...ESTOQUE_FIXO_ESCRITA_LI, quantidade },
    ecoSchema: liEcoEstoqueProdutoSchema,
    sinal: opts.sinal,
  });
}
