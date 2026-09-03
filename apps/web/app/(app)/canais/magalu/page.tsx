'use client';

import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { CanalCapsPanel } from '../_components/CanalCapsPanel';

export default function CanalMagaluPage() {
  return (
    <CanalCapsPanel
      tipo={INTEGRACAO_TIPO.magalu}
      titulo="Magalu"
      descricao="Contas e configurações da integração com o Magalu Open API."
    />
  );
}
