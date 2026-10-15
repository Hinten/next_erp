import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { MissingRegionError } from '@delfrance/core/region';

import { erroContidoPorConta } from '../core/containment';
import { ShopeeStockTasksDisabledError } from '../estoque/errosEstoque';
import { ShopeePriceSyncTasksDisabledError } from '../precos/errosPreco';
import { ShopeeTasksDisabledError } from '../shopeeTasks';
import { ATRASO_SERPRO_S, SHOPEE_NFE_UPLOAD_QUEUE } from './constantesNfe';
import { ShopeeNfeUploadTasksDisabledError } from './errosNfe';
import type { TarefaNfeShopee } from './tarefaNfe';

/**
 * Mocked: the transport seams (the Functions SDK's queue/enqueue and the admin
 * app binding) only — `../precos/shopeePriceSyncTasks.test.ts`'s shape.
 *
 * ⚠️ `../shopeeTasks` is mocked PARTIALLY, on purpose: `shopeeTasksRegion` stays
 * the real one (the region wiring is what three of these tests are about) and
 * only the valve can be forced, so the "one reader" claim is testable without
 * neutralising anything else. `./constantesNfe` and `./tarefaNfe` are NOT
 * mocked — the queue name is the half of the rename trap that lives on this
 * side, and the schema is the dispatcher's own, so a mocked copy of either
 * would pin nothing.
 */
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (..._args: unknown[]) => {}),
  taskQueue: vi.fn(),
  getFunctions: vi.fn(),
  /** `null` ⇒ defer to the REAL env-driven reader. */
  valvula: vi.fn((): boolean | null => null),
}));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: (...args: unknown[]) => {
    h.getFunctions(...args);
    return { taskQueue: h.taskQueue };
  },
}));

