/**
 * The replay ENGINE over `FakeDb` — the same double the script hands it.
 *
 * The captures are built as TEXT from the committed SG wire bodies, with
 * inline BR vectors (`importarPedido.test.ts`'s `detalheBR` shape) on top: the
 * repo's sanctioned fake CPF, an invented address. Never a captured body.
 *
 * Every case runs the REAL importer through the REAL Shopee client: what is
 * faked is the wire (the replay `fetch`) and the database, nothing between.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { TIPO_CLIENTE } from '@delfrance/schemas';
import { ShopeeSchemaError } from '@delfrance/integrations-shopee';

import {
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  WIRE_DIR,
} from '../fixtures/wireCorpus';
import { gerarCnpj } from '../testing/documentos';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  ATRASO_DA_SEGUNDA_PASSADA_MS,
  INT_FRETE_DA_REPRODUCAO,
  caminhosAlterados,
  criarFetchDeReproducao,
  linhasDeSemente,
  reproduzirPedidoShopee,
  type EntradaReproducao,
} from './reproduzirPedido';
import { CapturaInvalidaError, ChamadaNaoCapturadaError } from './reproduzirPedidoCli';

/* -------------------------------------------------------------------------- */
/*                                  vectors                                    */
/* -------------------------------------------------------------------------- */

const NOW_MS = 1_789_000_000_000;
/** The repo's one sanctioned fake CPF (`comprador.ts`). */
const CPF_FALSO = '12345678909';

interface Envelope {
  readonly error: string;
  readonly message: string;
  readonly response: Record<string, unknown>;
}

function lerWire(nome: string): Envelope {
  return JSON.parse(readFileSync(join(WIRE_DIR, nome), 'utf8')) as Envelope;
}

const DETALHE_SG = lerWire(FIXTURE_ORDER_DETAIL_QTY2_SG);
const ESCROW_SG = lerWire(FIXTURE_ESCROW_DETAIL_QTY2_SG);
const LINHA_SG = (DETALHE_SG.response.order_list as Record<string, unknown>[])[0]!;
const ORDER_SN = LINHA_SG.order_sn as string;

/** A BR order with a CLEAR buyer — the three optional fields the SG body predates included. */
function linhaBR(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(LINHA_SG),
    region: 'BR',
    currency: 'BRL',
    buyer_cpf_id: CPF_FALSO,
    buyer_username: 'compradora.exemplo',
    buyer_user_id: 734512908,
    note: '',
    note_update_time: 0,
    return_request_due_date: 0,
    recipient_address: {
      name: 'Fulana Exemplo da Silva',
      phone: '11988887777',
      town: '',
      district: 'Jardim Exemplo',
      city: 'Cidade Exemplo',
      state: 'SP',
      region: 'BR',
      zipcode: '01001000',
      full_address: 'Rua das Acacias Exemplo, 742, Jardim Exemplo',
    },
    ...patch,
  };
}

/** The same order outside the unmask window's reach: everything buyer-side starred. */
function linhaBRMascarada(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const base = linhaBR();
  return {
    ...base,
    buyer_cpf_id: '***********',
    recipient_address: {
      ...(base.recipient_address as Record<string, unknown>),
      name: '****',
      phone: '****',
      full_address: '****',
    },
    ...patch,
  };
}

function detalheTexto(...linhas: Record<string, unknown>[]): string {
  return JSON.stringify({ error: '', message: '', response: { order_list: linhas } });
}

function escrowTexto(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...ESCROW_SG, response: { ...ESCROW_SG.response, ...over } });
}

function novoDb(): FakeDb {
  const db = new FakeDb();
  for (const [caminho, dados] of linhasDeSemente()) db.seed(caminho, { ...dados });
  return db;
}

const viaCepStub = () => ({ buscarCep: vi.fn(() => Promise.resolve(null)) });

function entrada(over: Partial<EntradaReproducao> = {}): EntradaReproducao {
  return {
    detalheTexto: detalheTexto(linhaBR()),
    escrowTexto: escrowTexto(),
    orderSn: null,
    nowMs: NOW_MS,
    viaCep: viaCepStub(),
    ...over,
  };
}

