import { errorMessage, getSettings, isValidMeasurementId, validateEvents } from './lib/ga4';
import { buildPurchase } from './lib/orders';

export const config: SwellConfig = {
  description: 'Check the GA4 setup with the validation server',
  action: true,
};

// A purchase like the ones the app sends, with sample values
export const SAMPLE_ORDER = {
  id: 'validation',
  number: 'TEST-1001',
  account_id: 'validation',
  currency: 'USD',
  paid: true,
  grand_total: 42.5,
  tax_total: 3.5,
  shipment_total: 5,
  coupon_code: 'WELCOME10',
  items: [{ product_id: 'sample', product: { name: 'Sample product', sku: 'SAMPLE-1' }, price: 34, quantity: 1 }],
};

// Settings action: validate the Measurement ID and a sample purchase without recording data
export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());
  if (!isValidMeasurementId(settings.measurement_id)) {
    throw new SwellError('Enter a Measurement ID like G-XXXXXXXXXX, save, then test again.', { status: 400 });
  }
  if (!settings.api_secret?.trim()) {
    throw new SwellError('Enter the Measurement Protocol API secret, save, then test again.', { status: 400 });
  }

  let messages;
  try {
    messages = await validateEvents(settings, buildPurchase(SAMPLE_ORDER, settings));
  } catch (err) {
    throw new SwellError(`GA4 validation failed: ${errorMessage(err)}`, { status: 502 });
  }
  if (messages.length) {
    const details = messages.map((m) => `${m.fieldPath ?? 'event'}: ${m.description ?? m.validationCode}`).join('; ');
    throw new SwellError(`GA4 rejected the sample purchase: ${details}`, { status: 400 });
  }

  return {
    message: `GA4's validation server accepted a sample purchase for ${settings.measurement_id!.trim()}. `
      + "It can't check that the Measurement ID and API secret belong to your property: "
      + 'turn on Debug mode and watch Admin → DebugView in GA4 to confirm events arrive.',
  };
}
