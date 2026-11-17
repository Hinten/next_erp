import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { OPCOES_IMPORTACAO_SHOPEE_PADRAO, SHOPEE_IMPORT_STATUS } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  DESCRICAO_IMPORTAR_FOTOS_SHOPEE,
  ROTULO_OPCAO_IMPORTACAO_SHOPEE,
  ROTULO_STATUS_IMPORTACAO_SHOPEE,
} from '@/lib/shopee/rotulosImportacaoShopee';
import type { ImportarTodosShopeeActionState } from './useImportarTodosShopeeAction';
import type { AtualizarPrecosShopeeActionState } from './useAtualizarPrecosShopeeAction';

// The calendar has its own library tests; two plain inputs drive the range so
// the dialog's own rules — both ends or neither, SECONDS on the wire — are what
// is exercised here (the `relatorios/checkouts/page.test.tsx` precedent). Its
// label is rendered too, so the shared label module's `janela` is on screen.
vi.mock('@mantine/dates', () => ({
  DatePickerInput: ({
    label,
    value,
    onChange,
    error,
  }: {
    label?: string;
    value: [string | null, string | null];
    onChange: (value: [string | null, string | null]) => void;
    error?: string | null;
  }) => (
    <>
      <span>{label}</span>
      <input
        aria-label="Janela — de"
        value={value[0] ?? ''}
        onChange={(e) => onChange([e.target.value || null, value[1]])}
      />
      <input
        aria-label="Janela — até"
        value={value[1] ?? ''}
        onChange={(e) => onChange([value[0], e.target.value || null])}
      />
      {error ? <span>{error}</span> : null}
    </>
  ),
}));

const { ImportarTodosShopeeDialog } = await import('./ImportarTodosShopeeDialog');
const { AtualizarPrecosShopeeDialog } = await import('./AtualizarPrecosShopeeDialog');

function estadoImportacao(): ImportarTodosShopeeActionState {
  return {
    opened: true,
    contas: [{ id: 'int-1', nome: 'Loja A' }],
    busy: false,
    entries: [],
    reatados: new Set(),
    close: vi.fn(),
    start: vi.fn(async () => {}),
    dismiss: vi.fn(),
  };
}

function renderImportacao(state = estadoImportacao()) {
  render(
    <MantineTestProvider>
      <ImportarTodosShopeeDialog state={state} />
    </MantineTestProvider>,
  );
  return state;
}

const iniciar = () => screen.getByRole('button', { name: 'Iniciar importação' });
const caixa = (rotulo: string) => screen.getByLabelText(rotulo) as HTMLInputElement;

/** The body the dialog sends untouched: the backend's defaults, Ativos and Inativos. */
const CORPO_PADRAO = {
  ...OPCOES_IMPORTACAO_SHOPEE_PADRAO,
  statuses: [SHOPEE_IMPORT_STATUS.normal, SHOPEE_IMPORT_STATUS.unlist],
};

