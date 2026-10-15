/**
 * Order-import bodies in the SHAPE of the store owner's sanitized captures
 * (`GET /v1/pedido/{numero}/` and `GET /v1/situacao_historico/search/`, D17):
 * the same keys, the same JSON type at every leaf, the same decimal places in
 * every quoted amount, the same nesting.
 *
 * ⚠️ Every VALUE here is invented. The captures live with the app that owns
 * them (`apps/loja-integrada`); this package copies only their shape, so its
 * schema tests run against what the provider really sends without carrying a
 * single captured value. The two exceptions are not captured either: the
 * numero `165` and the pagamento id `69291176` are the public document's own
 * example values.
 *
 * What the shape pins, leaf by leaf:
 *
 *  - money is a quoted decimal: line prices with FOUR places, totals and
 *    payments with two, quantities and weights with three;
 *  - one instalment value is a JSON NUMBER (the card order), and the instalment
 *    plan is `{}` on the other payment forms;
 *  - `preco_custo` is a non-numeric string;
 *  - `sku` is 14 to 17 digits, quoted;
 *  - `itens[].produto` is a string; the shipping method of a pickup has
 *    `tipo: null`;
 *  - the situação is the full catalogue object, flags included;
 *  - `cupom_desconto` is an object on some orders, `null` on others.
 */

export const NUMERO_EXEMPLO = 165;

function situacao(id: number, codigo: string, flags: [boolean, boolean, boolean]) {
  const [aprovado, cancelado, final] = flags;
  return {
    aprovado,
    cancelado,
    codigo,
    final,
    id,
    nome: 'Situação sintética',
    notificar_comprador: true,
    padrao: false,
    resource_uri: `/api/v1/situacao/${String(id)}`,
  };
}

/** A shipped card order with two lines, in the captured shape. */
export const pedidoCartaoNaFormaCapturada = {
  cliente: {
    cnpj: null,
    cpf: '000.000.000-00',
    data_nascimento: null,
    email: 'comprador@exemplo.invalid',
    id: 1001,
    nome: 'Comprador Sintético',
    razao_social: null,
    resource_uri: '/api/v1/cliente/1001',
    sexo: '',
    telefone_celular: '(00) 00000-0000',
    telefone_principal: null,
  },
  cliente_obs: '',
  cupom_desconto: {
    aplicar_no_total: false,
    ativo: true,
    categorias: [],
    clientes: [],
    codigo: 'CUPOM-SINTETICO',
    condicao_cliente: 'todos',
    condicao_produto: 'todos',
    cumulativo: false,
    data_criacao: '2026-01-01T00:00:00.000000',
    data_modificacao: '2026-01-01T00:00:00.000000',
    descricao: 'Cupom sintético',
    grupos: [],
    id: 77,
    id_externo: null,
    produtos: [],
    quantidade: 10,
    quantidade_por_cliente: 1,
    quantidade_usada: 2,
    resource_uri: '/api/v1/cupom/77',
    tipo: 'porcentagem',
    validade: '2026-12-31',
    valor: '10.00',
    valor_minimo: null,
  },
  data_criacao: '2026-09-10T14:03:11.482913',
  data_expiracao: '2026-09-16T14:03:11.482913',
  data_modificacao: '2026-09-12T09:15:42.105377',
  endereco_entrega: {
    bairro: 'Bairro Sintético',
    cep: '00000-000',
    cidade: 'Cidade Sintética',
    cnpj: null,
    complemento: '',
    cpf: '000.000.000-00',
    endereco: 'Rua Sintética',
    estado: 'Estado Sintético',
    id: 2002,
    ie: null,
    nome: 'Destinatário Sintético',
    numero: '100',
    pais: 'Brasil',
    razao_social: null,
    referencia: null,
    rg: null,
    tipo: 'PF',
  },
  envios: [
    {
      data_criacao: '2026-09-10T14:03:11.601234',
      data_modificacao: '2026-09-12T09:15:41.998877',
      forma_envio: { code: 'SERVICO-A', id: 3003, nome: 'Transportadora Sintética', tipo: 'pac' },
      id: 4004,
      link_rastreio: null,
      objeto: 'XX000000000XX',
      pedido: `/api/v1/pedido/${String(NUMERO_EXEMPLO)}`,
      prazo: 7,
      valor: '18.50',
    },
  ],
  id: 0,
  id_anymarket: null,
  id_externo: null,
  integration_data: null,
  itens: [
    {
      altura: 10,
      disponibilidade: 0,
      id: 5005,
      largura: 20,
      linha: 1,
      ncm: null,
      nome: 'Produto Sintético A',
      pedido: `/api/v1/pedido/${String(NUMERO_EXEMPLO)}`,
      peso: '0.300',
      preco_cheio: '59.9000',
      preco_custo: 'custo indisponível',
      preco_promocional: null,
      preco_subtotal: '119.8000',
      preco_venda: '59.9000',
      produto: 'produto-sintetico-a',
      produto_pai: '/api/v1/produto/6006',
      profundidade: 5,
      quantidade: '2.000',
      sku: '12345678901234567',
      tipo: 'atributo_opcao',
      variacao: {
        Tamanho: { nome: 'M' },
        Cor: { cor: '#000000', cor_secundaria: null, nome: 'Preto' },
      },
    },
    {
      altura: 2,
      disponibilidade: 0,
      id: 5006,
      largura: 15,
      linha: 2,
      ncm: null,
      nome: 'Produto Sintético B',
      pedido: `/api/v1/pedido/${String(NUMERO_EXEMPLO)}`,
      peso: '0.100',
      preco_cheio: '29.9000',
      preco_custo: '',
      preco_promocional: null,
      preco_subtotal: '29.9000',
      preco_venda: '29.9000',
      produto: 'produto-sintetico-b',
      produto_pai: '/api/v1/produto/6007',
      profundidade: 2,
      quantidade: '1.000',
      sku: '12345678901234',
      tipo: 'atributo_opcao',
      variacao: { Tamanho: { nome: 'U' } },
    },
  ],
  numero: NUMERO_EXEMPLO,
  pagamentos: [
    {
      authorization_code: null,
      banco: null,
      bandeira: 'bandeira-sintetica',
      boleto_url: null,
      codigo_retorno_gateway: null,
      forma_pagamento: {
        codigo: 'gateway-sintetico-cartao',
        configuracoes: { ativo: false, disponivel: false },
        id: 8008,
        imagem: 'imagem-sintetica',
        nome: 'Cartão Sintético',
        resource_uri: '/api/v1/pagamento/8008',
      },
      id: 69291176,
      identificador_id: null,
      mensagem_gateway: null,
      pagamento_tipo: 'creditCard',
      parcelamento: { numero_parcelas: 3, valor_parcela: 50.73 },
      pix_code: null,
      pix_qrcode: null,
      transacao_id: 'transacao-sintetica',
      valor: '152.20',
      valor_pago: '152.20',
    },
  ],
  peso_real: '0.700',
  resource_uri: `/api/v1/pedido/${String(NUMERO_EXEMPLO)}`,
  situacao: situacao(11, 'pedido_enviado', [true, false, true]),
  utm_campaign: 'campanha-sintetica',
  valor_desconto: '16.00',
  valor_envio: '18.50',
  valor_subtotal: '149.70',
  valor_total: '152.20',
};