beforeEach(() => __resetAllReadCaches());
afterEach(() => {
  __resetAllReadCaches();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                               the buyer arms                                */
/* -------------------------------------------------------------------------- */

describe('reproduzirPedidoShopee — o comprador de verdade, pelo importador de verdade', () => {
  it('comprador limpo: cliente CRIADO, endereço vinculado, capturado — e a 2ª passada não muda nada', async () => {
    const db = novoDb();
    const r = await reproduzirPedidoShopee(asDb(db), entrada());

    expect(r.orderSn).toBe(ORDER_SN);
    expect(r.primeira).toMatchObject({ acao: 'criado', orderStatus: 'READY_TO_SHIP' });
    const pedido = r.leitura.pedido!.dados;
    expect(pedido.capturaComprador).toMatchObject({ estado: 'capturado', camposRecusados: [] });

    // The cliente the pedido links, created by THIS run (the database had none).
    expect(r.clientesAntes.ids).toEqual([]);
    expect(r.leitura.cliente).not.toBeNull();
    expect(r.leitura.cliente!.dados.cpf_cnpj).toBe(CPF_FALSO);
    expect(r.leitura.cliente!.dados.nome).toBe('Fulana Exemplo da Silva');
    // …and the endereço under it, as the fiscal AND the delivery address.
    expect(r.leitura.endereco).not.toBeNull();
    expect(r.leitura.endereco!.caminho).toMatch(
      new RegExp(`^clientes/${r.leitura.cliente!.id}/enderecos/`),
    );
    expect(r.leitura.endereco!.dados).toMatchObject({ cep: '01001000', estado: 'SP' });
    const frete = pedido.freteInicial as Record<string, unknown>;
    expect(frete.enderecoFreteOuterReference).toBe(pedido.enderecoFiscalOuterRef);
    // The seeded conta's ACTIVE int_frete doc — the ref a production conta's create gets.
    expect(frete.integracaoFreteOuterRef).toBe(`documents/int_frete/${INT_FRETE_DA_REPRODUCAO}`);

    // The idempotence probe.
    expect(r.segunda.acao).toBe('ignorado-sem-mudanca');
    expect(r.documentosAlterados).toEqual([]);
    expect(r.leituraFinal.clientes).toEqual({ ids: [r.leitura.cliente!.id], truncado: false });

    // Both passes were served from the captures, and nothing else was asked.
    expect(r.chamadas).toEqual([
      { path: '/api/v2/order/get_order_detail', servido: true },
      { path: '/api/v2/payment/get_escrow_detail', servido: true },
      { path: '/api/v2/order/get_order_detail', servido: true },
      { path: '/api/v2/payment/get_escrow_detail', servido: true },
    ]);
    // SP maps on its own: ViaCEP is never asked.
    expect(r.consultasViaCep).toBe(0);
    expect(r.escrowCapturado).toBe('resposta');
  });

  it('o comparador da 2ª passada ACHA uma mudança quando há uma — o zero acima não é vácuo', async () => {
    const r = await reproduzirPedidoShopee(asDb(novoDb()), entrada());
    const mexida = structuredClone(r.leitura);
    expect(caminhosAlterados(r.leitura, mexida)).toEqual([]);

    (mexida.pedido!.dados as Record<string, unknown>).valorCobrado = 1;
    expect(caminhosAlterados(r.leitura, mexida)).toEqual([r.leitura.pedido!.caminho]);

    // A document that VANISHED (or appeared) is a change too.
    const semCliente = { ...structuredClone(r.leitura), cliente: null };
    expect(caminhosAlterados(r.leitura, semCliente)).toEqual([r.leitura.cliente!.caminho]);
  });

  it('comprador PJ: o documento de 14 dígitos vira um cliente pessoa jurídica', async () => {
    const cnpj = gerarCnpj('112223330001');
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({ detalheTexto: detalheTexto(linhaBR({ buyer_cpf_id: cnpj })) }),
    );
    expect(r.leitura.pedido!.dados.capturaComprador).toMatchObject({ estado: 'capturado' });
    expect(r.leitura.cliente!.dados.cpf_cnpj).toBe(cnpj);
    expect(r.leitura.cliente!.dados.tipo).toBe(TIPO_CLIENTE.pessoaJuridica);
  });

  it('mascarado DENTRO da janela (READY_TO_SHIP): nenhum cliente, nenhum endereço, pendente', async () => {
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({ detalheTexto: detalheTexto(linhaBRMascarada()) }),
    );
    expect(r.primeira.acao).toBe('criado');
    const captura = r.leitura.pedido!.dados.capturaComprador as Record<string, unknown>;
    expect(captura.estado).toBe('pendente');
    expect(captura.camposRecusados).toEqual(['nome:mascarado', 'cpf_cnpj:mascarado']);
    expect(r.leitura.cliente).toBeNull();
    expect(r.leitura.endereco).toBeNull();
    expect(r.leituraFinal.clientes.ids).toEqual([]);
  });

  it('mascarado e COMPLETED: a janela fechou — expirado', async () => {
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({ detalheTexto: detalheTexto(linhaBRMascarada({ order_status: 'COMPLETED' })) }),
    );
    expect(r.leitura.pedido!.dados.capturaComprador).toMatchObject({ estado: 'expirado' });
    expect(r.leitura.cliente).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                         the endereço arms, and ViaCEP                       */
/* -------------------------------------------------------------------------- */

/** A clear buyer whose `state` no UF table maps — the ViaCEP fallback's input. */
function linhaBRUfDesconhecida(): Record<string, unknown> {
  const base = linhaBR();
  return linhaBR({
    recipient_address: {
      ...(base.recipient_address as Record<string, unknown>),
      state: 'Estado Desconhecido',
    },
  });
}

describe('reproduzirPedidoShopee — o endereço, e o ViaCEP que o importador consulta', () => {
  it('UF que não mapeia + o STUB: UMA consulta, o AC do construtor, e o diário diz uf-desconhecida', async () => {
    const viaCep = viaCepStub();
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({ detalheTexto: detalheTexto(linhaBRUfDesconhecida()), viaCep }),
    );
    // Asked once — by the first pass; the second finds the endereço already linked.
    expect(r.consultasViaCep).toBe(1);
    expect(viaCep.buscarCep).toHaveBeenCalledTimes(1);
    expect(viaCep.buscarCep).toHaveBeenCalledWith('01001000');
    const captura = r.leitura.pedido!.dados.capturaComprador as Record<string, unknown>;
    expect(captura.estado).toBe('capturado');
    expect(captura.camposRecusados).toEqual(['endereco:uf-desconhecida']);
    // Still stored and linked: the builder's AC, never a lost endereço.
    expect(r.leitura.endereco!.dados).toMatchObject({ cep: '01001000', estado: 'AC' });
    // The second pass does not re-derive the extra, so the diary changes — the
    // importer's own behaviour on a ViaCEP miss, which the report explains.
    expect(r.documentosAlterados).toEqual([r.leitura.pedido!.caminho]);
  });

  it('a mesma UF com um ViaCEP que RESPONDE: a UF dele é gravada e a 2ª passada não muda nada', async () => {
    const viaCep = {
      buscarCep: vi.fn(() =>
        Promise.resolve({
          logradouro: '',
          bairro: '',
          cidade: '',
          estado: 'SP',
          codigoMunicipio: '',
        }),
      ),
    };
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({ detalheTexto: detalheTexto(linhaBRUfDesconhecida()), viaCep }),
    );
    expect(r.consultasViaCep).toBe(1);
    expect(r.leitura.endereco!.dados).toMatchObject({ estado: 'SP' });
    expect(r.leitura.pedido!.dados.capturaComprador).toMatchObject({ camposRecusados: [] });
    expect(r.segunda.acao).toBe('ignorado-sem-mudanca');
    expect(r.documentosAlterados).toEqual([]);
  });

  it('um CEP inutilizável (sem-cep): o cliente vem, o endereço NÃO, e o diário diz por quê', async () => {
    const base = linhaBR();
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({
        detalheTexto: detalheTexto(
          linhaBR({
            recipient_address: {
              ...(base.recipient_address as Record<string, unknown>),
              zipcode: '0100',
            },
          }),
        ),
      }),
    );
    expect(r.leitura.cliente).not.toBeNull();
    expect(r.leitura.endereco).toBeNull();
    expect(r.leitura.pedido!.dados.capturaComprador).toMatchObject({
      camposRecusados: ['endereco:sem-cep'],
    });
    expect(r.consultasViaCep).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                           the idempotence probe's clock                     */
/* -------------------------------------------------------------------------- */

describe('reproduzirPedidoShopee — a 2ª passada roda num relógio POSTERIOR', () => {
  it('o atraso é a sobreposição de 5 minutos do backfill', () => {
    expect(ATRASO_DA_SEGUNDA_PASSADA_MS).toBe(5 * 60_000);
  });

  it('um update_time zerado cai no relógio do importador: a redelivery REESCREVE — e a sonda vê', async () => {
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({ detalheTexto: detalheTexto(linhaBR({ update_time: 0 })) }),
    );
    expect(r.primeira.acao).toBe('criado');
    // At the SAME clock this would read `ignorado-sem-mudanca` with nothing
    // changed — the idempotence production does not have.
    expect(r.segunda.acao).toBe('atualizado');
    expect(r.documentosAlterados).toContain(r.leitura.pedido!.caminho);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the wire seam                               */
/* -------------------------------------------------------------------------- */

describe('reproduzirPedidoShopee — o que a reprodução serve', () => {
  it('sem --escrow: o escrow falha como falha de rede e o pedido importa pelos preços do detalhe', async () => {
    const r = await reproduzirPedidoShopee(asDb(novoDb()), entrada({ escrowTexto: null }));
    expect(r.escrowCapturado).toBe('ausente');
    expect(r.escrowBruto).toBeNull();
    expect(r.primeira.acao).toBe('criado');
    expect(r.chamadas.filter((c) => c.path.endsWith('/get_escrow_detail'))).toEqual([
      { path: '/api/v2/payment/get_escrow_detail', servido: false },
      { path: '/api/v2/payment/get_escrow_detail', servido: false },
    ]);
    // The importer's OWN containment line — the production path, not ours.
    expect(r.logs.some((l) => l.includes('escrow indisponível'))).toBe(true);
    // Detail prices: 15 per unit (the detail is PER UNIT), quantity 2.
    const itens = r.leitura.pedido!.dados.itens as Record<string, Record<string, unknown>[]>;
    expect(itens.NONE![0]!.precoDeVenda).toBe(15);
  });

  it('um envelope de ERRO no --escrow é servido como veio — e contido como em produção', async () => {
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({
        escrowTexto: JSON.stringify({ error: 'error_not_found', message: 'x', response: null }),
      }),
    );
    expect(r.escrowCapturado).toBe('erro');
    expect(r.primeira.acao).toBe('criado');
    expect(
      r.chamadas.filter((c) => c.path.endsWith('/get_escrow_detail') && c.servido),
    ).toHaveLength(2);
  });

  it('um caminho que ninguém capturou é REGISTRADO e recusado', async () => {
    const { fetch: f, chamadas } = criarFetchDeReproducao({ detalhe: '{}', escrow: null });
    await expect(
      f('https://shopee-reproducao.invalid/api/v2/logistics/get_tracking_number?x=1'),
    ).rejects.toBeInstanceOf(ChamadaNaoCapturadaError);
    // The PATH only — never the query.
    expect(chamadas).toEqual([{ path: '/api/v2/logistics/get_tracking_number', servido: false }]);
  });

  it('um campo com o TIPO errado passa pelo schema de wire de verdade (ShopeeSchemaError)', async () => {
    await expect(
      reproduzirPedidoShopee(
        asDb(novoDb()),
        entrada({ detalheTexto: detalheTexto(linhaBR({ item_list: 'não é lista' })) }),
      ),
    ).rejects.toBeInstanceOf(ShopeeSchemaError);
  });

  it('um BOM no começo do arquivo (Out-File do PowerShell) não atrapalha', async () => {
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({
        detalheTexto: `﻿${detalheTexto(linhaBR())}`,
        escrowTexto: `﻿${escrowTexto()}`,
      }),
    );
    expect(r.primeira.acao).toBe('criado');
  });
});

/* -------------------------------------------------------------------------- */
/*                              the capture refusals                           */
/* -------------------------------------------------------------------------- */

describe('reproduzirPedidoShopee — capturas que não servem', () => {
  async function recusa(over: Partial<EntradaReproducao>): Promise<string> {
    const db = novoDb();
    const err: unknown = await reproduzirPedidoShopee(asDb(db), entrada(over)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapturaInvalidaError);
    // Refused BEFORE the importer: nothing was written.
    expect(db.writes).toEqual([]);
    return (err as CapturaInvalidaError).message;
  }

  it('um arquivo que não é o envelope é recusado nomeando só as CHAVES do topo', async () => {
    const mensagem = await recusa({
      detalheTexto: JSON.stringify({
        order_list: [linhaBR()],
        '123.456.789-09': 'x',
        buyer_cpf_id: CPF_FALSO,
      }),
    });
    expect(mensagem).toContain('order_list');
    expect(mensagem).toContain('buyer_cpf_id');
    // A key that is not identifier-shaped is COUNTED, never printed…
    expect(mensagem).not.toContain('123.456.789-09');
    expect(mensagem).toContain('+1 outra');
    // …and no value ever is.
    expect(mensagem).not.toContain(CPF_FALSO);
    expect(mensagem).not.toContain('Fulana');
  });

  it('um arquivo que não é JSON é recusado sem citar o conteúdo', async () => {
    const mensagem = await recusa({ detalheTexto: `Fulana Exemplo ${CPF_FALSO} {` });
    expect(mensagem).toContain('não é um JSON válido');
    expect(mensagem).not.toContain('Fulana');
    expect(mensagem).not.toContain(CPF_FALSO);
  });

  it('o --escrow de OUTRA order é recusado — comparado, nunca impresso', async () => {
    const mensagem = await recusa({ escrowTexto: escrowTexto({ order_sn: '991231ZZZZZZZZ' }) });
    expect(mensagem).toContain('par não confere');
    expect(mensagem).not.toContain(ORDER_SN);
    expect(mensagem).not.toContain('991231ZZZZZZZZ');
  });

  it('várias orders sem --order-sn: recusa; um --order-sn fora da lista: recusa', async () => {
    const outra = linhaBR({ order_sn: '991231AAAAAAAA' });
    const varias = detalheTexto(linhaBR(), outra);
    expect(await recusa({ detalheTexto: varias })).toContain('passe --order-sn');
    const fora = await recusa({ detalheTexto: varias, orderSn: '991231BBBBBBBB' });
    expect(fora).not.toContain('991231BBBBBBBB');
    expect(fora).not.toContain('991231AAAAAAAA');
  });

  it('com --order-sn escolhe a SEGUNDA linha — e é ela, com o SEU comprador, que importa e é varrida', async () => {
    const OUTRA_SN = '991231AAAAAAAA';
    const cnpj = gerarCnpj('112223330001');
    const outra = linhaBR({ order_sn: OUTRA_SN, buyer_cpf_id: cnpj });
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({
        detalheTexto: detalheTexto(linhaBR(), outra),
        escrowTexto: escrowTexto({ order_sn: OUTRA_SN }),
        orderSn: OUTRA_SN,
      }),
    );
    expect(r.orderSn).toBe(OUTRA_SN);
    // The row the residue scan reads is the one the importer imported.
    expect(r.linhaBruta.order_sn).toBe(OUTRA_SN);
    expect(r.linhaBruta.buyer_cpf_id).toBe(cnpj);
    expect(r.leitura.cliente!.dados.cpf_cnpj).toBe(cnpj);
    expect(r.primeira.acao).toBe('criado');
  });

  it('a captura de várias orders é servida ESTREITADA à escolhida: um defeito numa vizinha não derruba', async () => {
    // Production asks for ONE order_sn and never parses the sibling's row.
    const vizinhaQuebrada = linhaBR({ order_sn: '991231AAAAAAAA', item_list: 42 });
    const r = await reproduzirPedidoShopee(
      asDb(novoDb()),
      entrada({ detalheTexto: detalheTexto(linhaBR(), vizinhaQuebrada), orderSn: ORDER_SN }),
    );
    expect(r.orderSn).toBe(ORDER_SN);
    expect(r.primeira.acao).toBe('criado');
  });

  it('nenhuma order (um envelope de erro no --detalhe): recusa nomeando o código do envelope', async () => {
    const mensagem = await recusa({
      detalheTexto: JSON.stringify({ error: 'error_param', message: 'm', response: null }),
    });
    expect(mensagem).toContain('error_param');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the console                                */
/* -------------------------------------------------------------------------- */

/** The four console methods, read as REFERENCES (through `globalThis`) — never called. */
function metodosDoConsole(): readonly unknown[] {
  const c = globalThis.console;
  return [c.log, c.info, c.warn, c.error];
}

function exigirConsoleRestaurado(antes: readonly unknown[]): void {
  const depois = metodosDoConsole();
  antes.forEach((metodo, i) => expect(depois[i]).toBe(metodo));
}

describe('reproduzirPedidoShopee — o console é gravado e devolvido', () => {
  it('as linhas do importador são GRAVADAS (não impressas) e o console volta depois do sucesso', async () => {
    const antes = metodosDoConsole();
    const r = await reproduzirPedidoShopee(asDb(novoDb()), entrada());
    exigirConsoleRestaurado(antes);
    expect(r.logs.some((l) => l.startsWith('[info] [shopee/pedidos] pedido importado'))).toBe(true);
  });

  it('…e depois de um THROW também', async () => {
    const antes = metodosDoConsole();
    await expect(
      reproduzirPedidoShopee(
        asDb(novoDb()),
        entrada({ detalheTexto: detalheTexto(linhaBR({ item_list: 42 })) }),
      ),
    ).rejects.toBeInstanceOf(ShopeeSchemaError);
    exigirConsoleRestaurado(antes);
  });
});
