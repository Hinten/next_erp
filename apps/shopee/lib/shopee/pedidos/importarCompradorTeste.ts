/**
 * The `--live` half of `importar:pedido`'s TEST buyer mode (`--importar-cliente`):
 * the refusals that must run BEFORE the import, then the import itself.
 *
 * ⚠️ **Script-only** — imported by `scripts/importar-pedido.ts` and by nothing
 * else (`simulacaoComprador.test.ts` greps every route, sweep, trigger and
 * notification arm). It lives apart from `importarPedidoCli.ts` because it reads
 * Firestore, and that module promises it never does; the script loads it with a
 * dynamic import, so `--help` still loads none of it.
 *
 * ## The order, and why
 *
 *  0. The PROJECT: an explicit `--project`, equal to what the admin app
 *     resolved, under a service account issued for it
 *     (`exigirProjetoDoModoComprador`) — before any Shopee call.
 *  1. The importer's own READ-ONLY half, with the simulation — which re-checks
 *     the sandbox override and the order's real region itself.
 *  2. The COLLISION check, outside any transaction: who already holds the
 *     document the run would use (Shopee's usable one, else `--cpf-teste`, else
 *     the repo's fake). `findOrCreateCliente`'s first leg matches ANY
 *     holder (the run sends no other strong key, so none can contradict), so a
 *     holder with another name means the test buyer would be linked to a
 *     stranger. Both places a holder can be found are read — the
 *     `clienteIdentidades` side index AND the `cpf_cnpj` query — because the
 *     index is filled lazily and the dev seed writes its cliente straight to
 *     `clientes`, with no index row at all.
 *  3. A stored buyer link this run cannot attribute to the test buyer is
 *     refused (`exigirPedidoSemVinculoAlheio`): over a stored cliente the
 *     importer skips `findOrCreateCliente`, so step 2 would protect nothing.
 *  4. An existing pedido whose capture leaves nothing to do is refused.
 *  5. The importer's WRITE half (`gravarPreparoPedidoShopee`) over the SAME
 *     preparo — so it writes exactly the identity steps 2–4 checked, with no
 *     second Shopee read in between: the real capture path
 *     (`findOrCreateCliente`, `ensureEndereco`, the fill-once guards of the
 *     pedido transaction) creates and links the cliente and the endereço.
 *
 * ## Rule 7
 *
 * No transaction here, and no new write site: the cliente and its identity row
 * are `findOrCreateCliente`'s own transaction, the endereço is `ensureEndereco`
 * (a deterministic id, `ALREADY_EXISTS` swallowed), the pedido is
 * `salvarPedidoShopee`. Steps 2–4 are READS outside all of them, so a writer
 * that lands between them and step 5 is not excluded — the accepted residual:
 * this mode runs only against the sandbox, by one operator from one terminal,
 * and a lost race links the run to whichever holder `findOrCreateCliente`
 * picks, exactly as a real import would.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { clienteIdentidadeId, documentoNormalizado } from '@delfrance/data/admin/clientes';
import { clienteCollection, clienteIdentidadeCollection } from '@delfrance/data/admin/collections';

import { clienteDeShopee, type SimulacaoCompradorShopee } from './comprador';
import {
  gravarPreparoPedidoShopee,
  prepararImportacaoPedidoShopee,
  type AlvoDeImportacaoShopee,
  type ResultadoImportacaoPedidoShopee,
  type ShopeeImportarPedidoDeps,
} from './importarPedido';
import {
  decidirColisaoDeDocumento,
  exigirDocumentoSemColisao,
  exigirPedidoSemCapturaTerminal,
  exigirPedidoSemVinculoAlheio,
  exigirProjetoDoModoComprador,
  type ColisaoDeDocumento,
  type DonoDoDocumento,
  type ProjetoDoModoComprador,
} from './importarPedidoCli';

/** Rows of the `cpf_cnpj` query — `findOrCreateCliente`'s own per-leg page. */
const LIMITE_DONOS = 10;

