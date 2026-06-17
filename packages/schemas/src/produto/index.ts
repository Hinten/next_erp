/**
 * Produto domain schemas, grouped by WHAT THEY ARE so it's obvious what lands
 * in the database and what doesn't:
 *
 *  - COLLECTIONS → each has a `*Meta` (collectionPath + perms) and is a real
 *                  Firestore collection (registered in `../registry`).
 *  - EMBEDDED    → value objects nested INSIDE a produto document; no `meta`,
 *                  never their own collection.
 *  - PURE LOGIC  → no schema / no DB (pricing engine + variation helpers).
 *  - PAGE MODEL  → the aggregate validation model for the whole editor screen;
 *                  NOT a collection.
 *
 * Domains produto only *references* (grupoDeVariacoes, listaDePrecos, deposito,
 * categoria, tabelaDeMedidas, the imposto tribute domain) live at the schemas
 * root — they are their own collections, shared with pedido / NF-e.
 */

// === Firestore COLLECTIONS (each becomes a Firestore collection) ===
export * from './produto'; // produtos
export * from './extraData'; // produtos/{id}/extraData (singleton)
export * from './estoque'; // produtos/{id}/estoques
export * from './historicos'; // produtos/{id}/historicoDePrecos | historicoDeCusto
export * from './subcollections'; // produtos/{id}/<marketplace link docs>

// === EMBEDDED value objects (nested in the produto doc; NOT collections) ===
export * from './kit'; // produto.componentesKit[*]
export * from './anexo'; // produto.anexos[*]

// === PURE LOGIC (no database) ===
export * from './precoCalculo'; // price-formula engine, kit cost, precos diff
export * from './variacoes'; // variation cartesian / reconstruct / reconcile helpers

// === PAGE MODEL (aggregate for the screen; NOT a collection) ===
export * from './pageModel';
