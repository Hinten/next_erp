'use client';

/**
 * The options dialog of "Importar produtos da loja" (master plan step 9): the
 * five choices of the start body, each with one line saying what it does.
 *
 * - **Modo**: Simular reads and decides exactly as Importar does and writes
 *   nothing to the ERP; Importar writes.
 * - **Alvo**: every store product, only those the ERP lacks, or only those it
 *   has. The fourth target, a selection from a finished Simular, is started from
 *   that Simular's result, never from here.
 * - **Ação**: Completar creates what is missing and fills only EMPTY fields; Só
 *   vincular links and changes nothing else.
 * - **Categorias** and **Fotos** mean something under Completar only: under Só
 *   vincular both are DISABLED, show their defaults and are SENT as their
 *   defaults — the start body refuses anything else there, and a contradictory
 *   body is a mistake to prevent, not to send. The choice made under Completar
 *   comes back when the operator switches back.
 *
 * The store never overwrites the ERP, and price and stock are never imported
 * (decided 2026-10-27): the dialog says so above the choices.
 *
 * ⚠️ Every open starts from `OPCOES_IMPORTACAO_LI_PADRAO` — Simular, Todos, Só
 * vincular — the options that change the least. The choices live in the modal's
 * body, which Mantine unmounts when it closes, so an "Importar" left picked
 * yesterday is never the default of today's run.
 */
import { useState } from 'react';
import { Button, Modal, Radio, Stack, Text } from '@mantine/core';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  type AcaoImportacaoLi,
  type AlvoImportacaoLi,
  CATEGORIAS_IMPORTACAO_LI,
  type CategoriasImportacaoLi,
  FOTOS_IMPORTACAO_LI,
  type FotosImportacaoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  OPCOES_IMPORTACAO_LI_PADRAO,
  acaoImportacaoLiSchema,
  alvoImportacaoLiSchema,
  categoriasImportacaoLiSchema,
  fotosImportacaoLiSchema,
  modoImportacaoLiSchema,
} from '@delfrance/schemas';
import type { z } from 'zod';

import { ContasSelecionadas } from '@/components/contaJobs/ContasSelecionadas';
import {
  ROTULO_ACAO_IMPORTACAO_LI,
  ROTULO_ALVO_IMPORTACAO_LI,
  ROTULO_CATEGORIAS_IMPORTACAO_LI,
  ROTULO_FOTOS_IMPORTACAO_LI,
  ROTULO_MODO_IMPORTACAO_LI,
} from '@/lib/loja-integrada/importacaoRotulos';
import type { ImportarProdutosLiActionState } from './useImportarProdutosLiAction';

/** What each mode does, under its label. */
const DESCRICAO_MODO = {
  [MODO_IMPORTACAO_LI.simular]:
    'Lê a loja e mostra o que seria feito, produto por produto, sem gravar nada no ERP.',
  [MODO_IMPORTACAO_LI.aplicar]: 'Lê a loja e grava no ERP o que a leitura decidir.',
} as const satisfies Record<ModoImportacaoLi, string>;

/** The targets this dialog offers — `selecionados` is started from a Simular's result. */
const ALVOS_DO_DIALOGO = [
  ALVO_IMPORTACAO_LI.todos,
  ALVO_IMPORTACAO_LI.naoNoErp,
  ALVO_IMPORTACAO_LI.jaNoErp,
] as const satisfies readonly AlvoImportacaoLi[];

const DESCRICAO_ALVO = {
  [ALVO_IMPORTACAO_LI.todos]: 'Todos os produtos da loja que não estão na lixeira dela.',
  [ALVO_IMPORTACAO_LI.naoNoErp]:
    'Só os produtos da loja que o ERP ainda não tem: nem vinculados a esta conta, nem encontrados ' +
    'pelo SKU.',
  [ALVO_IMPORTACAO_LI.jaNoErp]:
    'Só os produtos da loja que o ERP já tem: vinculados a esta conta, ou encontrados por um único ' +
    'SKU.',
} as const satisfies Record<(typeof ALVOS_DO_DIALOGO)[number], string>;

const DESCRICAO_ACAO = {
  [ACAO_IMPORTACAO_LI.completar]:
    'Vincula, cria no ERP os produtos que faltam e preenche só os campos vazios dos que já ' +
    'existem.',
  [ACAO_IMPORTACAO_LI.soVincular]:
    'Só vincula os produtos da loja aos do ERP: nenhum produto é criado nem alterado.',
} as const satisfies Record<AcaoImportacaoLi, string>;

const DESCRICAO_CATEGORIAS = {
  [CATEGORIAS_IMPORTACAO_LI.criarEVincular]:
    'Cria no ERP as categorias da loja que ainda não têm vínculo, e as vincula.',
  [CATEGORIAS_IMPORTACAO_LI.soVincular]:
    'Usa só as categorias já vinculadas; um produto cuja categoria não tem vínculo fica sem ' +
    'categoria.',
} as const satisfies Record<CategoriasImportacaoLi, string>;

const DESCRICAO_FOTOS = {
  [FOTOS_IMPORTACAO_LI.naoImportar]: 'Nenhuma foto é copiada da loja.',
  [FOTOS_IMPORTACAO_LI.soSemFotos]:
    'Copia as fotos da loja só para os produtos do ERP que ainda não têm nenhuma foto.',
} as const satisfies Record<FotosImportacaoLi, string>;

const MODOS = modoImportacaoLiSchema.options;
const ACOES = acaoImportacaoLiSchema.options;
const CATEGORIAS = categoriasImportacaoLiSchema.options;
const FOTOS = fotosImportacaoLiSchema.options;

/** Why the two last groups are off, under Só vincular. */
const SO_COM_COMPLETAR = 'Só com "Completar": só vincular não cria categoria nem copia foto.';

