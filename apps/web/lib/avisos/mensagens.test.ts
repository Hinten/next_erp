import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  MOTIVO_IMPORTACAO_PARADA_LI,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  MOTIVO_REVERSAO_COM_ETIQUETA_LI,
  PENDENCIA_RECLAMACAO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  TIPO_AVISO,
  TIPO_AVISO_LABELS,
  avisoReceitaKitShopee,
  avisoSchema,
  motivoFreteNaoSuportadoLiSchema,
  motivoImportacaoParadaLiSchema,
  motivoPedidoContestadoLiSchema,
  motivoReversaoComEtiquetaLiSchema,
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

/**
 * The native-kit recipe tipo of Shopee step 19 (#1527). Its ONE definition
 * (`avisoReceitaKitShopee`) sits in `@delfrance/schemas`, so — unlike the
 * dispatch planos above — the writer's own builder is rendered here, not a
 * copied literal.
 *
 * ⚠️ M30: the order of the advice is the safety property. A #1450 repoint of the
 * map flips the ERP fingerprint while Shopee's recipe is unchanged, and
 * `--recriar` deletes a LIVE listing — so the sentence must say "republish
 * FIRST", and its recriar must name the link (`--link {vinculo} --recriar`),
 * never a bare `--recriar`.
 */
describe('MENSAGENS_POR_TIPO.shopeeKitReceitaDivergente', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.shopeeKitReceitaDivergente];
  const KIT = 'k1';
  const ITEM_ID = 2500139870;
  const VINCULO = 'l-kit-1';

  const corpoEsperado = (kit: string, anuncio: string, vinculo: string, variacoes: string) =>
    `A composição das variações ${variacoes} do kit ${kit} mudou no ERP, mas o kit ` +
    `${anuncio} na Shopee continua com a receita antiga — a Shopee não permite alterar componentes ` +
    'nem quantidades de um kit, então o estoque que ela calcula pode estar errado. Republique o kit primeiro ' +
    '(publicar:anuncio sem opções): se a composição na Shopee já for a mesma, este aviso se resolve sozinho. ' +
    `Senão, recrie o kit (publicar:anuncio --link ${vinculo} --recriar) ou volte a composição ao que ` +
    'está na Shopee.';

  /**
   * The same sentence when the aviso names NO link (the builder's `—`, or the
   * param absent): a `--recriar` refuses to run without `--link`, so the reader
   * prints no command with a dangling `--link —` — it sends the operator to the
   * `--link` the republish (already the first step) prints for a divergent kit.
   */
  const corpoSemVinculoEsperado = (kit: string, anuncio: string, variacoes: string) =>
    `A composição das variações ${variacoes} do kit ${kit} mudou no ERP, mas o kit ` +
    `${anuncio} na Shopee continua com a receita antiga — a Shopee não permite alterar componentes ` +
    'nem quantidades de um kit, então o estoque que ela calcula pode estar errado. Republique o kit primeiro ' +
    '(publicar:anuncio sem opções): se a composição na Shopee já for a mesma, este aviso se resolve sozinho. ' +
    'Senão, recrie o kit com o --link que a republicação indicar (o --recriar exige o vínculo do kit ' +
    'antigo, e este aviso não o identificou) ou volte a composição ao que está na Shopee.';

  it('renders the sentence verbatim with every param', () => {
    expect(
      mensagem.corpo({ kit: KIT, anuncio: String(ITEM_ID), vinculo: VINCULO, variacoes: 'c1, c2' }),
    ).toBe(corpoEsperado(KIT, String(ITEM_ID), VINCULO, 'c1, c2'));
  });

  it('M30 — tells the operator to republish FIRST, before any recriar', () => {
    const corpo = mensagem.corpo({ kit: KIT, anuncio: '1', vinculo: VINCULO, variacoes: 'c1' });
    expect(corpo).toContain('Republique o kit primeiro');
    expect(corpo).toContain('este aviso se resolve sozinho');
    expect(corpo.indexOf('Republique o kit primeiro')).toBeLessThan(corpo.indexOf('recrie o kit'));
  });

  it('M30 — the recriar names its link: `--link {vinculo} --recriar`, never a bare `--recriar`', () => {
    const corpo = mensagem.corpo({ kit: KIT, anuncio: '1', vinculo: VINCULO, variacoes: 'c1' });
    expect(corpo).toContain(`publicar:anuncio --link ${VINCULO} --recriar`);
    // Every `--recriar` in the sentence is the one the link precedes.
    const ocorrencias = [...corpo.matchAll(/--recriar/g)];
    expect(ocorrencias).toHaveLength(1);
    expect(corpo).not.toMatch(/publicar:anuncio --recriar/);
  });

  it('renders `{}` with the placeholder in every slot, never "undefined" — and no link-less command', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toBe(corpoSemVinculoEsperado('—', '—', '—'));
    expect(corpo).not.toContain('undefined');
  });

  it('renders what the ONE builder writes, each param in its slot (writer → reader)', () => {
    const plano = avisoReceitaKitShopee({
      integracaoId: 'int-1',
      kitProdutoId: KIT,
      itemId: ITEM_ID,
      linkDocId: VINCULO,
      variacoesDivergentes: ['c2', 'c1'],
    });
    const aviso = comoArmazenado(plano);
    expect(aviso.tipo).toBe(TIPO_AVISO.shopeeKitReceitaDivergente);
    expect(aviso.urlInterna).toEqual({ rota: `/produtos/${KIT}`, campo: 'componentesKit' });
    expect(mensagem.corpo(aviso.params)).toBe(
      corpoEsperado(KIT, String(ITEM_ID), VINCULO, 'c1, c2'),
    );
  });

  it('renders the builder’s `—` for an unknown item and link without a dangling flag value', () => {
    const plano = avisoReceitaKitShopee({
      integracaoId: 'int-1',
      kitProdutoId: KIT,
      itemId: null,
      linkDocId: null,
      variacoesDivergentes: ['c1'],
    });
    const corpo = mensagem.corpo(comoArmazenado(plano).params);
    expect(corpo).toBe(corpoSemVinculoEsperado(KIT, '—', 'c1'));
    expect(corpo).not.toContain('undefined');
    expect(corpo).not.toContain('null');
  });

  it('M30 — a link the aviso does not know prints NO `--link —` command: `--recriar` requires `--link`', () => {
    // The builder's `—`, an absent param and an empty one all mean "no link".
    const semVinculo: Record<string, string>[] = [
      { kit: KIT, anuncio: '1', vinculo: '—', variacoes: 'c1' },
      { kit: KIT, anuncio: '1', variacoes: 'c1' },
      { kit: KIT, anuncio: '1', vinculo: '', variacoes: 'c1' },
    ];
    for (const params of semVinculo) {
      const corpo = mensagem.corpo(params);
      expect(corpo).toBe(corpoSemVinculoEsperado(KIT, '1', 'c1'));
      expect(corpo).not.toMatch(/--link\s+—/);
      expect(corpo).not.toMatch(/publicar:anuncio --link/);
      expect(corpo).not.toMatch(/publicar:anuncio --recriar/);
      expect([...corpo.matchAll(/--recriar/g)]).toHaveLength(1);
      // Still republish FIRST — the republish is what prints the `--link`.
      expect(corpo.indexOf('Republique o kit primeiro')).toBeLessThan(
        corpo.indexOf('recrie o kit'),
      );
    }
  });

  it('NEAR-MISS: a KNOWN link keeps the runnable command, byte-for-byte', () => {
    const corpo = mensagem.corpo({ kit: KIT, anuncio: '1', vinculo: VINCULO, variacoes: 'c1' });
    expect(corpo).toBe(corpoEsperado(KIT, '1', VINCULO, 'c1'));
    expect(corpo).not.toBe(corpoSemVinculoEsperado(KIT, '1', 'c1'));
  });

  it('is titled like its label and carries no runbook — the publish route/CLI is the fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.shopeeKitReceitaDivergente);
    expect(mensagem.runbook).toBeUndefined();
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

  it('treats an empty status like a missing one: no "(HTTP —)" clause', () => {
    expect(mensagem.corpo({ loja: 'Conta A', status: '' })).toBe(
      `A Loja Integrada recusou o token da loja Conta A. ${PARADA}`,
    );
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

/**
 * The step-3 import-stopped tipo, rendered with the params its producer (the
 * Loja Integrada order poller, PR 3-e) writes: `{ loja, motivo }`, `motivo` a
 * `MOTIVO_IMPORTACAO_PARADA_LI` CODE.
 */
describe('MENSAGENS_POR_TIPO.lojaIntegradaImportacaoParada', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaImportacaoParada];
  const FIM = 'Pedidos novos e alterados não chegam ao ERP enquanto isso não se resolver.';

  it('renders the conta and the motivo phrase in their slots', () => {
    expect(
      mensagem.corpo({ loja: 'Conta A', motivo: MOTIVO_IMPORTACAO_PARADA_LI.filtroIgnorado }),
    ).toBe(
      'Os pedidos da loja Conta A não estão sendo importados da Loja Integrada: a Loja ' +
        `Integrada ignorou o filtro de data da busca de pedidos. ${FIM}`,
    );
  });

  it('is TOTAL over the motivo codes: every one has its own phrase, never the fallback', () => {
    const frases = new Set<string>();
    for (const motivo of motivoImportacaoParadaLiSchema.options) {
      const corpo = mensagem.corpo({ loja: 'Conta A', motivo });
      expect(corpo, motivo).not.toContain('confira o registro');
      expect(corpo, motivo).not.toContain('undefined');
      expect(corpo, motivo).not.toContain(motivo);
      frases.add(corpo);
    }
    expect(frases.size).toBe(motivoImportacaoParadaLiSchema.options.length);
  });

  it('a code newer than this build, an inherited key or a missing motivo falls back', () => {
    for (const motivo of ['motivo-do-futuro', 'toString', '', 7]) {
      expect(mensagem.corpo({ loja: 'Conta A', motivo }), String(motivo)).toBe(
        'Os pedidos da loja Conta A não estão sendo importados da Loja Integrada: confira o ' +
          `registro da varredura de pedidos. ${FIM}`,
      );
    }
    expect(mensagem.corpo({})).toBe(
      'Os pedidos da loja — não estão sendo importados da Loja Integrada: confira o registro ' +
        `da varredura de pedidos. ${FIM}`,
    );
  });

  it('renders the producer plano as stored', () => {
    const aviso = comoArmazenado({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', motivo: MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      relogioEvento: 1_800_000_000_654_321,
    });
    expect(aviso.severidade).toBe(SEVERIDADE_AVISO.critico);
    expect(aviso.urlInterna?.rota).toBe('/canais/loja-integrada/int-1');
    expect(mensagem.corpo(aviso.params)).toBe(
      'Os pedidos da loja Conta A não estão sendo importados da Loja Integrada: a conta está ' +
        `ativa, mas não tem token salvo. ${FIM}`,
    );
  });

  it('is titled like its label, with a runbook for the motivos the app cannot fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaImportacaoParada);
    expect(mensagem.runbook).toContain('salve um token válido na conta');
    expect(mensagem.runbook).toContain('registro da varredura de pedidos');
  });
});

