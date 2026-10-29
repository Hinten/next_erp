import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  CAMPO_RASCUNHO_SHOPEE,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  estadoPublicacaoRascunhoShopee,
  type EstadoPublicacaoRascunhoShopee,
} from '@delfrance/schemas';
import type { ObjectViewSections } from '@delfrance/ui';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  FRASE_CORRIGIR_NO_SELLER_CENTRE_SHOPEE,
  FRASE_MARCA_PODE_NAO_VALER_SHOPEE,
  MOTIVO_ANUNCIO_SHOPEE,
  ROTULO_ABRIR_TABELA_DE_MEDIDAS_SHOPEE,
  ROTULO_ABRIR_VARIACOES_SHOPEE,
  ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
  ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
  ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE,
  TEXTO_MOTIVO_ANUNCIO_SHOPEE,
  TITULO_ANUNCIO_INCERTO_SHOPEE,
  TITULO_RASCUNHO_PUBLICADO_SHOPEE,
  avisoDoDescarteComAnuncioSemVinculoShopee,
  formatarInstanteShopee,
  fraseDaPublicacaoSemRespostaShopee,
  fraseDoAnuncioIncertoShopee,
  fraseDoRascunhoPublicadoShopee,
  rotuloDaPublicacaoQueAdotaShopee,
  textoDoProblemaShopee,
} from '@/lib/shopee/anuncioProduto';
import type { SaidaDoProblemaShopee } from '@/lib/shopee/rascunho';
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
  idDoCampoRascunhoShopee,
} = await import('./DesfechoAcaoShopee');

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

function recusado(problemas: readonly ProblemaShopee[]): Desfecho {
  return {
    tipo: 'recusado',
    antesDaShopee: true,
    etapa: null,
    problemas,
    mensagem: 'Publicação bloqueada.',
    pedidoKit: null,
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
    expect(texto).toContain(avisoDoDescarteComAnuncioSemVinculoShopee([222]));
    const adota = rotuloDaPublicacaoQueAdotaShopee([222]);
    expect(botoes()).toEqual([ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE, adota]);
    expect(botoes()).not.toContain(ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE);
    fireEvent.click(within(painel()).getByRole('button', { name: adota }));
    expect(rascunho.onSaida).toHaveBeenLastCalledWith({
      tipo: 'publicar-atestando',
      rotulo: adota,
      adota: [222],
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

  it.each(['linkDocId', 'item_names', 'shop', 'attribute_list[COLOR]'])(
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