vi.mock('../../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

vi.mock('../shopeeTasks', async () => {
  const real = await vi.importActual<typeof import('../shopeeTasks')>('../shopeeTasks');
  return {
    ...real,
    shopeeTasksDesabilitado: (): boolean => h.valvula() ?? real.shopeeTasksDesabilitado(),
  };
});

const { createShopeeNfeUploadScheduler } = await import('./shopeeNfeUploadTasks');

const FONTE = readFileSync(
  fileURLToPath(new URL('./shopeeNfeUploadTasks.ts', import.meta.url)),
  'utf8',
);

/** The trigger's first enqueue — fixture ids only; no conta, order number or key. */
const payload: TarefaNfeShopee = {
  pedidoId: 'pedido-1',
  nfeId: 'nfe-1',
  fase: 'envio',
  adiamentosSerpro: 0,
  pausas: 0,
  reverificacoes: 0,
};

/** The argument list the LAST transport enqueue actually received. */
function ultimosArgumentos(): unknown[] {
  const chamada = h.enqueue.mock.calls.at(-1);
  expect(chamada).toBeDefined();
  return chamada ?? [];
}

/** A payload the TYPE forbids but a careless producer could still build. */
function invalida(parcial: Record<string, unknown>): TarefaNfeShopee {
  return { ...payload, ...parcial } as unknown as TarefaNfeShopee;
}

/** Enqueue and hand back whatever it rejected with (`null` when it resolved). */
async function capturar(p: Promise<void>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/**
 * Valve open. `semRegiao` UNSETS `SHOPEE_TASKS_REGION` — a flag rather than an
 * `undefined` argument, because a default parameter would silently turn an
 * explicit `undefined` back into the region.
 */
function valvulaAberta({ semRegiao = false }: { semRegiao?: boolean } = {}): void {
  vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
  vi.stubEnv('SHOPEE_TASKS_REGION', semRegiao ? undefined : 'us-east1');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.valvula.mockReturnValue(null);
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createShopeeNfeUploadScheduler — a fila', () => {
  it('1 — usa o nome da fila qualificado pela região, e o nome é o da QUINTA fila', async () => {
    valvulaAberta();

    await createShopeeNfeUploadScheduler().enqueue(payload);

    // A string INTEIRA, literal: o nome da fila é metade de uma armadilha de
    // rename cuja outra metade é o nome EXPORTADO da função implantada — um
    // rename pela metade enfileira numa fila que ninguém drena.
    expect(h.taskQueue).toHaveBeenCalledWith('locations/us-east1/functions/processShopeeNfeUpload');
    expect(SHOPEE_NFE_UPLOAD_QUEUE).toBe('processShopeeNfeUpload');
    expect(h.getFunctions).toHaveBeenCalledWith({ __app: true });
  });

  it('2 — cai para FUNCTIONS_REGION quando SHOPEE_TASKS_REGION não está posta', async () => {
    valvulaAberta({ semRegiao: true });
    vi.stubEnv('FUNCTIONS_REGION', 'southamerica-east1');

    await createShopeeNfeUploadScheduler().enqueue(payload);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/processShopeeNfeUpload',
    );
  });

  it('3 — região ausente LANÇA no primeiro enqueue, não antes, e NUNCA assume um padrão', async () => {
    valvulaAberta({ semRegiao: true });
    vi.stubEnv('FUNCTIONS_REGION', undefined);

    // Construir o scheduler não lê região nenhuma…
    const agendador = createShopeeNfeUploadScheduler();
    expect(h.taskQueue).not.toHaveBeenCalled();

    // …e a recusa acontece ANTES de qualquer chamada de transporte: sem default
    // deliberadamente, porque o Admin SDK resolveria a região dele, a tarefa
    // seria descartada em silêncio e quem enfileirou veria sucesso (#1108).
    await expect(agendador.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe('createShopeeNfeUploadScheduler — o atraso', () => {
  it('4 — PAR: um atraso > 0 vai como opção, com o valor (a espera do SERPRO e a pausa)', async () => {
    valvulaAberta();
    const agendador = createShopeeNfeUploadScheduler();

    // A espera do SERPRO que o gatilho sempre pede…
    await agendador.enqueue(payload, { scheduleDelaySeconds: ATRASO_SERPRO_S });
    expect(ultimosArgumentos()).toEqual([payload, { scheduleDelaySeconds: 360 }]);

    // …e o degrau de uma reverificação.
    await agendador.enqueue(payload, { scheduleDelaySeconds: 900 });
    expect(ultimosArgumentos()).toEqual([payload, { scheduleDelaySeconds: 900 }]);
  });

  it('5 — IGUAIS a "agora": sem opções, `{}`, 0 e negativo OMITEM o objeto de opções inteiro', async () => {
    valvulaAberta();
    const agendador = createShopeeNfeUploadScheduler();

    // ⛔ O objeto fica OMITIDO — a chamada ao transporte tem UM argumento só.
    // `toHaveBeenCalledWith` compara como `toEqual` e ignora chaves undefined,
    // então `{ scheduleDelaySeconds: undefined }` passaria por `{}`; o que mata o
    // mutante "o scheduler manda `undefined`" é o COMPRIMENTO da lista.
    await agendador.enqueue(payload);
    expect(ultimosArgumentos()).toHaveLength(1);

    await agendador.enqueue(payload, {});
    expect(ultimosArgumentos()).toHaveLength(1);

    // Zero é uma entrada real: o ajudante da espera do SERPRO devolve 0 para uma
    // NF-e autorizada há mais tempo que a espera — e zero segundos é "agora".
    await agendador.enqueue(payload, { scheduleDelaySeconds: 0 });
    expect(ultimosArgumentos()).toHaveLength(1);

    await agendador.enqueue(payload, { scheduleDelaySeconds: -5 });
    expect(ultimosArgumentos()).toHaveLength(1);

    expect(h.enqueue).toHaveBeenCalledTimes(4);
  });

  it('6 — QUASE-IGUAL: 1 segundo NÃO é "agora" — a opção vai, e vai com o valor', async () => {
    valvulaAberta();

    // O vizinho inteiro mais próximo do zero precisa atravessar: um `> 0`
    // apertado para `> 1` (ou para "pelo menos a espera do SERPRO") falharia
    // aqui. O lado de baixo — um `if (atraso)` que deixaria passar o negativo —
    // é o caso -5 do teste 5.
    await createShopeeNfeUploadScheduler().enqueue(payload, { scheduleDelaySeconds: 1 });
    expect(ultimosArgumentos()).toEqual([payload, { scheduleDelaySeconds: 1 }]);
  });
});

describe('createShopeeNfeUploadScheduler — a carga', () => {
  it('7 — PAR: a carga que vai para a fila é IGUAL à validada, com os padrões aplicados', async () => {
    valvulaAberta();
    const agendador = createShopeeNfeUploadScheduler();

    await agendador.enqueue(payload);
    expect(ultimosArgumentos()[0]).toEqual(payload);

    // Uma carga completa de reverificação atravessa igual…
    const reverificacao: TarefaNfeShopee = {
      ...payload,
      fase: 'reverificacao',
      adiamentosSerpro: 2,
      pausas: 1,
      reverificacoes: 1,
    };
    await agendador.enqueue(reverificacao);
    expect(ultimosArgumentos()[0]).toEqual(reverificacao);

    // …e um produtor que omitiu os padrões (o tipo não deixa, um cast deixa)
    // sai com a SAÍDA do schema — exatamente o que o despachante aceita.
    await agendador.enqueue({ pedidoId: 'pedido-1', nfeId: 'nfe-1' } as TarefaNfeShopee);
    expect(ultimosArgumentos()[0]).toEqual(payload);
  });

  it.each([
    ['pedidoId vazio', { pedidoId: '' }],
    ['nfeId vazio', { nfeId: '' }],
    ['fase desconhecida', { fase: 'upload' }],
    ['contador negativo', { pausas: -1 }],
    ['contador fracionário', { reverificacoes: 0.5 }],
    ['chave a mais (o número do pedido no canal)', { orderSn: '260910KJBHUJDM' }],
    ['chave a mais (a conta)', { integracaoId: 'int-1' }],
  ])('8 — QUASE-IGUAL: %s é RECUSADO antes do transporte (ZodError)', async (_nome, parcial) => {
    valvulaAberta();

    const erro = await capturar(createShopeeNfeUploadScheduler().enqueue(invalida(parcial)));

    expect(erro).toBeInstanceOf(ZodError);
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('9 — a recusa nomeia CAMPOS, nunca VALORES (nada do que foi enviado volta na mensagem)', async () => {
    valvulaAberta();

    const erro = await capturar(
      createShopeeNfeUploadScheduler().enqueue(
        invalida({ fase: 'fase-marcadora-xyz', orderSn: '260910KJBHUJDM' }),
      ),
    );

    expect(erro).toBeInstanceOf(ZodError);
    const mensagem = (erro as ZodError).message;
    // ÂNCORA: a mensagem fala dos campos (sem isso a ausência abaixo seria vácua).
    expect(mensagem).toContain('fase');
    expect(mensagem).toContain('orderSn');
    expect(mensagem).not.toContain('fase-marcadora-xyz');
    expect(mensagem).not.toContain('260910KJBHUJDM');
  });

  it('10 — a validação vem ANTES da região: carga inválida sem região é ZodError, não MissingRegionError', async () => {
    valvulaAberta({ semRegiao: true });
    vi.stubEnv('FUNCTIONS_REGION', undefined);

    const erro = await capturar(
      createShopeeNfeUploadScheduler().enqueue(invalida({ pedidoId: '' })),
    );

    expect(erro).toBeInstanceOf(ZodError);
    expect(erro).not.toBeInstanceOf(MissingRegionError);
  });
});

describe('createShopeeNfeUploadScheduler — a válvula', () => {
  it('11 — SHOPEE_TASKS_DISABLED=1 devolve um scheduler que LANÇA a classe da NF-e, sem tocar no transporte', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    const agendador = createShopeeNfeUploadScheduler();

    await expect(agendador.enqueue(payload)).rejects.toBeInstanceOf(
      ShopeeNfeUploadTasksDisabledError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('12 — a válvula fechada LANÇA mesmo com um atraso pedido (a espera do SERPRO não escapa)', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await expect(
      createShopeeNfeUploadScheduler().enqueue(payload, { scheduleDelaySeconds: ATRASO_SERPRO_S }),
    ).rejects.toBeInstanceOf(ShopeeNfeUploadTasksDisabledError);
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('13 — a classe é a DA NF-e: nem a compartilhada (contida por conta), nem as irmãs', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');

    const capturado = await capturar(createShopeeNfeUploadScheduler().enqueue(payload));

    // A compartilhada está DENTRO de `erroContidoPorConta`: se fosse ela, a
    // válvula fechada poderia virar o `lastError` de uma conta em vez de chegar
    // ao aviso `tasks-desabilitadas` do gatilho ou ao 503 da rota.
    expect(capturado).toBeInstanceOf(ShopeeNfeUploadTasksDisabledError);
    expect(capturado).not.toBeInstanceOf(ShopeeTasksDisabledError);
    expect(erroContidoPorConta(capturado)).toBe(false);
    // As duas irmãs mais prováveis de uma cópia (o modelo deste arquivo e o do estoque).
    expect(capturado).not.toBeInstanceOf(ShopeePriceSyncTasksDisabledError);
    expect(capturado).not.toBeInstanceOf(ShopeeStockTasksDisabledError);
    expect(new ShopeeTasksDisabledError()).not.toBeInstanceOf(ShopeeNfeUploadTasksDisabledError);
    expect((capturado as Error).name).toBe('ShopeeNfeUploadTasksDisabledError');
    expect((capturado as Error).message).toContain('SHOPEE_TASKS_DISABLED');
  });

  it('14 — válvula fechada + carga inválida é ZodError: a válvula não esconde um produtor quebrado', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');

    const erro = await capturar(
      createShopeeNfeUploadScheduler().enqueue(invalida({ orderSn: '260910KJBHUJDM' })),
    );

    expect(erro).toBeInstanceOf(ZodError);
    expect(erro).not.toBeInstanceOf(ShopeeNfeUploadTasksDisabledError);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('15 — lê a válvula por shopeeTasksDesabilitado, não pela variável', async () => {
    // A variável está VAZIA e mesmo assim o scheduler recusa: o que decide é a
    // função, que é a ÚNICA leitora de SHOPEE_TASKS_DISABLED neste app.
    valvulaAberta();
    h.valvula.mockReturnValue(true);

    await expect(createShopeeNfeUploadScheduler().enqueue(payload)).rejects.toBeInstanceOf(
      ShopeeNfeUploadTasksDisabledError,
    );
    expect(h.valvula).toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('16 — a decisão é tomada na CONSTRUÇÃO, não a cada enqueue', async () => {
    valvulaAberta();
    const agendador = createShopeeNfeUploadScheduler();

    // Fechar a válvula DEPOIS de construir não muda este scheduler: quem quer a
    // decisão nova constrói outro — o contrato dos adaptadores irmãos.
    h.valvula.mockReturnValue(true);
    await agendador.enqueue(payload);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('shopeeNfeUploadTasks.ts — a fonte', () => {
  it('17 — não lê o ambiente: chama as leitoras compartilhadas', () => {
    // Montada em tempo de execução, para que a grafia crua não apareça nem
    // neste teste (a disciplina da pasta procura por ela).
    const lerAmbiente = ['process', 'env'].join('.');
    expect(FONTE.includes(lerAmbiente)).toBe(false);
    expect(FONTE).toContain(
      "import { shopeeTasksDesabilitado, shopeeTasksRegion } from '../shopeeTasks'",
    );
    expect(FONTE).toContain('shopeeTasksDesabilitado()');
    expect(FONTE).toContain('shopeeTasksRegion()');
  });

  it('18 — o nome da fila vem da CONSTANTE, e o contrato de ./tarefaNfe não é redeclarado', () => {
    // Uma cópia literal do nome aqui seria uma segunda grafia a divergir da que o
    // índice das functions compara com o nome exportado.
    expect(FONTE).not.toContain("'processShopeeNfeUpload'");
    expect(FONTE).toContain('functions/${SHOPEE_NFE_UPLOAD_QUEUE}');
    // A interface e as opções são as do contrato, nunca uma cópia local.
    expect(FONTE).not.toMatch(/interface AgendadorNfeShopee/);
    expect(FONTE).not.toMatch(/interface OpcoesDeEnfileiramentoNfe/);
    expect(FONTE).toContain('tarefaNfeShopeeSchema.parse(');
  });
});