/**
 * The four order-import tipos of Loja Integrada steps 5–6, rendered with the
 * params their producer (the importer, PR 5-c) writes: `{ loja, pedido, codigo }`,
 * `{ loja, pedido, motivo }`, `{ loja, pedido }` and
 * `{ loja, formaEnvio, chave, motivo }`.
 */
describe('MENSAGENS_POR_TIPO.lojaIntegradaSituacaoDesconhecida', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaSituacaoDesconhecida];

  it('renders the order, the conta and the unknown codigo in their slots', () => {
    expect(mensagem.corpo({ loja: 'Conta A', pedido: '165', codigo: 'situacao_nova' })).toBe(
      'O pedido 165 da loja Conta A chegou da Loja Integrada com a situação "situacao_nova", ' +
        'que o ERP não conhece. O pedido foi importado e ficou marcado com um erro até a ' +
        'situação ser reconhecida — confira-o no painel da Loja Integrada. O aviso se encerra ' +
        'quando o pedido voltar com uma situação conhecida.',
    );
  });

  it('renders `{}` with placeholders, never "undefined"', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toContain('O pedido — da loja —');
    expect(corpo).toContain('"—"');
    expect(corpo).not.toContain('undefined');
  });

  it('is titled like its label, with a runbook naming the shared table — the fix is code', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaSituacaoDesconhecida);
    expect(mensagem.runbook).toContain('situacaoPedidoLojaIntegrada.ts');
  });
});

