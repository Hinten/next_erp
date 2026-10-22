import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOTIVO_RESOLUCAO_RECEITA_KIT } from './receitaKitShopee';
import {
  CANAL_AVISO,
  CANAL_AVISO_LABELS,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  MOTIVO_IMPORTACAO_PARADA_AMAZON,
  MOTIVO_IMPORTACAO_PARADA_LI,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  MOTIVO_REVERSAO_COM_ETIQUETA_LI,
  PENDENCIA_RECLAMACAO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  avisoNaoLido,
  avisoSchema,
  avisosLeituraSchema,
  canalAvisoSchema,
  chaveDeAviso,
  entradaDeLeitura,
  marcarTodosComoLidos,
  motivoFreteNaoSuportadoLiSchema,
  motivoImportacaoParadaAmazonSchema,
  motivoImportacaoParadaLiSchema,
  motivoPedidoContestadoLiSchema,
  motivoReversaoComEtiquetaLiSchema,
  pendenciaReclamacaoSchema,
  rotaInternaSegura,
  situacaoAnuncioForaDaSincronizacaoSchema,
  tipoAvisoSchema,
  urlExternaSegura,
  type Aviso,
  type AvisosLeitura,
  type TipoAviso,
} from './aviso';

const AGORA_US = 1_760_000_000_000_000;

function umAviso(over: Partial<Aviso> = {}): Aviso {
  return avisoSchema.parse({
    tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
    severidade: SEVERIDADE_AVISO.atencao,
    criadoEm: AGORA_US,
    atualizadoEm: AGORA_US,
    ...over,
  });
}

describe('avisoSchema', () => {
  it('fills every optional field with null (never undefined — the SDK rejects it)', () => {
    const parsed = umAviso();
    expect(parsed.canal).toBeNull();
    expect(parsed.motivo).toBeNull();
    expect(parsed.destinatarioUid).toBeNull();
    expect(parsed.urlInterna).toBeNull();
    expect(parsed.urlExterna).toBeNull();
    expect(parsed.prazo).toBeNull();
    expect(parsed.relogioEvento).toBeNull();
    expect(parsed.resolvidoEm).toBeNull();
    expect(parsed.resolucaoMotivo).toBeNull();
    expect(parsed.params).toEqual({});
    expect(parsed.ocorrencias).toBe(1);
  });

  it('keeps `resolvidoEm` a timestamp, not a boolean — it must say HOW LONG it stood', () => {
    const resolvido = umAviso({ resolvidoEm: AGORA_US + 3_600_000_000 });
    expect(resolvido.resolvidoEm).toBe(AGORA_US + 3_600_000_000);
    expect(typeof resolvido.resolvidoEm).toBe('number');
  });

  it('coerces a legacy ms timestamp into µs rather than rendering 1970', () => {
    // `microsSinceEpoch` is tolerant on read; a producer that wrote ms by mistake
    // must not surface as a 1970 date in the panel.
    const parsed = umAviso({ criadoEm: 1_760_000_000_000 });
    expect(parsed.criadoEm).toBe(AGORA_US);
  });
});

