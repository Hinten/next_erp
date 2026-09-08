import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { ZodError, z } from 'zod';

/**
 * Mocked: the admin Firestore handle, the Cloud Tasks scheduler and the channel
 * adapter (whose `parseNotificationBody` has its own suite — here it is a seam,
 * so the ladder can be driven exit by exit). The SIGNATURE verifier runs REAL:
 * every 401/503 below is produced by the same code a live push meets.
 */
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_p: unknown) => {}),
  persist: vi.fn(async () => {}),
  parse: vi.fn((raw: unknown) => raw as Record<string, unknown> | null),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({ __db: true }) }));

vi.mock('@/lib/shopee/shopeeTasks', () => ({
  createShopeeTaskScheduler: () => ({ enqueue: h.enqueue }),
}));

vi.mock('@/lib/shopee/notificacoes/notificacao', () => ({
  parseNotificationBody: (raw: unknown) => h.parse(raw),
  persistNotificationFailure: (...args: unknown[]) => h.persist(...(args as [])),
}));

const { POST, __resetContadorDeEntregasParaTestes } = await import('./route');

/** Invented — never a real credential. */
const CHAVE = 'chave-de-teste-nao-e-credencial';
const CALLBACK = 'https://erp.example/api/webhooks/shopee';

const CORPO = '{"code":1,"timestamp":1660616278,"data":{"shop_id":987654}}';
const PAYLOAD = {
  code: 1,
  shopId: 987654,
  timestamp: 1_660_616_278_000,
  data: { shop_id: 987654 },
};

function assinar(body: string, url = CALLBACK, chave = CHAVE): string {
  return createHmac('sha256', chave).update(`${url}|${body}`, 'utf8').digest('hex');
}

function push(body: string, header: string | null = assinar(body)): Request {
  return new Request(CALLBACK, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      ...(header == null ? {} : { authorization: header }),
    },
  });
}

