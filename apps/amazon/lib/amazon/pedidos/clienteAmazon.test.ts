import { describe, expect, it } from 'vitest';

import { gerarCnpj, gerarCpf, pontuarCnpj, pontuarCpf } from '../testing/documentos';
import { pedidoAmazon } from '../testing/pedidoWireAmazon';
import {
  enderecoBrutoAmazon,
  identidadeCompradorAmazon,
  intermediadorConfere,
} from './clienteAmazon';

const CPF = gerarCpf('123456789');
const CNPJ = gerarCnpj('434567890001');

function comComprador(
  registro: Record<string, unknown> | null,
  buyer: Record<string, unknown> = {},
) {
  return pedidoAmazon({
    extra: {
      buyer: { buyerName: 'Compradora Ficticia', buyerEmail: 'relay@example.invalid', ...buyer },
      tax: { taxRegistrations: registro === null ? [] : [registro] },
      recipient: { deliveryAddress: { name: 'Recebedor Ficticio Outro' } },
    },
  });
}

describe('identidadeCompradorAmazon — the BUYER registration, by its DIGITS', () => {
  it('CPF and CNPJ are decided by the digits whatever the type label says', () => {
    const cpf = identidadeCompradorAmazon(
      comComprador({ entityType: 'BUYER', taxRegistrationType: 'VAT', taxRegistrationNumber: CPF }),
    );
    expect(cpf).toEqual({
      ok: true,
      campos: {
        tipo: '0',
        nome: 'Compradora Ficticia',
        cpf_cnpj: CPF,
        idEstrangeiro: null,
        ie: null,
        telefone: null,
        email: null,
      },
    });
    const cnpj = identidadeCompradorAmazon(
      comComprador({
        entityType: 'BUYER',
        taxRegistrationType: 'CPF',
        taxRegistrationNumber: CNPJ,
        legalName: 'Empresa Ficticia Ltda',
      }),
    );
    expect(cnpj).toMatchObject({
      ok: true,
      campos: { tipo: '1', cpf_cnpj: CNPJ, nome: 'Empresa Ficticia Ltda' },
    });
  });

  it('the sandbox VAT buyer (10 digits) has no identity; a CPF label over 10 digits neither', () => {
    expect(
      identidadeCompradorAmazon(
        comComprador({
          entityType: 'BUYER',
          taxRegistrationType: 'VAT',
          taxRegistrationNumber: '9876501234',
        }),
      ),
    ).toEqual({ ok: false, motivo: 'sem-documento' });
    expect(
      identidadeCompradorAmazon(
        comComprador({
          entityType: 'BUYER',
          taxRegistrationType: 'CPF',
          taxRegistrationNumber: '9876501234',
        }),
      ),
    ).toEqual({ ok: false, motivo: 'sem-documento' });
  });

  it('EQUAL: a punctuated and a bare CPF give the same cpf_cnpj; NEAR-MISS: one digit off is refused', () => {
    const bare = identidadeCompradorAmazon(
      comComprador({ entityType: 'BUYER', taxRegistrationNumber: CPF }),
    );
    const pontuado = identidadeCompradorAmazon(
      comComprador({ entityType: 'BUYER', taxRegistrationNumber: pontuarCpf(CPF) }),
    );
    expect(bare.ok && pontuado.ok && bare.campos.cpf_cnpj === pontuado.campos.cpf_cnpj).toBe(true);
    const ultimo = Number(CPF.slice(-1));
    const errado = `${CPF.slice(0, -1)}${String((ultimo + 1) % 10)}`;
    expect(
      identidadeCompradorAmazon(
        comComprador({ entityType: 'BUYER', taxRegistrationNumber: errado }),
      ),
    ).toEqual({
      ok: false,
      motivo: 'sem-documento',
    });
  });

  it("the recipient's name never becomes the cliente's, and buyerEmail is never offered", () => {
    const semNome = identidadeCompradorAmazon(
      comComprador({ entityType: 'BUYER', taxRegistrationNumber: CPF }, { buyerName: '' }),
    );
    expect(semNome).toEqual({ ok: false, motivo: 'sem-nome' });
    const ok = identidadeCompradorAmazon(
      comComprador({ entityType: 'BUYER', taxRegistrationNumber: CPF }),
    );
    expect(JSON.stringify(ok)).not.toContain('relay@example.invalid');
    expect(JSON.stringify(ok)).not.toContain('Recebedor');
  });

  it('CNPJ name falls back legalName → buyerCompanyName → buyerName; only the FIRST BUYER entry counts', () => {
    const fallback = identidadeCompradorAmazon(
      comComprador(
        { entityType: 'BUYER', taxRegistrationNumber: pontuarCnpj(CNPJ) },
        { buyerCompanyName: 'Outra Ficticia SA' },
      ),
    );
    expect(fallback).toMatchObject({ ok: true, campos: { nome: 'Outra Ficticia SA' } });
    const doisRegistros = pedidoAmazon({
      extra: {
        buyer: { buyerName: 'Compradora Ficticia' },
        tax: {
          taxRegistrations: [
            { entityType: 'BUYER', taxRegistrationNumber: '9876501234' },
            { entityType: 'BUYER', taxRegistrationNumber: CPF },
          ],
        },
      },
    });
    expect(identidadeCompradorAmazon(doisRegistros)).toEqual({
      ok: false,
      motivo: 'sem-documento',
    });
  });
});

