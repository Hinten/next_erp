'use client';

/**
 * The "Importar todos os anúncios" options dialog for a Shopee conta (#1529, step
 * 21-5): Mercado Livre's nine toggles (labels verbatim), plus the two choices
 * only Shopee's `get_item_list` takes — which listing STATUSES to scan and an
 * optional `update_time` window.
 *
 * Every initial value comes from `OPCOES_IMPORTACAO_SHOPEE_PADRAO`, the one
 * object the backend's sanitizer and the job schema's defaults are built from,
 * so the dialog cannot open on a default the backend does not have. The choices
 * are preferences and persist across opens (no safety opt-in here, unlike the
 * price dialog's `baixarPreco`), and the body always carries all of them.
 *
 * A «Sobrescrever …» box counts only while the box it depends on is ticked:
 * greyed out, it is shown unticked and sent `false` — never omitted, because
 * the route's sanitizer fills an omitted key from the defaults, where
 * `sobrescreverPreco` is `true` (#2099). The labels are still Mercado Livre's,
 * but these SEMANTICS now differ from ML's dialog on purpose (#2099; ML's own
 * copy of the trap is #2123).
 */
import { useState } from 'react';
import { Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  OPCOES_IMPORTACAO_SHOPEE_PADRAO,
  SHOPEE_IMPORT_STATUS,
  type ShopeeImportStatus,
} from '@delfrance/schemas';

import { ContasSelecionadas } from '@/components/contaJobs/ContasSelecionadas';
import {
  DESCRICAO_IMPORTAR_FOTOS_SHOPEE,
  ROTULO_OPCAO_IMPORTACAO_SHOPEE,
  ROTULO_STATUS_IMPORTACAO_SHOPEE,
} from '@/lib/shopee/rotulosImportacaoShopee';
import { janelaUpdateTimeEmSegundos } from './cadenciaJobsShopee';
import type { ImportarTodosShopeeActionState } from './useImportarTodosShopeeAction';

/**
 * The four statuses a scan may ask for, in the order the body sends them.
 * Every label on this dialog is read from `@/lib/shopee/rotulosImportacaoShopee`,
 * which the refusal copy naming these boxes reads too (#2015, the #1369 rule).
 */
const STATUS_DO_ANUNCIO: readonly { valor: ShopeeImportStatus; rotulo: string }[] = [
  SHOPEE_IMPORT_STATUS.normal,
  SHOPEE_IMPORT_STATUS.unlist,
  SHOPEE_IMPORT_STATUS.banned,
  SHOPEE_IMPORT_STATUS.reviewing,
].map((valor) => ({ valor, rotulo: ROTULO_STATUS_IMPORTACAO_SHOPEE[valor] }));

const PADRAO = OPCOES_IMPORTACAO_SHOPEE_PADRAO;
const ROTULO = ROTULO_OPCAO_IMPORTACAO_SHOPEE;

