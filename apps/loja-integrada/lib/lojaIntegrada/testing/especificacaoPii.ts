/**
 * Response examples of the public Loja Integrada OpenAPI document (the one
 * `.master_plans/loja-integrada/evidence/li-doc.mjs` reads), transcribed for the
 * redaction tests — **for tests only**, like the rest of `testing/`.
 *
 * ## Provenance
 *
 * Each body below is the 200 example of the operation named in `operacao`, as
 * published on 2026-09-29 (the document's `last-modified`; its sha256 is in the
 * header of `especificacaoFolhas.json`), with these changes and no others:
 *
 *  - every personal value is replaced by a fake of the same role: `.invalid`
 *    e-mails, `Fulano de Tal`, `(00) 90000-0000`, `00000-000`, `Rua Exemplo, 0`;
 *  - the CPF is NOT committed: the document's example carries one with valid
 *    check digits, so the tests generate one at run time (`gerarCpf`) and pass it
 *    in (`PiiGeradaLi`);
 *  - the demo storefront's names, domains, image paths and store number become
 *    `loja.example` / `Produto Exemplo` / `0000/0000000/…`;
 *  - long lists are trimmed to their first rows;
 *  - the histórico row's `alterado_por` / `alterado_por_nome` (a gateway label in
 *    the document, a person in real data) carry the e-mail and name fakes.
 *
 * Ids, numeros, codes, dates, quantities and prices are the document's own.
 */

/** Values the tests generate at run time and inject: never committed. */
export interface PiiGeradaLi {
  /** 11 digits with valid check digits. */
  readonly cpf: string;
}

/** The fakes standing in for the document's personal values. */
export const PII_FALSA = {
  email: 'fulano@exemplo.invalid',
  nome: 'Fulano de Tal',
  telefone: '(00) 90000-0000',
  cep: '00000-000',
  logradouro: 'Rua Exemplo, 0',
  bairro: 'Bairro Exemplo',
  cidade: 'Cidade Exemplo',
} as const;

export interface ExemploEspecificacaoLi {
  /** `METHOD path` exactly as the leaf inventory names the operation. */
  readonly operacao: string;
  /** A concrete request path for it. */
  readonly caminho: string;
  readonly corpo: unknown;
}

