import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import {
  CAMPO_RASCUNHO_SHOPEE,
  type CampoRascunhoShopee,
  type MarcaRascunhoShopee as ParMarcaRascunhoShopee,
} from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  FRASE_CATEGORIA_TRAVADA_SHOPEE,
  FRASE_LOGISTICA_RASCUNHO_SHOPEE,
  FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE,
  FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE,
  FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE,
  FRASE_PENDENCIA_SEM_NOME_SHOPEE,
  FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE,
  FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
  FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE,
  FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE,
  FRASE_RASCUNHO_INCERTO_SHOPEE,
  FRASE_RASCUNHO_NOVO_SHOPEE,
  ROTULO_CRIAR_PAUSADO_SHOPEE,
  ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
  ROTULO_PUBLICAR_RASCUNHO_SHOPEE,
  ROTULO_PUBLICAR_SEGUNDO_ANUNCIO_SHOPEE,
  TITULO_PUBLICAR_RASCUNHO_SHOPEE,
  TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE,
  textoDaConfirmacaoDePublicacaoShopee,
  textoDoSegundoAnuncioNaPublicacaoShopee,
} from '@/lib/shopee/anuncioProduto';
import {
  comCampoRascunhoShopee,
  edicaoDoRascunhoGuardadoShopee,
  estadoDoBlocoRascunhoShopee,
  novaEdicaoRascunhoShopee,
  publicacaoDoRascunhoShopee,
  type EdicaoRascunhoShopee,
  type EntradaDaPublicacaoDoRascunhoShopee,
  type EntradaDoBlocoRascunhoShopee,
  type PublicacaoDoRascunhoShopee,
} from '@/lib/shopee/rascunho';

import type { CategoriaRascunhoShopeeProps } from './CategoriaRascunhoShopee';
import { idDoCampoRascunhoShopee } from './DesfechoAcaoShopee';
import type { MarcaRascunhoShopeeProps } from './MarcaRascunhoShopee';
import type { ConfirmacaoDePublicacaoShopee, RascunhoShopeeProps } from './RascunhoShopee';

/**
 * The draft form, over the REAL block decision (`estadoDoBlocoRascunhoShopee`
 * from REAL stored-draft fixtures) and — unless a test hands its own — the
 * REAL Publicar decision (`publicacaoDoRascunhoShopee`, whose `pendencias`
 * the form shows). Doubled: the two pickers (their own suites), captured so
 * the props this form hands them — and what it does with their picks — are
 * pinned here.
 */

const h = vi.hoisted(() => ({
  categoria: null as CategoriaRascunhoShopeeProps | null,
  marca: null as MarcaRascunhoShopeeProps | null,
}));

vi.mock('./CategoriaRascunhoShopee', () => ({
  CategoriaRascunhoShopee: (props: CategoriaRascunhoShopeeProps) => {
    h.categoria = props;
    return <div data-testid="stub-categoria" />;
  },
}));
vi.mock('./MarcaRascunhoShopee', () => ({
  MarcaRascunhoShopee: (props: MarcaRascunhoShopeeProps) => {
    h.marca = props;
    return <div data-testid="stub-marca" />;
  },
}));

const {
  FRASE_CAMPO_INVALIDO_RASCUNHO_SHOPEE,
  FRASE_TITULO_EM_BRANCO_RASCUNHO_SHOPEE,
  RascunhoShopee,
  fraseDasDivergenciasDoRascunhoShopee,
} = await import('./RascunhoShopee');

const CONTA = 'int-1';
const LINK = 'rasc00000000000000001';
const RAIZ = `shopee-rascunho-${LINK}`;
/** MILLISECONDS — the instant every reading below is taken at (a fixture, never the clock). */
const AGORA = Date.UTC(2026, 9, 28, 12, 0, 0);

/** A stored draft as P5 mints it: no listing, the produto's title, nothing chosen. */
function rascunho(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: null,
    integracaoId: CONTA,
    item_name: 'Camiseta',
    description: null,
    category_id: null,
    brand_id: null,
    original_brand_name: null,
    publicacaoEmCurso: null,
    ...extra,
  };
}

/** A lock that may have SENT (its SKU stamped, §H Q3). */
const travaCarimbada = (desde: number, expiraEm: number) => ({
  publicacaoEmCurso: { desde, expiraEm, token: 'tok-1', sku: 'SKU-1' },
});

function bloco(over: Partial<EntradaDoBlocoRascunhoShopee> = {}) {
  return estadoDoBlocoRascunhoShopee({
    link: rascunho(),
    edicao: null,
    nowMs: AGORA,
    kitVirtual: false,
    servidorConfirmado: true,
    podeEditar: true,
    ocupado: false,
    ...over,
  });
}

function entrada(link: Record<string, unknown>): EdicaoRascunhoShopee {
  return edicaoDoRascunhoGuardadoShopee({ linkDocId: LINK, contaId: CONTA, link });
}

/**
 * The Publicar decision the tab would hand over — the REAL gate over the same
 * `bloco`, `podeEditar`, `textosDoProduto` and `limites` the form gets (the
 * produto form clean, the snapshot from the server, nothing in flight unless
 * `gate` says otherwise).
 */
function decisao(
  p: Pick<RascunhoShopeeProps, 'bloco' | 'podeEditar' | 'textosDoProduto' | 'limites'>,
  gate: Partial<EntradaDaPublicacaoDoRascunhoShopee> = {},
): PublicacaoDoRascunhoShopee {
  return publicacaoDoRascunhoShopee({
    bloco: p.bloco,
    podeEditar: p.podeEditar,
    ocupado: false,
    servidorConfirmado: true,
    produtoSujo: false,
    textosDoProduto: p.textosDoProduto,
    limites: p.limites,
    ...gate,
  });
}

