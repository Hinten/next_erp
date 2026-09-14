import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIPO_CLIENTE, cpfCnpjUtilizavel } from '@delfrance/schemas';
import {
  CAPTURA_COMPRADOR_ESTADO,
  STATUS_SHOPEE_FORA_DA_JANELA,
  avaliarCapturaComprador,
  clienteDeShopee,
  enderecoDeShopee,
  type DetalheCompradorShopee,
  type EnderecoShopee,
} from './comprador';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/*                                                                            */
/*  ⚠️ Nada aqui é dado real: os dois documentos são os sintéticos canônicos   */
/*  e o primeiro teste do arquivo prova que ainda são VÁLIDOS pelo validador   */
/*  de produção — sem isso, um "CPF limpo" que na verdade não passa nos        */
/*  dígitos verificadores faria toda a suíte concordar pelo motivo errado.     */
/* -------------------------------------------------------------------------- */

const CPF = '12345678909';
const CNPJ = '11222333000181';
/** O mesmo CPF com o último dígito verificador trocado. */
const CPF_DV_ERRADO = '12345678900';

const ENDERECO_LIMPO: EnderecoShopee = {
  name: 'Joaquin da Silva',
  phone: '11987654321',
  town: 'Vila Olímpia',
  district: 'Itaim Bibi',
  city: 'São Paulo',
  state: 'SP',
  region: 'BR',
  zipcode: '01310-100',
  full_address: 'Avenida Paulista, 1578, apto 92, Bela Vista, São Paulo - SP',
};

function detalhe(over: Partial<DetalheCompradorShopee> = {}): DetalheCompradorShopee {
  return {
    region: 'BR',
    order_status: 'READY_TO_SHIP',
    buyer_cpf_id: CPF,
    recipient_address: ENDERECO_LIMPO,
    ...over,
  };
}

