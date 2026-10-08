import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  PENDENCIA_RECLAMACAO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  avisoSchema,
  pendenciaReclamacaoSchema,
} from '@delfrance/schemas';
import { MENSAGENS_POR_TIPO } from './mensagens';

/**
 * The two dispatch tipos of Shopee step 15b (#1744), rendered with the params
 * their producer writes (`apps/shopee/lib/shopee/avisos/despachoAutomatico.ts`),
 * and the return tipo of step 17 (#1525) further down.
 *
 * `rotas.test.ts` already proves every row renders `{}` without "undefined".
 * This file pins the sentences verbatim and renders the producers' planos
 * as LITERALS: `apps/web` has no dependency edge to `apps/shopee`, so a copied
 * literal is the only way to hold the writer's params against the reader's
 * wording — the producer's own test asserts the same values.
 */

const AGORA_US = 1_760_000_000_000_000;
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = '0123456789abcdef'.repeat(4);

/** The producer's `situacao` for `nfe-pendente` (class `nfe`). */
const SITUACAO_NFE_PENDENTE =
  'emita a NF-e do pedido — a Shopee só libera o envio com a nota validada, e o despacho ' +
  'automático é feito assim que ela validar';
/** The producer's `situacao` for `precisa-escolha` (class `manual`). */
const SITUACAO_PRECISA_ESCOLHA =
  'organize o envio pelo checkout ou pela Central do Vendedor — a Shopee pede uma escolha de ' +
  'endereço, horário ou modalidade que o despacho automático não faz sozinho';

const URL_INTERNA = { rota: ROTAS_AVISO.despachoCheckout.build(PEDIDO_ID), campo: null };

/** What the producer opens for an invoice-pending package (class `nfe`). */
const PLANO_DESPACHO_NFE = {
  tipo: TIPO_AVISO.despachoAutomaticoPendente,
  severidade: SEVERIDADE_AVISO.atencao,
  canal: CANAL_AVISO.shopee,
  params: { pedido: ORDER_SN, situacao: SITUACAO_NFE_PENDENTE },
  motivo: 'nfe-pendente',
  urlInterna: URL_INTERNA,
};

/** What the producer opens when the arrange needs a human choice (class `manual`). */
const PLANO_DESPACHO_MANUAL = {
  tipo: TIPO_AVISO.despachoAutomaticoPendente,
  severidade: SEVERIDADE_AVISO.critico,
  canal: CANAL_AVISO.shopee,
  params: { pedido: ORDER_SN, situacao: SITUACAO_PRECISA_ESCOLHA },
  motivo: 'precisa-escolha',
  urlInterna: URL_INTERNA,
};

/** What the producer opens once a print-deadline channel's shipment is arranged. */
const PLANO_ETIQUETA = {
  tipo: TIPO_AVISO.etiquetaComPrazo,
  severidade: SEVERIDADE_AVISO.atencao,
  canal: CANAL_AVISO.shopee,
  params: { pedido: ORDER_SN },
  urlInterna: URL_INTERNA,
};

/** The plano as the bell reads it back: through the schema, with the writer's stamps. */
function comoArmazenado(plano: object) {
  return avisoSchema.parse({ ...plano, criadoEm: AGORA_US, atualizadoEm: AGORA_US });
}

describe('MENSAGENS_POR_TIPO.despachoAutomaticoPendente', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.despachoAutomaticoPendente];

  it('renders the sentence verbatim with every param', () => {
    expect(mensagem.corpo({ pedido: ORDER_SN, situacao: 'faça X' })).toBe(
      `O despacho automático de um pacote do pedido ${ORDER_SN} não foi feito: faça X. ` +
        'Sem uma tentativa de despacho, a Shopee cancela o pedido.',
    );
  });

  it('renders `{}` with the placeholder in both slots, never "undefined"', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toBe(
      'O despacho automático de um pacote do pedido — não foi feito: —. ' +
        'Sem uma tentativa de despacho, a Shopee cancela o pedido.',
    );
    expect(corpo).not.toContain('undefined');
  });

  it('renders both producer planos as stored, each param in its slot', () => {
    for (const plano of [PLANO_DESPACHO_NFE, PLANO_DESPACHO_MANUAL]) {
      const aviso = comoArmazenado(plano);
      const corpo = mensagem.corpo(aviso.params);
      expect(corpo, plano.motivo).toContain(`do pedido ${ORDER_SN} não foi feito`);
      expect(corpo, plano.motivo).toContain(`não foi feito: ${plano.params.situacao}. Sem`);
      expect(corpo, plano.motivo).not.toContain('undefined');
    }
  });

  it('is titled like its label and carries no runbook — the checkout is the in-app fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.despachoAutomaticoPendente);
    expect(mensagem.runbook).toBeUndefined();
  });
});

