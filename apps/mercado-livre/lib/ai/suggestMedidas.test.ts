import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { MedidaColumnSpec, MedidaRowSpec } from '@delfrance/integrations-mercado-livre';

import type { AiInlineImage } from '@delfrance/ai';
import type { GenerateArgs } from '@delfrance/ai/admin';

const h = vi.hoisted(() => ({
  tabela: null as Record<string, unknown> | null,
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  tabelaDeMedidasCollection: {
    docRef: () => ({ get: async () => ({ exists: h.tabela != null, data: () => h.tabela }) }),
    docPath: (_ctx: unknown, id: string) => `tabMedi/${id}`,
    parseRead: (data: unknown) => data,
  },
}));

const { TabelaDeMedidasNotFoundError, suggestMedidas } = await import('./suggestMedidas');

const ROWS: MedidaRowSpec[] = [{ key: 'g/1/v/p', size: 'P' }];
const COLUMNS: MedidaColumnSpec[] = [
  {
    attributeId: 'CHEST',
    label: 'Tórax',
    kind: 'number',
    values: [],
    unitId: 'cm',
    required: true,
  },
];

/**
 * Split in two so the spread does NOT widen `generate` back to a plain
 * `GenerateFn` — the tests below read `.mock.calls` off it.
 */
function baseDeps() {
  return {
    db: {} as Firestore,
    generate: vi.fn(async (_args: GenerateArgs): Promise<unknown> => ({ P: { CHEST: '52' } })),
    loadImages: vi.fn(async (): Promise<AiInlineImage[]> => []),
    model: 'gemini-3.5-flash-lite',
  };
}
type Deps = ReturnType<typeof baseDeps>;

function deps(over: Partial<Deps> = {}) {
  return { ...baseDeps(), ...over };
}

const args = { tabMediId: 'tm1', rows: ROWS, columns: COLUMNS };

beforeEach(() => {
  h.tabela = { nome: 'Camiseta', codigo: null, descricao: null, fotos: null };
});

describe('suggestMedidas — sequencing', () => {
  it('throws for a tabela that does not exist', async () => {
    h.tabela = null;
    await expect(suggestMedidas(deps(), args)).rejects.toBeInstanceOf(TabelaDeMedidasNotFoundError);
  });

  it('never calls the model for an empty grid', async () => {
    const d = deps();
    const out = await suggestMedidas(d, { ...args, rows: [] });
    expect(d.generate).not.toHaveBeenCalled();
    expect(out.celulas).toBe(0);
  });

  it('runs without photos rather than failing', async () => {
    // A tabela with no readable photo still gets a text-only suggestion — the
    // UI is what says so, and `contexto` is how it knows.
    const out = await suggestMedidas(deps(), args);
    expect(out.contexto.fotos).toBe(0);
    expect(out.sugestoes).toHaveLength(1);
  });

  it('never trusts the model answer — it goes through the applier', async () => {
    const d = deps({ generate: vi.fn(async () => ({ GG: { WAIST: '99' } })) });
    // `GG` is not a row of this grid and `WAIST` is not a column of it.
    expect((await suggestMedidas(d, args)).sugestoes).toEqual([]);
  });
});

