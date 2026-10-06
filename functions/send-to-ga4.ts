import { MAX_BACKDATE_MS, errorMessage, getSettings, hasCredentials } from './lib/ga4';
import { ORDER_EXPAND, sendPurchase } from './lib/orders';

export const config: SwellConfig = {
  description: 'Send purchases of selected recent orders to GA4',
  action: true,
};

// Most orders an action sends, one request each, to finish within the function timeout
export const MAX_SELECTION = 25;
const RECORD_ID = /^[0-9a-f]{24}$/i;

// Record or bulk action on orders: send purchases that were missed (e.g. before the app was set up).
// GA4 accepts events up to 72 hours old, so older orders are skipped.
export default async function (req: SwellRequest) {
  const action = req.data.$action;
  if (action?.collection !== 'orders') {
    throw new SwellError('Run this action from orders', { status: 400 });
  }
  let query: Record<string, any>;
  if (action.source === 'record') {
    if (!action.record_id || !RECORD_ID.test(action.record_id)) {
      throw new SwellError('Invalid record', { status: 400 });
    }
    query = { id: action.record_id };
  } else if (action.source === 'bulk' && action.selection?.query) {
    query = action.selection.query;
  } else {
    throw new SwellError('Select orders to send', { status: 400 });
  }

  const settings = getSettings(await req.swell.settings());
  if (!hasCredentials(settings)) {
    throw new SwellError('GA4 Measurement ID and API secret are not set in app settings', { status: 400 });
  }
  if (!settings.enabled) {
    throw new SwellError('GA4 integration is disabled in app settings', { status: 400 });
  }

  const found = await req.swell.get('/orders', { ...query, limit: MAX_SELECTION + 1, expand: ORDER_EXPAND });
  const orders: any[] = found?.results ?? [];
  if (!orders.length) {
    throw new SwellError('No orders found', { status: 404 });
  }
  if (orders.length > MAX_SELECTION) {
    throw new SwellError(`Select up to ${MAX_SELECTION} orders`, { status: 400 });
  }

  let sent = 0;
  const skipped: string[] = [];
  const now = Date.now();
  for (const order of orders) {
    const created = new Date(order.date_created).getTime();
    if (!(now - created <= MAX_BACKDATE_MS)) {
      skipped.push(`${order.number}: older than 72 hours`);
      continue;
    }
    try {
      const result = await sendPurchase(req.swell, settings, order);
      if (result.sent) sent++;
      else skipped.push(`${order.number}: ${result.reason}`);
    } catch (err) {
      throw new SwellError(`GA4: ${errorMessage(err)}`, { status: 502 });
    }
  }

  return { message: summaryMessage(sent, skipped) };
}

// e.g. "Sent 2 purchases to GA4. Skipped: 100231: already sent"
export function summaryMessage(sent: number, skipped: string[]) {
  const parts = [sent ? `Sent ${sent} purchase${sent === 1 ? '' : 's'} to GA4.` : 'No purchases sent to GA4.'];
  if (skipped.length) {
    parts.push(`Skipped: ${skipped.slice(0, 5).join(' · ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}`);
  }
  return parts.join(' ');
}
