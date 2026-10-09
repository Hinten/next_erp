import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  PENDENCIA_RECLAMACAO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  avisoSchema,
  pendenciaReclamacaoSchema,
  situacaoAnuncioForaDaSincronizacaoSchema,
  type SituacaoAnuncioForaDaSincronizacao,
} from '@delfrance/schemas';
import { MENSAGENS_POR_TIPO } from './mensagens';

/**
 * The two dispatch tipos of Shopee step 15b (#1744), rendered with the params
 * their producer writes (`apps/shopee/lib/shopee/avisos/despachoAutomatico.ts`),
 * the return tipo of step 17 (#1525) further down, and the Mercado Livre
 * link-audit tipo (#1200) after it.
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

/**
 * #847 — the producer is `apps/mercado-livre/lib/marketplace/anuncios/avisoCategoria.ts`.
 * Same rule as the Shopee planos above: no dependency edge reaches it from here, so
 * the plano is a LITERAL, and the producer's own test pins the same params.
 */
describe('MENSAGENS_POR_TIPO.anuncioCategoriaAlterada', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.anuncioCategoriaAlterada];
  const RESTO =
    ' Confira se a nova categoria tem fórmulas e impostos configurados (sem fórmulas, valem ' +
    'as padrão da lista), troque a categoria do produto e das variações, e recalcule o ' +
    'preço. O aviso se encerra quando a categoria do produto for alterada.';
  const COMPLETO = {
    anuncio: 'MLB4567',
    categoriaErpId: 'MLB1',
    categoriaErpNome: 'Roupas > Camisetas',
    categoriaMlId: 'MLB2',
    categoriaMlNome: 'Roupas > Camisetas e Regatas',
    comissaoCategoriaErpPct: 16,
    comissaoCategoriaMlPct: 11.5,
  };

  it('renders the sentence verbatim with every param, the commission in pt-BR', () => {
    expect(mensagem.corpo(COMPLETO)).toBe(
      'O Mercado Livre moveu o anúncio MLB4567 para a categoria Roupas > Camisetas e Regatas ' +
        '(MLB2), mas o produto continua na categoria Roupas > Camisetas (MLB1) — é ela que ' +
        'escolhe as fórmulas de preço (comissão, frete) e as regras de imposto da NF-e. ' +
        `Comissão estimada pelo Mercado Livre: 16% → 11,5%.${RESTO}`,
    );
  });

  it('ids only: no names, no fees — the bare ids, and NO commission sentence', () => {
    expect(
      mensagem.corpo({ anuncio: 'MLB4567', categoriaErpId: 'MLB1', categoriaMlId: 'MLB2' }),
    ).toBe(
      'O Mercado Livre moveu o anúncio MLB4567 para a categoria MLB2, mas o produto continua ' +
        'na categoria MLB1 — é ela que escolhe as fórmulas de preço (comissão, frete) e as ' +
        `regras de imposto da NF-e.${RESTO}`,
    );
  });

  it('ONE fee alone, or a fee stored as text, renders no commission sentence', () => {
    const base = { anuncio: 'MLB4567', categoriaErpId: 'MLB1', categoriaMlId: 'MLB2' };
    expect(mensagem.corpo({ ...base, comissaoCategoriaErpPct: 16 })).not.toContain('Comissão');
    expect(
      mensagem.corpo({ ...base, comissaoCategoriaErpPct: '16', comissaoCategoriaMlPct: 11 }),
    ).not.toContain('Comissão');
  });

  it('renders `{}` with placeholders, never "undefined"', () => {
    const texto = mensagem.corpo({});
    expect(texto).not.toContain('undefined');
    expect(texto).toContain('o anúncio — para a categoria —');
  });

  it('the producer plano parses as stored, pointing at the produto', () => {
    const aviso = comoArmazenado({
      tipo: TIPO_AVISO.anuncioCategoriaAlterada,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.mercadoLivre,
      params: COMPLETO,
      urlInterna: { rota: ROTAS_AVISO.produto.build('prod-1'), campo: null },
    });
    expect(aviso.params).toEqual(COMPLETO);
    expect(aviso.urlInterna?.rota).toBe('/produtos/prod-1');
  });

  it('is titled like its label and carries no runbook — the produto is the in-app fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.anuncioCategoriaAlterada);
    expect(mensagem.runbook).toBeUndefined();
  });
});

/**
 * The link-audit tipo of #1200, rendered with the params its producer writes
 * (`apps/mercado-livre/lib/marketplace/estoque/auditoriaNaoEnumerados.ts`):
 * exactly `{ situacao, anuncio, anuncios }`, `situacao` a CODE and `anuncios` a
 * NUMBER. Same reason for the literals as above — `apps/web` has no dependency
 * edge to `apps/mercado-livre`.
 */
