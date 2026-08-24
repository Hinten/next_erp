# importacao — product import (ML → ERP)

Pulls an existing ML listing into the ERP as a produto: fields, category chain,
photos, variations and the link doc. The inverse direction (ERP → ML) is
`anuncios/`.

- `import.ts` — the IO orchestration: fetch item → map → produto + extraData +
  estoque + link. ⚠️ Reaches **across** into `anuncios/moderacoes.ts` (#1087):
  the importer is the third writer of the link doc's `moderacoes` and shares that
  module's ML read rather than restating it. ⚠️ The **gate** is no longer part of
  what it borrows from there: `precisaConsultarModeracao` moved to
  `@delfrance/schemas` in #1239, and all three writers import it from the schema.
  `lerModeracoesDoItem` holds the
  two divergences — the read sits above every write, and a transient ML failure
  degrades to "never asked" instead of discarding the produto.
- `importCore.ts` — the pure write-plan assembly (create vs fill-nulls, gating,
  link doc). ⚠️ Inventoried in `reserva-arithmetic-inventory.test.js` — it reads
  `args.existingEstoqueReservada` without ever naming the identifier (#931).
- `importVariations.ts` — variation-children orchestration (child produto +
  `variacaoMercadoLivre` + estoque), including User-Products. **No direct test
  sibling** — exercised through `import.test.ts`.
- `importFamily.ts` — one member id → the User-Products family's sibling ids.
- `importCategoria.ts` — builds the ERP Categoria ancestor chain from
  `path_from_root`.
- `importPhotos.ts` — downloads listing photos into Storage/Arquivos and appends
  to `produto.fotos`.
- `importTaxonomia.ts` — IO for the taxonomy resolver: loads
  `grupoDeVariacoes` candidates, runs `planTaxonomia`, persists misses.
- `importMigration.ts` — the User-Products (UPtin) migration handler;
  re-imports migrated members onto the same ERP produtos.
- `taxonomiaCore.ts` — the pure ML → ERP taxonomy resolver
  (`attribute_combinations[]` → grupoDeVariacoes / Variante).