/** The check digits of a CPF base (9 digits). */
export function gerarCpf(base9: string): string {
  const digitos = base9.split('').map(Number);
  const dv = (n: number) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += (digitos[i] ?? 0) * (n + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  digitos.push(dv(9));
  digitos.push(dv(10));
  return digitos.join('');
}

/** The check digits of a CNPJ base (12 characters, digits or A-Z). */
export function gerarCnpj(base12: string): string {
  const valores = base12
    .toUpperCase()
    .split('')
    .map((c) => c.charCodeAt(0) - 48);
  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const dv = (pesos: readonly number[]) => {
    let soma = 0;
    pesos.forEach((p, i) => {
      soma += (valores[i] ?? 0) * p;
    });
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const dv1 = dv(pesos1);
  valores.push(dv1);
  const dv2 = dv([6, ...pesos1]);
  return `${base12.toUpperCase()}${String(dv1)}${String(dv2)}`;
}

const SITUACAO_CANCELADO = {
  aprovado: false,
  cancelado: true,
  codigo: 'pedido_cancelado',
  final: true,
  id: 8,
  nome: 'Pedido Cancelado',
  notificar_comprador: true,
  padrao: false,
  resource_uri: '/api/v1/situacao/8',
};

const IMAGEM_PRINCIPAL = {
  caminho: '0000/0000000/produto/exemplo.jpg',
  grande: 'https://loja.example/800x800/0000/0000000/produto/exemplo.jpg',
  icone: 'https://loja.example/64x64/0000/0000000/produto/exemplo.jpg',
  id: 143127013,
  id_anymarket: null,
  imagem_id: 154961348,
  media: 'https://loja.example/380x380/0000/0000000/produto/exemplo.jpg',
  mime: 'image/jpeg',
  pequena: 'https://loja.example/210x210/0000/0000000/produto/exemplo.jpg',
  posicao: '0',
  principal: true,
  produto: '/api/v1/produto/238281213',
  resource_uri: '/api/v1/produto_imagem/143127013',
};

/** Every transcribed example. `pii` supplies the values that may not be committed. */
export function exemplosDaEspecificacao(pii: PiiGeradaLi): readonly ExemploEspecificacaoLi[] {
  return [
    {
      operacao: 'GET /v1/pedido/{pedido_id}',
      caminho: '/v1/pedido/165',
      corpo: {
        cliente: {
          cnpj: null,
          cpf: pii.cpf,
          data_nascimento: null,
          email: PII_FALSA.email,
          id: 34220641,
          nome: PII_FALSA.nome,
          razao_social: null,
          resource_uri: '/api/v1/cliente/34220641',
          sexo: '',
          telefone_celular: PII_FALSA.telefone,
          telefone_principal: null,
        },
        cliente_obs: null,
        cupom_desconto: null,
        data_criacao: '2022-10-31T12:28:05.704751',
        data_expiracao: '2022-11-06T12:28:05.782308',
        data_modificacao: '2022-10-31T12:28:12.653648',
        endereco_entrega: {
          bairro: PII_FALSA.bairro,
          cep: PII_FALSA.cep,
          cidade: PII_FALSA.cidade,
          cnpj: null,
          complemento: null,
          cpf: pii.cpf,
          endereco: PII_FALSA.logradouro,
          estado: 'RJ',
          id: 51870053,
          ie: 'isento',
          nome: PII_FALSA.nome,
          numero: '1',
          pais: 'Brasil',
          razao_social: null,
          referencia: null,
          rg: null,
          tipo: 'PF',
        },
        envios: [
          {
            data_criacao: '2022-10-31T12:28:05.722569',
            data_modificacao: '2022-10-31T12:28:05.722584',
            forma_envio: { code: 'PAC', id: 141909, nome: 'Enviali', tipo: 'PAC ' },
            id: 69291055,
            objeto: null,
            prazo: 7,
            valor: '21.38',
          },
        ],
        id_anymarket: null,
        id_externo: null,
        itens: [
          {
            altura: 2,
            disponibilidade: 0,
            id: 156487061,
            largura: 12,
            linha: 1,
            nome: 'Casaco infantil',
            pedido: '/api/v1/pedido/165',
            peso: '0.450',
            preco_cheio: '12.00',
            preco_custo: null,
            preco_promocional: '11.10',
            preco_subtotal: '11.10',
            preco_venda: '11.10',
            produto: {
              id_externo: 88568855,
              resource_uri: '/api/v1/produto/88568855?id_externo=1',
            },
            produto_pai: '/api/v1/produto/182904918',
            profundidade: 6,
            quantidade: '1.00',
            sku: 'casaco-azul-tam-m666',
            tipo: 'atributo_opcao',
          },
        ],
        numero: 165,
        pagamentos: [
          {
            authorization_code: null,
            banco: null,
            bandeira: 'Mastercard',
            codigo_retorno_gateway: null,
            forma_pagamento: {
              codigo: 'pagsegurov2',
              configuracoes: { ativo: true, disponivel: true },
              id: 24,
              imagem: 'https://loja.example/formas-de-pagamento/pagsegurov2-logo.png',
              nome: 'PagSeguro V2',
              resource_uri: '/api/v1/pagamento/24',
            },
            id: 69291176,
            identificador_id: null,
            mensagem_gateway: null,
            pagamento_tipo: 'creditCard',
            parcelamento: { numero_parcelas: 1, valor_parcela: 32.48 },
            transacao_id: null,
            valor: '32.48',
            valor_pago: '32.48',
          },
        ],
        peso_real: '0.450',
        resource_uri: '/api/v1/pedido/165',
        situacao: SITUACAO_CANCELADO,
        utm_campaign: null,
        valor_desconto: '0.00',
        valor_envio: '21.38',
        valor_subtotal: '11.10',
        valor_total: '32.48',
      },
    },
    {
      operacao: 'GET /v1/pedido/search',
      caminho: '/v1/pedido/search/',
      corpo: {
        meta: { limit: 15, next: null, offset: 0, previous: null, total_count: 2 },
        objects: [
          {
            cliente: '/api/v1/cliente/34220641',
            data_criacao: '2022-10-31T12:17:51.633657',
            data_expiracao: '2022-11-06T12:17:51.733114',
            data_modificacao: '2022-10-31T12:17:58.949670',
            id_anymarket: null,
            id_externo: null,
            numero: 164,
            peso_real: '0.170',
            resource_uri: '/api/v1/pedido/164',
            situacao: SITUACAO_CANCELADO,
            utm_campaign: null,
            valor_desconto: '0.00',
            valor_envio: '21.38',
            valor_subtotal: '85.00',
            valor_total: '106.38',
          },
        ],
      },
    },
    {
      operacao: 'GET /v1/situacao_historico/search',
      caminho: '/v1/situacao_historico/search/',
      corpo: {
        meta: { limit: 20, next: null, offset: 0, previous: null, total_count: 2 },
        objects: [
          {
            alterado_por: PII_FALSA.email,
            alterado_por_nome: PII_FALSA.nome,
            data: '2022-10-31T12:28:12.673363',
            id: 207232816,
            numero: 165,
            obs: null,
            resource_uri: '/api/v1/situacao_historico/207232816',
            situacao: SITUACAO_CANCELADO,
            situacao_anterior: {
              aprovado: false,
              cancelado: false,
              codigo: 'pedido_efetuado',
              final: false,
              id: 9,
              nome: 'Pedido Efetuado',
              notificar_comprador: false,
              padrao: true,
              resource_uri: '/api/v1/situacao/9',
            },
          },
        ],
      },
    },
    {
      operacao: 'GET /v1/situacao',
      caminho: '/v1/situacao/',
      corpo: {
        meta: { limit: 20, next: null, offset: 0, previous: null, total_count: 15 },
        objects: [
          {
            aprovado: false,
            cancelado: false,
            codigo: 'aguardando_pagamento',
            final: false,
            id: 2,
            nome: 'Aguardando pagamento',
            notificar_comprador: true,
            padrao: false,
            resource_uri: '/api/v1/situacao/2',
          },
          {
            aprovado: true,
            cancelado: false,
            codigo: 'em_producao',
            final: false,
            id: 17,
            nome: 'Em produção',
            notificar_comprador: true,
            padrao: false,
            resource_uri: '/api/v1/situacao/17',
          },
        ],
      },
    },
    {
      operacao: 'GET /v1/pagamento',
      caminho: '/v1/pagamento/',
      corpo: {
        meta: {
          limit: 20,
          next: '/api/v1/pagamento?limit=20&offset=20',
          offset: 0,
          previous: null,
          total_count: 27,
        },
        objects: [
          {
            codigo: 'wcboleto',
            configuracoes: { ativo: false, disponivel: true },
            id: 30,
            imagem: 'https://loja.example/formas-de-pagamento/wcboleto-logo.png',
            nome: 'Boleto Bancário',
            resource_uri: '/api/v1/pagamento/30',
          },
          {
            codigo: 'deposito',
            configuracoes: { ativo: false, disponivel: false },
            id: 7,
            imagem: 'https://loja.example/formas-de-pagamento/deposito-logo.png',
            nome: 'Depósito Bancário',
            resource_uri: '/api/v1/pagamento/7',
          },
        ],
      },
    },
    {
      operacao: 'GET /v1/pagamento/{pagamento_id}',
      caminho: '/v1/pagamento/8',
      corpo: {
        codigo: 'boleto',
        configuracoes: { ativo: false, disponivel: false },
        id: 8,
        imagem: 'https://loja.example/formas-de-pagamento/boleto-logo.png',
        nome: 'Boleto Bancário',
        resource_uri: '/api/v1/pagamento/8',
      },
    },
    {
      operacao: 'GET /v1/envio',
      caminho: '/v1/envio/',
      corpo: {
        meta: { limit: 20, next: null, offset: 0, previous: null, total_count: 12 },
        objects: [
          {
            codigo: 'enviali',
            configuracoes: { ativo: true, disponivel: true },
            id: 141909,
            imagem: null,
            nome: 'Enviali',
            resource_uri: '/api/v1/envio/141909',
            tipo: 'enviali',
          },
          {
            codigo: 'sedex',
            configuracoes: { ativo: true, disponivel: true },
            id: 1,
            imagem: 'https://loja.example/formas-de-envio/sedex-logo.png',
            nome: 'SEDEX',
            resource_uri: '/api/v1/envio/1',
            tipo: 'correios_api',
          },
        ],
      },
    },
    {
      operacao: 'GET /v1/envio/{envio_id}',
      caminho: '/v1/envio/30133',
      corpo: {
        codigo: 'mercadoenvios_normal',
        configuracoes: { ativo: false, disponivel: false },
        id: 30133,
        imagem: null,
        nome: 'MercadoEnvios Normal',
        resource_uri: '/api/v1/envio/30133',
        tipo: 'mercadoenvios_api',
      },
    },
    {
      operacao: 'GET /v1/produto/{produto_id}',
      caminho: '/v1/produto/238281213',
      corpo: {
        id: 238281213,
        altura: 15,
        apelido: 'produto-exemplo',
        ativo: true,
        bloqueado: false,
        categorias: ['/api/v1/categoria/23171713'],
        data_criacao: '2023-10-23T16:06:03.257071',
        data_modificacao: '2025-03-17T10:27:10.571236',
        descricao_completa: '',
        destaque: false,
        grades: [],
        gtin: '',
        id_externo: null,
        imagem_principal: IMAGEM_PRINCIPAL,
        imagens: [
          IMAGEM_PRINCIPAL,
          {
            caminho: '0000/0000000/produto/238281213/exemplo-2.png',
            grande: 'https://loja.example/800x800/0000/0000000/produto/exemplo-2.png',
            icone: 'https://loja.example/64x64/0000/0000000/produto/exemplo-2.png',
            id: 138518698,
            id_anymarket: null,
            imagem_id: 150044515,
            media: 'https://loja.example/380x380/0000/0000000/produto/exemplo-2.png',
            mime: null,
            pequena: 'https://loja.example/210x210/0000/0000000/produto/exemplo-2.png',
            posicao: null,
            principal: false,
            produto: '/api/v1/produto/238281213',
            resource_uri: '/api/v1/produto_imagem/138518698',
          },
        ],
        largura: 15,
        marca: '/api/v1/marca/20507618',
        mpn: '',
        ncm: '',
        nome: 'Produto Exemplo',
        peso: '0.500',
        profundidade: 15,
        removido: false,
        resource_uri: '/api/v1/produto/238281213',
        seo: '/api/v1/seo/98177864',
        sku: '16167',
        tipo: 'normal',
        url: 'https://loja.example/produto-exemplo',
        url_video_youtube: '',
        usado: false,
        variacoes: [],
        tags: [],
        preco_cheio: 100,
        preco_custo: null,
        preco_promocional: null,
        preco_sob_consulta: false,
        estoque_gerenciado: true,
        estoque_situacao_em_estoque: 0,
        estoque_situacao_sem_estoque: -1,
        estoque_quantidade: 15,
        pai: null,
      },
    },
    {
      operacao: 'GET /v1/produto_estoque/{produto_id}',
      caminho: '/v1/produto_estoque/174389010',
      corpo: {
        gerenciado: true,
        id: 109877209,
        produto: '/api/v1/produto/174389010',
        quantidade: 10,
        quantidade_disponivel: 10,
        quantidade_reservada: 0,
        resource_uri: '/api/v1/produto_estoque/174389010',
        situacao_em_estoque: 0,
        situacao_sem_estoque: -1,
      },
    },
    {
      operacao: 'GET /v1/produto_preco/{produto_id}',
      caminho: '/v1/produto_preco/174389010',
      corpo: {
        cheio: '32.83',
        custo: '32.83',
        id: 109870055,
        produto: '/api/v1/produto/174389010',
        promocional: '22.83',
        resource_uri: '/api/v1/produto_preco/174389010',
        sob_consulta: false,
      },
    },
  ];
}
