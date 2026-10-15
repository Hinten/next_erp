import type { ViaCepClient } from '@delfrance/core/cep';
import { validateCNPJ, validateCPF } from '@delfrance/core/documents';
import { liPedidoSchema } from '@delfrance/integrations-loja-integrada';
import { TIPO_CLIENTE, UF_SIGLA, clienteSchema, recoverEnderecoFromCep } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import {
  clienteDoPedidoLi,
  comRecebedorLi,
  documentoDoClienteLi,
  enderecoBrutoLi,
  enderecoDoPedidoLi,
  nomeDoRecebedorLi,
  paisIdLi,
  type ClienteLi,
  type EnderecoEntregaLi,
} from './clienteMapeamento';

/** Synthetic documents with valid check digits (the textbook examples). */
const CPF = '52998224725';
const CNPJ = '11222333000181';
/** Eleven digits that fail the check — the shape every captured buyer has. */
const CPF_INVALIDO = '12345678900';

function cliente(campos: Record<string, unknown>): ClienteLi {
  const pedido = liPedidoSchema.parse({
    numero: 1,
    situacao: { codigo: 'pedido_pago' },
    data_modificacao: '2026-10-14T10:00:00',
    cliente: { nome: 'Fulana de Tal', email: 'fulana@example.com', ...campos },
  });
  return pedido.cliente!;
}

function entrega(campos: Record<string, unknown>): EnderecoEntregaLi {
  const pedido = liPedidoSchema.parse({
    numero: 1,
    situacao: { codigo: 'pedido_pago' },
    data_modificacao: '2026-10-14T10:00:00',
    endereco_entrega: {
      nome: 'Quem Recebe',
      cep: '01310-100',
      endereco: 'Avenida Paulista',
      numero: '1000',
      complemento: 'ap 1',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      estado: 'SP',
      pais: 'Brasil',
      referencia: 'perto do metrô',
      ...campos,
    },
  });
  return pedido.endereco_entrega!;
}

describe('the synthetic documents', () => {
  it('are what this file says they are', () => {
    expect(validateCPF(CPF)).toBe(true);
    expect(validateCNPJ(CNPJ)).toBe(true);
    expect(validateCPF(CPF_INVALIDO)).toBe(false);
  });
});

