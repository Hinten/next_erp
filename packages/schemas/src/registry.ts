import type { z } from 'zod';
import type { DomainSchema } from './types';
import { cliente } from './cliente';
import { endereco } from './endereco';
import {
  produto,
  produtoExtraData,
  estoqueProduto,
  historicoEstoque,
  historicoPreco,
  historicoCusto,
  historicoModificacao,
  PRODUTO_SUBCOLLECTION_DOMAINS,
} from './produto';
import { categoria } from './categoria';
import { intFrete, tokenMelEnv } from './intFrete';
import {
  pedido,
  pagamento,
  metodoPagamento,
  incidente,
  checkout,
  historicoEstadoPedido,
  historicoFtIni,
  orderML,
} from './pedido';
import { counter } from './counter';
import { conversa, mensagem } from './conversa';
import { integracao, brandShopee, token6h, tokenDuravel } from './integracao';
import { notificacaoMercadoLivre } from './notificacaoMercadoLivre';
import { questionMercadoLivre } from './questionMercadoLivre';
import { cargo } from './cargo';
import { cmun } from './cmun';
import { usuario } from './usuario';
import { deposito } from './deposito';
import { balanco, movimentoBalanco, relatorioBalanco } from './balanco';
import { grupoDeVariacoes } from './grupoDeVariacoes';
import { tabelaDeMedidas } from './tabelaDeMedidas';
import { listaDePrecos } from './listaDePrecos';
import { operacao } from './operacao';
import { motivoIncidente } from './motivoIncidente';
import { filial } from './filial';
import { bandeiraCartao } from './bandeiraCartao';
import { nfe } from './nfe';
import { nfeConfig } from './nfeConfig';
import { enviNfeMsg } from './enviNfeMsg';
import { inutNumeracao } from './inutilizacaoNumeracao';
import { cartaCorrecao } from './cartaCorrecao';
import { impostoProduto } from './impostoProduto';
import { impostoCategoria } from './impostoCategoria';
import { regraImposto } from './regraImposto';
import { arquivo } from './storage/arquivo';

/**
 * Every DomainSchema in the package, in barrel-export order. This is the
 * single enumeration the Firestore rules generator (`@delfrance/rules-gen`)
 * walks to emit match blocks — a domain missing here gets NO rules and is
 * therefore denied outright once the generated ruleset deploys.
 *
 * `registry.test.ts` enforces set-equality between this list and every
 * DomainSchema-shaped export in the barrel, so forgetting to register a new
 * domain fails plain `turbo run test`.
 */
export const ALL_DOMAINS: ReadonlyArray<DomainSchema<z.ZodTypeAny>> = [
  cliente,
  endereco,
  produto,
  ...PRODUTO_SUBCOLLECTION_DOMAINS,
  categoria,
  intFrete,
  tokenMelEnv,
  pedido,
  pagamento,
  metodoPagamento,
  incidente,
  checkout,
  historicoEstadoPedido,
  historicoFtIni,
  orderML,
  counter,
  conversa,
  mensagem,
  integracao,
  brandShopee,
  // ⚠️ DUAL-RUN ONLY — remove all four with the Flutter decommission (#829).
  // These are legacy Mercado Livre collections the NEW app touches only through
  // the Admin SDK (or not at all). They are registered so the generated ruleset
  // reproduces the client grants the deployed legacy ruleset already gives the
  // Flutter app, which would otherwise be default-denied on the day we deploy.
  // See #783. `tokenDuravel`/`token6h` are the load-bearing pair (the Flutter
  // OAuth connect screen and every ML action screen read them client-side);
  // `notificacoesMercadoLivre` and `questionsML` are defensive parity.
  token6h,
  tokenDuravel,
  notificacaoMercadoLivre,
  questionMercadoLivre,
  cargo,
  cmun,
  usuario,
  deposito,
  balanco,
  movimentoBalanco,
  relatorioBalanco,
  grupoDeVariacoes,
  tabelaDeMedidas,
  listaDePrecos,
  operacao,
  motivoIncidente,
  filial,
  bandeiraCartao,
  nfe,
  nfeConfig,
  enviNfeMsg,
  inutNumeracao,
  cartaCorrecao,
  impostoProduto,
  impostoCategoria,
  regraImposto,
  historicoPreco,
  historicoCusto,
  historicoModificacao,
  produtoExtraData,
  estoqueProduto,
  historicoEstoque,
  arquivo,
];
