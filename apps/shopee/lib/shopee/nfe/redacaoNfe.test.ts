import { describe, expect, it } from 'vitest';

import { EXCERTO_SHOPEE_MAX } from './constantesNfe';
import { resumirTextoDaShopee } from './redacaoNfe';

/**
 * A synthetic, visibly impossible access key — cUF 99 (no such UF), an
 * all-ones CNPJ — assembled from its fields, never written as one literal.
 */
const CHAVE = ['99', '2609', '11111111111111', '55', '000', '000000001', '1', '00000000', '0'].join(
  '',
);

/** The same key the way the DANFE prints it: eleven groups of four. */
const CHAVE_DANFE = (CHAVE.match(/.{4}/g) ?? []).join(' ');

/** An order number of the fixture shape: six digits and eight letters. */
const ORDER_SN = '260910KJBHUJDM';

describe('resumirTextoDaShopee — limpeza', () => {
  it('1 — `null`, `undefined` e texto em branco dão `null`', () => {
    expect(resumirTextoDaShopee(null)).toBeNull();
    expect(resumirTextoDaShopee(undefined)).toBeNull();
    expect(resumirTextoDaShopee('')).toBeNull();
    expect(resumirTextoDaShopee(' \t\n ')).toBeNull();
    expect(resumirTextoDaShopee('...')).toBeNull();
    expect(resumirTextoDaShopee('Wrong parameters, detail: ..')).toBeNull();
  });

  it('2 — caracteres de controle são DESCARTADOS (não viram espaço), inclusive o TAB', () => {
    expect(resumirTextoDaShopee('upload_invoice_error\t')).toBe('upload_invoice_error');
    expect(resumirTextoDaShopee('File\u0007 error')).toBe('File error');
    expect(resumirTextoDaShopee('linha\nquebrada')).toBe('linhaquebrada');
  });

  it('3 — espaços colapsados e aparados', () => {
    expect(resumirTextoDaShopee('  Invalid   CNPJ   here  ')).toBe('Invalid CNPJ here');
  });

  it('4 — PAR: o envelope `Wrong parameters, detail:` sai (sem caixa) e os pontos finais também', () => {
    expect(resumirTextoDaShopee('Wrong parameters, detail: Invalid CNPJ..')).toBe('Invalid CNPJ');
    expect(resumirTextoDaShopee('WRONG PARAMETERS, DETAIL:Invalid UF.')).toBe('Invalid UF');
    expect(resumirTextoDaShopee('wrong parameters, detail: File error.')).toBe('File error');
  });

  it('5 — ⛔ NEAR-MISS: o envelope no MEIO do texto fica, e só pontos FINAIS saem', () => {
    expect(resumirTextoDaShopee('Falha. Wrong parameters, detail: x')).toBe(
      'Falha. Wrong parameters, detail: x',
    );
    expect(resumirTextoDaShopee('NF-e v4.00 recusada.')).toBe('NF-e v4.00 recusada');
  });
});

