import { describe, expect, it } from 'vitest';

import { criarListaDeNomes } from '../fixtures/piiScan';
import { gerarCnpj, gerarCpf, pontuarCnpj, pontuarCpf } from '../testing/documentos';
import { classeDeDocumento, formatarFolhas, tabelaDeFolhas } from './folhas';

const LISTA = criarListaDeNomes(['Termo Ficticio Zeta']);

describe('the dry-run leaf table', () => {
  it('paths, types and treatments only; repeated leaves collapse with a count', () => {
    const bruto = { a: [{ x: 'Fulana' }, { x: 'Beltrana' }], n: 1, k: 'Z' };
    const sanitizado = { a: [{ x: 'REDACTED' }, { x: 'REDACTED' }], n: 1, k: 1 };
    expect(formatarFolhas(tabelaDeFolhas(bruto, sanitizado, LISTA))).toEqual([
      'a.*.x : string → falsificado (2)',
      'n : number → mantido (1)',
      'k : string → redigido (1)',
    ]);
  });

  it('a closed-grammar enum leaf prints its kept value', () => {
    const bruto = {
      payment: { paymentExecutions: [{ paymentMethod: 'Pix' }] },
      programs: ['PRIME'],
      packageStatus: { status: 'IN_TRANSIT', detailedStatus: 'DELIVERED' },
      taxRegistrationAttributes: [{ key: 'STATE_REGISTRATION', value: 'x' }],
    };
    const linhas = formatarFolhas(tabelaDeFolhas(bruto, bruto, LISTA));
    expect(linhas).toContain(
      'payment.paymentExecutions.*.paymentMethod : string = Pix → mantido (1)',
    );
    expect(linhas).toContain('programs.* : string = PRIME → mantido (1)');
    expect(linhas).toContain('packageStatus.status : string = IN_TRANSIT → mantido (1)');
    expect(linhas).toContain('packageStatus.detailedStatus : string = DELIVERED → mantido (1)');
    expect(linhas).toContain(
      'taxRegistrationAttributes.*.key : string = STATE_REGISTRATION → mantido (1)',
    );
    // Near-miss: the attribute's VALUE is not an enum leaf, and prints nothing.
    expect(linhas).toContain('taxRegistrationAttributes.*.value : string → mantido (1)');
  });

  it('near-miss: an enum leaf that was faked, is not an enum token, or trips a pattern prints no value', () => {
    const cpf = gerarCpf('529982247');
    const bruto = {
      a: { paymentMethod: 'Pix' },
      b: { paymentMethod: 'pix minúsculo' },
      c: { paymentMethod: `X${cpf}` },
    };
    const sanitizado = { a: { paymentMethod: 'REDACTED' }, b: bruto.b, c: bruto.c };
    const texto = formatarFolhas(tabelaDeFolhas(bruto, sanitizado, LISTA)).join('\n');
    expect(texto).not.toContain('=');
    expect(texto).not.toContain(cpf);
  });

  it('a document leaf prints its SHAPE class only, never the value', () => {
    const cpf = gerarCpf('529982247');
    const cnpj = gerarCnpj('000001234567');
    const bruto = {
      taxRegistrations: [
        { taxRegistrationNumber: pontuarCpf(cpf) },
        { taxRegistrationNumber: cnpj },
        { taxRegistrationNumber: '12345678' },
      ],
      acquirerId: pontuarCnpj(cnpj),
    };
    const sanitizado = JSON.parse(JSON.stringify(bruto).replace(/[0-9]/g, '0')) as unknown;
    const texto = formatarFolhas(
      tabelaDeFolhas(bruto, sanitizado as Parameters<typeof tabelaDeFolhas>[1], LISTA),
    ).join('\n');
    expect(texto).toContain(
      'taxRegistrations.*.taxRegistrationNumber : string ~ cpfPontuado → falsificado (1)',
    );
    expect(texto).toContain(
      'taxRegistrations.*.taxRegistrationNumber : string ~ cnpj14 → falsificado (1)',
    );
    expect(texto).toContain(
      'taxRegistrations.*.taxRegistrationNumber : string ~ cnpjRaiz8 → falsificado (1)',
    );
    expect(texto).toContain('acquirerId : string ~ cnpjPontuado → falsificado (1)');
    expect(texto).not.toContain(cpf.slice(0, 6));
    expect(classeDeDocumento('1234567890')).toBe('outro(10)');
  });

  it('a key that trips a pattern or a listed term prints only its tag or <chave>', () => {
    const bruto = { 'fulana@exemplo.com.br': 1, termoficticiozeta: 2 };
    const texto = formatarFolhas(tabelaDeFolhas(bruto, bruto, LISTA)).join('\n');
    expect(texto).toContain('<redacted:email> : number → mantido (1)');
    expect(texto).toContain('<chave> : number → mantido (1)');
    expect(texto).not.toContain('fulana');
  });
});