describe('enderecoBrutoAmazon — extendedFields first', () => {
  const comEndereco = (endereco: Record<string, unknown>) =>
    pedidoAmazon({ extra: { recipient: { deliveryAddress: endereco } } });

  it('addressLine2 never becomes the número nor joins the complemento; no codigoMunicipio key', () => {
    const r = enderecoBrutoAmazon(
      comEndereco({
        name: 'Recebedor Ficticio',
        addressLine1: 'Rua Ficticia, 100',
        addressLine2: 'Apartamento 10',
        city: 'Cidade Ficticia',
        stateOrRegion: 'SP',
        postalCode: '01000-000',
        countryCode: 'BR',
        extendedFields: {
          streetName: 'Rua Ficticia',
          streetNumber: '100',
          complement: 'Apto 10',
          neighborhood: 'Bairro Ficticio',
        },
      }),
    );
    expect(r).toEqual({
      bruto: {
        cepRaw: '01000-000',
        logradouro: 'Rua Ficticia',
        numero: '100',
        complemento: 'Apto 10',
        bairro: 'Bairro Ficticio',
        cidade: 'Cidade Ficticia',
        estadoRaw: 'SP',
        paisId: 'BR',
      },
      nomeRecebedor: 'Recebedor Ficticio',
    });
    expect(JSON.stringify(r)).not.toContain('Apartamento 10');
    expect(r === null ? [] : Object.keys(r.bruto)).not.toContain('codigoMunicipio');
  });

  it('without extendedFields: addressLine1 is the logradouro, the número is absent (the builder writes S/N)', () => {
    const r = enderecoBrutoAmazon(
      comEndereco({
        addressLine1: 'Rua Ficticia, 100',
        addressLine2: '200',
        postalCode: '01000000',
        extendedFields: { streetName: '  ' },
      }),
    );
    expect(r?.bruto.logradouro).toBe('Rua Ficticia, 100');
    expect(r?.bruto.numero).toBeNull();
    expect(r?.bruto.complemento).toBeNull();
    expect(enderecoBrutoAmazon(pedidoAmazon())).toBeNull();
  });
});

describe('intermediadorConfere — root-aware', () => {
  const conta = pontuarCnpj(CNPJ);

  it('an 8-character root equal to the conta’s first 8 ⇒ confere; a different root ⇒ diverge', () => {
    expect(intermediadorConfere(CNPJ.slice(0, 8), conta)).toBe('confere');
    expect(intermediadorConfere('99999999', conta)).toBe('diverge');
  });

  it('NEAR-MISS: 14 characters, same root, another branch ⇒ diverge (full equality at 14)', () => {
    const outraFilial = gerarCnpj(`${CNPJ.slice(0, 8)}0002`);
    expect(intermediadorConfere(outraFilial, conta)).toBe('diverge');
    expect(intermediadorConfere(CNPJ, conta)).toBe('confere');
  });

  it('absent, another length, or an unusable conta document ⇒ no verdict (never a mismatch)', () => {
    expect(intermediadorConfere(null, conta)).toBe('sem-veredito');
    expect(intermediadorConfere('1234567', conta)).toBe('sem-veredito');
    expect(intermediadorConfere(CNPJ.slice(0, 8), null)).toBe('sem-veredito');
    expect(intermediadorConfere(CNPJ.slice(0, 8), CPF)).toBe('sem-veredito');
  });
});
