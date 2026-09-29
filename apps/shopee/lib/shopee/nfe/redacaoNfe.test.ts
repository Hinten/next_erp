import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { EXCERTO_SHOPEE_MAX } from './constantesNfe';
import { codigoSeguro, resumirTextoDaShopee } from './redacaoNfe';

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

/**
 * The same synthetic key with an ALPHANUMERIC CNPJ (`ZZ1ZZ2ZZ3ZZ4` + DV `00`),
 * assembled from its fields — the D1 §7 recipe.
 */
const CHAVE_ALFA = [
  '99',
  '2609',
  'ZZ1ZZ2ZZ3ZZ4',
  '00',
  '55',
  '000',
  '000000001',
  '1',
  '00000000',
  '0',
].join('');

/** The alphanumeric key the way the DANFE prints it: eleven groups of four. */
const CHAVE_ALFA_DANFE = (CHAVE_ALFA.match(/.{4}/g) ?? []).join(' ');

/** The numeric key in groups of four, joined by `sep` instead of a space. */
function chaveUnidaPor(sep: string): string {
  return (CHAVE.match(/.{4}/g) ?? []).join(sep);
}

/**
 * Every separator review 1 (R4-1) MEASURED leaking the key whole: none is one
 * of rule (a)'s joiners, and none is whitespace, so before the fix the key was
 * one long letter-free token. The last two are invisible (zero-width space,
 * soft hyphen) — format characters the cleaning step now drops.
 */
const SEPARADORES_MEDIDOS: ReadonlyArray<readonly [string, string]> = [
  ['vírgula', ','],
  ['sublinhado', '_'],
  ['barra vertical', '|'],
  ['dois-pontos', ':'],
  ['meia-risca (U+2013)', '\u2013'],
  ['espaço de largura zero (U+200B)', '\u200B'],
  ['hífen condicional (U+00AD)', '\u00AD'],
];

/** R4-3's measured string: a mixed token that the cap lifts to twelve characters. */
const ATRAVESSA_O_TETO = `${'a'.repeat(EXCERTO_SHOPEE_MAX - 13)} ab1c2defghi zzz`;

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
      ATRAVESSA_O_TETO,
      `chave ${CHAVE_ALFA_DANFE} recusada`,
      `chave ${chaveUnidaPor(',')} x`,
      'CNPJ 12 ABC 345 01DE 35 inválido',
      'ip 34.95.1.2 nao declarado',
    ];
    for (const texto of corpus) {
      const uma = resumirTextoDaShopee(texto);
      expect(resumirTextoDaShopee(uma)).toBe(uma);
    }
  });
});

