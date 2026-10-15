import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopeeAppPushConfig, ShopeePartnerClient } from '@delfrance/integrations-shopee';

import { chavePushDegradado, chavePushSuspenso } from '../avisos/pushSaude';
// ⚠️ The REAL avisos writer over the shared fake Firestore — the transitions are
// the property under test, and a mocked producer cannot show which row moved.
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { CODIGOS_ESPERADOS, runShopeePushConfigMonitor } from './pushConfigMonitor';

const AGORA_MS = 1_760_000_000_000;
const DIA_MS = 86_400_000;
const CALLBACK = 'https://shopee.exemplo.test/api/webhooks/shopee';

const PATH_DEGRADADO = `avisos/${chavePushDegradado()}`;
const PATH_SUSPENSO = `avisos/${chavePushSuspenso()}`;

const getAppPushConfig = vi.fn();
const partnerClient = { getAppPushConfig } as unknown as ShopeePartnerClient;

let avisosDeLog: { msg: string; meta?: Record<string, unknown> }[] = [];
const logger = {
  warn: (msg: string, meta?: Record<string, unknown>): void => {
    avisosDeLog.push(meta === undefined ? { msg } : { msg, meta });
  },
};

function config(over: Partial<ShopeeAppPushConfig> = {}): ShopeeAppPushConfig {
  return {
    callback_url: CALLBACK,
    live_push_status: 'Normal',
    suspended_time: null,
    blocked_shop_id: null,
    push_config_on_list: null,
    push_config_off_list: null,
    ...over,
  } as ShopeeAppPushConfig;
}

function monitor(db: FakeDb, nowMs = AGORA_MS) {
  return runShopeePushConfigMonitor(asDb(db), {
    partnerClient,
    increment,
    nowMs,
    logger,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  avisosDeLog = [];
  vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', CALLBACK);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */

describe('a leitura de live_push_status', () => {
  it('Normal resolve os dois, com motivo normalizado', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Warning' }));
    await monitor(db);
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Suspended' }));
    await monitor(db, AGORA_MS + 1000);

    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Normal' }));
    const out = await monitor(db, AGORA_MS + 2000);

    expect(out).toMatchObject({ status: 'normal', avisados: 0, resolvidos: 2 });
    expect(db.store[PATH_DEGRADADO]?.data).toMatchObject({
      resolvidoEm: (AGORA_MS + 2000) * 1000,
      resolucaoMotivo: 'normalizado',
    });
    expect(db.store[PATH_SUSPENSO]?.data.resolvidoEm).toBe((AGORA_MS + 2000) * 1000);
  });

  it('normal minúsculo resolve igual — a comparação é case-insensitive', async () => {
    // A página se contradiz: a descrição diz `Normal/Warning/Suspended` e o
    // próprio sample dela diz `"suspended"`.
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'normal' }));

    expect((await monitor(db)).status).toBe('normal');
  });

  it('  Suspended  com espaços é reconhecido pelo trim', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: '  Suspended  ' }));

    const out = await monitor(db);
    expect(out).toMatchObject({ status: 'suspended', statusBruto: '  Suspended  ' });
  });

  it('⚠️ normalizado NÃO é normal — a comparação é EXATA depois do fold, nunca startsWith', async () => {
    // O near-miss que decide o fold: `'normalizado'` começa com `'normal'`, e
    // lê-lo como saudável RESOLVERIA um aviso crítico de pé sobre um valor que
    // ninguém verificou. `'not normal'` contém `'normal'` também.
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Suspended' }));
    await monitor(db);
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'normalizado' }));

    const out = await monitor(db, AGORA_MS + 1000);

    expect(out).toMatchObject({ status: 'desconhecido', resolvidos: 0, avisados: 0 });
    expect(db.store[PATH_SUSPENSO]?.data.resolvidoEm).toBeNull();
  });

  it('um live_push_status desconhecido não levanta nem resolve nada — só registra', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Throttled' }));

    const out = await monitor(db);

    expect(out).toMatchObject({ status: 'desconhecido', statusBruto: 'Throttled' });
    expect(Object.keys(db.store)).toEqual([]);
    expect(avisosDeLog.some((a) => a.msg.includes('desconhecido'))).toBe(true);
  });

  it('live_push_status ausente (null) é tratado como desconhecido', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: null }));

    const out = await monitor(db);
    expect(out).toMatchObject({ status: 'desconhecido', statusBruto: null });
    expect(Object.keys(db.store)).toEqual([]);
  });
});

