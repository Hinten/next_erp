import { describe, expect, it } from 'vitest';

import { ESTADO_NFE } from './nfe';
import {
  decideNfeUploadDispatch,
  decideNfeUploadTransition,
  extractTpAmb,
  finalidadeDaNfeProc,
  type NfeUploadDispatch,
  type NfeUploadTransition,
} from './nfeEnvioCanal';

/*
 * Synthetic nfeProc shells — no access key, no CNPJ, nothing but the two
 * `<tpAmb>` positions the reader cares about. The ide one comes FIRST, as in
 * every real nfeProc (infNFe precedes protNFe).
 */
function proc(tpAmbIde: string, tpAmbProt: string = tpAmbIde): string {
  return (
    `<nfeProc><NFe><infNFe><ide><tpAmb>${tpAmbIde}</tpAmb></ide></infNFe></NFe>` +
    `<protNFe><infProt><tpAmb>${tpAmbProt}</tpAmb></infProt></protNFe></nfeProc>`
  );
}
const XML_PROD = proc('1');
const XML_HOM = proc('2');
const XML_SEM_TPAMB = '<nfeProc><NFe><infNFe><ide></ide></infNFe></NFe></nfeProc>';

/** A raw nfev4 snapshot, ready by default (aprovada + produção proc). */
function nfeDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { estado: ESTADO_NFE.aprovada, xml_nfe_proc: XML_PROD, numero: 7, ...over };
}

/* -------------------------------- extractTpAmb ------------------------------ */

describe('extractTpAmb', () => {
  it("reads '1' and '2', tolerating whitespace inside the element", () => {
    expect(extractTpAmb(XML_PROD)).toBe('1');
    expect(extractTpAmb('<ide><tpAmb>\n  1  </tpAmb></ide>')).toBe('1');
    expect(extractTpAmb(XML_HOM)).toBe('2');
  });

  it('the FIRST tpAmb wins — infNFe/ide 1 before a protNFe echo 2 reads 1 (and the reverse reads 2)', () => {
    expect(extractTpAmb(proc('1', '2'))).toBe('1');
    expect(extractTpAmb(proc('2', '1'))).toBe('2');
  });

  it('NEAR-MISS: no tpAmb, or a value outside 1|2, is null — never coerced to an ambiente', () => {
    expect(extractTpAmb(XML_SEM_TPAMB)).toBeNull();
    expect(extractTpAmb('<tpAmb>3</tpAmb>')).toBeNull();
    expect(extractTpAmb('<tpAmb></tpAmb>')).toBeNull();
    expect(extractTpAmb('')).toBeNull();
  });
});

/* -------------------------- decideNfeUploadDispatch ------------------------- */

describe('decideNfeUploadDispatch — the LEVEL ladder (Mercado Livre)', () => {
  it('apagada: a deleted doc (after undefined)', () => {
    expect(decideNfeUploadDispatch(nfeDoc(), undefined)).toEqual({
      action: 'skip',
      reason: 'apagada',
    });
  });

  it('nao-aprovada: any estado but aprovada — epecAprovado included', () => {
    for (const estado of [ESTADO_NFE.gerado, ESTADO_NFE.epecAprovado, ESTADO_NFE.cancelada]) {
      expect(decideNfeUploadDispatch(undefined, nfeDoc({ estado }))).toEqual({
        action: 'skip',
        reason: 'nao-aprovada',
      });
    }
  });

  it('xml-ausente: xml_nfe_proc null, absent, or not a string', () => {
    for (const xml_nfe_proc of [null, undefined, 123]) {
      expect(decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc }))).toEqual({
        action: 'skip',
        reason: 'xml-ausente',
      });
    }
  });

  it('tpamb-homologacao: a tpAmb 2 proc AND an unparseable one', () => {
    for (const xml_nfe_proc of [XML_HOM, XML_SEM_TPAMB]) {
      expect(decideNfeUploadDispatch(undefined, nfeDoc({ xml_nfe_proc }))).toEqual({
        action: 'skip',
        reason: 'tpamb-homologacao',
      });
    }
  });

  it('enqueue: an aprovada produção proc', () => {
    expect(decideNfeUploadDispatch(undefined, nfeDoc())).toEqual({ action: 'enqueue' });
  });

  it('LEVEL: ready → ready (a rewrite) still enqueues — the level ladder reads `after` only', () => {
    expect(decideNfeUploadDispatch(nfeDoc(), nfeDoc({ totais: { vNF: 10 } }))).toEqual({
      action: 'enqueue',
    });
  });
});

/* ------------------------- decideNfeUploadTransition ------------------------ */

