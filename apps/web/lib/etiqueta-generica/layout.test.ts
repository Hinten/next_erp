import { describe, expect, it } from 'vitest';

import {
  buildEtiquetaGenericaLayout,
  groupChave,
  LABEL_H_MM,
  LABEL_W_MM,
  wrapText,
  type EtiquetaOp,
} from './layout';
import {
  CHAVE,
  COM_NFE_MODEL,
  MAXIMAL_MODEL,
  MINIMAL_MODEL,
  RETIRADA_MODEL,
  RETIRADA_SEM_ENDERECO_MODEL,
  REVERSO_MODEL,
} from './fixtures';
import type { EtiquetaGenericaModel } from './model';

/** The drawn strings, top to bottom. */
function texts(model: EtiquetaGenericaModel): string[] {
  return buildEtiquetaGenericaLayout(model)
    .ops.filter((op): op is Extract<EtiquetaOp, { kind: 'text' }> => op.kind === 'text')
    .map((op) => op.text);
}

function textOps(model: EtiquetaGenericaModel): Extract<EtiquetaOp, { kind: 'text' }>[] {
  return buildEtiquetaGenericaLayout(model).ops.filter(
    (op): op is Extract<EtiquetaOp, { kind: 'text' }> => op.kind === 'text',
  );
}

describe('buildEtiquetaGenericaLayout — legacy element order', () => {
  it('reproduces the legacy label for a plain motoboy pedido', () => {
    expect(texts(MINIMAL_MODEL)).toEqual([
      'Pedido 12345',
      'Motoboy Centro (Motoboy)',
      'Cliente: Maria Aparecida de Souza',
      'Fone: (11) 98765-4321',
      'Entrega',
      'Logradouro: Rua das Palmeiras, 1250',
      'Bairro: Jardim Paulista',
      'Complemento: Apto 74B',
      'Cidade: São Paulo - SP',
      'CEP: 01415-002',
      'Recebido: _________________________________',
      'Data: ____/____/______',
    ]);
  });

  it('adds the NF-e number, the Code 128 and the grouped chave when an NF-e is authorized', () => {
    const layout = buildEtiquetaGenericaLayout(COM_NFE_MODEL);
    const barcode = layout.ops.find((op) => op.kind === 'barcode');
    expect(barcode).toMatchObject({ kind: 'barcode', data: CHAVE, x: 5, w: 90 });

    expect(texts(COM_NFE_MODEL)).toContain('NFe nº: 4821');
    expect(texts(COM_NFE_MODEL)).toContain(
      '3526 0114 2001 6600 0187 5500 1000 0000 1234 5678 9012',
    );
  });

  it('draws no barcode when the pedido has no authorized NF-e (legacy printed none at all)', () => {
    expect(buildEtiquetaGenericaLayout(MINIMAL_MODEL).ops.some((op) => op.kind === 'barcode')).toBe(
      false,
    );
  });

  it('swaps Entrega→Retirada and turns the foot into a second address block on a reverse label', () => {
    const drawn = texts(REVERSO_MODEL);
    expect(drawn).toContain('Reverso');
    // The customer's address is now the COLLECTION point…
    expect(drawn).toContain('Retirada');
    // …and the filial sede is the delivery target, replacing the signature lines.
    expect(drawn).toContain('Entrega');
    expect(drawn).toContain('Logradouro: Avenida Industrial, 900');
    expect(drawn).not.toContain('Data: ____/____/______');
  });

  it('prints no address block at all for retiradaNaLoja, but still says so when it is missing', () => {
    // Legacy `generica.dart:152-158`: the `else if` guarding the block has no
    // trailing `else`, so a resolved address on a pickup renders nothing.
    const pickup = texts(RETIRADA_MODEL);
    expect(pickup).not.toContain('Entrega');
    expect(pickup).not.toContain('Logradouro: Rua das Palmeiras, 1250');
    expect(pickup).not.toContain('Endereço não informado');

    // A genuinely absent address is checked FIRST, so it reports even on a pickup.
    expect(texts(RETIRADA_SEM_ENDERECO_MODEL)).toContain('Endereço não informado');
  });

  it('adds the recebedor and volumes blocks only when they carry data', () => {
    expect(texts(MAXIMAL_MODEL)).toContain('Recebedor: João Carlos Ferreira da Silva');
    expect(texts(MAXIMAL_MODEL)).toContain('CPF/CNPJ: 12.345.678/0001-95');
    expect(texts(MAXIMAL_MODEL)).toContain('Volumes: 3 volume(s) · 12,45 kg');
    expect(texts(MINIMAL_MODEL).some((t) => t.startsWith('Recebedor:'))).toBe(false);
    expect(texts(MINIMAL_MODEL).some((t) => t.startsWith('Volumes:'))).toBe(false);
  });
});