describe('as transições', () => {
  it('Warning levanta o degradado e RESOLVE o suspenso', async () => {
    // Ser reportado como Warning é prova positiva de que a assinatura está viva:
    // o campo é um escalar só, e `Suspended` é estritamente pior.
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Suspended' }));
    await monitor(db);

    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Warning' }));
    const out = await monitor(db, AGORA_MS + 1000);

    expect(out).toMatchObject({ status: 'warning', avisados: 1, resolvidos: 1 });
    expect(db.store[PATH_DEGRADADO]?.data).toMatchObject({
      severidade: 'atencao',
      params: { status: 'Warning' },
      resolvidoEm: null,
    });
    expect(db.store[PATH_SUSPENSO]?.data.resolvidoEm).toBe((AGORA_MS + 1000) * 1000);
  });

  it('⚠️ Suspended levanta o suspenso e NÃO TOCA no degradado — nem levanta, nem resolve', async () => {
    // Resolvê-lo carimbaria `resolvidoEm` em "entrega degradada" no momento em
    // que as coisas estão no pior estado, tirando-a do sino e iniciando o
    // relógio de retenção de 90 dias — uma mentira na direção perigosa.
    // Levantá-lo TAMBÉM poria duas linhas com dois runbooks diferentes na caixa
    // por um evento só.
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Warning' }));
    await monitor(db);

    getAppPushConfig.mockResolvedValue(
      config({ live_push_status: 'Suspended', suspended_time: 1_759_000_000 }),
    );
    const out = await monitor(db, AGORA_MS + 1000);

    expect(out).toMatchObject({ status: 'suspended', avisados: 1, resolvidos: 0 });
    expect(db.store[PATH_SUSPENSO]?.data).toMatchObject({
      severidade: 'critico',
      relogioEvento: 1_759_000_000 * 1000,
      resolvidoEm: null,
    });
    // De pé, intocada, e verdadeira.
    expect(db.store[PATH_DEGRADADO]?.data).toMatchObject({
      resolvidoEm: null,
      ocorrencias: 1,
      atualizadoEm: AGORA_MS * 1000,
    });
  });

  it('a primeira observação sendo Suspended NÃO inventa uma linha de degradado', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(
      config({ live_push_status: 'Suspended', suspended_time: 1_759_000_000 }),
    );

    await monitor(db);

    expect(Object.keys(db.store)).toEqual([PATH_SUSPENSO]);
  });

  it('uma segunda tick em Warning REPETE — ocorrencias vira 2 e criadoEm não se move', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Warning' }));

    await monitor(db);
    const out = await monitor(db, AGORA_MS + DIA_MS);

    expect(out.resultados).toMatchObject({ criado: 0, repetido: 1 });
    expect(db.store[PATH_DEGRADADO]?.data).toMatchObject({
      criadoEm: AGORA_MS * 1000,
      ocorrencias: 2,
    });
  });

  it('⚠️ duas ticks na MESMA suspensão são ignoradas pelo watermark — ocorrencias conta suspensões, não dias', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(
      config({ live_push_status: 'Suspended', suspended_time: 1_759_000_000 }),
    );

    await monitor(db);
    const out = await monitor(db, AGORA_MS + DIA_MS);

    expect(out.resultados).toMatchObject({ ignorado: 1 });
    expect(out.avisados).toBe(0);
    expect(db.store[PATH_SUSPENSO]?.data.ocorrencias).toBe(1);
  });

  it('uma NOVA suspensão (suspended_time maior) REABRE com criadoEm fresco', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(
      config({ live_push_status: 'Suspended', suspended_time: 1_759_000_000 }),
    );
    await monitor(db);
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Normal' }));
    await monitor(db, AGORA_MS + 1000);

    getAppPushConfig.mockResolvedValue(
      config({ live_push_status: 'Suspended', suspended_time: 1_759_500_000 }),
    );
    const out = await monitor(db, AGORA_MS + 2000);

    expect(out.resultados).toMatchObject({ reaberto: 1 });
    expect(db.store[PATH_SUSPENSO]?.data).toMatchObject({
      criadoEm: (AGORA_MS + 2000) * 1000,
      resolvidoEm: null,
      ocorrencias: 2,
    });
  });

  it('Normal depois de Suspended resolve e conta resolvidos: 1 UMA única vez', async () => {
    // ⚠️ `resolverAviso` reporta uma TRANSIÇÃO: contar "pedimos por duas linhas"
    // faria o contador reportar fechamentos que nunca aconteceram e
    // re-carimbaria `resolvidoEm` a cada dia, empurrando a linha para além do
    // corte de 90 dias do `sweepAvisosResolvidos`.
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(
      config({ live_push_status: 'Suspended', suspended_time: 1_759_000_000 }),
    );
    await monitor(db);

    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Normal' }));
    const primeira = await monitor(db, AGORA_MS + 1000);
    const segunda = await monitor(db, AGORA_MS + 2000);

    expect(primeira.resolvidos).toBe(1);
    expect(segunda.resolvidos).toBe(0);
    expect(db.store[PATH_SUSPENSO]?.data.resolvidoEm).toBe((AGORA_MS + 1000) * 1000);
  });
});

