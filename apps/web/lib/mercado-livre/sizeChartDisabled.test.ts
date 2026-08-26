import { describe, expect, it } from 'vitest';

import {
  SIZE_CHART_MOTIVOS,
  type SizeChartAction,
  type SizeChartBusy,
  type SizeChartEditorAction,
  type SizeChartEditorGateInput,
  type SizeChartGateInput,
  sizeChartEditorGate,
  sizeChartGate,
} from './sizeChartDisabled';

const ACTIONS: SizeChartAction[] = ['verificar', 'editar', 'excluir', 'novaGuia'];
const BUSY: SizeChartBusy[] = ['none', 'estaGuia', 'outraGuia'];

function input(over: Partial<SizeChartGateInput> = {}): SizeChartGateInput {
  return {
    readOnly: false,
    hasClient: true,
    canWrite: true,
    busy: 'none',
    hasGrupos: true,
    enviada: true,
    ...over,
  };
}

/** Every legal input, once. 2⁴ booleans × the three-way busy = 48. */
function everyInput(): SizeChartGateInput[] {
  const out: SizeChartGateInput[] = [];
  for (const readOnly of [false, true]) {
    for (const hasClient of [false, true]) {
      for (const canWrite of [false, true]) {
        for (const hasGrupos of [false, true]) {
          for (const enviada of [false, true]) {
            for (const busy of BUSY) {
              out.push({ readOnly, hasClient, canWrite, busy, hasGrupos, enviada });
            }
          }
        }
      }
    }
  }
  return out;
}