describe('TIPO_AVISO_LABELS', () => {
  it('covers every tipo — nothing else fails when a label is missing', () => {
    // `MENSAGENS_POR_TIPO` is total by its `Record<TipoAviso, …>` type, but this
    // map is a bare `as const` handed to `.meta()`: a tipo added without its label
    // typechecks everywhere, so only this test says so.
    expect(Object.keys(TIPO_AVISO_LABELS).sort()).toEqual([...tipoAvisoSchema.options].sort());
    for (const [tipo, label] of Object.entries(TIPO_AVISO_LABELS)) {
      expect(label.trim(), tipo).not.toBe('');
    }
  });

  it('keeps the named-member constant in step with the enum', () => {
    // `satisfies Record<string, TipoAviso>` proves every member is a tipo, not
    // that every tipo has a member.
    expect(Object.keys(TIPO_AVISO).sort()).toEqual([...tipoAvisoSchema.options].sort());
    for (const [nome, valor] of Object.entries(TIPO_AVISO)) expect(valor, nome).toBe(nome);
  });

  it('labels the two dispatch tipos without a provider product name', () => {
    expect(TIPO_AVISO_LABELS.despachoAutomaticoPendente).toBe('Despacho automático pendente');
    expect(TIPO_AVISO_LABELS.etiquetaComPrazo).toBe('Etiqueta com prazo de impressão');
  });

  it('labels the return tipo without a provider name — it is channel-neutral', () => {
    expect(TIPO_AVISO.reclamacaoAguardandoVendedor).toBe('reclamacaoAguardandoVendedor');
    expect(TIPO_AVISO_LABELS.reclamacaoAguardandoVendedor).toBe('Reclamação aguardando o vendedor');
  });

  it('declares the native-kit recipe tipo (Shopee step 19) with its pt-BR label', () => {
    // Shopee-prefixed on purpose: only a Shopee native kit freezes its
    // composition at create, so the condition IS the channel's.
    expect(TIPO_AVISO.shopeeKitReceitaDivergente).toBe('shopeeKitReceitaDivergente');
    expect(tipoAvisoSchema.safeParse('shopeeKitReceitaDivergente').success).toBe(true);
    expect(TIPO_AVISO_LABELS.shopeeKitReceitaDivergente).toBe(
      'Kit da Shopee com composição antiga',
    );
    // Near-miss: the tipo is persisted, so a respelling is a DIFFERENT tipo.
    expect(tipoAvisoSchema.safeParse('shopeeKitReceitaDivergentes').success).toBe(false);
    expect(tipoAvisoSchema.safeParse('kitReceitaDivergente').success).toBe(false);
  });

  it('parses a stored row of the native-kit recipe tipo with its four id params', () => {
    const parsed = umAviso({
      tipo: TIPO_AVISO.shopeeKitReceitaDivergente,
      canal: CANAL_AVISO.shopee,
      params: { kit: 'k1', anuncio: '2500139870', vinculo: 'l1', variacoes: 'c1, c2' },
      urlInterna: { rota: ROTAS_AVISO.produto.build('k1'), campo: 'componentesKit' },
    });
    expect(parsed.tipo).toBe('shopeeKitReceitaDivergente');
    expect(parsed.params).toEqual({
      kit: 'k1',
      anuncio: '2500139870',
      vinculo: 'l1',
      variacoes: 'c1, c2',
    });
    expect(parsed.urlInterna).toEqual({ rota: '/produtos/k1', campo: 'componentesKit' });
  });

  it('names a machine resolver for the native-kit recipe tipo: every motivo the constant defines', () => {
    // The collection is `serverOwned` — an aviso nothing resolves stands until
    // retention — so the tipo's docblock must name each resolution motivo, and
    // it must name exactly the ones `MOTIVO_RESOLUCAO_RECEITA_KIT` defines.
    const FONTE = readFileSync(join(import.meta.dirname, 'aviso.ts'), 'utf8');
    const inicio = FONTE.indexOf('**`shopeeKitReceitaDivergente`**');
    expect(inicio).toBeGreaterThan(-1);
    const fim = FONTE.indexOf('export const tipoAvisoSchema', inicio);
    const bloco = FONTE.slice(inicio, fim);
    expect(bloco).toContain('produced by step 19 (#1527)');
    const motivos = Object.values(MOTIVO_RESOLUCAO_RECEITA_KIT);
    expect(motivos).toHaveLength(5);
    for (const motivo of motivos) expect(bloco, motivo).toContain(`\`${motivo}\``);
  });

  it('labels the link-audit tipo without a provider name — it is channel-neutral', () => {
    expect(TIPO_AVISO.anuncioForaDaSincronizacao).toBe('anuncioForaDaSincronizacao');
    expect(TIPO_AVISO_LABELS.anuncioForaDaSincronizacao).toBe('Anúncio fora da sincronização');
  });

  it('names and labels the two Loja Integrada tipos (step 2)', () => {
    // Channel-SPECIFIC on purpose, unlike the three above: the remedy (only the
    // store owner can generate or renew the token, in the painel) is the
    // channel's own — the `shopeeDesautorizado` choice, not `canalSemCredencial`.
    expect(TIPO_AVISO.lojaIntegradaTokenExpirando).toBe('lojaIntegradaTokenExpirando');
    expect(TIPO_AVISO.lojaIntegradaReconexaoPendente).toBe('lojaIntegradaReconexaoPendente');
    expect(TIPO_AVISO_LABELS.lojaIntegradaTokenExpirando).toBe('Token da Loja Integrada expirando');
    expect(TIPO_AVISO_LABELS.lojaIntegradaReconexaoPendente).toBe(
      'Token da Loja Integrada recusado',
    );
  });

  it('names and labels the Loja Integrada import-stopped tipo (step 3)', () => {
    expect(TIPO_AVISO.lojaIntegradaImportacaoParada).toBe('lojaIntegradaImportacaoParada');
    expect(TIPO_AVISO_LABELS.lojaIntegradaImportacaoParada).toBe(
      'Importação de pedidos da Loja Integrada parada',
    );
    // Near-miss spellings are other tipos — refused by the enum, never folded.
    for (const quase of ['lojaIntegradaImportacaoParado', 'lojaintegradaImportacaoParada']) {
      expect(tipoAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('parses an import-stopped plano as stored: critico, the conta route, a clock', () => {
    const parsed = umAviso({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', motivo: MOTIVO_IMPORTACAO_PARADA_LI.filtroIgnorado },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      relogioEvento: 1_800_000_000_654_321,
    });
    expect(parsed).toMatchObject({
      tipo: 'lojaIntegradaImportacaoParada',
      severidade: 'critico',
      canal: 'lojaIntegrada',
      params: { loja: 'Conta A', motivo: 'filtro-ignorado' },
      relogioEvento: 1_800_000_000_654_321,
    });
    expect(parsed.urlInterna?.rota).toBe('/canais/loja-integrada/int-1');
  });

  it('names and labels the four Amazon tipos (step 2)', () => {
    expect(TIPO_AVISO.amazonReconexaoPendente).toBe('amazonReconexaoPendente');
    expect(TIPO_AVISO.amazonReautorizacaoExpirando).toBe('amazonReautorizacaoExpirando');
    expect(TIPO_AVISO.amazonSegredoLwaExpirando).toBe('amazonSegredoLwaExpirando');
    expect(TIPO_AVISO.amazonSegredoLwaRecusado).toBe('amazonSegredoLwaRecusado');
    expect(TIPO_AVISO_LABELS.amazonReconexaoPendente).toBe('Autorização da Amazon recusada');
    expect(TIPO_AVISO_LABELS.amazonReautorizacaoExpirando).toBe('Autorização da Amazon expirando');
    expect(TIPO_AVISO_LABELS.amazonSegredoLwaExpirando).toBe(
      'Segredo do aplicativo da Amazon expirando',
    );
    expect(TIPO_AVISO_LABELS.amazonSegredoLwaRecusado).toBe(
      'Segredo do aplicativo da Amazon recusado',
    );
    // Near-miss spellings are other tipos — refused by the enum, never folded.
    for (const quase of [
      'amazonReconexaoPendentes',
      'AmazonReconexaoPendente',
      'amazonSegredoLWAExpirando',
      'amazonSegredoExpirando',
    ]) {
      expect(tipoAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('names a machine resolver for every Amazon tipo in its docblock', () => {
    // `avisos` is `serverOwned` — an aviso nothing resolves stands until
    // retention — so each tipo's docblock entry must exist and say what closes it.
    const FONTE = readFileSync(join(import.meta.dirname, 'aviso.ts'), 'utf8');
    const fim = FONTE.indexOf('export const tipoAvisoSchema');
    for (const tipo of [
      'amazonReconexaoPendente',
      'amazonReautorizacaoExpirando',
      'amazonSegredoLwaExpirando',
      'amazonSegredoLwaRecusado',
      'amazonImportacaoParada',
    ]) {
      const inicio = FONTE.indexOf(`**\`${tipo}\`**`);
      expect(inicio, tipo).toBeGreaterThan(-1);
      expect(inicio, tipo).toBeLessThan(fim);
      const proximo = FONTE.indexOf(' * ---', inicio);
      const bloco = FONTE.slice(inicio, proximo === -1 || proximo > fim ? fim : proximo);
      expect(bloco, tipo).toMatch(/\*\*Machine resolvers?\*\*/);
    }
  });

  it('parses the Amazon planos as stored: per-conta on the conta page, per-app on the list', () => {
    const reconexao = umAviso({
      tipo: TIPO_AVISO.amazonReconexaoPendente,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.amazon,
      params: { loja: 'Conta A', status: 400 },
      motivo: 'invalid_grant',
      urlInterna: { rota: ROTAS_AVISO.canalAmazon.build('int-1'), campo: null },
      relogioEvento: 1_800_000_000_123_456,
    });
    expect(reconexao).toMatchObject({
      canal: 'amazon',
      severidade: 'critico',
      params: { loja: 'Conta A', status: 400 },
      motivo: 'invalid_grant',
      relogioEvento: 1_800_000_000_123_456,
    });
    expect(reconexao.urlInterna?.rota).toBe('/canais/amazon/int-1');

    // The app secret, its date unrecorded: no params at all, routed to the list.
    const segredo = umAviso({
      tipo: TIPO_AVISO.amazonSegredoLwaExpirando,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.amazon,
      urlInterna: { rota: ROTAS_AVISO.canalAmazonLista.build(), campo: null },
    });
    expect(segredo.params).toEqual({});
    expect(segredo.prazo).toBeNull();
    expect(segredo.urlInterna?.rota).toBe('/canais/amazon');
  });
});

describe('amazonImportacaoParada (Amazon step 4)', () => {
  it('names and labels the tipo; near-miss spellings are other tipos', () => {
    expect(TIPO_AVISO.amazonImportacaoParada).toBe('amazonImportacaoParada');
    expect(TIPO_AVISO_LABELS.amazonImportacaoParada).toBe('Importação de pedidos da Amazon parada');
    for (const quase of [
      'amazonImportacaoParado',
      'AmazonImportacaoParada',
      'amazonImportacaoPausada',
      'lojaIntegradaImportacaoParada ',
    ]) {
      expect(tipoAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('parses the producer plano as stored: critico, the conta route, a µs clock', () => {
    const parsed = umAviso({
      tipo: TIPO_AVISO.amazonImportacaoParada,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.amazon,
      params: { loja: 'Conta A', motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.vendedorDuplicado },
      urlInterna: { rota: ROTAS_AVISO.canalAmazon.build('int-1'), campo: null },
      relogioEvento: 1_800_000_000_654_321,
    });
    expect(parsed).toMatchObject({
      tipo: 'amazonImportacaoParada',
      severidade: 'critico',
      canal: 'amazon',
      params: { loja: 'Conta A', motivo: 'vendedor-duplicado' },
      relogioEvento: 1_800_000_000_654_321,
    });
    expect(parsed.urlInterna?.rota).toBe('/canais/amazon/int-1');
  });

  it('keys one row per conta, apart from every other Amazon tipo and from Loja Integrada’s', () => {
    const chave = (tipo: TipoAviso, conta: string) => chaveDeAviso({ tipo, conta });
    expect(chave(TIPO_AVISO.amazonImportacaoParada, 'int-1')).toBe('amazonImportacaoParada:int-1');
    const chaves = [
      chave(TIPO_AVISO.amazonImportacaoParada, 'int-1'),
      chave(TIPO_AVISO.amazonImportacaoParada, 'int-2'),
      chave(TIPO_AVISO.amazonReconexaoPendente, 'int-1'),
      chave(TIPO_AVISO.lojaIntegradaImportacaoParada, 'int-1'),
    ];
    expect(new Set(chaves).size).toBe(chaves.length);
  });
});

describe('MOTIVO_IMPORTACAO_PARADA_AMAZON', () => {
  it('keeps the named-member constant in step with the enum, member for member', () => {
    expect(Object.values(MOTIVO_IMPORTACAO_PARADA_AMAZON).sort()).toEqual(
      [...motivoImportacaoParadaAmazonSchema.options].sort(),
    );
    expect(motivoImportacaoParadaAmazonSchema.options).toHaveLength(13);
  });

  it('near-miss: the UNCOUNTED outcomes are not motivos — they never raise this aviso', () => {
    for (const quase of [
      'conta-parada',
      'segredo-recusado',
      'paginacao-expirada',
      'chamadas-desligadas',
      'lease-ocupado',
      'Limite-de-taxa',
      // Loja Integrada's own motivos are not Amazon's.
      'janela-instavel',
      'filtro-ignorado',
    ]) {
      expect(motivoImportacaoParadaAmazonSchema.safeParse(quase).success, quase).toBe(false);
    }
  });
});

describe('MOTIVO_IMPORTACAO_PARADA_LI', () => {
  it('keeps the named-member constant in step with the enum, member for member', () => {
    expect(Object.values(MOTIVO_IMPORTACAO_PARADA_LI).sort()).toEqual(
      [...motivoImportacaoParadaLiSchema.options].sort(),
    );
    expect(motivoImportacaoParadaLiSchema.options).toHaveLength(13);
  });

  it('near-miss: a parked conta and the switch off are NOT motivos — they never raise this aviso', () => {
    for (const quase of [
      'conta-parada',
      'chamadas-desligadas',
      'conta-inativa',
      'Filtro-ignorado',
    ]) {
      expect(motivoImportacaoParadaLiSchema.safeParse(quase).success, quase).toBe(false);
    }
  });
});

describe('the four Loja Integrada order-import tipos (steps 5–6)', () => {
  const PEDIDO_ID = '0123456789abcdef'.repeat(4);

  it('names and labels each one', () => {
    expect(TIPO_AVISO.lojaIntegradaSituacaoDesconhecida).toBe('lojaIntegradaSituacaoDesconhecida');
    expect(TIPO_AVISO.lojaIntegradaPedidoContestado).toBe('lojaIntegradaPedidoContestado');
    expect(TIPO_AVISO.lojaIntegradaPedidoHub).toBe('lojaIntegradaPedidoHub');
    expect(TIPO_AVISO.lojaIntegradaFreteNaoSuportado).toBe('lojaIntegradaFreteNaoSuportado');
    expect(TIPO_AVISO_LABELS.lojaIntegradaSituacaoDesconhecida).toBe(
      'Situação desconhecida em pedido da Loja Integrada',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaPedidoContestado).toBe(
      'Pedido da Loja Integrada contestado',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaPedidoHub).toBe(
      'Pedido da Loja Integrada vindo de um hub',
    );
    expect(TIPO_AVISO_LABELS.lojaIntegradaFreteNaoSuportado).toBe(
      'Forma de envio da Loja Integrada sem frete utilizável',
    );
  });

  it('near-miss: a multi-shipment order is NOT a tipo — it is a non-blocking incidente', () => {
    // The master plan once listed a multi-shipment aviso; it became an incidente
    // on the pedido (multi-shipment orders are not expected at all).
    for (const quase of ['lojaIntegradaMultiEnvio', 'lojaIntegradaPedidoContestada']) {
      expect(tipoAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('the three order-keyed tipos never share a row for one pedido, nor across contas', () => {
    const chave = (tipo: (typeof TIPO_AVISO)[keyof typeof TIPO_AVISO], conta: string) =>
      chaveDeAviso({ tipo, conta, entidade: PEDIDO_ID });
    const tipos = [
      TIPO_AVISO.lojaIntegradaSituacaoDesconhecida,
      TIPO_AVISO.lojaIntegradaPedidoContestado,
      TIPO_AVISO.lojaIntegradaPedidoHub,
    ];
    expect(new Set(tipos.map((t) => chave(t, 'int-1'))).size).toBe(3);
    expect(chave(TIPO_AVISO.lojaIntegradaPedidoContestado, 'int-1')).toBe(
      `lojaIntegradaPedidoContestado:int-1:${PEDIDO_ID}`,
    );
    expect(chave(TIPO_AVISO.lojaIntegradaPedidoContestado, 'int-1')).not.toBe(
      chave(TIPO_AVISO.lojaIntegradaPedidoContestado, 'int-2'),
    );
  });

  it('why the freight key is a DIGEST: the raw key folds two shipping methods into one row', () => {
    // `.` and `_` are one character to the aviso key, while the mapa keeps the
    // code verbatim — so `1---PAC.X` and `1---PAC_X` (two mapa rows) would
    // collide here. The producer digests the key instead.
    const crua = (chave: string) =>
      chaveDeAviso({
        tipo: TIPO_AVISO.lojaIntegradaFreteNaoSuportado,
        conta: 'int-1',
        entidade: chave,
      });
    expect(crua('1---PAC.X')).toBe(crua('1---PAC_X'));
  });

  it('parses each plano as stored: atencao, the route, an order clock', () => {
    const contestado = umAviso({
      tipo: TIPO_AVISO.lojaIntegradaPedidoContestado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', pedido: '165', motivo: MOTIVO_PEDIDO_CONTESTADO_LI.disputa },
      motivo: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
      urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null },
      relogioEvento: 1_789_000_000_123_456,
    });
    expect(contestado).toMatchObject({
      tipo: 'lojaIntegradaPedidoContestado',
      canal: 'lojaIntegrada',
      params: { loja: 'Conta A', pedido: '165', motivo: 'disputa' },
      motivo: 'disputa',
      relogioEvento: 1_789_000_000_123_456,
    });
    const frete = umAviso({
      tipo: TIPO_AVISO.lojaIntegradaFreteNaoSuportado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: {
        loja: 'Conta A',
        formaEnvio: 'Envio X - pac',
        chave: '1---PAC',
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo,
      },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
    });
    expect(frete.urlInterna?.rota).toBe('/canais/loja-integrada/int-1');
    expect(frete.params.motivo).toBe('alvo-inativo');
  });
});

describe('lojaIntegradaPedidoPagoSemEndereco: a paid order whose retries ran out without an address', () => {
  const PEDIDO_ID = '0123456789abcdef'.repeat(4);

  it('is a tipo, named and labelled', () => {
    expect(TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco).toBe(
      'lojaIntegradaPedidoPagoSemEndereco',
    );
    expect(tipoAvisoSchema.safeParse('lojaIntegradaPedidoPagoSemEndereco').success).toBe(true);
    expect(TIPO_AVISO_LABELS.lojaIntegradaPedidoPagoSemEndereco).toBe(
      'Pedido pago da Loja Integrada sem endereço',
    );
  });

  it('near-miss: a near spelling is no tipo', () => {
    for (const quase of ['lojaIntegradaPedidoSemEndereco', 'lojaIntegradaPedidoPagoSemEndereço']) {
      expect(tipoAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('one row per pedido of the conta, apart from the other order-keyed tipos', () => {
    const chave = (tipo: (typeof TIPO_AVISO)[keyof typeof TIPO_AVISO], conta: string) =>
      chaveDeAviso({ tipo, conta, entidade: PEDIDO_ID });
    expect(chave(TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco, 'int-1')).toBe(
      `lojaIntegradaPedidoPagoSemEndereco:int-1:${PEDIDO_ID}`,
    );
    expect(chave(TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco, 'int-1')).not.toBe(
      chave(TIPO_AVISO.lojaIntegradaPedidoHub, 'int-1'),
    );
  });

  it('parses as stored: critico, the conta page, an order clock', () => {
    const aviso = umAviso({
      tipo: TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', pedido: '165' },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      relogioEvento: 1_789_000_000_123_456,
    });
    expect(aviso).toMatchObject({
      tipo: 'lojaIntegradaPedidoPagoSemEndereco',
      severidade: 'critico',
      params: { loja: 'Conta A', pedido: '165' },
      relogioEvento: 1_789_000_000_123_456,
    });
  });
});

describe('lojaIntegradaReversaoComEtiqueta: a reversal landing on a pedido whose label was bought', () => {
  const PEDIDO_ID = '0123456789abcdef'.repeat(4);

  it('is a tipo, named and labelled', () => {
    expect(TIPO_AVISO.lojaIntegradaReversaoComEtiqueta).toBe('lojaIntegradaReversaoComEtiqueta');
    expect(TIPO_AVISO_LABELS.lojaIntegradaReversaoComEtiqueta).toBe(
      'Pedido da Loja Integrada revertido com etiqueta comprada',
    );
  });

  it('one row per pedido, apart from the contestado row the same refund may raise', () => {
    const chave = (tipo: (typeof TIPO_AVISO)[keyof typeof TIPO_AVISO]) =>
      chaveDeAviso({ tipo, conta: 'int-1', entidade: PEDIDO_ID });
    expect(chave(TIPO_AVISO.lojaIntegradaReversaoComEtiqueta)).toBe(
      `lojaIntegradaReversaoComEtiqueta:int-1:${PEDIDO_ID}`,
    );
    expect(chave(TIPO_AVISO.lojaIntegradaReversaoComEtiqueta)).not.toBe(
      chave(TIPO_AVISO.lojaIntegradaPedidoContestado),
    );
  });

  it('its motivo codes: one per reversal codigo, the constant in step with the enum', () => {
    expect(motivoReversaoComEtiquetaLiSchema.options).toEqual([
      'cancelado',
      'devolvido',
      'chargeback',
      'devolvido-sem-retorno',
    ]);
    expect(Object.values(MOTIVO_REVERSAO_COM_ETIQUETA_LI).sort()).toEqual(
      [...motivoReversaoComEtiquetaLiSchema.options].sort(),
    );
  });

  it('NEAR-MISS: a cancellation REQUEST or a dispute is no reversal; the wire codigos are not the codes', () => {
    for (const quase of ['cancelamento-solicitado', 'disputa', 'pedido_cancelado', 'Cancelado']) {
      expect(motivoReversaoComEtiquetaLiSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('parses as stored: atencao, the pedido page, an order clock', () => {
    const aviso = umAviso({
      tipo: TIPO_AVISO.lojaIntegradaReversaoComEtiqueta,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', pedido: '165', motivo: MOTIVO_REVERSAO_COM_ETIQUETA_LI.cancelado },
      motivo: MOTIVO_REVERSAO_COM_ETIQUETA_LI.cancelado,
      urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null },
      relogioEvento: 1_789_000_000_123_456,
    });
    expect(aviso).toMatchObject({
      tipo: 'lojaIntegradaReversaoComEtiqueta',
      params: { loja: 'Conta A', pedido: '165', motivo: 'cancelado' },
      motivo: 'cancelado',
    });
  });
});

describe('MOTIVO_PEDIDO_CONTESTADO_LI', () => {
  it('keeps the named-member constant in step with the enum, member for member', () => {
    expect(Object.values(MOTIVO_PEDIDO_CONTESTADO_LI).sort()).toEqual(
      [...motivoPedidoContestadoLiSchema.options].sort(),
    );
    expect(motivoPedidoContestadoLiSchema.options).toEqual([
      'disputa',
      'chargeback',
      'devolvido',
      'devolvido-sem-retorno',
    ]);
  });

  it('near-miss: a cancellation is NOT a contest, and the wire codigos are not the codes', () => {
    for (const quase of ['cancelado', 'pedido_chargeback', 'devolvido_sem_retorno', 'Disputa']) {
      expect(motivoPedidoContestadoLiSchema.safeParse(quase).success, quase).toBe(false);
    }
  });
});

describe('MOTIVO_FRETE_NAO_SUPORTADO_LI', () => {
  it('keeps the named-member constant in step with the enum, member for member', () => {
    expect(Object.values(MOTIVO_FRETE_NAO_SUPORTADO_LI).sort()).toEqual(
      [...motivoFreteNaoSuportadoLiSchema.options].sort(),
    );
    expect(motivoFreteNaoSuportadoLiSchema.options).toHaveLength(4);
  });

  it('near-miss: an unmapped method and a deliberate fob/outros mapping are NOT motivos', () => {
    // Neither raises this aviso: the unmapped row is already the operator's to-do,
    // and fob/outros route at label time.
    for (const quase of ['nao-mapeado', 'fob', 'outros', 'sem-int-frete']) {
      expect(motivoFreteNaoSuportadoLiSchema.safeParse(quase).success, quase).toBe(false);
    }
  });
});

describe('CANAL_AVISO', () => {
  it('keeps the named-member constant and the labels in step with the enum', () => {
    // `escreverAviso` full-parses on create, so a canal the enum lacks is a
    // write that throws — and a label the map lacks typechecks everywhere.
    expect(Object.keys(CANAL_AVISO).sort()).toEqual([...canalAvisoSchema.options].sort());
    for (const [nome, valor] of Object.entries(CANAL_AVISO)) expect(valor, nome).toBe(nome);
    expect(Object.keys(CANAL_AVISO_LABELS).sort()).toEqual([...canalAvisoSchema.options].sort());
  });

  it('carries Loja Integrada, spelled exactly — near-miss spellings stay refused', () => {
    expect(CANAL_AVISO.lojaIntegrada).toBe('lojaIntegrada');
    expect(CANAL_AVISO_LABELS.lojaIntegrada).toBe('Loja Integrada');
    for (const quase of ['loja-integrada', 'lojaintegrada', 'LojaIntegrada', 'loja_integrada']) {
      expect(canalAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('carries Amazon, spelled exactly — near-miss spellings stay refused', () => {
    expect(CANAL_AVISO.amazon).toBe('amazon');
    expect(CANAL_AVISO_LABELS.amazon).toBe('Amazon');
    for (const quase of ['Amazon', 'amazonSpApi', 'amazon-sp-api', 'amazon_br']) {
      expect(canalAvisoSchema.safeParse(quase).success, quase).toBe(false);
    }
  });

  it('parses a Loja Integrada plano as stored, keeping canal, route and severity', () => {
    const parsed = umAviso({
      tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', status: 401 },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      relogioEvento: 1_800_000_000_123_456,
    });
    expect(parsed.canal).toBe('lojaIntegrada');
    expect(parsed.severidade).toBe('critico');
    expect(parsed.params).toEqual({ loja: 'Conta A', status: 401 });
    expect(parsed.urlInterna?.rota).toBe('/canais/loja-integrada/int-1');
    expect(parsed.relogioEvento).toBe(1_800_000_000_123_456);
  });
});

describe('PENDENCIA_RECLAMACAO', () => {
  it('keeps the named-member constant in step with the enum, member for member', () => {
    expect(Object.values(PENDENCIA_RECLAMACAO).sort()).toEqual(
      [...pendenciaReclamacaoSchema.options].sort(),
    );
    expect(PENDENCIA_RECLAMACAO).toEqual({
      responderSolicitacao: 'responder-solicitacao',
      responderProposta: 'responder-proposta',
      enviarEvidencias: 'enviar-evidencias',
    });
  });

  it('is CLOSED at three: the pickup is shown on the panel and raises no aviso in v1', () => {
    // `organizar-coleta` is the near-miss: when the seller must act on the
    // reverse pickup is unsettled (register 242), so it is not a pendência.
    expect(pendenciaReclamacaoSchema.options).toHaveLength(3);
    expect(pendenciaReclamacaoSchema.safeParse('organizar-coleta').success).toBe(false);
    expect(pendenciaReclamacaoSchema.safeParse('responder_solicitacao').success).toBe(false);
  });
});

describe('SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO', () => {
  it('is exactly the three findings a human must fix, mirrored member for member', () => {
    expect(situacaoAnuncioForaDaSincronizacaoSchema.options).toEqual([
      'link-em-variacao',
      'pai-id-invalido',
      'produto-ausente',
    ]);
    expect(SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO).toEqual({
      linkEmVariacao: 'link-em-variacao',
      paiIdInvalido: 'pai-id-invalido',
      produtoAusente: 'produto-ausente',
    });
    expect(Object.values(SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO).sort()).toEqual(
      [...situacaoAnuncioForaDaSincronizacaoSchema.options].sort(),
    );
  });

  it('has NO member for the healed class, nor for the walk codes', () => {
    // `conta-fora-do-produto` is the near-miss: the audit re-adds the conta and
    // logs it, so an aviso for it would be one nobody has to act on. The walk's
    // `NAO_ENUMERADO_*` codes are a different set the producer maps FROM — a
    // stored one would mean the mapping was skipped.
    for (const naoMembro of [
      'conta-fora-do-produto',
      'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO',
      'NAO_ENUMERADO_LINK_EM_VARIACAO',
      'link_em_variacao',
    ]) {
      expect(situacaoAnuncioForaDaSincronizacaoSchema.safeParse(naoMembro).success, naoMembro).toBe(
        false,
      );
    }
  });
});

describe('chaveDeAviso — what the fold treats as EQUAL', () => {
  it('collapses the weekly sweep and the provider push for the same expiry window', () => {
    // The Shopee plan has TWO producers for one logical event: the weekly
    // `sweepShopeeAuthorizationExpiry` and Shopee's own `push 12`. They must land
    // on one row, or the operator gets the same warning twice a week.
    const daVarredura = chaveDeAviso({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: 'integracao-1',
      entidade: 'shop-77',
      janela: '2026-11-02',
    });
    const doPush = chaveDeAviso({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: 'integracao-1',
      entidade: 'shop-77',
      janela: '2026-11-02',
    });
    expect(daVarredura).toBe(doPush);
  });

  it('folds a `/` in a segment — an outerRef must not fork a subcollection path', () => {
    // This is the one that would break Firestore outright: the key IS the
    // document id, and `a/b` would address `avisos/a/b`, a subcollection.
    const chave = chaveDeAviso({
      tipo: TIPO_AVISO.pedidoPrecisaDecisao,
      conta: 'documents/usuarios/abc',
      entidade: 'pedido-1',
    });
    expect(chave).not.toContain('/');
    expect(chave).toContain('documents_usuarios_abc');
  });

  it('treats `a/b` and `a_b` as the SAME aviso — an accepted cost of that fold', () => {
    const comBarra = chaveDeAviso({ tipo: TIPO_AVISO.pedidoPrecisaDecisao, conta: 'a/b' });
    const comUnderscore = chaveDeAviso({ tipo: TIPO_AVISO.pedidoPrecisaDecisao, conta: 'a_b' });
    expect(comBarra).toBe(comUnderscore);
  });
});

describe('chaveDeAviso — what must stay DISTINCT (the near-miss half)', () => {
  // A test that the fold APPLIES cannot show where it STOPS. #1372 shipped eight
  // passing mutation tests that all asked "does it fold?" and none "does it fold
  // too much?", and real edits silently reached neither the provider nor
  // Firestore. These are the pairs that must NOT collapse.

  it('separates two expiry windows for the same conta', () => {
    const novembro = chaveDeAviso({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: 'integracao-1',
      janela: '2026-11-02',
    });
    const dezembro = chaveDeAviso({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      conta: 'integracao-1',
      janela: '2026-12-02',
    });
    expect(novembro).not.toBe(dezembro);
  });

  it('separates two violation types on the same item', () => {
    const banido = chaveDeAviso({
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: 'integracao-1',
      entidade: 'item-9:BANNED',
    });
    const deboost = chaveDeAviso({
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: 'integracao-1',
      entidade: 'item-9:DEBOOST',
    });
    expect(banido).not.toBe(deboost);
  });

  it('separates two contas with the same entity id', () => {
    const uma = chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, conta: 'a', entidade: 'x' });
    const outra = chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, conta: 'b', entidade: 'x' });
    expect(uma).not.toBe(outra);
  });

  it('does not let a missing middle segment alias a present one', () => {
    // Without the empty-segment placeholder, `(tipo, null, 'x')` and
    // `(tipo, 'x', null)` would both join to `tipo:x` and silently merge two
    // unrelated events.
    const semConta = chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, entidade: 'x' });
    const semEntidade = chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, conta: 'x' });
    expect(semConta).not.toBe(semEntidade);
  });

  it('separates two tipos sharing every other segment', () => {
    const expirando = chaveDeAviso({ tipo: TIPO_AVISO.shopeeAutorizacaoExpirando, conta: 'i-1' });
    const desautorizado = chaveDeAviso({ tipo: TIPO_AVISO.shopeeDesautorizado, conta: 'i-1' });
    expect(expirando).not.toBe(desautorizado);
  });

  it('does not let a colon INSIDE a segment shift the segment boundaries', () => {
    // The separator is the one character the fold must not leave intact: with `:`
    // untouched, `conta='loja:123'` and `(conta='loja', entidade='123')` produce
    // the same document id, so two unrelated operator events silently become one
    // and `ocorrencias` reads as a plausible repeat. The intended usage already
    // puts colons in segments (see the violation-type pair above), so this is not
    // a contrived input.
    const dentroDeUmSegmento = chaveDeAviso({
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: 'loja:123',
    });
    const emDoisSegmentos = chaveDeAviso({
      tipo: TIPO_AVISO.anuncioComViolacao,
      conta: 'loja',
      entidade: '123',
    });
    expect(dentroDeUmSegmento).not.toBe(emDoisSegmentos);

    const tresSegmentos = chaveDeAviso({
      tipo: TIPO_AVISO.pedidoPrecisaDecisao,
      conta: 'a',
      entidade: 'b',
      janela: 'c',
    });
    const doisComColon = chaveDeAviso({
      tipo: TIPO_AVISO.pedidoPrecisaDecisao,
      conta: 'a:b',
      entidade: 'c',
    });
    expect(tresSegmentos).not.toBe(doisComColon);
  });

  it('does not let a TRAILING colon alias the same segment without one', () => {
    const comDoisPontos = chaveDeAviso({ tipo: TIPO_AVISO.pedidoPrecisaDecisao, conta: 'a:' });
    const sem = chaveDeAviso({ tipo: TIPO_AVISO.pedidoPrecisaDecisao, conta: 'a' });
    expect(comDoisPontos).not.toBe(sem);
  });

  it('refuses a key too long to be a document id instead of writing a broken one', () => {
    expect(() =>
      chaveDeAviso({ tipo: TIPO_AVISO.anuncioComViolacao, entidade: 'x'.repeat(1600) }),
    ).toThrow(RangeError);
  });
});

describe('chaveDeAviso — the two dispatch tipos (Shopee step 15b)', () => {
  // The producer opens `despachoAutomaticoPendente` per PACKAGE per CLASS and
  // `etiquetaComPrazo` per PEDIDO, and the frete callers' resolver must RECOMPUTE
  // the same ids from what it observes: a key it cannot recompute is a row that
  // stands until retention sweeps it.
  const PEDIDO_ID = '0123456789abcdef'.repeat(4); // fixed-length hex, like a Shopee pedido id
  const despacho = (pacote: string, classe: 'nfe' | 'manual') =>
    chaveDeAviso({
      tipo: TIPO_AVISO.despachoAutomaticoPendente,
      conta: 'int-1',
      entidade: `${PEDIDO_ID}:${pacote}`,
      janela: classe,
    });

  it('folds the inner `:` of the entity and keeps the class LAST', () => {
    expect(despacho('OFG000000000001', 'nfe')).toBe(
      `despachoAutomaticoPendente:int-1:${PEDIDO_ID}_OFG000000000001:nfe`,
    );
    // The accepted cost of that fold: `:` and `_` inside the entity are one key.
    // Harmless here — the pedido id is fixed-length hex, so the package number
    // always starts at the same offset and two packages cannot meet.
    expect(
      chaveDeAviso({
        tipo: TIPO_AVISO.despachoAutomaticoPendente,
        conta: 'int-1',
        entidade: `${PEDIDO_ID}_OFG000000000001`,
        janela: 'nfe',
      }),
    ).toBe(despacho('OFG000000000001', 'nfe'));
  });

  it('separates two packages of one pedido — a split order keeps one row per package', () => {
    expect(despacho('OFG000000000001', 'nfe')).not.toBe(despacho('OFG000000000002', 'nfe'));
  });

  it('separates the two classes of one package — a refused arrange after the NF-e is a NEW row', () => {
    expect(despacho('OFG000000000001', 'nfe')).not.toBe(despacho('OFG000000000001', 'manual'));
  });

  it('keys the print alert per PEDIDO, apart from every dispatch row of that pedido', () => {
    const etiqueta = chaveDeAviso({
      tipo: TIPO_AVISO.etiquetaComPrazo,
      conta: 'int-1',
      entidade: PEDIDO_ID,
    });
    expect(etiqueta).toBe(`etiquetaComPrazo:int-1:${PEDIDO_ID}`);
    expect(etiqueta).not.toBe(despacho('OFG000000000001', 'nfe'));
    expect(etiqueta).not.toBe(despacho('OFG000000000001', 'manual'));
  });
});

describe('chaveDeAviso — the return tipo (Shopee step 17)', () => {
  // ONE row per RETURN, keyed on the return id alone. The importer raises and
  // resolves it from two different deliveries, so it must recompute the SAME id
  // from `(integracaoId, returnSn)` every time — a key it cannot recompute is a
  // row nothing ever closes.
  const devolucao = (conta: string, returnSn: string) =>
    chaveDeAviso({ tipo: TIPO_AVISO.reclamacaoAguardandoVendedor, conta, entidade: returnSn });

  it('spells the return id verbatim — an alphanumeric id is never folded', () => {
    expect(devolucao('int-1', '260910ABCDE0001')).toBe(
      'reclamacaoAguardandoVendedor:int-1:260910ABCDE0001',
    );
    expect(devolucao('int-1', '260910ABCDE0001')).toBe(devolucao('int-1', '260910ABCDE0001'));
  });

  it('separates two returns of one pedido, and one return id under two contas', () => {
    expect(devolucao('int-1', '2609100000000001')).not.toBe(devolucao('int-1', '2609100000000002'));
    expect(devolucao('int-1', '2609100000000001')).not.toBe(devolucao('int-2', '2609100000000001'));
  });

  it('never meets the per-pedido decision row — a different tipo, a different row', () => {
    expect(devolucao('int-1', '2609100000000001')).not.toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.pedidoPrecisaDecisao,
        conta: 'int-1',
        entidade: '2609100000000001',
      }),
    );
  });
});

describe('chaveDeAviso — the link-audit tipo (#1200)', () => {
  // ONE row per PRODUTO per conta. The monthly audit stores conta and produto only
  // in the id, reads the open avisos once per run and keeps ONE conta's rows by
  // PARSING the id — exactly three `:` segments, the tipo first, the conta second
  // compared whole — so the shape below is what its resolver reads back.
  const foraDaSincronizacao = (conta: string, produtoId: string) =>
    chaveDeAviso({ tipo: TIPO_AVISO.anuncioForaDaSincronizacao, conta, entidade: produtoId });
  /** The producer's parse of an id against one conta: `<tipo>:<conta>:<produto>`. */
  const daConta = (conta: string, chave: string) => {
    const segmentos = chave.split(':');
    return (
      segmentos.length === 3 &&
      segmentos[0] === chaveDeAviso({ tipo: TIPO_AVISO.anuncioForaDaSincronizacao }) &&
      `${segmentos[0]}:${segmentos[1]}` ===
        chaveDeAviso({ tipo: TIPO_AVISO.anuncioForaDaSincronizacao, conta }) &&
      segmentos[2] !== ''
    );
  };

  it('keeps the conta as the SECOND segment and the produto last, with no janela', () => {
    expect(foraDaSincronizacao('int-1', 'prod-1')).toBe('anuncioForaDaSincronizacao:int-1:prod-1');
    expect(daConta('int-1', foraDaSincronizacao('int-1', 'prod-1'))).toBe(true);
  });

  it('keeps a prefix-sharing conta, another tipo and the bare prefix OUT of the conta’s rows', () => {
    // `c10` shares `c1` as a string prefix; the WHOLE segment tells them apart,
    // and only because the fold never lets a `:` into a segment.
    expect(daConta('c1', foraDaSincronizacao('c10', 'p'))).toBe(false);
    expect(daConta('c1', foraDaSincronizacao('c1:0', 'p'))).toBe(false);
    expect(
      daConta(
        'c1',
        chaveDeAviso({ tipo: TIPO_AVISO.estoqueAcimaDoDisponivel, conta: 'c1', entidade: 'p' }),
      ),
    ).toBe(false);
    expect(
      daConta('c1', chaveDeAviso({ tipo: TIPO_AVISO.anuncioForaDaSincronizacao, conta: 'c1' })),
    ).toBe(false);
    // …while a produtoId carrying a `:` is folded, so its row still parses as the conta's.
    expect(foraDaSincronizacao('c1', 'a:b')).toBe('anuncioForaDaSincronizacao:c1:a_b');
    expect(daConta('c1', foraDaSincronizacao('c1', 'a:b'))).toBe(true);
  });
});

describe('chaveDeAviso — the two Loja Integrada tipos (step 2)', () => {
  // ONE row per CONTA for each tipo: the producers (save, renewal, park, sweep)
  // and the resolvers recompute the key from the integração id alone, so a key
  // they could not recompute would be a row nothing ever closes.
  const expiracao = (conta: string) =>
    chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaTokenExpirando, conta });
  const reconexao = (conta: string) =>
    chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente, conta });

  it('keys each tipo on the conta alone — no janela, so a new expiry date reuses the row', () => {
    expect(expiracao('int-1')).toBe('lojaIntegradaTokenExpirando:int-1');
    expect(reconexao('int-1')).toBe('lojaIntegradaReconexaoPendente:int-1');
    expect(expiracao('int-1')).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.lojaIntegradaTokenExpirando,
        conta: 'int-1',
        entidade: null,
        janela: null,
      }),
    );
  });

  it('separates two contas, and the two tipos of one conta', () => {
    expect(expiracao('int-1')).not.toBe(expiracao('int-2'));
    expect(reconexao('int-1')).not.toBe(reconexao('int-2'));
    expect(expiracao('int-1')).not.toBe(reconexao('int-1'));
  });

  it('the step-3 import-stopped tipo is keyed on the conta alone too, apart from the other two', () => {
    const importacao = (conta: string) =>
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaImportacaoParada, conta });
    expect(importacao('int-1')).toBe('lojaIntegradaImportacaoParada:int-1');
    expect(importacao('int-1')).not.toBe(importacao('int-2'));
    expect(new Set([importacao('int-1'), expiracao('int-1'), reconexao('int-1')]).size).toBe(3);
  });
});

describe('chaveDeAviso — the four Amazon tipos (step 2)', () => {
  // Producers and resolvers recompute these keys from the integração id alone
  // (per conta) or from nothing at all (per application); a key they could not
  // recompute would be a row nothing ever closes.
  const porConta = (tipo: TipoAviso, conta: string) => chaveDeAviso({ tipo, conta });

  it('keys the reconexão and the reauthorization on the conta alone — no janela', () => {
    expect(porConta(TIPO_AVISO.amazonReconexaoPendente, 'int-1')).toBe(
      'amazonReconexaoPendente:int-1',
    );
    expect(porConta(TIPO_AVISO.amazonReautorizacaoExpirando, 'int-1')).toBe(
      'amazonReautorizacaoExpirando:int-1',
    );
    // A reconnect moves the date; the row must stay the same one.
    expect(porConta(TIPO_AVISO.amazonReautorizacaoExpirando, 'int-1')).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.amazonReautorizacaoExpirando,
        conta: 'int-1',
        entidade: null,
        janela: null,
      }),
    );
  });

  it('keys the two app-secret tipos on the tipo alone — one row per application', () => {
    expect(chaveDeAviso({ tipo: TIPO_AVISO.amazonSegredoLwaExpirando })).toBe(
      'amazonSegredoLwaExpirando',
    );
    expect(chaveDeAviso({ tipo: TIPO_AVISO.amazonSegredoLwaRecusado })).toBe(
      'amazonSegredoLwaRecusado',
    );
    expect(chaveDeAviso({ tipo: TIPO_AVISO.amazonSegredoLwaRecusado, conta: null })).toBe(
      'amazonSegredoLwaRecusado',
    );
  });

  it('separates two contas, and every Amazon tipo from the others', () => {
    expect(porConta(TIPO_AVISO.amazonReconexaoPendente, 'int-1')).not.toBe(
      porConta(TIPO_AVISO.amazonReconexaoPendente, 'int-2'),
    );
    const chaves = [
      porConta(TIPO_AVISO.amazonReconexaoPendente, 'int-1'),
      porConta(TIPO_AVISO.amazonReautorizacaoExpirando, 'int-1'),
      chaveDeAviso({ tipo: TIPO_AVISO.amazonSegredoLwaExpirando }),
      chaveDeAviso({ tipo: TIPO_AVISO.amazonSegredoLwaRecusado }),
      porConta(TIPO_AVISO.lojaIntegradaReconexaoPendente, 'int-1'),
    ];
    expect(new Set(chaves).size).toBe(chaves.length);
  });
});

describe('avisoNaoLido', () => {
  const semLeitura: AvisosLeitura = avisosLeituraSchema.parse({});

  it('counts an aviso nobody has read', () => {
    expect(avisoNaoLido(umAviso(), 'a1', semLeitura, 'uid-1')).toBe(true);
  });

  it('ignores a resolved aviso even when unread', () => {
    expect(avisoNaoLido(umAviso({ resolvidoEm: AGORA_US }), 'a1', semLeitura, 'uid-1')).toBe(false);
  });

  it('ignores an aviso addressed to someone else, and keeps a broadcast', () => {
    const deOutro = umAviso({ destinatarioUid: 'uid-2' });
    expect(avisoNaoLido(deOutro, 'a1', semLeitura, 'uid-1')).toBe(false);
    expect(avisoNaoLido(umAviso({ destinatarioUid: 'uid-1' }), 'a1', semLeitura, 'uid-1')).toBe(
      true,
    );
    expect(avisoNaoLido(umAviso({ destinatarioUid: null }), 'a1', semLeitura, 'uid-1')).toBe(true);
  });

  it('honours a per-item read WITHOUT touching the others', () => {
    const leitura = avisosLeituraSchema.parse({
      ultimaVisualizacaoUs: 0,
      lidos: [entradaDeLeitura('a1', AGORA_US)],
    });
    expect(avisoNaoLido(umAviso(), 'a1', leitura, 'uid-1')).toBe(false);
    expect(avisoNaoLido(umAviso(), 'a2', leitura, 'uid-1')).toBe(true);
  });

  it('honours the watermark, and still counts one raised after it', () => {
    const leitura = avisosLeituraSchema.parse({ ultimaVisualizacaoUs: AGORA_US });
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US }), 'a1', leitura, 'uid-1')).toBe(false);
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 1 }), 'a2', leitura, 'uid-1')).toBe(true);
  });

  it('re-alerts a REOPENED aviso the operator had read individually', () => {
    // `escreverAviso` reopens a resolved aviso under the SAME id and stamps a
    // fresh `criadoEm`. The read named the version before that, so it no longer
    // covers this one.
    const leitura = avisosLeituraSchema.parse({
      ultimaVisualizacaoUs: 0,
      lidos: [entradaDeLeitura('a1', AGORA_US)],
    });
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 10 }), 'a1', leitura, 'uid-1')).toBe(true);
  });

  it('keeps a REPEAT read: the same id at the same `criadoEm` stays read', () => {
    // The near-miss of the reopen above. A repeat bumps `ocorrencias` and leaves
    // `criadoEm` alone, and nagging the operator about it again is precisely what
    // dedup exists to stop.
    const leitura = avisosLeituraSchema.parse({
      ultimaVisualizacaoUs: 0,
      lidos: [entradaDeLeitura('a1', AGORA_US)],
    });
    expect(
      avisoNaoLido(umAviso({ criadoEm: AGORA_US, ocorrencias: 7 }), 'a1', leitura, 'uid-1'),
    ).toBe(false);
  });

  it('gives a bare id no credit — the "compatible" check is the bug', () => {
    // `lidos.includes(avisoId)` is what kept a reopened aviso silenced. A bare id
    // names no version, so it cannot say whether it covers the current one.
    const leitura = avisosLeituraSchema.parse({ ultimaVisualizacaoUs: 0, lidos: ['a1'] });
    expect(avisoNaoLido(umAviso(), 'a1', leitura, 'uid-1')).toBe(true);
  });
});

