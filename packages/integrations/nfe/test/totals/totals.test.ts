import { describe, expect, it } from 'vitest';

import { extrairTotaisNFe } from '../../src/totals';

/**
 * Build a minimal but structurally faithful `<nfeProc>`: an `<ide>`, one or
 * more `<det><prod>` carrying their own `vProd`/`vDesc`, and the note-level
 * `<ICMSTot>`. The per-item values are deliberately DIFFERENT from the totals —
 * that difference is what the scoping tests below detect.
 */
function nfeProc(opts: {
  tpNF?: string;
  finNFe?: string;
  itens?: { vProd: string; vDesc: string }[];
  total?: Record<string, string>;
}): string {
  const itens = (opts.itens ?? [{ vProd: '10.00', vDesc: '0.00' }])
    .map(
      (i, n) =>
        `<det nItem="${n + 1}"><prod><cProd>X</cProd><vProd>${i.vProd}</vProd>` +
        `<vDesc>${i.vDesc}</vDesc></prod></det>`,
    )
    .join('');
  const total = Object.entries(opts.total ?? { vProd: '100.00', vDesc: '0.00', vNF: '100.00' })
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe35..." versao="4.00">` +
    `<ide><cUF>35</cUF><natOp>VENDA</natOp><tpNF>${opts.tpNF ?? '1'}</tpNF>` +
    `<finNFe>${opts.finNFe ?? '1'}</finNFe></ide>` +
    itens +
    `<total><ICMSTot>${total}</ICMSTot></total>` +
    `</infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`
  );
}