describe('MENSAGENS_POR_TIPO.lojaIntegradaPedidoContestado', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaPedidoContestado];
  const NAO_BLOQUEIA = 'O despacho NÃO fica bloqueado no ERP — confira o pedido antes de enviar.';
  const MANTIDO = 'O ERP manteve o estado e o pagamento do pedido';

  it('a dispute: the phrase, NOT blocked, and how it closes', () => {
    // The resolver closes the row on ANY later import that does not raise it —
    // a refund before the stock left included — so the sentence names the one
    // case that keeps it open instead of promising "a non-contest situação".
    expect(
      mensagem.corpo({
        loja: 'Conta A',
        pedido: '165',
        motivo: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
      }),
    ).toBe(
      'O pedido 165 da loja Conta A está contestado na Loja Integrada: o pagamento está em ' +
        `disputa. ${NAO_BLOQUEIA} O aviso se encerra quando a Loja Integrada tirar o pedido ` +
        'da disputa (por exemplo, pago de novo ou cancelado); se o pagamento for devolvido ' +
        'depois que o estoque do pedido já saiu, o aviso continua aberto, agora como devolução.',
    );
  });

  it('every refund-type motivo says the estado and payment were KEPT, and that it is final', () => {
    for (const motivo of [
      MOTIVO_PEDIDO_CONTESTADO_LI.chargeback,
      MOTIVO_PEDIDO_CONTESTADO_LI.devolvido,
      MOTIVO_PEDIDO_CONTESTADO_LI.devolvidoSemRetorno,
    ]) {
      const corpo = mensagem.corpo({ loja: 'Conta A', pedido: '165', motivo });
      expect(corpo, motivo).toContain(NAO_BLOQUEIA);
      expect(corpo, motivo).toContain(MANTIDO);
      expect(corpo, motivo).toContain('é final na Loja Integrada');
    }
    // Near-miss: the dispute is a hold, not a refund — nothing was "kept" there.
    expect(mensagem.corpo({ motivo: MOTIVO_PEDIDO_CONTESTADO_LI.disputa })).not.toContain(MANTIDO);
  });

  it('is TOTAL over the motivo codes: every one has its own phrase, never the fallback', () => {
    const frases = new Set<string>();
    for (const motivo of motivoPedidoContestadoLiSchema.options) {
      const corpo = mensagem.corpo({ loja: 'Conta A', pedido: '165', motivo });
      expect(corpo, motivo).not.toContain('o pagamento foi contestado.');
      expect(corpo, motivo).not.toContain('undefined');
      frases.add(corpo);
    }
    expect(frases.size).toBe(motivoPedidoContestadoLiSchema.options.length);
  });

  it('a newer code, an inherited key or a missing motivo falls back — still NOT blocked', () => {
    for (const motivo of ['motivo-do-futuro', 'toString', '', 3]) {
      const corpo = mensagem.corpo({ loja: 'Conta A', pedido: '165', motivo });
      expect(corpo, String(motivo)).toContain('o pagamento foi contestado.');
      expect(corpo, String(motivo)).toContain(NAO_BLOQUEIA);
    }
    expect(mensagem.corpo({})).not.toContain('undefined');
  });

  it('renders the producer plano as stored', () => {
    const aviso = comoArmazenado({
      tipo: TIPO_AVISO.lojaIntegradaPedidoContestado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', pedido: '165', motivo: MOTIVO_PEDIDO_CONTESTADO_LI.chargeback },
      motivo: MOTIVO_PEDIDO_CONTESTADO_LI.chargeback,
      urlInterna: { rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null },
      relogioEvento: 1_789_000_000_123_456,
    });
    expect(aviso.urlInterna?.rota).toBe(`/pedidos/${PEDIDO_ID}/editar`);
    expect(mensagem.corpo(aviso.params)).toContain('(chargeback)');
  });

  it('is titled like its label and carries no runbook — the pedido is the fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaPedidoContestado);
    expect(mensagem.runbook).toBeUndefined();
  });
});

