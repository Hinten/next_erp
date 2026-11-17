import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODIGO_ERRO_ETIQUETA_AMAZON,
  INTEGRACAO_FRETE,
  MOTIVO_ETIQUETA_AMAZON,
} from '@delfrance/schemas';

import { criarClienteAmazon, type AmazonClient, type EtiquetaAmazon } from '@/lib/amazon/client';
import {
  AmazonBackendError,
  AmazonRedeError,
  MENSAGEM_ETIQUETA_AMAZON_AGUARDE,
  MENSAGENS_MOTIVO_ETIQUETA_AMAZON,
} from '@/lib/amazon/erros';
import { printJob } from '@/lib/print-agent/printJob';
import { amazonClientFalso } from '@/lib/testing/amazonClientFalso';

import {
  AVISO_SO_ZPL_AMAZON,
  MENSAGEM_DEMORA_ETIQUETA_AMAZON,
  MENSAGEM_REDE_ETIQUETA_AMAZON,
  MENSAGEM_SEM_CLIENTE_AMAZON,
  PRAZO_ETIQUETA_AMAZON_MS,
  amazonProvider,
  createAmazonProvider,
} from './amazon';
import type { EtiquetaProviderInput } from '../types';

/* -------------------------------- fixtures -------------------------------- */

const PEDIDO_ID = 'cd'.repeat(32);
const NOME = 'amazon-111-2222222-3333333.zpl';

/** A ZPL label with a byte that is NOT valid UTF-8 (0xFF) and a two-byte `ç`. */
const ZPL = new Uint8Array([
  ...new TextEncoder().encode('^XA^FO50,50^FDCaixa '),
  0xff,
  0xc3,
  0xa7,
  ...new TextEncoder().encode('^FS^XZ\n'),
]);

/** "Try again" in any spelling — never after a timeout, a 5xx, a cut call or a network failure. */
const TENTE_DE_NOVO = /tente|novamente|de novo/i;

function etiqueta(over: Partial<EtiquetaAmazon> = {}): EtiquetaAmazon {
  return { bytes: new Blob([ZPL]), nomeArquivo: NOME, tipo: 'text/plain', ...over };
}

/**
 * An object every read of which THROWS: handed in as `frete` and `intFrete`, it
 * proves the provider never reads them (a migrated pedido may carry an
 * incomplete freight reference; the route resolves everything from the pedido).
 */
function intocavel(nome: string): never {
  return new Proxy(
    {},
    {
      get(_alvo, chave) {
        throw new Error(`${nome}.${String(chave)} foi lido`);
      },
    },
  ) as never;
}

function makeInput(over: {
  client: AmazonClient | null;
  formato?: 'pdf' | 'zpl2';
  printJob?: EtiquetaProviderInput['deps']['printJob'];
  notify?: EtiquetaProviderInput['ui']['notify'];
}): EtiquetaProviderInput {
  return {
    db: {} as never,
    pedido: { numero: '1234' } as never,
    pedidoId: PEDIDO_ID,
    frete: intocavel('frete'),
    intFrete: intocavel('intFrete'),
    formato: over.formato ?? 'zpl2',
    deps: {
      freightClient: null,
      nfeClient: null,
      mercadoLivreClient: null,
      shopeeClient: null,
      lojaIntegradaClient: null,
      amazonClient: over.client,
      printJob: over.printJob ?? vi.fn(async () => 'printed' as const),
    },
    ui: {
      confirmRisk: vi.fn(async () => true),
      notify: over.notify ?? vi.fn(),
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
      escolherEnvio: vi.fn(async () => null),
      confirmarCiente: vi.fn(),
    },
  };
}

