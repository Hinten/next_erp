'use client';

import type { ReactNode } from 'react';
import { Alert, Tabs } from '@mantine/core';

/**
 * Tab shell shared by the Filial create and edit pages, porting the
 * `rightMenu` of the Flutter `FilialCadastroPage`
 * (`.old/lib/grupoEconomico/pages/filiaisTableView.dart`): a single page that
 * serves both flows with the same Dados / Configurações NFe / Certificado
 * Digital navigation.
 *
 * The "Dados" panel content is supplied by the caller; the NFe and
 * Certificado panels are placeholders until the NF-e phase. Tabs keep their
 * default `keepMounted` (true) so the form keeps unsaved input when the user
 * peeks at the placeholder tabs — matching the Flutter `AutomaticKeepAlive`.
 */
export function FilialTabs({ children }: { children: ReactNode }) {
  return (
    <Tabs defaultValue="dados">
      <Tabs.List>
        <Tabs.Tab value="dados">Dados</Tabs.Tab>
        <Tabs.Tab value="nfe">Configurações NFe</Tabs.Tab>
        <Tabs.Tab value="certificado">Certificado Digital</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="dados" pt="md">
        {children}
      </Tabs.Panel>

      <Tabs.Panel value="nfe" pt="md">
        <Alert color="blue" title="Em breve">
          A configuração de numeração e ambiente da NF-e desta filial será disponibilizada na fase
          de NF-e.
        </Alert>
      </Tabs.Panel>

      <Tabs.Panel value="certificado" pt="md">
        <Alert color="blue" title="Em breve">
          O envio do certificado digital A1 (.pfx/.pem) desta filial será disponibilizado na fase de
          NF-e.
        </Alert>
      </Tabs.Panel>
    </Tabs>
  );
}