describe('extrairTotaisNFe', () => {
  it('reads the ICMSTot totals and the ide codes', () => {
    const t = extrairTotaisNFe(
      nfeProc({
        total: {
          vProd: '250.00',
          vDesc: '10.00',
          vST: '5.00',
          vIPI: '2.50',
          vFrete: '20.00',
          vSeg: '1.00',
          vOutro: '3.00',
          vNF: '271.50',
        },
      }),
    );
    expect(t).toEqual({
      vProd: 250,
      vDesc: 10,
      vST: 5,
      vIPI: 2.5,
      vFrete: 20,
      vSeg: 1,
      vOutro: 3,
      vNF: 271.5,
      tpNF: 1,
      finNFe: 1,
    });
  });

  // ── The scoping hazard this module exists to get right ──────────────────
  //
  // `vProd`/`vDesc` appear on EVERY `<det><prod>` as well as on `<ICMSTot>`.
  // A document-wide match returns the FIRST ITEM instead of the note total.
  describe('scoping — the per-item near-miss', () => {
    it('returns the ICMSTot vProd, NOT the first item vProd', () => {
      const t = extrairTotaisNFe(
        nfeProc({
          itens: [
            { vProd: '30.00', vDesc: '1.00' },
            { vProd: '70.00', vDesc: '2.00' },
          ],
          total: { vProd: '100.00', vDesc: '3.00', vNF: '97.00' },
        }),
      );
      // 30 is the first item and is a plausible-looking number; 100 is the note.
      expect(t?.vProd).toBe(100);
      expect(t?.vDesc).toBe(3);
    });

    it('a single-item note, where the two happen to AGREE, still comes from ICMSTot', () => {
      // The dangerous case: on a one-item note the wrong read is not wrong, so
      // it cannot distinguish a correct implementation from a broken one. This
      // pins the value that must come back either way.
      const t = extrairTotaisNFe(
        nfeProc({
          itens: [{ vProd: '42.00', vDesc: '0.00' }],
          total: { vProd: '42.00', vDesc: '0.00', vNF: '42.00' },
        }),
      );
      expect(t?.vProd).toBe(42);
    });
  });

  // ── Equal-vs-distinct pairs (the equivalence-fold rule) ─────────────────
  describe('what folds together, and what must stay apart', () => {
    it('EQUAL: trailing-zero forms of the same amount', () => {
      const a = extrairTotaisNFe(nfeProc({ total: { vProd: '90.5', vDesc: '0', vNF: '90.5' } }));
      const b = extrairTotaisNFe(
        nfeProc({ total: { vProd: '90.50', vDesc: '0.00', vNF: '90.50' } }),
      );
      expect(a?.vProd).toBe(b?.vProd);
    });

    it('DISTINCT: an explicit 0.00 is not the same as an absent block', () => {
      // `vFrete` absent means "no freight" → 0, and the block is still readable.
      const semFrete = extrairTotaisNFe(nfeProc({ total: { vProd: '10.00', vNF: '10.00' } }));
      expect(semFrete?.vFrete).toBe(0);
      // A missing `vNF`, by contrast, makes the note UNREADABLE — not zero.
      // Conflating the two is what would silently understate a month.
      const semNF = extrairTotaisNFe(nfeProc({ total: { vProd: '10.00', vFrete: '0.00' } }));
      expect(semNF).toBeNull();
    });

    it('DISTINCT: amounts that differ only past the second decimal', () => {
      const a = extrairTotaisNFe(nfeProc({ total: { vProd: '1.00', vDesc: '0', vNF: '1.00' } }));
      const b = extrairTotaisNFe(nfeProc({ total: { vProd: '1.01', vDesc: '0', vNF: '1.01' } }));
      expect(a?.vNF).not.toBe(b?.vNF);
    });
  });

  // ── null, never a partial block ─────────────────────────────────────────
  describe('returns null rather than a half-filled block', () => {
    it.each([
      ['empty string', ''],
      ['not XML at all', 'nem xml é'],
      [
        'no ICMSTot (an unauthorized doc)',
        '<nfeProc><NFe><infNFe><ide><tpNF>1</tpNF></ide></infNFe></NFe></nfeProc>',
      ],
    ])('%s', (_label, xml) => {
      expect(extrairTotaisNFe(xml)).toBeNull();
    });

    it('missing <ide> — no tpNF means we cannot tell revenue from a return', () => {
      expect(
        extrairTotaisNFe(
          '<nfeProc><total><ICMSTot><vProd>1.00</vProd><vNF>1.00</vNF></ICMSTot></total></nfeProc>',
        ),
      ).toBeNull();
    });

    it('rejects an out-of-range tpNF instead of coercing it', () => {
      expect(extrairTotaisNFe(nfeProc({ tpNF: '7' }))).toBeNull();
    });

    it('rejects an out-of-range finNFe instead of coercing it', () => {
      expect(extrairTotaisNFe(nfeProc({ finNFe: '9' }))).toBeNull();
    });

    it('rejects a comma decimal — a wire decimal is always dot-separated', () => {
      // If a comma ever shows up here the string is not what we think it is,
      // and guessing at the separator would invent a value.
      expect(extrairTotaisNFe(nfeProc({ total: { vProd: '1,50', vNF: '1,50' } }))).toBeNull();
    });

    // ── A malformed COMPONENT poisons the block too ──────────────────────
    //
    // These six used to fold to 0 on any unparseable value, which left the
    // block looking complete: `notasSemTotais` never counted the note, and the
    // total silently moved — up for a lost `vDesc`, DOWN for a lost `vFrete`.
    it.each([
      ['vDesc', '1,50'],
      ['vST', '1,50'],
      ['vIPI', 'N/A'],
      ['vFrete', 'grátis'],
      ['vSeg', '--'],
      ['vOutro', '1.2.3'],
    ])('a malformed %s poisons the whole block rather than folding to 0', (tag, lixo) => {
      const xml = nfeProc({
        total: { vProd: '1000.00', vDesc: '10.00', [tag]: lixo, vNF: '1000.00' },
      });
      expect(extrairTotaisNFe(xml)).toBeNull();
    });
  });

  // ── The near-miss the poison rule must NOT break ────────────────────────
  describe('absent is still zero — only PRESENT-and-unreadable poisons', () => {
    it('an omitted <vST> reads as 0 and the note stays readable', () => {
      // `<vFrete>`/`<vST>` are legitimately absent on most notes. If the fix
      // above had poisoned on absence instead, every ordinary note would come
      // back null and the apuração would never publish a rate at all.
      const t = extrairTotaisNFe(nfeProc({ total: { vProd: '10.00', vNF: '10.00' } }));
      expect(t).not.toBeNull();
      expect(t?.vST).toBe(0);
      expect(t?.vFrete).toBe(0);
    });

    it('an EMPTY <vST></vST> reads as 0, not as garbage', () => {
      const xml = nfeProc({ total: { vProd: '10.00', vST: '', vNF: '10.00' } });
      expect(extrairTotaisNFe(xml)?.vST).toBe(0);
    });

    it('a legitimate 0.00 and an absent tag agree — both mean "none"', () => {
      const explicito = extrairTotaisNFe(
        nfeProc({ total: { vProd: '10.00', vST: '0.00', vNF: '10.00' } }),
      );
      const ausente = extrairTotaisNFe(nfeProc({ total: { vProd: '10.00', vNF: '10.00' } }));
      expect(explicito?.vST).toBe(ausente?.vST);
    });
  });

  it('carries tpNF=0 through — an entrada SUBTRACTS from faturamento', () => {
    const t = extrairTotaisNFe(nfeProc({ tpNF: '0', finNFe: '4' }));
    expect(t?.tpNF).toBe(0);
    expect(t?.finNFe).toBe(4);
  });

  it('tolerates a namespace prefix on the elements', () => {
    const xml =
      '<ns:nfeProc xmlns:ns="http://www.portalfiscal.inf.br/nfe"><ns:ide><ns:tpNF>1</ns:tpNF>' +
      '<ns:finNFe>1</ns:finNFe></ns:ide><ns:total><ns:ICMSTot><ns:vProd>5.00</ns:vProd>' +
      '<ns:vNF>5.00</ns:vNF></ns:ICMSTot></ns:total></ns:nfeProc>';
    expect(extrairTotaisNFe(xml)?.vNF).toBe(5);
  });
});
