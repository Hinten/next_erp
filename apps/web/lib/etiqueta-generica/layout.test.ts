import { describe, expect, it } from 'vitest';

import {
  buildEtiquetaGenericaLayout,
  groupChave,
  LABEL_H_MM,
  LABEL_W_MM,
  lineHeightMm,
  wrapText,
  type EtiquetaOp,
} from './layout';
import { textWidthMm } from './metrics';
import {
  CHAVE,
  COM_NFE_MODEL,
  LONG_STRINGS_MODEL,
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
    // Fill rules are sized from the font metrics, so collapse their long
    // underscore runs rather than pinning a count a metrics fix would churn.
    // The 8+ threshold leaves the fixed `____/____/______` date mask intact.
    expect(texts(MINIMAL_MODEL).map((t) => t.replace(/_{8,}/g, '___'))).toEqual([
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
      // The proof-of-delivery stub — see `receiptBlock`. Legacy had only
      // `Recebido: ___` + a date, which proves a parcel was handed over but not
      // to WHOM, and that is the half that gets disputed.
      'Comprovante de recebimento',
      'Nome legível: ___',
      'CPF / RG: ___',
      'Data: ____/____/______',
      '___',
      'Assinatura do recebedor',
    ]);
  });

  it('puts the receipt stub on every label, whatever the tipo', () => {
    for (const model of [MINIMAL_MODEL, COM_NFE_MODEL, REVERSO_MODEL, RETIRADA_MODEL]) {
      const drawn = texts(model);
      expect(drawn).toContain('Comprovante de recebimento');
      expect(drawn).toContain('Assinatura do recebedor');
      expect(drawn.some((t) => t.startsWith('Nome legível:'))).toBe(true);
      expect(drawn.some((t) => t.startsWith('CPF / RG:'))).toBe(true);
      expect(drawn).toContain('Data: ____/____/______');
    }
  });

  it('leaves real room to sign in, not just a caption under a line', () => {
    const ops = textOps(MINIMAL_MODEL);
    const signRule = ops.findIndex((op) => /^_+$/.test(op.text));
    expect(signRule).toBeGreaterThan(0);
    // The gap between the last filled field and the signature rule is what the
    // recebedor actually signs in; a rule butted against the line above is
    // unusable with a pen.
    const gap = ops[signRule]!.y - ops[signRule - 1]!.y;
    expect(gap).toBeGreaterThan(8);
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
    // …and the filial sede is the delivery target.
    expect(drawn).toContain('Entrega');
    expect(drawn).toContain('Logradouro: Avenida Industrial, 900');
    // The receipt stub still follows it — the filial signs for the return too.
    expect(drawn.indexOf('Comprovante de recebimento')).toBeGreaterThan(
      drawn.indexOf('Logradouro: Avenida Industrial, 900'),
    );
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
    // Legacy: header, cliente, endereço, recebedor, volumes — plus one after
    // the reverse Entrega block, which now precedes the receipt stub instead of
    // being the last thing on the label.
    expect(rules).toHaveLength(6);
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
    expect(layout.scale).toBe(1); // comfortable — no squeeze needed
  });
});

describe('buildEtiquetaGenericaLayout — nothing may leave the page', () => {
  const MODELS: Array<[string, EtiquetaGenericaModel]> = [
    ['minimal', MINIMAL_MODEL],
    ['com NF-e', COM_NFE_MODEL],
    ['reverso', REVERSO_MODEL],
    ['retirada', RETIRADA_MODEL],
    ['maximal', MAXIMAL_MODEL],
    ['long uppercase strings', LONG_STRINGS_MODEL],
  ];

  it.each(MODELS)('keeps every line inside the 90mm text box (%s)', (_name, model) => {
    // Measured width, not a character count — a 51-char uppercase line is 118mm
    // wide and the old count-based assertion waved it through.
    for (const op of textOps(model)) {
      expect(textWidthMm(op.text, op.sizePt, op.bold)).toBeLessThanOrEqual(op.w);
    }
  });

  it.each(MODELS)('keeps every op inside the 150mm page (%s)', (_name, model) => {
    const layout = buildEtiquetaGenericaLayout(model);
    expect(layout.contentHeightMm).toBeLessThanOrEqual(LABEL_H_MM);
    for (const op of layout.ops) {
      if (op.kind === 'rect') continue; // the border IS the page
      const bottom =
        op.kind === 'text' ? op.y + lineHeightMm(op.sizePt) : op.y + ('h' in op ? op.h : 0);
      expect(bottom).toBeLessThanOrEqual(LABEL_H_MM);
    }
  });

  it.each(MODELS)('never lets two lines collide (%s)', (_name, model) => {
    // The squeeze has to scale the TYPE as well as the vertical rhythm. Scaling
    // only `y` still "fits the page" — it just draws the lines on top of each
    // other, which no page-bounds assertion would ever notice.
    const ops = textOps(model);
    for (let i = 0; i < ops.length - 1; i += 1) {
      const bottom = ops[i]!.y + lineHeightMm(ops[i]!.sizePt);
      expect(bottom).toBeLessThanOrEqual(ops[i + 1]!.y + 1e-6);
    }
  });

  it('shrinks a realistic long-address reverse label to fit rather than dropping its tail', () => {
    const layout = buildEtiquetaGenericaLayout(LONG_STRINGS_MODEL);
    // It genuinely overflows at full size — that is why the fixture exists.
    expect(layout.scale).toBeLessThan(1);
    expect(layout.scale).toBeGreaterThan(0.7); // still comfortably legible
    // …and the block that used to fall off the bottom is still drawn: on a
    // reverse label the tail is the filial-sede address the parcel returns to.
    const drawn = texts(LONG_STRINGS_MODEL);
    expect(drawn).toContain('Entrega');
    expect(drawn.some((t) => t.includes('RODOVIA GOVERNADOR'))).toBe(true);
  });
});

describe('wrapText', () => {
  const INNER_W = 90;

  it('wraps on word boundaries instead of letting a line run past the border', () => {
    for (const line of wrapText('Rua Professor Doutor Antonio Carlos', 30, 10, false)) {
      expect(textWidthMm(line, 10, false)).toBeLessThanOrEqual(30);
    }
    expect(wrapText('Rua Professor Doutor Antonio Carlos', 30, 10, false).length).toBeGreaterThan(
      1,
    );
  });

  it('wraps uppercase earlier than lowercase, because it IS wider', () => {
    // The bug this replaced: a flat 0.5em average treated these as identical.
    const lower = wrapText('a'.repeat(60), INNER_W, 10, false);
    const upper = wrapText('W'.repeat(60), INNER_W, 10, false);
    expect(upper.length).toBeGreaterThan(lower.length);
  });

  it('hard-splits a single word too wide for the box', () => {
    const parts = wrapText('A'.repeat(200), INNER_W, 10, false);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(textWidthMm(part, 10, false)).toBeLessThanOrEqual(INNER_W);
  });

  it('accounts for the point size, not just the character count', () => {
    expect(wrapText('A'.repeat(40), INNER_W, 20, false).length).toBeGreaterThan(
      wrapText('A'.repeat(40), INNER_W, 10, false).length,
    );
  });

  it('returns a single empty line for empty input rather than nothing', () => {
    expect(wrapText('', INNER_W, 10, false)).toEqual(['']);
  });
});

describe('groupChave', () => {
  it('groups the 44-digit chave in eleven blocks of four', () => {
    const grouped = groupChave(CHAVE);
    expect(grouped.split(' ')).toHaveLength(11);
    expect(grouped.replace(/ /g, '')).toBe(CHAVE);
  });
});