/** The same order before any capture: awaiting a PIX payment, no tracking, no coupon. */
export const pedidoPixNaFormaCapturada = {
  ...pedidoCartaoNaFormaCapturada,
  cupom_desconto: null,
  envios: [
    {
      ...pedidoCartaoNaFormaCapturada.envios[0],
      forma_envio: { code: 'RETIRADA', id: 3004, nome: 'Retirar pessoalmente', tipo: null },
      objeto: null,
    },
  ],
  pagamentos: [
    {
      ...pedidoCartaoNaFormaCapturada.pagamentos[0],
      bandeira: null,
      pagamento_tipo: 'instantPayment',
      parcelamento: {},
      pix_code: 'codigo-pix-sintetico',
      pix_qrcode: 'qrcode-sintetico',
    },
  ],
  situacao: situacao(2, 'aguardando_pagamento', [false, false, false]),
};

/** A two-row situação history in the captured shape: 9 → 2, then 2 → 8. */
export const historicoCanceladoNaFormaCapturada = {
  meta: { limit: 20, next: null, offset: 0, previous: null, total_count: 2 },
  objects: [
    {
      alterado_por: 'sistema',
      alterado_por_nome: 'Sistema',
      data: '2026-09-10T14:03:12.000117',
      id: 9001,
      numero: NUMERO_EXEMPLO,
      obs: null,
      resource_uri: '/api/v1/situacao_historico/9001',
      situacao: situacao(2, 'aguardando_pagamento', [false, false, false]),
      situacao_anterior: situacao(9, 'pedido_efetuado', [false, false, false]),
    },
    {
      alterado_por: 'sistema',
      alterado_por_nome: 'Sistema',
      data: '2026-09-16T14:03:12.774410',
      id: 9002,
      numero: NUMERO_EXEMPLO,
      obs: null,
      resource_uri: '/api/v1/situacao_historico/9002',
      situacao: situacao(8, 'pedido_cancelado', [false, true, true]),
      situacao_anterior: situacao(2, 'aguardando_pagamento', [false, false, false]),
    },
  ],
};
