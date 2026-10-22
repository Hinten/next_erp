import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { PERM } from '@delfrance/auth';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { ServicoMelhorEnvioSelectProps } from './ServicoMelhorEnvioSelect';
import { alvoFreteLiDoDoc, type AlvoFreteLi } from '@/lib/loja-integrada/useAlvosMapaFreteLi';
import type { FreteDaContaLi } from './useFreteDaContaLi';

/**
 * The "Mapeamento do Frete" tab of a Loja Integrada conta (step 20, #1826), as
 * a component: what each row shows (the mapped badge, the stored target's
 * label) and what an edit does to the form value. Doubled: the server-truth
 * seed (pinned by the page suite), the target list, the permission and the
 * Melhor Envio service select (its own suite).
 */

const h = vi.hoisted(() => ({
  permissoes: 0n,
  pronto: true,
  alvos: [] as AlvoFreteLi[],
  armazenados: new Map<string, AlvoFreteLi | null>(),
}));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({ allowed: (h.permissoes & bit) === bit, loading: false }),
}));
vi.mock('./useFreteDaContaLi', async (importActual) => ({
  ...(await importActual<typeof import('./useFreteDaContaLi')>()),
  useSemearFreteDaContaLi: () => ({ ready: h.pronto, error: null }),
}));
vi.mock('@/lib/loja-integrada/useAlvosMapaFreteLi', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/loja-integrada/useAlvosMapaFreteLi')>()),
  useAlvosMapaFreteLi: () => ({
    alvos: h.alvos,
    armazenados: h.armazenados,
    carregando: false,
    erro: null,
  }),
}));
vi.mock('./ServicoMelhorEnvioSelect', () => ({
  ServicoMelhorEnvioSelect: (p: ServicoMelhorEnvioSelectProps) => (
    <div data-testid="servico-me">
      <span>{`servico:${p.intFreteId}:${p.value ?? 'nenhum'}:${p.nomeArmazenado ?? ''}`}</span>
      <button
        type="button"
        disabled={p.disabled}
        onClick={() => p.onChange({ id: 2, name: 'SEDEX', company: { id: 1, name: 'Correios' } })}
      >
        escolher SEDEX
      </button>
    </div>
  ),
}));

const { MapaFreteManager } = await import('./MapaFreteManager');

type Doc = Record<string, unknown>;

// The shared query's own projection, so a test target carries every flag it would.
const alvo = (id: string, nome: string, tipo: string, ativo = true): AlvoFreteLi =>
  alvoFreteLiDoDoc(id, { nome, tipo, ativo });
const MOTO = alvo('moto-1', 'Moto Centro', 'motoboy');
const ME = alvo('me-conta', 'Conta ME', 'melhorEnvios');

const linha = (n: number, extra: Doc = {}): Doc => ({
  nomeOriginal: `Forma ${n}`,
  idOriginal: `100${n}---X`,
  observacao: `Origem: Pedido ${n}`,
  nomeTarget: null,
  targetData: null,
  integracaoUid: null,
  targetTipoIntegracao: 'outros',
  ...extra,
});

const ENCONTRADO: FreteDaContaLi = {
  estado: 'encontrado',
  intFreteId: 'lojaIntegrada-conta-1',
  ativo: true,
  total: 1,
  naConsulta: true,
};

function renderManager(
  inicial: unknown,
  { frete = ENCONTRADO, disabled = false }: { frete?: FreteDaContaLi; disabled?: boolean } = {},
) {
  const mudancas: unknown[] = [];
  function Host() {
    const [value, setValue] = useState<unknown>(inicial);
    return (
      <MapaFreteManager
        db={{} as never}
        frete={frete}
        value={value}
        disabled={disabled}
        onChange={(next) => {
          mudancas.push(next);
          setValue(next);
        }}
      />
    );
  }
  render(
    <MantineTestProvider>
      <Host />
    </MantineTestProvider>,
  );
  return mudancas;
}

const linhaNaTela = (i: number) => screen.getByTestId(`mapa-frete-linha-${i}`);
const destino = (i: number) =>
  within(linhaNaTela(i)).getAllByLabelText(`Destino da forma de envio ${i + 1}`)[0] as
    | HTMLInputElement
    | undefined;
async function escolherDestino(i: number, rotulo: string) {
  fireEvent.click(destino(i)!);
  fireEvent.click(await screen.findByRole('option', { name: rotulo }));
}

beforeEach(() => {
  h.permissoes = PERM.frete.write;
  h.pronto = true;
  h.alvos = [MOTO, ME];
  h.armazenados = new Map([
    [MOTO.id, MOTO],
    [ME.id, ME],
  ]);
});

