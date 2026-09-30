import { describe, expect, it } from 'vitest';

import {
  SHOPEE_ARQUIVO_ACCEPT,
  type ShopeeFormatoDeArquivo,
  classificarArquivoDeEnvio,
  pareceCorpoJson,
} from '../src/arquivo';
import * as publico from '../src/index';

const bytes = (...valores: number[]) => new Uint8Array(valores);
const ascii = (texto: string) => new TextEncoder().encode(texto);
const BOM = [0xef, 0xbb, 0xbf];

/** Um PDF mínimo com a linha binária de marcação (`%âãÏÓ`) — bytes ≥ 0x80. */
const PDF = bytes(
  0x25,
  0x50,
  0x44,
  0x46,
  0x2d,
  0x31,
  0x2e,
  0x37,
  0x0a,
  0x25,
  0xe2,
  0xe3,
  0xcf,
  0xd3,
);
/** Um cabeçalho LOCAL de arquivo ZIP — um arquivo com pelo menos uma entrada. */
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00);
/** O registro de fim de diretório central com que começa um ZIP VAZIO. */
const ZIP_VAZIO = bytes(0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00);

const PDF_ESPERADO: ShopeeFormatoDeArquivo = {
  formato: 'pdf',
  contentType: 'application/pdf',
  extensao: 'pdf',
};
const ZIP_ESPERADO: ShopeeFormatoDeArquivo = {
  formato: 'zip',
  contentType: 'application/zip',
  extensao: 'zip',
};
const ZPL_ESPERADO: ShopeeFormatoDeArquivo = {
  formato: 'zpl',
  contentType: 'text/plain',
  extensao: 'txt',
};
const DESCONHECIDO: ShopeeFormatoDeArquivo = { formato: 'desconhecido' };

describe('pareceCorpoJson — o corpo é um envelope, e não um arquivo?', () => {
  it('PAR — `{` e `[` no primeiro byte são JSON', () => {
    expect(pareceCorpoJson(ascii('{"error":"error_param"}'))).toBe(true);
    expect(pareceCorpoJson(ascii('[]'))).toBe(true);
  });

  it('S4 — PAR: um BOM UTF-8 e espaço ASCII na frente continuam sendo JSON', () => {
    // ⚠️ O mutante que ignora o BOM/o espaço entregaria um envelope de ERRO ao
    // chamador como se fosse uma "etiqueta".
    expect(pareceCorpoJson(new Uint8Array([...BOM, ...ascii('  {"error":"x"}')]))).toBe(true);
    expect(pareceCorpoJson(new Uint8Array([...BOM, ...ascii('{}')]))).toBe(true);
    expect(pareceCorpoJson(ascii(' \t\r\n{}'))).toBe(true);
    expect(pareceCorpoJson(ascii('\n[1]'))).toBe(true);
  });

  it('⛔ QUASE-IGUAL — um arquivo de etiqueta nunca parece JSON', () => {
    expect(pareceCorpoJson(PDF)).toBe(false);
    expect(pareceCorpoJson(ZIP)).toBe(false);
    expect(pareceCorpoJson(ascii('^XA^FO50,50^FDteste^FS^XZ'))).toBe(false);
    expect(pareceCorpoJson(ascii('<html><body>403</body></html>'))).toBe(false);
  });

  it('⛔ QUASE-IGUAL — vazio, só BOM e só espaço NÃO são JSON', () => {
    expect(pareceCorpoJson(new Uint8Array())).toBe(false);
    expect(pareceCorpoJson(bytes(...BOM))).toBe(false);
    expect(pareceCorpoJson(ascii('   \n'))).toBe(false);
  });

  it('⛔ QUASE-IGUAL — o BOM só vale no byte 0, e um form feed não é espaço de JSON', () => {
    // O BOM depois de um espaço não é um BOM: é um byte não-espaço antes do `{`.
    expect(pareceCorpoJson(new Uint8Array([0x20, ...BOM, ...ascii('{}')]))).toBe(false);
    // `JSON.parse` recusa o FF; contá-lo aqui mandaria ao parser um corpo que ele
    // chamaria de não-JSON.
    expect(pareceCorpoJson(ascii('\f{}'))).toBe(false);
    // Um BOM pela metade não é pulado.
    expect(pareceCorpoJson(bytes(0xef, 0xbb, 0x7b))).toBe(false);
  });
});

