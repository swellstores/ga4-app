import { commonParams, errorMessage, getSettings, hasCredentials, identity, isOn, payload, sendEvents, timestampMicros } from './lib/ga4';

export const config: SwellConfig = {
  description: 'Send sign_up events to GA4',
  model: {
    events: ['account.created'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;

  const settings = getSettings(await swell.settings());
  if (!settings.enabled || !hasCredentials(settings) || !isOn(settings.send_sign_up)) {
    return;
  }

  const id = identity(data.metadata, data.id, data.id, settings);
  try {
    await sendEvents(settings, payload(id, [{
      name: 'sign_up',
      params: { method: 'email', ...commonParams(id, settings, data.date_created) },
    }], timestampMicros(data.date_created)));
    console.log(`GA4: sent sign_up for account ${data.id}`);
  } catch (err) {
    console.error(`GA4: failed to send sign_up for account ${data.id} - ${errorMessage(err)}`);
    if ((err as any)?.status >= 400 && (err as any)?.status < 500) {
      return;
    }
    throw err;
  }
}
