/**
 * Produto domain schemas. The folder layout makes it explicit what lands in the
 * database and what doesn't:
 *
 *  - collection/          → each file is a Firestore COLLECTION (has a `*Meta`
 *                           with collectionPath + perms; registered in
 *                           `../registry`).
 *  - collection/embedded/ → value objects EMBEDDED inside those collection
 *                           documents; no `meta`, never their own collection.
 *  - pureLogic/           → no schema / no DB (pricing engine + variation
 *                           helpers).
 *  - pageModel/           → the aggregate validation model for the whole editor
 *                           screen; NOT a collection.
 *
 * Domains produto only *references* (grupoDeVariacoes, listaDePrecos, deposito,
 * categoria, tabelaDeMedidas, the imposto tribute domain) live at the schemas
 * root — they are their own collections, shared with pedido / NF-e.
 */

// === Firestore COLLECTIONS ===
export * from './collection/produto'; // produtos
export * from './collection/extraData'; // produtos/{id}/extraData (singleton)
export * from './collection/estoque'; // produtos/{id}/estoques
export * from './collection/historicoEstoque'; // produtos/{id}/estoques/{estId}/historicoEstoque
export * from './collection/historicos'; // produtos/{id}/historicoDePrecos | historicoDeCusto
export * from './collection/subcollections'; // produtos/{id}/<marketplace link docs>

// === EMBEDDED value objects (nested in a collection doc; NOT collections) ===
export * from './collection/embedded/kit'; // produto.componentesKit[*]
export * from './collection/embedded/anexo'; // produto.anexos[*]

// === PURE LOGIC (no database) ===
export * from './pureLogic/precoCalculo'; // price-formula engine, kit cost, precos diff
export * from './pureLogic/variacoes'; // variation cartesian / reconstruct / reconcile helpers

// === PAGE MODEL (aggregate for the screen; NOT a collection) ===
export * from './pageModel/pageModel';