describe('MENSAGENS_POR_TIPO.lojaIntegradaPedidoHub', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaPedidoHub];

  it('says the order was NOT imported, and why', () => {
    const corpo = mensagem.corpo({ loja: 'Conta A', pedido: '165' });
    expect(corpo).toContain('O pedido 165 da loja Conta A chegou à Loja Integrada por um hub');
    expect(corpo).toContain('não foi importado');
    expect(mensagem.corpo({})).not.toContain('undefined');
  });

  it('is titled like its label, with a runbook — the decision is outside the app', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaPedidoHub);
    expect(mensagem.runbook).toContain('não são importados');
  });
});

describe('MENSAGENS_POR_TIPO.lojaIntegradaFreteNaoSuportado', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaFreteNaoSuportado];

  it('renders the method, the conta and the motivo, and points at the mapping tab', () => {
    expect(
      mensagem.corpo({
        loja: 'Conta A',
        formaEnvio: 'Envio X - pac',
        chave: '1---PAC',
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo,
      }),
    ).toBe(
      'A forma de envio Envio X - pac da loja Conta A não pôde ser usada na importação de ' +
        'pedidos: o frete para o qual ela está mapeada está inativo. Os pedidos com ela foram ' +
        'importados com o frete da própria Loja Integrada, e o mapeamento é conferido de novo ' +
        'na hora da etiqueta. Revise o mapeamento na aba Mapeamento do Frete da conta; o aviso ' +
        'se encerra quando um pedido com essa forma de envio for importado depois da correção.',
    );
  });

  it('is TOTAL over the motivo codes, and falls back for anything else', () => {
    const frases = new Set<string>();
    for (const motivo of motivoFreteNaoSuportadoLiSchema.options) {
      const corpo = mensagem.corpo({ loja: 'Conta A', formaEnvio: 'X', motivo });
      expect(corpo, motivo).not.toContain('não pode ser usado.');
      frases.add(corpo);
    }
    expect(frases.size).toBe(motivoFreteNaoSuportadoLiSchema.options.length);
    for (const motivo of ['fob', 'toString', '']) {
      expect(mensagem.corpo({ motivo }), motivo).toContain('não pode ser usado.');
    }
  });

  it('renders the producer plano as stored, routed to the conta page', () => {
    const aviso = comoArmazenado({
      tipo: TIPO_AVISO.lojaIntegradaFreteNaoSuportado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      params: {
        loja: 'Conta A',
        formaEnvio: 'Envio X - pac',
        chave: '1---PAC',
        motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado,
      },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      relogioEvento: 1_789_000_000_000_001,
    });
    expect(aviso.urlInterna?.rota).toBe('/canais/loja-integrada/int-1');
    expect(mensagem.corpo(aviso.params)).toContain(
      'ela está mapeada para um tipo de frete que a importação não usa: mapeie-a para Melhor ' +
        'Envio, motoboy ou retirada na loja — ou para FOB ou outros, que a etiqueta resolve',
    );
  });

  it('`tipo-nao-suportado` names FOB and outros as a valid fix — a deliberate mapping raises no aviso', () => {
    // The import routes Melhor Envio, motoboy and retirada; a FOB/outros row is
    // routed at label time and resolves the aviso. A sentence that listed only
    // the first three would send the operator away from a correct mapping.
    const corpo = mensagem.corpo({
      loja: 'Conta A',
      formaEnvio: 'X',
      motivo: MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado,
    });
    expect(corpo).toContain('FOB ou outros');
    expect(corpo).not.toContain('só Melhor Envio');
  });

  it('is titled like its label and carries no runbook — the mapping tab is the fix', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaFreteNaoSuportado);
    expect(mensagem.runbook).toBeUndefined();
  });
});

