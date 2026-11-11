import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  CAMPO_RASCUNHO_SHOPEE,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  estadoPublicacaoRascunhoShopee,
  type AtributoDto,
  type AtributoInfoDto,
  type EstadoPublicacaoRascunhoShopee,
} from '@delfrance/schemas';
import type { ObjectViewSections } from '@delfrance/ui';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_FORA_DO_RASCUNHO_SHOPEE,
  FRASE_BUSCA_SEM_CANDIDATO_FORA_DO_RASCUNHO_SHOPEE,
  FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE,
  FRASE_ATESTACAO_SUPERADA_SHOPEE,
  FRASE_CORRIGIR_NO_SELLER_CENTRE_SHOPEE,
  FRASE_MARCA_PODE_NAO_VALER_SHOPEE,
  FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE,
  FRASE_RECUSA_SEM_PASSO_SHOPEE,
  MOTIVO_ANUNCIO_SHOPEE,
  PORTA_DA_IMPORTACAO_SHOPEE,
  ROTULO_ABRIR_TABELA_DE_MEDIDAS_SHOPEE,
  ROTULO_ABRIR_VARIACOES_SHOPEE,
  ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
  ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
  ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE,
  TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE,
  TEXTO_MOTIVO_ANUNCIO_SHOPEE,
  TITULO_ANUNCIO_INCERTO_SHOPEE,
  TITULO_RASCUNHO_PUBLICADO_SHOPEE,
  avisoDoDescarteComAnuncioSemVinculoShopee,
  formatarInstanteShopee,
  fraseDaPublicacaoSemRespostaShopee,
  fraseDoAnuncioIncertoShopee,
  fraseDoRascunhoPublicadoShopee,
  rotuloDaPublicacaoQueAdotaShopee,
  textoDaEtapaShopee,
  textoDoProblemaShopee,
} from '@/lib/shopee/anuncioProduto';
import { linhasDoEditorDeAtributosShopee } from '@/lib/shopee/atributosRascunho';
import {
  textoDaPublicacaoParadaDoRascunhoShopee,
  type SaidaDoProblemaShopee,
} from '@/lib/shopee/rascunho';
import {
  respostaPublicarShopeeSchema,
  type ProblemaShopee,
  type RespostaPublicarShopee,
} from '@/lib/shopee/wire';

import type { AcoesShopee } from './AcoesAnuncioShopee';
import type {
  DesfechoAcaoShopee as Desfecho,
  DesfechoAcaoShopeeProps,
  DesfechoDoRascunhoShopee,
} from './DesfechoAcaoShopee';

/**
 * The outcome panel of one listing (#1911 P11): a draft's 202, its no-answer
 * outcome, its 200, and the refusal rows' copy, surfaces and Seller-Centre
 * exits. Rendered for REAL over the REAL lib copy and the REAL state reading
 * (`estadoPublicacaoRascunhoShopee`); the only double is the ObjectView's
 * tab context (`useObjectViewSections`), which exists only inside the page.
 */

const h = vi.hoisted(() => ({ secoes: null as ObjectViewSections | null }));
vi.mock('@delfrance/ui', () => ({ useObjectViewSections: () => h.secoes }));

const {
  DesfechoAcaoShopee,
  FRASE_INCERTO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE,
  TITULO_PUBLICACAO_BLOQUEADA_SHOPEE,
  TITULO_PUBLICACAO_RECUSADA_SHOPEE,
  idDoCampoRascunhoShopee,
} = await import('./DesfechoAcaoShopee');
const { AtributosRascunhoShopee, TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE } =
  await import('./AtributosRascunhoShopee');

const CONTA = 'int-1';
const PRODUTO = 'prod-1';
const LINK = 'rasc00000000000000001';
const PAINEL = `shopee-desfecho-${LINK}`;
/** MILLISECONDS — the instant every reading is taken at (a fixture, never the clock). */
const AGORA = Date.UTC(2026, 9, 28, 12, 0, 0);

/** The draft's lock as the route stamps it — may have sent (its SKU stamped, §H Q3). */
function rascunhoTravado(desde: number, expiraEm: number): Record<string, unknown> {
  return {
    item_id: null,
    integracaoId: CONTA,
    publicacaoEmCurso: { desde, expiraEm, token: 'tok-1', sku: 'SKU-1' },
  };
}

/** em-andamento for 60 s more (`aguardarMs: 60 000`). */
const EM_ANDAMENTO = estadoPublicacaoRascunhoShopee(
  rascunhoTravado(AGORA - 10_000, AGORA + 60_000),
  AGORA,
);
/** The same lock long past its grace: `incerta`. */
const INCERTA = estadoPublicacaoRascunhoShopee(
  rascunhoTravado(AGORA - 1_000_000, AGORA - 500_000),
  AGORA,
);
const LIVRE: EstadoPublicacaoRascunhoShopee = { tipo: 'livre' };

function acoesBase(over: Partial<AcoesShopee> = {}): AcoesShopee {
  return {
    permitidas: true,
    bloqueadas: false,
    emVoo: null,
    desfechoDe: () => null,
    enderecavel: () => false,
    pedirPausa: vi.fn(),
    reativar: vi.fn(),
    reverificar: vi.fn(),
    republicar: vi.fn(),
    abrirKit: vi.fn(),
    incertoDe: () => null,
    repetirKit: vi.fn(),
    kitAberto: () => false,
    alternarKit: vi.fn(),
    ...over,
  };
}

function doRascunho(over: Partial<DesfechoDoRascunhoShopee> = {}): DesfechoDoRascunhoShopee {
  return {
    publicacao: LIVRE,
    nowMs: AGORA,
    skuEnviado: null,
    podePublicar: true,
    podeDescartar: true,
    onSaida: vi.fn(),
    ...over,
  };
}

function props(over: Partial<DesfechoAcaoShopeeProps>): DesfechoAcaoShopeeProps {
  return {
    contaId: CONTA,
    produtoId: PRODUTO,
    linkDocId: LINK,
    desfecho: { tipo: 'falha', mensagem: 'x' },
    acoes: acoesBase(),
    descricaoPropria: false,
    destinosDasSuperficies: { variacoes: null, medidas: null },
    rascunho: doRascunho(),
    ...over,
  };
}

function show(over: Partial<DesfechoAcaoShopeeProps>) {
  const r = render(
    <MantineTestProvider>
      <DesfechoAcaoShopee {...props(over)} />
    </MantineTestProvider>,
  );
  return {
    rerender: (outras: Partial<DesfechoAcaoShopeeProps>) =>
      r.rerender(
        <MantineTestProvider>
          <DesfechoAcaoShopee {...props(outras)} />
        </MantineTestProvider>,
      ),
  };
}

const painel = () => screen.getByTestId(PAINEL);
const botoes = (raiz: HTMLElement = painel()) =>
  within(raiz)
    .queryAllByRole('button')
    .map((b) => b.textContent);
const linha = (i = 0) => screen.getByTestId(`shopee-problema-${LINK}-${String(i)}`);

/** The route's 202 body, read through the REAL wire union (kit → item-incerto → item). */
function corpo202(over: Record<string, unknown> = {}): RespostaPublicarShopee {
  return respostaPublicarShopeeSchema.parse({
    arma: 'item',
    desfecho: 'incerto',
    linkDocId: LINK,
    aguardarMs: 240_000,
    reenvioVerificaSku: true,
    recusa: null,
    mensagem: 'Rode publicar:anuncio --link de novo.',
    ...over,
  });
}

/** The ordinary listing's 200, through the same union. */
function corpo200(over: Record<string, unknown> = {}): RespostaPublicarShopee {
  return respostaPublicarShopeeSchema.parse({
    itemId: 123456,
    estadoAnuncio: 'ativo',
    itemStatus: 'NORMAL',
    modelos: { total: 2, criados: 2, atualizados: 0, semFilho: 0 },
    fotos: { reutilizadas: 0, enviadas: 3, falhas: 0 },
    avisoShopee: null,
    taxInfoOmitido: null,
    tabelaDeMedidas: {
      sizeChartId: null,
      fonte: 'nenhuma',
      motivo: null,
      fotoOmitida: null,
      avisoObrigatoria: false,
    },
    ...over,
  });
}

function problema(over: Partial<ProblemaShopee>): ProblemaShopee {
  return { campo: null, motivo: 'outro', mensagem: 'Sentença do servidor.', acao: null, ...over };
}

function recusado(
  problemas: readonly ProblemaShopee[],
  over: Partial<Extract<Desfecho, { tipo: 'recusado' }>> = {},
): Desfecho {
  return {
    tipo: 'recusado',
    bloqueadaPeloErp: true,
    respondeAtestacao: false,
    etapa: null,
    problemas,
    mensagem: 'Publicação bloqueada.',
    pedidoKit: null,
    ...over,
  };
}