describe('classificarArquivoDeEnvio — a assinatura decide o formato', () => {
  it('PAR — `%PDF-` é PDF, com o content type EXATO e sem parâmetro', () => {
    expect(classificarArquivoDeEnvio(PDF)).toEqual(PDF_ESPERADO);
  });

  it('S7 — ⛔ QUASE-IGUAL: um `%PD` truncado e um `%PDF` sem hífen NÃO são PDF', () => {
    expect(classificarArquivoDeEnvio(ascii('%PD'))).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(ascii('%PDF'))).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(ascii('%PDX-1.7'))).toEqual(DESCONHECIDO);
    // A assinatura vale no byte 0: um PDF com espaço na frente não é reconhecido.
    expect(classificarArquivoDeEnvio(ascii(' %PDF-1.7'))).toEqual(DESCONHECIDO);
  });

  it('PAR — `PK\\x03\\x04` é ZIP, com `application/zip` EXATO', () => {
    expect(classificarArquivoDeEnvio(ZIP)).toEqual(ZIP_ESPERADO);
  });

  it('S6 — ⛔ QUASE-IGUAL: `PK\\x05\\x06` (um ZIP VAZIO) é desconhecido — não há etiqueta dentro', () => {
    expect(classificarArquivoDeEnvio(ZIP_VAZIO)).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(bytes(0x50, 0x4b, 0x03))).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(bytes(0x50, 0x4b, 0x07, 0x08))).toEqual(DESCONHECIDO);
  });

  it('S8 — PAR: `^XA` (depois de espaço ASCII) é ZPL, servido como `text/plain` EXATO — nunca com charset', () => {
    // ⚠️ O agente de impressão compara o tipo por IGUALDADE de string:
    // `text/plain;charset=utf-8` é um tipo que ele não imprime.
    expect(classificarArquivoDeEnvio(ascii('^XA^FO50,50^FDteste^FS^XZ'))).toEqual(ZPL_ESPERADO);
    expect(classificarArquivoDeEnvio(ascii('\r\n  \t^XA^XZ'))).toEqual(ZPL_ESPERADO);
  });

  it('⛔ QUASE-IGUAL — `^X`, `^XB` e `^XA` depois de um BOM NÃO são ZPL', () => {
    expect(classificarArquivoDeEnvio(ascii('^X'))).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(ascii('^XB^XZ'))).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(new Uint8Array([...BOM, ...ascii('^XA^XZ')]))).toEqual(
      DESCONHECIDO,
    );
  });

  it('⛔ QUASE-IGUAL — vazio, JSON, HTML e um octet stream qualquer são desconhecidos', () => {
    // Nenhum fallback para `application/octet-stream`: o agente não imprime nada
    // para esse tipo e ainda responde 200 — a perda silenciosa que o ML aceita.
    expect(classificarArquivoDeEnvio(new Uint8Array())).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(ascii('{"error":""}'))).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(ascii('<html>'))).toEqual(DESCONHECIDO);
    expect(classificarArquivoDeEnvio(bytes(0x00, 0x01, 0xff, 0xfe))).toEqual(DESCONHECIDO);
  });

  it('o desconhecido não carrega content type nenhum — não há o que servir', () => {
    expect(Object.keys(classificarArquivoDeEnvio(ascii('<html>')))).toEqual(['formato']);
  });
});

describe('a porta pública', () => {
  it('`index.ts` reexporta o módulo novo', () => {
    expect(publico.SHOPEE_ARQUIVO_ACCEPT).toBe('*/*');
    expect(SHOPEE_ARQUIVO_ACCEPT).toBe('*/*');
    expect(publico.pareceCorpoJson).toBe(pareceCorpoJson);
    expect(publico.classificarArquivoDeEnvio).toBe(classificarArquivoDeEnvio);
    expect(typeof publico.ShopeeArquivoVazioError).toBe('function');
  });
});
