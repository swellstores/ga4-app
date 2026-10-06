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

// Refunds already reported to GA4, by Swell refund ID ('canceled' for a canceled order).
// Orders sent before refunds were tracked by ID keep their total under 'previous'.
export function reportedRefunds(order: any): Record<string, number> {
  const data = appData(order);
  if (data.ga4_refunds && typeof data.ga4_refunds === 'object') {
    return data.ga4_refunds;
  }
  return data.ga4_refund_value ? { previous: money(data.ga4_refund_value) } : {};
}

export function reportedTotal(order: any) {
  return money(Object.values(reportedRefunds(order)).reduce((sum, value) => sum + (Number(value) || 0), 0));
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

// Send one GA4 refund under a key that is never sent twice: a Swell refund ID, or 'canceled'.
// The value is capped at the part of the order total not reported as refunded yet.
async function sendRefundOnce(
  swell: SwellClient,
  settings: Ga4Settings,
  order: any,
  key: string,
  amount: number,
): Promise<SendResult> {
  if (!appData(order).ga4_purchase_sent_at) {
    return { sent: false, reason: 'purchase not sent' };
  }
  const reported = reportedRefunds(order);
  if (key in reported) {
    return { sent: false, reason: 'already sent' };
  }
  const value = money(Math.min(money(amount), money(order.grand_total) - reportedTotal(order)));
  if (value < MIN_REFUND) {
    return { sent: false, reason: 'nothing left to refund' };
  }
  try {
    await sendEvents(settings, buildRefund(order, value, settings));
  } catch (err) {
    await saveStatus(swell, order.id, { ga4_error: (err as Error).message });
    throw err;
  }
  // ga4_refunds is merged by key, so refunds saved at the same time don't overwrite each other.
  // An older order keeps its earlier total under 'previous'.
  const previous = !appData(order).ga4_refunds && reported.previous ? { previous: reported.previous } : {};
  await saveStatus(swell, order.id, {
    ga4_refunds: { ...previous, [key]: value },
    ga4_refund_value: money(reportedTotal(order) + value),
    ga4_refund_sent_at: new Date().toISOString(),
    ga4_error: null,
  });
  return { sent: true };
}

// Report a successful Swell refund (payment.refund.succeeded) with its amount
export function sendRefund(swell: SwellClient, settings: Ga4Settings, order: any, refund: { id: string; amount: unknown }) {
  return sendRefundOnce(swell, settings, order, String(refund.id), Number(refund.amount) || 0);
}

// Report the rest of a canceled order as refunded, when Refund canceled orders is on
export function sendCancelRefund(swell: SwellClient, settings: Ga4Settings, order: any): Promise<SendResult> {
  if (!isOn(settings.refund_canceled)) {
    return Promise.resolve({ sent: false, reason: 'refunds of canceled orders are off' });
  }
  return sendRefundOnce(swell, settings, order, 'canceled', Number(order.grand_total) || 0);
}
