import { describe, expect, it } from 'vitest';

import { parseProcNFe } from '../../src/danfe/model';
import { CHAVE, PROCNFE_FIXTURE } from './fixtures';

describe('danfe/model parseProcNFe', () => {
  const model = parseProcNFe(PROCNFE_FIXTURE);

  it('strips the NFe prefix to a bare 44-digit chave', () => {
    expect(model.chave).toBe(CHAVE);
  });

  it('flags homologação from tpAmb=2', () => {
    expect(model.homologacao).toBe(true);
  });

  it('maps the ide header', () => {
    expect(model.ide.natOp).toBe('VENDA DE MERCADORIA');
    expect(model.ide.nNF).toBe('7');
    expect(model.ide.serie).toBe('1');
    expect(model.ide.tpNF).toBe('1');
    expect(model.ide.dhEmi).toBe('2026-05-26T15:25:00-03:00');
  });

  it('maps emitente with its address', () => {
    expect(model.emit.nome).toBe('DELFRANCE COMERCIO LTDA');
    expect(model.emit.cnpj).toBe('14200166000187');
    expect(model.emit.cpf).toBeNull();
    expect(model.emit.ie).toBe('110042490114');
    expect(model.emit.endereco.municipio).toBe('SAO PAULO');
    expect(model.emit.endereco.cep).toBe('01001000');
    expect(model.emit.endereco.complemento).toBe('SALA 2');
  });

  it('maps destinatário', () => {
    expect(model.dest.nome).toContain('HOMOLOGACAO');
    expect(model.dest.cnpj).toBe('99999090910270');
    expect(model.dest.endereco?.bairro).toBe('BELA VISTA');
  });

  it('passes the ICMSTot totals through', () => {
    expect(model.total.vNF).toBe('1234.56');
    expect(model.total.vProd).toBe('1234.56');
  });

  it('maps the autorização protocolo', () => {
    expect(model.prot?.nProt).toBe('135260000000456');
    expect(model.prot?.dhRecbto).toBe('2026-05-26T15:30:12-03:00');
    expect(model.prot?.tpAmb).toBe('2');
  });

  it('captures dados adicionais', () => {
    expect(model.infAdic.infCpl).toContain('Simples Nacional');
  });
});

describe('danfe/model edge cases', () => {
  it('maps NFref referenced chaves into ide.refNFes', () => {
    const REF = '35260514200166000187550010000000061000000010';
    const xml = PROCNFE_FIXTURE.replace('</ide>', `<NFref><refNFe>${REF}</refNFe></NFref></ide>`);
    expect(parseProcNFe(xml).ide.refNFes).toContain(REF);
  });

  it('unescapes XML-escaped characters in text fields', () => {
    const xml = PROCNFE_FIXTURE.replace('CAMISETA ALGODAO PRETA M', 'CAMISETA P&amp;B &lt;PROMO&gt;').replace(
      'ME ou EPP',
      'ME &amp; EPP',
    );
    const m = parseProcNFe(xml);
    expect(m.itens[0]?.xProd).toBe('CAMISETA P&B <PROMO>');
    expect(m.infAdic.infCpl).toContain('ME & EPP');
  });

  it('separates infAdFisco (RESERVADO AO FISCO) from infCpl', () => {
    const xml = PROCNFE_FIXTURE.replace('</infAdic>', '<infAdFisco>OBSERVACAO DE INTERESSE DO FISCO</infAdFisco></infAdic>');
    const m = parseProcNFe(xml);
    expect(m.infAdic.infAdFisco).toBe('OBSERVACAO DE INTERESSE DO FISCO');
    expect(m.infAdic.infCpl).toContain('Simples Nacional');
  });
});
