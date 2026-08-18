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
  /** What the transaction re-read sees; null = same as `stored`. */
  remote: null as ConfigIa | null,
  /** Every `configIa` document id the panel reached for, in order. */
  docIds: [] as string[],
  /** Every agent id passed to `GET /ia/modelos`, in order. */
  agentesPedidos: [] as Array<string | null>,
  notify: vi.fn(),
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
    // `remote` is what the transaction re-read sees — swap it to simulate
    // someone else having saved while this form was open.
    fn({
      get: async () => {
        const seen = h.remote ?? h.stored;
        return { exists: () => seen != null, data: () => seen };
      },
      set: (_ref, value) => {
        h.writes.push(value);
      },
    }),
}));

vi.mock('@mantine/notifications', () => ({
  notifications: { show: h.notify },
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));

vi.mock('@/lib/data/configIaCollection', () => ({
  CONFIG_IA_ML_ATRIBUTOS_DOC_ID: 'ml-atributos',
  configIaCollection: {
    // Records which document the panel actually reached for: this component is
    // rendered twice on one page, one instance per agent, so a hardcoded id
    // would silently make both edit the same settings.
    docRef: (_db: unknown, _ctx: unknown, id: string) => {
      h.docIds.push(id);
      return { id };
    },
  },
}));

vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: h.canWrite }) }));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return {
    ...actual,
    useMercadoLivreClient: () => ({
      iaModelos: async (agenteId?: string) => {
        h.agentesPedidos.push(agenteId ?? null);
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
    promptPadrao: 'Você preenche atributos. OMITA a chave de qualquer atributo que não determinar.',
    efetivo: {
      modelo: 'gemini-3.5-flash-lite',
      substituido: false,
      origem: 'padrao',
      padrao: 'gemini-3.5-flash-lite',
    },
    ...over,
  };
}

function renderPanel(agenteId = 'ml-atributos') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
  render(
    <ConfigIaPanel agenteId={agenteId} titulo="Agente de teste" descricao="Descrição de teste." />,
    { wrapper },
  );
}

beforeEach(() => {
  h.stored = null;
  h.writes = [];
  h.modelos = liveModelos();
  h.canWrite = true;
  h.remote = null;
  h.docIds = [];
  h.agentesPedidos = [];
  h.notify.mockClear();
});

describe('ConfigIaPanel — one panel per agent', () => {
  // The page renders this component twice, once per `configIa/{agenteId}`
  // document. A hardcoded id here would make both instances read and write the
  // same settings, and the second agent's kill switch would silently be the
  // first one's — with both panels still looking correct.
  it('reads the document it was handed, not a hardcoded one', async () => {
    renderPanel('ml-medidas');
    await waitFor(() => screen.getByRole('switch', { name: /sugestão por ia ativa/i }));
    expect(h.docIds).toContain('ml-medidas');
    expect(h.docIds).not.toContain('ml-atributos');
  });

  it('writes back to that same document', async () => {
    renderPanel('ml-medidas');
    await waitFor(() => screen.getByRole('switch', { name: /sugestão por ia ativa/i }));

    fireEvent.click(screen.getByRole('switch', { name: /sugestão por ia ativa/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
    expect(h.docIds).not.toContain('ml-atributos');
  });

  it('asks the backend for THAT agent, so it reports the right default instruction', async () => {
    // `promptPadrao` and `efetivo` are per-agent. Fetching without the id would
    // show the attribute agent's instruction under the size-chart heading —
    // wrong in the one place the operator goes to read what actually runs.
    renderPanel('ml-medidas');
    await waitFor(() => {
      expect(h.agentesPedidos).toContain('ml-medidas');
    });
  });

  it('renders the heading and blurb it was given', async () => {
    renderPanel('ml-medidas');
    await waitFor(() => {
      expect(screen.getByText('Agente de teste')).toBeDefined();
    });
    expect(screen.getByText('Descrição de teste.')).toBeDefined();
  });
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

describe('the shipped system instruction is visible', () => {
  it('can be revealed in full, so it can be judged before being changed', async () => {
    // The default carries the anti-hallucination rule — the single most
    // consequential sentence in the AI surface. An instruction nobody can read
    // is one nobody can decide to change.
    renderPanel();
    await waitFor(() => screen.getByRole('button', { name: /Ver instrução padrão/i }));

    fireEvent.click(screen.getByRole('button', { name: /Ver instrução padrão/i }));
    await waitFor(() => {
      expect(screen.getByText(/OMITA a chave/)).toBeDefined();
    });
  });

  it('marks the default as in use while the field is empty', async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('em uso')).toBeDefined();
    });
  });

  it('does NOT pre-fill the textarea with it', async () => {
    // ⚠️ Pre-filling would make the first save store a COPY, and the copy would
    // be frozen — a later improvement to the shipped wording would silently
    // never reach this tenant. `null` means "use whatever ships today".
    renderPanel();
    await waitFor(() => screen.getByRole('button', { name: /Ver instrução padrão/i }));
    expect(screen.getByLabelText('Instrução do sistema')).toHaveProperty('value', '');
  });

  it('copies it into the field on request, as an explicit choice', async () => {
    renderPanel();
    await waitFor(() => screen.getByRole('button', { name: /copiar para o campo/i }));

    fireEvent.click(screen.getByRole('button', { name: /copiar para o campo/i }));
    await waitFor(() => {
      expect(screen.getByLabelText('Instrução do sistema')).toHaveProperty(
        'value',
        'Você preenche atributos. OMITA a chave de qualquer atributo que não determinar.',
      );
    });
  });

  it('stops offering the copy once the field holds something', async () => {
    // Copying over an operator's own wording would discard it.
    h.stored = { ...defaults(), promptSistema: 'Minha instrução' };
    renderPanel();
    await waitFor(() => screen.getByRole('button', { name: /Ver instrução padrão/i }));
    expect(screen.queryByRole('button', { name: /copiar para o campo/i })).toBeNull();
    expect(screen.queryByText('em uso')).toBeNull();
  });
});

describe('two operators editing the same singleton', () => {
  it('refuses to overwrite a change made while the form was open', async () => {
    // ⚠️ Rule 7 tier 3. The browser SDK has no `lastUpdateTime` precondition, so
    // without this the loser of the race silently wins: A opens the page, B
    // saves a new model, A saves a stale form and B's change is gone with no
    // signal on either side.
    h.stored = { ...defaults(), ultimaModificacao: 1_000 };
    h.remote = { ...defaults(), modelo: 'gemini-3.6-flash', ultimaModificacao: 2_000 };
    renderPanel();
    await waitFor(() => screen.getByRole('switch', { name: /sugestão por ia ativa/i }));

    fireEvent.click(screen.getByRole('switch', { name: /sugestão por ia ativa/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/Outra pessoa alterou/i) }),
      );
    });
    expect(h.writes).toHaveLength(0);
  });

  it('saves normally when nobody else touched it', async () => {
    h.stored = { ...defaults(), ultimaModificacao: 1_000 };
    h.remote = { ...defaults(), ultimaModificacao: 1_000 };
    renderPanel();
    await waitFor(() => screen.getByRole('switch', { name: /sugestão por ia ativa/i }));

    fireEvent.click(screen.getByRole('switch', { name: /sugestão por ia ativa/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
  });

  it('creates the doc without a conflict when none exists yet', async () => {
    // A fresh tenant has no document; there is nothing to have lost a race to.
    h.stored = null;
    h.remote = null;
    renderPanel();
    await waitFor(() => screen.getByRole('switch', { name: /sugestão por ia ativa/i }));

    fireEvent.click(screen.getByRole('switch', { name: /sugestão por ia ativa/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(h.writes).toHaveLength(1);
    });
  });
});