function comEndereco(over: Partial<EnderecoShopee>): DetalheCompradorShopee {
  return detalhe({ recipient_address: { ...ENDERECO_LIMPO, ...over } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('os documentos sintéticos deste arquivo', () => {
  it('são algoritmicamente válidos — senão toda a suíte concordaria pelo motivo errado', () => {
    expect(cpfCnpjUtilizavel(CPF)).toBe(CPF);
    expect(cpfCnpjUtilizavel(CNPJ)).toBe(CNPJ);
    expect(cpfCnpjUtilizavel(CPF_DV_ERRADO)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              clienteDeShopee                               */
/* -------------------------------------------------------------------------- */

describe('clienteDeShopee', () => {
  it('nome e CPF limpos ⇒ cliente pessoa física, telefone NULL', () => {
    const cliente = clienteDeShopee(detalhe());
    expect(cliente).toEqual({
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Joaquin da Silva',
      cpf_cnpj: CPF,
      idEstrangeiro: null,
      ie: null,
      telefone: null,
      email: null,
    });
  });

  it('⚠️ NEAR-MISS: um documento de 14 ⇒ pessoa JURÍDICA, não pessoa física', () => {
    expect(clienteDeShopee(detalhe({ buyer_cpf_id: CPF }))?.tipo).toBe(TIPO_CLIENTE.pessoaFisica);
    expect(clienteDeShopee(detalhe({ buyer_cpf_id: CNPJ }))?.tipo).toBe(
      TIPO_CLIENTE.pessoaJuridica,
    );
    expect(clienteDeShopee(detalhe({ buyer_cpf_id: CNPJ }))?.cpf_cnpj).toBe(CNPJ);
  });

  it('nome mascarado + CPF limpo ⇒ NULL (as duas formas de máscara)', () => {
    expect(clienteDeShopee(comEndereco({ name: 'J******n' }))).toBeNull();
    expect(clienteDeShopee(comEndereco({ name: '****' }))).toBeNull();
  });

  it('CPF mascarado + nome limpo ⇒ NULL', () => {
    expect(clienteDeShopee(detalhe({ buyer_cpf_id: '***.***.***-**' }))).toBeNull();
    expect(clienteDeShopee(detalhe({ buyer_cpf_id: null }))).toBeNull();
  });

  it('⚠️ NEAR-MISS: um CPF com dígito verificador errado ⇒ NULL — o refine do schema derrubaria a importação de dentro do add()', () => {
    expect(clienteDeShopee(detalhe({ buyer_cpf_id: CPF }))).not.toBeNull();
    expect(clienteDeShopee(detalhe({ buyer_cpf_id: CPF_DV_ERRADO }))).toBeNull();
  });

  it('region diferente de BR ⇒ NULL, mesmo com nome e documento limpos', () => {
    expect(clienteDeShopee(detalhe({ region: 'SG' }))).toBeNull();
    // ⚠️ A leitura é a region do PEDIDO. A do recipient_address está dentro do
    // bloco que a máscara esconde — lê-la marcaria como estrangeiro todo pedido
    // brasileiro mascarado.
    expect(clienteDeShopee(comEndereco({ region: 'SG' }))).not.toBeNull();
  });

  it('buyer_username NUNCA vira nome, nem como fallback', () => {
    const comUsername = {
      ...comEndereco({ name: '****' }),
      buyer_username: 'joaquin_da_silva',
    } as DetalheCompradorShopee;
    expect(clienteDeShopee(comUsername)).toBeNull();
  });

  it('o telefone nunca sai da função — nem limpo, nem sanitizado', () => {
    const cliente = clienteDeShopee(detalhe());
    expect(cliente?.telefone).toBeNull();
    expect(JSON.stringify(cliente)).not.toContain(ENDERECO_LIMPO.phone);
  });

  it('sem recipient_address ⇒ NULL', () => {
    expect(clienteDeShopee(detalhe({ recipient_address: null }))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                             enderecoDeShopee                               */
/* -------------------------------------------------------------------------- */

describe('enderecoDeShopee', () => {
  it('usa o full_address INTEIRO como logradouro e NÃO divide por vírgula', () => {
    const saida = enderecoDeShopee(ENDERECO_LIMPO, 'BR');
    expect(saida?.kind).toBe('ok');
    if (saida?.kind !== 'ok') throw new Error('esperava ok');
    // Cinco partes separadas por vírgula: o legado assumia quatro e trocava tudo
    // de lugar. O valor sobrevive inteiro (o builder corta em 60 caracteres).
    expect(ENDERECO_LIMPO.full_address?.split(', ')).toHaveLength(5);
    expect(saida.fields.logradouro).toBe(ENDERECO_LIMPO.full_address);
    expect(saida.fields.numero).toBe('S/N');
    expect(saida.fields.cep).toBe('01310100');
    expect(saida.fields.estado).toBe('SP');
    // paisId 'BR' é o default implícito e grava null.
    expect(saida.fields.pais).toBeNull();
  });

  it('⚠️ NEAR-MISS: o bairro sai de district, e cai para town só quando district está vazio', () => {
    const comDistrict = enderecoDeShopee(ENDERECO_LIMPO, 'BR');
    expect(comDistrict?.kind === 'ok' && comDistrict.fields.bairro).toBe('Itaim Bibi');
    const semDistrict = enderecoDeShopee({ ...ENDERECO_LIMPO, district: '' }, 'BR');
    expect(semDistrict?.kind === 'ok' && semDistrict.fields.bairro).toBe('Vila Olímpia');
  });

  it('⚠️ um district MASCARADO cai para town — não é um bairro chamado "****"', () => {
    const saida = enderecoDeShopee({ ...ENDERECO_LIMPO, district: '****' }, 'BR');
    expect(saida?.kind === 'ok' && saida.fields.bairro).toBe('Vila Olímpia');
  });

  it('nome, full_address ou zipcode mascarados ⇒ NULL, nada é montado', () => {
    expect(enderecoDeShopee({ ...ENDERECO_LIMPO, name: '****' }, 'BR')).toBeNull();
    expect(enderecoDeShopee({ ...ENDERECO_LIMPO, full_address: '****' }, 'BR')).toBeNull();
    expect(enderecoDeShopee({ ...ENDERECO_LIMPO, zipcode: '*****-***' }, 'BR')).toBeNull();
    expect(enderecoDeShopee({ ...ENDERECO_LIMPO, full_address: null }, 'BR')).toBeNull();
    expect(enderecoDeShopee(null, 'BR')).toBeNull();
  });

  it('um zipcode presente mas impossível devolve sem-cep ao chamador — não é engolido', () => {
    // 6 dígitos: um CEP que existe no payload e não vira um CEP brasileiro.
    const saida = enderecoDeShopee({ ...ENDERECO_LIMPO, zipcode: '188021' }, 'SG');
    expect(saida?.kind).toBe('sem-cep');
  });

  it('um estado desconhecido devolve uf-desconhecida COM os campos — o chamador recupera pelo CEP', () => {
    const saida = enderecoDeShopee({ ...ENDERECO_LIMPO, state: 'Selangor' }, 'BR');
    expect(saida?.kind).toBe('uf-desconhecida');
    if (saida?.kind !== 'uf-desconhecida') throw new Error('esperava uf-desconhecida');
    expect(saida.estadoRaw).toBe('Selangor');
    expect(saida.fields.logradouro).toBe(ENDERECO_LIMPO.full_address);
  });

  it('a region do PEDIDO vira paisId — um pedido não-BR grava o país', () => {
    const saida = enderecoDeShopee({ ...ENDERECO_LIMPO, zipcode: '01310-100' }, 'SG');
    expect(saida?.kind === 'ok' && saida.fields.pais).toBe('SG');
  });
});

/* -------------------------------------------------------------------------- */
/*                          avaliarCapturaComprador                           */
/* -------------------------------------------------------------------------- */

describe('avaliarCapturaComprador', () => {
  it('nome e CPF limpos ⇒ capturado, sem nenhum campo recusado', () => {
    expect(
      avaliarCapturaComprador({ detail: detalhe(), statusObservado: 'READY_TO_SHIP' }),
    ).toEqual({ estado: CAPTURA_COMPRADOR_ESTADO.capturado, camposRecusados: [] });
  });

  it('nome limpo + CPF mascarado ⇒ pendente e ["cpf_cnpj:mascarado"]', () => {
    expect(
      avaliarCapturaComprador({
        detail: detalhe({ buyer_cpf_id: '***.***.***-**' }),
        statusObservado: 'READY_TO_SHIP',
      }),
    ).toEqual({
      estado: CAPTURA_COMPRADOR_ESTADO.pendente,
      camposRecusados: ['cpf_cnpj:mascarado'],
    });
  });

  it('⚠️ NEAR-MISS: DV inválido diz "invalido", não "mascarado" — só o segundo melhora esperando', () => {
    expect(
      avaliarCapturaComprador({
        detail: detalhe({ buyer_cpf_id: CPF_DV_ERRADO }),
        statusObservado: 'READY_TO_SHIP',
      }).camposRecusados,
    ).toEqual(['cpf_cnpj:invalido']);
    expect(
      avaliarCapturaComprador({
        detail: detalhe({ buyer_cpf_id: '***.***.***-**' }),
        statusObservado: 'READY_TO_SHIP',
      }).camposRecusados,
    ).toEqual(['cpf_cnpj:mascarado']);
  });

  it('nome e CPF mascarados ⇒ os DOIS campos recusados, um por campo', () => {
    expect(
      avaliarCapturaComprador({
        detail: { ...comEndereco({ name: 'J******n' }), buyer_cpf_id: '****' },
        statusObservado: 'PROCESSED',
      }).camposRecusados,
    ).toEqual(['nome:mascarado', 'cpf_cnpj:mascarado']);
  });

  it('um CPF ausente é "ausente", não "mascarado"', () => {
    expect(
      avaliarCapturaComprador({
        detail: detalhe({ buyer_cpf_id: null }),
        statusObservado: 'READY_TO_SHIP',
      }).camposRecusados,
    ).toEqual(['cpf_cnpj:ausente']);
  });

  it('region "SG" ⇒ expirado com "regiao:nao-br", e NADA sobre máscara', () => {
    const saida = avaliarCapturaComprador({
      detail: detalhe({ region: 'SG' }),
      statusObservado: 'READY_TO_SHIP',
    });
    expect(saida).toEqual({
      estado: CAPTURA_COMPRADOR_ESTADO.expirado,
      camposRecusados: ['regiao:nao-br'],
    });
    expect(saida.camposRecusados.join()).not.toContain('mascarado');
  });

  it('⚠️ NEAR-MISS: cada status FORA da janela expira; um status DENTRO dela segue pendente', () => {
    for (const status of STATUS_SHOPEE_FORA_DA_JANELA) {
      expect(
        avaliarCapturaComprador({
          detail: detalhe({ buyer_cpf_id: '****' }),
          statusObservado: status,
        }).estado,
      ).toBe(CAPTURA_COMPRADOR_ESTADO.expirado);
    }
    for (const status of ['UNPAID', 'PENDING', 'READY_TO_SHIP', 'PROCESSED', 'RETRY_SHIP']) {
      expect(
        avaliarCapturaComprador({
          detail: detalhe({ buyer_cpf_id: '****' }),
          statusObservado: status,
        }).estado,
      ).toBe(CAPTURA_COMPRADOR_ESTADO.pendente);
    }
  });

  it('⚠️ um status fora da janela COM captura continua capturado — a janela só decide quem falhou', () => {
    expect(
      avaliarCapturaComprador({ detail: detalhe(), statusObservado: 'COMPLETED' }).estado,
    ).toBe(CAPTURA_COMPRADOR_ESTADO.capturado);
  });

  it('nenhum campo recusado carrega VALOR — só o nome do campo e o veredito', () => {
    const saida = avaliarCapturaComprador({
      detail: { ...comEndereco({ name: 'Joaquin da Silva' }), buyer_cpf_id: CPF_DV_ERRADO },
      statusObservado: 'READY_TO_SHIP',
    });
    const serializado = JSON.stringify(saida.camposRecusados);
    expect(serializado).not.toContain(CPF_DV_ERRADO);
    expect(serializado).not.toContain('Joaquin');
    expect(serializado).not.toContain(ENDERECO_LIMPO.phone);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   logs                                     */
/* -------------------------------------------------------------------------- */

describe('o adaptador não loga nada', () => {
  it('nenhum console.* é chamado em nenhum caminho — o diário é o registro, e um log é por onde um valor vazaria', () => {
    const espioes = (['log', 'info', 'warn', 'error', 'debug'] as const).map((nivel) =>
      vi.spyOn(console, nivel).mockImplementation(() => {}),
    );

    clienteDeShopee(detalhe());
    clienteDeShopee(comEndereco({ name: '****' }));
    clienteDeShopee(detalhe({ region: 'SG' }));
    enderecoDeShopee(ENDERECO_LIMPO, 'BR');
    enderecoDeShopee({ ...ENDERECO_LIMPO, zipcode: '188021' }, 'SG');
    enderecoDeShopee({ ...ENDERECO_LIMPO, name: '****' }, 'BR');
    avaliarCapturaComprador({ detail: detalhe(), statusObservado: 'READY_TO_SHIP' });
    avaliarCapturaComprador({
      detail: detalhe({ buyer_cpf_id: '****' }),
      statusObservado: 'SHIPPED',
    });

    for (const espiao of espioes) {
      const argumentos = JSON.stringify(espiao.mock.calls);
      expect(argumentos).not.toContain(CPF);
      expect(argumentos).not.toContain('Joaquin');
      expect(espiao).not.toHaveBeenCalled();
    }
  });
});
