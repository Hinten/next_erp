/**
 * The pure half of `rastrear:pedido` (#1515, step 7, plan §3.0-P P4).
 *
 * ⚠️ Three of these are the only thing standing between a rehearsal and a leak
 * or a dead command, and none is a happy path:
 *
 *  - **10** drives the summary builder over a row that REALLY carries
 *    `recipient_address`, `driver_info` and `virtual_contact_number` (they ride
 *    `shopeePackageDetailRowSchema`'s `.passthrough()`, so the data is in the
 *    object), with a FIELD-COUNT pin so a field added to the allow-list has to
 *    be looked at;
 *  - **8** pins that the documented invocation carries no `--` separator —
 *    `pnpm-run-args.test.js` fails CI on that spelling, and the command would
 *    die on its own separator;
 *  - **13** pins that the rehearsal's `DiagnosticoPushFrete` CLAIMS nothing: a
 *    fabricated status or tracking number would put an assertion into a task log
 *    that no Shopee delivery ever made.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ESTADO_FRETE,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  seedFreteInicial,
} from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeSchemaError,
  shopeePackageDetailRowSchema,
  type ShopeePackageDetailRow,
} from '@delfrance/integrations-shopee';

import { observadoDoPacoteDetalhe } from './fretePushShopee';
import { preverFreteShopee } from './freteTx';
import { microsDeSegundosShopee } from './orderMapping';
import type { LinhaSimuladaRastreio } from './rastrearPedidoSimulacao';
import {
  ArgumentoInvalidoError,
  CAMPOS_RESUMO_RASTREIO,
  DIAGNOSTICO_DE_ENSAIO,
  USO_RASTREAR_PEDIDO,
  carimboMicros,
  carimboSegundos,
  descreverErroRastreio,
  parseArgsRastrearPedido,
  renderFreteArmazenado,
  renderResumoRastreio,
  resumoDoFreteArmazenado,
  resumoDoPacoteSimulado,
  type ResumoRastreioShopee,
} from './rastrearPedidoCli';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, order or buyer.  */
/* -------------------------------------------------------------------------- */

const ORDER_SN = '260910KJBHUJDM';
const PKG_A = 'OFG242672552205937';
/** An invented carrier code. Never a real one. */
const RASTREIO = 'BR000000001BR';
const T_S = 1_788_973_354;
const PRAZO_S = 1_789_405_354;
const NOW_US = 1_789_000_000_000_000;

/** Sentinels — nothing real, and nothing that may reach the output. */
const SENTINELA_ENDERECO = 'SENTINELA-RUA-DO-COMPRADOR';
const SENTINELA_MOTORISTA = 'SENTINELA-NOME-DO-MOTORISTA';
const SENTINELA_TELEFONE = 'SENTINELA-TELEFONE-VIRTUAL';

function args(...argv: string[]) {
  const c = parseArgsRastrearPedido(argv);
  if (c.kind !== 'rastrear') throw new Error('esperava o comando rastrear');
  return c.args;
}

/**
 * ONE `get_package_detail` row, parsed by the REAL schema and carrying the three
 * PII blocks the schema deliberately does not declare. They survive
 * `.passthrough()`, so the object this test hands the summary builder really
 * does hold them — which is what makes test 10 an assertion rather than a wish.
 */
function linhaComPii(over: Record<string, unknown> = {}): ShopeePackageDetailRow {
  return shopeePackageDetailRowSchema.parse({
    order_sn: ORDER_SN,
    package_number: PKG_A,
    fulfillment_status: 'LOGISTICS_REQUEST_CREATED',
    tracking_number: RASTREIO,
    logistics_channel_id: 11_006,
    shipping_carrier: 'Sandbox -Standard Express LPS',
    ship_by_date: PRAZO_S,
    update_time: T_S,
    is_shipment_arranged: true,
    group_shipment_id: 0,
    item_list: [
      { item_id: 846_056_136, model_id: 12_984_093, model_quantity: 2, item_sku: 'SKU-1' },
    ],
    recipient_address: {
      name: SENTINELA_ENDERECO,
      full_address: SENTINELA_ENDERECO,
      geolocation: { latitude: '0', longitude: '0' },
    },
    driver_info: { driver_name: SENTINELA_MOTORISTA, license_plate: SENTINELA_MOTORISTA },
    virtual_contact_number: SENTINELA_TELEFONE,
    ...over,
  });
}