/**
 * A radio group's string as the enum it stands for, or `null`: the group hands
 * back whatever value a radio carried, and only a member of the schema is one
 * of this dialog's options.
 */
function lerOpcao<T extends string>(schema: z.ZodType<T>, valor: string): T | null {
  const lido = schema.safeParse(valor);
  return lido.success ? lido.data : null;
}

export function DialogoImportacaoLi({ state }: { state: ImportarProdutosLiActionState }) {
  return (
    <Modal
      opened={state.opened}
      onClose={state.close}
      title="Importar produtos da loja"
      centered
      size="lg"
    >
      <FormularioImportacaoLi state={state} />
    </Modal>
  );
}

/** The body: mounted on every open, so its choices start from the defaults each time. */
function FormularioImportacaoLi({ state }: { state: ImportarProdutosLiActionState }) {
  const PADRAO = OPCOES_IMPORTACAO_LI_PADRAO;
  const [modo, setModo] = useState<ModoImportacaoLi>(PADRAO.modo);
  const [alvo, setAlvo] = useState<AlvoImportacaoLi>(PADRAO.alvo);
  const [acao, setAcao] = useState<AcaoImportacaoLi>(PADRAO.acao);
  const [categorias, setCategorias] = useState<CategoriasImportacaoLi>(PADRAO.categorias);
  const [fotos, setFotos] = useState<FotosImportacaoLi>(PADRAO.fotos);

  // Under "Só vincular" the two groups show — and the body carries — their
  // defaults; the operator's pick for "Completar" is kept for the way back.
  const soVincular = acao === ACAO_IMPORTACAO_LI.soVincular;
  const categoriasDoCorpo = soVincular ? PADRAO.categorias : categorias;
  const fotosDoCorpo = soVincular ? PADRAO.fotos : fotos;
  const simular = modo === MODO_IMPORTACAO_LI.simular;

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Lê os produtos da loja de cada conta selecionada e os compara com os do ERP, pelo vínculo
        desta conta e pelo SKU. A loja nunca sobrescreve o ERP: só campos vazios são preenchidos.
        Preço e estoque nunca são importados. Pode levar vários minutos — acompanhe no painel ao
        lado da lista. Se a conta já tiver uma importação em andamento, o painel passa a
        acompanhá-la e nenhuma segunda é iniciada.
      </Text>
      <ContasSelecionadas contas={state.contas} />

      <Radio.Group
        label="Modo"
        value={modo}
        onChange={(v) => setModo(lerOpcao(modoImportacaoLiSchema, v) ?? modo)}
      >
        <Stack gap="xs" mt={4}>
          {MODOS.map((m) => (
            <Radio
              key={m}
              value={m}
              label={ROTULO_MODO_IMPORTACAO_LI[m]}
              description={DESCRICAO_MODO[m]}
            />
          ))}
        </Stack>
      </Radio.Group>

      <Radio.Group
        label="Quais produtos"
        value={alvo}
        onChange={(v) => setAlvo(lerOpcao(alvoImportacaoLiSchema, v) ?? alvo)}
      >
        <Stack gap="xs" mt={4}>
          {ALVOS_DO_DIALOGO.map((a) => (
            <Radio
              key={a}
              value={a}
              label={ROTULO_ALVO_IMPORTACAO_LI[a]}
              description={DESCRICAO_ALVO[a]}
            />
          ))}
        </Stack>
      </Radio.Group>

      <Radio.Group
        label="O que fazer"
        value={acao}
        onChange={(v) => setAcao(lerOpcao(acaoImportacaoLiSchema, v) ?? acao)}
      >
        <Stack gap="xs" mt={4}>
          {ACOES.map((a) => (
            <Radio
              key={a}
              value={a}
              label={ROTULO_ACAO_IMPORTACAO_LI[a]}
              description={DESCRICAO_ACAO[a]}
            />
          ))}
        </Stack>
      </Radio.Group>

      <Radio.Group
        label="Categorias"
        description={soVincular ? SO_COM_COMPLETAR : undefined}
        value={categoriasDoCorpo}
        onChange={(v) => setCategorias(lerOpcao(categoriasImportacaoLiSchema, v) ?? categorias)}
      >
        <Stack gap="xs" mt={4}>
          {CATEGORIAS.map((c) => (
            <Radio
              key={c}
              value={c}
              label={ROTULO_CATEGORIAS_IMPORTACAO_LI[c]}
              description={DESCRICAO_CATEGORIAS[c]}
              disabled={soVincular}
            />
          ))}
        </Stack>
      </Radio.Group>

      <Radio.Group
        label="Fotos"
        description={soVincular ? SO_COM_COMPLETAR : undefined}
        value={fotosDoCorpo}
        onChange={(v) => setFotos(lerOpcao(fotosImportacaoLiSchema, v) ?? fotos)}
      >
        <Stack gap="xs" mt={4}>
          {FOTOS.map((f) => (
            <Radio
              key={f}
              value={f}
              label={ROTULO_FOTOS_IMPORTACAO_LI[f]}
              description={DESCRICAO_FOTOS[f]}
              disabled={soVincular}
            />
          ))}
        </Stack>
      </Radio.Group>

      <Button
        onClick={() => {
          void state.start({
            modo,
            alvo,
            acao,
            categorias: categoriasDoCorpo,
            fotos: fotosDoCorpo,
          });
        }}
        loading={state.busy}
        // Disabled, not only spinning, while a start is in flight: two starts in
        // the same second can both pass the backend's guard (it holds no lock).
        disabled={state.busy || state.contas.length === 0}
      >
        {simular ? 'Iniciar simulação' : 'Iniciar importação'}
      </Button>
    </Stack>
  );
}