function callbacks() {
  return {
    onCampo: vi.fn(),
    onSalvar: vi.fn(),
    onDesfazer: vi.fn(),
    onDescartar: vi.fn(),
    onPublicar: vi.fn(),
    onConfirmarPublicacao: vi.fn(),
    onCancelarPublicacao: vi.fn(),
    onSubmit: vi.fn((e: { preventDefault: () => void }) => e.preventDefault()),
  };
}

function elemento(
  props: Partial<RascunhoShopeeProps>,
  cb: ReturnType<typeof callbacks>,
  emFormulario: boolean,
) {
  const base = {
    bloco: bloco(),
    podeEditar: true,
    textosDoProduto: null,
    limites: null,
    ...props,
  };
  const ui = (
    <RascunhoShopee
      db={{} as Firestore}
      contaId={CONTA}
      contaNome="Loja Principal"
      linkDocId={LINK}
      marcaGuardada={null}
      divergencias={[]}
      emVoo={null}
      resultado={null}
      decisaoDePublicar={decisao(base)}
      confirmacaoDePublicacao={null}
      onCampo={cb.onCampo}
      onSalvar={cb.onSalvar}
      onDesfazer={cb.onDesfazer}
      onDescartar={cb.onDescartar}
      onPublicar={cb.onPublicar}
      onConfirmarPublicacao={cb.onConfirmarPublicacao}
      onCancelarPublicacao={cb.onCancelarPublicacao}
      {...base}
    />
  );
  return (
    <MantineTestProvider>
      {emFormulario ? <form onSubmit={cb.onSubmit}>{ui}</form> : ui}
    </MantineTestProvider>
  );
}

function show(props: Partial<RascunhoShopeeProps> = {}, emFormulario = false) {
  const cb = callbacks();
  const r = render(elemento(props, cb, emFormulario));
  return {
    ...cb,
    rerender: (outras: Partial<RascunhoShopeeProps>) =>
      r.rerender(elemento(outras, cb, emFormulario)),
  };
}

/** A decision with nothing in the way — for the tests about the button and the dialog themselves. */
const PRONTO: PublicacaoDoRascunhoShopee = {
  podePublicar: true,
  impedimento: null,
  pendencias: [],
  aviso: null,
};

/** The block's own «Publicar» opened it: no D15 warning, «Criar pausado» unticked, no attestation. */
const CONFIRMACAO: ConfirmacaoDePublicacaoShopee = {
  segundoAnuncio: null,
  pausado: false,
  atestacao: null,
};

const raiz = () => screen.getByTestId(RAIZ);
const titulo = () => screen.getByLabelText('Título do anúncio') as HTMLInputElement;
const descricao = () => screen.getByLabelText('Descrição do anúncio') as HTMLTextAreaElement;
const botao = (nome: string) =>
  within(raiz()).getByRole('button', { name: nome }) as HTMLButtonElement;
const nomesDosBotoes = () =>
  within(raiz())
    .queryAllByRole('button')
    .map((b) => b.textContent);

beforeEach(() => {
  h.categoria = null;
  h.marca = null;
});

