import { describe, expect, it } from 'vitest';
import { CAMPO_CORPO_RELAY_AMAZON } from '@delfrance/schemas';

import { APPLICATION_ID, SPID_A } from '../testing/fixtures';
import {
  TIPO_FEED_PROCESSING_FINISHED,
  TIPO_ORDER_CHANGE,
  desembrulharRelay,
  instanteEmMs,
  lerEnvelopeAmazon,
  lerFeedProcessingFinished,
  lerOrderChange,
} from './envelope';

const NOTIFICACAO = '00000000-0000-0000-0000-000000000001';
const PEDIDO = '000-0000000-0000001';

/** A PascalCase ORDER_CHANGE with placeholder ids. */
function orderChange(): Record<string, unknown> {
  return {
    NotificationVersion: '1.0',
    NotificationType: 'ORDER_CHANGE',
    PayloadVersion: '1.0',
    EventTime: '2020-01-11T00:09:53.109Z',
    Payload: {
      OrderChangeNotification: {
        NotificationLevel: 'OrderLevel',
        SellerId: SPID_A,
        AmazonOrderId: PEDIDO,
        Summary: { FulfillmentType: 'AFN', OrderStatus: 'Unshipped' },
      },
    },
    NotificationMetadata: {
      ApplicationId: APPLICATION_ID,
      SubscriptionId: '00000000-0000-0000-0000-000000000002',
      PublishTime: '2020-07-13T19:42:04.284Z',
      NotificationId: NOTIFICACAO,
    },
  };
}

/** A camelCase FEED_PROCESSING_FINISHED with placeholder ids. */
function feed(): Record<string, unknown> {
  return {
    notificationType: 'FEED_PROCESSING_FINISHED',
    payload: {
      feedProcessingFinishedNotification: {
        accountId: 'amzn1.merchant.o.AXXXXXXXXXXXXX',
        feedId: '00000000000',
        feedType: 'POST_PRODUCT_DATA',
        processingStatus: 'DONE',
      },
    },
    notificationMetadata: { applicationId: APPLICATION_ID, notificationId: NOTIFICACAO },
  };
}

function definir(obj: Record<string, unknown>, caminho: readonly string[], valor: unknown) {
  let alvo = obj;
  for (const chave of caminho.slice(0, -1)) alvo = alvo[chave] as Record<string, unknown>;
  const ultima = caminho.at(-1) ?? '';
  if (valor === undefined) delete alvo[ultima];
  else alvo[ultima] = valor;
  return obj;
}

describe('desembrulharRelay', () => {
  it('the template’s wrapper key is the contract’s', () => {
    expect(CAMPO_CORPO_RELAY_AMAZON).toBe('body');
  });

  it('{ body: <object> } ⇒ forma relay', () => {
    const env = orderChange();
    expect(desembrulharRelay({ body: env })).toEqual({
      tipo: 'envelope',
      forma: 'relay',
      envelope: env,
    });
  });

  it('{ body: <JSON string> } ⇒ parsed ONCE, forma relay-string', () => {
    const env = orderChange();
    expect(desembrulharRelay({ body: JSON.stringify(env) })).toEqual({
      tipo: 'envelope',
      forma: 'relay-string',
      envelope: env,
    });
    // Twice-encoded is not parsed twice.
    expect(desembrulharRelay({ body: JSON.stringify(JSON.stringify(env)) })).toMatchObject({
      tipo: 'descartada',
      motivo: 'sem-envelope-do-relay',
    });
  });

  it('{ body: <string that is not JSON> } ⇒ json-invalido', () => {
    expect(desembrulharRelay({ body: '{x' })).toEqual({
      tipo: 'descartada',
      forma: 'relay-string',
      motivo: 'json-invalido',
    });
  });

  it.each([
    ['a bare envelope', orderChange()],
    ['the wrapper with another key', { body: orderChange(), extra: 1 }],
    ['another key alone', { corpo: orderChange() }],
    ['an array', [orderChange()]],
    ['null', null],
    ['a string', 'x'],
  ])('%s ⇒ sem-envelope-do-relay', (_c, json) => {
    expect(desembrulharRelay(json)).toEqual({
      tipo: 'descartada',
      forma: 'sem-envelope',
      motivo: 'sem-envelope-do-relay',
    });
  });

  it.each([
    ['a number', 1],
    ['null', null],
    ['an array', [1]],
  ])('{ body: %s } is the wrapper with nothing usable ⇒ sem-envelope-do-relay', (_c, corpo) => {
    expect(desembrulharRelay({ body: corpo })).toEqual({
      tipo: 'descartada',
      forma: 'relay',
      motivo: 'sem-envelope-do-relay',
    });
  });

  it('a `body` inherited from the prototype is not the wrapper', () => {
    const herdado = Object.create({ body: orderChange() }) as object;
    expect(desembrulharRelay(herdado)).toMatchObject({ motivo: 'sem-envelope-do-relay' });
  });
});

