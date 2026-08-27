'use client';

import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Group,
  MultiSelect,
  Pill,
  Skeleton,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import { addDoc, deleteDoc, setDoc } from 'firebase/firestore';
import { ZodError } from 'zod';
import { normalizeNCM, type RegraImposto } from '@delfrance/schemas';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { nowMillis } from '@delfrance/core/datetime';
import { regraImpostoCollection } from '@/lib/data/regraImpostoCollection';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { ImpostoConfigEditor, type ImpostoConfigValue } from '@/components/imposto';

const CATEGORIA_LIMIT = 500;

export interface MacrosTabProps {
  /** Absent in create mode — there is no subcollection yet. */
  operacaoId?: string;
  disabled?: boolean;
}

/** Bare doc id from a `documents/<col>/<id>` ref (or a plain id). */
function bareId(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length === 0) return null;
  return ref.split('/').filter(Boolean).pop() ?? null;
}

export function MacrosTab({ operacaoId, disabled }: MacrosTabProps) {
  if (!operacaoId) {
    return (
      <Text c="dimmed" size="sm">
        Salve a operação para cadastrar regras de imposto (macros).
      </Text>
    );
  }
  return <MacrosManager operacaoId={operacaoId} disabled={disabled} />;
}

interface MacroForm {
  nome: string;
  produtos: string[];
  categorias: string[];
  ncms: string[];
  imposto: ImpostoConfigValue;
}

const EMPTY_FORM: MacroForm = { nome: '', produtos: [], categorias: [], ncms: [], imposto: {} };

/**
 * `NVE`/`indEscala` are `string[]`/`boolean` on {@link RegraImposto} (the
 * legacy wire shape, #468), but the shared `DadosGeraisSection` — reused
 * as-is by the produto/categoria/operação editors, which still store both as
 * plain strings — only knows how to edit a free-text value. Bridged HERE
 * rather than in the shared component so those other three editors are
 * untouched. Round-trips losslessly through an unedited save.
 *
 * `formatNveText` takes `unknown`, not `string[] | null`, on purpose: a doc
 * that fails `parseSoftRead` for an UNRELATED reason (a schema mismatch
 * anywhere else in it) comes back raw, and `NVE` could still be the legacy
 * scalar string `regraImpostoSchema`'s own read-tolerant preprocess would
 * otherwise have caught — this is the last line of defense against `.join`
 * throwing on the "Editar" click.
 */
export function formatNveText(nve: unknown): string | null {
  if (typeof nve === 'string') return nve.trim() || null;
  return Array.isArray(nve) && nve.length > 0 ? nve.join(', ') : null;
}

export function parseNveText(text: string | null | undefined): string[] | null {
  if (text == null) return null;
  const codes = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return codes.length > 0 ? codes : null;
}

// `indEscala`'s domain values elsewhere in this repo are 'S'/'N' — the NF-e
// XSD enum (`indEscala: z.enum(['S', 'N'])`) and the produto/categoria
// imposto tabs an operator edits through this SAME widget both use them, so
// that is the muscle memory this free-text field inherits. Recognized text
// maps explicitly both ways; anything else (typos, a stray word) is treated
// as NOT SET rather than guessed — silently flipping an operator's "N" to
// `true` is worse than asking them to retype it.
const IND_ESCALA_TRUE_WORDS = new Set(['s', 'sim', 'true', '1']);
const IND_ESCALA_FALSE_WORDS = new Set(['n', 'nao', 'não', 'false', '0']);

export function formatIndEscalaText(v: boolean | null): string | null {
  if (v === true) return 'S';
  if (v === false) return 'N';
  return null;
}

export function parseIndEscalaText(text: string | null | undefined): boolean | null {
  const trimmed = (text?.trim() ?? '').toLowerCase();
  if (trimmed === '') return null;
  if (IND_ESCALA_TRUE_WORDS.has(trimmed)) return true;
  if (IND_ESCALA_FALSE_WORDS.has(trimmed)) return false;
  return null;
}

