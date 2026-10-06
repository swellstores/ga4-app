import {
  MAX_ITEMS,
  commonParams,
  compact,
  identity,
  isOn,
  money,
  payload,
  sendEvents,
  text,
  timestampMicros,
  type Ga4Payload,
  type Ga4Settings,
  type SwellClient,
} from './ga4';

export const ORDER_EXPAND = ['items.product', 'items.variant'];

// Refund amounts below a cent are rounding noise
const MIN_REFUND = 0.005;

export function appData(order: any) {
  return order?.$app?.ga4 ?? {};
}

// GA4 ecommerce items: SKU (or product ID), name, variant, unit price after item discounts, quantity
export function buildItems(order: any) {
  return (order.items ?? []).slice(0, MAX_ITEMS).map((item: any, index: number) => compact({
    item_id: text(item.variant?.sku || item.product?.sku || item.product_id),
    item_name: text(item.product?.name || item.product_name || item.product_id),
    item_variant: text(item.variant?.name),
    price: money(Number(item.price || 0) - Number(item.discount_each || 0)),
    quantity: Number(item.quantity) || 1,
    index,
  }));
}

// Whether a purchase can be sent under "Send purchase when"
export function isPurchaseReady(order: any, settings: Ga4Settings) {
  if (!order || order.draft || order.canceled || order.status === 'canceled') {
    return false;
  }
  return settings.send_purchase_on === 'submitted' || order.paid === true;
}

function orderIdentity(order: any, settings: Ga4Settings) {
  return identity(order.metadata, order.account_id, order.id, settings);
}

export function buildPurchase(order: any, settings: Ga4Settings): Ga4Payload {
  const id = orderIdentity(order, settings);
  return payload(id, [{
    name: 'purchase',
    params: compact({
      transaction_id: String(order.number ?? order.id),
      value: money(order.grand_total),
      currency: order.currency,
      tax: money(order.tax_total),
      shipping: money(order.shipment_total),
      coupon: text(order.coupon_code),
      items: buildItems(order),
      ...commonParams(id, settings, order.date_created),
    }),
  }], timestampMicros(order.date_submitted ?? order.date_created));
}

export function buildRefund(order: any, value: number, settings: Ga4Settings): Ga4Payload {
  const id = orderIdentity(order, settings);
  return payload(id, [{
    name: 'refund',
    params: compact({
      transaction_id: String(order.number ?? order.id),
      value: money(value),
      currency: order.currency,
      ...commonParams(id, settings),
    }),
  }]);
}

// Total the app should have reported as refunded: the refund total, or the whole order once canceled
export function refundTarget(order: any, settings: Ga4Settings) {
  if ((order.canceled || order.status === 'canceled') && isOn(settings.refund_canceled)) {
    return money(order.grand_total);
  }
  return Math.min(money(order.refund_total), money(order.grand_total));
}

// Status stored on the order without triggering order events
function saveStatus(swell: SwellClient, orderId: string, values: Record<string, unknown>) {
  return swell.put(`/orders/${orderId}`, { $events: false, $app: { ga4: values } });
}

export type SendResult = { sent: boolean; reason?: string };

// Send the purchase once and remember it on the order
export async function sendPurchase(swell: SwellClient, settings: Ga4Settings, order: any): Promise<SendResult> {
  if (appData(order).ga4_purchase_sent_at) {
    return { sent: false, reason: 'already sent' };
  }
  if (!isPurchaseReady(order, settings)) {
    return { sent: false, reason: settings.send_purchase_on === 'submitted' ? 'draft or canceled' : 'not paid' };
  }
  const event = buildPurchase(order, settings);
  try {
    await sendEvents(settings, event);
  } catch (err) {
    await saveStatus(swell, order.id, { ga4_error: (err as Error).message });
    throw err;
  }
  await saveStatus(swell, order.id, {
    ga4_purchase_sent_at: new Date().toISOString(),
    ga4_client_id: event.client_id,
    ga4_error: null,
  });
  return { sent: true };
}

// Report what was refunded since the last refund event, for orders whose purchase was sent
export async function sendRefund(swell: SwellClient, settings: Ga4Settings, order: any): Promise<SendResult> {
  const data = appData(order);
  if (!data.ga4_purchase_sent_at) {
    return { sent: false, reason: 'purchase not sent' };
  }
  const target = refundTarget(order, settings);
  const delta = money(target - money(data.ga4_refund_value));
  if (delta < MIN_REFUND) {
    return { sent: false, reason: 'nothing new refunded' };
  }
  try {
    await sendEvents(settings, buildRefund(order, delta, settings));
  } catch (err) {
    await saveStatus(swell, order.id, { ga4_error: (err as Error).message });
    throw err;
  }
  await saveStatus(swell, order.id, { ga4_refund_value: target, ga4_refund_sent_at: new Date().toISOString(), ga4_error: null });
  return { sent: true };
}