describe('buildEtiquetaGenericaLayout — legacy geometry', () => {
  it('borders the label flush to the trim', () => {
    const rect = buildEtiquetaGenericaLayout(MINIMAL_MODEL).ops.find((op) => op.kind === 'rect');
    // Stroke centred on the path, so a half-rule inset keeps it inside the page.
    expect(rect).toMatchObject({ kind: 'rect', x: 0.1765, y: 0.1765 });
    expect(rect).toMatchObject({ w: LABEL_W_MM - 0.353, h: LABEL_H_MM - 0.353 });
  });

  it('runs every divider edge to edge, the way pw.Divider() did', () => {
    const rules = buildEtiquetaGenericaLayout(MAXIMAL_MODEL).ops.filter(
      (op): op is Extract<EtiquetaOp, { kind: 'rule' }> => op.kind === 'rule',
    );
    // Legacy: header, cliente, endereço, recebedor, volumes.
    expect(rules).toHaveLength(5);
    for (const rule of rules) {
      expect(rule.x).toBeCloseTo(0.353, 3);
      expect(rule.x + rule.w).toBeCloseTo(LABEL_W_MM - 0.353, 3);
    }
  });

  it('keeps the legacy Helvetica scale — 12pt headings, 10pt body', () => {
    const ops = textOps(MINIMAL_MODEL);
    expect(ops.find((op) => op.text === 'Pedido 12345')).toMatchObject({
      sizePt: 12,
      bold: true,
      align: 'center',
    });
    expect(ops.find((op) => op.text === 'Entrega')).toMatchObject({
      sizePt: 12,
      bold: true,
      align: 'center',
    });
    expect(ops.find((op) => op.text?.startsWith('Cliente:'))).toMatchObject({
      sizePt: 10,
      bold: false,
      align: 'left',
    });
  });

  it('insets every block 5mm, including the recebedor block legacy left flush to the border', () => {
    for (const op of textOps(MAXIMAL_MODEL)) {
      expect(op.x).toBe(5);
      expect(op.w).toBe(90);
    }
  });

  it('fits the page even with every optional block present', () => {
    const layout = buildEtiquetaGenericaLayout(MAXIMAL_MODEL);
    expect(layout.contentHeightMm).toBeLessThanOrEqual(LABEL_H_MM);
  });
});

describe('wrapText', () => {
  it('wraps on word boundaries instead of letting a line run past the border', () => {
    expect(wrapText('Rua Professor Doutor Antonio Carlos', 20)).toEqual([
      'Rua Professor Doutor',
      'Antonio Carlos',
    ]);
  });

  it('hard-splits a single word longer than the limit', () => {
    expect(wrapText('AAAAABBBBBCCCCC', 5)).toEqual(['AAAAA', 'BBBBB', 'CCCCC']);
  });

  it('keeps a long logradouro inside the label instead of overflowing it', () => {
    const long = {
      ...MINIMAL_MODEL,
      endereco: {
        ...MINIMAL_MODEL.endereco!,
        logradouro: 'Avenida Professor Doutor Antonio Carlos Fernandes de Albuquerque Junior',
      },
    };
    const lines = texts(long).filter((t) => t.startsWith('Logradouro:') || t.includes('Albuquer'));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(51);
  });

  it('returns a single empty line for empty input rather than nothing', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
});

describe('groupChave', () => {
  it('groups the 44-digit chave in eleven blocks of four', () => {
    const grouped = groupChave(CHAVE);
    expect(grouped.split(' ')).toHaveLength(11);
    expect(grouped.replace(/ /g, '')).toBe(CHAVE);
  });
});
