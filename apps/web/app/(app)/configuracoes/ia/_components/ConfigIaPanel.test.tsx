import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PROVEDOR_IA, type ConfigIa } from '@delfrance/schemas';
import type { MercadoLivreIaModelos } from '@/lib/mercado-livre/client';

const h = vi.hoisted(() => ({
  /** What `getDoc` sees. `null` = the document does not exist yet. */
  stored: null as ConfigIa | null,
  /** Every document written, in order. */
  writes: [] as Array<Record<string, unknown>>,
  /** What `GET /ia/modelos` answers; `null` = the backend is unreachable. */
  modelos: null as MercadoLivreIaModelos | null,
  canWrite: true,
}));

vi.mock('firebase/firestore', () => ({
  getDoc: async () => ({
    exists: () => h.stored != null,
    data: () => h.stored,
  }),
  runTransaction: async (
    _db: unknown,
    fn: (tx: {
      get: (ref: unknown) => Promise<{ exists: () => boolean; data: () => ConfigIa | null }>;
      set: (ref: unknown, value: Record<string, unknown>) => void;
    }) => Promise<void>,
  ) =>
    fn({
      get: async () => ({ exists: () => h.stored != null, data: () => h.stored }),
      set: (_ref, value) => {
        h.writes.push(value);
      },
    }),
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));

vi.mock('@/lib/data/configIaCollection', () => ({
  CONFIG_IA_ML_ATRIBUTOS_DOC_ID: 'ml-atributos',
  configIaCollection: { docRef: () => ({}) },
}));

vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: h.canWrite }) }));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return {
    ...actual,
    useMercadoLivreClient: () => ({
      iaModelos: async () => {
        if (h.modelos == null) throw new Error('backend indisponível');
        return h.modelos;
      },
    }),
  };
});

const { ConfigIaPanel } = await import('./ConfigIaPanel');

function liveModelos(over: Partial<MercadoLivreIaModelos> = {}): MercadoLivreIaModelos {
  return {
    modelos: [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
    ],
    fonte: 'live',
    efetivo: {
      modelo: 'gemini-3.5-flash-lite',
      substituido: false,
      origem: 'padrao',
      padrao: 'gemini-3.5-flash-lite',
    },
    ...over,
  };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
  render(<ConfigIaPanel />, { wrapper });
}

beforeEach(() => {
  h.stored = null;
  h.writes = [];
  h.modelos = liveModelos();
  h.canWrite = true;
});

describe('ConfigIaPanel — the document may not exist yet', () => {
  it('renders the defaults and says the document has not been created', async () => {
    // This is the state of every tenant until someone saves once. ObjectView
    // cannot do this at all — its saveRecord takes a tx.update path that throws
    // on a missing doc, which is why this panel is hand-written.
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/ainda usando os padrões do sistema/i)).toBeDefined();
    });
  });

  it('creates the document on the first save', async () => {
    renderPanel();
    await waitFor(() => screen.getByRole('switch', { name: /sugestão por ia ativa/i }));

    fireEvent.click(screen.getByRole('switch', { name: /sugestão por ia ativa/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.writes[0]).toMatchObject({ ativo: false });
  });
});

describe('ConfigIaPanel — the model field', () => {
  it('stores an unset model as NULL, not as the default name', async () => {
    // ⚠️ Writing the default name here would break the resolution chain: a
    // stored value always wins, so MERCADO_LIVRE_AI_MODEL could never be
    // reached and the shipped default would be frozen for this tenant.
    h.stored = { ...defaults(), ativo: true };
    renderPanel();
    await waitFor(() => screen.getByRole('switch', { name: /sugestão por ia ativa/i }));

    fireEvent.click(screen.getByRole('switch', { name: /sugestão por ia ativa/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(h.writes).toHaveLength(1));
    expect(h.writes[0]!.modelo).toBeNull();
  });

  it('keeps a stored model visible even when the provider stopped serving it', async () => {
    // A Select that silently blanks the stored value hides both the setting and
    // the reason suggestions are misbehaving.
    //
    // ⚠️ Asserted on the DISPLAYED text, not on the value: a Mantine Select's
    // input shows the matching option's LABEL. That is what makes this the
    // stronger assertion anyway — it proves the operator can see *why* the
    // value is a problem, not merely that it survived.
    h.stored = { ...defaults(), modelo: 'gemini-2.0-retired' };
    renderPanel();
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Modelo' })).toHaveProperty(
        'value',
        'gemini-2.0-retired (indisponível no provedor)',
      );
    });
  });

  it('offers the model by ROLE — a Mantine Select labels two elements', async () => {
    // `getByLabelText('Modelo')` matches BOTH the combobox input and its
    // listbox, so it throws on multiple matches. Query by role.
    renderPanel();
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Modelo' })).toBeDefined();
    });
  });
});

describe('ConfigIaPanel — what is in use right now', () => {
  it('warns when a backend env var is overriding the default', async () => {
    // The operator has no other way to discover this; showing the stored value
    // alone would be a lie of omission.
    h.modelos = liveModelos({
      efetivo: {
        modelo: 'gemini-3.6-flash',
        substituido: false,
        origem: 'env',
        padrao: 'gemini-3.5-flash-lite',
      },
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/MERCADO_LIVRE_AI_MODEL/)).toBeDefined();
    });
  });

  it('warns when the stored model was substituted', async () => {
    h.modelos = liveModelos({
      efetivo: {
        modelo: 'gemini-3.5-flash-lite',
        substituido: true,
        origem: 'config',
        padrao: 'gemini-3.5-flash-lite',
      },
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/substituído automaticamente/i)).toBeDefined();
    });
  });

  it('says the catalogue is the shipped list when the provider could not be read', async () => {
    h.modelos = liveModelos({ fonte: 'fallback', erro: '403 permission denied' });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/não foi possível consultar o catálogo/i)).toBeDefined();
    });
  });

  it('still lets the settings be saved when the ML backend is unreachable', async () => {
    // The page exists to fix a broken setting, which is exactly when the backend
    // is most likely to be the broken thing.
    h.modelos = null;
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/não foi possível consultar o backend/i)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDefined();
  });
});

describe('ConfigIaPanel — permissions', () => {
  it('disables every control without integracao.write', async () => {
    h.canWrite = false;
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/somente leitura/i)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('switch', { name: /sugestão por ia ativa/i })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('keeps Salvar disabled until something is edited', async () => {
    h.stored = defaults();
    renderPanel();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Salvar' })).toHaveProperty('disabled', true);
    });
  });
});

function defaults(): ConfigIa {
  return {
    modelo: null,
    provedor: PROVEDOR_IA.vertex,
    promptSistema: null,
    maxOutputTokens: 8_192,
    temperatura: 0,
    ativo: true,
    ultimaModificacao: null,
  };
}