describe('ImportarTodosShopeeDialog', () => {
  it('names the conta the run will touch', () => {
    renderImportacao();
    expect(screen.getByText('1 conta selecionada')).not.toBeNull();
    expect(screen.getByText('Loja A')).not.toBeNull();
  });

  it('⭐ sends EVERY option, starting from the backend’s own defaults — Ativos and Inativos, no window', () => {
    const state = renderImportacao();
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith(CORPO_PADRAO);
  });

  it('keeps the statuses in the canonical order, whatever order they were clicked in', () => {
    const state = renderImportacao();
    fireEvent.click(screen.getByLabelText('Ativos'));
    fireEvent.click(screen.getByLabelText('Inativos'));
    fireEvent.click(screen.getByLabelText('Em revisão'));
    fireEvent.click(screen.getByLabelText('Ativos'));
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: [SHOPEE_IMPORT_STATUS.normal, SHOPEE_IMPORT_STATUS.reviewing],
      }),
    );
  });

  it('refuses to start with no status — the wire parameter is required', () => {
    const state = renderImportacao();
    fireEvent.click(screen.getByLabelText('Ativos'));
    fireEvent.click(screen.getByLabelText('Inativos'));

    expect(screen.getByText('Escolha pelo menos um status.')).not.toBeNull();
    expect((iniciar() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(iniciar());
    expect(state.start).not.toHaveBeenCalled();
  });

  it('⭐ turns the date window into SECONDS, whole São Paulo days', () => {
    const state = renderImportacao();
    fireEvent.change(screen.getByLabelText('Janela — de'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Janela — até'), { target: { value: '2026-10-02' } });
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({ updateTimeFromS: 1790823600, updateTimeToS: 1790996399 }),
    );
  });

  it('refuses half a window instead of guessing the other end', () => {
    const state = renderImportacao();
    fireEvent.change(screen.getByLabelText('Janela — de'), { target: { value: '2026-10-01' } });

    expect(screen.getByText('Escolha as duas datas da janela, ou limpe-a.')).not.toBeNull();
    expect((iniciar() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(iniciar());
    expect(state.start).not.toHaveBeenCalled();
  });

  it('#2015: every label the shared module names is on screen, with the default the refusal copy claims', () => {
    // `anuncioProduto.ts`'s import-remedy copy (`logistica-nao-confirmada`,
    // `logistica-sem-valor-gravado`) quotes these labels and says which come
    // ticked: the screen must agree with both.
    const R = ROTULO_OPCAO_IMPORTACAO_SHOPEE;
    const S = ROTULO_STATUS_IMPORTACAO_SHOPEE;
    renderImportacao();
    for (const chave of [
      'importarEstoque',
      'sobrescreverEstoque',
      'importarPreco',
      'sobrescreverPreco',
      'importarFotos',
      'importarCategorias',
      'atualizarProdutoPai',
      'sobrescreverDadosProduto',
      'atualizarCadastrados',
    ] as const) {
      expect(caixa(R[chave]).type, chave).toBe('checkbox');
    }
    // «desmarque … (vem marcado)»: ticked, and untickable as the dialog opens.
    expect(caixa(R.sobrescreverPreco).checked).toBe(true);
    expect(caixa(R.sobrescreverPreco).disabled).toBe(false);
    // «deixe desmarcados …» / «… marcado» (the operator ticks it).
    expect(caixa(R.sobrescreverEstoque).checked).toBe(false);
    expect(caixa(R.sobrescreverDadosProduto).checked).toBe(false);
    expect(caixa(R.atualizarCadastrados).checked).toBe(false);
    // «(«Banidos» e «Em revisão» vêm desmarcados)» — the other two come ticked.
    expect(caixa(S[SHOPEE_IMPORT_STATUS.banned]).checked).toBe(false);
    expect(caixa(S[SHOPEE_IMPORT_STATUS.reviewing]).checked).toBe(false);
    expect(caixa(S[SHOPEE_IMPORT_STATUS.normal]).checked).toBe(true);
    expect(caixa(S[SHOPEE_IMPORT_STATUS.unlist]).checked).toBe(true);
    expect(screen.getByText(R.statuses)).not.toBeNull();
    // «… a «Janela de atualização (opcional)» vazia»: it opens empty.
    expect(screen.getByText(R.janela)).not.toBeNull();
    expect(caixa('Janela — de').value).toBe('');
    expect(caixa('Janela — até').value).toBe('');
    // «Com «Importar fotos» marcado (vem marcado), a importação acrescenta fotos…».
    expect(caixa(R.importarFotos).checked).toBe(true);
  });

  it('#2099: «Importar fotos» says photos are APPENDED and a removed one comes back — under that box, and only there', () => {
    const R = ROTULO_OPCAO_IMPORTACAO_SHOPEE;
    renderImportacao();
    const raizDa = (rotulo: string) =>
      caixa(rotulo).closest('.mantine-Checkbox-root') as HTMLElement;

    // By reference: the dialog renders the module's sentence, never a retyped one.
    expect(
      within(raizDa(R.importarFotos)).getByText(DESCRICAO_IMPORTAR_FOTOS_SHOPEE),
    ).not.toBeNull();
    // Near-miss: the box beside it carries no such description (`getByText`
    // below also proves it is on screen exactly once).
    expect(
      within(raizDa(R.importarCategorias)).queryByText(DESCRICAO_IMPORTAR_FOTOS_SHOPEE),
    ).toBeNull();
    expect(screen.getByText(DESCRICAO_IMPORTAR_FOTOS_SHOPEE)).not.toBeNull();
  });

  it('#2099 (C8): the «Importar fotos» description is the decided sentence, VERBATIM — a removed photo comes back, and the dedup is never worded as a history', () => {
    // PAIR: the decided C8 copy, verbatim (#1911 P14b design §4 C8). The test above
    // renders it BY REFERENCE, which follows any drift of the constant's text.
    expect(DESCRICAO_IMPORTAR_FOTOS_SHOPEE).toBe(
      'Acrescenta ao produto as fotos do anúncio; nunca remove nem substitui uma foto já cadastrada. Uma foto removida do produto volta se ainda estiver no anúncio.',
    );
    // NEAR-MISS: the dedup reads the produto's CURRENT photos, not what this conta
    // brought before, and a photo is never replaced (the same pair as the import
    // recipe's in `lib/shopee/anuncioProduto.test.ts`).
    expect(DESCRICAO_IMPORTAR_FOTOS_SHOPEE).not.toContain('ainda não trouxe');
    expect(DESCRICAO_IMPORTAR_FOTOS_SHOPEE).not.toMatch(/substituídas|trocadas/);
  });

  it('sends the toggles the operator changed', () => {
    const state = renderImportacao();
    fireEvent.click(screen.getByLabelText('Importar fotos'));
    fireEvent.click(screen.getByLabelText('Atualizar anúncios já cadastrados'));
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({ importarFotos: false, atualizarCadastrados: true }),
    );
  });
});

/**
 * #2099 trap (a): every «Sobrescrever …» box hangs off the box above it. Greyed
 * out, it must be neither shown ticked nor sent ticked — and it is sent `false`,
 * never omitted, because the route's sanitizer fills an omitted key from the
 * defaults (`sobrescreverPreco: true`). Every body is asserted WHOLE, so an
 * omitted or stray key fails too.
 */
describe('ImportarTodosShopeeDialog — a greyed-out «Sobrescrever …» box (#2099)', () => {
  const R = ROTULO_OPCAO_IMPORTACAO_SHOPEE;
  const PARES = [
    { pai: 'importarEstoque', caixa: 'sobrescreverEstoque' },
    { pai: 'importarPreco', caixa: 'sobrescreverPreco' },
    { pai: 'atualizarProdutoPai', caixa: 'sobrescreverDadosProduto' },
  ] as const;

  /** Ticks the dependent box unless it already opens ticked (only the price one does). */
  function marcarCaixa(chave: (typeof PARES)[number]['caixa']) {
    if (!caixa(R[chave]).checked) fireEvent.click(caixa(R[chave]));
    expect(caixa(R[chave]).checked, chave).toBe(true);
  }

  it.each(PARES)(
    'PAIR: «$pai» ticked + «$caixa» ticked ⇒ shown ticked and enabled, and sent `true`',
    ({ pai, caixa: chave }) => {
      const state = renderImportacao();
      marcarCaixa(chave);

      expect(caixa(R[pai]).checked).toBe(true);
      expect(caixa(R[chave]).disabled).toBe(false);
      fireEvent.click(iniciar());
      expect(state.start).toHaveBeenCalledTimes(1);
      expect(state.start).toHaveBeenCalledWith({ ...CORPO_PADRAO, [chave]: true });
    },
  );

  it.each(PARES)(
    '⛔ NEAR-MISS: «$pai» unticked + «$caixa» ticked ⇒ greyed out, shown UNticked, and sent `false` (never omitted)',
    ({ pai, caixa: chave }) => {
      const state = renderImportacao();
      marcarCaixa(chave);
      fireEvent.click(caixa(R[pai]));

      expect(caixa(R[pai]).checked).toBe(false);
      expect(caixa(R[chave]).disabled).toBe(true);
      expect(caixa(R[chave]).checked).toBe(false);
      fireEvent.click(iniciar());
      expect(state.start).toHaveBeenCalledTimes(1);
      // WHOLE body: the dependent key is present and `false`, and the other two
      // pairs are untouched (unticking one parent greys out only its own box).
      expect(state.start).toHaveBeenCalledWith({ ...CORPO_PADRAO, [pai]: false, [chave]: false });
    },
  );

  it.each(PARES)(
    'unticking «$pai» greys out only «$caixa»: the other two boxes stay enabled and show their own value',
    ({ pai, caixa: chave }) => {
      renderImportacao();
      fireEvent.click(caixa(R[pai]));

      for (const outro of PARES.filter((p) => p.caixa !== chave)) {
        expect(caixa(R[outro.caixa]).disabled, outro.caixa).toBe(false);
        expect(caixa(R[outro.caixa]).checked, outro.caixa).toBe(
          OPCOES_IMPORTACAO_SHOPEE_PADRAO[outro.caixa],
        );
      }
    },
  );

  it.each(PARES)(
    're-ticking «$pai» brings the «$caixa» preference back: shown ticked and sent `true`',
    ({ pai, caixa: chave }) => {
      const state = renderImportacao();
      marcarCaixa(chave);
      fireEvent.click(caixa(R[pai]));
      expect(caixa(R[chave]).checked).toBe(false);
      fireEvent.click(caixa(R[pai]));

      expect(caixa(R[chave]).disabled).toBe(false);
      expect(caixa(R[chave]).checked).toBe(true);
      fireEvent.click(iniciar());
      expect(state.start).toHaveBeenCalledWith({ ...CORPO_PADRAO, [chave]: true });
    },
  );

  it('⭐ the #2099 case: unticking «Importar preço» at the defaults stops the re-pricing — `sobrescreverPreco: false`', () => {
    const state = renderImportacao();
    fireEvent.click(caixa(R.importarPreco));
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith({
      ...OPCOES_IMPORTACAO_SHOPEE_PADRAO,
      statuses: [SHOPEE_IMPORT_STATUS.normal, SHOPEE_IMPORT_STATUS.unlist],
      importarPreco: false,
      sobrescreverPreco: false,
    });
  });
});

describe('AtualizarPrecosShopeeDialog', () => {
  function estadoPrecos(baixarPreco: boolean): AtualizarPrecosShopeeActionState {
    return {
      opened: true,
      contas: [{ id: 'int-1', nome: 'Loja A' }],
      baixarPreco,
      setBaixarPreco: vi.fn(),
      busy: false,
      entries: [],
      reatados: new Set(),
      close: vi.fn(),
      start: vi.fn(async () => {}),
      dismiss: vi.fn(),
    };
  }

  it('shows the decrease opt-in as the hook holds it and reports a change', () => {
    const state = estadoPrecos(false);
    render(
      <MantineTestProvider>
        <AtualizarPrecosShopeeDialog state={state} />
      </MantineTestProvider>,
    );
    const opcao = screen.getByLabelText('Permitir baixar preços') as HTMLInputElement;
    expect(opcao.checked).toBe(false);

    fireEvent.click(opcao);
    expect(state.setBaixarPreco).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Atualizar preços' }));
    expect(state.start).toHaveBeenCalled();
  });
});
