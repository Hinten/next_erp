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
export * from './collection/historicoModificacoes'; // produtos/{id}/historicoDeModificacoes
export * from './collection/subcollections'; // produtos/{id}/<marketplace link docs>
export * from './collection/mercadoLivreLink'; // typed ML link-doc write shapes (not DomainSchemas)
export * from './collection/shopeeLink'; // typed Shopee link-doc write shapes (not DomainSchemas)
export * from './collection/amazonLink'; // typed Amazon link-doc write shapes (not DomainSchemas)
export * from './collection/magaluLink'; // typed Magalu link-doc write shapes (not DomainSchemas)
export * from './collection/lojaIntegradaLink'; // typed Loja Integrada link-doc write shapes (not DomainSchemas)

// === EMBEDDED value objects (nested in a collection doc; NOT collections) ===
export * from './collection/embedded/kit'; // produto.componentesKit[*]
export * from './collection/embedded/anexo'; // produto.anexos[*]

// === PURE LOGIC (no database) ===
export * from './pureLogic/precoCalculo'; // price-formula engine, kit cost, precos diff
export * from './pureLogic/variacoes'; // variation cartesian / reconstruct / reconcile helpers
export * from './pureLogic/familia'; // parent ⇄ sole-member identity (shared by web and the ML backend)
export * from './pureLogic/fotosVariacao'; // per-variant gallery resolution (own → tagged → parent)
export * from './pureLogic/kitVariacoes'; // "Gerar Variações" kit-component matcher
export * from './pureLogic/kitEstoque'; // kit available-stock (min over limitarEstoque components)
export * from './pureLogic/kitUnidadeVendavel'; // repoint componentesKit at the sellable unit (#1398)
export * from './pureLogic/dimensoes'; // box/bag estimator + the ProdutoMedidas shape it reads
export * from './pureLogic/dimensoesKit'; // kit weight + box rollup (the ONE impl client & server share)
export * from './pureLogic/googleMerchantFeed'; // Google Merchant complementary XML feed (#553)

// === PAGE MODEL (aggregate for the screen; NOT a collection) ===
export * from './pageModel/pageModel';
