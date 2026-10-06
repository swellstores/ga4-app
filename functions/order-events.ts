import { errorMessage, getSettings, hasCredentials, isOn } from './lib/ga4';
import { ORDER_EXPAND, sendCancelRefund, sendPurchase } from './lib/orders';

export const config: SwellConfig = {
  description: 'Send purchase events to GA4, and refund the rest of canceled orders',
  model: {
    events: ['order.submitted', 'order.paid', 'order.canceled'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const event = data.$event?.type;

  const settings = getSettings(await swell.settings());
  if (!settings.enabled || !hasCredentials(settings)) {
    return;
  }

  const purchaseEvent = settings.send_purchase_on === 'submitted' ? 'order.submitted' : 'order.paid';
  const isCancel = event === 'order.canceled';
  if (event !== purchaseEvent && !(isCancel && isOn(settings.send_refunds))) {
    return;
  }

  const order = await swell.get(`/orders/${data.id}`, { expand: ORDER_EXPAND });
  if (!order?.id) {
    return;
  }

  try {
    const result = isCancel
      ? await sendCancelRefund(swell, settings, order)
      : await sendPurchase(swell, settings, order);
    if (result.sent) {
      console.log(`GA4: sent ${isCancel ? 'refund for canceled' : 'purchase for'} order ${order.number}`);
    }
  } catch (err) {
    console.error(`GA4: failed to send ${event} for order ${order.number} - ${errorMessage(err)}`);
    // 4xx means the settings are wrong; retrying won't help
    if ((err as any)?.status >= 400 && (err as any)?.status < 500) {
      return;
    }
    throw err;
  }
}