/** The print agent at `localhost:8888`, faked: what the REAL `printJob` POSTs to it. */
function agenteFalso() {
  const pedidos: {
    docName: string;
    docDataBase64: string;
    contentType: string;
    tamanhoFolhaImpressao: string;
  }[] = [];
  const agente = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    pedidos.push(JSON.parse(String(init?.body)) as (typeof pedidos)[number]);
    return new Response(null, { status: 200 });
  });
  const viaAgente: EtiquetaProviderInput['deps']['printJob'] = (blob, opts) =>
    printJob(blob, opts, { fetch: agente, saveBlob: vi.fn() });
  return { pedidos, viaAgente };
}

function decodificar(base64: string): number[] {
  return [...Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))];
}

/** The REAL client over a scripted backend `fetch` (D11: nothing leaves the test). */
function clienteReal(responder: () => Response | Promise<Response>): AmazonClient {
  return criarClienteAmazon(
    'https://amazon.backend.test',
    async () => 'id-token',
    async () => responder(),
  );
}

function rotulo(tipo = 'text/plain'): Response {
  return new Response(ZPL, {
    status: 200,
    headers: { 'content-type': tipo, 'content-disposition': `attachment; filename="${NOME}"` },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ------------------------------ what it declares ------------------------------ */

describe('amazonProvider — what it declares', () => {
  it('claims exactly the `amz` tipo', () => {
    expect(amazonProvider.tipos).toEqual([INTEGRACAO_FRETE.amazon]);
    expect(amazonProvider.tipos).toEqual(['amz']);
  });

  it('declares `reimpressao: mesmo-documento` (a reprint is the same schedule’s label)', () => {
    expect(amazonProvider.reimpressao).toBe('mesmo-documento');
  });

  it('the deadline is the backend ceiling (300 s) plus the 60-s margin', () => {
    expect(PRAZO_ETIQUETA_AMAZON_MS.longo).toBe(360_000);
  });
});

/* ------------------------------- the print path ------------------------------- */

describe('the label reaches the print agent as ZPL, byte for byte', () => {
  it('⭐ the agent gets EXACTLY text/plain even when the answer says text/plain;charset=UTF-8', async () => {
    const { pedidos, viaAgente } = agenteFalso();
    const input = makeInput({
      client: clienteReal(() => rotulo('text/plain;charset=UTF-8')),
      printJob: viaAgente,
    });

    expect(await amazonProvider.emitirOuImprimir(input)).toEqual({ status: 'printed' });

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.contentType).toBe('text/plain');
    expect(pedidos[0]?.tamanhoFolhaImpressao).toBe('etq');
    expect(pedidos[0]?.docName).toBe(NOME);
  });

  it('⭐ the bytes the agent decodes are the server’s exact bytes, the non-UTF-8 one included', async () => {
    const { pedidos, viaAgente } = agenteFalso();
    const input = makeInput({ client: clienteReal(() => rotulo()), printJob: viaAgente });

    await amazonProvider.emitirOuImprimir(input);

    const recebidos = decodificar(pedidos[0]?.docDataBase64 ?? '');
    expect(recebidos).toContain(0xff);
    expect(recebidos).toEqual([...ZPL]);
  });

  it('NEAR-MISS: the same label through a text() round trip would NOT be the same bytes', async () => {
    const { pedidos, viaAgente } = agenteFalso();
    const viaTexto = new Blob([await rotulo().text()]);

    await viaAgente(viaTexto, { fileName: NOME, contentType: 'text/plain', tamanho: 'etq' });

    expect(decodificar(pedidos[0]?.docDataBase64 ?? '')).not.toEqual([...ZPL]);
  });

  it('⭐ formato `pdf` gives the ZPL-only notice and STILL a ZPL job on the label sheet', async () => {
    const notify = vi.fn();
    const imprimir = vi.fn(async () => 'printed' as const);
    const input = makeInput({
      client: amazonClientFalso({ etiqueta: vi.fn(async () => etiqueta()) }),
      formato: 'pdf',
      printJob: imprimir,
      notify,
    });

    expect(await amazonProvider.emitirOuImprimir(input)).toEqual({ status: 'printed' });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: AVISO_SO_ZPL_AMAZON, color: 'yellow' }),
    );
    expect(imprimir).toHaveBeenCalledWith(expect.any(Blob), {
      fileName: NOME,
      contentType: 'text/plain',
      tamanho: 'etq',
    });
  });

  it('NEAR-MISS: formato `zpl2` prints with NO notice', async () => {
    const notify = vi.fn();
    const input = makeInput({
      client: amazonClientFalso({ etiqueta: vi.fn(async () => etiqueta()) }),
      formato: 'zpl2',
      notify,
    });

    expect(await amazonProvider.emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('asks for the label by the pedido id, with a signal — and nothing else', async () => {
    const pedir = vi.fn(async () => etiqueta());
    await amazonProvider.emitirOuImprimir(
      makeInput({ client: amazonClientFalso({ etiqueta: pedir }) }),
    );

    expect(pedir).toHaveBeenCalledTimes(1);
    expect(pedir).toHaveBeenCalledWith(PEDIDO_ID, { signal: expect.any(AbortSignal) });
  });

  it('the agent down (printJob answers downloaded): the notice names the file and says it goes to the Zebra', async () => {
    const notify = vi.fn();
    const input = makeInput({
      client: amazonClientFalso({ etiqueta: vi.fn(async () => etiqueta()) }),
      printJob: vi.fn(async () => 'downloaded' as const),
      notify,
    });

    expect(await amazonProvider.emitirOuImprimir(input)).toEqual({ status: 'printed' });
    const [aviso] = notify.mock.calls.map((c) => (c[0] as { message: string }).message);
    expect(aviso).toContain(NOME);
    expect(aviso).toContain('Zebra');
  });

  it('a label that is not text/plain (the client refuses one) is DOWNLOADED, never sent to the agent', async () => {
    const salvarArquivo = vi.fn();
    const imprimir = vi.fn(async () => 'printed' as const);
    const notify = vi.fn();
    const provider = createAmazonProvider({ salvarArquivo });
    const input = makeInput({
      client: amazonClientFalso({
        etiqueta: vi.fn(async () => etiqueta({ tipo: 'application/pdf' })),
      }),
      printJob: imprimir,
      notify,
    });

    expect(await provider.emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(imprimir).not.toHaveBeenCalled();
    expect(salvarArquivo).toHaveBeenCalledWith(expect.any(Blob), NOME);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'yellow' }));
  });

  it('never reads `frete` or `intFrete` (both throw on any read here)', async () => {
    const input = makeInput({
      client: amazonClientFalso({ etiqueta: vi.fn(async () => etiqueta()) }),
    });

    await expect(amazonProvider.emitirOuImprimir(input)).resolves.toEqual({ status: 'printed' });
  });
});

