'use client';

import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { CanalCapsPanel } from '../_components/CanalCapsPanel';

export default function CanalAmazonPage() {
  return (
    <CanalCapsPanel
      tipo={INTEGRACAO_TIPO.amazon}
      titulo="Amazon"
      descricao="Contas e configurações da integração com a Amazon."
    />
  );
}