describe('entradaDeLeitura', () => {
  it('is deterministic: the same (id, criadoEm) is the same entry', () => {
    expect(entradaDeLeitura('a1', AGORA_US)).toBe(entradaDeLeitura('a1', AGORA_US));
  });

  it('keeps one microsecond of `criadoEm` apart', () => {
    expect(entradaDeLeitura('a1', AGORA_US)).not.toBe(entradaDeLeitura('a1', AGORA_US + 1));
  });

  it('never aliases two pairs, even for ids that contain `@` and digits', () => {
    // `chaveDeAviso` does not fold `@`, so an id can carry one. The entry stays
    // injective only because a number never stringifies with an `@` in it. The
    // grid needs an id ENDING in a digit: without a separator `('x1', 2)` and
    // `('x', 12)` both spell `x12`, which is what fails if the `@` is ever dropped
    // or swapped for a digit.
    const entradas = new Set<string>();
    for (const id of ['x', 'x1', 'x@1']) {
      for (const criadoEm of [1, 2, 12]) entradas.add(entradaDeLeitura(id, criadoEm));
    }
    expect(entradas.size).toBe(9);
  });
});

describe('marcarTodosComoLidos', () => {
  it('takes the value it is GIVEN — the caller passes a seen `criadoEm`, not a clock', () => {
    // The rows are stamped by a Cloud Function and the panel runs in a browser, so
    // a "now" read here would compare two different clocks and a fast client would
    // mark unraised avisos read.
    const proximo = marcarTodosComoLidos(AGORA_US + 42);
    expect(proximo.ultimaVisualizacaoUs).toBe(AGORA_US + 42);
  });

  it('advances the watermark AND clears `lidos` in the same value', () => {
    // Advancing without clearing grows the array forever; clearing without
    // advancing marks nothing read. Both halves or neither.
    const proximo = marcarTodosComoLidos(AGORA_US);
    expect(proximo).toEqual({ ultimaVisualizacaoUs: AGORA_US, lidos: [] });
  });

  it('leaves an aviso raised AFTER the mark still unread', () => {
    const leitura = marcarTodosComoLidos(AGORA_US);
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 1 }), 'novo', leitura, 'uid-1')).toBe(true);
  });

  it('does not resurrect a stale entry: the clear leaves only the watermark to answer', () => {
    // `chave` is stable, so the same document id comes back when an aviso is
    // re-raised. Once the watermark moves, the per-item entries it replaced must
    // be gone, or the array grows forever and still answers for rows the
    // watermark now owns.
    const antes = avisosLeituraSchema.parse({
      ultimaVisualizacaoUs: 0,
      lidos: [entradaDeLeitura('recorrente', AGORA_US + 5)],
    });
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 5 }), 'recorrente', antes, 'uid-1')).toBe(
      false,
    );

    const depois = marcarTodosComoLidos(AGORA_US);
    expect(avisoNaoLido(umAviso({ criadoEm: AGORA_US + 5 }), 'recorrente', depois, 'uid-1')).toBe(
      true,
    );
  });
});

