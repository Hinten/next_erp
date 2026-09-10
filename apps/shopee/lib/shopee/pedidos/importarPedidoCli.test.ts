import { describe, expect, it } from 'vitest';
import type { ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { avaliarCapturaComprador } from './comprador';
import {
  ArgumentoInvalidoError,
  descreverErro,
  parseArgsImportarPedido,
  renderResumoPedido,
  resumoDoPedidoArmazenado,
  resumoDoPedidoMapeado,
} from './importarPedidoCli';
import { mapearItensShopee } from './itens';
import { mapearFreteInicialShopee } from './orderFreteMapping';
import { mapearPedidoShopee } from './orderMapping';

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
    freteCobrado: frete.valorCobrado,
    nowUs: watermarkUs,
  });
  const mapeado = mapearPedidoShopee({
    detalhe,
    escrow: null,
    itens: mapeados.itens,
    conferencia: mapeados.conferencia,
    frete,
    conta: {
      integracaoPedidoOuterRef: 'documents/integracao/int-1',
      listaDePrecosOuterRef: null,
      operacaoPedidoOuterRef: null,
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
      freteCobrado: frete.valorCobrado,
      nowUs: watermarkUs,
    });
    const resumo = resumoDoPedidoMapeado(
      'ped-sha256',
      mapearPedidoShopee({
        detalhe: mascarado,
        escrow: null,
        itens: mapeados.itens,
        conferencia: mapeados.conferencia,
        frete,
        conta: {
          integracaoPedidoOuterRef: 'documents/integracao/int-1',
          listaDePrecosOuterRef: null,
          operacaoPedidoOuterRef: null,
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