describe('RascunhoShopee — the form of a stored draft', () => {
  it('renders the four fields from `bloco.valores`, the logistics line, and its three buttons', () => {
    const link = rascunho({ description: 'Algodão', category_id: 100087, brand_id: 0 });
    show({ bloco: bloco({ link }) });
    expect(raiz()).toBeTruthy();
    expect(titulo().value).toBe('Camiseta');
    expect(descricao().value).toBe('Algodão');
    expect(h.categoria?.categoryId).toBe(100087);
    expect(h.categoria?.titulo).toBe('Camiseta');
    expect(h.marca?.marca).toEqual({ brand_id: 0, original_brand_name: null });
    expect(screen.getByText(FRASE_LOGISTICA_RASCUNHO_SHOPEE)).toBeTruthy();
    expect(nomesDosBotoes()).toEqual([
      'Salvar rascunho',
      'Desfazer alterações',
      ROTULO_PUBLICAR_RASCUNHO_SHOPEE,
      'Descartar',
    ]);
  });

  it('a CLEAN stored draft: nothing to save or undo, Descartar asks once (`confirmar`)', () => {
    const cb = show();
    expect(botao('Salvar rascunho').disabled).toBe(true);
    expect(botao('Desfazer alterações').disabled).toBe(true);
    fireEvent.click(botao('Descartar'));
    expect(cb.onDescartar).toHaveBeenCalledWith('confirmar');
  });

  it('NEAR-MISS: a DIRTY entry enables Salvar and Desfazer, each firing its callback', () => {
    const edicao = comCampoRascunhoShopee(
      entrada(rascunho()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Camiseta azul',
    );
    const cb = show({ bloco: bloco({ edicao }) });
    expect(titulo().value).toBe('Camiseta azul');
    fireEvent.click(botao('Salvar rascunho'));
    expect(cb.onSalvar).toHaveBeenCalledTimes(1);
    fireEvent.click(botao('Desfazer alterações'));
    expect(cb.onDesfazer).toHaveBeenCalledTimes(1);
  });

  it('typing reports each field through `onCampo` — the editor owns the value', () => {
    const cb = show();
    fireEvent.change(titulo(), { target: { value: 'Camiseta verde' } });
    expect(cb.onCampo).toHaveBeenCalledWith(CAMPO_RASCUNHO_SHOPEE.itemName, 'Camiseta verde');
    fireEvent.change(descricao(), { target: { value: 'Malha fria' } });
    expect(cb.onCampo).toHaveBeenCalledWith(CAMPO_RASCUNHO_SHOPEE.description, 'Malha fria');
  });

  it('a picker’s pick is forwarded VERBATIM as its field (the brand pair is never rebuilt here)', () => {
    const cb = show();
    h.categoria?.onEscolher(100087);
    expect(cb.onCampo).toHaveBeenCalledWith(CAMPO_RASCUNHO_SHOPEE.categoryId, 100087);
    const par: ParMarcaRascunhoShopee = { brand_id: 88, original_brand_name: 'Puma (importada)' };
    h.marca?.onEscolher(par);
    expect(cb.onCampo).toHaveBeenCalledWith(CAMPO_RASCUNHO_SHOPEE.marca, par);
    expect(cb.onCampo.mock.calls.at(-1)?.[1]).toBe(par);
  });

  it('hands the brand picker the STORED pair (§H Q1) and the conta', () => {
    const guardada = { brand_id: 88, original_brand_name: 'Puma (importada)' };
    show({ marcaGuardada: guardada });
    expect(h.marca?.marcaGuardada).toBe(guardada);
    expect(h.marca?.contaId).toBe(CONTA);
    expect(h.marca?.contaNome).toBe('Loja Principal');
    expect(h.marca?.linkDocId).toBe(LINK);
    expect(h.categoria?.contaId).toBe(CONTA);
  });

  it('no button submits the enclosing produto <form>', () => {
    const edicao = comCampoRascunhoShopee(
      entrada(rascunho()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Camiseta azul',
    );
    const cb = show({ bloco: bloco({ edicao }) }, true);
    fireEvent.click(botao('Salvar rascunho'));
    fireEvent.click(botao('Desfazer alterações'));
    fireEvent.click(botao('Descartar'));
    expect(cb.onSalvar).toHaveBeenCalledTimes(1);
    expect(cb.onSubmit).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: «Publicar» and the confirmation’s controls never submit it either', () => {
    const cb = show({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO }, true);
    // The dialog renders inline under `env="test"`: the block's own button is the FIRST «Publicar».
    const [doBloco] = within(raiz()).getAllByRole('button', {
      name: ROTULO_PUBLICAR_RASCUNHO_SHOPEE,
    });
    fireEvent.click(doBloco!);
    const dialogo = within(screen.getByTestId(`shopee-rascunho-publicar-${LINK}`));
    fireEvent.click(dialogo.getByRole('checkbox'));
    fireEvent.click(dialogo.getByRole('button', { name: ROTULO_PUBLICAR_RASCUNHO_SHOPEE }));
    fireEvent.click(dialogo.getByRole('button', { name: 'Cancelar' }));
    expect(cb.onPublicar).toHaveBeenCalledTimes(1);
    expect(cb.onConfirmarPublicacao).toHaveBeenCalledTimes(1);
    expect(cb.onCancelarPublicacao).toHaveBeenCalledTimes(1);
    expect(cb.onSubmit).not.toHaveBeenCalled();
  });

  it('Enter in the title never submits the produto form (implicit submission is swallowed)', () => {
    show();
    const enter = createEvent.keyDown(titulo(), { key: 'Enter' });
    fireEvent(titulo(), enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it('NEAR-MISS: any other key types normally', () => {
    show();
    const tecla = createEvent.keyDown(titulo(), { key: 'a' });
    fireEvent(titulo(), tecla);
    expect(tecla.defaultPrevented).toBe(false);
  });
});

describe('RascunhoShopee — «Publicar» on every draft block (#1911 P11: the P10 pin, INVERTED)', () => {
  const estados: [string, Partial<EntradaDoBlocoRascunhoShopee>][] = [
    ['clean', {}],
    [
      'dirty',
      {
        edicao: comCampoRascunhoShopee(entrada(rascunho()), CAMPO_RASCUNHO_SHOPEE.itemName, 'X'),
      },
    ],
    [
      'local new',
      {
        link: null,
        edicao: novaEdicaoRascunhoShopee({ linkDocId: LINK, contaId: CONTA, nomeProduto: 'X' }),
      },
    ],
    ['incerta', { link: rascunho({ criacaoIncertaDesde: AGORA - 600_000 }) }],
  ];
  it.each(estados)('%s: exactly one button whose name contains "Publicar"', (_nome, over) => {
    show({ bloco: bloco(over) });
    const publicar = within(raiz()).getAllByRole('button', { name: /Publicar/ });
    expect(publicar.map((b) => b.textContent)).toEqual([ROTULO_PUBLICAR_RASCUNHO_SHOPEE]);
  });

  it('NEAR-MISS: a virtual-kit produto has NO «Publicar» (its first publish is a native kit, §C #1)', () => {
    show({
      bloco: bloco({ kitVirtual: true }),
      decisaoDePublicar: PRONTO,
      confirmacaoDePublicacao: CONFIRMACAO,
    });
    expect(within(raiz()).queryByRole('button', { name: /Publicar/ })).toBeNull();
    expect(screen.queryByTestId(`shopee-rascunho-publicar-${LINK}`)).toBeNull();
  });

  it('NEAR-MISS: a read-only operator has NO «Publicar», nor its confirmation', () => {
    show({
      bloco: bloco({ podeEditar: false }),
      podeEditar: false,
      decisaoDePublicar: PRONTO,
      confirmacaoDePublicacao: CONFIRMACAO,
    });
    expect(within(raiz()).queryByRole('button', { name: /Publicar/ })).toBeNull();
    expect(screen.queryByTestId(`shopee-rascunho-publicar-${LINK}`)).toBeNull();
  });
});

describe('RascunhoShopee — who may author', () => {
  it('read-only (`podeEditar: false`): values shown, fields disabled, NO button at all', () => {
    show({ bloco: bloco({ podeEditar: false }), podeEditar: false });
    expect(titulo().value).toBe('Camiseta');
    expect(titulo().disabled).toBe(true);
    expect(descricao().disabled).toBe(true);
    expect(h.marca?.editavel).toBe(false);
    expect(h.categoria?.editavel).toBe(false);
    expect(nomesDosBotoes()).toEqual([]);
  });

  it('NEAR-MISS: with the permission the fields accept typing', () => {
    show();
    expect(titulo().disabled).toBe(false);
    expect(h.marca?.editavel).toBe(true);
    expect(h.categoria?.editavel).toBe(true);
  });

  it('server truth: a stored draft with no entry, read from the CACHE, is read-only and says so', () => {
    show({ bloco: bloco({ servidorConfirmado: false }) });
    expect(titulo().disabled).toBe(true);
    expect(screen.getByText(FRASE_RASCUNHO_CARREGANDO_SHOPEE)).toBeTruthy();
  });

  it('NEAR-MISS: an EXISTING entry keeps editing through a cache re-listen', () => {
    show({ bloco: bloco({ servidorConfirmado: false, edicao: entrada(rascunho()) }) });
    expect(titulo().disabled).toBe(false);
    expect(screen.queryByText(FRASE_RASCUNHO_CARREGANDO_SHOPEE)).toBeNull();
  });
});

describe('RascunhoShopee — the publish reading (through `bloco` only)', () => {
  it('em-andamento: the notice, every field read-only, Salvar and Descartar disabled', () => {
    const link = rascunho(travaCarimbada(AGORA - 10_000, AGORA + 60_000));
    show({ bloco: bloco({ link }) });
    expect(raiz().textContent).toContain('está sendo publicado');
    expect(titulo().disabled).toBe(true);
    expect(h.categoria?.editavel).toBe(false);
    expect(botao('Salvar rascunho').disabled).toBe(true);
    expect(botao('Descartar').disabled).toBe(true);
  });

  it('incerta: the notice; editable EXCEPT the category; Descartar asks for the attestation', () => {
    const link = rascunho(travaCarimbada(AGORA - 1_000_000, AGORA - 500_000));
    const cb = show({ bloco: bloco({ link }) });
    expect(screen.getByText(FRASE_RASCUNHO_INCERTO_SHOPEE)).toBeTruthy();
    expect(titulo().disabled).toBe(false);
    expect(h.categoria?.editavel).toBe(false);
    fireEvent.click(botao('Descartar'));
    expect(cb.onDescartar).toHaveBeenCalledWith('atestar');
  });

  it('NEAR-MISS (§H Q3): an expired UNSTAMPED lock reads `livre` — no notice, category editable, plain confirmation', () => {
    const link = rascunho({
      publicacaoEmCurso: { desde: AGORA - 1_000_000, expiraEm: AGORA - 500_000, token: 'tok-1' },
    });
    const cb = show({ bloco: bloco({ link }) });
    expect(screen.queryByText(FRASE_RASCUNHO_INCERTO_SHOPEE)).toBeNull();
    expect(h.categoria?.editavel).toBe(true);
    fireEvent.click(botao('Descartar'));
    expect(cb.onDescartar).toHaveBeenCalledWith('confirmar');
  });

  it('a category changed before the reading turned `incerta` cannot be saved, and it says why', () => {
    const link = rascunho({ category_id: 100087, criacaoIncertaDesde: AGORA - 600_000 });
    const edicao = comCampoRascunhoShopee(entrada(link), CAMPO_RASCUNHO_SHOPEE.categoryId, 100090);
    show({ bloco: bloco({ link, edicao }) });
    expect(screen.getByTestId(`${RAIZ}-impedimento`).textContent).toBe(
      FRASE_CATEGORIA_TRAVADA_SHOPEE,
    );
    expect(botao('Salvar rascunho').disabled).toBe(true);
  });

  it('NEAR-MISS: a title edit in `incerta` saves (only `category_id` is locked)', () => {
    const link = rascunho({ category_id: 100087, criacaoIncertaDesde: AGORA - 600_000 });
    const edicao = comCampoRascunhoShopee(entrada(link), CAMPO_RASCUNHO_SHOPEE.itemName, 'Nova');
    show({ bloco: bloco({ link, edicao }) });
    expect(screen.queryByTestId(`${RAIZ}-impedimento`)).toBeNull();
    expect(botao('Salvar rascunho').disabled).toBe(false);
  });
});

describe('RascunhoShopee — a local new draft and a virtual kit', () => {
  it('a LOCAL new draft: the notice, Salvar enabled, no Desfazer, Descartar drops it locally', () => {
    const edicao = novaEdicaoRascunhoShopee({
      linkDocId: LINK,
      contaId: CONTA,
      nomeProduto: 'Camiseta',
    });
    const cb = show({ bloco: bloco({ link: null, edicao }) });
    expect(screen.getByText(FRASE_RASCUNHO_NOVO_SHOPEE)).toBeTruthy();
    expect(titulo().value).toBe('Camiseta');
    expect(nomesDosBotoes()).toEqual([
      'Salvar rascunho',
      ROTULO_PUBLICAR_RASCUNHO_SHOPEE,
      'Descartar',
    ]);
    // Nothing stored to publish yet: disabled, and it says why.
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).disabled).toBe(true);
    expect(screen.getByTestId(`${RAIZ}-publicar-aviso`).textContent).toBe(
      FRASE_PUBLICAR_RASCUNHO_NOVO_SHOPEE,
    );
    expect(botao('Salvar rascunho').disabled).toBe(false);
    fireEvent.click(botao('Descartar'));
    expect(cb.onDescartar).toHaveBeenCalledWith('local');
  });

  it('a VIRTUAL-KIT produto: the notice and «Descartar» only — no fields, no pendências', () => {
    const cb = show({
      bloco: bloco({ kitVirtual: true }),
      textosDoProduto: { nomeProduto: 'Kit', descricaoProduto: null },
    });
    expect(screen.getByText(FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE)).toBeTruthy();
    expect(screen.queryByLabelText('Título do anúncio')).toBeNull();
    expect(h.categoria).toBeNull();
    expect(h.marca).toBeNull();
    expect(screen.queryByTestId(`${RAIZ}-pendencias`)).toBeNull();
    expect(nomesDosBotoes()).toEqual(['Descartar']);
    fireEvent.click(botao('Descartar'));
    expect(cb.onDescartar).toHaveBeenCalledWith('confirmar');
  });

  it('NEAR-MISS: a non-kit produto gets the editor', () => {
    show({ bloco: bloco({ kitVirtual: false }) });
    expect(screen.queryByText(FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE)).toBeNull();
    expect(titulo()).toBeTruthy();
  });
});

describe('RascunhoShopee — pendências (the STORED produto texts)', () => {
  const TEXTOS = { nomeProduto: 'Camiseta', descricaoProduto: null };

  it('a fresh draft lists the description, the category and the brand, in the assembly’s order', () => {
    show({ textosDoProduto: TEXTOS });
    const itens = within(screen.getByTestId(`${RAIZ}-pendencias`))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(itens).toEqual([
      FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE,
      FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE,
      FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE,
    ]);
  });

  it('NEAR-MISS: the produto texts not read yet ⇒ NO pendência (none claimed from missing knowledge)', () => {
    show({ textosDoProduto: null });
    expect(screen.queryByTestId(`${RAIZ}-pendencias`)).toBeNull();
  });

  it('the produto’s stored description satisfies the draft’s null one', () => {
    show({ textosDoProduto: { nomeProduto: 'Camiseta', descricaoProduto: 'Algodão' } });
    expect(screen.getByTestId(`${RAIZ}-pendencias`).textContent).not.toContain(
      FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE,
    );
  });

  it('they read the FORM’s values: a category and a brand picked (unsaved) clear theirs', () => {
    const edicao = comCampoRascunhoShopee(
      comCampoRascunhoShopee(entrada(rascunho()), CAMPO_RASCUNHO_SHOPEE.categoryId, 100087),
      CAMPO_RASCUNHO_SHOPEE.marca,
      { brand_id: 0, original_brand_name: null },
    );
    show({ bloco: bloco({ edicao }), textosDoProduto: TEXTOS });
    const texto = screen.getByTestId(`${RAIZ}-pendencias`).textContent;
    expect(texto).not.toContain(FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE);
    expect(texto).not.toContain(FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE);
    expect(texto).toContain(FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE);
  });

  it('a title outside the category’s band is a pendência, and its input shows the measure', () => {
    const limites = {
      itemNameLengthLimit: { min: 20, max: 100 },
      itemDescriptionLengthLimit: null,
    };
    show({ textosDoProduto: TEXTOS, limites });
    expect(screen.getByTestId(`${RAIZ}-pendencias`).textContent).toContain(
      'O título tem 8 caracteres; esta categoria aceita 20..100.',
    );
    expect(
      screen.getByText(/8 caracteres; esta categoria aceita 20\.\.100\./, {
        selector: 'p, div',
      }),
    ).toBeTruthy();
  });

  it.each([
    // rev. 2a #15: a legacy `-1` is "not chosen" (fail-closed) — the picker
    // still gets the held pair, and the marca pendência shows beside it.
    ['a legacy -1', -1, true],
    // A stored id the conta's shortlist may not list (imported, removed since)
    // is still a CHOSEN brand: no pendência.
    ['an id the shortlist may not list', 77, false],
  ])(
    'a stored brand %s renders the form and hands the picker the held pair — marca pendência %s',
    (_caso, brandId, pendencia) => {
      const link = rascunho({
        description: 'Algodão',
        category_id: 100087,
        brand_id: brandId,
        original_brand_name: 'Acme',
      });
      show({ bloco: bloco({ link }), textosDoProduto: TEXTOS });
      // Positive first: the form rendered, the picker got the stored pair.
      expect(titulo().value).toBe('Camiseta');
      expect(h.marca?.marca).toEqual({ brand_id: brandId, original_brand_name: 'Acme' });
      const pendencias = screen.queryByTestId(`${RAIZ}-pendencias`);
      if (pendencia) {
        expect(
          within(pendencias!)
            .getAllByRole('listitem')
            .map((li) => li.textContent),
        ).toEqual([FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE]);
      } else {
        expect(pendencias).toBeNull();
      }
    },
  );

  it('NEAR-MISS: bands unknown ⇒ no band pendência and no measure', () => {
    show({ textosDoProduto: TEXTOS, limites: null });
    expect(screen.getByTestId(`${RAIZ}-pendencias`).textContent).not.toContain('caracteres');
    expect(raiz().textContent).not.toContain('esta categoria aceita');
  });
});

describe('RascunhoShopee — what blocks a save, and the last answer', () => {
  it('a title cleared to blanks: its error, the sentence, Salvar disabled', () => {
    const edicao = comCampoRascunhoShopee(
      entrada(rascunho()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      '  ',
    );
    show({ bloco: bloco({ edicao }) });
    expect(screen.getByText(FRASE_TITULO_EM_BRANCO_RASCUNHO_SHOPEE)).toBeTruthy();
    expect(screen.getByTestId(`${RAIZ}-impedimento`).textContent).toBe(
      FRASE_CAMPO_INVALIDO_RASCUNHO_SHOPEE,
    );
    expect(botao('Salvar rascunho').disabled).toBe(true);
  });

  it('NEAR-MISS: a real title has no error', () => {
    const edicao = comCampoRascunhoShopee(
      entrada(rascunho()),
      CAMPO_RASCUNHO_SHOPEE.itemName,
      'Ok',
    );
    show({ bloco: bloco({ edicao }) });
    expect(screen.queryByText(FRASE_TITULO_EM_BRANCO_RASCUNHO_SHOPEE)).toBeNull();
    expect(screen.queryByTestId(`${RAIZ}-impedimento`)).toBeNull();
  });

  it('the last draft answer shows on the block — a "may have happened" one too', () => {
    show({ resultado: { mensagem: 'O rascunho PODE ter sido salvo.', incerto: true } });
    expect(screen.getByTestId(`${RAIZ}-resultado`).textContent).toBe(
      'O rascunho PODE ter sido salvo.',
    );
  });

  it('NEAR-MISS: none ⇒ nothing', () => {
    show({ resultado: null });
    expect(screen.queryByTestId(`${RAIZ}-resultado`)).toBeNull();
  });

  it('the stale check names the fields another writer changed', () => {
    const divergencias: CampoRascunhoShopee[] = [
      CAMPO_RASCUNHO_SHOPEE.itemName,
      CAMPO_RASCUNHO_SHOPEE.marca,
    ];
    show({ divergencias });
    const aviso = screen.getByTestId(`${RAIZ}-divergencias`).textContent;
    expect(aviso).toBe(fraseDasDivergenciasDoRascunhoShopee(divergencias));
    expect(aviso).toContain('(Título, Marca)');
  });

  it('NEAR-MISS: no divergence ⇒ no notice', () => {
    show({ divergencias: [] });
    expect(screen.queryByTestId(`${RAIZ}-divergencias`)).toBeNull();
  });

  it('the write in flight spins on ITS button only', () => {
    const edicao = comCampoRascunhoShopee(entrada(rascunho()), CAMPO_RASCUNHO_SHOPEE.itemName, 'X');
    show({ bloco: bloco({ edicao, ocupado: true }), emVoo: 'salvar-rascunho' });
    expect(botao('Salvar rascunho').getAttribute('data-loading')).toBe('true');
    expect(botao('Descartar').getAttribute('data-loading')).toBeNull();
    expect(botao('Descartar').disabled).toBe(true);
  });

  it('NEAR-MISS: a discard in flight spins on Descartar', () => {
    show({ bloco: bloco({ ocupado: true }), emVoo: 'descartar-rascunho' });
    expect(botao('Descartar').getAttribute('data-loading')).toBe('true');
    expect(botao('Salvar rascunho').getAttribute('data-loading')).toBeNull();
  });
});

describe('RascunhoShopee — the pendências shown ARE the Publicar decision’s (#1369)', () => {
  it('the form lists `decisaoDePublicar.pendencias`, never a list of its own', () => {
    // The form's own inputs (`textosDoProduto: null`) would compute NONE: what
    // shows can only come from the decision.
    show({
      textosDoProduto: null,
      decisaoDePublicar: {
        podePublicar: false,
        impedimento: 'pendencias',
        pendencias: [{ tipo: 'sem-nome' }],
        aviso: null,
      },
    });
    const itens = within(screen.getByTestId(`${RAIZ}-pendencias`))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(itens).toEqual([FRASE_PENDENCIA_SEM_NOME_SHOPEE]);
  });

  it('NEAR-MISS: a decision with no pendência ⇒ no list, whatever the form’s own inputs say', () => {
    show({
      textosDoProduto: { nomeProduto: 'Camiseta', descricaoProduto: null },
      decisaoDePublicar: PRONTO,
    });
    expect(screen.queryByTestId(`${RAIZ}-pendencias`)).toBeNull();
  });
});

describe('RascunhoShopee — «Publicar» (`decisaoDePublicar`)', () => {
  it('enabled ⇔ `podePublicar`; the click asks the editor (`onPublicar`) and sends nothing itself', () => {
    const cb = show({ decisaoDePublicar: PRONTO });
    const publicar = botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE);
    expect(publicar.disabled).toBe(false);
    fireEvent.click(publicar);
    expect(cb.onPublicar).toHaveBeenCalledTimes(1);
    expect(cb.onConfirmarPublicacao).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`${RAIZ}-publicar-aviso`)).toBeNull();
  });

  it('NEAR-MISS: a decision that blocks ⇒ disabled, no `onPublicar`, and its `aviso` under the button', () => {
    const cb = show({
      decisaoDePublicar: {
        podePublicar: false,
        impedimento: 'produto-nao-salvo',
        pendencias: [],
        aviso: FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
      },
    });
    const publicar = botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE);
    expect(publicar.disabled).toBe(true);
    fireEvent.click(publicar);
    expect(cb.onPublicar).not.toHaveBeenCalled();
    expect(screen.getByTestId(`${RAIZ}-publicar-aviso`).textContent).toBe(
      FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
    );
  });

  it('a block impediment with NO aviso (the block’s notice already says why) ⇒ disabled, no aviso line', () => {
    show({
      decisaoDePublicar: {
        podePublicar: false,
        impedimento: 'publicacao-em-andamento',
        pendencias: [],
        aviso: null,
      },
    });
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).disabled).toBe(true);
    expect(screen.queryByTestId(`${RAIZ}-publicar-aviso`)).toBeNull();
  });

  it('the publish in flight spins on «Publicar» only', () => {
    show({ bloco: bloco({ ocupado: true }), emVoo: 'publicar' });
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).getAttribute('data-loading')).toBe('true');
    expect(botao('Salvar rascunho').getAttribute('data-loading')).toBeNull();
    expect(botao('Descartar').getAttribute('data-loading')).toBeNull();
  });

  it('NEAR-MISS: a save in flight does not spin «Publicar»', () => {
    show({ bloco: bloco({ ocupado: true }), emVoo: 'salvar-rascunho' });
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).getAttribute('data-loading')).toBeNull();
  });
});

