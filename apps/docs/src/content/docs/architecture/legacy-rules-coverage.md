---
title: Legacy ruleset coverage
description: Which Flutter-era Firestore collections the generated ruleset does not grant.
---

:::caution[Generated file]
Produced by `pnpm --filter @delfrance/rules-gen report:legacy-coverage`, which needs
the gitignored `.old/` checkout. Do not hand-edit.
:::

A Firestore database has exactly one ruleset. When the generated `firestore.rules`
replaces the legacy Flutter one, every collection listed as **not covered** below
becomes default-denied for the still-running Flutter client — silently. This page is
the mechanical diff behind that cutover decision (issue #783).

**71 of 149** legacy match blocks have no counterpart in the
generated ruleset.

> The **Flutter client usage** column is a heuristic: it maps each legacy block to the
> Dart model behind its `permCode`, then looks for references under `.old/lib` (the
> Flutter app), skipping generated `*.g.dart`. "backend only" means the model is used
> exclusively by the Cloud Run / Functions code, which runs on the Admin SDK and
> bypasses rules — so losing the rules block costs nothing. **Confirm before acting:**
> a model reached indirectly through a shared package will read as backend-only.

## Not covered by the generated ruleset

| Collection | Kind | Legacy perm | Actions | Flutter client usage |
| --- | --- | --- | --- | --- |
| `algolia` | collection | `AG1` | read, create, update, delete | `Algolia` — `lib/global/search/providers/algoliaProvider.dart`, `lib/produtos/pages/produtoTableView.dart` |
| `balanco` | collection | `be22` | read, create, update, delete | `BalancoEstoque` — `lib/produtos/models.dart`, `lib/produtos/pages/balancoEstoque.dart` |
| `balanco/*/movimento` | collection | `be23` | read, create, update, delete | `MovimentoBalancoEstoque` — `lib/produtos/models.dart`, `lib/produtos/pages/balancoEstoque.dart` |
| `balanco/*/relatorio` | collection | `be25` | read, create, update, delete | `RelatorioBalanco` — `lib/produtos/pages/balancoEstoque.dart` |
| `cargo` | collection | `u1` | read, create, update, delete | `Cargo` — `lib/user/pages/cargo.dart`, `lib/user/pages/cargoTableView.dart`, `lib/user/pages/novo_user_interno.dart` +2 more |
| `categorias/*/categorialojaintegrada` | collection | `l2` | read, create, update, delete | `CategoriaLojaIntegrada` — **backend only** |
| `chat/*/resumo` | collection | `ar` | read, create, update, delete | `ResumoIa` — **backend only** |
| `CMUN` | collection | `c2` | read, create, update, delete | `TabelaoCmun` — `lib/clientes/etc.dart` |
| `etiquetas` | collection | `et0` | read, create, update, delete | `TelaEtiqueta` — `lib/etiquetas/models.dart`, `lib/produtos/pages/etiquetas.dart` |
| `filiais/*/certificados` | collection | `cer` | read, create, update, delete | `CertificadoDigital` — `lib/grupoEconomico/pages/filiaisTableView.dart` |
| `filiais/*/enviNfe/*/epec` | collection | `ep1` | read, create, update, delete | `EpecMsg` — **backend only** |
| `filiais/*/logo` | collection | — | read, delete, write, update | — |
| `filiais/*/nfe` | collection | `nf0` | read, create, update, delete | `NFeConfig` — `lib/grupoEconomico/pages/filiaisTableView.dart`, `lib/nfe/models.dart` |
| `grupoeconomico` | collection | `g0` | read, create, update, delete | `GrupoEconomico` — `lib/grupoEconomico/models.dart`, `lib/user/providers/auth.dart` |
| `grupoeconomico/*/grupPriv` | collection | `g2` | read, create, update, delete | `GrupoEconomcioPrivateData` — **backend only** |
| `integracao/*/actokshopee` | collection | `S2` | read, create, update, delete | `AcessTokenShopee` — `lib/canaisDeVenda/shopee/pages/contaCadastro.dart` |
| `integracao/*/notification` | collection | `iN` | read, create, update, delete | `NotificationMagalu` — **backend only** |
| `integracao/*/pagina` | collection | `wa2` | read, create, update, delete | `Conta_Pagina` — `lib/chat/providers/conversaProvider.dart`, `lib/facebook/providers/messager.dart` |
| `integracao/*/pedManager` | collection | `lm` | read, create, update, delete | `ContaIntegradaPedidoManager` — **backend only** |
| `integracao/*/pushshopee` | collection | `SP` | read, create, update, delete | `PushShopee` — **backend only** |
| `integracao/*/token` | collection | `fbt` | read, create, update, delete | `TokenFacebook` — `lib/facebook/providers/messager.dart` |
| `integracao/*/tokenMagalu` | collection | `iT` | read, create, update, delete | `TokenContaMagalu` — `lib/canaisDeVenda/magalu/pages/cadastroConta.dart` |
| `integracao/*/tokenoaut` | collection | `J3` | read, create, update, delete | `TokenOauthAmazon` — `lib/canaisDeVenda/amazon/pages/cadastroConta.dart` |
| `integracoes/*/pagina` | collection | — | read, write, update, delete | — |
| `integracoes/*/token` | collection | — | read, write, update, delete | — |
| `integracoes/*/whatsapp` | collection | — | read, write, update, delete | — |
| `metodo_pgto/*/token6hmp` | collection | `pn` | read, create, update, delete | `Token6hMercadoPago` — `lib/pagamento_integracoes/mercadoPago/pages/tokenInicial.dart` |
| `metodo_pgto/*/tokenDuravelmp` | collection | `po` | read, create, update, delete | `TokenDuravelMercadoPago` — `lib/pagamento_integracoes/mercadoPago/pages/tokenInicial.dart` |
| `notificacoesMercadoPago` | collection | `mp` | read, create, update, delete | `NotificacoesMercadoPagoRaw` — **backend only** |
| `pedidos/*/checkin` | collection | `pi` | read, create, update, delete | `CheckinFretePedido` — `lib/despacho/pages/checkin.dart` |
| `pedidos/*/linkPgtoMercadoPago` | collection | `mx` | read, create, update, delete | `LinkPagamentoMercadoPago` — `lib/pagamento/models.dart`, `lib/pedido/pages/pagamento.dart` |
| `pedidos/*/nfev4/*/cancelamento` | collection | `can` | read, create, update, delete | `CancelamentoNFeMsg` — `lib/nfe/pages/cancelamentoNFe.dart`, `lib/pedido_nfe/models.dart` |
| `pedidos/*/nfev4/*/cce` | collection | `cce` | read, create, update, delete | `CartaDeCorrecao` — `lib/nfe/pages/cartaCorrecao.dart`, `lib/pedido_nfe/models.dart` |
| `pedidos/*/pagamentos/*/histpgto` | collection | `ph` | read, create, update, delete | `HistoricoPagamentoPedido` — `lib/pagamento/historicoPagamentoWidget.dart` |
| `pedidos/*/pedshopee` | collection | `S5` | read, create, update, delete | `PedidoShopee` — **backend only** |
| `produtos/*/fotos` | collection | `15` | read, create, update, delete | `Foto` — `lib/produtos/models.dart`, `lib/relatorios/pages/relatorioProdutosMaisVendidos.dart`, `lib/storage/providers/fotos.dart` |
| `publicacao` | collection | `wa4` | read, create, update, delete | `Publicacao` — `lib/chat/menu_lateral.dart`, `lib/chat/providers/conversaProvider.dart` |
| `publicacao/*/comentarios` | collection | `wa5` | read, create, update, delete | `Comentario` — `lib/chat/conversa.dart`, `lib/chat/menu_lateral.dart`, `lib/chat/providers/conversaProvider.dart` +2 more |
| `user` | collection | `u2` | read, create, update, delete | `Usuario` — `lib/chat/basico/conversa_popup_menu.dart`, `lib/chat/conversa.dart`, `lib/chat/menu_lateral.dart` +15 more |
| `webchat` | collection | `w1` | read, create, update, delete | `Webchat` — `lib/menuLateral/homeMenu.dart`, `lib/webchat/models.dart`, `lib/webchat/pages/conta.dart` +1 more |
| `actokshopee` | collection group | `S2` | read | `AcessTokenShopee` — `lib/canaisDeVenda/shopee/pages/contaCadastro.dart` |
| `cancelamento` | collection group | `can` | read | `CancelamentoNFeMsg` — `lib/nfe/pages/cancelamentoNFe.dart`, `lib/pedido_nfe/models.dart` |
| `categorialojaintegrada` | collection group | `l2` | read | `CategoriaLojaIntegrada` — **backend only** |
| `cce` | collection group | `cce` | read | `CartaDeCorrecao` — `lib/nfe/pages/cartaCorrecao.dart`, `lib/pedido_nfe/models.dart` |
| `certificados` | collection group | `cer` | read | `CertificadoDigital` — `lib/grupoEconomico/pages/filiaisTableView.dart` |
| `checkin` | collection group | `pi` | read | `CheckinFretePedido` — `lib/despacho/pages/checkin.dart` |
| `comentarios` | collection group | `wa5` | read | `Comentario` — `lib/chat/conversa.dart`, `lib/chat/menu_lateral.dart`, `lib/chat/providers/conversaProvider.dart` +2 more |
| `epec` | collection group | `ep1` | read | `EpecMsg` — **backend only** |
| `fotos` | collection group | `15` | read | `Foto` — `lib/produtos/models.dart`, `lib/relatorios/pages/relatorioProdutosMaisVendidos.dart`, `lib/storage/providers/fotos.dart` |
| `grupPriv` | collection group | `g2` | read | `GrupoEconomcioPrivateData` — **backend only** |
| `histpgto` | collection group | `ph` | read | `HistoricoPagamentoPedido` — `lib/pagamento/historicoPagamentoWidget.dart` |
| `int_frete` | collection group | `F0` | read | _model not found_ |
| `integracao` | collection group | `i0` | read | _model not found_ |
| `linkPgtoMercadoPago` | collection group | `mx` | read | `LinkPagamentoMercadoPago` — `lib/pagamento/models.dart`, `lib/pedido/pages/pagamento.dart` |
| `logo` | collection group | — | read | — |
| `metodo_pgto` | collection group | `p0` | read | _model not found_ |
| `movimento` | collection group | `be23` | read | `MovimentoBalancoEstoque` — `lib/produtos/models.dart`, `lib/produtos/pages/balancoEstoque.dart` |
| `nfe` | collection group | `nf0` | read | `NFeConfig` — `lib/grupoEconomico/pages/filiaisTableView.dart`, `lib/nfe/models.dart` |
| `notification` | collection group | `iN` | read | `NotificationMagalu` — **backend only** |
| `pagina` | collection group | `wa2` | read | `Conta_Pagina` — `lib/chat/providers/conversaProvider.dart`, `lib/facebook/providers/messager.dart` |
| `pedManager` | collection group | `lm` | read | `ContaIntegradaPedidoManager` — **backend only** |
| `pedshopee` | collection group | `S5` | read | `PedidoShopee` — **backend only** |
| `pushshopee` | collection group | `SP` | read | `PushShopee` — **backend only** |
| `relatorio` | collection group | `be25` | read | `RelatorioBalanco` — `lib/produtos/pages/balancoEstoque.dart` |
| `resumo` | collection group | `ar` | read | `ResumoIa` — **backend only** |
| `token` | collection group | `fbt` | read | `TokenFacebook` — `lib/facebook/providers/messager.dart` |
| `token6hmp` | collection group | `pn` | read | `Token6hMercadoPago` — `lib/pagamento_integracoes/mercadoPago/pages/tokenInicial.dart` |
| `tokenDuravelmp` | collection group | `po` | read | `TokenDuravelMercadoPago` — `lib/pagamento_integracoes/mercadoPago/pages/tokenInicial.dart` |
| `tokenMagalu` | collection group | `iT` | read | `TokenContaMagalu` — `lib/canaisDeVenda/magalu/pages/cadastroConta.dart` |
| `tokenoaut` | collection group | `J3` | read | `TokenOauthAmazon` — `lib/canaisDeVenda/amazon/pages/cadastroConta.dart` |
| `whatsapp` | collection group | — | read | — |

## Covered

| Collection | Kind | Legacy perm | Actions | Flutter client usage |
| --- | --- | --- | --- | --- |
| `arquivos` | collection | `q1` | read, create, update, delete | `Arquivo` — `lib/canaisDeVenda/amazon/pages/importarProdutos.dart`, `lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart`, `lib/chat/basico/chat_input.dart` +19 more |
| `bandeirasCartao` | collection | `pb` | read, create, update, delete | `BandeiraCartao` — `lib/pagamento/widgets/cartao_credito.dart`, `lib/pagamento/widgets/cartao_debito.dart`, `lib/pedido/models.dart` +1 more |
| `categorias` | collection | `13` | read, create, update, delete | `Categoria` — `lib/canaisDeVenda/amazon/pages/linkVariacoes.dart`, `lib/canaisDeVenda/lojaIntegrada/pages/cadastroProduto2.dart`, `lib/canaisDeVenda/mercadoLivre/api.dart` +10 more |
| `categorias/*/imposto` | collection | `1pc` | read, create, update, delete | `ImpostoCategoria` — **backend only** |
| `chat` | collection | `a2` | read, create, update, delete | `Conversa` — `lib/chat/basico/chat_input.dart`, `lib/chat/basico/conversa_popup_menu.dart`, `lib/chat/basico/mensagem.dart` +7 more |
| `chat/*/mensagem` | collection | `a1` | read, create, update, delete | `Mensagem` — `lib/canaisDeVenda/atualizarPreco.dart`, `lib/chat/basico/conversa_popup_menu.dart`, `lib/chat/basico/mensagem.dart` +10 more |
| `clientes` | collection | `c0` | read, create, update, delete | `Cliente` — `lib/chat/conversa.dart`, `lib/chat/providers/old/chat.dart`, `lib/clientes/models.dart` +9 more |
| `clientes/*/enderecos` | collection | `c1` | read, create, update, delete | `Categoria` — `lib/canaisDeVenda/amazon/pages/linkVariacoes.dart`, `lib/canaisDeVenda/lojaIntegrada/pages/cadastroProduto2.dart`, `lib/canaisDeVenda/mercadoLivre/api.dart` +10 more |
| `depositos` | collection | `17` | read, create, update, delete | `Deposito` — `lib/canaisDeVenda/pages/seletorDeIntegracao.dart`, `lib/produtos/models.dart`, `lib/produtos/pages/balancoEstoque.dart` +4 more |
| `filiais` | collection | `g1` | read, create, update, delete | `Filial` — `lib/grupoEconomico/models.dart`, `lib/grupoEconomico/pages/filiaisTableView.dart`, `lib/grupoEconomico/widgets.dart` +2 more |
| `filiais/*/enviNfe` | collection | `nf1` | read, create, update, delete | `EnviNFeMsg` — **backend only** |
| `filiais/*/inutilizacao` | collection | `inu` | read, create, update, delete | `InutNumeracao` — `lib/nfe/models.dart`, `lib/nfe/pages/inutNFe.dart` |
| `grupoDeVariacoes` | collection | `20` | read, create, update, delete | `GrupoDeVariacoes` — `lib/canaisDeVenda/amazon/pages/linkVariacoes.dart`, `lib/canaisDeVenda/amazon/pages/produtoCadastroAmazon.dart`, `lib/canaisDeVenda/lojaIntegrada/pages/linkadorVariacoesLi.dart` +16 more |
| `int_frete` | collection | `F0` | read, create, update, delete | _model not found_ |
| `int_frete/*/tokenMelEnv` | collection | `M2` | read, create, update, delete | `TokenMelhorEnvio` — **backend only** |
| `integracao` | collection | `i0` | read, create, update, delete | _model not found_ |
| `integracao/*/brandshopee` | collection | `SB` | read, create, update, delete | `BrandShopee` — `lib/canaisDeVenda/shopee/models.dart`, `lib/canaisDeVenda/shopee/pages/contaCadastro.dart`, `lib/canaisDeVenda/shopee/pages/produtoCadastro.dart` +1 more |
| `integracao/*/token6h` | collection | `m1` | read, create, update, delete | `Token6h` — `lib/canaisDeVenda/mercadoLivre/models.dart`, `lib/canaisDeVenda/mercadoLivre/pages/tokenInicial.dart` |
| `integracao/*/tokenDuravel` | collection | `m2` | read, create, update, delete | `TokenDuravel` — `lib/canaisDeVenda/mercadoLivre/api.dart`, `lib/canaisDeVenda/mercadoLivre/models.dart`, `lib/canaisDeVenda/mercadoLivre/pages/tokenInicial.dart` |
| `listaDePrecos` | collection | `10` | read, create, update, delete | `ListaDePrecos` — `lib/canaisDeVenda/pages/recalcularPrecos.dart`, `lib/canaisDeVenda/pages/seletorDeIntegracao.dart`, `lib/pedido/providers/cadastroPedidoProvider.dart` +8 more |
| `metodo_pgto` | collection | `p0` | read, create, update, delete | _model not found_ |
| `motivosincidentes` | collection | `p3` | read, create, update, delete | `MotivoIncidente` — `lib/pedido/models.dart`, `lib/pedido/pages/motivoIncidenteTableView.dart`, `lib/pedido/providers/cadastroPedidoProvider.dart` |
| `notificacoesMercadoLivre` | collection | `m4` | read, create, update, delete | `NotificationMercadoLivre` — `lib/canaisDeVenda/mercadoLivre/models.dart` |
| `operacao` | collection | `p6` | read, create, update, delete | `Operacao` — `lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart`, `lib/despacho/pages/checkin.dart`, `lib/nfe/pages/importarNfe.dart` +7 more |
| `operacao/*/regras` | collection | `1pR` | read, create, update, delete | `RegraImposto` — `lib/pedido/models.dart`, `lib/pedido/pages/operacaoCadastro.dart` |
| `pedidos` | collection | `p8` | read, create, update, delete | `Pedido` — `lib/canaisDeVenda/amazon/dba.dart`, `lib/canaisDeVenda/magalu/utils/gerar_etiqueta_magalu.dart`, `lib/canaisDeVenda/mercadoLivre/models.dart` +29 more |
| `pedidos/*/checkout` | collection | `pc` | read, create, update, delete | `CheckoutFretePedido` — `lib/despacho/pages/checkout.dart`, `lib/despacho/pages/emitirOuImprimirFrete.dart`, `lib/integracoes_frete/melhor_envios/comprar_gerar_imprimir_etiqueta.dart` +3 more |
| `pedidos/*/historicoEstadoPedido` | collection | `p9` | read, create, update, delete | `HistoricoEstadosPedido` — `lib/despacho/pages/checkin.dart`, `lib/despacho/pages/checkout.dart`, `lib/pedido/pages/pedidoCadastro.dart` +1 more |
| `pedidos/*/historicoFtIni` | collection | `pf` | read, create, update, delete | `HistoricoAlteracaoFreteInicial` — `lib/despacho/pages/checkin.dart`, `lib/despacho/pages/checkout.dart`, `lib/pedido/pages/pedidoTableView.dart` |
| `pedidos/*/incidentes` | collection | `p4` | read, create, update, delete | `Incidente` — `lib/despacho/pages/checkin.dart`, `lib/despacho/pages/checkout.dart`, `lib/despacho/pages/emitirOuImprimirFrete.dart` +7 more |
| `pedidos/*/nfev4` | collection | `pn0` | read, create, update, delete | `NotaFiscalEletronica` — `lib/despacho/pages/checkout.dart`, `lib/nfe/actions.dart`, `lib/nfe/importarNfeFromXml.dart` +8 more |
| `pedidos/*/orderML` | collection | `ma` | read, create, update, delete | `OrderML` — `lib/canaisDeVenda/mercadoLivre/models.dart`, `lib/pedido/pages/pedidoTableView.dart` |
| `pedidos/*/pagamentos` | collection | `p7` | read, create, update, delete | `Pagamento` — `lib/menuLateral/homeMenu.dart`, `lib/pagamento/historicoPagamentoWidget.dart`, `lib/pagamento_integracoes/seletorDeIntegracaoPagamento.dart` +5 more |
| `produtos` | collection | `14` | read, create, update, delete | `Produto` — `lib/canaisDeVenda/amazon/pages/importarProdutos.dart`, `lib/canaisDeVenda/amazon/pages/produtoCadastroAmazon.dart`, `lib/canaisDeVenda/atualizarPreco.dart` +53 more |
| `produtos/*/estoques` | collection | `18` | read, create, update, delete | `Estoque` — `lib/canaisDeVenda/amazon/pages/importarProdutos.dart`, `lib/canaisDeVenda/mercadoLivre/pages/importacaoProdutoML.dart`, `lib/canaisDeVenda/mercadoLivre/providers/importacao.dart` +13 more |
| `produtos/*/estoques/*/historicoEstoque` | collection | `1h` | read, create, update, delete | `HistoricoEstoque` — `lib/produtos/pages/balancoEstoque.dart`, `lib/produtos/pages/entradaEstoque.dart` |
| `produtos/*/extraData` | collection | `1P` | read, create, update, delete | `ProdutoExtraData` — `lib/canaisDeVenda/amazon/pages/importarProdutos.dart`, `lib/produtos/models.dart`, `lib/produtos/pages/produtoCadastro.dart` +1 more |
| `produtos/*/historicoDeCusto` | collection | `12` | read, create, update, delete | `HistoricoCusto` — **backend only** |
| `produtos/*/historicoDePrecos` | collection | `1hp` | read, create, update, delete | `HistoricoPreco` — `lib/produtos/pages/produtoCadastro.dart` |
| `produtos/*/imposto` | collection | `1p` | read, create, update, delete | `Imposto` — `lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart`, `lib/despacho/pages/checkout.dart`, `lib/produtos/models.dart` +1 more |
| `produtos/*/prodAmazon` | collection | `J4` | read, create, update, delete | `ProdutoAmazon` — `lib/canaisDeVenda/amazon/models.dart`, `lib/canaisDeVenda/amazon/pages/importarProdutos.dart`, `lib/canaisDeVenda/amazon/pages/produtoCadastroAmazon.dart` +4 more |
| `produtos/*/prodshopee` | collection | `S3` | read, create, update, delete | `ProdutoShopee` — `lib/canaisDeVenda/shopee/models.dart`, `lib/canaisDeVenda/shopee/pages/produtoCadastro.dart`, `lib/canaisDeVenda/shopee/routes.dart` +2 more |
| `produtos/*/produtolojaintegrada` | collection | `l3` | read, create, update, delete | `ProdutoIntegrada` — `lib/canaisDeVenda/lojaIntegrada/models.dart`, `lib/canaisDeVenda/lojaIntegrada/pages/old/cadastroProduto.dart`, `lib/canaisDeVenda/lojaIntegrada/pages/SeletorDeProdutosLojaIntegradaView.dart` +5 more |
| `produtos/*/produtoMagalu2` | collection | `i3` | read, create, update, delete | `ProdutoMagalu` — `lib/canaisDeVenda/magalu/models.dart`, `lib/canaisDeVenda/magalu/pages/produtoCadastro.dart`, `lib/canaisDeVenda/magalu/pages/seletorProdutoMagalu.dart` +4 more |
| `produtos/*/produtoMercadoLivre` | collection | `m6` | read, create, update, delete | `ProdutoMercadoLivre` — `lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart`, `lib/canaisDeVenda/mercadoLivre/pages/cadastroProdutoMLNew.dart`, `lib/canaisDeVenda/mercadoLivre/pages/table.dart` +5 more |
| `produtos/*/variacaoMercadoLivre` | collection | `m7` | read, create, update, delete | `VariacoesML` — `lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart`, `lib/canaisDeVenda/mercadoLivre/pages/cadastroProdutoMLNew.dart`, `lib/canaisDeVenda/mercadoLivre/providers/cadastro.dart` +3 more |
| `produtos/*/variashopee` | collection | `S4` | read, create, update, delete | `VariacaoShopee` — `lib/produtos/providers/produtoTableProvider.dart` |
| `questionsML` | collection | `mb` | read, create, update, delete | `QuestionML` — **backend only** |
| `tabMedi` | collection | `21` | read, create, update, delete | `TabelaDeMedidas` — `lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart`, `lib/moda/models.dart`, `lib/moda/pages/medidasCadastro.dart` +3 more |
| `brandshopee` | collection group | `SB` | read | `BrandShopee` — `lib/canaisDeVenda/shopee/models.dart`, `lib/canaisDeVenda/shopee/pages/contaCadastro.dart`, `lib/canaisDeVenda/shopee/pages/produtoCadastro.dart` +1 more |
| `checkout` | collection group | `pc` | read | `CheckoutFretePedido` — `lib/despacho/pages/checkout.dart`, `lib/despacho/pages/emitirOuImprimirFrete.dart`, `lib/integracoes_frete/melhor_envios/comprar_gerar_imprimir_etiqueta.dart` +3 more |
| `enderecos` | collection group | `c1` | read | `Categoria` — `lib/canaisDeVenda/amazon/pages/linkVariacoes.dart`, `lib/canaisDeVenda/lojaIntegrada/pages/cadastroProduto2.dart`, `lib/canaisDeVenda/mercadoLivre/api.dart` +10 more |
| `enviNfe` | collection group | `nf1` | read | `EnviNFeMsg` — **backend only** |
| `estoques` | collection group | `18` | read | `Estoque` — `lib/canaisDeVenda/amazon/pages/importarProdutos.dart`, `lib/canaisDeVenda/mercadoLivre/pages/importacaoProdutoML.dart`, `lib/canaisDeVenda/mercadoLivre/providers/importacao.dart` +13 more |
| `extraData` | collection group | `1P` | read | `ProdutoExtraData` — `lib/canaisDeVenda/amazon/pages/importarProdutos.dart`, `lib/produtos/models.dart`, `lib/produtos/pages/produtoCadastro.dart` +1 more |
| `historicoDeCusto` | collection group | `12` | read | `HistoricoCusto` — **backend only** |
| `historicoDePrecos` | collection group | `1hp` | read | `HistoricoPreco` — `lib/produtos/pages/produtoCadastro.dart` |
| `historicoEstadoPedido` | collection group | `p9` | read | `HistoricoEstadosPedido` — `lib/despacho/pages/checkin.dart`, `lib/despacho/pages/checkout.dart`, `lib/pedido/pages/pedidoCadastro.dart` +1 more |
| `historicoEstoque` | collection group | `1h` | read | `HistoricoEstoque` — `lib/produtos/pages/balancoEstoque.dart`, `lib/produtos/pages/entradaEstoque.dart` |
| `historicoFtIni` | collection group | `pf` | read | `HistoricoAlteracaoFreteInicial` — `lib/despacho/pages/checkin.dart`, `lib/despacho/pages/checkout.dart`, `lib/pedido/pages/pedidoTableView.dart` |
| `imposto` | collection group | `1pc` | read | `ImpostoCategoria` — **backend only** |
| `incidentes` | collection group | `p4` | read | `Incidente` — `lib/despacho/pages/checkin.dart`, `lib/despacho/pages/checkout.dart`, `lib/despacho/pages/emitirOuImprimirFrete.dart` +7 more |
| `inutilizacao` | collection group | `inu` | read | `InutNumeracao` — `lib/nfe/models.dart`, `lib/nfe/pages/inutNFe.dart` |
| `mensagem` | collection group | `a1` | read, create | `Mensagem` — `lib/canaisDeVenda/atualizarPreco.dart`, `lib/chat/basico/conversa_popup_menu.dart`, `lib/chat/basico/mensagem.dart` +10 more |
| `nfev4` | collection group | `pn0` | read | `NotaFiscalEletronica` — `lib/despacho/pages/checkout.dart`, `lib/nfe/actions.dart`, `lib/nfe/importarNfeFromXml.dart` +8 more |
| `orderML` | collection group | `ma` | read | `OrderML` — `lib/canaisDeVenda/mercadoLivre/models.dart`, `lib/pedido/pages/pedidoTableView.dart` |
| `pagamentos` | collection group | `p7` | read | `Pagamento` — `lib/menuLateral/homeMenu.dart`, `lib/pagamento/historicoPagamentoWidget.dart`, `lib/pagamento_integracoes/seletorDeIntegracaoPagamento.dart` +5 more |
| `prodAmazon` | collection group | `J4` | read | `ProdutoAmazon` — `lib/canaisDeVenda/amazon/models.dart`, `lib/canaisDeVenda/amazon/pages/importarProdutos.dart`, `lib/canaisDeVenda/amazon/pages/produtoCadastroAmazon.dart` +4 more |
| `prodshopee` | collection group | `S3` | read | `ProdutoShopee` — `lib/canaisDeVenda/shopee/models.dart`, `lib/canaisDeVenda/shopee/pages/produtoCadastro.dart`, `lib/canaisDeVenda/shopee/routes.dart` +2 more |
| `produtolojaintegrada` | collection group | `l3` | read | `ProdutoIntegrada` — `lib/canaisDeVenda/lojaIntegrada/models.dart`, `lib/canaisDeVenda/lojaIntegrada/pages/old/cadastroProduto.dart`, `lib/canaisDeVenda/lojaIntegrada/pages/SeletorDeProdutosLojaIntegradaView.dart` +5 more |
| `produtoMagalu2` | collection group | `i3` | read | `ProdutoMagalu` — `lib/canaisDeVenda/magalu/models.dart`, `lib/canaisDeVenda/magalu/pages/produtoCadastro.dart`, `lib/canaisDeVenda/magalu/pages/seletorProdutoMagalu.dart` +4 more |
| `produtoMercadoLivre` | collection group | `m6` | read | `ProdutoMercadoLivre` — `lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart`, `lib/canaisDeVenda/mercadoLivre/pages/cadastroProdutoMLNew.dart`, `lib/canaisDeVenda/mercadoLivre/pages/table.dart` +5 more |
| `regras` | collection group | `1pR` | read | `RegraImposto` — `lib/pedido/models.dart`, `lib/pedido/pages/operacaoCadastro.dart` |
| `token6h` | collection group | `m1` | read | `Token6h` — `lib/canaisDeVenda/mercadoLivre/models.dart`, `lib/canaisDeVenda/mercadoLivre/pages/tokenInicial.dart` |
| `tokenDuravel` | collection group | `m2` | read | `TokenDuravel` — `lib/canaisDeVenda/mercadoLivre/api.dart`, `lib/canaisDeVenda/mercadoLivre/models.dart`, `lib/canaisDeVenda/mercadoLivre/pages/tokenInicial.dart` |
| `tokenMelEnv` | collection group | `M2` | read | `TokenMelhorEnvio` — **backend only** |
| `variacaoMercadoLivre` | collection group | `m7` | read | `VariacoesML` — `lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart`, `lib/canaisDeVenda/mercadoLivre/pages/cadastroProdutoMLNew.dart`, `lib/canaisDeVenda/mercadoLivre/providers/cadastro.dart` +3 more |
| `variashopee` | collection group | `S4` | read | `VariacaoShopee` — `lib/produtos/providers/produtoTableProvider.dart` |