describe('MENSAGENS_POR_TIPO.etiquetaComPrazo', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.etiquetaComPrazo];
  const RESTO =
    ' já está organizado. Emita e imprima a etiqueta em até 1 hora após a criação do pedido — ' +
    'a Shopee exige isso neste canal de entrega rápida. Se ela já foi impressa, nada a fazer: ' +
    'o aviso se encerra quando a Shopee registrar a coleta.';

  it('renders the sentence verbatim with every param', () => {
    expect(mensagem.corpo({ pedido: ORDER_SN })).toBe(`O envio do pedido ${ORDER_SN}${RESTO}`);
  });

  it('renders `{}` with the placeholder, never "undefined"', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toBe(`O envio do pedido —${RESTO}`);
    expect(corpo).not.toContain('undefined');
  });

  it('renders the producer plano as stored, the pedido in its slot', () => {
    const corpo = mensagem.corpo(comoArmazenado(PLANO_ETIQUETA).params);
    expect(corpo).toBe(`O envio do pedido ${ORDER_SN}${RESTO}`);
  });

  it('is titled like its label and carries no runbook — the checkout is the in-app fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.etiquetaComPrazo);
    expect(mensagem.runbook).toBeUndefined();
  });
});

/**
 * The return tipo of Shopee step 17 (#1525), rendered with the params its
 * producer writes (`apps/shopee/lib/shopee/devolucoes/avisoDevolucao.ts`):
 * exactly `{ pedido, devolucao, pendencia }`, `pendencia` a CODE.
 */
describe('MENSAGENS_POR_TIPO.reclamacaoAguardandoVendedor', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.reclamacaoAguardandoVendedor];
  const RETURN_SN = '260910ABCDE0001';
  const RESTO =
    '. Sem resposta até o prazo, o canal decide sozinho — em geral a favor do comprador. ' +
    'Abra a aba Incidentes do pedido.';
  const corpoCom = (pendencia: string | number | undefined) =>
    mensagem.corpo({
      pedido: ORDER_SN,
      devolucao: RETURN_SN,
      ...(pendencia === undefined ? {} : { pendencia }),
    });

  it('renders every pendência code as its own phrase, in its slot', () => {
    const FRASES: Record<string, string> = {
      [PENDENCIA_RECLAMACAO.responderSolicitacao]: 'responda à solicitação de devolução',
      [PENDENCIA_RECLAMACAO.responderProposta]:
        'o comprador fez uma proposta e aguarda sua resposta',
      [PENDENCIA_RECLAMACAO.enviarEvidencias]: 'o canal pediu evidências',
    };
    // Every member of the closed set has a pinned phrase — a code added to the
    // schema without one fails here, not as a blank slot in the bell.
    expect(Object.keys(FRASES).sort()).toEqual([...pendenciaReclamacaoSchema.options].sort());
    for (const [codigo, frase] of Object.entries(FRASES)) {
      expect(corpoCom(codigo), codigo).toBe(
        `A devolução ${RETURN_SN} do pedido ${ORDER_SN} aguarda você: ${frase}${RESTO}`,
      );
    }
  });

  it('falls back on an unknown, absent or inherited code — never "undefined"', () => {
    // A code newer than this build, a near-miss spelling, the pickup that is NOT
    // a pendência in v1, a number, nothing at all, and a key every object inherits.
    for (const pendencia of [
      'organizar-coleta',
      'responder_solicitacao',
      'RESPONDER-SOLICITACAO',
      '',
      0,
      undefined,
      'toString',
      '__proto__',
    ]) {
      const corpo = corpoCom(pendencia);
      expect(corpo, String(pendencia)).toBe(
        `A devolução ${RETURN_SN} do pedido ${ORDER_SN} aguarda você: ` +
          `confira a situação da devolução${RESTO}`,
      );
      expect(corpo, String(pendencia)).not.toContain('undefined');
    }
  });

  it('renders `{}` with the placeholders and the fallback, never "undefined"', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toBe(
      `A devolução — do pedido — aguarda você: confira a situação da devolução${RESTO}`,
    );
    expect(corpo).not.toContain('undefined');
  });

  it('interpolates no `params.prazo` — the deadline is the `prazo` FIELD', () => {
    // A `prazo` param through `p()` would print the raw µs integer as if it were a
    // date; the bell formats the field for every tipo (#1751).
    const prazoUs = AGORA_US + 86_400_000_000;
    const corpo = mensagem.corpo({
      pedido: ORDER_SN,
      devolucao: RETURN_SN,
      pendencia: PENDENCIA_RECLAMACAO.responderProposta,
      prazo: prazoUs,
    });
    expect(corpo).not.toContain(String(prazoUs));
    expect(corpo).toBe(corpoCom(PENDENCIA_RECLAMACAO.responderProposta));
  });

  it('renders the producer plano as stored, with the prazo on the field', () => {
    const prazoUs = AGORA_US + 86_400_000_000;
    const aviso = comoArmazenado({
      tipo: TIPO_AVISO.reclamacaoAguardandoVendedor,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      params: {
        pedido: ORDER_SN,
        devolucao: RETURN_SN,
        pendencia: PENDENCIA_RECLAMACAO.enviarEvidencias,
      },
      motivo: 'REQUESTED',
      urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null },
      prazo: prazoUs,
    });
    expect(aviso.prazo).toBe(prazoUs);
    expect(aviso.urlInterna?.rota).toBe(`/pedidos/${PEDIDO_ID}/editar`);
    expect(mensagem.corpo(aviso.params)).toBe(
      `A devolução ${RETURN_SN} do pedido ${ORDER_SN} aguarda você: o canal pediu evidências${RESTO}`,
    );
  });

  it('is titled like its label and carries no runbook — the panel is the in-app fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.reclamacaoAguardandoVendedor);
    expect(mensagem.runbook).toBeUndefined();
  });
});