describe('RascunhoShopee — «Publicar» through the REAL gate (`publicacaoDoRascunhoShopee`)', () => {
  const TEXTOS = { nomeProduto: 'Camiseta', descricaoProduto: 'Algodão' };
  const LIMITES = { itemNameLengthLimit: { min: 1, max: 120 }, itemDescriptionLengthLimit: null };
  /** Saved, with a category and «Sem marca»: nothing the publish would refuse. */
  const pronto = (extra: Record<string, unknown> = {}) =>
    rascunho({ category_id: 100087, brand_id: 0, ...extra });

  it('a clean saved draft with every input known ⇒ enabled, no pendência, no aviso', () => {
    show({ bloco: bloco({ link: pronto() }), textosDoProduto: TEXTOS, limites: LIMITES });
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).disabled).toBe(false);
    expect(screen.queryByTestId(`${RAIZ}-pendencias`)).toBeNull();
    expect(screen.queryByTestId(`${RAIZ}-publicar-aviso`)).toBeNull();
  });

  it('NEAR-MISS: unsaved changes ⇒ disabled with «Salve as alterações…»', () => {
    const link = pronto();
    const edicao = comCampoRascunhoShopee(entrada(link), CAMPO_RASCUNHO_SHOPEE.itemName, 'Outra');
    show({ bloco: bloco({ link, edicao }), textosDoProduto: TEXTOS, limites: LIMITES });
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).disabled).toBe(true);
    expect(screen.getByTestId(`${RAIZ}-publicar-aviso`).textContent).toBe(
      FRASE_PUBLICAR_COM_ALTERACOES_SHOPEE,
    );
  });

  it('NEAR-MISS: the bands not loaded ⇒ disabled with the bands sentence (rule e)', () => {
    show({ bloco: bloco({ link: pronto() }), textosDoProduto: TEXTOS, limites: null });
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).disabled).toBe(true);
    expect(screen.getByTestId(`${RAIZ}-publicar-aviso`).textContent).toBe(
      FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE,
    );
  });

  it('`incerta` does NOT block: its publish is a real one (ENSURE first)', () => {
    const link = pronto(travaCarimbada(AGORA - 1_000_000, AGORA - 500_000));
    show({ bloco: bloco({ link }), textosDoProduto: TEXTOS, limites: LIMITES });
    expect(screen.getByText(FRASE_RASCUNHO_INCERTO_SHOPEE)).toBeTruthy();
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).disabled).toBe(false);
  });

  it('NEAR-MISS: `em-andamento` blocks it (the publish answers 409 now)', () => {
    const link = pronto(travaCarimbada(AGORA - 10_000, AGORA + 60_000));
    show({ bloco: bloco({ link }), textosDoProduto: TEXTOS, limites: LIMITES });
    expect(botao(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).disabled).toBe(true);
  });
});