describe('the buyer is the fiscal identity, from cliente.* only', () => {
  it('a PF buyer: the CPF, tipo PF, the nome, the contact', () => {
    const r = clienteDoPedidoLi(
      cliente({
        cpf: '529.982.247-25',
        telefone_celular: '(11) 99999-0000',
        telefone_principal: '1133334444',
      }),
    );
    expect(r.identidadeForte).toBe(true);
    expect(r.campos).toEqual({
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Fulana de Tal',
      cpf_cnpj: CPF,
      idEstrangeiro: null,
      ie: null,
      telefone: '(11) 99999-0000',
      email: 'fulana@example.com',
    });
    expect('idMercadoLivre' in r.campos).toBe(false);
  });

  it('a PJ buyer ⇒ the razao_social, tipo PJ, the CNPJ', () => {
    const r = clienteDoPedidoLi(cliente({ cnpj: CNPJ, razao_social: 'Empresa Exemplo Ltda' }));
    expect(r.campos).toMatchObject({
      tipo: TIPO_CLIENTE.pessoaJuridica,
      nome: 'Empresa Exemplo Ltda',
      cpf_cnpj: CNPJ,
    });
  });

  it('a PJ buyer without a usable razao_social falls back to the nome', () => {
    expect(clienteDoPedidoLi(cliente({ cnpj: CNPJ, razao_social: '' })).campos.nome).toBe(
      'Fulana de Tal',
    );
  });

  it('⚠️ NEAR-MISS: a PF buyer’s razao_social is never the name', () => {
    expect(
      clienteDoPedidoLi(cliente({ cpf: CPF, razao_social: 'Outra Coisa Ltda' })).campos.nome,
    ).toBe('Fulana de Tal');
  });

  it('an invalid 11-digit CPF (every captured buyer) ⇒ NO document, no strong identity', () => {
    const r = clienteDoPedidoLi(cliente({ cpf: CPF_INVALIDO }));
    expect(r.campos.cpf_cnpj).toBeNull();
    expect(r.campos.tipo).toBeNull();
    expect(r.identidadeForte).toBe(false);
  });

  it('⚠️ NEAR-MISS: a present but INVALID CNPJ never falls back to the CPF', () => {
    expect(documentoDoClienteLi(cliente({ cnpj: '11222333000180', cpf: CPF }))).toBeNull();
  });

  it('EQUAL pair: an empty cnpj is nothing, so the CPF decides (as with no cnpj at all)', () => {
    expect(documentoDoClienteLi(cliente({ cnpj: '', cpf: CPF }))).toBe(CPF);
    expect(documentoDoClienteLi(cliente({ cnpj: null, cpf: CPF }))).toBe(CPF);
  });

  it('⚠️ NEAR-MISS: each field holds its own document kind', () => {
    expect(documentoDoClienteLi(cliente({ cpf: CNPJ }))).toBeNull();
    expect(documentoDoClienteLi(cliente({ cnpj: CPF }))).toBeNull();
  });

  it('a masked document or name is no value', () => {
    const r = clienteDoPedidoLi(cliente({ cpf: '***.***.***-25', nome: 'F****a' }));
    expect(r.campos.cpf_cnpj).toBeNull();
    expect(r.campos.nome).toBe('');
  });

  it('the phone falls back to telefone_principal; an empty celular is nothing', () => {
    expect(
      clienteDoPedidoLi(cliente({ telefone_celular: '', telefone_principal: '1133334444' })).campos
        .telefone,
    ).toBe('1133334444');
    expect(clienteDoPedidoLi(cliente({ email: '' })).campos.email).toBeNull();
  });

  it('EQUAL pair: an address the cliente schema accepts is offered, trimmed', () => {
    expect(clienteDoPedidoLi(cliente({ email: 'fulana@example.com' })).campos.email).toBe(
      'fulana@example.com',
    );
    expect(clienteDoPedidoLi(cliente({ email: ' fulana@example.com ' })).campos.email).toBe(
      'fulana@example.com',
    );
    expect(clienteSchema.shape.email.safeParse('fulana@example.com').success).toBe(true);
  });

  it('⚠️ NEAR-MISS: an address the cliente schema REFUSES is never offered (it would park the whole order on a ZodError)', () => {
    for (const ruim of [
      'fulana.@example.com',
      'a..b@example.com',
      `${'a'.repeat(245)}@example.com`,
      'sem-arroba',
    ]) {
      expect(clienteSchema.shape.email.safeParse(ruim).success, ruim.slice(0, 20)).toBe(false);
      expect(
        clienteDoPedidoLi(cliente({ email: ruim })).campos.email,
        ruim.slice(0, 20),
      ).toBeNull();
    }
    // The phone and document legs still decide.
    const r = clienteDoPedidoLi(cliente({ email: 'a..b@example.com', cpf: CPF }));
    expect(r.campos.cpf_cnpj).toBe(CPF);
    expect(r.identidadeForte).toBe(true);
  });

  it('no buyer block ⇒ an empty identity, never a throw', () => {
    expect(clienteDoPedidoLi(null)).toEqual({
      campos: {
        tipo: null,
        nome: '',
        cpf_cnpj: null,
        idEstrangeiro: null,
        ie: null,
        telefone: null,
        email: null,
      },
      identidadeForte: false,
    });
  });

  it('⚠️ a buyer with no document beside a recipient with a valid CPF: the CPF is NEVER offered or stamped', () => {
    const comprador = cliente({ cpf: null, email: 'fulana@example.com' });
    const recebedor = entrega({ cpf: CPF, nome: 'Outra Pessoa' });
    expect(clienteDoPedidoLi(comprador).campos.cpf_cnpj).toBeNull();
    const construido = enderecoDoPedidoLi(recebedor);
    if (construido.kind === 'sem-cep') throw new Error('expected an endereço');
    const final = comRecebedorLi(construido.fields, recebedor);
    expect(final.cpf_cnpj).toBeNull();
    expect(final.telefone).toBeNull();
    expect(final.nome).toBe('Outra Pessoa');
  });
});

