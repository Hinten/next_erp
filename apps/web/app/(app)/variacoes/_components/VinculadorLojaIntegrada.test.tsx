import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import {
  CODIGO_ERRO_LI,
  INTEGRACAO_TIPO,
  type RespostaGradeLi,
  type RespostaGradesLi,
} from '@delfrance/schemas';
import { DELETE_MARK, SectionTabs } from '@delfrance/ui';

import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The Loja Integrada tab of a variation group, on its own: a real form context,
 * a faked backend client (`lojaIntegradaClientFalso`, so every route it does not
 * expect rejects naming itself) and a faked conta list.
 *
 * Pinned (nothing in the tab is thrown away without a click):
 *  - under the switch-off answer the stored links still render with their
 *    stored names, with the linker's own copy, and stay editable; adding is off;
 *  - an option row stays visible after its last variante is cleared;
 *  - an invalid entry and another conta's entry are shown, staged-removable, and
 *    carried back UNCHANGED by an edit elsewhere;
 *  - no grade is read while the tab is not the active one;
 *  - with the store readable: add a link, assign variantes, see a stale grade
 *    marked (never pruned), and the yellow warning for two variantes on one option.
 */

const h = vi.hoisted(() => ({
  grades: vi.fn(),
  grade: vi.fn(),
  integracoes: [] as { id: string; data: Record<string, unknown> }[],
  statusIntegracoes: 'success' as 'pending' | 'error' | 'success',
}));