export function ImportarTodosShopeeDialog({ state }: { state: ImportarTodosShopeeActionState }) {
  const [statuses, setStatuses] = useState<readonly ShopeeImportStatus[]>(PADRAO.statuses);
  const [importarEstoque, setImportarEstoque] = useState<boolean>(PADRAO.importarEstoque);
  const [sobrescreverEstoque, setSobrescreverEstoque] = useState<boolean>(
    PADRAO.sobrescreverEstoque,
  );
  const [importarPreco, setImportarPreco] = useState<boolean>(PADRAO.importarPreco);
  const [sobrescreverPreco, setSobrescreverPreco] = useState<boolean>(PADRAO.sobrescreverPreco);
  const [importarFotos, setImportarFotos] = useState<boolean>(PADRAO.importarFotos);
  const [importarCategorias, setImportarCategorias] = useState<boolean>(PADRAO.importarCategorias);
  const [atualizarProdutoPai, setAtualizarProdutoPai] = useState<boolean>(
    PADRAO.atualizarProdutoPai,
  );
  const [sobrescreverDadosProduto, setSobrescreverDadosProduto] = useState<boolean>(
    PADRAO.sobrescreverDadosProduto,
  );
  const [atualizarCadastrados, setAtualizarCadastrados] = useState<boolean>(
    PADRAO.atualizarCadastrados,
  );
  const [janela, setJanela] = useState<[string | null, string | null]>([null, null]);

  // A «Sobrescrever …» box counts only while the box it depends on is ticked:
  // greyed out, it is neither shown ticked nor sent — sent `false`, never
  // omitted (an omitted key takes the server default, `sobrescreverPreco:
  // true`) (#2099). The preference survives in state for a re-tick.
  const sobrescreverEstoqueEfetivo = importarEstoque && sobrescreverEstoque;
  const sobrescreverPrecoEfetivo = importarPreco && sobrescreverPreco;
  const sobrescreverDadosProdutoEfetivo = atualizarProdutoPai && sobrescreverDadosProduto;

  const semStatus = statuses.length === 0;
  // Both ends or neither: half a window is a mistake to point out, not a filter
  // to guess the other half of.
  const janelaPelaMetade = (janela[0] === null) !== (janela[1] === null);
  const janelaEmSegundos = janelaUpdateTimeEmSegundos(janela);

  return (
    <Modal opened={state.opened} onClose={state.close} title="Importar todos os anúncios" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Varre todos os anúncios da conta selecionada e importa (ou atualiza) cada um. Pode levar
          alguns minutos — acompanhe no painel ao lado da lista. Se a conta já tiver uma importação
          em andamento, o painel passa a acompanhá-la e nenhuma segunda é iniciada. Kits cujos
          componentes ainda não estavam importados falham na primeira passada — rode a importação de
          novo para trazê-los.
        </Text>
        <ContasSelecionadas contas={state.contas} />
        <Checkbox.Group
          label={ROTULO.statuses}
          value={[...statuses]}
          onChange={(valores) =>
            // Kept in the canonical order, whatever order they were clicked in.
            setStatuses(STATUS_DO_ANUNCIO.map((s) => s.valor).filter((v) => valores.includes(v)))
          }
          error={semStatus ? 'Escolha pelo menos um status.' : null}
        >
          <Group gap="md" mt={4}>
            {STATUS_DO_ANUNCIO.map((s) => (
              <Checkbox key={s.valor} value={s.valor} label={s.rotulo} />
            ))}
          </Group>
        </Checkbox.Group>
        <Checkbox
          label={ROTULO.importarEstoque}
          checked={importarEstoque}
          onChange={(e) => setImportarEstoque(e.currentTarget.checked)}
        />
        <Checkbox
          label={ROTULO.sobrescreverEstoque}
          checked={sobrescreverEstoqueEfetivo}
          onChange={(e) => setSobrescreverEstoque(e.currentTarget.checked)}
          disabled={!importarEstoque}
        />
        <Checkbox
          label={ROTULO.importarPreco}
          checked={importarPreco}
          onChange={(e) => setImportarPreco(e.currentTarget.checked)}
        />
        <Checkbox
          label={ROTULO.sobrescreverPreco}
          checked={sobrescreverPrecoEfetivo}
          onChange={(e) => setSobrescreverPreco(e.currentTarget.checked)}
          disabled={!importarPreco}
        />
        <Checkbox
          label={ROTULO.importarFotos}
          description={DESCRICAO_IMPORTAR_FOTOS_SHOPEE}
          checked={importarFotos}
          onChange={(e) => setImportarFotos(e.currentTarget.checked)}
        />
        <Checkbox
          label={ROTULO.importarCategorias}
          checked={importarCategorias}
          onChange={(e) => setImportarCategorias(e.currentTarget.checked)}
        />
        <Checkbox
          label={ROTULO.atualizarProdutoPai}
          checked={atualizarProdutoPai}
          onChange={(e) => setAtualizarProdutoPai(e.currentTarget.checked)}
        />
        <Checkbox
          label={ROTULO.sobrescreverDadosProduto}
          description="Por padrão a importação só preenche campos vazios. Marque para substituir também os valores já cadastrados. A descrição e a categoria nunca são substituídas."
          checked={sobrescreverDadosProdutoEfetivo}
          onChange={(e) => setSobrescreverDadosProduto(e.currentTarget.checked)}
          disabled={!atualizarProdutoPai}
        />
        <Checkbox
          label={ROTULO.atualizarCadastrados}
          checked={atualizarCadastrados}
          onChange={(e) => setAtualizarCadastrados(e.currentTarget.checked)}
        />
        <DatePickerInput
          type="range"
          label={ROTULO.janela}
          description="Só traz mudanças de cadastro — preço e estoque não alteram essa data."
          placeholder="Todas as datas"
          valueFormat="DD/MM/YYYY"
          value={janela}
          onChange={setJanela}
          allowSingleDateInRange
          clearable
          error={janelaPelaMetade ? 'Escolha as duas datas da janela, ou limpe-a.' : null}
        />
        <Button
          onClick={() => {
            void state.start({
              statuses: [...statuses],
              importarEstoque,
              sobrescreverEstoque: sobrescreverEstoqueEfetivo,
              importarPreco,
              sobrescreverPreco: sobrescreverPrecoEfetivo,
              importarFotos,
              importarCategorias,
              atualizarProdutoPai,
              sobrescreverDadosProduto: sobrescreverDadosProdutoEfetivo,
              atualizarCadastrados,
              updateTimeFromS: janelaEmSegundos?.[0] ?? null,
              updateTimeToS: janelaEmSegundos?.[1] ?? null,
            });
          }}
          loading={state.busy}
          disabled={semStatus || janelaPelaMetade}
        >
          Iniciar importação
        </Button>
      </Stack>
    </Modal>
  );
}