describe('ROTAS_AVISO', () => {
  it('keeps every `build` output shaped like its `padrao`', () => {
    // Pins the two halves against each other so one cannot be edited alone. The
    // companion test in apps/web asserts each `padrao` is a REAL route directory
    // — that is what turns a rename from "fails nothing" into "fails a test".
    for (const [nome, rota] of Object.entries(ROTAS_AVISO)) {
      const construida = (rota.build as (id?: string) => string)('ID');
      expect(construida.split('/').length, nome).toBe(rota.padrao.split('/').length);
      expect(construida.startsWith('/'), nome).toBe(true);
      expect(construida, nome).not.toContain('undefined');
    }
  });

  it('builds a concrete Shopee conta route', () => {
    expect(ROTAS_AVISO.canalShopee.build('abc')).toBe('/canais/shopee/abc');
  });

  it('builds a concrete Loja Integrada conta route', () => {
    expect(ROTAS_AVISO.canalLojaIntegrada.padrao).toBe('/canais/loja-integrada/[id]');
    expect(ROTAS_AVISO.canalLojaIntegrada.build('abc')).toBe('/canais/loja-integrada/abc');
    expect(rotaInternaSegura(ROTAS_AVISO.canalLojaIntegrada.build('abc'))).toBe(
      '/canais/loja-integrada/abc',
    );
  });

  it('builds the Amazon conta route and the Amazon conta LIST route', () => {
    expect(ROTAS_AVISO.canalAmazon.padrao).toBe('/canais/amazon/[id]');
    expect(ROTAS_AVISO.canalAmazon.build('abc')).toBe('/canais/amazon/abc');
    expect(rotaInternaSegura(ROTAS_AVISO.canalAmazon.build('abc'))).toBe('/canais/amazon/abc');
    // The per-application avisos (the LWA app secret) belong to no conta.
    expect(ROTAS_AVISO.canalAmazonLista.padrao).toBe('/canais/amazon');
    expect(ROTAS_AVISO.canalAmazonLista.build()).toBe('/canais/amazon');
    expect(rotaInternaSegura(ROTAS_AVISO.canalAmazonLista.build())).toBe('/canais/amazon');
  });

  it('lands a dispatch aviso on the checkout, with the pedido id as `?pedido=`', () => {
    expect(ROTAS_AVISO.despachoCheckout.padrao).toBe('/despacho/checkout');
    expect(ROTAS_AVISO.despachoCheckout.build('abc')).toBe('/despacho/checkout?pedido=abc');
    expect(ROTAS_AVISO.despachoCheckout.build('a&b=c d')).toBe(
      '/despacho/checkout?pedido=a%26b%3Dc%20d',
    );
  });

  it('encodes the pedido id, so the checkout reads back exactly the id it was given', () => {
    // The checkout reads `searchParams.get('pedido')` and looks the pedido up by
    // doc id. Unencoded, `&` would end the value early, `#` would start a
    // fragment and `%41`/`+` would decode into another string — each one a
    // lookup of a DIFFERENT pedido, or of none.
    const ids = ['0123456789abcdef'.repeat(4), 'a&b=c', 'a#b', 'a b', 'a+b', 'a/b', 'a?b', '%41'];
    for (const id of ids) {
      const rota = ROTAS_AVISO.despachoCheckout.build(id);
      expect(new URL(rota, 'https://erp.invalid').searchParams.get('pedido'), id).toBe(id);
      expect(rotaInternaSegura(rota), id).toBe(rota);
    }
  });
});