/** A 2xx answer must carry a ZERO-LENGTH body, or Shopee counts it as FAILED. */
async function esperarCorpoVazio(res: Response): Promise<void> {
  expect(res.body).toBeNull();
  expect(await res.text()).toBe('');
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetContadorDeEntregasParaTestes();
  h.parse.mockImplementation(() => PAYLOAD);
  vi.stubEnv('SHOPEE_PARTNER_ID', '1000001');
  vi.stubEnv('SHOPEE_PARTNER_KEY', CHAVE);
  vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', CALLBACK);
  vi.stubEnv('SHOPEE_SANDBOX', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/shopee — o caminho feliz', () => {
  it('responde 204 e enfileira o payload', async () => {
    const res = await POST(push(CORPO));
    expect(res.status).toBe(204);
    await esperarCorpoVazio(res);
    expect(h.enqueue).toHaveBeenCalledWith(PAYLOAD);
    expect(h.persist).not.toHaveBeenCalled();
  });

  // ⚠️ O corpo entra no HMAC byte a byte. Um `JSON.stringify(JSON.parse(raw))`
  // mudaria espaços e ordem de chaves e quebraria a verificação — este corpo
  // tem espaçamento que nenhum re-serializador reproduziria.
  it('verifica os bytes EXATOS recebidos, sem re-serializar', async () => {
    const cru = '{ "code" : 1 ,  "timestamp":1660616278 }';
    const res = await POST(push(cru));
    expect(res.status).toBe(204);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('um corpo vazio ainda é verificado e acked', async () => {
    const res = await POST(push(''));
    expect(res.status).toBe(204);
    await esperarCorpoVazio(res);
  });
});

describe('as três saídas 2xx respondem corpo VAZIO', () => {
  it('feliz', async () => {
    await esperarCorpoVazio(await POST(push(CORPO)));
  });

  it('body não-parseável (SyntaxError)', async () => {
    const res = await POST(push('nao é json'));
    expect(res.status).toBe(204);
    await esperarCorpoVazio(res);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('envelope sem push_code (parse devolve null)', async () => {
    h.parse.mockReturnValue(null);
    const res = await POST(push('{"sem":"code"}'));
    expect(res.status).toBe(204);
    await esperarCorpoVazio(res);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });
});

describe('a porta da assinatura', () => {
  it('assinatura errada ⇒ 401, ZERO enqueues e ZERO escritas', async () => {
    const res = await POST(push(CORPO, assinar('{"code":2}')));
    expect(res.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.parse).not.toHaveBeenCalled();
  });

  it('header ausente ⇒ 401', async () => {
    const res = await POST(push(CORPO, null));
    expect(res.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('assinatura de outra chave ⇒ 401', async () => {
    const res = await POST(push(CORPO, assinar(CORPO, CALLBACK, 'outra-chave-de-teste')));
    expect(res.status).toBe(401);
  });

  // ⚠️ A URL configurada entra byte a byte na base string. Uma barra final a
  // mais na configuração muda o dígito e reprova um push legítimo — é por isso
  // que `shopeePushCallbackUrl()` não normaliza, e é isso que o log das
  // primeiras entregas existe para revelar em produção.
  it('uma barra final na URL configurada muda o dígito ⇒ 401', async () => {
    vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', `${CALLBACK}/`);
    const res = await POST(push(CORPO, assinar(CORPO, CALLBACK)));
    expect(res.status).toBe(401);

    // …e o push assinado COM a barra passa, provando que só a URL mudou.
    const ok = await POST(push(CORPO, assinar(CORPO, `${CALLBACK}/`)));
    expect(ok.status).toBe(204);
  });

  it('SHOPEE_PARTNER_KEY ausente ⇒ 503, sem enfileirar', async () => {
    vi.stubEnv('SHOPEE_PARTNER_KEY', '');
    const res = await POST(push(CORPO));
    expect(res.status).toBe(503);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('SHOPEE_PUSH_CALLBACK_URL ausente ⇒ 503, sem enfileirar', async () => {
    vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', '');
    const res = await POST(push(CORPO));
    expect(res.status).toBe(503);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('503 vence 401: não configurado responde 503 mesmo sem header', async () => {
    vi.stubEnv('SHOPEE_PARTNER_KEY', '   ');
    const res = await POST(push(CORPO, null));
    expect(res.status).toBe(503);
  });
});

describe('falha de enqueue', () => {
  it('persiste para o sweep e AINDA responde 204', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('SHOPEE_TASKS_DISABLED=1'));
    const res = await POST(push(CORPO));
    expect(res.status).toBe(204);
    await esperarCorpoVazio(res);
    expect(h.persist).toHaveBeenCalledTimes(1);
    const [, payload, erro] = h.persist.mock.calls[0]! as unknown as [unknown, unknown, string];
    expect(payload).toEqual(PAYLOAD);
    expect(erro).toContain('enqueue falhou');
  });

  it('um ZodError no persist é descartado (204), não um 5xx', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('transporte fora do ar'));
    h.persist.mockRejectedValueOnce(new ZodError([]));
    const res = await POST(push(CORPO));
    expect(res.status).toBe(204);
    await esperarCorpoVazio(res);
  });

  // ⚠️ A ÚNICA saída não-2xx do caminho de persistência. Um erro transitório do
  // Firestore é genuinamente retentável, e a Shopee reentrega em +5 min.
  it('um erro transitório no persist é RELANÇADO (5xx ⇒ reentrega)', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('transporte fora do ar'));
    const transitorio = new Error('14 UNAVAILABLE');
    h.persist.mockRejectedValueOnce(transitorio);
    await expect(POST(push(CORPO))).rejects.toBe(transitorio);
  });

  it('um ZodError real produzido por um schema também é descartado', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('transporte fora do ar'));
    const real = z.object({ code: z.number() }).safeParse({ code: 'x' });
    h.persist.mockRejectedValueOnce(real.error);
    const res = await POST(push(CORPO));
    expect(res.status).toBe(204);
  });
});

describe('o log das primeiras entregas', () => {
  /** Só as linhas do log de entrega — o 401 e o body ilegível também usam warn. */
  function entregas(spy: { mock: { calls: unknown[][] } }): [string, Record<string, unknown>][] {
    return spy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('entrega recebida'),
    ) as unknown as [string, Record<string, unknown>][];
  }

  it('registra URL configurada vs recebida e no MÁXIMO 8 caracteres de cada dígito', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const header = assinar(CORPO);
    await POST(push(CORPO, header));

    expect(entregas(warnSpy)).toHaveLength(1);
    const [, meta] = entregas(warnSpy)[0]!;
    expect(meta.urlConfigurada).toBe(CALLBACK);
    expect(meta.urlRecebida).toBe(CALLBACK);
    expect(meta.assinaturaOk).toBe(true);
    expect(meta.bytes).toBe(CORPO.length);
    expect(String(meta.digestRecebido)).toHaveLength(8);
    expect(String(meta.digestEsperado)).toHaveLength(8);

    // ⚠️ Nem o corpo, nem o header inteiro, nem a chave.
    const serializado = JSON.stringify(entregas(warnSpy)[0]);
    expect(serializado).not.toContain('987654');
    expect(serializado).not.toContain(header);
    expect(serializado).not.toContain(CHAVE);
  });

  it('para de registrar depois de 5 entregas válidas', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 7; i += 1) await POST(push(CORPO));
    expect(entregas(warnSpy)).toHaveLength(5);
  });

  // Um descasamento é sempre registrado — é exatamente nele que a resposta
  // sobre QUAL URL a Shopee assina está escondida.
  it('registra TODO descasamento, mesmo depois do limite', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 5; i += 1) await POST(push(CORPO));
    warnSpy.mockClear();
    await POST(push(CORPO, assinar('{"outro":1}')));
    expect(entregas(warnSpy)).toHaveLength(1);
    const [, meta] = entregas(warnSpy)[0]!;
    expect(meta.assinaturaOk).toBe(false);
  });
});