/**
 * The reversal-after-the-label tipo (step 5, owner decision 2026-10-19),
 * rendered with the params its producer (the importer) writes:
 * `{ loja, pedido, motivo }`, `motivo` a `MOTIVO_REVERSAO_COM_ETIQUETA_LI` CODE.
 */
describe('MENSAGENS_POR_TIPO.lojaIntegradaReversaoComEtiqueta', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaReversaoComEtiqueta];
  const ACAO =
    'O ERP aplicou a situação ao pedido como de costume, mas não cancela a etiqueta nem a ' +
    'NF-e: cancele a etiqueta no Melhor Envio e a NF-e do pedido, se ela já foi emitida, antes ' +
    'que o pacote seja despachado.';
  const FIM =
    'Essa situação é final na Loja Integrada, então o aviso só se encerra se o pedido for ' +
    'reaberto no painel da loja.';

  it('a cancellation: the phrase, what to cancel, and why it does not close by itself', () => {
    expect(
      mensagem.corpo({
        loja: 'Conta A',
        pedido: '165',
        motivo: MOTIVO_REVERSAO_COM_ETIQUETA_LI.cancelado,
      }),
    ).toBe(
      'O pedido 165 da loja Conta A foi cancelado na Loja Integrada depois que a etiqueta dele ' +
        `já tinha sido comprada. ${ACAO} ${FIM}`,
    );
  });

  it('is TOTAL over the motivo codes: each its own phrase, never the fallback', () => {
    const frases = new Set<string>();
    for (const motivo of motivoReversaoComEtiquetaLiSchema.options) {
      const corpo = mensagem.corpo({ loja: 'Conta A', pedido: '165', motivo });
      expect(corpo, motivo).not.toContain('foi revertido');
      expect(corpo, motivo).toContain(ACAO);
      frases.add(corpo);
    }
    expect(frases.size).toBe(motivoReversaoComEtiquetaLiSchema.options.length);
  });

  it('a code newer than this build, an inherited key or a missing motivo falls back to the neutral phrase', () => {
    for (const motivo of ['motivo-do-futuro', 'toString', '', 7]) {
      expect(mensagem.corpo({ loja: 'Conta A', pedido: '165', motivo }), String(motivo)).toBe(
        'O pedido 165 da loja Conta A foi revertido na Loja Integrada depois que a etiqueta dele ' +
          `já tinha sido comprada. ${ACAO} ${FIM}`,
      );
    }
    expect(mensagem.corpo({})).not.toContain('undefined');
  });

  it('is titled like its label, with a runbook naming both cancellations', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaReversaoComEtiqueta);
    expect(mensagem.runbook).toBe(
      'Cancele a etiqueta no painel do Melhor Envio. Se a NF-e do pedido já foi emitida, ' +
        'cancele-a pelo ERP dentro do prazo de cancelamento da SEFAZ.',
    );
  });
});

