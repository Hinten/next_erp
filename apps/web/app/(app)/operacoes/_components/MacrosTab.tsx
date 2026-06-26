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
import { type RegraImposto } from '@delfrance/schemas';
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

function formFromRegra(r: RegraImposto): MacroForm {
  const { id: _id, nome, produtos, categorias, ncms, dataCadastro: _dc, ...imposto } = r;
  return {
    nome: nome ?? '',
    produtos: produtos ?? [],
    categorias: categorias ?? [],
    ncms: ncms ?? [],
    imposto: imposto as ImpostoConfigValue,
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
      () => buildQuery(categoriaCollection.ref(db, {}), [orderByField('nome'), limit(CATEGORIA_LIMIT)]),
      [db],
    ),
  );
  const categoriaOptions = useMemo(
    () => (categoriasSnap.data ?? []).map((c) => ({ value: c.id, label: c.data.nome })),
    [categoriasSnap.data],
  );

  // null = closed; { id: null } = adding; { id } = editing.
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [form, setForm] = useState<MacroForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Reset key for the add-produto picker (it has no persistent value of its own).
  const [produtoPickerKey, setProdutoPickerKey] = useState(0);

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditing({ id: null });
    setSaveError(null);
  }
  function openEdit(id: string, regra: RegraImposto) {
    setForm(formFromRegra(regra));
    setEditing({ id });
    setSaveError(null);
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    // The regra doc = matching criteria + the imposto blob (origem/CFOP/configs).
    const docData = {
      nome: form.nome.trim() || null,
      produtos: form.produtos,
      categorias: form.categorias,
      ncms: form.ncms.map((n) => n.trim()),
      ...form.imposto,
      dataCadastro: nowMillis(),
    };
    try {
      if (editing.id) {
        await setDoc(regraImpostoCollection.docRef(db, { operacaoId }, editing.id), docData as never);
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
                <Button size="xs" variant="light" onClick={() => openEdit(id, regra)} disabled={disabled}>
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
