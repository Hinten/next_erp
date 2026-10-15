/**
 * The shapes the two size-chart routes ANSWER with (step 18, #1526):
 * `GET /api/marketplace/shopee/tabela-medidas/lista` and `…/detalhe`.
 *
 * ⚠️ NOT declared here. The three envelopes live in `@delfrance/schemas`
 * (`tabelaDeMedidasShopeeDto.ts`), the one package both this app and `apps/web`
 * reach: the routes build their 200s against those types, their tests parse the
 * bodies with those schemas, and the browser parses the same bytes with the
 * SAME schema objects. Before that the browser held a hand-kept copy whose
 * comment said the names matched this file — the #1369 shape the compiler
 * cannot check. This module only keeps the app's import path (`./dto`) stable.
 */
export {
  detalheTabelaMedidasDtoSchema,
  listaTabelasMedidasDtoSchema,
  tabelaMedidasLinhaDtoSchema,
  type DetalheTabelaMedidasDto,
  type ListaTabelasMedidasDto,
  type TabelaMedidasLinhaDto,
} from '@delfrance/schemas';