describe('as verificações que são SÓ log', () => {
  it('um callback_url divergente é só um warn — não existe tipo de aviso para isso', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ callback_url: 'https://outro.test/webhook' }));

    const out = await monitor(db);

    expect(out.callbackDivergente).toBe(true);
    expect(Object.keys(db.store)).toEqual([]);
    expect(avisosDeLog.some((a) => a.msg.includes('callback_url da Shopee diverge'))).toBe(true);
  });

  it('⚠️ a comparação do callback_url é BYTE A BYTE: uma barra final é divergência', async () => {
    // A string entra no base string do HMAC do push (`callback_url + '|' +
    // rawBody`), e `pushSignature.test.ts` já fixa que uma barra final muda o
    // digest — então a diferença "cosmética" É o defeito.
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ callback_url: `${CALLBACK}/` }));

    expect((await monitor(db)).callbackDivergente).toBe(true);
  });

  it('um callback_url idêntico não diverge', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config());

    expect((await monitor(db)).callbackDivergente).toBe(false);
  });

  it('sem SHOPEE_PUSH_CALLBACK_URL não há comparação, e o warn diz isso', async () => {
    // Reportar divergência contra um valor que não temos seria um falso
    // positivo diário.
    vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', '');
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config());

    const out = await monitor(db);

    expect(out.callbackDivergente).toBe(false);
    expect(avisosDeLog.some((a) => a.msg.includes('não configurado localmente'))).toBe(true);
  });

  it('push_config_off_list contendo 3 avisa nomeando os códigos', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ push_config_off_list: [3, 44] }));

    const out = await monitor(db);

    expect(out.codigosDesligados).toEqual([3]);
    expect(avisosDeLog.some((a) => a.msg.includes('DESLIGADOS'))).toBe(true);
  });

  it('⚠️ uma off_list VAZIA não prova nada sobre a ON — o enum documentado para em 13 e os códigos vivos chegam a 47', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(
      config({ push_config_off_list: [], push_config_on_list: [] }),
    );

    const out = await monitor(db);

    // Nenhum código é reportado como desligado, e nenhum é reportado como
    // ligado: só a presença EXPLÍCITA na off_list é evidência.
    expect(out.codigosDesligados).toEqual([]);
    expect(avisosDeLog.some((a) => a.msg.includes('DESLIGADOS'))).toBe(false);
    expect(CODIGOS_ESPERADOS).toEqual([1, 2, 3, 12]);
  });

  it('blocked_shop_id não vazio vira um warn com a contagem', async () => {
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ blocked_shop_id: [987654, 987655] }));

    const out = await monitor(db);

    expect(out.lojasBloqueadas).toBe(2);
    expect(avisosDeLog.some((a) => a.msg.includes('bloqueadas'))).toBe(true);
  });
});

describe('o monitor nunca escreve na Shopee', () => {
  it('nunca chama set_app_push_config — o cliente não expõe a operação', async () => {
    // A ausência É a aplicação da regra: `set_app_push_config` recebe um
    // `callback_url` único do APP, dispara um push de teste ao vivo, tem
    // semântica de corpo parcial indocumentada, e o enum de códigos dele para em
    // 13 enquanto os códigos vivos chegam a 47.
    const db = new FakeDb();
    getAppPushConfig.mockResolvedValue(config({ live_push_status: 'Suspended' }));

    await monitor(db);

    expect('setAppPushConfig' in partnerClient).toBe(false);
    expect(getAppPushConfig).toHaveBeenCalledTimes(1);
    // Uma leitura, nenhuma outra chamada de provedor.
    expect(Object.keys(partnerClient)).toEqual(['getAppPushConfig']);
  });
});