describe("suggestMedidas — the caller's facts win over the stored document", () => {
  // ⚠️ The bug this pins. The editor sits inside an ObjectView form, so a
  // descrição typed but not saved is NOT on the document — reading only the
  // stored copy handed the model an empty record and produced "nenhuma medida
  // foi lida" over a screen that visibly had text in it.
  it('uses a descrição the caller supplies, over the stored one', async () => {
    h.tabela = { nome: 'Camiseta', descricao: 'antiga' };
    const d = deps();
    await suggestMedidas(d, { ...args, facts: { descricao: 'recém digitada' } });
    expect(d.generate.mock.calls[0]![0].request.text).toContain('recém digitada');
    expect(d.generate.mock.calls[0]![0].request.text).not.toContain('antiga');
  });

  it('falls back to the stored value per FIELD, not all-or-nothing', async () => {
    // A caller that supplies only a photo must not lose the stored descrição.
    h.tabela = { nome: 'Camiseta', codigo: 'FORN-42', descricao: 'guardada' };
    const d = deps();
    await suggestMedidas(d, { ...args, facts: { nome: 'Outro nome' } });
    const text = d.generate.mock.calls[0]![0].request.text;
    expect(text).toContain('Outro nome');
    expect(text).toContain('FORN-42');
    expect(text).toContain('guardada');
  });

  it("passes the caller's fotos to the loader", async () => {
    // The photo has the same staleness problem and it matters more: uploading
    // the table then clicking IA is the likeliest flow of all.
    const fotos = [{ arquivoOuterRef: 'arquivos/nova' }] as never;
    const d = deps();
    await suggestMedidas(d, { ...args, facts: { fotos } });
    expect(d.loadImages).toHaveBeenCalledWith(fotos);
  });

  it('reports every source that reached the model', async () => {
    h.tabela = { nome: 'C', codigo: 'X', descricao: 'D', fotos: [{ arquivoOuterRef: 'a/1' }] };
    const d = deps({ loadImages: vi.fn(async () => [{ base64: 'AQ', mimeType: 'image/jpeg' }]) });
    const out = await suggestMedidas(d, args);
    expect(out.contexto).toEqual({
      fotos: 1,
      anexadas: 1,
      descricao: true,
      codigo: true,
      referencia: false,
    });
  });

  it('separates "no photo" from "photo not readable yet"', async () => {
    // ⚠️ The two carry OPPOSITE instructions. A tabela whose photo has no
    // readable copy yet needs the operator to WAIT; one with no photo at all
    // needs them to upload. A single `comFoto` flag told both to upload — which
    // is the advice that made a working feature look broken.
    h.tabela = { nome: 'C', fotos: [{ arquivoOuterRef: 'a/1' }, { arquivoOuterRef: 'a/2' }] };
    const attached = await suggestMedidas(deps(), args);
    expect(attached.contexto).toMatchObject({ fotos: 0, anexadas: 2 });

    h.tabela = { nome: 'C', fotos: null };
    const none = await suggestMedidas(deps(), args);
    expect(none.contexto).toMatchObject({ fotos: 0, anexadas: 0 });
  });
});

describe('suggestMedidas — the reference chart', () => {
  const filled = {
    id: 'MLB-OUTRA',
    nome: 'Já preenchida',
    rows: [
      {
        attributes: [
          { id: 'SIZE', value_name: 'P' },
          { id: 'CHEST', value_name: '52 cm' },
        ],
      },
    ],
  };

  it('offers a chart already filled on ANOTHER conta', async () => {
    h.tabela = {
      nome: 'C',
      tabelasDeMedidasMercadoLivre: { conta1: { tabelas: [filled] } },
    };
    const d = deps();
    const out = await suggestMedidas(d, args);
    expect(out.contexto.referencia).toBe(true);
    expect(d.generate.mock.calls[0]![0].request.text).toContain('52 cm');
  });

  it('NEVER offers the chart being edited', async () => {
    // Circular: it would "confirm" whatever is already in the grid, blanks
    // included.
    h.tabela = {
      nome: 'C',
      tabelasDeMedidasMercadoLivre: { conta1: { tabelas: [filled] } },
    };
    const d = deps();
    const out = await suggestMedidas(d, { ...args, chartId: 'MLB-OUTRA' });
    expect(out.contexto.referencia).toBe(false);
  });

  it('tolerates a marketplace map in an unexpected shape', async () => {
    // Flutter authors this map and it is `z.record(z.unknown())` passthrough.
    h.tabela = {
      nome: 'C',
      tabelasDeMedidasMercadoLivre: { conta1: null, conta2: {}, conta3: { tabelas: 'nope' } },
    };
    await expect(suggestMedidas(deps(), args)).resolves.toMatchObject({
      contexto: { referencia: false },
    });
  });
});