const importar = (itemIds: number[], vinculados: { itemId: number; produtoId: string }[]) => ({
  tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar,
  itemIds,
  vinculados,
});

beforeEach(() => {
  h.secoes = null;
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('DesfechoAcaoShopee — a draft’s 202 (`tipo: item-incerto`, rev. 2a #1/#7)', () => {
  it('the union routes the 202 to its own branch: the uncertain title and copy, never «falhou»', () => {
    const resposta = corpo202();
    expect(resposta.tipo).toBe('item-incerto');
    show({
      desfecho: { tipo: 'publicado', resposta, pedidoRascunho: { pausado: false } },
      rascunho: doRascunho({ publicacao: EM_ANDAMENTO }),
    });
    expect(within(painel()).getByText(TITULO_ANUNCIO_INCERTO_SHOPEE)).toBeTruthy();
    expect(resposta.tipo === 'item-incerto').toBe(true);
    if (resposta.tipo !== 'item-incerto') return;
    expect(
      within(painel()).getByText(fraseDoAnuncioIncertoShopee(resposta, EM_ANDAMENTO, AGORA)),
    ).toBeTruthy();
    expect(painel().textContent).not.toMatch(/falhou/i);
    expect(painel().textContent).not.toContain('republicado');
    // The CLI `mensagem` is not even on the wire.
    expect(painel().textContent).not.toContain('publicar:anuncio');
  });

  it('the wait is the SNAPSHOT’s reading — never the 202’s own `aguardarMs` (240 000)', () => {
    show({
      desfecho: { tipo: 'publicado', resposta: corpo202(), pedidoRascunho: { pausado: false } },
      rascunho: doRascunho({ publicacao: EM_ANDAMENTO }),
    });
    expect(EM_ANDAMENTO.tipo === 'em-andamento' && EM_ANDAMENTO.aguardarMs).toBe(60_000);
    expect(painel().textContent).toContain(formatarInstanteShopee(AGORA + 60_000)!);
    expect(painel().textContent).not.toContain(formatarInstanteShopee(AGORA + 240_000)!);
  });

  it('re-worded on EVERY render: the reading turning `incerta` drops the wait', () => {
    const desfecho: Desfecho = {
      tipo: 'publicado',
      resposta: corpo202(),
      pedidoRascunho: { pausado: false },
    };
    const r = show({ desfecho, rascunho: doRascunho({ publicacao: EM_ANDAMENTO }) });
    expect(painel().textContent).toContain('Aguarde até');
    r.rerender({ desfecho, rascunho: doRascunho({ publicacao: INCERTA }) });
    expect(painel().textContent).not.toContain('Aguarde');
    expect(painel().textContent).toContain('Publique de novo o mesmo rascunho');
  });

  it('`reenvioVerificaSku: false` ⇒ the SKU-first text (never "importe-o" before the SKU step)', () => {
    show({
      desfecho: {
        tipo: 'publicado',
        resposta: corpo202({ reenvioVerificaSku: false }),
        pedidoRascunho: { pausado: false },
      },
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    expect(painel().textContent).toContain('enviado sem SKU');
  });

  it('NEAR-MISS: `reenvioVerificaSku: true` ⇒ the ERP looks it up by the SKU sent', () => {
    show({
      desfecho: { tipo: 'publicado', resposta: corpo202(), pedidoRascunho: { pausado: false } },
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    expect(painel().textContent).not.toContain('enviado sem SKU');
    expect(painel().textContent).toContain('procura o anúncio pelo SKU enviado');
  });

  it('Shopee’s own answer shows when the 202 carries one', () => {
    show({
      desfecho: {
        tipo: 'publicado',
        resposta: corpo202({ recusa: { codigo: 'error_inner', fraseShopee: 'try later' } }),
        pedidoRascunho: { pausado: false },
      },
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    expect(painel().textContent).toContain('A Shopee respondeu: error_inner — try later.');
  });

  it('the link is no longer a draft (`rascunho: null`) ⇒ no "publish the same draft again"', () => {
    show({
      desfecho: { tipo: 'publicado', resposta: corpo202(), pedidoRascunho: { pausado: false } },
      rascunho: null,
    });
    expect(within(painel()).getByText(TITULO_ANUNCIO_INCERTO_SHOPEE)).toBeTruthy();
    expect(within(painel()).getByText(FRASE_INCERTO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE)).toBeTruthy();
    expect(painel().textContent).not.toContain('mesmo rascunho');
  });
});

describe('DesfechoAcaoShopee — a draft’s Publicar with no answer (`sem-resposta`, rev. 2a #15)', () => {
  it('em-andamento: «pode não ter terminado — aguarde até …», yellow, never «falhou»', () => {
    show({
      desfecho: { tipo: 'sem-resposta' },
      rascunho: doRascunho({ publicacao: EM_ANDAMENTO }),
    });
    const aviso = screen.getByTestId(`${PAINEL}-sem-resposta`);
    expect(
      within(aviso).getByText(fraseDaPublicacaoSemRespostaShopee(EM_ANDAMENTO, AGORA)),
    ).toBeTruthy();
    expect(aviso.textContent).toContain(formatarInstanteShopee(AGORA + 60_000)!);
    expect(painel().textContent).not.toMatch(/falhou/i);
    // The title's «yellow», checked (R3-tests#3): never the red of a failure.
    expect(aviso.getAttribute('style') ?? '').toContain(COR('yellow'));
    expect(aviso.getAttribute('style') ?? '').not.toContain(COR('red'));
  });

  it('re-worded from the CURRENT reading: `incerta` ⇒ «confira», no wait', () => {
    const r = show({
      desfecho: { tipo: 'sem-resposta' },
      rascunho: doRascunho({ publicacao: EM_ANDAMENTO }),
    });
    r.rerender({
      desfecho: { tipo: 'sem-resposta' },
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    const texto = screen.getByTestId(`${PAINEL}-sem-resposta`).textContent;
    expect(texto).toContain(fraseDaPublicacaoSemRespostaShopee(INCERTA, AGORA));
    expect(texto).not.toContain('aguarde');
  });

  it('the link is no longer a draft ⇒ the neutral line', () => {
    show({ desfecho: { tipo: 'sem-resposta' }, rascunho: null });
    expect(
      within(screen.getByTestId(`${PAINEL}-sem-resposta`)).getByText(
        FRASE_INCERTO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE,
      ),
    ).toBeTruthy();
  });

  it('NEAR-MISS: a definite `falha` reads its sentence (and no uncertain notice)', () => {
    show({ desfecho: { tipo: 'falha', mensagem: 'O rascunho não existe mais.' } });
    expect(painel().textContent).toBe('O rascunho não existe mais.');
    expect(screen.queryByTestId(`${PAINEL}-sem-resposta`)).toBeNull();
  });
});

describe('DesfechoAcaoShopee — a draft’s 200 (rev. 2a #14: not proof of a create)', () => {
  it('titled as a draft published, Shopee’s reading first — never «criado», never «republicado»', () => {
    const resposta = corpo200();
    show({ desfecho: { tipo: 'publicado', resposta, pedidoRascunho: { pausado: false } } });
    expect(within(painel()).getByText(TITULO_RASCUNHO_PUBLICADO_SHOPEE)).toBeTruthy();
    if (resposta.tipo !== 'item') throw new Error('item 200 expected');
    expect(
      within(painel()).getByText(
        fraseDoRascunhoPublicadoShopee(resposta, { pausadoPedido: false }),
      ),
    ).toBeTruthy();
    expect(painel().textContent).not.toMatch(/\bcriado\b/);
    expect(painel().textContent).not.toContain('republicado');
    // The update's own facts still follow.
    expect(painel().textContent).toContain('Fotos: 3 enviada(s)');
  });

  it('«Criar pausado» asked and Shopee reads it ACTIVE ⇒ says it did not apply', () => {
    show({
      desfecho: { tipo: 'publicado', resposta: corpo200(), pedidoRascunho: { pausado: true } },
    });
    expect(painel().textContent).toContain('«Criar pausado» não se aplicou');
  });

  it('NEAR-MISS: asked and Shopee reads it PAUSED ⇒ no caveat', () => {
    show({
      desfecho: {
        tipo: 'publicado',
        resposta: corpo200({ estadoAnuncio: 'pausado' }),
        pedidoRascunho: { pausado: true },
      },
    });
    expect(painel().textContent).not.toContain('«Criar pausado»');
  });

  it('NEAR-MISS: a live link’s republish (`pedidoRascunho: null`) keeps «Anúncio republicado»', () => {
    show({
      desfecho: { tipo: 'publicado', resposta: corpo200(), pedidoRascunho: null },
      rascunho: null,
    });
    expect(within(painel()).getByText('Anúncio republicado na Shopee')).toBeTruthy();
    expect(screen.queryByText(TITULO_RASCUNHO_PUBLICADO_SHOPEE)).toBeNull();
    expect(painel().textContent).not.toContain('Publicado na Shopee: anúncio');
  });
});

describe('DesfechoAcaoShopee — refusal rows: copy with the block’s produto (§C rule 3)', () => {
  const jaVinculada = (vinculados: { itemId: number; produtoId: string }[], itemIds: number[]) =>
    problema({
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada,
      mensagem: 'Rode importar:anuncio.',
      acao: importar(itemIds, vinculados),
    });

  it('an id linked to THIS produto reads «(deste produto)» — `produtoId` reaches the copy', () => {
    const p = jaVinculada([{ itemId: 111, produtoId: PRODUTO }], [111]);
    show({ desfecho: recusado([p]) });
    const texto = linha().textContent;
    expect(texto).toContain(textoDoProblemaShopee(p, LINK, PRODUTO));
    expect(texto).toContain('111 (deste produto)');
  });

  it('NEAR-MISS: an id linked to ANOTHER produto names it', () => {
    show({ desfecho: recusado([jaVinculada([{ itemId: 111, produtoId: 'prod-9' }], [111])]) });
    expect(linha().textContent).toContain('111 (do produto prod-9)');
  });

  it('a 422 holding #9 and #10 renders TWO rows', () => {
    show({
      desfecho: recusado([
        problema({
          motivo: MOTIVO_ANUNCIO_SHOPEE.anuncioExistenteSemVinculo,
          acao: importar([501], []),
        }),
        problema({
          motivo: MOTIVO_ANUNCIO_SHOPEE.anuncioExistenteDeOutroProduto,
          acao: importar([502], [{ itemId: 502, produtoId: 'prod-9' }]),
        }),
      ]),
    });
    expect(linha(0).textContent).toContain('501 (sem vínculo)');
    expect(linha(1).textContent).toContain('502 (do produto prod-9)');
  });
});

describe('DesfechoAcaoShopee — #2015: one `logistica-nao-confirmada` copy per refusal, every channel still named', () => {
  /** apps/shopee's N1 — one row per lost compulsory channel (spelled as `anuncioProduto.test.ts` does). */
  const n1 = (canal: number) =>
    `O canal obrigatório ${String(canal)} precisa de um tamanho, e o ERP não tem registro de ter ` +
    'lido da Shopee nem de ter enviado a ela o valor gravado neste vínculo, então esse valor ' +
    'não é reenviado. Importe o anúncio 1000123 para gravar os valores atuais da Shopee e ' +
    'publique de novo.';
  const lnc = (mensagem: string) =>
    problema({
      campo: 'logistic_info',
      motivo: MOTIVO_ANUNCIO_SHOPEE.logisticaNaoConfirmada,
      mensagem,
    });
  const copia = TEXTO_MOTIVO_ANUNCIO_SHOPEE[MOTIVO_ANUNCIO_SHOPEE.logisticaNaoConfirmada] ?? '?';
  const vezes = (texto: string, trecho: string) => texto.split(trecho).length - 1;

  it('two lost channels ⇒ row 0 reads the copy and channel A, row 1 ONLY channel B — the copy once in the alert', () => {
    show({ desfecho: recusado([lnc(n1(80003)), lnc(n1(80007))]), rascunho: null });
    expect(linha(0).textContent).toBe(`${copia} Detalhe: ${n1(80003)}`);
    expect(linha(1).textContent).toBe(`Detalhe: ${n1(80007)}`);
    expect(vezes(painel().textContent ?? '', copia)).toBe(1);
  });

  it('a later row with nothing to add (terminal text) is dropped — its siblings keep their ORIGINAL testids', () => {
    show({
      desfecho: recusado([
        lnc(n1(80003)),
        lnc('rode importar:anuncio --item 1000123'),
        problema({
          campo: 'logistic_info',
          motivo: 'logistica-sem-canal',
          mensagem: 'Nenhum canal obrigatório da loja pôde ser habilitado para este item.',
        }),
      ]),
      rascunho: null,
    });
    expect(linha(0).textContent).toBe(`${copia} Detalhe: ${n1(80003)}`);
    expect(screen.queryByTestId(`shopee-problema-${LINK}-1`)).toBeNull();
    expect(linha(2).textContent).toContain(
      'Nenhum canal obrigatório da loja pôde ser habilitado para este item.',
    );
  });

  it('an all-N1 refusal (apps/shopee adds no shop-wide sentence then) offers NO weight button ⟷ NEAR-MISS a `logistica-sem-canal` row beside it gets one', () => {
    h.secoes = {
      activeSection: 'Shopee',
      goToSection: vi.fn(),
      sectionOfField: (k) => (k === 'pesoBrutoKg' ? 'Dimensões e peso' : null),
    };
    const peso = { name: 'Abrir no produto: Dimensões e peso' };
    const r = show({ desfecho: recusado([lnc(n1(80003)), lnc(n1(80007))]), rascunho: null });
    expect(within(painel()).queryAllByRole('button', peso)).toEqual([]);
    expect(painel().textContent).not.toMatch(/confira peso/);
    r.rerender({
      desfecho: recusado([
        lnc(n1(80003)),
        problema({
          campo: 'logistic_info',
          motivo: 'logistica-sem-canal',
          mensagem: 'Nenhum canal obrigatório da loja pôde ser habilitado para este item.',
        }),
      ]),
      rascunho: null,
    });
    // Anti-vacuity: the same tab context DOES give the weight button to the
    // `logistica-sem-canal` row, so its absence above is the motivo's doing.
    expect(within(painel()).getAllByRole('button', peso)).toHaveLength(1);
    expect(within(linha(1)).getAllByRole('button', peso)).toHaveLength(1);
  });
});

describe('DesfechoAcaoShopee — K2-13: a draft is never published through a refusal row', () => {
  it('`republicar{linkDocId: <the draft>}` (P1’s rascunho-nao-nomeado) ⇒ NO button — a draft is not addressable', () => {
    const enderecavel = vi.fn(() => false);
    const acoes = acoesBase({ enderecavel });
    show({
      desfecho: recusado([
        problema({
          motivo: MOTIVO_ANUNCIO_SHOPEE.rascunhoNaoNomeado,
          acao: { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar, linkDocId: LINK },
        }),
      ]),
      acoes,
    });
    expect(botoes()).toEqual([]);
    expect(enderecavel).toHaveBeenCalledWith(LINK);
    expect(acoes.republicar).not.toHaveBeenCalled();
    expect(linha().textContent).toContain(
      TEXTO_MOTIVO_ANUNCIO_SHOPEE[MOTIVO_ANUNCIO_SHOPEE.rascunhoNaoNomeado]!,
    );
  });

  it('NEAR-MISS: the same acao naming a LIVE, addressable link keeps its «Republicar» button', () => {
    const acoes = acoesBase({ enderecavel: (id) => id === 'vivo-1' });
    show({
      desfecho: recusado([
        problema({
          motivo: 'vinculo-substituido',
          acao: { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.republicar, linkDocId: 'vivo-1' },
        }),
      ]),
      acoes,
    });
    fireEvent.click(within(painel()).getByRole('button', { name: 'Republicar o vínculo vivo-1' }));
    expect(acoes.republicar).toHaveBeenCalledWith(CONTA, 'vivo-1');
  });
});

describe('DesfechoAcaoShopee — the Seller-Centre attestation exits (§C #7, #8)', () => {
  const semSku = problema({
    motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaSemSku,
    mensagem: 'Use --confirmar-criacao-incerta.',
  });

  it('`criacao-incerta-sem-sku` ⇒ ONE exit, handed to the editor — never a re-send from here', () => {
    const rascunho = doRascunho({ publicacao: INCERTA });
    const acoes = acoesBase();
    show({ desfecho: recusado([semSku]), rascunho, acoes });
    expect(botoes()).toEqual([ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE]);
    fireEvent.click(
      within(painel()).getByRole('button', { name: ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE }),
    );
    expect(rascunho.onSaida).toHaveBeenCalledWith<[SaidaDoProblemaShopee]>({
      tipo: 'publicar-atestando',
      rotulo: ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
      adota: [],
      // The server cannot look a SKU-less attempt up (KNOWN #12).
      varre: false,
    });
    expect(acoes.republicar).not.toHaveBeenCalled();
    // The CLI sentence is never on screen.
    expect(painel().textContent).not.toContain('--confirmar');
  });

  it('NEAR-MISS: the draft’s Publicar cannot act now ⇒ the exit is disabled', () => {
    show({ desfecho: recusado([semSku]), rascunho: doRascunho({ podePublicar: false }) });
    expect(
      (
        within(painel()).getByRole('button', {
          name: ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('NEAR-MISS: every write button blocked (`acoes.bloqueadas`) ⇒ disabled too', () => {
    show({ desfecho: recusado([semSku]), acoes: acoesBase({ bloqueadas: true }) });
    expect(
      (
        within(painel()).getByRole('button', {
          name: ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it.each([
    ['a renamed slug', { motivo: 'criacao-incerta-sem-sku-v2' }],
    ['a live listing’s row (`rascunho: null`)', {}],
    ['no write permission', {}],
  ])('NEAR-MISS: %s ⇒ no exit', (caso, over) => {
    show({
      desfecho: recusado([{ ...semSku, ...over }]),
      rascunho: caso.startsWith('a live') ? null : doRascunho(),
      acoes: acoesBase({ permitidas: !caso.startsWith('no write') }),
    });
    expect(botoes()).toEqual([]);
  });

  const jaVinculada = (itemIds: number[], vinculados: { itemId: number; produtoId: string }[]) =>
    problema({
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada,
      acao: importar(itemIds, vinculados),
    });

  it('`criacao-incerta-ja-vinculada`, every candidate linked ⇒ TWO exits: discard, and a deliberate second listing', () => {
    const rascunho = doRascunho({ publicacao: INCERTA });
    show({
      desfecho: recusado([jaVinculada([111], [{ itemId: 111, produtoId: PRODUTO }])]),
      rascunho,
    });
    expect(botoes()).toEqual([
      ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
      ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE,
    ]);
    expect(linha().textContent).not.toContain('sem vínculo');
    fireEvent.click(
      within(painel()).getByRole('button', { name: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE }),
    );
    expect(rascunho.onSaida).toHaveBeenLastCalledWith({
      tipo: 'descartar-atestando',
      rotulo: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
      aviso: null,
    });
    fireEvent.click(
      within(painel()).getByRole('button', { name: ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE }),
    );
    expect(rascunho.onSaida).toHaveBeenLastCalledWith({
      tipo: 'publicar-atestando',
      rotulo: ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE,
      adota: [],
      varre: true,
    });
  });

  it('the MIXED case (one linked + one unlinked candidate): «sem vínculo», an ADOPTION, and the discard warned', () => {
    const rascunho = doRascunho({ publicacao: INCERTA });
    show({
      desfecho: recusado([jaVinculada([111, 222], [{ itemId: 111, produtoId: PRODUTO }])]),
      rascunho,
    });
    const texto = linha().textContent;
    expect(texto).toContain('222 (sem vínculo)');
    expect(texto).toContain('111 (deste produto)');
    // Review round 3: the discard's warning says the free listing stays,
    // unlinked — never «importe-o» (the shared SKU would mint another produto).
    expect(texto).toContain(
      'O anúncio sem vínculo 222 continua na Shopee, sem vínculo no ERP — o descarte não o ' +
        'vincula a nada.',
    );
    expect(texto).not.toContain(PORTA_DA_IMPORTACAO_SHOPEE);
    expect(texto).not.toMatch(/importe-o/i);
    const adota = rotuloDaPublicacaoQueAdotaShopee([222]);
    expect(botoes()).toEqual([ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE, adota]);
    expect(botoes()).not.toContain(ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE);
    fireEvent.click(within(painel()).getByRole('button', { name: adota }));
    expect(rascunho.onSaida).toHaveBeenLastCalledWith({
      tipo: 'publicar-atestando',
      rotulo: adota,
      adota: [222],
      varre: true,
    });
    fireEvent.click(
      within(painel()).getByRole('button', { name: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE }),
    );
    expect(rascunho.onSaida).toHaveBeenLastCalledWith({
      tipo: 'descartar-atestando',
      rotulo: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
      aviso: avisoDoDescarteComAnuncioSemVinculoShopee([222]),
    });
  });

  it('R8-copy#1 (round 2): NO candidate linked (the §I1 refusal of a create that found a free listing) ⇒ the ADOPTION exit alone — never «É o anúncio da tentativa», whose dialog says «vinculado no ERP» ⟷ NEAR-MISS the same free id beside ONE linked candidate keeps both', () => {
    const rascunho = doRascunho({ publicacao: INCERTA });
    const adota = rotuloDaPublicacaoQueAdotaShopee([222]);
    const r = show({ desfecho: recusado([jaVinculada([222], [])]), rascunho });
    expect(botoes()).toEqual([adota]);
    expect(linha().textContent).toContain('222 (sem vínculo)');
    expect(linha().textContent).not.toContain(avisoDoDescarteComAnuncioSemVinculoShopee([222]));
    fireEvent.click(within(painel()).getByRole('button', { name: adota }));
    expect(rascunho.onSaida).toHaveBeenLastCalledWith({
      tipo: 'publicar-atestando',
      rotulo: adota,
      adota: [222],
      varre: true,
    });
    expect(rascunho.onSaida).toHaveBeenCalledTimes(1);

    r.rerender({
      desfecho: recusado([jaVinculada([111, 222], [{ itemId: 111, produtoId: PRODUTO }])]),
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    expect(botoes()).toEqual([ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE, adota]);
  });

  it('review round 3 (VERIFY-1 mixed-row PARTIAL): a MIXED row whose linked candidate is ANOTHER produto’s never shows the import door anywhere on the row — sentence nor discard warning ⟷ NEAR-MISS an all-linked row (a discard exit, no warning) keeps its text, and an all-free row keeps the door', () => {
    const contexto = { publicacao: INCERTA, skuEnviado: null, respondeAtestacao: false };
    const mista = jaVinculada([111, 222], [{ itemId: 111, produtoId: 'prod-9' }]);
    const r = show({ desfecho: recusado([mista]), rascunho: doRascunho({ publicacao: INCERTA }) });
    expect(linha().textContent).toContain('111 (do produto prod-9)');
    expect(linha().textContent).toContain('222 (sem vínculo)');
    expect(botoes()).toContain(ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE);
    expect(linha().textContent).not.toContain(PORTA_DA_IMPORTACAO_SHOPEE);
    expect(linha().textContent).not.toMatch(/importe-o/i);

    // NEAR-MISS: every candidate linked — the discard exit is there, it warns
    // nothing, and the row reads exactly the lib's sentence (today's text).
    const ligada = jaVinculada([111], [{ itemId: 111, produtoId: 'prod-9' }]);
    r.rerender({ desfecho: recusado([ligada]), rascunho: doRascunho({ publicacao: INCERTA }) });
    expect(botoes()).toContain(ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE);
    expect(linha().textContent).toBe(
      `${textoDoProblemaShopee(ligada, LINK, PRODUTO, contexto)}` +
        `${ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE}${ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE}`,
    );
    // NEAR-MISS: every candidate free — the import IS that row's door (no discard exit there).
    r.rerender({
      desfecho: recusado([jaVinculada([222], [])]),
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    expect(linha().textContent).toContain(PORTA_DA_IMPORTACAO_SHOPEE);
  });

  it('NEAR-MISS: the discard exit is gated by `podeDescartar`, the publish one by `podePublicar`', () => {
    show({
      desfecho: recusado([jaVinculada([111], [{ itemId: 111, produtoId: PRODUTO }])]),
      rascunho: doRascunho({ podeDescartar: false, podePublicar: true }),
    });
    const [descartar, publicar] = within(painel()).getAllByRole('button') as HTMLButtonElement[];
    expect(descartar!.disabled).toBe(true);
    expect(publicar!.disabled).toBe(false);
  });

  it('`criacao-incerta-ambigua` WITH its importar ⇒ the copy, the ids — and NO button (never the flag, no SKU route; «Importar» is text)', () => {
    // The tab context WOULD name the SKU's tab: what keeps the button away is the allow-list.
    h.secoes = {
      activeSection: 'Shopee',
      goToSection: vi.fn(),
      sectionOfField: (k) => (k === 'sku' ? 'Dados gerais' : null),
    };
    const p = problema({
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaAmbigua,
      campo: 'item_sku',
      acao: importar([301, 302], []),
    });
    show({ desfecho: recusado([p]), rascunho: doRascunho({ publicacao: INCERTA }) });
    expect(botoes()).toEqual([]);
    expect(linha().textContent).toContain(
      TEXTO_MOTIVO_ANUNCIO_SHOPEE[MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaAmbigua]!,
    );
    expect(linha().textContent).toContain('301 (sem vínculo), 302 (sem vínculo)');
  });

  it('NEAR-MISS: the acao-LESS ambígua (the SKU moved) ⇒ its own copy and the SKU route, still no flag', () => {
    const goToSection = vi.fn();
    h.secoes = {
      activeSection: 'Shopee',
      goToSection,
      sectionOfField: (k) => (k === 'sku' ? 'Dados gerais' : null),
    };
    show({
      desfecho: recusado([
        problema({
          motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaAmbigua,
          campo: 'item_sku',
          mensagem: 'Rode importar:anuncio.',
        }),
      ]),
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    expect(botoes()).toEqual(['Abrir no produto: Dados gerais']);
    expect(linha().textContent).toContain('O SKU do produto mudou desde a tentativa incerta');
    expect(linha().textContent).not.toContain('importar:anuncio');
    fireEvent.click(
      within(painel()).getByRole('button', { name: 'Abrir no produto: Dados gerais' }),
    );
    expect(goToSection).toHaveBeenCalledWith('Dados gerais');
  });

  it.each([
    MOTIVO_ANUNCIO_SHOPEE.buscaDeAnuncioIncompleta,
    MOTIVO_ANUNCIO_SHOPEE.anuncioExistenteSemVinculo,
    MOTIVO_ANUNCIO_SHOPEE.buscaDeAnuncioExistenteIncompleta,
  ])('NEAR-MISS: %s ⇒ no attestation exit', (motivo) => {
    show({
      desfecho: recusado([problema({ motivo })]),
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    expect(botoes()).toEqual([]);
  });
});

/*
 * #1911 P13 — `attribute_list` on a draft routes to the «Atributos» section,
 * whose ROOT carries the field id (`AtributosRascunhoShopee` stamps it): the
 * section is rendered for REAL over the REAL model, so the focus lands on what
 * Mantine actually renders. Public BR taxonomy (100408 «Tipo de Conexão»,
 * 2498 / 2530); no stored value.
 */
const infoDoAtributo = (p: Partial<AtributoInfoDto>): AtributoInfoDto => ({
  inputType: null,
  inputValidationType: 0,
  formatType: 1,
  dateFormatType: null,
  attributeUnitList: null,
  maxValueCount: null,
  introduction: null,
  isOem: false,
  supportSearchValue: false,
  ...p,
});
const TIPO_DE_CONEXAO: AtributoDto = {
  attributeId: 100408,
  mandatory: true,
  name: 'Tipo de Conexão',
  attributeInfo: infoDoAtributo({ inputType: 1 }),
  attributeValueList: [
    {
      valueId: 2498,
      name: 'Com fio, Sem conexão ou Outros',
      valueUnit: null,
      childAttributeList: [],
    },
    {
      valueId: 2530,
      name: 'Sem fio (Bluetooth, Wifi, Radiofrequência)',
      valueUnit: null,
      childAttributeList: [],
    },
  ],
};

/** 100134 «Material» (input 5: a MultiSelect plus custom chips), public BR taxonomy. */
const MATERIAL: AtributoDto = {
  attributeId: 100134,
  mandatory: false,
  name: 'Material',
  attributeInfo: infoDoAtributo({ inputType: 5, inputValidationType: 2, maxValueCount: 5 }),
  attributeValueList: [
    { valueId: 1207, name: 'Plástico', valueUnit: null, childAttributeList: [] },
    { valueId: 1218, name: 'Vidro', valueUnit: null, childAttributeList: [] },
  ],
};
/** Synthetic: a list-less input 5 — custom chips and a composer only. */
const TEXTOS: AtributoDto = {
  attributeId: 900011,
  mandatory: false,
  name: 'Sintético textos',
  attributeInfo: infoDoAtributo({ inputType: 5, inputValidationType: 2 }),
  attributeValueList: [],
};

/** The REAL section of this draft, beside the panel: `editavel` as the block would say. */
function secaoDeAtributos(
  editavel: boolean,
  arvore: readonly AtributoDto[] = [TIPO_DE_CONEXAO],
  lista: Parameters<typeof linhasDoEditorDeAtributosShopee>[0]['lista'] = null,
) {
  const { linhas, semLugar, removidosAoSalvar } = linhasDoEditorDeAtributosShopee({
    arvore: { atributos: [...arvore], truncated: false },
    lista,
    guardados: lista,
    digitacoes: {},
  });
  render(
    <MantineTestProvider>
      <AtributosRascunhoShopee
        linkDocId={LINK}
        leitura={{
          tipo: TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.lida,
          truncated: false,
          warning: null,
        }}
        linhas={linhas}
        semLugar={semLugar}
        removidosAoSalvar={removidosAoSalvar}
        publicacao={LIVRE}
        editavel={editavel}
        onAtributo={vi.fn()}
        ensaiarAdicao={() => null}
      />
    </MantineTestProvider>,
  );
  return screen.getByTestId(`shopee-rascunho-atributos-${LINK}`);
}

describe('DesfechoAcaoShopee — «Corrigir no rascunho: Atributos» (#1911 P13)', () => {
  it.each(['attribute_list', 'attribute_list[COLOR]'])(
    'o `%s` de um rascunho ⇒ «Corrigir no rascunho: Atributos», que FOCA o primeiro controle habilitado da seção — o campo da primeira linha',
    (campo) => {
      const secao = secaoDeAtributos(true);
      // The field id is the section's OWN root — the attributes', never the category's.
      expect(secao.id).toBe(idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.attributes));
      show({ desfecho: recusado([problema({ campo, motivo: 'atributo-obrigatorio' })]) });
      expect(botoes()).toEqual(['Corrigir no rascunho: Atributos']);
      fireEvent.click(
        within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Atributos' }),
      );
      const campoDoAtributo = within(secao).getByRole('combobox', { name: /Tipo de Conexão/ });
      expect(document.activeElement).toBe(campoDoAtributo);
      expect(campoDoAtributo.getAttribute('type')).not.toBe('hidden');
    },
  );

  it('QUASE-PAR: uma seção SOMENTE LEITURA (todo controle desabilitado) não recebe o foco — nada mais se move', () => {
    const secao = secaoDeAtributos(false);
    show({
      desfecho: recusado([problema({ campo: 'attribute_list', motivo: 'atributo-obrigatorio' })]),
    });
    fireEvent.click(
      within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Atributos' }),
    );
    expect(secao.contains(document.activeElement)).toBe(false);
  });

  it('o primeiro controle habilitado nunca é um input OCULTO (o Mantine guarda um ao lado de cada Select) ⟷ QUASE-PAR: nem um desabilitado', () => {
    const wrapper = document.createElement('div');
    wrapper.id = idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.attributes);
    const oculto = document.createElement('input');
    oculto.type = 'hidden';
    const desligado = document.createElement('input');
    desligado.disabled = true;
    const ligado = document.createElement('input');
    wrapper.append(oculto, desligado, ligado);
    document.body.appendChild(wrapper);
    show({
      desfecho: recusado([problema({ campo: 'attribute_list', motivo: 'atributo-obrigatorio' })]),
    });
    fireEvent.click(
      within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Atributos' }),
    );
    expect(document.activeElement).toBe(ligado);
  });

  it('a primeira linha é um MultiSelect COM valor (100134 Material, 1207 gravado) ⇒ o foco vai para o campo de busca do MultiSelect, nunca para o X do pill', () => {
    const secao = secaoDeAtributos(
      true,
      [MATERIAL],
      [{ attribute_id: 100134, attribute_value_list: [{ value_id: 1207 }] }],
    );
    show({
      desfecho: recusado([problema({ campo: 'attribute_list', motivo: 'atributo-obrigatorio' })]),
    });
    fireEvent.click(
      within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Atributos' }),
    );
    const ativo = document.activeElement as HTMLElement;
    expect(ativo.tagName).toBe('INPUT');
    expect(ativo).toBe(within(secao).getByRole('combobox', { name: /Material/ }));
  });

  it('QUASE-PAR: uma linha de textos múltiplos com um chip ⇒ o foco vai para o compositor (Adicionar outro valor), nunca para «Remover …»', () => {
    const secao = secaoDeAtributos(
      true,
      [TEXTOS],
      [
        {
          attribute_id: 900011,
          attribute_value_list: [{ value_id: 0, original_value_name: 'Valor A' }],
        },
      ],
    );
    expect(within(secao).getByRole('button', { name: 'Remover Valor A' })).toBeTruthy();
    show({
      desfecho: recusado([problema({ campo: 'attribute_list', motivo: 'atributo-obrigatorio' })]),
    });
    fireEvent.click(
      within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Atributos' }),
    );
    expect(document.activeElement).toBe(
      within(secao).getByRole('textbox', { name: 'Adicionar outro valor' }),
    );
  });

  it('QUASE-PAR: um wrapper só com botões (o seletor de categoria) foca o botão habilitado — nunca um fora da ordem de tabulação ou oculto', () => {
    const wrapper = document.createElement('div');
    wrapper.id = idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.attributes);
    const oculto = document.createElement('button');
    oculto.tabIndex = -1;
    oculto.setAttribute('aria-hidden', 'true');
    const ligado = document.createElement('button');
    wrapper.append(oculto, ligado);
    document.body.appendChild(wrapper);
    show({
      desfecho: recusado([problema({ campo: 'attribute_list', motivo: 'atributo-obrigatorio' })]),
    });
    fireEvent.click(
      within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Atributos' }),
    );
    expect(document.activeElement).toBe(ligado);
  });

  it('QUASE-PAR: o `attribute_list` de um anúncio PUBLICADO ⇒ «Corrigir no Seller Centre», texto sem botão', () => {
    show({
      desfecho: recusado([problema({ campo: 'attribute_list', motivo: 'atributo-obrigatorio' })]),
      rascunho: null,
    });
    expect(botoes()).toEqual([]);
    expect(linha().textContent).toContain(FRASE_CORRIGIR_NO_SELLER_CENTRE_SHOPEE);
  });
});

describe('DesfechoAcaoShopee — campo → the surface that fixes it (D17, DC §2.9)', () => {
  it('a draft’s `item_name` ⇒ «Corrigir no rascunho: Título», which FOCUSES that field of this draft', () => {
    const campo = document.createElement('input');
    campo.id = idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.itemName);
    document.body.appendChild(campo);
    show({
      desfecho: recusado([problema({ campo: 'item_name', motivo: 'titulo-fora-da-faixa' })]),
    });
    fireEvent.click(within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Título' }));
    expect(document.activeElement).toBe(campo);
  });

  it('a picker field (the brand) ⇒ its wrapper’s first ENABLED control takes the focus', () => {
    const wrapper = document.createElement('div');
    wrapper.id = idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.marca);
    const desligado = document.createElement('button');
    desligado.disabled = true;
    const ligado = document.createElement('input');
    wrapper.append(desligado, ligado);
    document.body.appendChild(wrapper);
    show({ desfecho: recusado([problema({ campo: 'brand', motivo: 'marca-invalida' })]) });
    fireEvent.click(within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Marca' }));
    expect(document.activeElement).toBe(ligado);
  });

  it('a Shopee BRAND refusal adds «a marca pode não valer…»', () => {
    show({ desfecho: recusado([problema({ campo: 'brand', motivo: 'marca-invalida' })]) });
    expect(linha().textContent).toContain(FRASE_MARCA_PODE_NAO_VALER_SHOPEE);
  });

  it('NEAR-MISS: `marca-nao-escolhida` (nothing was rejected) ⇒ the button, never that sentence', () => {
    show({
      desfecho: recusado([
        problema({ campo: 'brand', motivo: MOTIVO_ANUNCIO_SHOPEE.marcaNaoEscolhida }),
      ]),
    });
    expect(
      within(painel()).getByRole('button', { name: 'Corrigir no rascunho: Marca' }),
    ).toBeTruthy();
    expect(linha().textContent).not.toContain(FRASE_MARCA_PODE_NAO_VALER_SHOPEE);
  });

  it('NEAR-MISS: a PUBLISHED listing’s `item_name` ⇒ «Corrigir no Seller Centre», text with no button', () => {
    show({
      desfecho: recusado([problema({ campo: 'item_name', motivo: 'titulo-fora-da-faixa' })]),
      rascunho: null,
    });
    expect(botoes()).toEqual([]);
    expect(linha().textContent).toContain(FRASE_CORRIGIR_NO_SELLER_CENTRE_SHOPEE);
  });

  it('a produto field (`weight`) ⇒ «Abrir no produto: <aba>», switching the ObjectView tab', () => {
    const goToSection = vi.fn();
    h.secoes = {
      activeSection: 'Shopee',
      goToSection,
      sectionOfField: (k) => (k === 'pesoBrutoKg' ? 'Dimensões e peso' : null),
    };
    show({ desfecho: recusado([problema({ campo: 'weight', motivo: 'sem-peso' })]) });
    fireEvent.click(
      within(painel()).getByRole('button', { name: 'Abrir no produto: Dimensões e peso' }),
    );
    expect(goToSection).toHaveBeenCalledWith('Dimensões e peso');
  });

  it('NEAR-MISS: outside the ObjectView (no tab to name) ⇒ no button, the sentence stays', () => {
    h.secoes = null;
    show({ desfecho: recusado([problema({ campo: 'weight', motivo: 'sem-peso' })]) });
    expect(botoes()).toEqual([]);
    expect(linha().textContent).toContain('Sentença do servidor.');
  });

  it('NEAR-MISS: inside the ObjectView but the field has NO tab (no rendered input) ⇒ no dead button', () => {
    const goToSection = vi.fn();
    h.secoes = { activeSection: 'Shopee', goToSection, sectionOfField: () => null };
    show({ desfecho: recusado([problema({ campo: 'weight', motivo: 'sem-peso' })]) });
    expect(botoes()).toEqual([]);
    expect(goToSection).not.toHaveBeenCalled();
  });

  it('`description` with no text of the draft’s own ⇒ the produto’s Descrição tab', () => {
    const goToSection = vi.fn();
    h.secoes = {
      activeSection: 'Shopee',
      goToSection,
      sectionOfField: (k) => (k === 'extraData' ? 'Descrição' : null),
    };
    show({
      desfecho: recusado([problema({ campo: 'description', motivo: 'descricao-curta' })]),
      descricaoPropria: false,
    });
    fireEvent.click(within(painel()).getByRole('button', { name: 'Abrir no produto: Descrição' }));
    expect(goToSection).toHaveBeenCalledWith('Descrição');
  });

  it('NEAR-MISS: the draft has its OWN description ⇒ «Corrigir no rascunho: Descrição»', () => {
    show({
      desfecho: recusado([problema({ campo: 'description', motivo: 'descricao-curta' })]),
      descricaoPropria: true,
    });
    expect(botoes()).toEqual(['Corrigir no rascunho: Descrição']);
  });

  it('a variation root ⇒ «Abrir Variações», a link to the page the editor names', () => {
    show({
      desfecho: recusado([problema({ campo: 'tier_variation[0].name', motivo: 'opcoes-demais' })]),
      destinosDasSuperficies: { variacoes: '/variacoes/g-1', medidas: null },
    });
    const link = within(painel()).getByRole('link', { name: ROTULO_ABRIR_VARIACOES_SHOPEE });
    expect(link.getAttribute('href')).toBe('/variacoes/g-1');
  });

  it('NEAR-MISS: the editor names no variations page ⇒ no link', () => {
    show({
      desfecho: recusado([problema({ campo: 'tier_variation', motivo: 'opcoes-demais' })]),
      destinosDasSuperficies: { variacoes: null, medidas: '/medidas/m-1' },
    });
    expect(within(painel()).queryByRole('link')).toBeNull();
  });

  it('NEAR-MISS (§H): the native kit’s `tier_variation_list` is UNMAPPED — the sentence, no button, no link', () => {
    show({
      desfecho: recusado([
        problema({
          campo: 'tier_variation_list[0]',
          motivo: 'opcoes-demais',
          mensagem: 'A opção "X" do kit tem nome longo demais.',
        }),
      ]),
      destinosDasSuperficies: { variacoes: '/variacoes/g-1', medidas: '/medidas/m-1' },
    });
    expect(botoes()).toEqual([]);
    expect(within(painel()).queryByRole('link')).toBeNull();
    expect(linha().textContent).toContain('A opção "X" do kit tem nome longo demais.');
  });

  it('`size_chart_info` ⇒ «Abrir a tabela de medidas»', () => {
    show({
      desfecho: recusado([problema({ campo: 'size_chart_info', motivo: 'tabela-de-medidas' })]),
      destinosDasSuperficies: { variacoes: null, medidas: '/medidas/m-1' },
    });
    expect(
      within(painel())
        .getByRole('link', { name: ROTULO_ABRIR_TABELA_DE_MEDIDAS_SHOPEE })
        .getAttribute('href'),
    ).toBe('/medidas/m-1');
  });

  // `attribute_list[COLOR]` left this list in #1911 P13 (it routes to «Atributos»
  // now — the describe below); `attribute_lists` is its near miss.
  it.each(['linkDocId', 'item_names', 'shop', 'attribute_lists'])(
    'NEAR-MISS: an unmapped campo on a draft (%s) ⇒ the sentence, no button',
    (campo) => {
      h.secoes = {
        activeSection: 'Shopee',
        goToSection: vi.fn(),
        sectionOfField: () => 'Qualquer',
      };
      show({ desfecho: recusado([problema({ campo, motivo: 'outro' })]) });
      expect(botoes()).toEqual([]);
      expect(within(painel()).queryByRole('link')).toBeNull();
      expect(linha().textContent).toContain('Sentença do servidor.');
    },
  );

  it('the SKU allow-list: `anuncio-existente-de-outro-produto` ⇒ «Abrir no produto» (SKU)', () => {
    h.secoes = {
      activeSection: 'Shopee',
      goToSection: vi.fn(),
      sectionOfField: (k) => (k === 'sku' ? 'Dados gerais' : null),
    };
    show({
      desfecho: recusado([
        problema({
          campo: 'item_sku',
          motivo: MOTIVO_ANUNCIO_SHOPEE.anuncioExistenteDeOutroProduto,
          acao: importar([502], [{ itemId: 502, produtoId: 'prod-9' }]),
        }),
      ]),
    });
    expect(botoes()).toEqual(['Abrir no produto: Dados gerais']);
  });

  it('NEAR-MISS: a motivo outside the allow-list carrying `item_sku` (Shopee’s duplicate refusal) ⇒ none', () => {
    h.secoes = {
      activeSection: 'Shopee',
      goToSection: vi.fn(),
      sectionOfField: (k) => (k === 'sku' ? 'Dados gerais' : null),
    };
    show({
      desfecho: recusado([
        problema({ campo: 'item_sku', motivo: MOTIVO_ANUNCIO_SHOPEE.anuncioSemelhanteExistente }),
      ]),
    });
    expect(botoes()).toEqual([]);
    expect(linha().textContent).toContain(
      TEXTO_MOTIVO_ANUNCIO_SHOPEE[MOTIVO_ANUNCIO_SHOPEE.anuncioSemelhanteExistente]!,
    );
  });
});

/** The Alert root's inline style — Mantine's colour lands there as `--mantine-color-<cor>-…` variables. */
function estiloDoAlerta(el: HTMLElement): string {
  return el.closest('[role="alert"]')?.getAttribute('style') ?? '';
}
const COR = (cor: 'red' | 'yellow' | 'orange') => `--mantine-color-${cor}-`;

describe('DesfechoAcaoShopee — the colour of each outcome (R3-tests#3: the titles that claim one now pin it)', () => {
  it('the 202 is YELLOW, never red', () => {
    show({
      desfecho: { tipo: 'publicado', resposta: corpo202(), pedidoRascunho: { pausado: false } },
      rascunho: doRascunho({ publicacao: EM_ANDAMENTO }),
    });
    const estilo = estiloDoAlerta(within(painel()).getByText(TITULO_ANUNCIO_INCERTO_SHOPEE));
    expect(estilo).toContain(COR('yellow'));
    expect(estilo).not.toContain(COR('red'));
  });

  it('`sem-resposta` is YELLOW, never red', () => {
    show({
      desfecho: { tipo: 'sem-resposta' },
      rascunho: doRascunho({ publicacao: EM_ANDAMENTO }),
    });
    const estilo = screen.getByTestId(`${PAINEL}-sem-resposta`).getAttribute('style') ?? '';
    expect(estilo).toContain(COR('yellow'));
    expect(estilo).not.toContain(COR('red'));
  });

  it('NEAR-MISS: a definite `falha` is RED, never yellow (the pair stays two-sided)', () => {
    show({ desfecho: { tipo: 'falha', mensagem: 'O rascunho não existe mais.' } });
    const estilo = estiloDoAlerta(within(painel()).getByText('O rascunho não existe mais.'));
    expect(estilo).toContain(COR('red'));
    expect(estilo).not.toContain(COR('yellow'));
  });
});

describe('DesfechoAcaoShopee — a draft’s Publicar the route STOPPED (`parada`, §I2 / R8-copy#0)', () => {
  const expirada = { tipo: 'expirada', mensagemDoServidor: 'x' } as const;
  const interrompida = {
    tipo: 'interrompida',
    mensagemDoServidor: 'offset fora do limite',
  } as const;

  it.each([
    ['expirada', expirada],
    ['interrompida', interrompida],
  ] as const)(
    '%s is worded from the CURRENT reading on every render — `livre` checks first, `incerta` never creates another — orange, never «falhou»',
    (_caso, parada) => {
      const r = show({ desfecho: { tipo: 'parada', parada }, rascunho: doRascunho() });
      const aviso = () => screen.getByTestId(`${PAINEL}-parada`);
      expect(aviso().textContent).toBe(textoDaPublicacaoParadaDoRascunhoShopee(parada, LIVRE));
      expect(aviso().textContent).toContain('Procure o SKU deste produto no Seller Centre');
      r.rerender({
        desfecho: { tipo: 'parada', parada },
        rascunho: doRascunho({ publicacao: INCERTA }),
      });
      expect(aviso().textContent).toBe(textoDaPublicacaoParadaDoRascunhoShopee(parada, INCERTA));
      expect(aviso().textContent).not.toContain('crie-o lá');
      expect(aviso().textContent).not.toMatch(/falhou/i);
      const estilo = aviso().getAttribute('style') ?? '';
      expect(estilo).toContain(COR('orange'));
      expect(estilo).not.toContain(COR('red'));
    },
  );

  it('NEAR-MISS: the link is no longer a draft ⇒ the neutral line, never a draft’s exit', () => {
    show({ desfecho: { tipo: 'parada', parada: expirada }, rascunho: null });
    expect(screen.getByTestId(`${PAINEL}-parada`).textContent).toBe(
      FRASE_INCERTO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE,
    );
  });
});

describe('DesfechoAcaoShopee — OUR 422’s title claims nothing about what was sent (R7-roundtrip#0, R2-drafts#4, R4-1369-fold#4, R6-docs#0, R8-copy#10)', () => {
  it.each([
    ['a live listing’s Republicar (an UPDATE: the model leg may refuse after `update_item`)', null],
    ['a draft’s Publicar (an adopted draft is an update too)', doRascunho()],
  ])('%s ⇒ «Publicação bloqueada pelo ERP», never «nada foi enviado»', (_caso, rascunho) => {
    show({ desfecho: recusado([problema({ motivo: 'variacao-sem-vinculo' })]), rascunho });
    expect(within(painel()).getByText(TITULO_PUBLICACAO_BLOQUEADA_SHOPEE)).toBeTruthy();
    expect(painel().textContent).not.toMatch(/nada foi enviado/i);
    expect(screen.queryByText(TITULO_PUBLICACAO_RECUSADA_SHOPEE)).toBeNull();
  });

  // #1911 P12 (fix wave TITLE): the vendas e2e asserts this title `exact` on
  // BOTH its cases — a draft's FIRST create, blocked before any write
  // (`recusaSemPeso`, `itemId: null`), and a live listing's Republicar — and
  // that lane runs only on staging. So the literal is pinned HERE too, in
  // `CI test`: a title that grows a claim back («— nada foi enviado à Shopee»)
  // for the create alone reds this, not only the staging run. ⚠️ The panel
  // holds no `itemId` and no etapa for a BLOCKED 422, so it has nothing to key
  // a «nada foi enviado» on: one title for every case is the only true one
  // here (fix-B-P12-TITLE.md).
  it('the title is EXACTLY the e2e’s literal on a draft’s first create (pre-write) as on a live Republicar — the same title for both', () => {
    expect(TITULO_PUBLICACAO_BLOQUEADA_SHOPEE).toBe('Publicação bloqueada pelo ERP');
    const semPeso = recusado([problema({ campo: 'weight', motivo: 'sem-peso' })]);
    const r = show({ desfecho: semPeso, rascunho: doRascunho() });
    const titulo = () =>
      within(painel()).getByText(TITULO_PUBLICACAO_BLOQUEADA_SHOPEE, { exact: true });
    expect(titulo()).toBeTruthy();
    expect(painel().textContent).not.toMatch(/nada foi enviado/i);
    r.rerender({ desfecho: semPeso, rascunho: null });
    expect(titulo()).toBeTruthy();
    expect(painel().textContent).not.toMatch(/nada foi enviado/i);
  });

  it('NEAR-MISS: Shopee’s own refusal (`SHOPEE_PUBLISH_REJECTED`) keeps «A Shopee recusou a publicação»', () => {
    show({
      desfecho: recusado([problema({ motivo: 'modelo-recusado' })], { bloqueadaPeloErp: false }),
    });
    expect(within(painel()).getByText(TITULO_PUBLICACAO_RECUSADA_SHOPEE)).toBeTruthy();
    expect(screen.queryByText(TITULO_PUBLICACAO_BLOQUEADA_SHOPEE)).toBeNull();
  });
});

describe('DesfechoAcaoShopee — a DRAFT row is worded by the block’s facts (R4-1369-fold#0 TAB side, R8-copy#2/#5)', () => {
  const vinculada = problema({
    motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada,
    acao: importar(
      [111, 222],
      [
        { itemId: 111, produtoId: PRODUTO },
        { itemId: 222, produtoId: 'prod-9' },
      ],
    ),
  });

  it('an ATTESTED publish’s look-up row opens with «A situação mudou» — the server refused the changed situation, nothing sent', () => {
    show({
      desfecho: recusado([vinculada], { respondeAtestacao: true }),
      rascunho: doRascunho({ publicacao: INCERTA }),
    });
    expect(linha().textContent?.startsWith(FRASE_ATESTACAO_SUPERADA_SHOPEE)).toBe(true);
    expect(linha().textContent).toContain(
      textoDoProblemaShopee(vinculada, LINK, PRODUTO, {
        publicacao: INCERTA,
        skuEnviado: null,
        respondeAtestacao: true,
      }),
    );
  });

  it.each([
    ['the operator’s FIRST refusal (unattested)', false, doRascunho({ publicacao: INCERTA })],
    ['a live listing’s row (no draft context)', true, null],
  ])('NEAR-MISS: %s ⇒ no such opening', (_caso, respondeAtestacao, rascunho) => {
    show({ desfecho: recusado([vinculada], { respondeAtestacao }), rascunho });
    expect(linha().textContent).not.toContain(FRASE_ATESTACAO_SUPERADA_SHOPEE);
  });

  /** A run in flight OVER a recorded attempt (`em-andamento`, `aposIncerteza`). */
  const SOBRE_REGISTRO = estadoPublicacaoRascunhoShopee(
    { ...rascunhoTravado(AGORA - 10_000, AGORA + 60_000), criacaoIncertaDesde: AGORA - 600_000 },
    AGORA,
  );

  it('review round 4: `criacao-incerta-encerrada` (the attestation refused before any look-up) is worded by its MOTIVO over EVERY reading the panel is handed — never a search, no exit ⟷ NEAR-MISS the acao-less ja-vinculada row (a look-up DID run) keeps the look-up wording over every reading too', () => {
    expect(SOBRE_REGISTRO).toMatchObject({ tipo: 'em-andamento', aposIncerteza: true });
    const encerrada = problema({
      campo: 'item_sku',
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaEncerrada,
      mensagem:
        'a confirmação da criação incerta esperava adotar o anúncio 1000011, mas, quando esta ' +
        'publicação leu o rascunho, ele já não registrava a criação incerta confirmada — nada foi ' +
        'enviado nem vinculado, e nenhuma busca foi feita.',
      acao: null,
    });
    const vinculada = problema({
      campo: 'item_sku',
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada,
      mensagem: 'a busca de agora não confere — nada foi enviado nem vinculado.',
      acao: null,
    });
    const BUSCA =
      TEXTO_MOTIVO_ANUNCIO_SEM_ACAO_SHOPEE[MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada];
    if (BUSCA === undefined) throw new Error('the map must word the acao-less ja-vinculada row');
    const com = (p: ProblemaShopee, publicacao: EstadoPublicacaoRascunhoShopee) => ({
      desfecho: recusado([p], { respondeAtestacao: true }),
      rascunho: doRascunho({ publicacao }),
    });
    const r = show(com(encerrada, LIVRE));
    for (const publicacao of [LIVRE, EM_ANDAMENTO, INCERTA, SOBRE_REGISTRO]) {
      r.rerender(com(encerrada, publicacao));
      expect(linha().textContent, publicacao.tipo).toBe(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE);
      expect(linha().textContent).not.toMatch(/busca|não acha nenhum/);
      expect(linha().textContent).not.toContain(FRASE_ATESTACAO_SUPERADA_SHOPEE);
      // The server's sentence never shows; no button (no exit, no SKU route).
      expect(linha().textContent).not.toContain('nenhuma busca foi feita');
      expect(botoes()).toEqual([]);
      // NEAR-MISS: the look-up's own row — round 1's wording, whatever the reading.
      r.rerender(com(vinculada, publicacao));
      expect(linha().textContent, publicacao.tipo).toBe(BUSCA);
      expect(linha().textContent).not.toContain(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_SHOPEE);
    }
    // The link is no draft any more (the panel is handed `rascunho: null`):
    // the same fact, and no draft «Publicar» to name.
    r.rerender({ desfecho: recusado([encerrada], { respondeAtestacao: true }), rascunho: null });
    expect(linha().textContent).toBe(FRASE_ATESTACAO_SEM_CRIACAO_INCERTA_FORA_DO_RASCUNHO_SHOPEE);
    expect(linha().textContent).not.toContain('Publicar do rascunho');
    expect(botoes()).toEqual([]);
    // NEAR-MISS off a draft: the look-up's row keeps its fact, and on a block
    // whose button is a Republicar it never says «publicar de novo cria».
    r.rerender({ desfecho: recusado([vinculada], { respondeAtestacao: true }), rascunho: null });
    expect(linha().textContent).toBe(FRASE_BUSCA_SEM_CANDIDATO_FORA_DO_RASCUNHO_SHOPEE);
    expect(linha().textContent).not.toMatch(/cria um anúncio novo|Publicar do rascunho/);
    expect(botoes()).toEqual([]);
  });

  it('review round 4 (the WC1 pin, retargeted): the panel hands the row the block’s CURRENT reading — #11 (`busca-de-anuncio-existente-incompleta`, no acao) words its exit by it: `livre` checks first, `incerta` the last attempt’s listing first, `em-andamento` waits — re-worded on every render', () => {
    const onze = problema({
      campo: 'item_sku',
      motivo: MOTIVO_ANUNCIO_SHOPEE.buscaDeAnuncioExistenteIncompleta,
      mensagem: 'A Shopee deixou de fora o anúncio 1000011.',
      acao: null,
    });
    const com = (publicacao: EstadoPublicacaoRascunhoShopee) => ({
      desfecho: recusado([onze]),
      rascunho: doRascunho({ publicacao }),
    });
    const r = show(com(LIVRE));
    expect(linha().textContent).toContain('Procure o SKU deste produto no Seller Centre');
    expect(linha().textContent).not.toContain('se o anúncio da última tentativa existe');
    r.rerender(com(INCERTA));
    expect(linha().textContent).toContain(
      'Confira no Seller Centre: se o anúncio da última tentativa existe',
    );
    expect(linha().textContent).not.toContain('Procure o SKU deste produto');
    expect(linha().textContent).not.toContain('crie-o lá');
    r.rerender(com(EM_ANDAMENTO));
    expect(linha().textContent).toContain('O rascunho ainda aparece em publicação');
    expect(linha().textContent).not.toMatch(/Procure o SKU|se o anúncio da última tentativa/);
    // Each reading's text is the lib's over THAT reading (one module, #1369).
    for (const publicacao of [LIVRE, INCERTA, EM_ANDAMENTO]) {
      r.rerender(com(publicacao));
      expect(linha().textContent, publicacao.tipo).toBe(
        textoDoProblemaShopee(onze, LINK, PRODUTO, {
          publicacao,
          skuEnviado: null,
          respondeAtestacao: false,
        }),
      );
    }
  });

  it('the SKU-moved row names the SKU the attempt SENT (`skuEnviado`) ⟷ NEAR-MISS unknown, it asks to restore nothing it cannot show', () => {
    const skuMudou = problema({ motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaAmbigua });
    const r = show({
      desfecho: recusado([skuMudou]),
      rascunho: doRascunho({ publicacao: INCERTA, skuEnviado: 'SKU-A' }),
    });
    expect(linha().textContent).toContain('«SKU-A»');
    r.rerender({
      desfecho: recusado([skuMudou]),
      rascunho: doRascunho({ publicacao: INCERTA, skuEnviado: null }),
    });
    expect(linha().textContent).not.toContain('«SKU-A»');
    expect(linha().textContent).not.toMatch(/volte o SKU/);
  });

  it('a draft’s mid-publish etapa never names «Reverificar» (a draft block has none) ⟷ NEAR-MISS a live listing’s keeps it', () => {
    const comEtapa = (r: DesfechoDoRascunhoShopee | null) =>
      show({
        desfecho: recusado([problema({})], { bloqueadaPeloErp: false, etapa: 'add_item' }),
        rascunho: r,
      });
    const r = comEtapa(doRascunho());
    expect(painel().textContent).toContain(textoDaEtapaShopee('add_item', { ehRascunho: true }));
    expect(painel().textContent).not.toContain('Reverificar');
    expect(painel().textContent).not.toContain('add_item');
    r.rerender({
      desfecho: recusado([problema({})], { bloqueadaPeloErp: false, etapa: 'add_item' }),
      rascunho: null,
    });
    expect(painel().textContent).toContain(textoDaEtapaShopee('add_item', { ehRascunho: false }));
    expect(painel().textContent).toContain('Reverificar');
  });

  it('a row-less refusal whose sentence is terminal text: a draft gets the stand-in that names no button ⟷ NEAR-MISS a live one names «Reverificar»', () => {
    const semLinhas = (r: DesfechoDoRascunhoShopee | null) =>
      show({
        desfecho: recusado([], { mensagem: 'Rode publicar:anuncio --link de novo.' }),
        rascunho: r,
      });
    const r = semLinhas(doRascunho());
    expect(painel().textContent).toContain(FRASE_RECUSA_SEM_PASSO_RASCUNHO_SHOPEE);
    expect(painel().textContent).not.toContain('publicar:anuncio');
    r.rerender({
      desfecho: recusado([], { mensagem: 'Rode publicar:anuncio --link de novo.' }),
      rascunho: null,
    });
    expect(painel().textContent).toContain(FRASE_RECUSA_SEM_PASSO_SHOPEE);
  });
});
