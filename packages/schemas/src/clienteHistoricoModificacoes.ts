import type { CollectionMetadata } from './types';

export {
  historicoModificacaoSchema,
  type HistoricoModificacao,
} from './shared/historicoModificacoes';
import { historicoModificacaoSchema } from './shared/historicoModificacoes';

// Reuses the CLIENTE permission bits (byte 0 — see `cliente.ts`), the same
// convention as the produto/pedido twins: reading a cliente's history requires
// the same read claim as the cliente itself. Write/delete bits are declared
// (required by `resolvePermissions`, which throws on an invalid bit) but stay
// inert — `meta.serverOwned` makes the rules generator deny every client write
// regardless of claim.
const PERM_CLIENTE_READ = 1n << 0n;
const PERM_CLIENTE_WRITE = 1n << 1n;
const PERM_CLIENTE_DELETE = 1n << 2n;

/**
 * `clientes/{id}/historicoDeModificacoes` — the cliente-rooted instance of the
 * shared entry schema (`./shared/historicoModificacoes`). Written EXCLUSIVELY by
 * the `apps/functions` cliente trigger family (`onClienteChanged` for the
 * cliente document itself, `onEnderecoChanged` for its covered `enderecos`
 * subcollection).
 *
 * ⚠️ Like `pedidos` (and unlike `produtos`), `clientes` has NO delete-cascade
 * trigger — `clienteMeta.cascade` declares `enderecos` but deliberately leaves
 * it unenforced (owner call, 2026-08: an endereço is read LIVE by ref from the
 * NF-e orchestrator and the pedido printer, so cascading it would break
 * reprinting/re-emission for every historical pedido of that customer). Nothing
 * sweeps a cliente's subtree, so a row here SURVIVES the cliente's own deletion
 * — the same reasoning as `historicoModificacaoPedidoMeta`, and why every
 * cliente source leaves `requireParentExists` OFF.
 *
 * The other rooted instances are `../produto/collection/historicoModificacoes.ts`,
 * `../pedido/collection/historicoModificacoes.ts` and
 * `./operacaoHistoricoModificacoes.ts`; all four metas are pinned to each other
 * by `./shared/historicoModificacoes.meta.test.ts`.
 */
export const historicoModificacaoClienteMeta: CollectionMetadata = {
  collectionPath: 'clientes/{clienteId}/historicoDeModificacoes',
  permissions: {
    read: PERM_CLIENTE_READ,
    write: PERM_CLIENTE_WRITE,
    delete: PERM_CLIENTE_DELETE,
  },
  serverOwned: true,
  // Shares the `historicoDeModificacoes` leaf with the produto/pedido/operacao
  // roots — the generator unions the read claims of every collection sharing a
  // leaf name into ONE `{path=**}` block, so leaving this on would let a
  // `d_produto`/`d_pedido`/fiscal holder group-read a cliente's history and vice
  // versa. Every root sharing the leaf must set it.
  noCollectionGroupRead: true,
  // Same shape the produto/pedido feeds issue (newest first). Declared so the
  // `defaultQuery.indexes` meta-test requires the index; the existing
  // `historicoDeModificacoes(timestamp desc)` COLLECTION-scope entry already
  // covers it — a `queryScope: COLLECTION` index keyed on the leaf applies at
  // any parent path, so no new entry is needed in firestore.indexes.json.
  defaultQuery: {
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    limit: 50,
  },
};

export const historicoModificacaoCliente = {
  schema: historicoModificacaoSchema,
  meta: historicoModificacaoClienteMeta,
};