function rawPedido(): Record<string, unknown> {
  return {
    numero: ORDER_SN,
    ultimaModificacao: microsDeSegundosShopee(T_S),
    freteInicial: freteDoPedidoSchema.parse({
      ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
      externalOptionIntegracao: 'shopee',
    }),
  };
}

/** A fully-populated simulated line, built from the real producers. */
function linhaSimulada(over: Partial<LinhaSimuladaRastreio> = {}): LinhaSimuladaRastreio {
  const row = linhaComPii();
  const observado = observadoDoPacoteDetalhe(row);
  return {
    packageNumber: PKG_A,
    origem: 'volume',
    linha: row,
    observado,
    previsao: preverFreteShopee(rawPedido(), {
      orderSn: ORDER_SN,
      observados: observado === null ? [] : [observado],
      relogioDaOrdemUs: null,
      prazoDaOrdemUs: null,
      nowUs: NOW_US,
    }),
    motivo: null,
    ...over,
  };
}

/** Every field `null`, every list empty — the record a renderer must survive. */
function resumoVazio(): ResumoRastreioShopee {
  return {
    packageNumber: PKG_A,
    origem: 'flag',
    fonte: null,
    fulfillmentStatus: null,
    estadoAlvo: null,
    trackingNumber: null,
    shipByDateS: null,
    logisticsChannelId: null,
    updateTimeS: null,
    isShipmentArranged: null,
    groupShipmentId: null,
    itensNoPacote: null,
    acao: null,
    camposQueMudariam: [],
  };
}

/* ========================================================================== */
/*  1–8 · a matriz de argumentos                                              */
/* ========================================================================== */