describe('decideNfeUploadTransition — the EDGE (Shopee)', () => {
  it('create-ready: undefined → ready enqueues', () => {
    expect(decideNfeUploadTransition(undefined, nfeDoc())).toEqual({ action: 'enqueue' });
  });

  it('not-ready → ready: enviando → aprovada + produção proc enqueues', () => {
    const before = nfeDoc({ estado: ESTADO_NFE.enviando, xml_nfe_proc: null });
    expect(decideNfeUploadTransition(before, nfeDoc())).toEqual({ action: 'enqueue' });
  });

  it('NEAR-MISS of the migration pair: aprovada WITHOUT proc → aprovada WITH proc (digest-mismatch repair) enqueues', () => {
    const before = nfeDoc({ xml_nfe_proc: null });
    expect(decideNfeUploadTransition(before, nfeDoc())).toEqual({ action: 'enqueue' });
  });

  it('EQUAL PAIR (the 2026-09-nfe-totais migration): ready → ready with only `totais` changed is ja-pronta', () => {
    const before = nfeDoc();
    const after = nfeDoc({ totais: { vNF: 10, tpNF: '1', finNFe: '1' } });
    expect(decideNfeUploadTransition(before, after)).toEqual({
      action: 'skip',
      reason: 'ja-pronta',
    });
  });

  it('EQUAL PAIR: an identical rewrite of a ready doc (a poke) is ja-pronta', () => {
    expect(decideNfeUploadTransition(nfeDoc(), nfeDoc())).toEqual({
      action: 'skip',
      reason: 'ja-pronta',
    });
  });

  it('NEAR-MISS: epecAprovado → aprovada (EPEC pós-transmissão) enqueues', () => {
    const before = nfeDoc({ estado: ESTADO_NFE.epecAprovado });
    expect(decideNfeUploadTransition(before, nfeDoc())).toEqual({ action: 'enqueue' });
  });

  it('NEAR-MISS: aprovada tpAmb 2 → aprovada tpAmb 1 enqueues (ready is the whole predicate, not the estado)', () => {
    const before = nfeDoc({ xml_nfe_proc: XML_HOM });
    expect(decideNfeUploadTransition(before, nfeDoc())).toEqual({ action: 'enqueue' });
  });

  it('ready → cancelada is the level verdict of `after` (nao-aprovada), never ja-pronta', () => {
    const after = nfeDoc({ estado: ESTADO_NFE.cancelada });
    expect(decideNfeUploadTransition(nfeDoc(), after)).toEqual({
      action: 'skip',
      reason: 'nao-aprovada',
    });
  });

  it('delete of a ready doc is apagada', () => {
    expect(decideNfeUploadTransition(nfeDoc(), undefined)).toEqual({
      action: 'skip',
      reason: 'apagada',
    });
  });

  it('a tpAmb 2 proc is tpamb-homologacao, whatever came before', () => {
    const after = nfeDoc({ xml_nfe_proc: XML_HOM });
    expect(decideNfeUploadTransition(undefined, after)).toEqual({
      action: 'skip',
      reason: 'tpamb-homologacao',
    });
    expect(decideNfeUploadTransition(nfeDoc(), after)).toEqual({
      action: 'skip',
      reason: 'tpamb-homologacao',
    });
  });

  it('the first tpAmb wins on the edge too: ide 1 + protNFe echo 2 enqueues, ide 2 + echo 1 does not', () => {
    const before = nfeDoc({ estado: ESTADO_NFE.enviando, xml_nfe_proc: null });
    expect(decideNfeUploadTransition(before, nfeDoc({ xml_nfe_proc: proc('1', '2') }))).toEqual({
      action: 'enqueue',
    });
    expect(decideNfeUploadTransition(before, nfeDoc({ xml_nfe_proc: proc('2', '1') }))).toEqual({
      action: 'skip',
      reason: 'tpamb-homologacao',
    });
  });

  it('not-ready → not-ready reports the reason of `after` (xml-ausente), not of `before`', () => {
    const before = nfeDoc({ estado: ESTADO_NFE.enviando, xml_nfe_proc: null });
    expect(decideNfeUploadTransition(before, nfeDoc({ xml_nfe_proc: null }))).toEqual({
      action: 'skip',
      reason: 'xml-ausente',
    });
  });
});

/* ------------------------------- type contract ------------------------------ */

