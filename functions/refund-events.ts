import { errorMessage, getSettings, hasCredentials, isOn } from './lib/ga4';
import { ORDER_EXPAND, sendRefund } from './lib/orders';

export const config: SwellConfig = {
  description: 'Send a GA4 refund event for each successful refund',
  model: {
    // fires once per refund when it succeeds, including partial refunds
    events: ['payment.refund.succeeded'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;

  const settings = getSettings(await swell.settings());
  if (!settings.enabled || !hasCredentials(settings) || !isOn(settings.send_refunds)) {
    return;
  }

  // refunds of payments without an order (e.g. subscription invoices) are not sent
  const orderId = data.order_id;
  if (!orderId || !data.id) {
    return;
  }

  const order = await swell.get(`/orders/${orderId}`, { expand: ORDER_EXPAND });
  if (!order?.id) {
    return;
  }

  try {
    const result = await sendRefund(swell, settings, order, { id: data.id, amount: data.amount });
    if (result.sent) {
      console.log(`GA4: sent refund ${data.id} of ${data.amount} for order ${order.number}`);
    } else {
      console.log(`GA4: refund ${data.id} for order ${order.number} not sent - ${result.reason}`);
    }
  } catch (err) {
    console.error(`GA4: failed to send refund ${data.id} for order ${order.number} - ${errorMessage(err)}`);
    if ((err as any)?.status >= 400 && (err as any)?.status < 500) {
      return;
    }
    throw err;
  }
}
