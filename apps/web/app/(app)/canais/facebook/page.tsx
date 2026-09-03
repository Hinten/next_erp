'use client';

import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { CanalCapsPanel } from '../_components/CanalCapsPanel';

export default function CanalFacebookPage() {
  return (
    <CanalCapsPanel
      tipo={INTEGRACAO_TIPO.facebook}
      titulo="Facebook"
      descricao="Contas e configurações da integração com Facebook/Messenger."
    />
  );
}
