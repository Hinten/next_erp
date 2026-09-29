/**
 * Pedido domain schemas. Folder layout mirrors `../produto`:
 *
 *  - collection/  → each file is a Firestore COLLECTION (has a `*Meta` with
 *                   collectionPath + perms; registered in `../registry`).
 *  - pureLogic/   → no schema / no DB (totals factory + kanban buckets).
 *  - wire/        → request / response contracts a backend route and the web
 *                   share (browser-safe; NOT a collection).
 *  - pageModel/   → the aggregate validation model for the whole editor screen;
 *                   NOT a collection.
 *
 * Domains the pedido only *references* (cliente, endereco, operacao, integracao,
 * listaDePrecos, frete, bandeiraCartao, …) live at the schemas root.
 */

// === Firestore COLLECTIONS ===
export * from './collection/pedido'; // pedidos
export * from './collection/pagamento'; // pedidos/{id}/pagamentos + metodo_pgto
export * from './collection/incidente'; // pedidos/{id}/incidentes
export * from './collection/checkout'; // pedidos/{id}/checkout (dispatch audit doc)
export * from './collection/historicoEstadoPedido'; // pedidos/{id}/historicoEstadoPedido
export * from './collection/historicoFtIni'; // pedidos/{id}/historicoFtIni (frete trail)
export * from './collection/historicoModificacoes'; // pedidos/{id}/historicoDeModificacoes
export * from './collection/orderML'; // pedidos/{id}/orderML (Mercado Livre order mirror)
export * from './collection/linkPgtoMercadoPago'; // pedidos/{id}/linkPgtoMercadoPago (MP Checkout Pro links, #367)

// === PURE LOGIC (no database) ===
export * from './pureLogic/totals'; // money caches factory (derivePedidoTotals)
export * from './pureLogic/cobertura'; // payments + devolução credit vs the gross total
export * from './pureLogic/estado'; // kanban buckets
export * from './pureLogic/estoque'; // pedido → estoque desired-state predicates
export * from './pureLogic/itens'; // flattenPedidoItens (grouped → ordem-sorted list)
export * from './pureLogic/itemIdentity'; // per-line identity for the modification history
export * from './pureLogic/nomeDoItem'; // the ONE display-name resolver for a pedido line
export * from './pureLogic/checkoutEngine'; // kit-aware scan engine (checkout screen)
export * from './pureLogic/checkoutCompleteness'; // save-time completeness check
export * from './pureLogic/linkPagamento'; // MP payment-link gate, summary and copy text (#367)

// === WIRE (request / response contracts shared by a backend route and the web) ===
export * from './wire/linkPagamento'; // Mercado Pago payment-link routes (#367)

// === PAGE MODEL (aggregate for the screen; NOT a collection) ===
export * from './pageModel/pageModel';
