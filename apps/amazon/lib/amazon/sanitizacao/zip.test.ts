import { describe, expect, it } from 'vitest';

import { TAMANHO_DO_SAL, criarFalsificadorAmazon } from './falsificacao';
import { lerListagemDoZip, nomeFalsoDeEntrada } from './zip';

const b = (t: string) => new TextEncoder().encode(t);
const falsificador = () => criarFalsificadorAmazon(new Uint8Array(TAMANHO_DO_SAL).fill(3));

describe('★ the zip listing: names faked, sizes kept, never a zip', () => {
  it('entry names are shape-faked, sizes kept, and an order id goes through the SAME id map', () => {
    const f = falsificador();
    const r = lerListagemDoZip(
      b('1024 etiqueta-123-4567890-1234567.zpl\n2048 Loja/Rótulo 7.pdf\n'),
      f,
    );
    expect(r).toEqual({
      ok: true,
      entradas: [
        { nome: `xxxxxxxx-${f('pedido', '123-4567890-1234567')}.zpl`, bytes: 1024 },
        { nome: 'xxxx/xxxxxx 0.pdf', bytes: 2048 },
      ],
    });
  });

  it('near-miss: two entries differing only by extension stay distinct', () => {
    const f = falsificador();
    expect(nomeFalsoDeEntrada('label.zpl', f)).not.toBe(nomeFalsoDeEntrada('label.pdf', f));
  });

  it('an all-digit "extension" is shape-faked, never kept', () => {
    expect(nomeFalsoDeEntrada('arquivo.11222333', falsificador())).toBe('xxxxxxx.00000000');
  });

  it('★ only a label or document extension is kept: a surname or an id fragment after the last dot is shape-faked', () => {
    const f = falsificador();
    expect(nomeFalsoDeEntrada('nf.Sicrano', f)).toBe('xx.xxxxxxx');
    expect(nomeFalsoDeEntrada('etiqueta.Fulana', f)).toBe('xxxxxxxx.xxxxxx');
    expect(nomeFalsoDeEntrada('a.1a2b3c4d', f)).toBe('x.0x0x0x0x');
    // Near-miss: a kept extension stays as written, in any case, and two of them stay distinct.
    expect(nomeFalsoDeEntrada('label.ZPL', f)).toBe('xxxxx.ZPL');
    expect(nomeFalsoDeEntrada('label.pdf', f)).toBe('xxxxx.pdf');
    expect(nomeFalsoDeEntrada('label.ZPL', f)).not.toBe(nomeFalsoDeEntrada('label.pdf', f));
    // A faked name is a fixpoint either way.
    expect(nomeFalsoDeEntrada('xx.xxxxxxx', f)).toBe('xx.xxxxxxx');
  });

  it('a fake name is a fixpoint', () => {
    const f = falsificador();
    const um = nomeFalsoDeEntrada('etiqueta-123-4567890-1234567.zpl', f);
    expect(nomeFalsoDeEntrada(um, f)).toBe(um);
  });

  it('a bad line refuses by line number, never by content; an empty listing is refused', () => {
    expect(lerListagemDoZip(b('10 a.zpl\nsem tamanho.pdf\n'), falsificador())).toEqual({
      ok: false,
      problemas: [{ linha: 2, tipo: 'linha-invalida' }],
    });
    expect(lerListagemDoZip(b('\n'), falsificador())).toEqual({
      ok: false,
      problemas: [{ linha: null, tipo: 'vazio' }],
    });
    expect(lerListagemDoZip(new Uint8Array([0xff, 0xfe, 0x31, 0x00]), falsificador())).toEqual({
      ok: false,
      problemas: [{ linha: null, tipo: 'utf16' }],
    });
  });
});