describe('parseArgsRastrearPedido', () => {
  it('2/3/4/5/6. a matriz de recusas', () => {
    // ⚠️ A CLASSE e a MENSAGEM, nas duas asserções: só a classe deixaria passar
    // uma recusa que acontece pelo motivo errado (a mensagem é o que o operador
    // lê), e só a mensagem deixaria passar um `Error` genérico, que o script
    // trata de outro jeito.
    const recusa = (argv: string[], trecho: string): void => {
      expect(() => parseArgsRastrearPedido(argv), argv.join(' ')).toThrowError(
        ArgumentoInvalidoError,
      );
      expect(() => parseArgsRastrearPedido(argv), argv.join(' ')).toThrowError(trecho);
    };

    // 2 — cada obrigatório, sozinho.
    recusa([], '--integracao');
    recusa(['--order-sn', ORDER_SN], '--integracao');
    recusa(['--integracao', 'int-1'], '--order-sn');
    recusa(['--integracao'], 'exige um valor');
    recusa(['--integracao', 'int-1', '--order-sn'], 'exige um valor');

    // 3 — a contradição, recusada em vez de resolvida por precedência.
    recusa(
      ['--integracao', 'int-1', '--order-sn', ORDER_SN, '--live', '--dry-run'],
      'contraditórios',
    );

    // 4 — `--package` em branco e o sentinela `-`.
    recusa(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--package'], 'exige um valor');
    recusa(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--package='], 'exige um valor');
    recusa(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--package', '   '], 'exige um valor');
    recusa(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--package', '-'], 'sentinela');
    recusa(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--package=-'], 'sentinela');
    // A vírgula é o separador da chamada em lote — `assertPackageDetailParams`
    // recusa depois do fetch; aqui custa zero leitura e zero chamada.
    recusa(
      ['--integracao', 'int-1', '--order-sn', ORDER_SN, '--package', `${PKG_A},X`],
      'UM package_number',
    );

    // 5 — a opção desconhecida é NOMEADA.
    recusa(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--sei-la'], 'Opção desconhecida');
    expect(() =>
      parseArgsRastrearPedido(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--sei-la']),
    ).toThrowError('--sei-la');

    // 6 — o `--` literal: o pnpm repassa esse token PARA o script.
    recusa(['--integracao', 'int-1', '--order-sn', ORDER_SN, '--'], 'Separador "--"');
    expect(() => parseArgsRastrearPedido(['--'])).toThrowError('pnpm repassa');

    // ⚠️ NEAR-MISS das duas recusas de `--package`: um número que apenas
    // CONTÉM um traço é um pacote válido, e `--` como prefixo de flag continua
    // sendo flag.
    expect(
      args('--integracao', 'int-1', '--order-sn', ORDER_SN, '--package', 'BR-1').packageNumber,
    ).toBe('BR-1');
    expect(args('--integracao=int-1', '--order-sn=' + ORDER_SN).packageNumber).toBeNull();
  });

  it('7. o caminho feliz, a forma `=` e os padrões que importam', () => {
    const a = args('--integracao', 'int-1', '--order-sn', ORDER_SN);
    expect(a).toEqual({
      integracaoId: 'int-1',
      orderSn: ORDER_SN,
      packageNumber: null,
      // ⚠️ DRY-RUN é o padrão, e `--live` é o único opt-in.
      live: false,
      json: false,
      projectId: null,
    });

    const b = args(
      '--integracao=int-2',
      `--order-sn=${ORDER_SN}`,
      `--package=${PKG_A}`,
      '--live',
      '--json',
      '--project=demo-erp',
    );
    expect(b).toEqual({
      integracaoId: 'int-2',
      orderSn: ORDER_SN,
      packageNumber: PKG_A,
      live: true,
      json: true,
      projectId: 'demo-erp',
    });

    // `--dry-run` explícito é aceito sozinho, e o valor é aparado.
    expect(args('--integracao', 'int-1', '--order-sn', ORDER_SN, '--dry-run').live).toBe(false);
    expect(args('--integracao', '  int-1  ', '--order-sn', ORDER_SN).integracaoId).toBe('int-1');
  });

  it('1. `--help` responde ANTES de qualquer validação', () => {
    // Sozinho, sem os obrigatórios, com uma opção desconhecida junto e depois de
    // um `--package` inválido: nenhuma dessas recusas pode preceder a ajuda.
    expect(parseArgsRastrearPedido(['--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsRastrearPedido(['-h'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsRastrearPedido(['--sei-la', '--help'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsRastrearPedido(['--package', '-', '-h'])).toEqual({ kind: 'ajuda' });
    expect(parseArgsRastrearPedido(['--live', '--dry-run', '--help'])).toEqual({ kind: 'ajuda' });
  });

  it('1b. …e o SCRIPT devolve na ajuda antes do primeiro `await import`', () => {
    // A outra metade do trato, e é ESTRUTURAL: nada abaixo da linha de import
    // dinâmico foi carregado ainda, então nenhuma leitura de env em escopo de
    // módulo, nenhum singleton de admin e nenhum cliente pode rodar no caminho
    // da ajuda. Um teste unitário do parser não consegue ver isso.
    const fonte = readFileSync(
      new URL('../../../scripts/rastrear-pedido.ts', import.meta.url),
      'utf8',
    );
    const ajuda = fonte.indexOf("comando.kind === 'ajuda'");
    const primeiroImport = fonte.indexOf('await import(');
    expect(ajuda).toBeGreaterThan(0);
    expect(primeiroImport).toBeGreaterThan(0);
    expect(ajuda).toBeLessThan(primeiroImport);
  });

  it('8. o texto de uso NÃO carrega um separador `--` entre flags', () => {
    // Um `pnpm run` com o separador antes das flags repassa o token literal para
    // o script, e todo CLI deste repo parseia `process.argv` sozinho — então o
    // comando documentado morreria no próprio separador.
    // `pnpm-run-args.test.js` derruba a CI nessa grafia, INCLUSIVE dentro desta
    // string e deste comentário.
    expect(USO_RASTREAR_PEDIDO).not.toMatch(/pnpm .*[^ ] -- +-/);
    expect(USO_RASTREAR_PEDIDO).not.toMatch(/pnpm .*[^ ] -- +\\/);
    // ÂNCORA: o negativo não é vazio — o texto documenta mesmo uma invocação.
    expect(USO_RASTREAR_PEDIDO).toContain('rastrear:pedido');
    expect(USO_RASTREAR_PEDIDO).toContain('--order-sn');
    // Os três rungs são DITOS, não só implementados.
    expect(USO_RASTREAR_PEDIDO).toContain('[flag]');
    expect(USO_RASTREAR_PEDIDO).toContain('[volume]');
    expect(USO_RASTREAR_PEDIDO).toContain('[order_detail]');
    // E o padrão é dito de frente.
    expect(USO_RASTREAR_PEDIDO).toContain('É o PADRÃO');
  });
});

/* ========================================================================== */
/*  9–11 · a redação                                                          */
/* ========================================================================== */

describe('resumoDoPacoteSimulado', () => {
  it('9/10. os sentinelas não aparecem NEM no objeto NEM na renderização, e a lista é fechada', () => {
    const linha = linhaSimulada();
    // ⚠️ ÂNCORA do próprio teste: a PII está mesmo no objeto de entrada (ela
    // viaja no `.passthrough()` do schema). Sem isto o negativo abaixo seria
    // vacuamente verdadeiro.
    const cru = linha.linha as unknown as Record<string, unknown>;
    expect(JSON.stringify(cru)).toContain(SENTINELA_ENDERECO);
    expect(JSON.stringify(cru)).toContain(SENTINELA_MOTORISTA);
    expect(JSON.stringify(cru)).toContain(SENTINELA_TELEFONE);

    const r = resumoDoPacoteSimulado(linha);

    // (a) a lista de permissão é FECHADA — e o número é fixado, para que um
    // campo novo tenha de ser olhado em vez de entrar de carona.
    expect(Object.keys(r).sort()).toEqual([...CAMPOS_RESUMO_RASTREIO].sort());
    expect(CAMPOS_RESUMO_RASTREIO).toHaveLength(14);
    expect(Object.hasOwn(r, 'recipient_address')).toBe(false);
    expect(Object.hasOwn(r, 'driver_info')).toBe(false);
    expect(Object.hasOwn(r, 'virtual_contact_number')).toBe(false);

    // (b) nem o objeto…
    const serializado = JSON.stringify(r);
    expect(serializado).not.toContain(SENTINELA_ENDERECO);
    expect(serializado).not.toContain(SENTINELA_MOTORISTA);
    expect(serializado).not.toContain(SENTINELA_TELEFONE);
    expect(serializado).not.toContain('recipient');
    expect(serializado).not.toContain('driver');

    // (c) …nem as linhas renderizadas.
    const texto = renderResumoRastreio(r, null).join('\n');
    expect(texto).not.toContain(SENTINELA_ENDERECO);
    expect(texto).not.toContain(SENTINELA_MOTORISTA);
    expect(texto).not.toContain(SENTINELA_TELEFONE);

    // (d) ÂNCORA: o negativo não pode ser vazio — o resumo carrega mesmo o que
    // uma rehearsal precisa ver, inclusive o código de rastreio, que é
    // `codRastreio` e é impresso DE PROPÓSITO.
    expect(r.packageNumber).toBe(PKG_A);
    expect(r.origem).toBe('volume');
    expect(r.fonte).toBe('get_package_detail');
    expect(r.fulfillmentStatus).toBe('LOGISTICS_REQUEST_CREATED');
    expect(r.estadoAlvo).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(r.trackingNumber).toBe(RASTREIO);
    expect(r.shipByDateS).toBe(PRAZO_S);
    expect(r.logisticsChannelId).toBe(11_006);
    expect(r.updateTimeS).toBe(T_S);
    expect(r.isShipmentArranged).toBe(true);
    expect(r.groupShipmentId).toBe(0);
    // ⚠️ Uma CONTAGEM, nunca as linhas: um item carrega SKU e product_location.
    expect(r.itensNoPacote).toBe(1);
    expect(serializado).not.toContain('SKU-1');
    expect(r.acao).toBe('atualizado');
    expect(r.camposQueMudariam).toContain('freteInicial.codRastreio');
    expect(texto).toContain(RASTREIO);
    expect(texto).toContain('atualizado');
  });

  it('9b. uma linha sem resposta rende só os campos que existem, sem inventar nenhum', () => {
    const r = resumoDoPacoteSimulado(
      linhaSimulada({
        linha: null,
        observado: null,
        previsao: null,
        motivo: 'ausente-na-resposta',
      }),
    );

    expect(Object.keys(r).sort()).toEqual([...CAMPOS_RESUMO_RASTREIO].sort());
    expect(r.fonte).toBeNull();
    expect(r.itensNoPacote).toBeNull();
    expect(r.acao).toBeNull();
    expect(r.camposQueMudariam).toEqual([]);
    // ÂNCORA: a identidade e o rung continuam lá — é o que o relatório imprime.
    expect(r.packageNumber).toBe(PKG_A);
    expect(r.origem).toBe('volume');
  });
});

describe('renderResumoRastreio', () => {
  it('11. um registro TODO nulo imprime `—` em cada campo e não estoura', () => {
    const linhas = renderResumoRastreio(resumoVazio(), null);
    const texto = linhas.join('\n');

    expect(() => renderResumoRastreio(resumoVazio(), null)).not.toThrow();
    // Um travessão por campo nulo — treze deles mais a lista vazia.
    expect(texto).toContain('fonte ............... —');
    expect(texto).toContain('fulfillment_status .. —   → estado alvo: —');
    expect(texto).toContain('tracking_number ..... —');
    expect(texto).toContain('ship_by_date ........ —');
    expect(texto).toContain('update_time ......... —');
    expect(texto).toContain('canal / grupo ....... — / —   shipment_arranged=—');
    expect(texto).toContain('itens no pacote ..... —');
    expect(texto).toContain('ação ................ —');
    expect(texto).toContain('campos que mudariam . (nenhum)');
    // ÂNCORA: o package_number nunca é nulo, então ele NÃO vira travessão.
    expect(linhas[0]).toContain(PKG_A);
  });

  it('11b. com um `motivo`, a renderização para na explicação e não finge dados', () => {
    const linhas = renderResumoRastreio(resumoVazio(), 'ausente-na-resposta (linhas ilegíveis: 1)');

    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toContain('NÃO LIDO');
    expect(linhas[1]).toContain('ausente-na-resposta');
  });

  it('11c. os dois carimbos são UTC e nunca o fuso da máquina', () => {
    // ⚠️ O runner roda com `TZ=UTC`, então o ISO sozinho não distingue as duas
    // leituras — o que distingue é o número LITERAL, escrito aqui.
    expect(carimboSegundos(T_S)).toBe('1788973354 (2026-09-09T17:02:34.000Z)');
    expect(carimboMicros(microsDeSegundosShopee(T_S))).toBe(
      '1788973354000000 (2026-09-09T17:02:34.000Z)',
    );
    // …e o instante é calculado a partir de `Date.UTC`, não copiado do ISO: uma
    // leitura no fuso de São Paulo responderia três horas antes.
    expect(T_S * 1000).toBe(Date.UTC(2026, 8, 9, 17, 2, 34));
    expect(carimboSegundos(null)).toBe('—');
    expect(carimboMicros(null)).toBe('—');
    // Um número que não pode ser data nenhuma não estoura o relatório — e o
    // NEAR-MISS logo abaixo mostra que a guarda não fold demais: um µs grande
    // mas ainda datável continua virando ISO.
    expect(carimboMicros(1e19)).toBe('10000000000000000000 (?)');
    expect(carimboMicros(Number.MAX_SAFE_INTEGER)).toBe(
      '9007199254740991 (2255-06-05T23:47:34.740Z)',
    );
  });
});

/* ========================================================================== */
/*  12 · os erros                                                             */
/* ========================================================================== */

describe('descreverErroRastreio', () => {
  it('12. um argumento inválido imprime a AJUDA; um erro da Shopee imprime CLASSE, code e path', () => {
    const ajuda = descreverErroRastreio(new ArgumentoInvalidoError('--order-sn é obrigatório.'));
    expect(ajuda[0]).toContain('--order-sn é obrigatório.');
    expect(ajuda.join('\n')).toContain('rastrear:pedido');

    const api = descreverErroRastreio(
      new ShopeeApiError('order not found', {
        code: 'error_param',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/order/get_package_detail',
        requestId: 'abc',
      }),
    );
    const texto = api.join('\n');
    expect(texto).toContain('ShopeeApiError');
    expect(texto).toContain('error_param');
    expect(texto).toContain('/api/v2/order/get_package_detail');
    // ⚠️ E nunca a ajuda: só o arm de ARGUMENTO imprime o texto de uso.
    expect(texto).not.toContain('rastrear:pedido');

    // Um corpo ilegível sai por CAMINHOS de campo, nunca pelo corpo.
    const schema = descreverErroRastreio(
      new ShopeeSchemaError('resposta inválida', {
        httpStatus: 200,
        path: '/api/v2/order/get_package_detail',
        campos: ['package_list.0.package_number'],
      }),
    );
    expect(schema.join('\n')).toContain('package_list.0.package_number');

    // E um não-Error não derruba o describer.
    expect(descreverErroRastreio('caiu')[0]).toContain('não-Error');
  });
});

/* ========================================================================== */
/*  13 · o diagnóstico do ensaio não AFIRMA nada                              */
/* ========================================================================== */

describe('DIAGNOSTICO_DE_ENSAIO', () => {
  it('13. todo campo de afirmação é nulo — não há push por trás de um ensaio', () => {
    expect(DIAGNOSTICO_DE_ENSAIO).toEqual({
      // O tipo só admite os três códigos de push do passo 7; não existe membro
      // "sem push", e inventar um alargaria um tipo de fio por causa de uma
      // ferramenta de dev.
      code: 4,
      grafiaDoPedido: 'ordersn',
      trackingNoDoPush: null,
      statusDoPush: null,
      camposMudados: null,
      shipByDateAntigaS: null,
      shipByDateNovaS: null,
      canalAntigo: null,
      canalNovo: null,
      relogioDoPushS: null,
    });
    // ⚠️ A propriedade que importa, dita de frente: TODO campo fora dos dois que
    // o tipo não deixa em aberto é nulo — uma versão futura que preenchesse um
    // deles estaria pondo no log uma afirmação que a Shopee nunca fez.
    for (const [chave, valor] of Object.entries(DIAGNOSTICO_DE_ENSAIO)) {
      if (chave === 'code' || chave === 'grafiaDoPedido') continue;
      expect(valor, chave).toBeNull();
    }
  });
});

/* ========================================================================== */
/*  15 · o bloco guardado, relido depois de um --live                          */
/* ========================================================================== */

describe('resumoDoFreteArmazenado', () => {
  it('15. lê o bloco CRU por lista de permissão — o endereço e a bagagem do Melhor Envio não têm por onde passar', () => {
    const bruto = {
      estado: ESTADO_FRETE.aguardandoPostagem,
      codRastreio: RASTREIO,
      externalOptionId: '11006',
      prazoDespacho: microsDeSegundosShopee(PRAZO_S),
      ultimaModificacao: NOW_US,
      // Tudo abaixo é o que NÃO pode sair.
      clienteRecebedorOuterReference: { path: SENTINELA_ENDERECO },
      enderecoFreteOuterReference: { path: SENTINELA_ENDERECO },
      externalOptionData: { endereco: SENTINELA_ENDERECO, motorista: SENTINELA_MOTORISTA },
      pacotes: [
        {
          numero: PKG_A,
          estado: ESTADO_FRETE.aguardandoPostagem,
          estadoMarketplace: 'LOGISTICS_REQUEST_CREATED',
          codRastreio: RASTREIO,
          canalId: '11006',
          prazoDespacho: microsDeSegundosShopee(PRAZO_S),
          atualizadoEm: microsDeSegundosShopee(T_S),
          fonte: 'get_package_detail',
          recipient_address: SENTINELA_ENDERECO,
        },
      ],
    };

    const r = resumoDoFreteArmazenado(bruto)!;
    const texto = [JSON.stringify(r), ...renderFreteArmazenado(r)].join('\n');

    expect(texto).not.toContain(SENTINELA_ENDERECO);
    expect(texto).not.toContain(SENTINELA_MOTORISTA);
    // ÂNCORA: o que a rehearsal precisa ver continua lá.
    expect(r.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(r.codRastreio).toBe(RASTREIO);
    expect(r.externalOptionId).toBe('11006');
    expect(r.pacotes).toHaveLength(1);
    expect(r.pacotes[0]!.estadoMarketplace).toBe('LOGISTICS_REQUEST_CREATED');
    expect(texto).toContain(PKG_A);
    expect(texto).toContain('2026-09-09T17:02:34.000Z');
  });

  it('15b. um bloco ausente, nulo ou de outro tipo responde `null` e a renderização diz isso', () => {
    for (const valor of [null, undefined, 'iniciado', [1, 2]]) {
      expect(resumoDoFreteArmazenado(valor)).toBeNull();
    }
    expect(renderFreteArmazenado(null)).toEqual(['  (o pedido não tem freteInicial)']);
    // Um bloco sem `pacotes` (o estado normal de todo pedido não-Shopee) lê
    // como uma lista vazia, nunca como um estouro.
    const r = resumoDoFreteArmazenado({ estado: ESTADO_FRETE.iniciado })!;
    expect(r.pacotes).toEqual([]);
    expect(r.codRastreio).toBeNull();
    expect(renderFreteArmazenado(r).join('\n')).toContain('pacotes (0)');
  });
});