/**
 * Every cliente that holds `documento` (canonical, as `clienteDeShopee` returns
 * it): the side index's owners that still exist AND still hold it — the two
 * conditions `findOrCreateCliente` prunes on — plus the `cpf_cnpj` query.
 */
export async function lerDonosDoDocumento(
  db: Firestore,
  documento: string,
): Promise<DonoDoDocumento[]> {
  const donos = new Map<string, DonoDoDocumento>();

  const consulta = await clienteCollection
    .ref(db, {})
    .where('cpf_cnpj', '==', documento)
    .limit(LIMITE_DONOS)
    .get();
  for (const doc of consulta.docs) {
    const raw = (doc.data() ?? {}) as Record<string, unknown>;
    donos.set(doc.id, { clienteId: doc.id, nome: raw.nome });
  }

  const indice = await clienteIdentidadeCollection
    .docRef(db, {}, clienteIdentidadeId('cpf_cnpj', documento))
    .get();
  const doIndice = indice.exists
    ? ((indice.data() ?? {}) as Record<string, unknown>).clienteIds
    : undefined;
  for (const id of Array.isArray(doIndice) ? doIndice : []) {
    if (typeof id !== 'string' || donos.has(id)) continue;
    const snap = await clienteCollection.docRef(db, {}, id).get();
    if (!snap.exists) continue;
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    if (documentoNormalizado(raw.cpf_cnpj) !== documento) continue;
    donos.set(id, { clienteId: id, nome: raw.nome });
  }

  return [...donos.values()];
}

export type ImportacaoCompradorTeste =
  | {
      readonly kind: 'importado';
      readonly resultado: ResultadoImportacaoPedidoShopee;
      /** `null` when no cliente would be created (a refused name or document). */
      readonly colisao: ColisaoDeDocumento | null;
    }
  /** Shopee denies the order — an ANSWER, nothing was written. */
  | { readonly kind: 'inexistente'; readonly resultado: ResultadoImportacaoPedidoShopee };

export async function importarPedidoComCompradorDeTeste(
  db: Firestore,
  alvo: AlvoDeImportacaoShopee,
  simulacao: SimulacaoCompradorShopee,
  projeto: ProjetoDoModoComprador,
  deps: Omit<ShopeeImportarPedidoDeps, 'simulacaoComprador'> = {},
): Promise<ImportacaoCompradorTeste> {
  // 0. The project — before any Shopee call and any write.
  exigirProjetoDoModoComprador(projeto);

  // 1. The read-only half — the importer's own guards run inside it.
  const preparado = await prepararImportacaoPedidoShopee(db, alvo, {
    ...deps,
    simulacaoComprador: simulacao,
  });
  if (preparado.kind === 'inexistente') {
    return { kind: 'inexistente', resultado: preparado.resultado };
  }
  const { preparo } = preparado;

  // 2. The collision check. No cliente would be created when the name or the
  // document refuses, and then there is nobody to collide with. The document is
  // the one the simulated row CARRIES (Shopee's usable one, else `--cpf-teste`,
  // else the repo's fake — `simularCompradorShopee`'s precedence), read off
  // `clienteDeShopee` exactly as `findOrCreateCliente` will receive it.
  const simulado = preparo.simulacao;
  const campos = simulado === null ? null : clienteDeShopee(simulado.detalheComprador);
  let colisao: ColisaoDeDocumento | null = null;
  if (simulado !== null && campos !== null && campos.cpf_cnpj !== null) {
    colisao = decidirColisaoDeDocumento(
      await lerDonosDoDocumento(db, campos.cpf_cnpj),
      campos.nome,
    );
    exigirDocumentoSemColisao(colisao, simulado.fonteDoCpf);
  }

  // 3. A stored link that is not the test buyer's.
  exigirPedidoSemVinculoAlheio(preparo.armazenado, colisao);

  // 4. An existing pedido whose capture leaves nothing to do.
  exigirPedidoSemCapturaTerminal(preparo.armazenado, simulacao.importarEndereco);

  // 5. The write half, over the preparo steps 2–4 checked.
  const resultado = await gravarPreparoPedidoShopee(db, alvo, preparo, deps);
  return { kind: 'importado', resultado, colisao };
}