describe('lerOrderChange (PascalCase)', () => {
  it('reads the four routing fields and the application id — nothing else', () => {
    expect(lerOrderChange(orderChange())).toEqual({
      tipo: 'lida',
      applicationId: APPLICATION_ID,
      campos: {
        sellerId: SPID_A,
        amazonOrderId: PEDIDO,
        notificationId: NOTIFICACAO,
        publishTimeMs: Date.UTC(2020, 6, 13, 19, 42, 4, 284),
      },
    });
  });

  it('refuses a camelCase envelope (casing pinned), even one forced to ORDER_CHANGE', () => {
    expect(lerOrderChange(feed())).toEqual({ tipo: 'outra-forma' });
    const camel = { ...feed(), notificationType: 'ORDER_CHANGE' };
    expect(lerOrderChange(camel)).toEqual({ tipo: 'outra-forma' });
  });

  it.each([
    ['SellerId', ['Payload', 'OrderChangeNotification', 'SellerId'], undefined],
    ['SellerId', ['Payload', 'OrderChangeNotification', 'SellerId'], 'A B'],
    [
      'AmazonOrderId',
      ['Payload', 'OrderChangeNotification', 'AmazonOrderId'],
      '000-0000000-00000001',
    ],
    ['AmazonOrderId', ['Payload', 'OrderChangeNotification', 'AmazonOrderId'], 12],
    ['NotificationId', ['NotificationMetadata', 'NotificationId'], 'a/b'],
    ['NotificationId', ['NotificationMetadata', 'NotificationId'], 'x'.repeat(129)],
    ['PublishTime', ['NotificationMetadata', 'PublishTime'], '2020-07-13T19:42:04.284'],
    ['PublishTime', ['NotificationMetadata', 'PublishTime'], 'ontem'],
    ['PublishTime', ['NotificationMetadata', 'PublishTime'], '1969-12-31T23:59:59Z'],
  ])(
    'an invalid %s is reported by its wire name, with the app id still read',
    (campo, caminho, valor) => {
      expect(lerOrderChange(definir(orderChange(), caminho, valor))).toEqual({
        tipo: 'campo-invalido',
        applicationId: APPLICATION_ID,
        campo,
      });
    },
  );

  it('EventTime is never read: a garbage EventTime still reads', () => {
    const env = orderChange();
    env.EventTime = 'lixo';
    expect(lerOrderChange(env).tipo).toBe('lida');
  });

  it('an ApplicationId that is not a string reads as null', () => {
    const env = definir(orderChange(), ['NotificationMetadata', 'ApplicationId'], 7);
    expect(lerOrderChange(env)).toMatchObject({ tipo: 'lida', applicationId: null });
  });
});

describe('lerFeedProcessingFinished (camelCase)', () => {
  it('reads the feed’s fields; sellerId optional (absent ⇒ null)', () => {
    expect(lerFeedProcessingFinished(feed())).toEqual({
      tipo: 'lida',
      applicationId: APPLICATION_ID,
      campos: {
        feedId: '00000000000',
        feedType: 'POST_PRODUCT_DATA',
        processingStatus: 'DONE',
        accountId: 'amzn1.merchant.o.AXXXXXXXXXXXXX',
        sellerId: null,
        notificationId: NOTIFICACAO,
      },
    });
    const comVendedor = definir(
      feed(),
      ['payload', 'feedProcessingFinishedNotification', 'sellerId'],
      SPID_A,
    );
    expect(lerFeedProcessingFinished(comVendedor)).toMatchObject({ campos: { sellerId: SPID_A } });
    const nulo = definir(
      feed(),
      ['payload', 'feedProcessingFinishedNotification', 'sellerId'],
      null,
    );
    expect(lerFeedProcessingFinished(nulo)).toMatchObject({ campos: { sellerId: null } });
  });

  it('refuses a PascalCase envelope (casing pinned)', () => {
    expect(lerFeedProcessingFinished(orderChange())).toEqual({ tipo: 'outra-forma' });
    const pascal = { ...orderChange(), NotificationType: 'FEED_PROCESSING_FINISHED' };
    expect(lerFeedProcessingFinished(pascal)).toEqual({ tipo: 'outra-forma' });
  });

  it.each([
    ['feedId', ['payload', 'feedProcessingFinishedNotification', 'feedId'], undefined],
    ['feedType', ['payload', 'feedProcessingFinishedNotification', 'feedType'], ''],
    ['processingStatus', ['payload', 'feedProcessingFinishedNotification', 'processingStatus'], 5],
    ['accountId', ['payload', 'feedProcessingFinishedNotification', 'accountId'], undefined],
    ['sellerId', ['payload', 'feedProcessingFinishedNotification', 'sellerId'], 'A B'],
    ['notificationId', ['notificationMetadata', 'notificationId'], undefined],
  ])('an invalid %s is reported', (campo, caminho, valor) => {
    expect(lerFeedProcessingFinished(definir(feed(), caminho, valor))).toEqual({
      tipo: 'campo-invalido',
      applicationId: APPLICATION_ID,
      campo,
    });
  });
});