describe('resumirTextoDaShopee — review 1 (F-1, R4-1, R4-3, R4-5)', () => {
  it.each(SEPARADORES_MEDIDOS)(
    '20 — PAR (R4-1): a chave unida por %s sai mascarada inteira',
    (_nome, sep) => {
      expect(resumirTextoDaShopee(`chave ${chaveUnidaPor(sep)} x`)).toBe('chave ••• x');
    },
  );

  it('21 — PAR (R4-1): um CNPJ numérico unido por `_` ou `|` também — o token longo com ≥ 7 dígitos', () => {
    expect(resumirTextoDaShopee('CNPJ 11_111_111_1111_11 inválido')).toBe('CNPJ ••• inválido');
    expect(resumirTextoDaShopee('CNPJ 11|111|111|1111|11 inválido')).toBe('CNPJ ••• inválido');
  });

  it('22 — ⛔ NEAR-MISS (R4-1): um token longo sem letras com SEIS dígitos sobrevive; com sete, não', () => {
    expect(resumirTextoDaShopee('ref (11)-(22)-(33) ok')).toBe('ref (11)-(22)-(33) ok');
    expect(resumirTextoDaShopee('ref (11)-(22)-(333) ok')).toBe('ref ••• ok');
    // E a vírgula decimal continua não sendo um identificador (9 caracteres).
    expect(resumirTextoDaShopee('valor 12.345,67 divergente')).toBe('valor 12.345,67 divergente');
  });

  it('23 — PAR (F-1): a chave com CNPJ alfanumérico no formato do DANFE sai mascarada inteira', () => {
    expect(CHAVE_ALFA).toHaveLength(44);
    expect(resumirTextoDaShopee(`chave ${CHAVE_ALFA_DANFE} recusada`)).toBe('chave ••• recusada');
    // Colada, a regra (b) já a pegava; o formato do DANFE é o que vazava.
    expect(resumirTextoDaShopee(`chave ${CHAVE_ALFA} recusada`)).toBe('chave ••• recusada');
  });

  it('24 — PAR (F-1): o CNPJ alfanumérico espaçado é mascarado a partir da corrida de grupos com dígito', () => {
    // Todos os grupos com dígito: a regra (c) o leva inteiro (antes, nenhuma
    // regra via nada — tokens curtos, no máximo cinco dígitos seguidos).
    expect(resumirTextoDaShopee('CNPJ 1A 2BC 345 01DE 35 inválido')).toBe('CNPJ ••• inválido');
    // `ABC` não tem dígito e quebra a corrida: `12 ABC` fica — o resíduo aceito,
    // o mesmo da raiz sozinha (teste 25); ordem e DV (`345 01DE 35`) somem.
    expect(resumirTextoDaShopee('CNPJ 12 ABC 345 01DE 35 inválido')).toBe(
      'CNPJ 12 ABC ••• inválido',
    );
    // Formatado SEM espaços é um token só de 18 caracteres: a regra (b) o leva.
    expect(resumirTextoDaShopee('CNPJ 12.ABC.345/01DE-35 inválido')).toBe('CNPJ ••• inválido');
  });

  it('25 — ⛔ NEAR-MISS (F-1): o que a regra (c) NÃO pode comer — números curtos, prosa e códigos curtos', () => {
    const sobrevivem = [
      '539',
      '5102',
      'CFOP 5102',
      'Rejeição 539: CFOP 5102 não permitido',
      // Sem acento e sem dois-pontos: `CFOP` não tem dígito, então a corrida
      // `539 CFOP 5102` nunca se forma (seriam sete dígitos).
      'Rejeicao 539 CFOP 5102 nao permitido',
      'protocolo 123456 pendente',
      'valor 12.345,67 divergente',
      // Três grupos alfanuméricos, mas só três dígitos.
      'lote A1-B2-C3 recusado',
      'NF-e v4.00.1 recusada',
      // O resíduo aceito: a raiz alfanumérica sozinha (cinco dígitos).
      'raiz 12.ABC.345 divergente',
      // O resíduo aceito: dois caracteres entre os grupos não unem nada.
      'itens 123 - 4567',
    ];
    for (const texto of sobrevivem) expect(resumirTextoDaShopee(texto)).toBe(texto);
  });

  it('26 — ⛔ resíduo aceito, medido: a chave com ` - ` entre os grupos NÃO é mascarada (nem com `, ` ou `; `)', () => {
    // Se isto um dia passar a mascarar, o cabeçalho do módulo mente — atualize-o.
    for (const sep of [' - ', ', ', '; ']) {
      expect(resumirTextoDaShopee(`chave ${chaveUnidaPor(sep)} x`)).toContain('9926');
    }
  });

  it('27 — PAR (R4-3): no limite do teto, a saída já é o ponto fixo — a 2ª chamada não muda nada', () => {
    const uma = resumirTextoDaShopee(ATRAVESSA_O_TETO);
    // O corte cola `…` no token misto de 11 caracteres; a máscara final o pega.
    expect(uma).toBe(`${'a'.repeat(EXCERTO_SHOPEE_MAX - 13)} •••`);
    expect(resumirTextoDaShopee(uma)).toBe(uma);
    expect(Array.from(uma ?? '').length).toBeLessThanOrEqual(EXCERTO_SHOPEE_MAX);
  });

  it('28 — ⛔ NEAR-MISS (R4-3): um token de 11 caracteres que o teto NÃO toca sobrevive', () => {
    expect(resumirTextoDaShopee('código ab1c2defghi zzz')).toBe('código ab1c2defghi zzz');
  });

  it('29 — R4-5: um IPv4 com até seis dígitos NÃO é mascarado (o cabeçalho diz isso); com sete, é', () => {
    expect(resumirTextoDaShopee('ip 34.95.1.2 nao declarado')).toBe('ip 34.95.1.2 nao declarado');
    expect(resumirTextoDaShopee('ip 192.168.10.1 nao declarado')).toBe('ip ••• nao declarado');
  });

  it('30 — PAR (R4-1): um caractere de FORMATO invisível no meio de um número curto não o esconde', () => {
    // Token curto (< 12): só a limpeza (`\p{Cf}` descartado) junta os sete dígitos.
    expect(resumirTextoDaShopee('protocolo 123456\u200B7 pendente')).toBe('protocolo ••• pendente');
    expect(resumirTextoDaShopee('protocolo 12345\u00AD67 pendente')).toBe('protocolo ••• pendente');
  });

  it('31 — ⛔ NEAR-MISS (R4-1): o caractere de formato sai, mas seis dígitos continuam seis', () => {
    expect(resumirTextoDaShopee('protocolo 123456\u200B pendente')).toBe(
      'protocolo 123456 pendente',
    );
    expect(resumirTextoDaShopee('CFOP 51\u00AD02 não aceito')).toBe('CFOP 5102 não aceito');
  });
});

