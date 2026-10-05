import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlPayment,
  type MlShipmentPayment,
} from '@delfrance/integrations-mercado-livre';

/** `payment_id` rides in the plugin schema's passthrough. */
interface MlShipmentPaymentIdPassthrough extends MlShipmentPayment {
  payment_id?: number | string | null;
}

export function shipmentPaymentId(payment: MlShipmentPayment): number | string | null {
  return (payment as MlShipmentPaymentIdPassthrough).payment_id ?? null;
}

export interface LoadShipmentPaymentDetailsOptions {
  approvedOnly: boolean;
  tolerateNotFound: boolean;
}

/**
 * Loads unique payment details referenced by shipment-payment summaries.
 * Callers choose whether status gates the fan-out and whether a detail that
 * disappeared with HTTP 404 counts as absent.
 */
export async function loadShipmentPaymentDetails(
  api: MercadoLivreApi,
  summaries: readonly MlShipmentPayment[],
  options: LoadShipmentPaymentDetailsOptions,
): Promise<MlPayment[]> {
  const ids = [
    ...new Set(
      summaries
        .filter((payment) => !options.approvedOnly || payment.status === 'approved')
        .map(shipmentPaymentId)
        .filter((id): id is number | string => id != null)
        .map(String),
    ),
  ];
  const payments = await Promise.all(
    ids.map(async (id): Promise<MlPayment | null> => {
      try {
        return await api.getPayment(id);
      } catch (err) {
        if (
          options.tolerateNotFound &&
          err instanceof MercadoLivreHttpError &&
          err.status === 404
        ) {
          return null;
        }
        throw err;
      }
    }),
  );
  return payments.filter((payment): payment is MlPayment => payment != null);
}
