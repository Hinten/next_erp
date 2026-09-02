'use client';

import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { CanalCapsPanel } from '../_components/CanalCapsPanel';

export default function CanalLojaIntegradaPage() {
  return (
    <CanalCapsPanel
      tipo={INTEGRACAO_TIPO.lojaIntegrada}
      titulo="Loja Integrada"
      descricao="Contas e configurações da integração com a Loja Integrada."
    />
  );
}