describe('MapaFreteManager — the mapped badge (decided by integracaoUid alone)', () => {
  it('⚠️ NEAR-MISS: a row with a target tipo but no integracaoUid is NOT mapped', () => {
    renderManager([linha(1, { integracaoUid: null, targetTipoIntegracao: 'motoboy' })]);
    expect(within(linhaNaTela(0)).getByText('Sem mapeamento')).toBeTruthy();
  });

  it('⚠️ NEAR-MISS: an empty integracaoUid is NOT mapped', () => {
    renderManager([linha(1, { integracaoUid: '', targetTipoIntegracao: 'motoboy' })]);
    expect(within(linhaNaTela(0)).getByText('Sem mapeamento')).toBeTruthy();
  });

  it("EQUAL pair: a row whose target tipo is 'outros' WITH an integracaoUid IS mapped", () => {
    h.alvos = [...h.alvos, alvo('outro-1', 'Outro destino', 'outros')];
    renderManager([linha(1, { integracaoUid: 'outro-1', targetTipoIntegracao: 'outros' })]);
    expect(within(linhaNaTela(0)).getByText('Mapeada')).toBeTruthy();
  });

  it('EQUAL pair: a path-form integracaoUid names the same stored target as its bare id', () => {
    renderManager([
      linha(1, { integracaoUid: 'documents/int_frete/moto-1', targetTipoIntegracao: 'motoboy' }),
      linha(2, { integracaoUid: 'moto-1', targetTipoIntegracao: 'motoboy' }),
    ]);
    expect(destino(0)?.value).toBe('Moto Centro (Motoboy)');
    expect(destino(1)?.value).toBe('Moto Centro (Motoboy)');
    expect(within(linhaNaTela(0)).getByText('Mapeada')).toBeTruthy();
  });
});

describe('MapaFreteManager — (e) a stored target is always named', () => {
  it('an INACTIVE stored target keeps its name, marked inactive, and is not offered to others', async () => {
    const inativa = alvo('ret-1', 'Balcão', 'retiradaNaLoja', false);
    h.alvos = [MOTO, inativa];
    h.armazenados = new Map([[inativa.id, inativa]]);
    renderManager([
      linha(1, { integracaoUid: 'ret-1', targetTipoIntegracao: 'retiradaNaLoja' }),
      linha(2),
    ]);
    expect(destino(0)?.value).toBe('Balcão (Retirar na Loja) (inativa)');
    fireEvent.click(destino(1)!);
    expect(await screen.findByRole('option', { name: 'Moto Centro (Motoboy)' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Balcão/ })).toBeNull();
  });

  it('a DELETED stored target falls back to its stored label', () => {
    h.armazenados = new Map([['sumiu', null]]);
    renderManager([
      linha(1, {
        integracaoUid: 'sumiu',
        targetTipoIntegracao: 'motoboy',
        nomeTarget: 'Moto antiga',
      }),
    ]);
    expect(destino(0)?.value).toBe('Moto antiga (excluída)');
  });

  it('a stored target of an UNSUPPORTED tipo is named as such, never dropped', () => {
    const marketplace = alvo('ml-1', 'Envios ML', 'mercadoLivre');
    h.armazenados = new Map([[marketplace.id, marketplace]]);
    renderManager([linha(1, { integracaoUid: 'ml-1', targetTipoIntegracao: 'mercadoLivre' })]);
    expect(destino(0)?.value).toMatch(/^Envios ML \(.+\) — não suportado$/);
  });
});