describe('MENSAGENS_POR_TIPO.anuncioForaDaSincronizacao', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.anuncioForaDaSincronizacao];
  const ITEM_ID = 'MLB1234567890';
  const PRODUTO_ID = 'produto-123';
  const INTEGRACAO_ID = 'integracao-ml-1';
  const INICIO = 'está ativo no canal, mas não recebe estoque nem preço automaticamente: ';
  const FRASES: Record<SituacaoAnuncioForaDaSincronizacao, string> = {
    [SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao]:
      'ele está vinculado a uma variação, e não ao produto pai — refaça o vínculo no produto pai',
    [SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.paiIdInvalido]:
      'o cadastro do produto tem um vínculo de produto pai inválido — corrija o cadastro do ' +
      'produto',
    [SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente]:
      'ele aponta para um produto que não existe mais — encerre o anúncio no canal ou peça a ' +
      'remoção do vínculo órfão',
  };
  const corpoCom = (situacao: string | number | undefined, anuncios: string | number = 1) =>
    mensagem.corpo({
      anuncio: ITEM_ID,
      anuncios,
      ...(situacao === undefined ? {} : { situacao }),
    });

  it('renders every situação code as its own phrase, in its slot', () => {
    // Every member of the closed set has a pinned phrase — a code added to the
    // schema without one fails here, not as a blank slot in the bell.
    expect(Object.keys(FRASES).sort()).toEqual(
      [...situacaoAnuncioForaDaSincronizacaoSchema.options].sort(),
    );
    for (const [codigo, frase] of Object.entries(FRASES)) {
      expect(corpoCom(codigo), codigo).toBe(`O anúncio ${ITEM_ID} ${INICIO}${frase}.`);
    }
  });

  it('never names a channel — the tipo is channel-neutral', () => {
    for (const codigo of situacaoAnuncioForaDaSincronizacaoSchema.options) {
      expect(corpoCom(codigo, 3), codigo).not.toMatch(/mercado ?livre/i);
    }
  });

  it('falls back on an unknown, absent or inherited code — never "undefined"', () => {
    // The healed class (no aviso, so no phrase), the walk's own code that the
    // producer maps FROM, a near-miss spelling, a number, nothing at all, and a
    // key every object inherits.
    for (const situacao of [
      'conta-fora-do-produto',
      'NAO_ENUMERADO_LINK_EM_VARIACAO',
      'link_em_variacao',
      '',
      0,
      undefined,
      'toString',
      '__proto__',
    ]) {
      const corpo = corpoCom(situacao);
      expect(corpo, String(situacao)).toBe(
        `O anúncio ${ITEM_ID} ${INICIO}confira o vínculo do anúncio.`,
      );
      expect(corpo, String(situacao)).not.toContain('undefined');
    }
  });

  it('renders `{}` with the placeholder and the fallback, never "undefined"', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toBe(`O anúncio — ${INICIO}confira o vínculo do anúncio.`);
    expect(corpo).not.toContain('undefined');
  });

  it('renders an empty item id (a link that names none) as the placeholder', () => {
    expect(
      mensagem.corpo({
        situacao: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente,
        anuncio: '',
        anuncios: 1,
      }),
    ).toMatch(/^O anúncio — está ativo no canal/);
  });

  it('adds the count sentence only when the produto has MORE than one such anúncio', () => {
    const codigo = SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao;
    const base = `O anúncio ${ITEM_ID} ${INICIO}${FRASES[codigo]}.`;
    expect(corpoCom(codigo, 1)).toBe(base);
    expect(corpoCom(codigo, 2)).toBe(`${base} Este produto tem 2 anúncios nessa situação.`);
    expect(corpoCom(codigo, 3)).toBe(`${base} Este produto tem 3 anúncios nessa situação.`);
    // The producer writes a NUMBER; a string count is not parsed into a guess,
    // and a zero or absent count adds nothing.
    expect(corpoCom(codigo, '3')).toBe(base);
    expect(corpoCom(codigo, 0)).toBe(base);
    expect(mensagem.corpo({ situacao: codigo, anuncio: ITEM_ID }), 'sem `anuncios`').toBe(base);
  });

  it('renders both producer route shapes as stored, the code in `motivo` too', () => {
    // `produto-ausente` lands on the CONTA's channel page — a produto that no
    // longer exists has no page to open; every other situação lands on the produto.
    const planos = [
      {
        situacao: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao,
        rota: ROTAS_AVISO.produto.build(PRODUTO_ID),
        esperada: `/produtos/${PRODUTO_ID}`,
      },
      {
        situacao: SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente,
        rota: ROTAS_AVISO.canalMercadoLivre.build(INTEGRACAO_ID),
        esperada: `/canais/mercado-livre/${INTEGRACAO_ID}`,
      },
    ];
    for (const { situacao, rota, esperada } of planos) {
      const params = { situacao, anuncio: ITEM_ID, anuncios: 3 };
      const aviso = comoArmazenado({
        tipo: TIPO_AVISO.anuncioForaDaSincronizacao,
        severidade: SEVERIDADE_AVISO.atencao,
        canal: CANAL_AVISO.mercadoLivre,
        params,
        motivo: situacao,
        urlInterna: { rota, campo: null },
      });
      expect(aviso.tipo, situacao).toBe(TIPO_AVISO.anuncioForaDaSincronizacao);
      expect(aviso.severidade, situacao).toBe(SEVERIDADE_AVISO.atencao);
      expect(aviso.canal, situacao).toBe(CANAL_AVISO.mercadoLivre);
      expect(aviso.params, situacao).toEqual(params);
      expect(aviso.motivo, situacao).toBe(situacao);
      expect(aviso.urlInterna?.rota, situacao).toBe(esperada);
      // A periodic observation by one scheduled writer: no provider clock, no deadline.
      expect(aviso.relogioEvento, situacao).toBeNull();
      expect(aviso.prazo, situacao).toBeNull();
      expect(mensagem.corpo(aviso.params), situacao).toBe(
        `O anúncio ${ITEM_ID} ${INICIO}${FRASES[situacao]}. ` +
          'Este produto tem 3 anúncios nessa situação.',
      );
    }
  });

  it('is titled like its label and carries no runbook — the cadastro is the in-app fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.anuncioForaDaSincronizacao);
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
