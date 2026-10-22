import { describe, expect, it } from 'vitest';

import { fluxoEspiao } from '../testing/fixtures';
import { MAX_CORPO_RECEPTOR_BYTES, MAX_MENSAGEM_SQS_BYTES, lerCorpoLimitado } from './corpo';

const decodificar = (dados: Uint8Array) => new TextDecoder().decode(dados);

describe('lerCorpoLimitado', () => {
  it('pins the bound at twice an SQS message’s 1 MiB maximum: 2 MiB', () => {
    // Literals, not the derivation: the old 256-KiB bound dropped a valid
    // notification between 256 KiB and 1 MiB (the receiver's 1-MiB cases).
    expect(MAX_MENSAGEM_SQS_BYTES).toBe(1_048_576);
    expect(MAX_CORPO_RECEPTOR_BYTES).toBe(2_097_152);
  });

  it('reads a body in chunks and joins them byte for byte', async () => {
    const f = fluxoEspiao(['{"body":', ' {"a":', '"ação"}}']);
    const r = await lerCorpoLimitado(f.stream, null, MAX_CORPO_RECEPTOR_BYTES);
    expect(r.tipo).toBe('lido');
    if (r.tipo !== 'lido') return;
    expect(decodificar(r.dados)).toBe('{"body": {"a":"ação"}}');
    expect(r.bytes).toBe(new TextEncoder().encode('{"body": {"a":"ação"}}').byteLength);
    expect(f.cancelado()).toBe(false);
  });

  it('no body at all is an empty read', async () => {
    expect(await lerCorpoLimitado(null, null, 10)).toEqual({
      tipo: 'lido',
      dados: new Uint8Array(0),
      bytes: 0,
    });
  });

  it.each([null, String(MAX_CORPO_RECEPTOR_BYTES)])(
    'exactly the bound is read whole, content-length %j (the near-miss of one byte more)',
    async (cabecalho) => {
      const f = fluxoEspiao([new Uint8Array(MAX_CORPO_RECEPTOR_BYTES)]);
      const r = await lerCorpoLimitado(f.stream, cabecalho, MAX_CORPO_RECEPTOR_BYTES);
      expect(r).toMatchObject({ tipo: 'lido', bytes: MAX_CORPO_RECEPTOR_BYTES });
      expect(f.cancelado()).toBe(false);
    },
  );

  it('one byte over the bound STOPS the read at the chunk that crossed it, and cancels', async () => {
    // Four quarter-bound chunks reach the bound exactly; the fifth (one byte)
    // crosses it; three more chunks are never pulled. One quarter is reused.
    const quarto = new Uint8Array(MAX_CORPO_RECEPTOR_BYTES / 4);
    const partes = [quarto, quarto, quarto, quarto, new Uint8Array(1), quarto, quarto, quarto];
    const f = fluxoEspiao(partes);
    const r = await lerCorpoLimitado(f.stream, null, MAX_CORPO_RECEPTOR_BYTES);
    expect(r).toEqual({ tipo: 'grande', bytes: MAX_CORPO_RECEPTOR_BYTES + 1 });
    expect(f.puxados()).toBe(5);
    expect(f.cancelado()).toBe(true);
  });

  it('a declared content-length over the bound is refused with ZERO chunks read', async () => {
    const f = fluxoEspiao(['{}']);
    const r = await lerCorpoLimitado(
      f.stream,
      String(MAX_CORPO_RECEPTOR_BYTES + 1),
      MAX_CORPO_RECEPTOR_BYTES,
    );
    expect(r).toEqual({ tipo: 'grande', bytes: MAX_CORPO_RECEPTOR_BYTES + 1 });
    expect(f.puxados()).toBe(0);
    expect(f.cancelado()).toBe(true);
  });

  // The whitespace row sits ABOVE the bound, so a parser that accepted it would refuse.
  it.each(['abc', '-1', '1e9', ` ${String(MAX_CORPO_RECEPTOR_BYTES + 1)}`, ''])(
    'an unparseable content-length (%j) is ignored: the count decides',
    async (cabecalho) => {
      const f = fluxoEspiao(['{}']);
      const r = await lerCorpoLimitado(f.stream, cabecalho, MAX_CORPO_RECEPTOR_BYTES);
      expect(r).toMatchObject({ tipo: 'lido', bytes: 2 });
    },
  );

  it('a lying content-length (small) cannot stretch the bound: the count still stops it', async () => {
    const f = fluxoEspiao([new Uint8Array(8), new Uint8Array(8)]);
    const r = await lerCorpoLimitado(f.stream, '4', 10);
    expect(r).toEqual({ tipo: 'grande', bytes: 16 });
    expect(f.cancelado()).toBe(true);
  });

  it('a stream error propagates (the caller answers 5xx)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controle) {
        controle.error(new TypeError('conexão encerrada'));
      },
    });
    await expect(lerCorpoLimitado(stream, null, 10)).rejects.toBeInstanceOf(TypeError);
  });
});