describe('the producer planos as stored', () => {
  it('parse, keeping the checkout route and the class severity', () => {
    // A plano the schema rejected would never reach the bell at all; one it
    // reshaped would render something the producer never wrote.
    const nfe = comoArmazenado(PLANO_DESPACHO_NFE);
    expect(nfe.severidade).toBe(SEVERIDADE_AVISO.atencao);
    expect(nfe.params).toEqual(PLANO_DESPACHO_NFE.params);
    expect(nfe.urlInterna).toEqual({
      rota: `/despacho/checkout?pedido=${PEDIDO_ID}`,
      campo: null,
    });
    expect(nfe.prazo).toBeNull();

    expect(comoArmazenado(PLANO_DESPACHO_MANUAL).severidade).toBe(SEVERIDADE_AVISO.critico);
    expect(comoArmazenado(PLANO_ETIQUETA).params).toEqual({ pedido: ORDER_SN });
  });
});

/**
 * The two Loja Integrada tipos of step 2 (#1829), rendered with the params their
 * producers write (`apps/loja-integrada/lib/lojaIntegrada/avisos/avisos.ts`):
 * expiry `{ loja, dias, expiraEm }` — `dias` a NUMBER, `expiraEm` a
 * `YYYY-MM-DD` civil date — and reconexão `{ loja, status }`.
 */