/**
 * The paid-order-without-an-address tipo (step 5, owner decision 2026-10-19),
 * rendered with the params its producer (the notification pipeline's exhaustion
 * signal) writes: `{ loja, pedido }`.
 */
describe('MENSAGENS_POR_TIPO.lojaIntegradaPedidoPagoSemEndereco', () => {
  const mensagem = MENSAGENS_POR_TIPO[TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco];

  it('says the PAID order did not reach the ERP, why, that retrying stopped, and how it closes', () => {
    expect(mensagem.corpo({ loja: 'Conta A', pedido: '165' })).toBe(
      'O pedido 165 da loja Conta A está pago na Loja Integrada, mas chegou sem um endereço de ' +
        'entrega utilizável (CEP e logradouro) e por isso não entrou no ERP — nem o pedido, nem ' +
        'a atualização dele: sem endereço não há como comprar a etiqueta. A importação tentou de ' +
        'novo por algumas horas e parou. O aviso se encerra quando o pedido for importado.',
    );
  });

  it('renders `{}` with placeholders, never "undefined"', () => {
    const corpo = mensagem.corpo({});
    expect(corpo).toContain('O pedido — da loja —');
    expect(corpo).not.toContain('undefined');
  });

  it('renders the producer plano as stored: critico, routed to the conta page', () => {
    const aviso = comoArmazenado({
      tipo: TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Conta A', pedido: '165' },
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build('int-1'), campo: null },
      relogioEvento: 1_789_000_000_000_001,
    });
    expect(aviso.severidade).toBe(SEVERIDADE_AVISO.critico);
    expect(aviso.urlInterna?.rota).toBe('/canais/loja-integrada/int-1');
    expect(mensagem.corpo(aviso.params)).toContain('O pedido 165 da loja Conta A está pago');
  });

  it('is titled like its label, with a runbook — the fix is in the Loja Integrada painel, and a pickup is mapped', () => {
    expect(mensagem.titulo).toBe(TIPO_AVISO_LABELS.lojaIntegradaPedidoPagoSemEndereco);
    expect(mensagem.runbook).toBe(
      'Preencha o endereço de entrega do pedido no painel da Loja Integrada: a alteração faz o ' +
        'pedido voltar à importação. Se ele for de retirada na loja, mapeie antes a forma de ' +
        'envio dele para retirada na loja na aba Mapeamento do Frete da conta e depois altere o ' +
        'pedido no painel.',
    );
  });
});