describe('the two unions stay apart', () => {
  it("'ja-pronta' is a transition reason only — the level union (an exhaustive Record key in the ML route) rejects it", () => {
    const transicao: NfeUploadTransition = { action: 'skip', reason: 'ja-pronta' };
    // @ts-expect-error — 'ja-pronta' must never join NfeUploadDispatch (tsc enforces this line).
    const nivel: NfeUploadDispatch = { action: 'skip', reason: 'ja-pronta' };
    expect(transicao).toEqual(nivel);
  });
});

/* ------------------------------- the sale gate ------------------------------ */

interface OpcoesDoProcDeVenda {
  /** `null` ⇒ the element is ABSENT. */
  readonly tpNF?: string | null;
  /** `null` ⇒ the element is ABSENT. */
  readonly finNFe?: string | null;
  /** A namespace prefix on every element (`nfe`). */
  readonly ns?: string;
}

/**
 * A minimal synthetic `nfeProc` for the sale gate — no access key, no CNPJ, no
 * real party; the shape Shopee's own table is pinned on.
 */
function procDeVenda(o: OpcoesDoProcDeVenda = {}): string {
  const p = o.ns === undefined ? '' : `${o.ns}:`;
  const tpNF = o.tpNF === undefined ? '1' : o.tpNF;
  const finNFe = o.finNFe === undefined ? '1' : o.finNFe;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${p}nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">`,
    `<${p}NFe><${p}infNFe versao="4.00"><${p}ide><${p}cUF>99</${p}cUF><${p}mod>55</${p}mod>`,
    tpNF === null ? '' : `<${p}tpNF>${tpNF}</${p}tpNF>`,
    finNFe === null ? '' : `<${p}finNFe>${finNFe}</${p}finNFe>`,
    `</${p}ide><${p}emit><${p}xNome>TESTE SINTETICO SEM VALOR FISCAL</${p}xNome></${p}emit>`,
    `</${p}infNFe></${p}NFe>`,
    `<${p}protNFe versao="4.00"><${p}infProt><${p}tpAmb>1</${p}tpAmb>`,
    `<${p}cStat>100</${p}cStat></${p}infProt></${p}protNFe></${p}nfeProc>`,
  ].join('');
}

// The SAME table as Shopee's `finalidadeDoProc` (its `notaNaShopee.test.ts`):
// the function was copied here unchanged, and until Shopee re-points at this
// one, the two copies agree only as long as both tables do.
describe('finalidadeDaNfeProc — only the SALE note goes to a channel', () => {
  it('`tpNF 1` + `finNFe 1` is venda', () => {
    expect(finalidadeDaNfeProc(procDeVenda())).toBe('venda');
  });

  it('a DEVOLUÇÃO (`finNFe 4`) and an ENTRADA (`tpNF 0`) are outra', () => {
    expect(finalidadeDaNfeProc(procDeVenda({ finNFe: '4' }))).toBe('outra');
    expect(finalidadeDaNfeProc(procDeVenda({ tpNF: '0' }))).toBe('outra');
  });

  it.each(['2', '3', '5', '6', '9'])(
    'NEAR-MISS: a legible, non-normal `finNFe %s` is outra (never venda)',
    (finNFe) => {
      expect(finalidadeDaNfeProc(procDeVenda({ finNFe }))).toBe('outra');
    },
  );

  it.each([
    ['no `tpNF`', procDeVenda({ tpNF: null })],
    ['no `finNFe`', procDeVenda({ finNFe: null })],
    ['an empty `tpNF`', procDeVenda({ tpNF: '' })],
    ['a letter in `finNFe`', procDeVenda({ finNFe: 'x' })],
    ['`tpNF` `01` (two digits — never read as `1`)', procDeVenda({ tpNF: '01' })],
    ['`finNFe` `11`', procDeVenda({ finNFe: '11' })],
    ['text that is not XML', 'nada aqui'],
  ])('NEAR-MISS: %s ⇒ ilegivel', (_rotulo, xml) => {
    expect(finalidadeDaNfeProc(xml)).toBe('ilegivel');
  });

  it('PAIR: whitespace around the digit changes nothing; neither does a namespace prefix', () => {
    expect(finalidadeDaNfeProc(procDeVenda({ tpNF: ' 1 ', finNFe: '\n1\n' }))).toBe('venda');
    expect(finalidadeDaNfeProc(procDeVenda({ ns: 'nfe' }))).toBe('venda');
  });

  it('the FIRST element of each wins: a later `tpNF 0` changes nothing', () => {
    const xml = procDeVenda().replace(
      '</nfeProc>',
      '<extra><tpNF>0</tpNF><finNFe>4</finNFe></extra></nfeProc>',
    );
    expect(finalidadeDaNfeProc(xml)).toBe('venda');
  });
});