/* -------------------------------- the failures -------------------------------- */

describe('the failures, each with its sentence', () => {
  it('a null client answers its own error with no call and no print', async () => {
    const imprimir = vi.fn();
    const out = await amazonProvider.emitirOuImprimir(
      makeInput({ client: null, printJob: imprimir }),
    );

    expect(out).toEqual({
      status: 'error',
      message:
        'O ERP não conseguiu falar com o backend da Amazon nesta página (sessão expirada ou ' +
        'endereço do backend não configurado). Recarregue a página; se continuar, imprima a ' +
        'etiqueta pela Seller Central e avise o suporte.',
    });
    expect(MENSAGEM_SEM_CLIENTE_AMAZON).not.toMatch(TENTE_DE_NOVO);
    expect(imprimir).not.toHaveBeenCalled();
  });

  it('⭐ a NAO_ELEGIVEL envelope built through the REAL client shows the motivo’s sentence', async () => {
    const imprimir = vi.fn();
    const client = clienteReal(
      () =>
        new Response(
          JSON.stringify({
            error: 'A etiqueta deste pedido não pode ser impressa agora.',
            code: CODIGO_ERRO_ETIQUETA_AMAZON.NAO_ELEGIVEL,
            motivo: MOTIVO_ETIQUETA_AMAZON.nfeSubstituta,
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
    );

    const out = await amazonProvider.emitirOuImprimir(makeInput({ client, printJob: imprimir }));

    expect(out).toEqual({
      status: 'error',
      message: MENSAGENS_MOTIVO_ETIQUETA_AMAZON[MOTIVO_ETIQUETA_AMAZON.nfeSubstituta],
    });
    expect(out.status === 'error' && out.message).toContain('agende a coleta na Seller Central');
    expect(imprimir).not.toHaveBeenCalled();
  });

  it('⚠️ a codeless platform 500 through the REAL client asks for the wait, never "novamente"', async () => {
    const client = clienteReal(
      () =>
        new Response('<html>Internal</html>', {
          status: 500,
          headers: { 'content-type': 'text/html' },
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const out = await amazonProvider.emitirOuImprimir(makeInput({ client }));

    expect(out).toEqual({ status: 'error', message: MENSAGEM_ETIQUETA_AMAZON_AGUARDE });
    expect(out.status === 'error' && out.message).not.toMatch(TENTE_DE_NOVO);
  });

  it('a 503 AMAZON_INDISPONIVEL asks for the wait', async () => {
    const client = amazonClientFalso({
      etiqueta: vi.fn(() =>
        Promise.reject(
          new AmazonBackendError('x', 503, CODIGO_ERRO_ETIQUETA_AMAZON.AMAZON_INDISPONIVEL),
        ),
      ),
    });

    const out = await amazonProvider.emitirOuImprimir(makeInput({ client }));

    expect(out).toEqual({ status: 'error', message: MENSAGEM_ETIQUETA_AMAZON_AGUARDE });
  });

  it('a network failure asks for the same wait (the call may have reached Amazon)', async () => {
    const client = amazonClientFalso({
      etiqueta: vi.fn(() => Promise.reject(new AmazonRedeError(new TypeError('x')))),
    });

    const out = await amazonProvider.emitirOuImprimir(makeInput({ client }));

    expect(out).toEqual({ status: 'error', message: MENSAGEM_REDE_ETIQUETA_AMAZON });
    expect(MENSAGEM_REDE_ETIQUETA_AMAZON).toMatch(/aguarde cerca de 1 minuto/i);
    expect(MENSAGEM_REDE_ETIQUETA_AMAZON).not.toMatch(TENTE_DE_NOVO);
  });

  it('anything else propagates (rule 6), and nothing is printed', async () => {
    const outro = new RangeError('outra coisa');
    const imprimir = vi.fn();
    const client = amazonClientFalso({ etiqueta: vi.fn(() => Promise.reject(outro)) });

    await expect(
      amazonProvider.emitirOuImprimir(makeInput({ client, printJob: imprimir })),
    ).rejects.toBe(outro);
    expect(imprimir).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: an AbortError the provider did NOT cause is not its timeout — it propagates', async () => {
    const alheio = new DOMException('alheio', 'AbortError');
    const client = amazonClientFalso({ etiqueta: vi.fn(() => Promise.reject(alheio)) });

    await expect(amazonProvider.emitirOuImprimir(makeInput({ client }))).rejects.toBe(alheio);
  });
});

/* -------------------------------- the deadline -------------------------------- */

describe('the deadline outlasts the backend (PRAZO_ETIQUETA_AMAZON_MS)', () => {
  /**
   * A label call that never answers on its own: it rejects only when its signal
   * aborts — with the abort itself unless the test names another rejection.
   */
  function pendurado(rejeicao?: () => unknown) {
    let sinal: AbortSignal | undefined;
    const pedir = vi.fn(
      (_pedidoId: string, opts?: { readonly signal?: AbortSignal }) =>
        new Promise<EtiquetaAmazon>((_resolve, reject) => {
          sinal = opts?.signal;
          opts?.signal?.addEventListener('abort', () => {
            reject(rejeicao === undefined ? opts.signal?.reason : rejeicao());
          });
        }),
    );
    return { pedir, sinal: () => sinal };
  }

  it.each([
    ['a bare TypeError', () => new TypeError('terminated')],
    ['an AmazonRedeError', () => new AmazonRedeError(new TypeError('terminated'))],
  ])(
    'after its OWN deadline, %s from the call still reads as the timeout (never propagates)',
    async (_forma, rejeicao) => {
      vi.useFakeTimers();
      const { pedir } = pendurado(rejeicao);
      const resultado = amazonProvider.emitirOuImprimir(
        makeInput({ client: amazonClientFalso({ etiqueta: pedir }) }),
      );

      await vi.advanceTimersByTimeAsync(PRAZO_ETIQUETA_AMAZON_MS.longo);

      await expect(resultado).resolves.toEqual({
        status: 'error',
        message: MENSAGEM_DEMORA_ETIQUETA_AMAZON,
      });
    },
  );

  it('NEAR-MISS: after its OWN deadline, a bug-shaped rejection (RangeError) still propagates (rule 6), never the timeout copy', async () => {
    vi.useFakeTimers();
    const bug = new RangeError('bug');
    const { pedir } = pendurado(() => bug);
    const resultado = amazonProvider.emitirOuImprimir(
      makeInput({ client: amazonClientFalso({ etiqueta: pedir }) }),
    );
    // Attached BEFORE the deadline fires, so the rejection is never unhandled.
    const verificacao = expect(resultado).rejects.toBe(bug);

    await vi.advanceTimersByTimeAsync(PRAZO_ETIQUETA_AMAZON_MS.longo);

    await verificacao;
  });

  it('⭐ does NOT abort at the route’s 240-s worst case nor at the 300-s ceiling, and aborts at 360 s with the wait sentence', async () => {
    vi.useFakeTimers();
    const { pedir, sinal } = pendurado();
    const imprimir = vi.fn();
    let resultado: unknown = 'pendente';
    void amazonProvider
      .emitirOuImprimir(
        makeInput({ client: amazonClientFalso({ etiqueta: pedir }), printJob: imprimir }),
      )
      .then((r) => {
        resultado = r;
      });

    await vi.advanceTimersByTimeAsync(240_000);
    expect(sinal()?.aborted).toBe(false);
    expect(resultado).toBe('pendente');

    await vi.advanceTimersByTimeAsync(60_000 + 59_999); // 359.999 s
    expect(sinal()?.aborted).toBe(false);
    expect(resultado).toBe('pendente');

    await vi.advanceTimersByTimeAsync(1);
    expect(sinal()?.aborted).toBe(true);
    expect(resultado).toEqual({ status: 'error', message: MENSAGEM_DEMORA_ETIQUETA_AMAZON });
    expect(imprimir).not.toHaveBeenCalled();
  });

  it('the timeout sentence and the AMAZON_INDISPONIVEL one both say "aguarde", neither "tente de novo"', () => {
    for (const frase of [MENSAGEM_DEMORA_ETIQUETA_AMAZON, MENSAGEM_ETIQUETA_AMAZON_AGUARDE]) {
      expect(frase).toMatch(/aguarde cerca de 1 minuto/i);
      expect(frase).toContain('reimprima pela lista de pedidos');
      expect(frase).not.toMatch(TENTE_DE_NOVO);
    }
  });

  it('a label that answers in time clears the timer: nothing is left pending', async () => {
    vi.useFakeTimers();
    const client = amazonClientFalso({ etiqueta: vi.fn(async () => etiqueta()) });

    await amazonProvider.emitirOuImprimir(makeInput({ client }));

    expect(vi.getTimerCount()).toBe(0);
  });
});
