import { describe, expect, it } from 'vitest';
import {
  FORMA_PAGAMENTO,
  FORMA_PAGAMENTO_LABELS,
  STATUS_PAGAMENTO,
  STATUS_PAGAMENTO_LABELS,
  cpfCnpjUtilizavel,
  MODALIDADE_FRETE,
} from '@delfrance/schemas';
import {
  shopeeOrderDetailRowSchema,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import {
  cpfComDvErrado,
  gerarCnpj,
  gerarCpf,
  pontuarCnpj,
  pontuarCpf,
} from '../testing/documentos';
import { FONTE_CPF_SIMULADO, avaliarCapturaComprador, cpfDeTesteUtilizavel } from './comprador';
import {
  ArgumentoInvalidoError,
  SimulacaoCompradorRecusadaError,
  USO_IMPORTAR_PEDIDO,
  capturaTerminalDoPedido,
  decidirColisaoDeDocumento,
  descreverErro,
  exigirDocumentoSemColisao,
  exigirPedidoSemCapturaTerminal,
  exigirPedidoSemVinculoAlheio,
  exigirProjetoDoModoComprador,
  linhaDoCompradorNoPreambulo,
  parseArgsImportarPedido,
  projetoDaCredencial,
  renderCompradorGravado,
  renderResumoPedido,
  resumoDoCompradorGravado,
  resumoDoPedidoArmazenado,
  resumoDoPedidoMapeado,
  resumoDosPagamentosArmazenados,
  resumoDosPagamentosMapeados,
} from './importarPedidoCli';
import { mapearItensShopee } from './itens';
import { mapearFreteInicialShopee } from './orderFreteMapping';
import { mapearPedidoShopee } from './orderMapping';
import { mapearPagamentosShopee } from './pagamentoMapping';

const INT = 'int-1';
const ORDER_SN = '220810QSK8S7BX';
const OBRIGATORIOS = ['--integracao', INT, '--order-sn', ORDER_SN] as const;

/* -------------------------------------------------------------------------- */
/*             the synthetic buyer — every literal that must NOT leak          */
/* -------------------------------------------------------------------------- */

/** Algorithmically valid, and never a real document. */
const CPF_FALSO = '12345678909';
const NOME_FALSO = 'Comprador de Teste';
const TELEFONE_FALSO = '11999999999';
const ENDERECO_FALSO = 'Praca da Se, 100, Centro, Sao Paulo, SP';
const EMAIL_FALSO = 'comprador.teste@example.invalid';
const TITULO_FALSO = 'Vestido Longo Estampado Delfrance';

/** Every literal the redaction must swallow, in one list the tests iterate. */
const PII = [NOME_FALSO, CPF_FALSO, TELEFONE_FALSO, ENDERECO_FALSO, EMAIL_FALSO];

describe('parseArgsImportarPedido', () => {
  it('recusa a linha de comando sem os dois obrigatórios', () => {
    expect(() => parseArgsImportarPedido([])).toThrow(ArgumentoInvalidoError);
    expect(() => parseArgsImportarPedido(['--integracao', INT])).toThrow(/--order-sn/);
    expect(() => parseArgsImportarPedido(['--order-sn', ORDER_SN])).toThrow(/--integracao/);
  });

  it('recusa uma flag sem valor, inclusive quando a próxima palavra é outra flag', () => {
    expect(() => parseArgsImportarPedido(['--integracao', '--order-sn', ORDER_SN])).toThrow(
      /--integracao exige um valor/,
    );
    expect(() => parseArgsImportarPedido([...OBRIGATORIOS, '--project'])).toThrow(
      /--project exige um valor/,
    );
  });

  it('é DRY-RUN por padrão — escrever exige um opt-in explícito', () => {
    const cmd = parseArgsImportarPedido([...OBRIGATORIOS]);
    expect(cmd).toEqual({
      kind: 'importar',
      args: { integracaoId: INT, orderSn: ORDER_SN, live: false, json: false, projectId: null },
    });
  });

  it('--live liga a gravação; --dry-run explícito não muda o padrão', () => {
    const live = parseArgsImportarPedido([...OBRIGATORIOS, '--live']);
    expect(live.kind === 'importar' && live.args.live).toBe(true);

    const seco = parseArgsImportarPedido([...OBRIGATORIOS, '--dry-run']);
    expect(seco.kind === 'importar' && seco.args.live).toBe(false);
  });

  it('recusa --live junto de --dry-run em vez de escolher por precedência', () => {
    expect(() => parseArgsImportarPedido([...OBRIGATORIOS, '--live', '--dry-run'])).toThrow(
      /contraditórios/,
    );
  });

  it('aceita --flag=valor, --json e --project', () => {
    const cmd = parseArgsImportarPedido([
      `--integracao=${INT}`,
      `--order-sn=${ORDER_SN}`,
      '--json',
      '--project=erp-staging',
    ]);
    expect(cmd).toEqual({
      kind: 'importar',
      args: {
        integracaoId: INT,
        orderSn: ORDER_SN,
        live: false,
        json: true,
        projectId: 'erp-staging',
      },
    });
  });

  it('recusa uma opção desconhecida em vez de ignorá-la', () => {
    expect(() => parseArgsImportarPedido([...OBRIGATORIOS, '--forcar'])).toThrow(/--forcar/);
  });

  it('recusa o separador solto que o pnpm repassa, com uma mensagem acionável', () => {
    expect(() => parseArgsImportarPedido(['--', ...OBRIGATORIOS])).toThrow(/Separador/);
  });

  it('--help responde ANTES de exigir qualquer coisa', () => {
    expect(parseArgsImportarPedido(['--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsImportarPedido(['-h'])).toEqual({ kind: 'ajuda' });
    // …e também quando vem depois de argumentos válidos.
    expect(parseArgsImportarPedido([...OBRIGATORIOS, '--help'])).toEqual({ kind: 'ajuda' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                the redaction                                */
/* -------------------------------------------------------------------------- */

/**
 * A BR order carrying every synthetic literal at once — the buyer block, the
 * message box and the item title.
 */
function detalheComPii(): ShopeeOrderDetailRow {
  const base = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
  return {
    ...base,
    region: 'BR',
    buyer_cpf_id: CPF_FALSO,
    // ⚠️ BUYER-authored, and the field the redaction has to reduce to a length:
    // a buyer typing their address into the message box is not hypothetical.
    message_to_seller: `${NOME_FALSO} — ${TELEFONE_FALSO} — ${ENDERECO_FALSO} — ${EMAIL_FALSO}`,
    note: 'entregar pela manhã',
    recipient_address: {
      name: NOME_FALSO,
      phone: TELEFONE_FALSO,
      town: '',
      district: 'Centro',
      city: 'Sao Paulo',
      state: 'SP',
      region: 'BR',
      zipcode: '01001000',
      full_address: ENDERECO_FALSO,
    },
    item_list: (base.item_list ?? []).map((i) => ({ ...i, item_name: TITULO_FALSO })),
  } as ShopeeOrderDetailRow;
}

/**
 * The mapped pedido AND its summary.
 *
 * ⚠️ Both, because a `not.toContain` needs an ANCHOR: if the literal never
 * reached the MAPPED pedido in the first place, every redaction assertion below
 * would pass against a redaction that does nothing at all. The tests assert the
 * literals ARE in `mapeado` before asserting they are NOT in `resumo`.
 */
function mapeadoComPii(): {
  mapeado: ReturnType<typeof mapearPedidoShopee>;
  resumo: ReturnType<typeof resumoDoPedidoMapeado>;
} {
  const detalhe = detalheComPii();
  const watermarkUs = 1_789_000_000_000_000;
  const { frete } = mapearFreteInicialShopee({ detalhe, escrow: null, watermarkUs });
  const mapeados = mapearItensShopee({
    detalhe,
    escrow: null,
    resolucoes: new Map(),
    modalidade: MODALIDADE_FRETE.fob,
    nowUs: watermarkUs,
  });
  const mapeado = mapearPedidoShopee({
    detalhe,
    itens: mapeados.itens,
    descontoTotal: mapeados.dinheiro.descontoTotal,
    frete,
    conta: {
      integracaoPedidoOuterRef: 'documents/integracao/int-1',
      listaDePrecosOuterRef: null,
      operacaoPedidoOuterRef: null,
      modalidadeFreteImportacao: null,
    },
    captura: avaliarCapturaComprador({ detail: detalhe, statusObservado: detalhe.order_status }),
    camposRecusadosExtra: [],
    clientePedidoOuterRef: 'documents/clientes/cli-1',
    enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
    watermarkUs,
  });
  return { mapeado, resumo: resumoDoPedidoMapeado('ped-sha256', mapeado) };
}

describe('resumoDoPedidoMapeado — a redação', () => {
  it('a ÂNCORA: o pedido mapeado carrega mesmo os literais que o resumo tem de sumir', () => {
    const { mapeado } = mapeadoComPii();
    const json = JSON.stringify(mapeado);
    // `observacoesInternas` traz o que o comprador escreveu; `nomeDeVenda`, o
    // título do produto. Sem esta asserção, todo `not.toContain` abaixo passaria
    // igual com uma redação que não faz nada.
    for (const literal of [NOME_FALSO, TELEFONE_FALSO, ENDERECO_FALSO, EMAIL_FALSO, TITULO_FALSO]) {
      expect(json).toContain(literal);
    }
  });

  it('não carrega nome, CPF, telefone, endereço nem e-mail — nem no JSON nem no render', () => {
    const { resumo } = mapeadoComPii();
    const json = JSON.stringify(resumo);
    const texto = renderResumoPedido(resumo).join('\n');
    for (const literal of PII) {
      expect(json).not.toContain(literal);
      expect(texto).not.toContain(literal);
    }
  });

  it('reduz `observacoesInternas` a um NÚMERO de caracteres, e o número é o real', () => {
    const { resumo } = mapeadoComPii();
    // `note` + '\n' + `message_to_seller` — o mapper COMPÕE, nunca interpola.
    const esperado =
      'entregar pela manhã'.length +
      1 +
      `${NOME_FALSO} — ${TELEFONE_FALSO} — ${ENDERECO_FALSO} — ${EMAIL_FALSO}`.length;
    expect(resumo.observacoesInternasChars).toBe(esperado);
    expect(JSON.stringify(resumo)).not.toContain('entregar pela manhã');
  });

  it('omite o título do produto, que não é dado do comprador mas também não se imprime', () => {
    const { resumo } = mapeadoComPii();
    expect(JSON.stringify(resumo)).not.toContain(TITULO_FALSO);
  });

  it('MANTÉM o que precisa continuar visível — a redação não pode apagar o diagnóstico', () => {
    const { resumo } = mapeadoComPii();
    // O veredito da captura é NOME de campo + veredito, nunca um valor: com um
    // CPF válido e um nome limpo esta order CAPTURA, e isso tem de aparecer.
    expect(resumo.capturaComprador.estado).toBe('capturado');
    expect(resumo.capturaComprador.camposRecusados).toEqual([]);
    // Os ids e os refs continuam inteiros — é por eles que se acha o documento.
    expect(resumo.pedidoId).toBe('ped-sha256');
    // O `numero` é o `order_sn` VERBATIM — o da fixture, não o do texto de uso.
    expect(resumo.numero).toBe('260910KJBHUJDM');
    expect(resumo.clientePedidoOuterRef).toBe('documents/clientes/cli-1');
    expect(resumo.enderecoFiscalOuterRef).toBe('documents/clientes/cli-1/enderecos/end-1');
    // …e as linhas continuam com sku, quantidade e preço.
    expect(resumo.itens.length).toBeGreaterThan(0);
    expect(resumo.itens[0]?.quantidade).toBeGreaterThan(0);
  });

  it('carrega o veredito de captura recusada VERBATIM — nomes de campo, nunca valores', () => {
    const detalhe = detalheComPii();
    const mascarado = {
      ...detalhe,
      buyer_cpf_id: '***********',
      recipient_address: { ...detalhe.recipient_address, name: '****' },
    } as ShopeeOrderDetailRow;
    const captura = avaliarCapturaComprador({
      detail: mascarado,
      statusObservado: mascarado.order_status,
    });
    const watermarkUs = 1_789_000_000_000_000;
    const { frete } = mapearFreteInicialShopee({ detalhe: mascarado, escrow: null, watermarkUs });
    const mapeados = mapearItensShopee({
      detalhe: mascarado,
      escrow: null,
      resolucoes: new Map(),
      modalidade: MODALIDADE_FRETE.fob,
      nowUs: watermarkUs,
    });
    const resumo = resumoDoPedidoMapeado(
      'ped-sha256',
      mapearPedidoShopee({
        detalhe: mascarado,
        itens: mapeados.itens,
        descontoTotal: mapeados.dinheiro.descontoTotal,
        frete,
        conta: {
          integracaoPedidoOuterRef: 'documents/integracao/int-1',
          listaDePrecosOuterRef: null,
          operacaoPedidoOuterRef: null,
          modalidadeFreteImportacao: null,
        },
        captura,
        camposRecusadosExtra: ['endereco:sem-cep'],
        clientePedidoOuterRef: null,
        enderecoFiscalOuterRef: null,
        watermarkUs,
      }),
    );
    expect(resumo.capturaComprador.camposRecusados).toContain('nome:mascarado');
    expect(resumo.capturaComprador.camposRecusados).toContain('endereco:sem-cep');
    expect(resumo.capturaComprador.camposRecusadosExtra).toEqual(['endereco:sem-cep']);
    expect(JSON.stringify(resumo)).not.toContain(NOME_FALSO);
  });
});

describe('resumoDoPedidoArmazenado — a redação do documento lido de volta', () => {
  /** A stored pedido carrying PII in a field the summary does not name. */
  function docArmazenado(): Record<string, unknown> {
    return {
      numero: ORDER_SN,
      estado: 'pago',
      lastMarketplaceUpdate: 1_789_000_000_000_000,
      timestamp: 1_788_000_000_000_000,
      valorCobrado: 31.99,
      descontoTotal: 0,
      observacoesInternas: `${NOME_FALSO} ${TELEFONE_FALSO} ${ENDERECO_FALSO}`,
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      ehSaida: true,
      bloquearEmissaoNFe: null,
      error: null,
      marketplace: {
        tipo: 'shopee',
        status: 'READY_TO_SHIP',
        statusEm: 1_789_000_000_000_000,
        pendingTerms: [],
        completedScenario: null,
        cancelReason: null,
        cancelBy: null,
      },
      capturaComprador: {
        estado: 'capturado',
        statusObservado: 'READY_TO_SHIP',
        camposRecusados: [],
        camposRecusadosExtra: [],
        // O latch da transação grava mais campos aqui; nenhum deles é copiado.
        tentativas: 1,
        em: 1_789_000_000_000_000,
      },
      freteInicial: {
        estado: 'iniciado',
        modalidade: '0',
        externalOptionIntegracao: 'shopee',
        externalId: 'PKG-1',
        externalOptionId: '80014',
        valorCobrado: 1.99,
        custoCalculado: 1.99,
        custoFinal: null,
        codRastreio: null,
        prazoDespacho: 1_789_500_000_000_000,
        dataPrevisaoEntrega: null,
        ultimaModificacao: 1_789_000_000_000_000,
        volumes: [{ numero: 'PKG-1', pesoBruto: 0.5, especie: 'pacote' }],
        // Um campo do bloco que a redação NÃO nomeia — e que não pode vazar.
        clienteRecebedorOuterReference: `documents/clientes/${NOME_FALSO}`,
      },
      itens: {
        NONE: [
          {
            ordem: 1,
            mktplaceId: '123-456',
            produtoUid: null,
            sku: 'SKU-1',
            gtin: null,
            precoDeVenda: 15,
            descontoUnitario: 0,
            quantidade: 2,
            nomeDeVenda: TITULO_FALSO,
          },
        ],
      },
      // Campos que o schema do pedido não tem hoje: a lista de permissões é o
      // que impede que um campo novo apareça no output sem ninguém decidir.
      nomeDoComprador: NOME_FALSO,
      emailDoComprador: EMAIL_FALSO,
    };
  }

  it('não carrega nenhum dos literais — nem os de campos que o resumo não nomeia', () => {
    const resumo = resumoDoPedidoArmazenado('ped-sha256', docArmazenado());
    const json = JSON.stringify(resumo);
    const texto = renderResumoPedido(resumo).join('\n');
    for (const literal of [...PII, TITULO_FALSO]) {
      expect(json).not.toContain(literal);
      expect(texto).not.toContain(literal);
    }
  });

  it('lê o que interessa: estado, watermark, frete e as linhas', () => {
    const resumo = resumoDoPedidoArmazenado('ped-sha256', docArmazenado());
    expect(resumo.origem).toBe('armazenado');
    expect(resumo.estadoArmazenado).toBe('pago');
    expect(resumo.alvoEstado).toBeNull();
    expect(resumo.lastMarketplaceUpdateUs).toBe(1_789_000_000_000_000);
    expect(resumo.observacoesInternasChars).toBe(
      `${NOME_FALSO} ${TELEFONE_FALSO} ${ENDERECO_FALSO}`.length,
    );
    expect(resumo.frete?.valorCobrado).toBe(1.99);
    expect(resumo.frete?.volumes).toEqual([{ numero: 'PKG-1', pesoBrutoKg: 0.5 }]);
    expect(resumo.itens).toEqual([
      {
        ordem: 1,
        mktplaceId: '123-456',
        produtoUid: null,
        sku: 'SKU-1',
        gtin: null,
        precoDeVenda: 15,
        descontoUnitario: 0,
        quantidade: 2,
      },
    ]);
  });

  it('sobrevive a um documento com os tipos errados sem inventar valores', () => {
    const resumo = resumoDoPedidoArmazenado('ped-sha256', {
      numero: 42,
      estado: null,
      marketplace: 'não é um objeto',
      capturaComprador: ['também não'],
      freteInicial: null,
      itens: { NONE: 'nem isto é uma lista' },
    });
    expect(resumo.numero).toBeNull();
    expect(resumo.marketplace.status).toBeNull();
    expect(resumo.capturaComprador.camposRecusados).toEqual([]);
    expect(resumo.frete).toBeNull();
    expect(resumo.itens).toEqual([]);
  });

  it('recupera o produtoUid da CHAVE do mapa quando a linha não o repete', () => {
    const resumo = resumoDoPedidoArmazenado('ped-sha256', {
      itens: { 'prod-9': [{ ordem: 2, sku: 'SKU-9', quantidade: 1, precoDeVenda: 10 }] },
    });
    expect(resumo.itens[0]?.produtoUid).toBe('prod-9');
  });
});

describe('descreverErro', () => {
  it('descreve um erro de argumento com a ajuda junto', () => {
    const linhas = descreverErro(new ArgumentoInvalidoError('--order-sn é obrigatório.'));
    expect(linhas[0]).toContain('--order-sn');
    expect(linhas.join('\n')).toContain('--dry-run');
  });

  it('nomeia a CLASSE de um erro qualquer, nunca só a mensagem', () => {
    expect(descreverErro(new TypeError('x is not a function'))[0]).toContain('TypeError');
    expect(descreverErro('caiu')[0]).toContain('caiu');
  });
});

/* -------------------------------------------------------------------------- */
/*                     os pagamentos (#1514, step 6)                           */
/* -------------------------------------------------------------------------- */

/** O CNPJ FICTÍCIO canônico do repo, e um código de autorização inventado. */
const CNPJ_FALSO = '11222333000181';
const CAUT_FALSO = 'AUT-CC-0001';

function linhaCombinadaBR(): ShopeeOrderDetailRow {
  return shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    order_status: 'READY_TO_SHIP',
    region: 'BR',
    pay_time: 1_788_973_353,
    total_amount: 31.99,
    payment_method: 'Combined Payment',
    payment_info: [
      {
        payment_method: 'pix',
        payment_amount: 10,
        card_brand: '',
        transaction_id: 'AUT-PIX-0002',
        payment_processor_register: CNPJ_FALSO,
      },
      {
        payment_method: 'credit_card',
        payment_amount: 21.99,
        card_brand: 'visa',
        transaction_id: CAUT_FALSO,
        payment_processor_register: CNPJ_FALSO,
      },
    ],
  });
}

function mapeadosBR() {
  return mapearPagamentosShopee({
    linha: linhaCombinadaBR(),
    escrow: null,
    valorDoComprador: 31.99,
    watermarkUs: 1_789_000_000_000_000,
    nowUs: 1_789_000_000_000_000,
    contaId: INT,
    orderSn: ORDER_SN,
  });
}

describe('resumoDosPagamentosMapeados', () => {
  it('traz rótulo, valores e o ALVO de status — nunca um veredito', () => {
    const resumos = resumoDosPagamentosMapeados(mapeadosBR());
    expect(resumos).toHaveLength(2);

    const cartao = resumos[0]!;
    expect(cartao.idCampo).toBe(ORDER_SN);
    expect(cartao.formaCodigo).toBe(FORMA_PAGAMENTO.cartao_credito);
    expect(cartao.formaLabel).toBe(FORMA_PAGAMENTO_LABELS[FORMA_PAGAMENTO.cartao_credito]);
    expect(cartao.statusCodigo).toBe(STATUS_PAGAMENTO.aprovado);
    expect(cartao.statusLabel).toBe(STATUS_PAGAMENTO_LABELS[STATUS_PAGAMENTO.aprovado]);
    expect(cartao.valor).toBe(21.99);
    expect(cartao.aVista).toBe(true);
    expect(cartao.bandeira).toBe('01');
    // ⚠️ BOOLEANOS. O CNPJ do processador e o código de autorização NUNCA saem.
    expect(cartao.temCartao).toBe(true);
    expect(cartao.temCnpjInstituicao).toBe(true);
    expect(cartao.temCAut).toBe(true);
    // Nada disto é conhecido antes da escrita.
    expect(cartao.dataCancelamentoUs).toBeNull();
    expect(cartao.temLiquidacao).toBe(false);

    const pix = resumos[1]!;
    expect(pix.idCampo).toBe(`${ORDER_SN}-1`);
    expect(pix.formaCodigo).toBe(FORMA_PAGAMENTO.pix);
    // Pix chega com `card_brand: ''` — que é "nenhuma bandeira", não "desconhecida".
    expect(pix.bandeira).toBeNull();
    expect(pix.temCartao).toBe(true);
  });

  it('⚠️ nem o CNPJ nem o cAut aparecem — nem no objeto, nem nas linhas renderizadas', () => {
    const resumos = resumoDosPagamentosMapeados(mapeadosBR());
    const json = JSON.stringify(resumos);
    expect(json).not.toContain(CNPJ_FALSO);
    expect(json).not.toContain(CAUT_FALSO);
    expect(json).not.toContain('AUT-');

    const texto = renderResumoPedido(
      resumoDoPedidoArmazenado('ped-sha256', { numero: ORDER_SN }),
      resumos,
    ).join('\n');
    expect(texto).toContain('### pagamentos (2)');
    expect(texto).not.toContain(CNPJ_FALSO);
    expect(texto).not.toContain(CAUT_FALSO);
    // …e a âncora: o bloco realmente foi renderizado, senão o negativo é vácuo.
    expect(texto).toContain('cnpj_instituicao=presente');
    expect(texto).toContain('cAut=presente');
  });
});

describe('resumoDosPagamentosArmazenados', () => {
  it('lê o documento gravado, inclusive a liquidação da varredura semanal', () => {
    const [r] = resumoDosPagamentosArmazenados([
      {
        id: 'doc-1',
        data: {
          id: ORDER_SN,
          valor: 31.99,
          forma_de_pagamento: FORMA_PAGAMENTO.pix,
          status_pagamento: STATUS_PAGAMENTO.aprovado,
          parcelas: 1,
          aVista: true,
          tarifas: 1.29,
          cartao: { bandeira: '01', cnpj_instituicao: CNPJ_FALSO, cAut: CAUT_FALSO },
          marketplace: { tarifasBrutas: 1.29 },
          liquidacao: { payoutAmount: 30.7, fonte: 'escrow_list' },
          dataAprovacao: 1_788_973_353_000_000,
        },
      },
    ]);
    expect(r!.docId).toBe('doc-1');
    expect(r!.valor).toBe(31.99);
    expect(r!.tarifas).toBe(1.29);
    expect(r!.tarifasBrutas).toBe(1.29);
    expect(r!.temLiquidacao).toBe(true);
    expect(r!.temCnpjInstituicao).toBe(true);
    expect(r!.temCAut).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CNPJ_FALSO);
    expect(JSON.stringify(r)).not.toContain(CAUT_FALSO);
  });

  it('sobrevive a um documento cru SEM chave nenhuma, sem inventar valores', () => {
    const [r] = resumoDosPagamentosArmazenados([{ id: 'doc-vazio', data: {} }]);
    expect(r).toEqual({
      docId: 'doc-vazio',
      idCampo: null,
      formaCodigo: null,
      formaLabel: null,
      statusCodigo: null,
      statusLabel: null,
      valor: null,
      parcelas: null,
      aVista: null,
      tarifas: null,
      descricaoPagamento: null,
      temCartao: false,
      bandeira: null,
      temCnpjInstituicao: false,
      temCAut: false,
      dataAprovacaoUs: null,
      dataCancelamentoUs: null,
      temLiquidacao: false,
      tarifasBrutas: null,
    });
  });

  it('⚠️ um `forma_de_pagamento` fora do catálogo vira rótulo NULO, nunca um chute', () => {
    const [r] = resumoDosPagamentosArmazenados([{ id: 'x', data: { forma_de_pagamento: 4242 } }]);
    expect(r!.formaCodigo).toBe(4242);
    expect(r!.formaLabel).toBeNull();
  });
});

describe('renderResumoPedido — a seção de pagamentos', () => {
  it('⚠️ OMITIR o argumento não renderiza a seção; um array VAZIO renderiza "(0)"', () => {
    const resumo = resumoDoPedidoArmazenado('ped-sha256', { numero: ORDER_SN });
    // Duas verdades diferentes: "não perguntei" e "perguntei, e não há nenhum".
    expect(renderResumoPedido(resumo).join('\n')).not.toContain('### pagamentos');
    expect(renderResumoPedido(resumo, []).join('\n')).toContain('### pagamentos (0)');
  });
});

describe('o int_frete da conta e o endereço de entrega no resumo (2026-11-18)', () => {
  const REF_CONTA = 'documents/int_frete/shopee-int-1';
  const ENTREGA = 'documents/clientes/cli-1/enderecos/end-1';

  /** The mapped pedido with the conta's ref stamped on its block, as the importer hands it. */
  function mapeadoComRef(ref: string | null): ReturnType<typeof mapearPedidoShopee> {
    const { mapeado } = mapeadoComPii();
    return {
      ...mapeado,
      dados: {
        ...mapeado.dados,
        freteInicial: { ...mapeado.dados.freteInicial, integracaoFreteOuterRef: ref },
      },
    };
  }

  it('o resumo MAPEADO lê as duas refs do bloco mapeado — a entrega é a fiscal', () => {
    const resumo = resumoDoPedidoMapeado('ped-sha256', mapeadoComRef(REF_CONTA));
    expect(resumo.frete?.integracaoFreteOuterRef).toBe(REF_CONTA);
    // `mapearPedidoShopee` copies the fiscal ref into the block.
    expect(resumo.frete?.enderecoFreteOuterReference).toBe(ENTREGA);
    expect(resumo.enderecoFiscalOuterRef).toBe(ENTREGA);
  });

  it('o render MAPEADO mostra a linha `int_frete da conta`, e diz quando não há doc ativo', () => {
    const comRef = renderResumoPedido(
      resumoDoPedidoMapeado('ped-sha256', mapeadoComRef(REF_CONTA)),
    );
    expect(comRef.find((l) => l.includes('int_frete da conta'))).toContain(REF_CONTA);
    expect(comRef.find((l) => l.includes('int_frete da conta'))).toContain('só um pedido NOVO');
    expect(comRef.find((l) => l.includes('endereço de entrega'))).toContain(ENTREGA);
    // The dry-run caveat names the delivery address too: it is the fiscal one,
    // which a dry run never resolves.
    expect(comRef).toContain(
      '     O endereço de entrega do `freteInicial` é o fiscal, então sai nulo também.',
    );

    // QUASE-ERRO: no active doc reads as a sentence, never as a blank or a guess.
    const semRef = renderResumoPedido(resumoDoPedidoMapeado('ped-sha256', mapeadoComRef(null)));
    expect(semRef.find((l) => l.includes('int_frete da conta'))).toContain(
      'nenhum ativo — o pedido fica sem ref',
    );
  });

  it('o resumo ARMAZENADO lê as duas refs do documento, e o render as mostra', () => {
    const resumo = resumoDoPedidoArmazenado('ped-sha256', {
      numero: ORDER_SN,
      freteInicial: {
        estado: 'iniciado',
        integracaoFreteOuterRef: REF_CONTA,
        enderecoFreteOuterReference: ENTREGA,
      },
    });
    expect(resumo.frete?.integracaoFreteOuterRef).toBe(REF_CONTA);
    expect(resumo.frete?.enderecoFreteOuterReference).toBe(ENTREGA);
    const texto = renderResumoPedido(resumo);
    expect(texto.find((l) => l.includes('integracaoFreteOuterRef'))).toContain(REF_CONTA);
    expect(texto.find((l) => l.includes('endereço de entrega'))).toContain(ENTREGA);
    // The stored summary never claims what the CONTA has — only what the pedido holds.
    expect(texto.join('\n')).not.toContain('int_frete da conta');
    expect(texto.join('\n')).not.toContain('então sai nulo também');
  });

  it('QUASE-ERRO: uma ref gravada que não é string vira NULA, sem inventar valor', () => {
    const resumo = resumoDoPedidoArmazenado('ped-sha256', {
      freteInicial: { integracaoFreteOuterRef: 42, enderecoFreteOuterReference: { id: 'x' } },
    });
    expect(resumo.frete?.integracaoFreteOuterRef).toBeNull();
    expect(resumo.frete?.enderecoFreteOuterReference).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*             o modo comprador de TESTE — argumentos e guardas                */
/* -------------------------------------------------------------------------- */

const NOME_TESTE = 'Pessoa Ficticia Sandbox';
const CEP_TESTE = '93847261';
/** Built at RUN time from a 9-digit base — never a committed DV-valid literal. */
const CPF_TESTE = gerarCpf('418209375');

describe('parseArgsImportarPedido — o modo comprador de TESTE', () => {
  it('--importar-cliente sozinho liga o modo, sem endereço e sem substitutos', () => {
    const cmd = parseArgsImportarPedido([...OBRIGATORIOS, '--importar-cliente']);
    expect(cmd.kind === 'importar' && cmd.args.comprador).toEqual({
      nomeTeste: null,
      cepTeste: null,
      cpfTeste: null,
      importarEndereco: false,
    });
  });

  it('aceita cada flag dependente junto de --importar-cliente, nas duas grafias', () => {
    const cmd = parseArgsImportarPedido([
      ...OBRIGATORIOS,
      '--importar-cliente',
      '--importar-endereco',
      '--nome-teste',
      NOME_TESTE,
      `--cep-teste=${CEP_TESTE}`,
    ]);
    expect(cmd.kind === 'importar' && cmd.args.comprador).toEqual({
      nomeTeste: NOME_TESTE,
      cepTeste: CEP_TESTE,
      cpfTeste: null,
      importarEndereco: true,
    });
    const inline = parseArgsImportarPedido([
      ...OBRIGATORIOS,
      '--importar-cliente',
      `--nome-teste=${NOME_TESTE}`,
    ]);
    expect(inline.kind === 'importar' && inline.args.comprador?.nomeTeste).toBe(NOME_TESTE);
  });

  it('QUASE-ERRO: sem o modo, a chave `comprador` NÃO existe — nem como null', () => {
    const cmd = parseArgsImportarPedido([...OBRIGATORIOS, '--live', '--project', 'demo-erp']);
    expect(cmd.kind === 'importar' && 'comprador' in cmd.args).toBe(false);
  });

  it.each([
    ['--importar-endereco', ['--importar-endereco']],
    ['--nome-teste', ['--nome-teste', NOME_TESTE]],
    ['--cep-teste', ['--cep-teste', CEP_TESTE]],
    ['--cpf-teste', ['--cpf-teste', CPF_TESTE]],
    ['--cpf-teste', [`--cpf-teste=${pontuarCpf(CPF_TESTE)}`]],
  ])('recusa %s SEM --importar-cliente — sozinho seria inerte', (flag, extra) => {
    expect(() => parseArgsImportarPedido([...OBRIGATORIOS, ...extra])).toThrow(
      new ArgumentoInvalidoError(`${flag} exige --importar-cliente.`),
    );
  });

  it('recusa um --nome-teste vazio ou só de espaços', () => {
    for (const vazio of ['', '   ']) {
      expect(() =>
        parseArgsImportarPedido([...OBRIGATORIOS, '--importar-cliente', '--nome-teste', vazio]),
      ).toThrow(/--nome-teste exige um valor/);
    }
  });

  it.each(['1234567', '123456789', '0100100A', '01001-000', 'abcdefgh'])(
    'recusa --cep-teste %s — exatamente 8 dígitos',
    (cep) => {
      expect(() =>
        parseArgsImportarPedido([...OBRIGATORIOS, '--importar-cliente', '--cep-teste', cep]),
      ).toThrow(/--cep-teste exige exatamente 8 dígitos/);
    },
  );

  it.each(['--live', '--dry-run', '--json', '--importar-cliente', '--importar-endereco'])(
    'recusa um valor inline numa flag booleana: %s=false NÃO liga nem desliga nada',
    (flag) => {
      const extra = flag === '--importar-endereco' ? ['--importar-cliente'] : [];
      for (const valor of ['false', 'nao', '']) {
        expect(() =>
          parseArgsImportarPedido([...OBRIGATORIOS, ...extra, `${flag}=${valor}`]),
        ).toThrow(new ArgumentoInvalidoError(`${flag} não aceita valor.`));
      }
      // QUASE-ERRO: a flag nua continua aceita.
      expect(() => parseArgsImportarPedido([...OBRIGATORIOS, ...extra, flag])).not.toThrow();
    },
  );

  it('QUASE-ERRO: --live=false recusa em vez de rodar LIVE; --live nu roda', () => {
    expect(() => parseArgsImportarPedido([...OBRIGATORIOS, '--live=false'])).toThrow(
      ArgumentoInvalidoError,
    );
    const cmd = parseArgsImportarPedido([...OBRIGATORIOS, '--live']);
    expect(cmd.kind === 'importar' && cmd.args.live).toBe(true);
  });

  it('uma grafia parecida continua sendo «Opção desconhecida»', () => {
    for (const grafia of ['--importCliente', '--importar-clientes', '--nomeTeste', '--cpfTeste']) {
      expect(() => parseArgsImportarPedido([...OBRIGATORIOS, grafia])).toThrow(
        `Opção desconhecida: ${grafia}`,
      );
    }
  });

  it('⚠️ a recusa de uma opção desconhecida NUNCA repete um valor — nem inline, nem solto', () => {
    for (const cpf of [CPF_TESTE, pontuarCpf(CPF_TESTE)]) {
      // A typo in the flag name, inline value: only the NAME is echoed.
      const inline = mensagemDe(() =>
        parseArgsImportarPedido([...OBRIGATORIOS, '--importar-cliente', `--cpf-test=${cpf}`]),
      );
      expect(inline).toBe('Opção desconhecida: --cpf-test=…');
      // A CPF typed without its flag: refused, and not repeated either.
      const solto = mensagemDe(() =>
        parseArgsImportarPedido([...OBRIGATORIOS, '--importar-cliente', cpf]),
      );
      expect(solto).toMatch(/^Argumento solto, sem flag/);
      for (const m of [inline, solto]) {
        expect(m).not.toContain(cpf);
        expect(m).not.toContain(CPF_TESTE.slice(0, 9));
      }
    }
    // QUASE-ERRO: a flag-shaped unknown token without `=` is still named whole.
    expect(mensagemDe(() => parseArgsImportarPedido([...OBRIGATORIOS, '--forcar']))).toBe(
      'Opção desconhecida: --forcar',
    );
  });

  it('⚠️ um CPF com um traço perdido na frente é VALOR, não flag — e não é repetido', () => {
    const pontuado = pontuarCpf(CPF_TESTE);
    for (const token of [
      `-${pontuado}`,
      `--${CPF_TESTE}`,
      `-${CPF_TESTE}`,
      `--${CPF_TESTE}=x`,
      `--cpf${CPF_TESTE}`,
    ]) {
      const m = mensagemDe(() =>
        parseArgsImportarPedido([...OBRIGATORIOS, '--importar-cliente', token]),
      );
      expect(m).toMatch(/^Argumento solto, sem flag \(o valor não é repetido aqui\)/);
      expect(m).not.toContain(CPF_TESTE);
      expect(m).not.toContain(pontuado);
      expect(m).not.toContain(CPF_TESTE.slice(0, 9));
    }
    // QUASE-ERRO: a flag made of letters and hyphens, single dash included, is still named.
    for (const flag of ['-x', '--cpf-test', '--Importar-Cliente']) {
      expect(mensagemDe(() => parseArgsImportarPedido([...OBRIGATORIOS, flag]))).toBe(
        `Opção desconhecida: ${flag}`,
      );
    }
  });

  it('--help continua respondendo PRIMEIRO, mesmo ao lado de uma flag dependente solta', () => {
    expect(parseArgsImportarPedido(['--help', '--nome-teste', NOME_TESTE])).toEqual({
      kind: 'ajuda',
    });
    expect(parseArgsImportarPedido([...OBRIGATORIOS, '--cep-teste', '1', '-h'])).toEqual({
      kind: 'ajuda',
    });
  });

  it('a ajuda nomeia as cinco flags e não carrega o separador do pnpm', () => {
    for (const flag of [
      '--importar-cliente',
      '--importar-endereco',
      '--nome-teste',
      '--cep-teste',
      '--cpf-teste <cpf>',
    ]) {
      expect(USO_IMPORTAR_PEDIDO).toContain(flag);
    }
    expect(USO_IMPORTAR_PEDIDO).not.toMatch(/ -- /);
    // The staging note and the shell-history warning ride the help itself.
    expect(USO_IMPORTAR_PEDIDO).toContain('No staging o CPF falso já pertence');
    expect(USO_IMPORTAR_PEDIDO).toContain('histórico');
    // ⚠️ …and so does pnpm's own echo of the command line, with the way out:
    // the help must not promise that NO output repeats the digits.
    expect(USO_IMPORTAR_PEDIDO).toContain('o pnpm repete a linha de comando');
    expect(USO_IMPORTAR_PEDIDO).toContain('pnpm -s');
    expect(USO_IMPORTAR_PEDIDO).not.toContain('Nenhuma saída repete');
  });

  it.each([
    ['--nome-teste', `--nome-teste=${NOME_TESTE}`, { nomeTeste: NOME_TESTE }],
    ['--cep-teste', `--cep-teste=${CEP_TESTE}`, { cepTeste: CEP_TESTE }],
    ['--cpf-teste', `--cpf-teste=${pontuarCpf(CPF_TESTE)}`, { cpfTeste: CPF_TESTE }],
  ])(
    'QUASE-ERRO: %s=<valor> NÃO come a flag seguinte — a forma inline é UM token só',
    (_flag, inline, esperado) => {
      // The inline form NOT in last position: the next flag must still be read.
      const cmd = parseArgsImportarPedido([
        ...OBRIGATORIOS,
        '--importar-cliente',
        inline,
        '--importar-endereco',
        '--json',
      ]);
      expect(cmd.kind === 'importar' && cmd.args.comprador).toMatchObject({
        ...esperado,
        importarEndereco: true,
      });
      expect(cmd.kind === 'importar' && cmd.args.json).toBe(true);
    },
  );
});

describe('linhaDoCompradorNoPreambulo — o que o script diz ANTES de ler qualquer coisa', () => {
  const NADA = { nomeTeste: null, cepTeste: null, cpfTeste: null, importarEndereco: false };

  it('diz SE cada substituto foi dado, e cada um vira SÓ a sua palavra', () => {
    expect(linhaDoCompradorNoPreambulo(NADA)).toBe(
      '  comprador ....... TESTE — endereço=não nome-teste=não cep-teste=não cpf-teste=não',
    );
    expect(
      linhaDoCompradorNoPreambulo({
        nomeTeste: NOME_TESTE,
        cepTeste: CEP_TESTE,
        cpfTeste: CPF_TESTE,
        importarEndereco: true,
      }),
    ).toBe('  comprador ....... TESTE — endereço=sim nome-teste=sim cep-teste=sim cpf-teste=sim');
    for (const [over, palavra] of [
      [{ importarEndereco: true }, 'endereço=sim'],
      [{ nomeTeste: NOME_TESTE }, 'nome-teste=sim'],
      [{ cepTeste: CEP_TESTE }, 'cep-teste=sim'],
      [{ cpfTeste: CPF_TESTE }, 'cpf-teste=sim'],
    ] as const) {
      const linha = linhaDoCompradorNoPreambulo({ ...NADA, ...over });
      expect(linha).toContain(palavra);
      // Exactly ONE `sim` — the others stay `não`.
      expect(linha.match(/=sim\b/g)).toHaveLength(1);
    }
  });

  it('⚠️ nunca carrega um VALOR — nem os dígitos do --cpf-teste, nem o nome, nem o CEP', () => {
    for (const cpf of [CPF_TESTE, pontuarCpf(CPF_TESTE)]) {
      const linha = linhaDoCompradorNoPreambulo({
        nomeTeste: NOME_TESTE,
        cepTeste: CEP_TESTE,
        cpfTeste: cpf,
        importarEndereco: true,
      });
      // Anchor: the line was built, with the flag named.
      expect(linha).toContain('cpf-teste=sim');
      for (const valor of [cpf, CPF_TESTE, CPF_TESTE.slice(0, 9), NOME_TESTE, CEP_TESTE]) {
        expect(linha).not.toContain(valor);
      }
    }
  });
});

/** The message of a synchronous throw — the parser's refusals are all `ArgumentoInvalidoError`. */
function mensagemDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ArgumentoInvalidoError) return err.message;
    throw err;
  }
  throw new Error('esperava uma recusa de argumento');
}

describe('parseArgsImportarPedido — --cpf-teste', () => {
  const comCpf = (...extra: string[]) =>
    parseArgsImportarPedido([...OBRIGATORIOS, '--importar-cliente', ...extra]);
  const cpfTesteDe = (cmd: ReturnType<typeof parseArgsImportarPedido>) =>
    cmd.kind === 'importar' ? cmd.args.comprador?.cpfTeste : undefined;

  it('aceita os 11 dígitos puros e o formato 000.000.000-00 — ambos viram a forma CANÔNICA', () => {
    for (const grafia of [CPF_TESTE, pontuarCpf(CPF_TESTE), `  ${pontuarCpf(CPF_TESTE)} `]) {
      expect(cpfTesteDe(comCpf('--cpf-teste', grafia))).toBe(CPF_TESTE);
      // The inline form, exactly like --nome-teste's.
      expect(cpfTesteDe(comCpf(`--cpf-teste=${grafia}`))).toBe(CPF_TESTE);
    }
    // Beside the other substitutes, nothing else moves.
    const cmd = comCpf('--nome-teste', NOME_TESTE, '--cpf-teste', CPF_TESTE);
    expect(cmd.kind === 'importar' && cmd.args.comprador).toEqual({
      nomeTeste: NOME_TESTE,
      cepTeste: null,
      cpfTeste: CPF_TESTE,
      importarEndereco: false,
    });
  });

  it('recusa um valor vazio, só de espaços, ausente ou que é outra flag — como --nome-teste', () => {
    for (const extra of [
      ['--cpf-teste', ''],
      ['--cpf-teste', '   '],
      ['--cpf-teste='],
      ['--cpf-teste'],
      ['--cpf-teste', '--live'],
    ]) {
      expect(() => comCpf(...extra)).toThrow(
        new ArgumentoInvalidoError('--cpf-teste exige um valor.'),
      );
    }
  });

  it('⚠️ recusa dígitos verificadores errados — o validador canônico decide, não o formato', () => {
    const errado = cpfComDvErrado(CPF_TESTE);
    // The anchor: the near-miss is shaped exactly like the accepted one.
    expect(errado).toMatch(/^\d{11}$/);
    expect(errado).not.toBe(CPF_TESTE);
    expect(cpfDeTesteUtilizavel(errado)).toBeNull();
    for (const grafia of [errado, pontuarCpf(errado)]) {
      expect(() => comCpf('--cpf-teste', grafia)).toThrow(/dígitos verificadores não conferem/);
    }
  });

  it('recusa 11 dígitos IGUAIS — mod-11 os aceitaria, o validador não', () => {
    for (const d of ['0', '1', '9']) {
      const repetido = d.repeat(11);
      // The anchor: the check digits alone DO accept it — the validator's own
      // degenerate-input rule is what refuses.
      expect(gerarCpf(d.repeat(9))).toBe(repetido);
      expect(cpfDeTesteUtilizavel(repetido)).toBeNull();
      expect(() => comCpf('--cpf-teste', repetido)).toThrow(/todos iguais/);
      expect(() => comCpf('--cpf-teste', pontuarCpf(repetido))).toThrow(/todos iguais/);
    }
  });

  it.each([
    ['10 dígitos', CPF_TESTE.slice(0, 10)],
    ['12 dígitos', `${CPF_TESTE}0`],
    ['letras', `${CPF_TESTE.slice(0, 10)}A`],
    ['só letras', 'abcdefghijk'],
    ['pontuação incompleta', `${CPF_TESTE.slice(0, 9)}-${CPF_TESTE.slice(9)}`],
    ['barra no lugar do traço', pontuarCpf(CPF_TESTE).replace('-', '/')],
    ['espaços no meio', `${CPF_TESTE.slice(0, 3)} ${CPF_TESTE.slice(3)}`],
  ])('recusa %s — a grafia é 11 dígitos, puros ou 000.000.000-00', (_rotulo, grafia) => {
    expect(() => comCpf('--cpf-teste', grafia)).toThrow(
      new ArgumentoInvalidoError(
        '--cpf-teste exige um CPF de 11 dígitos, puros ou no formato 000.000.000-00.',
      ),
    );
  });

  it('⚠️ recusa um CNPJ VÁLIDO, puro ou pontuado — a flag é de PESSOA FÍSICA', () => {
    const cnpj = gerarCnpj('434567890001');
    // The anchor: the capture predicate WOULD accept it — the narrowing is ours.
    expect(cpfCnpjUtilizavel(cnpj)).toBe(cnpj);
    expect(cpfDeTesteUtilizavel(cnpj)).toBeNull();
    for (const grafia of [cnpj, pontuarCnpj(cnpj)]) {
      expect(() => comCpf('--cpf-teste', grafia)).toThrow(
        new ArgumentoInvalidoError(
          '--cpf-teste aceita só CPF (pessoa física, 11 dígitos), nunca CNPJ.',
        ),
      );
    }
  });

  it('QUASE-ERRO: 14 caracteres que NÃO são um CNPJ válido levam a mensagem de FORMA, não «nunca CNPJ»', () => {
    const cnpj = gerarCnpj('434567890001');
    const dvErrado = `${cnpj.slice(0, 13)}${String((Number(cnpj[13]) + 1) % 10)}`;
    // The anchors: same shape as the valid one, and the canonical predicate refuses it.
    expect(dvErrado).toMatch(/^\d{14}$/);
    expect(cpfCnpjUtilizavel(dvErrado)).toBeNull();
    for (const grafia of [dvErrado, pontuarCnpj(dvErrado), 'abcdefghijklmn']) {
      expect(() => comCpf('--cpf-teste', grafia)).toThrow(
        new ArgumentoInvalidoError(
          '--cpf-teste exige um CPF de 11 dígitos, puros ou no formato 000.000.000-00.',
        ),
      );
    }
  });

  it('⚠️ NENHUMA recusa de --cpf-teste repete o valor — nem puro, nem pontuado', () => {
    const errado = cpfComDvErrado(CPF_TESTE);
    const cnpj = gerarCnpj('434567890001');
    const recusados = [
      errado,
      pontuarCpf(errado),
      `${errado}0`,
      cnpj,
      pontuarCnpj(cnpj),
      '2'.repeat(11),
    ];
    for (const valor of recusados) {
      for (const argv of [
        [...OBRIGATORIOS, '--importar-cliente', '--cpf-teste', valor],
        [...OBRIGATORIOS, '--importar-cliente', `--cpf-teste=${valor}`],
        // …and the dependent refusal, BEFORE the value is even judged.
        [...OBRIGATORIOS, '--cpf-teste', valor],
      ]) {
        const m = mensagemDe(() => parseArgsImportarPedido(argv));
        expect(m).not.toContain(valor);
        expect(m).not.toContain(valor.replace(/\D/g, ''));
        // What the operator sees: the message, then the whole help.
        const saida = descreverErro(new ArgumentoInvalidoError(m)).join('\n');
        expect(saida).not.toContain(valor.replace(/\D/g, ''));
      }
    }
  });
});

describe('exigirProjetoDoModoComprador — o --live grava, então o projeto é NOMEADO', () => {
  const ok = {
    projetoPedido: 'demo-erp',
    projetoResolvido: 'demo-erp',
    projetoDaCredencial: 'demo-erp',
  };

  it('passa com --project igual ao resolvido E uma conta de serviço desse projeto', () => {
    expect(() => exigirProjetoDoModoComprador(ok)).not.toThrow();
  });

  it('⚠️ recusa credenciais padrão do ambiente — elas não dizem de qual projeto são', () => {
    expect(() => exigirProjetoDoModoComprador({ ...ok, projetoDaCredencial: null })).toThrow(
      SimulacaoCompradorRecusadaError,
    );
    expect(() => exigirProjetoDoModoComprador({ ...ok, projetoDaCredencial: null })).toThrow(
      /exige uma conta de serviço \(FIREBASE_SERVICE_ACCOUNT ou FIREBASE_SERVICE_ACCOUNT_PATH\)/,
    );
  });

  it('recusa sem --project', () => {
    expect(() => exigirProjetoDoModoComprador({ ...ok, projetoPedido: null })).toThrow(
      SimulacaoCompradorRecusadaError,
    );
    expect(() => exigirProjetoDoModoComprador({ ...ok, projetoPedido: null })).toThrow(
      /exige --project/,
    );
  });

  it('recusa um --project diferente do resolvido, e um resolvido ausente', () => {
    expect(() => exigirProjetoDoModoComprador({ ...ok, projetoResolvido: 'outro' })).toThrow(
      /não é o projeto que o admin resolveu/,
    );
    expect(() => exigirProjetoDoModoComprador({ ...ok, projetoResolvido: null })).toThrow(
      SimulacaoCompradorRecusadaError,
    );
  });

  it('recusa uma credencial emitida para OUTRO projeto (a regra de tools/migrations)', () => {
    expect(() => exigirProjetoDoModoComprador({ ...ok, projetoDaCredencial: 'outro' })).toThrow(
      /credencial de serviço é do projeto outro/,
    );
  });
});

describe('projetoDaCredencial', () => {
  it('lê o projectId de um cert() e responde null para tudo o mais', () => {
    expect(projetoDaCredencial({ projectId: 'demo-erp', privateKey: 'x' })).toBe('demo-erp');
    for (const outro of [undefined, null, {}, { projectId: 42 }, { projectId: '' }, 'demo-erp']) {
      expect(projetoDaCredencial(outro)).toBeNull();
    }
  });
});

describe('a captura TERMINAL de um pedido existente', () => {
  const CLIENTE = 'documents/clientes/cli-1';
  const ENDERECO = 'documents/clientes/cli-1/enderecos/end-1';
  const capturado = (extra: Record<string, unknown> = {}) => ({
    capturaComprador: { estado: 'capturado' },
    clientePedidoOuterRef: CLIENTE,
    ...extra,
  });

  it('expirado é terminal sempre; pendente, ausente e lixo nunca', () => {
    for (const importarEndereco of [false, true]) {
      expect(
        capturaTerminalDoPedido({ capturaComprador: { estado: 'expirado' } }, importarEndereco),
      ).toBe('expirado');
      expect(
        capturaTerminalDoPedido({ capturaComprador: { estado: 'pendente' } }, importarEndereco),
      ).toBeNull();
      expect(capturaTerminalDoPedido({}, importarEndereco)).toBeNull();
      expect(capturaTerminalDoPedido(null, importarEndereco)).toBeNull();
      expect(
        capturaTerminalDoPedido({ capturaComprador: 'expirado' }, importarEndereco),
      ).toBeNull();
    }
  });

  it('capturado só é terminal quando não resta NADA a preencher', () => {
    // Cliente e endereço vinculados: nada a fazer, com ou sem --importar-endereco.
    const completo = capturado({ enderecoFiscalOuterRef: ENDERECO });
    expect(capturaTerminalDoPedido(completo, true)).toBe('capturado');
    expect(capturaTerminalDoPedido(completo, false)).toBe('capturado');
    // Sem endereço e sem --importar-endereco: nada a fazer também.
    expect(capturaTerminalDoPedido(capturado(), false)).toBe('capturado');
    expect(capturaTerminalDoPedido(capturado({ enderecoFiscalOuterRef: '' }), false)).toBe(
      'capturado',
    );
  });

  it('⚠️ QUASE-ERRO: capturado SEM endereço + --importar-endereco NÃO é terminal — o endereço ainda grava', () => {
    expect(capturaTerminalDoPedido(capturado(), true)).toBeNull();
    expect(capturaTerminalDoPedido(capturado({ enderecoFiscalOuterRef: null }), true)).toBeNull();
    // …e um capturado sem cliente vinculado também tem o que preencher.
    expect(
      capturaTerminalDoPedido({ capturaComprador: { estado: 'capturado' } }, false),
    ).toBeNull();
  });

  it('a recusa diz o estado e manda usar um pedido novo', () => {
    expect(() =>
      exigirPedidoSemCapturaTerminal({ capturaComprador: { estado: 'expirado' } }, true),
    ).toThrow(
      'o pedido já existe e a captura do comprador já terminou (expirado); use um pedido de teste novo.',
    );
    expect(() => exigirPedidoSemCapturaTerminal(null, true)).not.toThrow();
    // Capturado sem endereço e sem a flag: a recusa diz como gravá-lo.
    expect(() => exigirPedidoSemCapturaTerminal(capturado(), false)).toThrow(
      /\(capturado\) \(o endereço ainda não foi gravado: passe --importar-endereco para gravá-lo\)/,
    );
    // QUASE-ERRO: com o endereço vinculado a dica não aparece.
    expect(() =>
      exigirPedidoSemCapturaTerminal(capturado({ enderecoFiscalOuterRef: ENDERECO }), false),
    ).toThrow(
      'o pedido já existe e a captura do comprador já terminou (capturado); use um pedido de teste novo.',
    );
  });
});

describe('exigirPedidoSemVinculoAlheio — um vínculo que NÃO é o do comprador de teste', () => {
  const CLIENTE = 'documents/clientes/cli-1';
  const mesmoNome = { kind: 'mesmo-nome', clienteIds: ['cli-1'] } as const;

  it('sem pedido, ou sem vínculo nenhum, segue', () => {
    expect(() => exigirPedidoSemVinculoAlheio(null, null)).not.toThrow();
    expect(() =>
      exigirPedidoSemVinculoAlheio(
        { clientePedidoOuterRef: null, enderecoFiscalOuterRef: '' },
        null,
      ),
    ).not.toThrow();
  });

  it('o cliente vinculado É o comprador de teste (mesmo documento, mesmo nome) — segue', () => {
    expect(() =>
      exigirPedidoSemVinculoAlheio({ clientePedidoOuterRef: CLIENTE }, mesmoNome),
    ).not.toThrow();
    expect(() =>
      exigirPedidoSemVinculoAlheio(
        {
          clientePedidoOuterRef: CLIENTE,
          enderecoFiscalOuterRef: `${CLIENTE}/enderecos/end-1`,
        },
        mesmoNome,
      ),
    ).not.toThrow();
  });

  it('⚠️ um cliente que o operador vinculou à mão recusa — o id sai, nunca um nome', () => {
    for (const colisao of [
      null,
      { kind: 'livre' } as const,
      { kind: 'mesmo-nome', clienteIds: ['outro'] } as const,
    ]) {
      expect(() =>
        exigirPedidoSemVinculoAlheio({ clientePedidoOuterRef: CLIENTE }, colisao),
      ).toThrow(
        'o pedido já tem cliente/endereço vinculado (cliente cli-1) que não é o comprador de ' +
          'teste desta execução; use um pedido de teste novo. Nada foi gravado.',
      );
    }
  });

  it('um endereço vinculado SEM cliente também recusa', () => {
    expect(() =>
      exigirPedidoSemVinculoAlheio(
        { enderecoFiscalOuterRef: 'documents/clientes/x/enderecos/e' },
        mesmoNome,
      ),
    ).toThrow(/\(cliente —\)/);
  });
});

describe('decidirColisaoDeDocumento — a dobra é normalizeNome e NADA mais', () => {
  it('ninguém com o documento ⇒ livre', () => {
    expect(decidirColisaoDeDocumento([], NOME_TESTE)).toEqual({ kind: 'livre' });
  });

  it('PAR IGUAL: espaços nas pontas e repetidos dobram — a re-execução converge', () => {
    expect(
      decidirColisaoDeDocumento(
        [{ clienteId: 'c-1', nome: '  Pessoa   Ficticia Sandbox ' }],
        NOME_TESTE,
      ),
    ).toEqual({ kind: 'mesmo-nome', clienteIds: ['c-1'] });
  });

  it('⚠️ QUASE-ERRO: caixa, acento ou uma letra a mais NÃO dobram — é outra pessoa', () => {
    for (const nome of [
      'pessoa ficticia sandbox',
      'Pessoa Fictícia Sandbox',
      'Pessoa Ficticia Sandboxx',
    ]) {
      expect(decidirColisaoDeDocumento([{ clienteId: 'c-1', nome }], NOME_TESTE)).toEqual({
        kind: 'colisao',
        clienteIds: ['c-1'],
      });
    }
  });

  it('um dono com outro nome entre vários basta, e só ELE é nomeado; um nome não-texto é colisão', () => {
    expect(
      decidirColisaoDeDocumento(
        [
          { clienteId: 'c-2', nome: NOME_TESTE },
          { clienteId: 'c-1', nome: 'Cliente Dev Pessoa Fisica' },
          { clienteId: 'c-3', nome: null },
        ],
        NOME_TESTE,
      ),
    ).toEqual({ kind: 'colisao', clienteIds: ['c-1', 'c-3'] });
  });

  it('um nome de comprador que não dobra (só espaços) colide com QUALQUER dono', () => {
    expect(decidirColisaoDeDocumento([{ clienteId: 'c-1', nome: null }], '   ')).toEqual({
      kind: 'colisao',
      clienteIds: ['c-1'],
    });
    // QUASE-ERRO: com um nome que dobra, o dono de nome igual converge.
    expect(decidirColisaoDeDocumento([{ clienteId: 'c-1', nome: NOME_TESTE }], NOME_TESTE)).toEqual(
      { kind: 'mesmo-nome', clienteIds: ['c-1'] },
    );
  });

  /** The refusal `exigirDocumentoSemColisao` raises for one source, as text. */
  function recusaDaColisao(
    decisao: Parameters<typeof exigirDocumentoSemColisao>[0],
    fonte: Parameters<typeof exigirDocumentoSemColisao>[1],
  ): string {
    try {
      exigirDocumentoSemColisao(decisao, fonte);
    } catch (err) {
      if (err instanceof SimulacaoCompradorRecusadaError) return err.message;
      throw err;
    }
    throw new Error('esperava uma recusa de colisão');
  }

  const SEED = decidirColisaoDeDocumento(
    [{ clienteId: 'seed-1', nome: 'Cliente Dev Pessoa Fisica' }],
    NOME_TESTE,
  );

  it('a recusa nomeia os ids e o caminho de saída — NUNCA o nome gravado, em TODA fonte', () => {
    for (const fonte of Object.values(FONTE_CPF_SIMULADO)) {
      const mensagem = recusaDaColisao(SEED, fonte);
      expect(mensagem).toContain('seed-1');
      expect(mensagem).toContain('--nome-teste');
      expect(mensagem).toContain('Nada foi gravado.');
      expect(mensagem).not.toContain('Cliente Dev');
      expect(mensagem).not.toContain(NOME_TESTE);
      // QUASE-ERRO: the two non-colliding answers never refuse, whatever the source.
      expect(() =>
        exigirDocumentoSemColisao({ kind: 'mesmo-nome', clienteIds: ['c'] }, fonte),
      ).not.toThrow();
      expect(() => exigirDocumentoSemColisao({ kind: 'livre' }, fonte)).not.toThrow();
    }
  });

  it('o CPF FALSO colide (o staging de hoje) ⇒ sugere --cpf-teste PRIMEIRO, depois --nome-teste e apagar', () => {
    const m = recusaDaColisao(SEED, FONTE_CPF_SIMULADO.cpfFalso);
    expect(m).toMatch(/^o CPF falso do repo, que o modo de teste usaria, já pertence/);
    const cpf = m.indexOf('--cpf-teste <outro CPF de teste>');
    const nome = m.indexOf('--nome-teste');
    const apagar = m.indexOf('apague esse cliente');
    expect(cpf).toBeGreaterThan(-1);
    expect(nome).toBeGreaterThan(cpf);
    expect(apagar).toBeGreaterThan(nome);
    // Where the holders come from is said right: the NF-e live lane and dev
    // seeds — no e2e spec writes the fake.
    expect(m).toContain('o NF-e live do CI e seeds de dev gravam clientes com o CPF falso');
    expect(m).not.toContain('e2e');
    // The ten ids of a staging collision all ride the message, ids only.
    const dez = Array.from({ length: 10 }, (_, i) => `ci-${String(i)}-cliente`);
    const muitos = recusaDaColisao(
      decidirColisaoDeDocumento(
        dez.map((clienteId) => ({ clienteId, nome: 'Outro' })),
        NOME_TESTE,
      ),
      FONTE_CPF_SIMULADO.cpfFalso,
    );
    for (const id of dez) expect(muitos).toContain(id);
  });

  it('um --cpf-teste que colide diz que ESSE documento já tem dono — e pede outro', () => {
    const m = recusaDaColisao(SEED, FONTE_CPF_SIMULADO.cpfTeste);
    expect(m).toMatch(/^o CPF informado em --cpf-teste já pertence a outro cliente \(seed-1\)/);
    expect(m).toContain('Passe outro --cpf-teste');
    // QUASE-ERRO: it does not blame the repo's fake, nor send the operator to the seed.
    expect(m).not.toContain('CPF falso');
    expect(m).not.toContain('seed de dev');
  });

  it('⚠️ uma fonte FORA da união (um chamador JS, um cast) ainda RECUSA — nunca passa como livre', () => {
    const estranha = 'outra-fonte' as unknown as Parameters<typeof exigirDocumentoSemColisao>[1];
    const m = recusaDaColisao(SEED, estranha);
    expect(m).toMatch(
      /^o documento que o modo de teste usaria já pertence a outro cliente \(seed-1\)/,
    );
    expect(m).toContain('--nome-teste');
    expect(m).toContain('Nada foi gravado.');
    // It names no source it cannot vouch for, and never the source value itself.
    expect(m).not.toContain('outra-fonte');
    expect(m).not.toContain('CPF falso');
    // QUASE-ERRO: the two non-colliding answers still pass with that same source.
    expect(() =>
      exigirDocumentoSemColisao({ kind: 'mesmo-nome', clienteIds: ['c'] }, estranha),
    ).not.toThrow();
    expect(() => exigirDocumentoSemColisao({ kind: 'livre' }, estranha)).not.toThrow();
  });

  it('o documento da SHOPEE colide ⇒ diz que ele vence o --cpf-teste, e não o sugere', () => {
    const m = recusaDaColisao(SEED, FONTE_CPF_SIMULADO.shopee);
    expect(m).toMatch(/^o documento que a Shopee mandou já pertence/);
    expect(m).toContain('ele vence o --cpf-teste');
    expect(m).not.toContain('Passe outro --cpf-teste');
    expect(m).not.toContain('<outro CPF de teste>');
  });
});

describe('o resumo do comprador GRAVADO (--live)', () => {
  it('ids e veredito; sem a chave de teste no resultado, tudo vira nulo', () => {
    const base = {
      kind: 'pedido',
      acao: 'criado',
      orderSn: ORDER_SN,
      pedidoId: 'ped-1',
      orderStatus: 'READY_TO_SHIP',
      itensSemProduto: 0,
      acaoPagamentos: null,
      pagamentosGravados: 0,
      acaoFrete: null,
      pacotesGravados: 0,
      detail: 'criado',
    } as const;
    const depois = {
      clientePedidoOuterRef: 'documents/clientes/cli-9',
      enderecoFiscalOuterRef: 'documents/clientes/cli-9/enderecos/end-7',
    };
    const gravado = resumoDoCompradorGravado(
      {
        ...base,
        compradorDeTeste: {
          cliente: { clienteId: 'cli-9', criado: false, matchedBy: 'cpf_cnpj' },
          enderecoOuterRef: 'documents/clientes/cli-9/enderecos/end-7',
          fonteDoCpf: FONTE_CPF_SIMULADO.cpfTeste,
        },
      },
      depois,
    );
    expect(gravado).toEqual({
      pedidoId: 'ped-1',
      clienteId: 'cli-9',
      criado: false,
      matchedBy: 'cpf_cnpj',
      enderecoId: 'end-7',
      fonteDoCpf: FONTE_CPF_SIMULADO.cpfTeste,
      limpeza: ['pedidos/ped-1', 'clientes/cli-9/enderecos/end-7', 'clientes/cli-9'],
    });
    const texto = renderCompradorGravado(gravado).join('\n');
    expect(texto).toContain('cli-9   criado=não   matchedBy=cpf_cnpj');
    expect(texto).toContain('CPF de teste aplicado ... sim (informado em --cpf-teste)');
    expect(texto).toContain(
      'limpeza (no console) .... pedidos/ped-1, clientes/cli-9/enderecos/end-7, clientes/cli-9',
    );
    expect(texto).toContain('um cliente reaproveitado, como o do seed, fica');
    expect(resumoDoCompradorGravado(base, null)).toEqual({
      pedidoId: 'ped-1',
      clienteId: null,
      criado: null,
      matchedBy: null,
      enderecoId: null,
      fonteDoCpf: null,
      limpeza: [],
    });
    // QUASE-ERRO: sem vínculo gravado a limpeza é só o pedido; sem pedido, nem o bloco sai.
    expect(resumoDoCompradorGravado(base, {}).limpeza).toEqual(['pedidos/ped-1']);
    const semEscrita = renderCompradorGravado(resumoDoCompradorGravado(base, null)).join('\n');
    expect(semEscrita).not.toContain('limpeza');
    // Without the write half there is no source to report — a dash, never a guess.
    expect(semEscrita).toContain('CPF de teste aplicado ... —');
  });

  it('a linha «CPF de teste aplicado» do --live diz a FONTE, como a do dry-run', () => {
    const rotulos = {
      [FONTE_CPF_SIMULADO.cpfTeste]: 'sim (informado em --cpf-teste)',
      [FONTE_CPF_SIMULADO.cpfFalso]: 'sim (o CPF falso do repo)',
      [FONTE_CPF_SIMULADO.shopee]: 'não — vale o da Shopee',
    };
    for (const fonte of Object.values(FONTE_CPF_SIMULADO)) {
      const texto = renderCompradorGravado({
        pedidoId: 'ped-1',
        clienteId: 'cli-9',
        criado: true,
        matchedBy: null,
        enderecoId: null,
        fonteDoCpf: fonte,
        limpeza: [],
      }).join('\n');
      expect(texto).toContain(`  CPF de teste aplicado ... ${rotulos[fonte]}`);
      // QUASE-ERRO: no other source's label rides along.
      for (const outra of Object.values(FONTE_CPF_SIMULADO).filter((f) => f !== fonte)) {
        expect(texto).not.toContain(rotulos[outra]);
      }
    }
  });
});

describe('descreverErro — a recusa do modo de teste', () => {
  it('é uma linha só, com o motivo — a recusa vem antes de qualquer gravação', () => {
    expect(descreverErro(new SimulacaoCompradorRecusadaError('motivo X'))).toEqual([
      '❌ Modo comprador de TESTE recusado: motivo X',
    ]);
  });
});