vi.mock('@/lib/loja-integrada/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/loja-integrada/client')>();
  const { lojaIntegradaClientFalso } = await import('@/lib/testing/lojaIntegradaClientFalso');
  const client = lojaIntegradaClientFalso({ grades: h.grades, grade: h.grade });
  return { ...actual, useBackendLojaIntegrada: () => ({ client, indisponivel: null }) };
});
vi.mock('@/lib/data/useIntegracoes', () => ({
  useIntegracoes: () => ({
    rows: h.statusIntegracoes === 'success' ? h.integracoes : [],
    byId: new Map(h.integracoes.map((r) => [r.id, r.data])),
    status: h.statusIntegracoes,
  }),
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));

const { VinculadorLojaIntegrada } = await import('./VinculadorLojaIntegrada');
const { LojaIntegradaClientHttpError } = await import('@/lib/loja-integrada/client');

type Doc = Record<string, unknown>;

const VARIANTES = [
  { id: 'v1', nome: 'P', codigo: null },
  { id: 'v2', nome: 'M', codigo: null },
  { id: 'v3', nome: 'G', codigo: null },
];

const opcao = (id: number, variantes: string[], nome: string | null): Doc => ({
  li_option_id: id,
  li_option_name: nome,
  arakene_variation_id: variantes,
});
/** A legacy-shaped link of the active conta: grade 8946 with two options. */
const GUARDADO: Doc = {
  name: 'Tamanho',
  grade_id: 8946,
  integracaoLiId: 'CONTA1',
  variationOptions: [opcao(37097, ['v1'], 'P'), opcao(37098, ['v2'], 'M')],
  chaveDesconhecida: 'mantida',
};
const MEIA_BOCA: Doc = { integracaoLiId: 'CONTA1' };
const DE_OUTRA_CONTA: Doc = {
  name: 'Cor',
  grade_id: 9001,
  integracaoLiId: 'CONTA2',
  variationOptions: [opcao(1, ['v3'], 'Azul')],
};

const GRADES: RespostaGradesLi = {
  grades: [
    { id: 8946, nome: 'Tamanho', nomeVisivel: 'Tamanho' },
    { id: 8950, nome: 'Numeração', nomeVisivel: null },
  ],
  lidaEmMs: 1_790_000_000_000,
};
const DETALHE_8946: RespostaGradeLi = {
  grade: GRADES.grades[0]!,
  opcoes: [
    { id: 37097, nome: 'P' },
    { id: 37098, nome: 'M' },
    { id: 37099, nome: 'G' },
  ],
  lidaEmMs: 1_790_000_000_000,
};
const DETALHE_8950: RespostaGradeLi = {
  grade: GRADES.grades[1]!,
  opcoes: [{ id: 41, nome: '40' }],
  lidaEmMs: 1_790_000_000_000,
};

const desligado = () =>
  new LojaIntegradaClientHttpError('desligadas', 503, CODIGO_ERRO_LI.chamadasDesligadas);

/** The latest form value of the field, read back from the harness. */
let valorAtual: () => unknown = () => undefined;

function Harness({ inicial }: { inicial: unknown }) {
  const form = useForm({ defaultValues: { variacoes: VARIANTES, linksVariacoesli: inicial } });
  const valor = useWatch({ control: form.control, name: 'linksVariacoesli' });
  useEffect(() => {
    valorAtual = () => form.getValues('linksVariacoesli');
  }, [form]);
  return (
    <FormProvider {...form}>
      <VinculadorLojaIntegrada
        value={valor}
        onChange={(v) => form.setValue('linksVariacoesli', v as never, { shouldDirty: true })}
      />
    </FormProvider>
  );
}

function Host({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MantineTestProvider>{children}</MantineTestProvider>
    </QueryClientProvider>
  );
}

async function renderTab(inicial: unknown) {
  render(
    <Host>
      <Harness inicial={inicial} />
    </Host>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function clicar(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Pick `rotulo` in the Mantine (Multi)Select labelled `label` inside `escopo`. */
async function escolher(escopo: HTMLElement, label: string, rotulo: string) {
  // The dropdown's listbox carries the same label as the input: take the input.
  await clicar(within(escopo).getAllByLabelText(label)[0]!);
  await clicar(await within(escopo).findByRole('option', { name: rotulo }));
}

const blocoDaConta = () => screen.getByTestId('vinculador-li-conta-CONTA1');
const cartao = (grade: number) => screen.getByTestId(`vinculo-li-CONTA1-${grade}`);

beforeEach(() => {
  h.grades.mockReset();
  h.grade.mockReset();
  h.statusIntegracoes = 'success';
  h.integracoes = [
    { id: 'CONTA1', data: { tipo: INTEGRACAO_TIPO.lojaIntegrada, nome: 'Loja A', ativo: true } },
    { id: 'CONTA2', data: { tipo: INTEGRACAO_TIPO.lojaIntegrada, nome: 'Loja B', ativo: false } },
    { id: 'ML1', data: { tipo: INTEGRACAO_TIPO.mercadoLivre, nome: 'ML', ativo: true } },
  ];
});

describe('Loja Integrada tab — the store cannot be read (switch off)', () => {
  beforeEach(() => {
    h.grades.mockRejectedValue(desligado());
    h.grade.mockRejectedValue(desligado());
  });

  it('shows the stored links with their STORED names, and the linker’s own copy', async () => {
    await renderTab([GUARDADO]);

    expect(within(cartao(8946)).getByText('Tamanho (8946)')).toBeTruthy();
    expect(within(cartao(8946)).getAllByLabelText('Variantes da opção P')).not.toHaveLength(0);
    expect(within(cartao(8946)).getAllByLabelText('Variantes da opção M')).not.toHaveLength(0);
    expect(within(blocoDaConta()).getByText(/só podem ser lidas depois da migração/)).toBeTruthy();
    // Adding needs the store's grade list.
    expect(
      (
        within(blocoDaConta()).getByRole('button', {
          name: 'Adicionar vínculo',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('stays editable: assigning a variante changes ONLY that entry, extra keys kept', async () => {
    await renderTab([GUARDADO, DE_OUTRA_CONTA]);

    await escolher(cartao(8946), 'Variantes da opção M', 'G');

    const valor = valorAtual() as Doc[];
    expect(valor[0]).toEqual({
      ...GUARDADO,
      variationOptions: [opcao(37097, ['v1'], 'P'), opcao(37098, ['v2', 'v3'], 'M')],
    });
    // Another conta's entry is carried back UNCHANGED.
    expect(valor[1]).toEqual(DE_OUTRA_CONTA);
  });

  it('an option row stays visible after its last variante is cleared, and the option leaves the entry', async () => {
    await renderTab([GUARDADO]);

    // Clicking the one selected variante again deselects it.
    await escolher(cartao(8946), 'Variantes da opção P', 'P');

    expect((valorAtual() as Doc[])[0]?.variationOptions).toEqual([opcao(37098, ['v2'], 'M')]);
    expect(within(cartao(8946)).getAllByLabelText('Variantes da opção P')).not.toHaveLength(0);
  });

  it('an invalid entry and another conta’s entry are listed apart, each staged-removable', async () => {
    await renderTab([GUARDADO, MEIA_BOCA, DE_OUTRA_CONTA]);
    const outras = screen.getByTestId('vinculador-li-outras');

    expect(within(outras).getByText(/vínculo ilegível/)).toBeTruthy();
    expect(within(outras).getByText(/Loja B \(inativa\)/)).toBeTruthy();

    const linhaMeiaBoca = screen.getByTestId('vinculo-li-outro-1');
    await clicar(within(linhaMeiaBoca).getByRole('button', { name: 'Remover vínculo' }));
    expect((valorAtual() as Doc[])[1]).toEqual({ ...MEIA_BOCA, [DELETE_MARK]: true });
    // …nothing else moved.
    expect((valorAtual() as Doc[])[2]).toEqual(DE_OUTRA_CONTA);

    await clicar(within(linhaMeiaBoca).getByRole('button', { name: 'Desfazer remoção' }));
    expect((valorAtual() as Doc[])[1]).toEqual(MEIA_BOCA);
  });

  it('a path-shaped conta id is "conta não reconhecida", never matched to the conta', async () => {
    const comCaminho = { ...GUARDADO, integracaoLiId: 'documents/integracao/CONTA1' };
    await renderTab([comCaminho]);

    expect(screen.queryByTestId('vinculo-li-CONTA1-8946')).toBeNull();
    expect(
      within(screen.getByTestId('vinculador-li-outras')).getByText(/conta não reconhecida/),
    ).toBeTruthy();
  });
});

describe('Loja Integrada tab — when it reads', () => {
  it('reads no grade while the tab is not the active one', async () => {
    h.grades.mockResolvedValue(GRADES);
    h.grade.mockResolvedValue(DETALHE_8946);
    render(
      <Host>
        <SectionTabs
          sections={['Dados gerais', 'Loja Integrada']}
          contents={{ 'Dados gerais': null, 'Loja Integrada': <Harness inicial={[GUARDADO]} /> }}
          value="Dados gerais"
          onChange={() => undefined}
        />
      </Host>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.grades).not.toHaveBeenCalled();
    expect(h.grade).not.toHaveBeenCalled();
  });

  it('a backend older than the catalogue routes (404, no code) says it does not offer the read yet', async () => {
    h.grades.mockRejectedValue(new LojaIntegradaClientHttpError('404', 404, null));
    h.grade.mockRejectedValue(new LojaIntegradaClientHttpError('404', 404, null));
    await renderTab([GUARDADO]);

    expect(
      within(blocoDaConta()).getByText(/este backend ainda não oferece a leitura/),
    ).toBeTruthy();
  });
});

describe('Loja Integrada tab — the store is readable', () => {
  beforeEach(() => {
    h.grades.mockResolvedValue(GRADES);
    h.grade.mockImplementation(async (_conta: string, gradeId: number) =>
      gradeId === 8946 ? DETALHE_8946 : DETALHE_8950,
    );
  });

  it('adds a link through the grade list: the conta id verbatim, the grade’s nome as label', async () => {
    await renderTab([GUARDADO]);

    await escolher(blocoDaConta(), 'Grade da loja', 'Numeração (8950)');
    await clicar(within(blocoDaConta()).getByRole('button', { name: 'Adicionar vínculo' }));

    expect((valorAtual() as Doc[])[1]).toEqual({
      name: 'Numeração',
      grade_id: 8950,
      integracaoLiId: 'CONTA1',
      variationOptions: [],
    });
    // The new link's options come from the store's detail of that grade.
    await escolher(cartao(8950), 'Variantes da opção 40', 'G');
    expect((valorAtual() as Doc[])[1]?.variationOptions).toEqual([opcao(41, ['v3'], '40')]);
  });

  it('a grade already linked for this conta is not offered again', async () => {
    await renderTab([GUARDADO]);

    await clicar(within(blocoDaConta()).getAllByLabelText('Grade da loja')[0]!);

    expect(within(blocoDaConta()).queryByRole('option', { name: 'Tamanho (8946)' })).toBeNull();
    expect(within(blocoDaConta()).getByRole('option', { name: 'Numeração (8950)' })).toBeTruthy();
  });

  it('the store’s options are offered beside the stored ones', async () => {
    await renderTab([GUARDADO]);
    expect(await within(cartao(8946)).findAllByLabelText('Variantes da opção G')).not.toHaveLength(
      0,
    );
  });

  it('a stored grade missing from the store is MARKED "não encontrada na loja", never pruned', async () => {
    const sumida = { ...GUARDADO, grade_id: 7777, name: 'Antiga' };
    await renderTab([sumida]);

    expect(within(cartao(7777)).getByText('não encontrada na loja')).toBeTruthy();
    expect((valorAtual() as Doc[])[0]).toEqual(sumida);
  });

  it('two variantes on one option show the yellow warning — it does not block', async () => {
    await renderTab([GUARDADO]);

    await escolher(cartao(8946), 'Variantes da opção P', 'G');

    expect(
      within(cartao(8946)).getByText(
        /duas variantes usam a mesma opção; um produto que tenha as duas não poderá ser enviado/,
      ),
    ).toBeTruthy();
  });
});

describe('Loja Integrada tab — what it cannot read is still never dropped', () => {
  it('a stored value that is not a list is reported, and only an explicit click replaces it', async () => {
    h.grades.mockRejectedValue(desligado());
    const ilegivel = { legado: true };
    await renderTab(ilegivel);

    expect(screen.getByText(/não estão numa lista/)).toBeTruthy();
    expect(valorAtual()).toEqual(ilegivel);
    await clicar(screen.getByRole('button', { name: 'Substituir por uma lista vazia' }));
    expect(valorAtual()).toEqual([]);
  });

  it('while the conta list fails, every entry is listed read-only and kept', async () => {
    h.statusIntegracoes = 'error';
    h.grades.mockRejectedValue(desligado());
    await renderTab([GUARDADO]);

    expect(screen.getByText(/Não foi possível ler as contas/)).toBeTruthy();
    expect(screen.getByTestId('vinculo-li-outro-0')).toBeTruthy();
    expect(h.grades).not.toHaveBeenCalled();
  });
});
