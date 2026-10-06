import { errorMessage, getSettings, hasCredentials, isOn } from './lib/ga4';
import { ORDER_EXPAND, sendPurchase, sendRefund } from './lib/orders';

export const config: SwellConfig = {
  description: 'Send purchase and refund events to GA4',
  model: {
    events: ['order.submitted', 'order.paid', 'order.refunded', 'order.canceled', 'order.updated'],
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
  const isRefund = event === 'order.refunded' || event === 'order.canceled'
    // partial refunds change refund_total without an order.refunded event
    || (event === 'order.updated' && 'refund_total' in (data.$event?.data ?? {}));
  if (event !== purchaseEvent && !(isRefund && isOn(settings.send_refunds))) {
    return;
  }

  const order = await swell.get(`/orders/${data.id}`, { expand: ORDER_EXPAND });
  if (!order?.id) {
    return;
  }

  try {
    const result = event === purchaseEvent
      ? await sendPurchase(swell, settings, order)
      : await sendRefund(swell, settings, order);
    if (result.sent) {
      console.log(`GA4: sent ${event === purchaseEvent ? 'purchase' : 'refund'} for order ${order.number}`);
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