describe('sizeChartGate', () => {
  it('leaves every control open when nothing blocks it', () => {
    for (const action of ACTIONS) {
      expect(sizeChartGate(action, input())).toEqual({ disabled: false, motivo: null });
    }
  });

  /**
   * ⚠️ The invariant the whole module exists for. A tooltip that drifts from the
   * `disabled` expression beside it starts explaining a state the button is not
   * in — so `disabled` is DERIVED from `motivo` and both come out of one call.
   * This sweeps the full legal input space for all four controls to keep it
   * that way if anyone ever hand-rolls a branch.
   */
  it('never disables without a motivo, and never carries a motivo while enabled', () => {
    for (const action of ACTIONS) {
      for (const over of everyInput()) {
        const { disabled, motivo } = sizeChartGate(action, over);
        expect(disabled).toBe(motivo !== null);
      }
    }
  });

  /**
   * ⚠️ The regression guard. Explaining the gates must not MOVE them: the
   * cadastros e2e clicks Excluir, and a control that quietly gained a cause
   * would fail there rather than here. Each expectation below is the expression
   * that stood in the component before this module existed.
   *
   * The one deliberate delta is `verificar`'s `enviada` — see the ⚠️ on
   * `naoEnviada`: that button was ENABLED and did nothing.
   */
  it('reproduces the disabling each control had before the tooltips', () => {
    for (const over of everyInput()) {
      const anyBusy = over.busy !== 'none';
      expect(sizeChartGate('verificar', over).disabled).toBe(
        over.readOnly || !over.hasClient || !over.canWrite || anyBusy || !over.enviada,
      );
      expect(sizeChartGate('editar', over).disabled).toBe(
        over.readOnly || !over.hasClient || anyBusy,
      );
      expect(sizeChartGate('excluir', over).disabled).toBe(
        over.readOnly || !over.hasClient || !over.canWrite || anyBusy,
      );
      expect(sizeChartGate('novaGuia', over).disabled).toBe(
        over.readOnly || !over.hasClient || !over.hasGrupos,
      );
    }
  });

  // ⚠️ The two causes that said NOTHING on screen. #1087 hit both and could not
  // tell one from the other, or from a broken client.
  it('explains the form being read-only, naming the bit that causes it', () => {
    const motivo = sizeChartGate('editar', input({ readOnly: true })).motivo;
    expect(motivo).toMatch(/somente leitura/i);
    // Not a generic "ação indisponível": `readOnly` on this page is
    // `!usePermission(PERM.produto.write)`, and saying so is the actionable half.
    expect(motivo).toMatch(/produtos/i);
  });

  it('explains a missing client as an unauthenticated session', () => {
    expect(sizeChartGate('editar', input({ hasClient: false })).motivo).toMatch(/autenticada/i);
  });

  /**
   * A logged-out operator arrives with every flag down at once: no Firebase user
   * means no claims, so `readOnly` is true and `canWrite` false as well. Ranking
   * either of those first would tell someone who just needs to sign in that they
   * lack a grant only an admin can give — a dead end. `publishDisabled.ts` ranks
   * `hasClient` first for exactly this.
   */
  it('⚠️ tells a logged-out operator to sign in, NOT that they lack permission', () => {
    const motivo = sizeChartGate(
      'excluir',
      input({ hasClient: false, readOnly: true, canWrite: false }),
    ).motivo;
    expect(motivo).toMatch(/autenticada/i);
    expect(motivo).not.toMatch(/permissão|somente leitura/i);
  });

  /**
   * ⚠️ Inverts `publishDisabled.ts`'s order on purpose. Both are admin grants,
   * so neither is more actionable — but `readOnly` disables all four controls
   * where `canWrite` disables two. Report the narrower gap first and the
   * operator fixes it only to find the broader one still there.
   */
  it('reports the read-only form before the narrower integrações gap', () => {
    expect(sizeChartGate('excluir', input({ readOnly: true, canWrite: false })).motivo).toMatch(
      /somente leitura/i,
    );
  });

  it('still reports the integrações gap once the form is editable', () => {
    expect(sizeChartGate('excluir', input({ canWrite: false })).motivo).toBe(
      SIZE_CHART_MOTIVOS.semEscrita,
    );
  });

  // Opening the editor is a read. The modal owns the write bit for its "Enviar".
  it('does not ask for the write bit to open the editor', () => {
    expect(sizeChartGate('editar', input({ canWrite: false })).disabled).toBe(false);
    expect(sizeChartGate('novaGuia', input({ canWrite: false })).disabled).toBe(false);
  });

  it('says WHICH guia holds the lock', () => {
    expect(sizeChartGate('excluir', input({ busy: 'estaGuia' })).motivo).toMatch(/nesta guia/i);
    expect(sizeChartGate('excluir', input({ busy: 'outraGuia' })).motivo).toMatch(/outra guia/i);
  });

  /**
   * ⚠️ Not a message — a behaviour this PR deliberately leaves alone. "Nova
   * guia" only opens the editor, and the editor rebuilds the conta's array from
   * the live snapshot when it saves, so the single-operation lock never covered
   * it. Pinned so nobody folds it in while "tidying" the gate.
   */
  it('leaves Nova guia open while another guia is busy', () => {
    expect(sizeChartGate('novaGuia', input({ busy: 'outraGuia' })).disabled).toBe(false);
  });

  it('keeps the variation-group guidance, which is also the standing card text', () => {
    expect(sizeChartGate('novaGuia', input({ hasGrupos: false })).motivo).toBe(
      SIZE_CHART_MOTIVOS.semGrupos,
    );
  });

  /**
   * ⚠️ The one gate that is NEW. `verifyDeletion` opens with
   * `if (!client || chart.id == null || chart.id === '') return;`, so a guia
   * flagged for deletion with no ML id rendered a button that was enabled and
   * did nothing — worse than a dead one, because it looks like it worked.
   */
  it('closes Verificar on a guia Mercado Livre never received', () => {
    expect(sizeChartGate('verificar', input({ enviada: false })).motivo).toMatch(
      /nunca foi enviada/i,
    );
  });
});

const EDITOR_ACTIONS: SizeChartEditorAction[] = [
  'preencherIa',
  'cancelar',
  'salvarRascunho',
  'enviar',
];

function editorInput(over: Partial<SizeChartEditorGateInput> = {}): SizeChartEditorGateInput {
  return {
    canWrite: true,
    busy: null,
    aiFillable: true,
    hasNome: true,
    hasDominio: true,
    blockingError: null,
    overCap: null,
    ...over,
  };
}

const BLOQUEIO = 'Responda os atributos da guia.';
const CAP = 'O Mercado Livre aceita no máximo 75 tamanhos por guia.';