describe('rotaInternaSegura', () => {
  it('accepts a real in-app path', () => {
    expect(rotaInternaSegura('/canais/shopee/abc')).toBe('/canais/shopee/abc');
    expect(rotaInternaSegura('/pedidos/1/editar#fiscal')).toBe('/pedidos/1/editar#fiscal');
  });

  it('refuses a PROTOCOL-RELATIVE path, which starts with `/` but leaves the site', () => {
    // The reason a bare `startsWith('/')` is not the check.
    expect(rotaInternaSegura('//evil.com/x')).toBeNull();
  });

  it('refuses anything that is not a path at all', () => {
    expect(rotaInternaSegura('javascript:alert(1)')).toBeNull();
    expect(rotaInternaSegura('https://evil.com/x')).toBeNull();
    expect(rotaInternaSegura('canais/shopee/abc')).toBeNull();
    expect(rotaInternaSegura(null)).toBeNull();
    expect(rotaInternaSegura('')).toBeNull();
  });

  it('accepts every route the shared builder can emit', () => {
    for (const [nome, rota] of Object.entries(ROTAS_AVISO)) {
      const construida = (rota.build as (id?: string) => string)('ID');
      expect(rotaInternaSegura(construida), nome).toBe(construida);
    }
  });
});

describe('urlExternaSegura', () => {
  const PERMITIDOS = ['shopee.com.br', 'mercadolivre.com.br'];

  it('accepts an https URL on an allowed host and its subdomains', () => {
    expect(urlExternaSegura('https://shopee.com.br/x', PERMITIDOS)).toBe('https://shopee.com.br/x');
    expect(urlExternaSegura('https://seller.shopee.com.br/x', PERMITIDOS)).toBe(
      'https://seller.shopee.com.br/x',
    );
  });

  it('refuses every shape that could execute or leak', () => {
    expect(urlExternaSegura('javascript:alert(1)', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('http://shopee.com.br/x', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('https://evil.com/x', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('nao-e-uma-url', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura(null, PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('', PERMITIDOS)).toBeNull();
  });

  it('refuses a host that merely ENDS with an allowed name', () => {
    // `notshopee.com.br` must not pass a naive `endsWith` check.
    expect(urlExternaSegura('https://notshopee.com.br/x', PERMITIDOS)).toBeNull();
    expect(urlExternaSegura('https://shopee.com.br.evil.com/x', PERMITIDOS)).toBeNull();
  });
});