describe('MENSAGENS_POR_TIPO.lojaIntegradaTokenExpirando', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaTokenExpirando];
  const LOJA = 'Conta A';
  const RENOVE = 'Renove no painel e atualize a validade no ERP.';
  const VENCIDO =
    'Se o token não foi renovado no painel, ele foi revogado — gere um novo e salve-o no ERP. ' +
    'Se foi renovado, atualize a validade no ERP.';

  it('renders the conta, the days and the date (DD/MM/AAAA) in their slots', () => {
    expect(mensagem.corpo({ loja: LOJA, dias: 12, expiraEm: '2026-11-02' })).toBe(
      `O token da Loja Integrada da loja ${LOJA} vence em 12 dia(s) (02/11/2026). ${RENOVE}`,
    );
  });

  it('says "vence hoje" at zero days, and keeps one day apart from it', () => {
    expect(mensagem.corpo({ loja: LOJA, dias: 0, expiraEm: '2026-11-02' })).toBe(
      `O token da Loja Integrada da loja ${LOJA} vence hoje (02/11/2026). ${RENOVE}`,
    );
    expect(mensagem.corpo({ loja: LOJA, dias: 1, expiraEm: '2026-11-02' })).toBe(
      `O token da Loja Integrada da loja ${LOJA} vence em 1 dia(s) (02/11/2026). ${RENOVE}`,
    );
  });

  it('says the date has passed at negative days — never "vence em -1 dia(s)"', () => {
    for (const dias of [-1, -30]) {
      const corpo = mensagem.corpo({ loja: LOJA, dias, expiraEm: '2026-11-02' });
      expect(corpo, String(dias)).toBe(
        `A validade informada para o token da Loja Integrada da loja ${LOJA} já passou ` +
          `(02/11/2026). ${VENCIDO}`,
      );
      expect(corpo, String(dias)).not.toContain(String(dias));
    }
  });

  it('formats the date by splitting the string — no time-zone shift to the day before', () => {
    // `new Date('2026-01-01')` is UTC midnight: rendered in São Paulo it would
    // read 31/12/2025. The split cannot move a day.
    expect(mensagem.corpo({ loja: LOJA, dias: 5, expiraEm: '2026-01-01' })).toContain(
      '(01/01/2026)',
    );
  });

  it('omits a missing or malformed date rather than printing it raw', () => {
    for (const expiraEm of [undefined, '2026-11-2', '02/11/2026', 20261102, '']) {
      const corpo = mensagem.corpo({
        loja: LOJA,
        dias: 12,
        ...(expiraEm === undefined ? {} : { expiraEm }),
      });
      expect(corpo, String(expiraEm)).toBe(
        `O token da Loja Integrada da loja ${LOJA} vence em 12 dia(s). ${RENOVE}`,
      );
    }
  });

  it('renders `{}` with the placeholders, never "undefined" or "NaN"', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toBe(`O token da Loja Integrada da loja — vence em — dia(s). ${RENOVE}`);
    expect(corpo).not.toContain('undefined');
    expect(corpo).not.toContain('NaN');
  });

  it('renders the producer plano as stored, with the expiry on the `prazo` field', () => {
    const prazoUs = AGORA_US + 20 * 86_400_000_000;
    const aviso = comoArmazenado({
      tipo: TIPO_AVISO.lojaIntegradaTokenExpirando,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: LOJA, dias: 20, expiraEm: '2026-10-29' },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      prazo: prazoUs,
    });
    expect(aviso.canal).toBe(CANAL_AVISO.lojaIntegrada);
    expect(aviso.prazo).toBe(prazoUs);
    expect(aviso.urlInterna?.rota).toBe('/canais/loja-integrada/int-1');
    expect(mensagem.corpo(aviso.params)).toBe(
      `O token da Loja Integrada da loja ${LOJA} vence em 20 dia(s) (29/10/2026). ${RENOVE}`,
    );
  });

  it('is titled like its label and carries no runbook — the conta panel is the in-app fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaTokenExpirando);
    expect(mensagem.runbook).toBeUndefined();
  });
});

describe('MENSAGENS_POR_TIPO.lojaIntegradaReconexaoPendente', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaReconexaoPendente];
  const PARADA = 'A importação fica parada até salvar um token válido.';

  it('renders the conta and the HTTP status in their slots, for 401 and 403', () => {
    for (const status of [401, 403]) {
      expect(mensagem.corpo({ loja: 'Conta A', status }), String(status)).toBe(
        `A Loja Integrada recusou o token da loja Conta A (HTTP ${String(status)}). ${PARADA}`,
      );
    }
  });

  it('renders `{}` with the placeholder and no status, never "undefined"', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toBe(`A Loja Integrada recusou o token da loja —. ${PARADA}`);
    expect(corpo).not.toContain('undefined');
  });

  it('renders the producer plano as stored', () => {
    const aviso = comoArmazenado({
      tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', status: 403 },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      relogioEvento: 1_800_000_000_123_456,
    });
    expect(aviso.severidade).toBe(SEVERIDADE_AVISO.critico);
    expect(aviso.prazo).toBeNull();
    expect(mensagem.corpo(aviso.params)).toBe(
      `A Loja Integrada recusou o token da loja Conta A (HTTP 403). ${PARADA}`,
    );
  });

  it('is titled like its label, with a runbook naming the owner and the painel', () => {
    // The remedy is outside the app: only the store owner can generate or renew
    // the token. The runbook says who and where; saving it is the in-app half.
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaReconexaoPendente);
    expect(mensagem.runbook).toBe(
      'Peça ao proprietário da loja que gere um novo token ou renove o atual no painel da Loja ' +
        'Integrada (Configurações > Chave para API) e salve-o na conta, no ERP.',
    );
  });
});
