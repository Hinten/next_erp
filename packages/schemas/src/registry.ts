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
import { integracao, brandShopee } from './integracao';
import { cargo } from './cargo';
import { usuario } from './usuario';
import { deposito } from './deposito';
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
  cargo,
  usuario,
  deposito,
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