describe('MapaFreteManager — edits', () => {
  it('mapping a row changes THAT row only, through aplicarAlvoLi', async () => {
    const outra = linha(2, { chaveLegada: 1 });
    const mudancas = renderManager([linha(1), outra]);
    await escolherDestino(0, 'Moto Centro (Motoboy)');
    expect(mudancas).toEqual([
      [
        {
          ...linha(1),
          integracaoUid: 'moto-1',
          targetTipoIntegracao: 'motoboy',
          targetData: null,
          nomeTarget: null,
        },
        outra,
      ],
    ]);
    expect(within(linhaNaTela(0)).getByText('Mapeada')).toBeTruthy();
  });

  it('"Nenhum" clears a mapped row', async () => {
    const mudancas = renderManager([
      linha(1, { integracaoUid: 'moto-1', targetTipoIntegracao: 'motoboy' }),
    ]);
    await escolherDestino(0, 'Nenhum');
    expect(mudancas).toEqual([[linha(1)]]);
  });

  it('a Melhor Envio account is only STAGED until its service is picked', async () => {
    const mudancas = renderManager([linha(1)]);
    await escolherDestino(0, 'Conta ME (Melhor Envios)');
    expect(mudancas).toEqual([]);
    expect(screen.getByText(/Escolha o serviço do Melhor Envio para concluir/)).toBeTruthy();
    expect(screen.getByText('servico:me-conta:nenhum:')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'escolher SEDEX' }));
    expect(mudancas).toEqual([
      [
        {
          ...linha(1),
          integracaoUid: 'me-conta',
          targetTipoIntegracao: 'melhorEnvios',
          targetData: { id: 2, name: 'SEDEX', company: { id: 1, name: 'Correios' } },
          nomeTarget: 'Correios — SEDEX',
        },
      ],
    ]);
    expect(screen.queryByText(/Escolha o serviço do Melhor Envio para concluir/)).toBeNull();
  });

  it('a row mapped to Melhor Envio shows its stored service', () => {
    renderManager([
      linha(1, {
        integracaoUid: 'me-conta',
        targetTipoIntegracao: 'melhorEnvios',
        targetData: { id: 7, name: 'Expresso' },
        nomeTarget: 'Transportadora — Expresso',
      }),
    ]);
    expect(screen.getByText('servico:me-conta:7:Transportadora — Expresso')).toBeTruthy();
  });

  it("EQUAL pair: a stored service `'7'` shows the SAME service as `7` (the shared service reader)", () => {
    renderManager([
      linha(1, {
        integracaoUid: 'me-conta',
        targetTipoIntegracao: 'melhorEnvios',
        targetData: { id: '7', name: 'Expresso' },
        nomeTarget: 'Transportadora — Expresso',
      }),
    ]);
    expect(screen.getByText('servico:me-conta:7:Transportadora — Expresso')).toBeTruthy();
  });

  it("⚠️ NEAR-MISS: a stored service `'07'` or `0` shows NO service — the importer would not route by it either", () => {
    renderManager([
      linha(1, {
        integracaoUid: 'me-conta',
        targetTipoIntegracao: 'melhorEnvios',
        targetData: { id: '07' },
        nomeTarget: 'Transportadora — Expresso',
      }),
      linha(2, {
        integracaoUid: 'me-conta',
        targetTipoIntegracao: 'melhorEnvios',
        targetData: { id: 0 },
        nomeTarget: 'Transportadora — Zero',
      }),
    ]);
    expect(screen.getByText('servico:me-conta:nenhum:Transportadora — Expresso')).toBeTruthy();
    expect(screen.getByText('servico:me-conta:nenhum:Transportadora — Zero')).toBeTruthy();
  });

  it('a row with no identifier is read-only', () => {
    renderManager([linha(1, { idOriginal: null })]);
    expect(destino(0)?.disabled).toBe(true);
    expect(within(linhaNaTela(0)).getByText('Sem identificador')).toBeTruthy();
  });

  it('a non-object row is shown and kept, never edited', () => {
    renderManager(['lixo', linha(2)]);
    expect(within(linhaNaTela(0)).getByText(/formato inesperado/)).toBeTruthy();
    expect(destino(1)?.disabled).toBe(false);
  });
});

describe('MapaFreteManager — states', () => {
  it('(g) read-only without PERM.frete.write, and says why', () => {
    h.permissoes = 0n;
    renderManager([linha(1)]);
    expect(destino(0)?.disabled).toBe(true);
    expect(screen.getByText(/exige permissão de escrita nas integrações de frete/)).toBeTruthy();
  });

  it('(g) read-only when the page is (no conta write permission)', () => {
    renderManager([linha(1)], { disabled: true });
    expect(destino(0)?.disabled).toBe(true);
  });

  it('(c) nothing is editable before the server-truth seed', () => {
    h.pronto = false;
    renderManager([linha(1)]);
    expect(screen.queryByTestId('mapa-frete-linha-0')).toBeNull();
    expect(screen.getByText('Carregando o frete da conta do servidor…')).toBeTruthy();
  });

  it('a conta with no freight doc explains it, and offers nothing to edit', () => {
    renderManager(null, { frete: { estado: 'ausente' } });
    expect(screen.getByText('Esta conta ainda não tem frete')).toBeTruthy();
    expect(screen.getByText(/Esta tela não o cria/)).toBeTruthy();
    expect(screen.queryByTestId('mapa-frete-linha-0')).toBeNull();
  });

  it('a doc that no longer belongs to the conta is read-only, and says why', () => {
    // The listener stopped naming the loaded doc (its back-ref or tipo moved):
    // a save would write a doc the conta no longer routes by.
    renderManager([linha(1)], { frete: { ...ENCONTRADO, naConsulta: false } });
    expect(destino(0)?.disabled).toBe(true);
    expect(screen.getByText('O frete desta conta mudou')).toBeTruthy();
  });

  it('NEAR-MISS: the same doc still in the conta’s query is editable', () => {
    renderManager([linha(1)], { frete: { ...ENCONTRADO, naConsulta: true } });
    expect(destino(0)?.disabled).toBe(false);
    expect(screen.queryByText('O frete desta conta mudou')).toBeNull();
  });

  it('an inactive doc and a conta with several docs are both flagged', () => {
    renderManager([linha(1)], { frete: { ...ENCONTRADO, ativo: false, total: 2 } });
    expect(screen.getByText('Frete inativo')).toBeTruthy();
    expect(screen.getByText('Mais de um documento de frete')).toBeTruthy();
  });

  it('a mapa that is not a list is kept as it is and not editable', () => {
    renderManager({ a: linha(1) });
    expect(screen.getByText('Mapeamento em formato inesperado')).toBeTruthy();
    expect(screen.queryByTestId('mapa-frete-linha-0')).toBeNull();
  });

  it('an empty mapa says how rows appear', () => {
    renderManager(null);
    expect(screen.getByText(/Cada forma de envio aparece aqui/)).toBeTruthy();
  });

  it('without PERM.frete.read the tab says so', () => {
    renderManager(null, { frete: { estado: 'sem-permissao' } });
    expect(screen.getByText('Sem permissão')).toBeTruthy();
  });
});