function everyEditorInput(): SizeChartEditorGateInput[] {
  const out: SizeChartEditorGateInput[] = [];
  for (const canWrite of [false, true]) {
    for (const busy of [null, 'draft', 'send'] as const) {
      for (const aiFillable of [false, true]) {
        for (const hasNome of [false, true]) {
          for (const hasDominio of [false, true]) {
            for (const blockingError of [null, BLOQUEIO]) {
              for (const overCap of [null, CAP]) {
                out.push({
                  canWrite,
                  busy,
                  aiFillable,
                  hasNome,
                  hasDominio,
                  blockingError,
                  overCap,
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

describe('sizeChartEditorGate', () => {
  it('leaves every control open when nothing blocks it', () => {
    for (const action of EDITOR_ACTIONS) {
      expect(sizeChartEditorGate(action, editorInput())).toEqual({ disabled: false, motivo: null });
    }
  });

  it('never disables without a motivo, and never carries a motivo while enabled', () => {
    for (const action of EDITOR_ACTIONS) {
      for (const over of everyEditorInput()) {
        const { disabled, motivo } = sizeChartEditorGate(action, over);
        expect(disabled).toBe(motivo !== null);
      }
    }
  });

  it('reproduces the disabling each control had before the tooltips', () => {
    for (const over of everyEditorInput()) {
      const busy = over.busy !== null;
      expect(sizeChartEditorGate('preencherIa', over).disabled).toBe(
        !over.canWrite || busy || !over.aiFillable,
      );
      expect(sizeChartEditorGate('cancelar', over).disabled).toBe(busy);
      expect(sizeChartEditorGate('salvarRascunho', over).disabled).toBe(
        busy || !over.hasNome || !over.hasDominio,
      );
      expect(sizeChartEditorGate('enviar', over).disabled).toBe(
        busy || !over.canWrite || over.blockingError != null || over.overCap != null,
      );
    }
  });

  it('names which call is in flight', () => {
    expect(sizeChartEditorGate('cancelar', editorInput({ busy: 'draft' })).motivo).toMatch(
      /rascunho/i,
    );
    expect(sizeChartEditorGate('cancelar', editorInput({ busy: 'send' })).motivo).toMatch(
      /enviando/i,
    );
  });

  // A draft is a local Firestore write; only the two calls that reach Mercado
  // Livre need the integrações bit.
  it('asks for the write bit only where a call leaves the browser', () => {
    const noWrite = editorInput({ canWrite: false });
    expect(sizeChartEditorGate('preencherIa', noWrite).motivo).toBe(SIZE_CHART_MOTIVOS.semEscrita);
    expect(sizeChartEditorGate('enviar', noWrite).motivo).toBe(SIZE_CHART_MOTIVOS.semEscrita);
    expect(sizeChartEditorGate('cancelar', noWrite).disabled).toBe(false);
    expect(sizeChartEditorGate('salvarRascunho', noWrite).disabled).toBe(false);
  });

  it('says what the AI button is waiting for, before the round trip that would 422', () => {
    expect(sizeChartEditorGate('preencherIa', editorInput({ aiFillable: false })).motivo).toBe(
      SIZE_CHART_MOTIVOS.gradeVazia,
    );
  });

  it('says which half of the draft is missing', () => {
    expect(sizeChartEditorGate('salvarRascunho', editorInput({ hasNome: false })).motivo).toMatch(
      /nome/i,
    );
    expect(
      sizeChartEditorGate('salvarRascunho', editorInput({ hasDominio: false })).motivo,
    ).toMatch(/domínio/i);
  });

  /**
   * ⚠️ The status line beside these buttons reads `enviar.motivo`, and it used
   * to be built from `canWrite` and `blockingError` alone — so a send blocked by
   * the row cap, or by a save already running, left it reporting the guia was
   * ready to send.
   */
  it('reports the causes the status line used to drop', () => {
    expect(sizeChartEditorGate('enviar', editorInput({ overCap: CAP })).motivo).toBe(CAP);
    expect(sizeChartEditorGate('enviar', editorInput({ busy: 'draft' })).motivo).toMatch(
      /rascunho/i,
    );
  });

  it('passes an already-phrased blocker through verbatim', () => {
    expect(sizeChartEditorGate('enviar', editorInput({ blockingError: BLOQUEIO })).motivo).toBe(
      BLOQUEIO,
    );
  });
});
