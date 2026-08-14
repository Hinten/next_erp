'use client';

import { Divider, Stack, Title } from '@mantine/core';
import { CONFIG_IA_ML_ATRIBUTOS_DOC_ID, CONFIG_IA_ML_MEDIDAS_DOC_ID } from '@delfrance/schemas';

import { ConfigIaPanel } from './_components/ConfigIaPanel';

/**
 * `/configuracoes/ia` — settings for the AI agents.
 *
 * No `RequirePerm` here: `configuracoes/layout.tsx` already wraps every child in
 * `RequirePerm bit={PERM.configuracoes.read}`, and a second guard would mean two
 * redirects racing. The write gate is inside the panel
 * (`usePermission(PERM.integracao.write)`).
 *
 * One panel per agent, each editing its own `configIa/{agenteId}` document.
 * Stacked rather than tabbed on purpose: with two short forms, tabs would hide
 * half the settings behind a click and — more to the point — hide whether the
 * OTHER agent is currently switched off, which is exactly what someone opening
 * this page to diagnose a misbehaving suggestion needs to see.
 */
export default function ConfiguracoesIaPage() {
  return (
    <Stack>
      <Title order={2}>Inteligência artificial</Title>

      <ConfigIaPanel
        agenteId={CONFIG_IA_ML_ATRIBUTOS_DOC_ID}
        titulo="Sugestão de atributos (Mercado Livre)"
        descricao="Preenche os atributos da categoria a partir do nome, marca, descrição e uma foto do produto. As sugestões sempre passam por revisão — nada é gravado no anúncio automaticamente."
      />

      <Divider my="md" />

      <ConfigIaPanel
        agenteId={CONFIG_IA_ML_MEDIDAS_DOC_ID}
        titulo="Preenchimento da guia de tamanhos (Mercado Livre)"
        descricao="Lê as medidas na foto da tabela do fornecedor e preenche a grade da guia. As sugestões sempre passam por revisão — nenhuma medida é gravada automaticamente."
      />
    </Stack>
  );
}