describe('the endereço', () => {
  it('maps the delivery block one to one; referencia is not mapped', () => {
    expect(enderecoBrutoLi(entrega({}))).toEqual({
      cepRaw: '01310-100',
      logradouro: 'Avenida Paulista',
      numero: '1000',
      complemento: 'ap 1',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      estadoRaw: 'SP',
      paisId: null,
    });
    const r = enderecoDoPedidoLi(entrega({}));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.fields.estado).toBe(UF_SIGLA.SP);
  });

  it('an absent estado ⇒ AC, ok (the builder’s contract)', () => {
    const r = enderecoDoPedidoLi(entrega({ estado: null }));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.fields.estado).toBe(UF_SIGLA.AC);
  });

  it('an unknown estado ⇒ uf-desconhecida, recovered through the INJECTED ViaCEP', async () => {
    const r = enderecoDoPedidoLi(entrega({ estado: 'Província X' }));
    expect(r.kind).toBe('uf-desconhecida');
    if (r.kind !== 'uf-desconhecida') return;
    const perguntados: string[] = [];
    const viaCep: ViaCepClient = {
      buscarCep: (cep) => {
        perguntados.push(cep);
        return Promise.resolve({
          logradouro: 'Avenida Paulista',
          bairro: 'Bela Vista',
          cidade: 'São Paulo',
          estado: 'SP',
          codigoMunicipio: '3550308',
        });
      },
    };
    const recuperado = await recoverEnderecoFromCep(r, viaCep);
    expect(perguntados).toEqual(['01310100']);
    expect(recuperado.ufResolvida).toBe(true);
    const final = comRecebedorLi(recuperado.fields, entrega({ estado: 'Província X' }));
    expect(final.estado).toBe(UF_SIGLA.SP);
    // cMun is never resolved at import.
    expect(final.codigoMunicipio).toBeNull();
    expect(final.nome).toBe('Quem Recebe');
  });

  it('no CEP ⇒ sem-cep (no endereço; the importer retries later)', () => {
    expect(enderecoDoPedidoLi(entrega({ cep: '' })).kind).toBe('sem-cep');
    expect(enderecoDoPedidoLi(null).kind).toBe('sem-cep');
  });

  it("pais: 'Brasil' ⇒ null; 'AR' ⇒ kept; 'BR' and a lowercase code ⇒ null", () => {
    expect(paisIdLi('Brasil')).toBeNull();
    expect(paisIdLi('AR')).toBe('AR');
    expect(paisIdLi('BR')).toBeNull();
    expect(paisIdLi('ar')).toBeNull();
    expect(paisIdLi('')).toBeNull();
    const r = enderecoDoPedidoLi(entrega({ pais: 'AR' }));
    if (r.kind === 'sem-cep') throw new Error('expected an endereço');
    expect(r.fields.pais).toBe('AR');
  });

  it('the recipient’s name: razao_social for a PJ recipient (a valid CNPJ), else nome; a masked one is none', () => {
    expect(nomeDoRecebedorLi(entrega({ razao_social: 'Loja Destino Ltda', cnpj: CNPJ }))).toBe(
      'Loja Destino Ltda',
    );
    expect(nomeDoRecebedorLi(entrega({ razao_social: '', cnpj: CNPJ }))).toBe('Quem Recebe');
    expect(nomeDoRecebedorLi(entrega({}))).toBe('Quem Recebe');
    expect(nomeDoRecebedorLi(entrega({ nome: 'Q****e' }))).toBeNull();
    expect(nomeDoRecebedorLi(null)).toBeNull();
  });

  it('⚠️ NEAR-MISS: a PF recipient’s razao_social is never the name — the buyer side’s rule, on the same field', () => {
    for (const campos of [
      { razao_social: 'Outra Coisa Ltda' },
      { razao_social: 'Outra Coisa Ltda', cpf: CPF },
      { razao_social: 'Outra Coisa Ltda', cnpj: '11222333000180' },
    ]) {
      expect(nomeDoRecebedorLi(entrega(campos)), JSON.stringify(campos)).toBe('Quem Recebe');
    }
  });
});
