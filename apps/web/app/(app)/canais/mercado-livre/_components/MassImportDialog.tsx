'use client';

/**
 * The "Importar todos os anúncios" options dialog — the same eight toggles the
 * conta panel carried, now naming the conta the run will cover (#816).
 *
 * The checkboxes are plain component state and persist across opens: they are
 * preferences, not a safety opt-in (contrast `baixarPreco` on the price-sync
 * dialog, which is re-armed on every open).
 */
import { useState } from 'react';
import { Button, Checkbox, List, Modal, Stack, Text } from '@mantine/core';

import type { MassImportActionState } from './useMassImportAction';

export function MassImportDialog({ state }: { state: MassImportActionState }) {
  const [importarEstoque, setImportarEstoque] = useState(true);
  const [sobrescreverEstoque, setSobrescreverEstoque] = useState(false);
  const [importarPreco, setImportarPreco] = useState(true);
  const [sobrescreverPreco, setSobrescreverPreco] = useState(true);
  const [importarFotos, setImportarFotos] = useState(true);
  const [importarCategorias, setImportarCategorias] = useState(true);
  const [atualizarProdutoPai, setAtualizarProdutoPai] = useState(true);
  const [sobrescreverDadosProduto, setSobrescreverDadosProduto] = useState(false);
  const [atualizarCadastrados, setAtualizarCadastrados] = useState(false);

  return (
    <Modal opened={state.opened} onClose={state.close} title="Importar todos os anúncios" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Varre todos os anúncios da conta selecionada e importa (ou atualiza) cada um. Pode levar
          alguns minutos — acompanhe o progresso no painel de ações da lista.
        </Text>
        <ContasSelecionadas contas={state.contas} />
        <Checkbox
          label="Importar estoque"
          checked={importarEstoque}
          onChange={(e) => setImportarEstoque(e.currentTarget.checked)}
        />
        <Checkbox
          label="Sobrescrever estoque existente"
          checked={sobrescreverEstoque}
          onChange={(e) => setSobrescreverEstoque(e.currentTarget.checked)}
          disabled={!importarEstoque}
        />
        <Checkbox
          label="Importar preço"
          checked={importarPreco}
          onChange={(e) => setImportarPreco(e.currentTarget.checked)}
        />
        <Checkbox
          label="Sobrescrever preço existente"
          checked={sobrescreverPreco}
          onChange={(e) => setSobrescreverPreco(e.currentTarget.checked)}
          disabled={!importarPreco}
        />
        <Checkbox
          label="Importar fotos"
          checked={importarFotos}
          onChange={(e) => setImportarFotos(e.currentTarget.checked)}
        />
        <Checkbox
          label="Importar categorias"
          checked={importarCategorias}
          onChange={(e) => setImportarCategorias(e.currentTarget.checked)}
        />
        <Checkbox
          label="Completar dados do produto pai"
          checked={atualizarProdutoPai}
          onChange={(e) => setAtualizarProdutoPai(e.currentTarget.checked)}
        />
        <Checkbox
          label="Sobrescrever dados do produto (marca, dimensões, SKU)"
          description="Por padrão a importação só preenche campos vazios. Marque para substituir também os valores já cadastrados. A descrição e a categoria nunca são substituídas."
          checked={sobrescreverDadosProduto}
          onChange={(e) => setSobrescreverDadosProduto(e.currentTarget.checked)}
          disabled={!atualizarProdutoPai}
        />
        <Checkbox
          label="Atualizar anúncios já cadastrados"
          checked={atualizarCadastrados}
          onChange={(e) => setAtualizarCadastrados(e.currentTarget.checked)}
        />
        <Button
          onClick={() => {
            void state.start({
              importarEstoque,
              sobrescreverEstoque,
              importarPreco,
              sobrescreverPreco,
              importarFotos,
              importarCategorias,
              atualizarProdutoPai,
              sobrescreverDadosProduto,
              atualizarCadastrados,
            });
          }}
          loading={state.busy}
        >
          Iniciar importação
        </Button>
      </Stack>
    </Modal>
  );
}

/**
 * Naming the account is what makes the run reviewable before it starts — the
 * operator sees exactly which conta a minutes-long job will touch, not just a
 * count. Both actions cap the selection at one, so this normally renders a
 * single name; it stays list-shaped because the ledger below it is.
 */
export function ContasSelecionadas({
  contas,
}: {
  contas: readonly { id: string; nome: string }[];
}) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {contas.length === 1 ? '1 conta selecionada' : `${contas.length} contas selecionadas`}
      </Text>
      <List size="sm" withPadding>
        {contas.map((conta) => (
          <List.Item key={conta.id}>{conta.nome}</List.Item>
        ))}
      </List>
    </Stack>
  );
}