describe('lerEnvelopeAmazon — dispatch on WHICH type key', () => {
  it('Pascal ORDER_CHANGE ⇒ the order parser', () => {
    expect(lerEnvelopeAmazon(orderChange())).toMatchObject({
      tipo: TIPO_ORDER_CHANGE,
      casing: 'pascal',
      leitura: { tipo: 'lida' },
    });
  });

  it('camel FEED_PROCESSING_FINISHED ⇒ the feed parser', () => {
    expect(lerEnvelopeAmazon(feed())).toMatchObject({
      tipo: TIPO_FEED_PROCESSING_FINISHED,
      casing: 'camel',
      leitura: { tipo: 'lida' },
    });
  });

  it('both keys ⇒ forma-ambigua; neither ⇒ sem-tipo', () => {
    expect(lerEnvelopeAmazon({ ...orderChange(), notificationType: 'ORDER_CHANGE' })).toEqual({
      tipo: 'descartada',
      motivo: 'forma-ambigua',
      casing: null,
      tipoNotificacao: null,
    });
    const nenhum = orderChange();
    delete nenhum.NotificationType;
    expect(lerEnvelopeAmazon(nenhum)).toEqual({
      tipo: 'descartada',
      motivo: 'sem-tipo',
      casing: null,
      tipoNotificacao: null,
    });
  });

  it.each([
    [
      'Pascal FEED_PROCESSING_FINISHED',
      { NotificationType: 'FEED_PROCESSING_FINISHED' },
      'pascal',
      'FEED_PROCESSING_FINISHED',
    ],
    ['camel ORDER_CHANGE', { notificationType: 'ORDER_CHANGE' }, 'camel', 'ORDER_CHANGE'],
    ['another type', { NotificationType: 'ANY_OFFER_CHANGED' }, 'pascal', 'ANY_OFFER_CHANGED'],
    ['free text as the type', { notificationType: 'um texto qualquer' }, 'camel', null],
    ['a null type', { NotificationType: null }, 'pascal', null],
  ])('%s ⇒ tipo-desconhecido', (_c, env, casing, tipoNotificacao) => {
    expect(lerEnvelopeAmazon(env)).toEqual({
      tipo: 'descartada',
      motivo: 'tipo-desconhecido',
      casing,
      tipoNotificacao,
    });
  });
});

describe('instanteEmMs — the offset is REQUIRED', () => {
  it.each([
    ['2020-07-13T19:42:04.284Z', Date.UTC(2020, 6, 13, 19, 42, 4, 284)],
    ['2020-07-13T16:42:04.284-03:00', Date.UTC(2020, 6, 13, 19, 42, 4, 284)],
    ['2020-07-13T19:42:04Z', Date.UTC(2020, 6, 13, 19, 42, 4)],
    ['2020-07-13T19:42:04.284123Z', Date.UTC(2020, 6, 13, 19, 42, 4, 284)],
  ])('%s ⇒ %i', (texto, ms) => {
    expect(instanteEmMs(texto)).toBe(ms);
  });

  it.each([
    '2020-07-13T19:42:04.284',
    '2020-07-13',
    '2020-07-13 19:42:04Z',
    ' 2020-07-13T19:42:04Z',
    '1969-12-31T23:59:59.999Z',
    42,
    null,
  ])('%j ⇒ null', (valor) => {
    expect(instanteEmMs(valor)).toBeNull();
  });
});