function formFromRegra(r: RegraImposto): MacroForm {
  const {
    id: _id,
    nome,
    produtos,
    categorias,
    ncms,
    dataCadastro: _dc,
    NVE,
    indEscala,
    ...rest
  } = r;
  return {
    nome: nome ?? '',
    produtos: produtos ?? [],
    categorias: categorias ?? [],
    ncms: ncms ?? [],
    imposto: {
      ...rest,
      NVE: formatNveText(NVE),
      indEscala: formatIndEscalaText(indEscala),
    } as ImpostoConfigValue,
  };
}

function MacrosManager({ operacaoId, disabled }: { operacaoId: string; disabled?: boolean }) {
  const db = getFirebaseFirestore();

  const q = useMemo(
    () =>
      buildQuery(regraImpostoCollection.ref(db, { operacaoId }), [
        orderByField('dataCadastro', 'desc'),
      ]),
    [db, operacaoId],
  );
  const { data, loading, error } = useSnapshot<RegraImposto>(q);

  // All categorias for the matching MultiSelect (categorias are few).
  const categoriasSnap = useSnapshot(
    useMemo(
      () =>
        buildQuery(categoriaCollection.ref(db, {}), [orderByField('nome'), limit(CATEGORIA_LIMIT)]),
      [db],
    ),
  );
  const categoriaOptions = useMemo(
    () => (categoriasSnap.data ?? []).map((c) => ({ value: c.id, label: c.data.nome })),
    [categoriasSnap.data],
  );

  // null = closed; { id: null } = adding; { id } = editing. `dataCadastro` holds
  // the existing rule's creation stamp so an edit preserves it (it's the UI sort
  // key — re-stamping it would reorder the rule).
  const [editing, setEditing] = useState<{ id: string | null; dataCadastro: number | null } | null>(
    null,
  );
  const [form, setForm] = useState<MacroForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Reset key for the add-produto picker (it has no persistent value of its own).
  const [produtoPickerKey, setProdutoPickerKey] = useState(0);

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditing({ id: null, dataCadastro: null });
    setSaveError(null);
  }
  function openEdit(id: string, regra: RegraImposto) {
    setForm(formFromRegra(regra));
    setEditing({ id, dataCadastro: regra.dataCadastro ?? null });
    setSaveError(null);
  }

  async function handleSave() {
    if (!editing) return;
    // NCMs are stored digits-only, 8 digits (the schema is deliberately
    // lenient so legacy free-form docs still READ — the write-side guarantee
    // lives here). `6109.10.00` normalizes to `61091000`; anything else is a
    // field error before any write happens.
    const ncms: string[] = [];
    for (const raw of form.ncms) {
      const normalized = normalizeNCM(raw);
      if (normalized == null || !/^\d{8}$/.test(normalized)) {
        setSaveError(`NCM inválido: "${raw}" — informe 8 dígitos (ex.: 61091000).`);
        return;
      }
      if (!ncms.includes(normalized)) ncms.push(normalized);
    }
    setSaving(true);
    setSaveError(null);
    // The regra doc = matching criteria + the imposto blob (origem/CFOP/configs).
    // NVE/indEscala come back out of the shared editor's free-text shape into
    // regraImpostoSchema's real wire types — see formFromRegra.
    const { NVE: nveText, indEscala: indEscalaText, ...restImposto } = form.imposto;
    const docData = {
      nome: form.nome.trim() || null,
      produtos: form.produtos,
      categorias: form.categorias,
      ncms,
      ...restImposto,
      NVE: parseNveText(nveText as string | null | undefined),
      indEscala: parseIndEscalaText(indEscalaText as string | null | undefined),
      // Preserve the creation stamp on edit; only mint a new one on create.
      dataCadastro: editing.id ? (editing.dataCadastro ?? nowMillis()) : nowMillis(),
    };
    try {
      if (editing.id) {
        await setDoc(
          regraImpostoCollection.docRef(db, { operacaoId }, editing.id),
          docData as never,
        );
      } else {
        await addDoc(regraImpostoCollection.ref(db, { operacaoId }), docData as never);
      }
      setEditing(null);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSaveError(err.message);
        return;
      }
      if (err instanceof ZodError) {
        setSaveError(`Dados inválidos: ${err.issues.map((i) => i.message).join('; ')}`);
        return;
      }
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    await deleteDoc(regraImpostoCollection.docRef(db, { operacaoId }, deleteTarget));
    setDeleteTarget(null);
  }

  function addProduto(ref: unknown) {
    const id = bareId(ref);
    setProdutoPickerKey((k) => k + 1);
    if (id && !form.produtos.includes(id)) {
      setForm((f) => ({ ...f, produtos: [...f.produtos, id] }));
    }
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={3}>Regras de imposto (macros)</Title>
        {!editing && (
          <Button size="xs" onClick={openAdd} disabled={disabled}>
            + Adicionar regra
          </Button>
        )}
      </Group>
      <Text c="dimmed" size="sm">
        Cada regra define a tributação de itens que casam por produto, categoria ou NCM (qualquer
        um). A primeira regra que casa vence.
      </Text>

      {editing && (
        <Card withBorder>
          <Stack gap="sm">
            <Text fw={500}>{editing.id ? 'Editar regra' : 'Nova regra'}</Text>
            <TextInput
              label="Nome da regra"
              value={form.nome}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setForm((f) => ({ ...f, nome: value }));
              }}
              disabled={disabled}
            />

            <Divider label="Critérios de correspondência" labelPosition="left" />
            <MultiSelect
              label="Categorias"
              data={categoriaOptions}
              value={form.categorias}
              onChange={(v) => setForm((f) => ({ ...f, categorias: v }))}
              searchable
              clearable
              disabled={disabled}
              comboboxProps={{ withinPortal: true }}
            />
            <TagsInput
              label="NCMs"
              description="8 dígitos cada. Enter para adicionar."
              value={form.ncms}
              onChange={(v) => setForm((f) => ({ ...f, ncms: v }))}
              disabled={disabled}
            />
            <Stack gap="xs">
              <CollectionSelect
                key={produtoPickerKey}
                collection={produtoCollection}
                labelField="nome"
                searchFields={['nome', 'sku']}
                fieldName="macro-add-produto"
                value={null}
                onChange={addProduto}
                label="Adicionar produto"
                hint="Selecione um produto para incluir na regra."
                disabled={disabled}
              />
              {form.produtos.length > 0 && (
                <Pill.Group>
                  {form.produtos.map((id) => (
                    <Pill
                      key={id}
                      withRemoveButton={!disabled}
                      onRemove={() =>
                        setForm((f) => ({ ...f, produtos: f.produtos.filter((p) => p !== id) }))
                      }
                    >
                      {id}
                    </Pill>
                  ))}
                </Pill.Group>
              )}
            </Stack>

            <Divider label="Tributação" labelPosition="left" />
            <ImpostoConfigEditor
              value={form.imposto}
              onChange={(next) => setForm((f) => ({ ...f, imposto: next }))}
              disabled={disabled}
            />

            {saveError && <Alert color="red">{saveError}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEditing(null)} disabled={saving}>
                Cancelar
              </Button>
              <Button onClick={handleSave} loading={saving} disabled={disabled}>
                Salvar regra
              </Button>
            </Group>
          </Stack>
        </Card>
      )}

      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={64} />}
      {!loading && data && data.length === 0 && (
        <Text c="dimmed" size="sm">
          Nenhuma regra cadastrada nesta operação.
        </Text>
      )}
      {!loading &&
        data?.map(({ id, data: regra }) => (
          <Card key={id} withBorder>
            <Group justify="space-between" align="flex-start">
              <Stack gap={2}>
                <Text fw={500}>{regra.nome ?? '(sem nome)'}</Text>
                <Text size="xs" c="dimmed">
                  {regra.produtos.length} produto(s) · {regra.categorias.length} categoria(s) ·{' '}
                  {regra.ncms.length} NCM(s)
                </Text>
              </Stack>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => openEdit(id, regra)}
                  disabled={disabled}
                >
                  Editar
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  onClick={() => setDeleteTarget(id)}
                  disabled={disabled}
                >
                  Excluir
                </Button>
              </Group>
            </Group>
          </Card>
        ))}

      {deleteTarget && (
        <Alert color="red" title="Excluir regra">
          <Group justify="space-between">
            <Text size="sm">Tem certeza que deseja excluir esta regra?</Text>
            <Group>
              <Button variant="default" size="xs" onClick={() => setDeleteTarget(null)}>
                Cancelar
              </Button>
              <Button color="red" size="xs" onClick={handleDelete}>
                Excluir
              </Button>
            </Group>
          </Group>
        </Alert>
      )}
    </Stack>
  );
}