describe('resumirTextoDaShopee — a máscara', () => {
  it('6 — PAR: um cStat de 3 dígitos, um CFOP de 4 e um número de 6 dígitos SOBREVIVEM', () => {
    expect(resumirTextoDaShopee('Rejeição 539: Duplicidade de NF-e')).toBe(
      'Rejeição 539: Duplicidade de NF-e',
    );
    expect(resumirTextoDaShopee('CFOP 5102 não aceito')).toBe('CFOP 5102 não aceito');
    expect(resumirTextoDaShopee('protocolo 123456 pendente')).toBe('protocolo 123456 pendente');
  });

  it('7 — ⛔ NEAR-MISS: SETE dígitos já são um identificador', () => {
    expect(resumirTextoDaShopee('protocolo 1234567 pendente')).toBe('protocolo ••• pendente');
  });

  it('8 — PAR: a chave de acesso é mascarada em texto corrido E no formato do DANFE', () => {
    expect(CHAVE).toHaveLength(44);
    expect(resumirTextoDaShopee(`Rejeição 539: Duplicidade de NF-e [chNFe:${CHAVE}]`)).toBe(
      'Rejeição 539: Duplicidade de NF-e •••',
    );
    expect(resumirTextoDaShopee(`chave ${CHAVE} recusada`)).toBe('chave ••• recusada');
    // Onze tokens de quatro dígitos — nenhum, sozinho, parece um identificador.
    expect(resumirTextoDaShopee(`chave ${CHAVE_DANFE} recusada`)).toBe('chave ••• recusada');
  });

  it('9 — um CNPJ e um CPF formatados são mascarados (grupos unidos por UM separador)', () => {
    expect(resumirTextoDaShopee('CNPJ 11.222.333/0001-44 inválido')).toBe('CNPJ ••• inválido');
    expect(resumirTextoDaShopee('CPF 111.111.111-11 inválido')).toBe('CPF ••• inválido');
    expect(resumirTextoDaShopee('CNPJ 11 222 333 0001 44 inválido')).toBe('CNPJ ••• inválido');
  });

  it('10 — ⛔ NEAR-MISS: dois separadores seguidos NÃO unem grupos, e a vírgula decimal não une', () => {
    expect(resumirTextoDaShopee('itens 123 - 4567')).toBe('itens 123 - 4567');
    expect(resumirTextoDaShopee('itens 123-4567')).toBe('itens •••');
    expect(resumirTextoDaShopee('valor 12.345,67 divergente')).toBe('valor 12.345,67 divergente');
  });

  it('11 — PAR: um CNPJ alfanumérico e um número de pedido (só 6 dígitos) são mascarados', () => {
    expect(resumirTextoDaShopee(`pedido ${ORDER_SN} sem nota`)).toBe('pedido ••• sem nota');
    expect(resumirTextoDaShopee('emitente ZZ9ZZ9ZZ9ZZ901 divergente')).toBe(
      'emitente ••• divergente',
    );
    // O limiar exato: doze caracteres, letras e dois dígitos.
    expect(resumirTextoDaShopee('token ABCDEFGHIJ12 aqui')).toBe('token ••• aqui');
  });

  it('12 — ⛔ NEAR-MISS: token longo SEM dígitos, com UM dígito, ou com 11 caracteres sobrevive', () => {
    expect(resumirTextoDaShopee('order.upload_invoice_error')).toBe('order.upload_invoice_error');
    expect(resumirTextoDaShopee('token ABCDEFGHIJK1 aqui')).toBe('token ABCDEFGHIJK1 aqui');
    expect(resumirTextoDaShopee('token ABCDEFGHI12 aqui')).toBe('token ABCDEFGHI12 aqui');
  });

  it('13 — ⛔ as duas regras julgam o MESMO texto: nenhuma esconde um trecho da outra', () => {
    // A regra (a) sozinha primeiro deixaria `•••ABC0112` (10 caracteres), curto
    // demais para a regra (b) — um pedaço legível do identificador.
    expect(resumirTextoDaShopee('id 1234567ABC0112 aqui')).toBe('id ••• aqui');
  });

  it('14 — ⛔ a máscara é um PONTO FIXO: o que ela junta é julgado de novo', () => {
    // Nenhum dos dois tokens, sozinho, é longo o bastante; o grupo de dígitos
    // que os une é mascarado e os junta num token de 18 caracteres misto — que
    // a segunda passada mascara inteiro.
    expect(resumirTextoDaShopee('x A1B2CDE1234 567FGHIJKLM y')).toBe('x ••• y');
  });

  it('15 — uma data com separadores (8 dígitos) também é mascarada — o preço aceito', () => {
    expect(resumirTextoDaShopee('emitida em 29/09/2026')).toBe('emitida em •••');
  });
});

describe('resumirTextoDaShopee — o teto', () => {
  it('16 — PAR: o teto padrão é EXCERTO_SHOPEE_MAX, com `…` no fim', () => {
    const longo = 'palavra '.repeat(40);
    const r = resumirTextoDaShopee(longo);
    expect(r).not.toBeNull();
    expect(Array.from(r ?? '')).toHaveLength(EXCERTO_SHOPEE_MAX);
    expect(r?.endsWith('…')).toBe(true);
    expect(resumirTextoDaShopee('curto')).toBe('curto');
  });

  it('17 — ⛔ uma chave que ATRAVESSA o teto sai inteira mascarada (o teto vem DEPOIS da máscara)', () => {
    // Cortar antes deixaria seis dígitos da chave — abaixo do limiar de sete.
    const prefixo = 'a'.repeat(EXCERTO_SHOPEE_MAX - 8);
    expect(resumirTextoDaShopee(`${prefixo} ${CHAVE}`)).toBe(`${prefixo} •••`);
    // E um número de pedido cortado a oito caracteres não seria mais "longo".
    const prefixo2 = 'a'.repeat(EXCERTO_SHOPEE_MAX - 10);
    expect(resumirTextoDaShopee(`${prefixo2} ${ORDER_SN}`)).toBe(`${prefixo2} •••`);
    // Mesmo quando o texto mascarado ainda passa do teto, nenhum dígito vaza.
    const r = resumirTextoDaShopee(`${'palavra '.repeat(30)}${CHAVE} ${'fim '.repeat(20)}`);
    expect(r).not.toMatch(/\d/);
    expect(Array.from(r ?? '')).toHaveLength(EXCERTO_SHOPEE_MAX);
  });

  it('18 — um teto explícito é respeitado, e o resultado nunca termina em ponto', () => {
    expect(resumirTextoDaShopee('abcdefghij', 5)).toBe('abcd…');
    expect(resumirTextoDaShopee('ab. cd. ef.', 100)).toBe('ab. cd. ef');
  });
});

describe('resumirTextoDaShopee — idempotência', () => {
  it('19 — PAR: sanitizar a própria saída não muda nada', () => {
    const corpus = [
      `Wrong parameters, detail: Rejeição 539: Duplicidade de NF-e [chNFe:${CHAVE}]..`,
      `chave ${CHAVE_DANFE} recusada`,
      `pedido ${ORDER_SN} sem nota`,
      'x A1B2CDE1234 567FGHIJKLM y',
      'Wrong parameters, detail: Wrong parameters, detail: File error..',
      `${'palavra '.repeat(40)}${CHAVE}`,
      'CFOP 5102 não aceito',
    ];
    for (const texto of corpus) {
      const uma = resumirTextoDaShopee(texto);
      expect(resumirTextoDaShopee(uma)).toBe(uma);
    }
  });
});
