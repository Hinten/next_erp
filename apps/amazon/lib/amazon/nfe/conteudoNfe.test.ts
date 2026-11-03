/**
 * `invoiceContent` and `contentMD5Value` (step 14, PR 14-b): fixed vectors
 * (each recomputed with `node:crypto` before it was pinned), the near misses a
 * wrong encoding would produce, and the round trip of the exact bytes. The
 * package's own shape checks accept what this module builds.
 */
import {
  type PedidoPostSpApi,
  type SpApiEscritaClient,
  enviarNotaFiscal,
} from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { conteudoDaNfeAmazon } from './conteudoNfe';

/** What the package checks (`entrega.ts`): 22 base64 characters, then `==`. */
const MD5_BASE64 = /^[A-Za-z0-9+/]{22}==$/;
/** Standard base64, length a multiple of 4. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const XML_MINIMO = '<?xml version="1.0" encoding="UTF-8"?><nfeProc/>';
/** The byte-order mark, built from its code point so this file's own encoding cannot change it. */
const BOM = String.fromCharCode(0xfeff);
/** "A" + c-cedilla + a-tilde + "o" (the pt-BR word for action), the same way. */
const ACAO = String.fromCharCode(0x41, 0xe7, 0xe3, 0x6f);

describe('conteudoDaNfeAmazon — the digest', () => {
  it.each([
    ['the empty string', '', '1B2M2Y8AsgTpgAmY7PhCfg=='],
    ['abc', 'abc', 'kAFQmDzST7DWlj99KOF/cg=='],
    ['a minimal proc', XML_MINIMO, 'a/PoRlrYGXeMk2IMq+1Yhg=='],
    ['a non-ASCII text, as UTF-8 bytes', ACAO, 'NpsXEAc+zTLiZI9AQ3M3sg=='],
  ])('★ %s ⇒ the base64 of the MD5 of its UTF-8 bytes', (_r, xml, md5) => {
    const c = conteudoDaNfeAmazon(xml);
    expect(c.contentMD5Value).toBe(md5);
    expect(c.contentMD5Value).toMatch(MD5_BASE64);
  });

  it('★ mutation 5 NEAR-MISS: never the hex digest (the model’s placeholder shape)', () => {
    const c = conteudoDaNfeAmazon('abc');
    expect(c.contentMD5Value).not.toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(c.contentMD5Value).not.toMatch(/^[0-9a-f]{32}$/);
  });

  it('★ mutation 6 NEAR-MISS: never the MD5 of the base64 TEXT', () => {
    const c = conteudoDaNfeAmazon('abc');
    expect(c.contentMD5Value).not.toBe('9MASgXimoht6PddnKXJdkQ==');
  });

  it('★ NEAR-MISS: never the bytes as latin1', () => {
    expect(conteudoDaNfeAmazon(ACAO).contentMD5Value).not.toBe('2vSq/DcgNKyBGmXvCPuG4A==');
  });
});

describe('conteudoDaNfeAmazon — the content', () => {
  it('★ mutation 7: invoiceContent decodes back to the EXACT input — a leading BOM and a trailing newline kept', () => {
    for (const xml of [
      XML_MINIMO,
      `${BOM}${XML_MINIMO}\n`,
      `  ${XML_MINIMO}\r\n`,
      `${XML_MINIMO}<!-- ${ACAO} -->`,
    ]) {
      const c = conteudoDaNfeAmazon(xml);
      expect(Buffer.from(c.invoiceContent, 'base64').toString('utf8')).toBe(xml);
      expect(c.invoiceContent).toMatch(BASE64);
      expect(c.invoiceContent.length % 4).toBe(0);
    }
  });

  it('★ mutation 7: the digest covers the same untouched bytes (a BOM and a newline change it)', () => {
    const limpo = conteudoDaNfeAmazon(XML_MINIMO).contentMD5Value;
    expect(conteudoDaNfeAmazon(`${BOM}${XML_MINIMO}`).contentMD5Value).not.toBe(limpo);
    expect(conteudoDaNfeAmazon(`${XML_MINIMO}\n`).contentMD5Value).not.toBe(limpo);
    expect(conteudoDaNfeAmazon(` ${XML_MINIMO}`).contentMD5Value).not.toBe(limpo);
  });

  it('a pinned content vector: the BOM + newline proc', () => {
    expect(conteudoDaNfeAmazon(`${BOM}<a/>\n`)).toEqual({
      invoiceContent: '77u/PGEvPgo=',
      contentMD5Value: 'bZo85z4sJ7g+BFobwZnmjQ==',
    });
  });
});

describe('the package accepts what this module builds', () => {
  it('enviarNotaFiscal’s shape checks pass, and the body carries the two values verbatim (a recording client, no network)', async () => {
    const corpos: string[] = [];
    const escritor: SpApiEscritaClient = {
      post: <S extends z.ZodType>(p: PedidoPostSpApi<S>) => {
        corpos.push(p.corpo);
        return Promise.resolve({ dados: p.schema.parse({}) as z.infer<S> } as never);
      },
    };
    const c = conteudoDaNfeAmazon(`${BOM}${XML_MINIMO}\n`);
    await expect(
      enviarNotaFiscal(escritor, { orderId: '171-9876543-2109876', ...c }),
    ).resolves.toEqual({ tipo: 'aceito-para-processamento' });
    const enviado = JSON.parse(corpos[0] ?? '{}') as Record<string, unknown>;
    expect(enviado.invoiceContent).toBe(c.invoiceContent);
    expect(enviado.contentMD5Value).toBe(c.contentMD5Value);
  });
});
