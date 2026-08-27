'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Firestore } from 'firebase/firestore';
import { Alert, Button, Checkbox, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { isValidMlbItemId, maskMlbItemId } from '@/lib/mercado-livre/itemId';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';

/**
 * "Importar do Mercado Livre" modal on the produtos LIST page — import CREATES
 * a produto, so it belongs here (not the editor tab). Pick an ML account + an
 * MLB id, choose the stock/price options (the ported `PreferenciasProdutoMercadoLivre`,
 * NOT persisted), import, and jump to the created/updated produto. All three
 * listing models import (simple, legacy `variations[]`, User-Products); a
 * listing the importer cannot take — closed, another seller's, untitled, or on
 * an integração with no `user_id` — comes back 422 (`ML_IMPORT_BLOCKED`), and
 * the `issues` list below renders the reason.
 */
const MAX_CONTAS = 50;

export function ImportarMercadoLivreModal({
  db,
  opened,
  onClose,
}: {
  db: Firestore;
  opened: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const client = useMercadoLivreClient();
  const { allowed: canImport } = usePermission(PERM.integracao.write);

  // Only subscribe while the modal is open AND the user can import — no realtime
  // listener/reads on every /produtos visit (useSnapshot(null) = no subscription).
  const contasQuery = useMemo(
    () =>
      opened && canImport
        ? buildQuery(integracaoCollection.ref(db, {}), [
            whereEqual('tipo', INTEGRACAO_TIPO.mercadoLivre),
            limit(MAX_CONTAS),
          ])
        : null,
    [db, opened, canImport],
  );
  const contasSnap = useSnapshot(contasQuery);
  const contaOptions = (contasSnap.data ?? []).map((c) => ({
    value: c.id,
    label: (c.data.nome as string | undefined) ?? c.id,
  }));

  const [integracaoId, setIntegracaoId] = useState<string | null>(null);
  const [itemId, setItemId] = useState('');
  const [importarEstoque, setImportarEstoque] = useState(true);
  const [sobrescreverEstoque, setSobrescreverEstoque] = useState(false);
  const [importarPreco, setImportarPreco] = useState(true);
  const [sobrescreverPreco, setSobrescreverPreco] = useState(true);
  const [sobrescreverDadosProduto, setSobrescreverDadosProduto] = useState(false);
  const [importarFotos, setImportarFotos] = useState(true);
  const [importarCategorias, setImportarCategorias] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[] | null>(null);

  // `itemId` is already masked on every keystroke, so it is either canonical or invalid.
  const itemIdValido = isValidMlbItemId(itemId);
  const canSubmit = canImport && !!integracaoId && itemIdValido && !busy;

  async function handleImport() {
    if (!client || !integracaoId || !itemIdValido) return;
    setBusy(true);
    setIssues(null);
    try {
      const result = await client.importar({
        integracaoId,
        itemId,
        options: {
          importarEstoque,
          sobrescreverEstoque,
          importarPreco,
          sobrescreverPreco,
          sobrescreverDadosProduto,
          importarFotos,
          importarCategorias,
        },
      });
      notifications.show({
        color: 'green',
        title: result.created ? 'Produto importado' : 'Produto atualizado',
        message: result.nome,
      });
      onClose();
      router.push(`/produtos/${result.produtoId}/editar`);
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        if (err.code === 'ML_IMPORT_BLOCKED' && err.issues) {
          setIssues(err.issues);
        } else if (err.status === 409) {
          setIssues(['A conta do Mercado Livre precisa ser reconectada.']);
        } else {
          setIssues([err.message]);
        }
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        setIssues(['Não foi possível falar com o Mercado Livre. Tente novamente.']);
        return;
      }
      throw err;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Importar do Mercado Livre" centered>
      <Stack>
        {!canImport && <Alert color="yellow">Você não tem permissão para importar produtos.</Alert>}
        <Select
          label="Conta"
          placeholder="Selecione a conta do Mercado Livre"
          data={contaOptions}
          value={integracaoId}
          onChange={setIntegracaoId}
          disabled={!canImport}
          searchable
        />
        <TextInput
          label="Código do anúncio (MLB)"
          placeholder="MLB1234567890"
          description="Aceita colar o link do anúncio ou o código com hífen (MLB-1234567890)."
          value={itemId}
          onChange={(e) => setItemId(maskMlbItemId(e.currentTarget.value))}
          error={
            itemId.length > 0 && !itemIdValido
              ? 'Informe um código no formato MLB1234567890.'
              : undefined
          }
          disabled={!canImport}
        />

        <Text size="sm" fw={500}>
          Opções
        </Text>
        <Checkbox
          label="Importar estoque"
          checked={importarEstoque}
          onChange={(e) => setImportarEstoque(e.currentTarget.checked)}
          disabled={!canImport}
        />
        <Checkbox
          label="Sobrescrever estoque existente"
          checked={sobrescreverEstoque}
          onChange={(e) => setSobrescreverEstoque(e.currentTarget.checked)}
          disabled={!canImport || !importarEstoque}
        />
        <Checkbox
          label="Importar preço"
          checked={importarPreco}
          onChange={(e) => setImportarPreco(e.currentTarget.checked)}
          disabled={!canImport}
        />
        <Checkbox
          label="Sobrescrever preço existente"
          checked={sobrescreverPreco}
          onChange={(e) => setSobrescreverPreco(e.currentTarget.checked)}
          disabled={!canImport || !importarPreco}
        />
        <Checkbox
          label="Sobrescrever dados do produto (marca, dimensões, SKU)"
          description="Por padrão a importação só preenche campos vazios. Marque para substituir também os valores já cadastrados. A descrição e a categoria nunca são substituídas."
          checked={sobrescreverDadosProduto}
          onChange={(e) => setSobrescreverDadosProduto(e.currentTarget.checked)}
          disabled={!canImport}
        />
        <Checkbox
          label="Importar fotos"
          checked={importarFotos}
          onChange={(e) => setImportarFotos(e.currentTarget.checked)}
          disabled={!canImport}
        />
        <Checkbox
          label="Importar categorias"
          checked={importarCategorias}
          onChange={(e) => setImportarCategorias(e.currentTarget.checked)}
          disabled={!canImport}
        />

        {issues && (
          <Alert color="red" title="Não foi possível importar">
            {issues.map((i, idx) => (
              <Text key={idx} size="sm">
                {i}
              </Text>
            ))}
          </Alert>
        )}

        <Button onClick={handleImport} loading={busy} disabled={!canSubmit}>
          Importar
        </Button>
      </Stack>
    </Modal>
  );
}