describe('resumirTextoDaShopee — review 1, a lente de mutação (R6, R9)', () => {
  it('32 — PAR (R6): o texto cru ≡ o já mascarado — a junção que só a 2ª passada vê some ANTES do teto', () => {
    // A 1ª passada une `1 2345678 9` (regra (a)) e deixa `AB1CDE•••FGH1IJ`: 15
    // caracteres, letras e dois dígitos — só a 2ª passada o mascara. Uma máscara
    // de passada única deixaria esse token para o teto cortar, e a saída teria
    // 12 caracteres a menos da cauda (nada vaza: a máscara final ainda o pega).
    const cru = `AB1CDE1 2345678 9FGH1IJ ${'a'.repeat(200)}`;
    const uma = resumirTextoDaShopee(cru);
    expect(uma).toBe(resumirTextoDaShopee(`••• ${'a'.repeat(200)}`));
    expect(uma).toBe(`••• ${'a'.repeat(EXCERTO_SHOPEE_MAX - 5)}…`);
    expect(Array.from(uma ?? '')).toHaveLength(EXCERTO_SHOPEE_MAX);
  });

  it('33 — ⛔ NEAR-MISS (R9): DOIS grupos alfanuméricos com 7 dígitos não são a regra (c) — ela exige três; PAR: com TRÊS, são', () => {
    // Nenhuma outra regra os pega: a corrida de dígitos tem no máximo seis, e
    // nenhum token chega a doze caracteres.
    expect(resumirTextoDaShopee('protocolo 123456 A1 recusado')).toBe(
      'protocolo 123456 A1 recusado',
    );
    expect(resumirTextoDaShopee('ref 12A345 6B7 ok')).toBe('ref 12A345 6B7 ok');
    expect(resumirTextoDaShopee('protocolo 123456 A1 B2 recusado')).toBe('protocolo ••• recusado');
  });
});

/* -------------------------------------------------------------------------- */
/*                   codigoSeguro — review 2 (S3-6 + E1)                       */
/* -------------------------------------------------------------------------- */

describe('codigoSeguro — o código da Shopee como TOKEN curto, nunca texto livre nem identificador', () => {
  it('34 — PAR: `order.upload_invoice_error` passa, e com espaço/TAB em volta ≡ o mesmo código aparado', () => {
    expect(codigoSeguro('order.upload_invoice_error')).toBe('order.upload_invoice_error');
    expect(codigoSeguro(' order.upload_invoice_error	')).toBe('order.upload_invoice_error');
    expect(codigoSeguro('error_param')).toBe('error_param');
    expect(codigoSeguro('common.source_ip_undeclared')).toBe('common.source_ip_undeclared');
  });

  it('35 — ⛔ NEAR-MISS: `e` + os 44 dígitos de uma chave tem forma de token e é `null` (sete dígitos ou mais)', () => {
    expect(codigoSeguro(`e${CHAVE}`)).toBeNull();
    // The digit threshold, both sides: six digits are a code, seven are not.
    expect(codigoSeguro('error_123456')).toBe('error_123456');
    expect(codigoSeguro('error_1234567')).toBeNull();
    expect(codigoSeguro('e1.2.3.4.5.6.7')).toBeNull();
  });

  it('36 — ⛔ NEAR-MISS: um código de 70 caracteres é `null`; o teto é 64, dos dois lados', () => {
    expect(codigoSeguro(`error_${'x'.repeat(64)}`)).toBeNull();
    expect(codigoSeguro(`e${'x'.repeat(63)}`)).toBe(`e${'x'.repeat(63)}`);
    expect(codigoSeguro(`e${'x'.repeat(64)}`)).toBeNull();
  });

  it('37 — ⛔ NEAR-MISS: texto livre, o número de pedido, um dígito na frente e o que não é string ⇒ `null`', () => {
    for (const naoCodigo of [
      'chave inválida',
      `chave ${CHAVE}`,
      ORDER_SN,
      '1error',
      '_error',
      'error-param',
      '',
      '   ',
      null,
      undefined,
      42,
      { code: 'error_param' },
    ]) {
      expect(codigoSeguro(naoCodigo), String(naoCodigo)).toBeNull();
    }
  });

  it('38 — a fonte: o handler e a CLI leem o código por ESTE portão, sem cópia privada da regex', () => {
    for (const modulo of ['./processarNfe.ts', './enviarNfeCli.ts']) {
      const fonte = readFileSync(fileURLToPath(new URL(modulo, import.meta.url)), 'utf8');
      expect(fonte, modulo).toMatch(
        /import \{ codigoSeguro, resumirTextoDaShopee \} from '\.\/redacaoNfe';/,
      );
      expect(fonte, modulo).not.toContain('CODIGO_TOKEN');
      expect(fonte, modulo).not.toContain('[a-z0-9_.]');
      expect(fonte, modulo).not.toMatch(/function codigoSeguro/);
    }
  });
});