describe('RascunhoShopee — the «Publicar» confirmation (controlled by the editor)', () => {
  const dialogo = () => within(screen.getByTestId(`shopee-rascunho-publicar-${LINK}`));
  const confirmar = (nome: string) =>
    dialogo().getByRole('button', { name: nome }) as HTMLButtonElement;
  const caixa = () => dialogo().getByRole('checkbox') as HTMLInputElement;

  it('closed (`null`) ⇒ nothing rendered', () => {
    show({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: null });
    expect(screen.queryByTestId(`shopee-rascunho-publicar-${LINK}`)).toBeNull();
  });

  it('open: the publish text for THIS conta, «Criar pausado» unticked, no D15 warning, no attestation', () => {
    const b = bloco();
    show({ bloco: b, decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO });
    expect(screen.getByText(TITULO_PUBLICAR_RASCUNHO_SHOPEE)).toBeTruthy();
    const texto = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Principal',
      publicacao: b.publicacao,
    });
    expect(texto).toContain('«Loja Principal»');
    expect(dialogo().getByText(texto)).toBeTruthy();
    expect(dialogo().getByLabelText(ROTULO_CRIAR_PAUSADO_SHOPEE)).toBe(caixa());
    expect(caixa().checked).toBe(false);
    expect(screen.queryByTestId(`shopee-rascunho-publicar-${LINK}-segundo-anuncio`)).toBeNull();
    expect(screen.queryByTestId(`shopee-rascunho-publicar-${LINK}-atestacao`)).toBeNull();
    expect(confirmar(ROTULO_PUBLICAR_RASCUNHO_SHOPEE).disabled).toBe(false);
  });

  it('confirm hands «Criar pausado» AS TICKED NOW — unticked ⇒ `false`', () => {
    const cb = show({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO });
    fireEvent.click(confirmar(ROTULO_PUBLICAR_RASCUNHO_SHOPEE));
    expect(cb.onConfirmarPublicacao).toHaveBeenCalledWith(false);
    expect(cb.onCancelarPublicacao).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: ticked ⇒ `true`', () => {
    const cb = show({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO });
    fireEvent.click(caixa());
    expect(caixa().checked).toBe(true);
    fireEvent.click(confirmar(ROTULO_PUBLICAR_RASCUNHO_SHOPEE));
    expect(cb.onConfirmarPublicacao).toHaveBeenCalledWith(true);
  });

  it('«Cancelar» closes through the editor and sends nothing', () => {
    const cb = show({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO });
    fireEvent.click(confirmar('Cancelar'));
    expect(cb.onCancelarPublicacao).toHaveBeenCalledTimes(1);
    expect(cb.onConfirmarPublicacao).not.toHaveBeenCalled();
  });

  it('a 409 re-ask keeps the refused request’s «Criar pausado» (`pausado: true` ⇒ ticked)', () => {
    const cb = show({
      decisaoDePublicar: PRONTO,
      confirmacaoDePublicacao: { ...CONFIRMACAO, pausado: true },
    });
    expect(caixa().checked).toBe(true);
    fireEvent.click(confirmar(ROTULO_PUBLICAR_RASCUNHO_SHOPEE));
    expect(cb.onConfirmarPublicacao).toHaveBeenCalledWith(true);
  });

  it('every opening starts from the EDITOR’s value — a tick does not survive a close', () => {
    const r = show({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO });
    fireEvent.click(caixa());
    expect(caixa().checked).toBe(true);
    r.rerender({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: null });
    expect(screen.queryByTestId(`shopee-rascunho-publicar-${LINK}`)).toBeNull();
    r.rerender({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO });
    expect(caixa().checked).toBe(false);
  });

  it('D15: a second listing ⇒ the warning, its title, and «Publicar mesmo assim»', () => {
    const segundoAnuncio = { quantidade: 2, comRascunho: true };
    const cb = show({
      decisaoDePublicar: PRONTO,
      confirmacaoDePublicacao: { ...CONFIRMACAO, segundoAnuncio },
    });
    expect(screen.getByText(TITULO_SEGUNDO_ANUNCIO_NA_PUBLICACAO_SHOPEE)).toBeTruthy();
    expect(screen.queryByText(TITULO_PUBLICAR_RASCUNHO_SHOPEE)).toBeNull();
    expect(screen.getByTestId(`shopee-rascunho-publicar-${LINK}-segundo-anuncio`).textContent).toBe(
      textoDoSegundoAnuncioNaPublicacaoShopee(segundoAnuncio),
    );
    expect(dialogo().queryByRole('button', { name: ROTULO_PUBLICAR_RASCUNHO_SHOPEE })).toBeNull();
    fireEvent.click(confirmar(ROTULO_PUBLICAR_SEGUNDO_ANUNCIO_SHOPEE));
    expect(cb.onConfirmarPublicacao).toHaveBeenCalledWith(false);
  });

  it('an attestation exit opened it ⇒ what the operator attested is said', () => {
    show({
      decisaoDePublicar: PRONTO,
      confirmacaoDePublicacao: {
        ...CONFIRMACAO,
        atestacao: {
          tipo: 'publicar-atestando',
          rotulo: ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
          adota: [],
        },
      },
    });
    expect(screen.getByTestId(`shopee-rascunho-publicar-${LINK}-atestacao`).textContent).toContain(
      ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
    );
    // `adota: []` ⇒ the publish creates: the create text.
    expect(screen.getByTestId(`shopee-rascunho-publicar-${LINK}`).textContent).toContain(
      'O anúncio será criado na conta «Loja Principal»',
    );
  });

  it('an attestation exit that ADOPTS (§C #8 mixed) ⇒ the text names the adopted listing and never «será criado»', () => {
    const b = bloco();
    show({
      bloco: b,
      decisaoDePublicar: PRONTO,
      confirmacaoDePublicacao: {
        ...CONFIRMACAO,
        atestacao: { tipo: 'publicar-atestando', rotulo: 'Publicar confirmando', adota: [222] },
      },
    });
    const texto = screen.getByTestId(`shopee-rascunho-publicar-${LINK}`).textContent ?? '';
    expect(texto).toContain(
      textoDaConfirmacaoDePublicacaoShopee({
        contaNome: 'Loja Principal',
        publicacao: b.publicacao,
        adota: [222],
      }),
    );
    expect(texto).not.toContain('será criado');
  });

  it('an `incerta` draft’s text says the publish may ADOPT (and «Criar pausado» then does not apply)', () => {
    const link = rascunho(travaCarimbada(AGORA - 1_000_000, AGORA - 500_000));
    const b = bloco({ link });
    expect(b.publicacao.tipo).toBe('incerta');
    show({ bloco: b, decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO });
    const texto = textoDaConfirmacaoDePublicacaoShopee({
      contaNome: 'Loja Principal',
      publicacao: b.publicacao,
    });
    expect(texto).toContain('«Criar pausado» não se aplica');
    expect(dialogo().getByText(texto)).toBeTruthy();
  });

  it('NEAR-MISS: a `livre` draft’s text never mentions an adoption', () => {
    show({ decisaoDePublicar: PRONTO, confirmacaoDePublicacao: CONFIRMACAO });
    expect(screen.getByTestId(`shopee-rascunho-publicar-${LINK}`).textContent).not.toContain(
      'não se aplica',
    );
  });

  it('the decision turned against it while open ⇒ the confirm is disabled, says why, and sends nothing', () => {
    const cb = show({
      decisaoDePublicar: {
        podePublicar: false,
        impedimento: 'produto-nao-salvo',
        pendencias: [],
        aviso: FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
      },
      confirmacaoDePublicacao: CONFIRMACAO,
    });
    const botaoConfirmar = confirmar(ROTULO_PUBLICAR_RASCUNHO_SHOPEE);
    expect(botaoConfirmar.disabled).toBe(true);
    fireEvent.click(botaoConfirmar);
    expect(cb.onConfirmarPublicacao).not.toHaveBeenCalled();
    expect(dialogo().getByText(FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE)).toBeTruthy();
  });
});

describe('RascunhoShopee — field ids (what a refusal row’s «Corrigir no rascunho» focuses)', () => {
  it('the title and the description inputs carry their ids; the pickers sit inside theirs', () => {
    show();
    expect(titulo().id).toBe(idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.itemName));
    expect(descricao().id).toBe(idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.description));
    const categoria = document.getElementById(
      idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.categoryId),
    );
    const marca = document.getElementById(
      idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.marca),
    );
    expect(within(categoria!).getByTestId('stub-categoria')).toBeTruthy();
    expect(within(marca!).getByTestId('stub-marca')).toBeTruthy();
  });

  it('NEAR-MISS: ids are per DRAFT — another link’s id names nothing here', () => {
    show();
    expect(
      document.getElementById(idDoCampoRascunhoShopee('outro', CAMPO_RASCUNHO_SHOPEE.itemName)),
    ).toBeNull();
  });
});
