// Measurement Protocol hosts; EU data is collected in region1
const HOSTS = {
  global: 'https://www.google-analytics.com',
  eu: 'https://region1.google-analytics.com',
};

// Measurement Protocol limits
export const MAX_ITEMS = 200;
export const MAX_VALUE_LENGTH = 100;
export const MAX_BACKDATE_MS = 72 * 60 * 60 * 1000;

export interface Ga4Settings {
  measurement_id?: string;
  api_secret?: string;
  enabled?: boolean;
  region?: 'global' | 'eu';
  // send purchase when the order is 'paid' (default) or 'submitted'
  send_purchase_on?: 'paid' | 'submitted';
  send_refunds?: boolean;
  refund_canceled?: boolean;
  send_sign_up?: boolean;
  send_user_id?: boolean;
  debug_mode?: boolean;
}

// The subset of the Swell client this lib needs (req.swell)
export interface SwellClient {
  get(url: string, query?: any): Promise<any>;
  put(url: string, data?: any): Promise<any>;
  settings(id?: string): Promise<any>;
}

export interface Ga4Event {
  name: string;
  params: Record<string, unknown>;
}

export interface Ga4Payload {
  client_id: string;
  user_id?: string;
  timestamp_micros?: number;
  events: Ga4Event[];
}

export interface ValidationMessage {
  fieldPath?: string;
  description?: string;
  validationCode?: string;
}

// Measurement Protocol failure with its HTTP status
export class Ga4Error extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'Ga4Error';
    this.status = status;
  }
}

export function getSettings(rawSettings: any): Ga4Settings {
  return (rawSettings?.ga4 ?? {}) as Ga4Settings;
}

export function isValidMeasurementId(value: unknown) {
  return typeof value === 'string' && /^G-[A-Z0-9]{4,}$/i.test(value.trim());
}

export function hasCredentials(settings: Ga4Settings) {
  return isValidMeasurementId(settings.measurement_id) && Boolean(settings.api_secret?.trim());
}

// Settings and events are on unless turned off; settings saved before a field existed have no value
export const isOn = (value: boolean | undefined) => value !== false;

function collectUrl(settings: Ga4Settings, validate: boolean) {
  const host = settings.region === 'eu' ? HOSTS.eu : HOSTS.global;
  const query = new URLSearchParams({
    measurement_id: settings.measurement_id!.trim(),
    api_secret: settings.api_secret!.trim(),
  });
  return `${host}/${validate ? 'debug/' : ''}mp/collect?${query}`;
}

// Send events to GA4. The collect endpoint accepts anything with a 2xx and returns no details,
// so only transport and authentication failures can be detected here.
export async function sendEvents(settings: Ga4Settings, payload: Ga4Payload): Promise<void> {
  if (!hasCredentials(settings)) {
    throw new Ga4Error('GA4 Measurement ID and API secret are not set in app settings', 400);
  }
  const res = await fetch(collectUrl(settings, false), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Ga4Error(`GA4 collect failed (${res.status})${text ? `: ${text.slice(0, 300)}` : ''}`, res.status);
  }
}

// Check events with the Measurement Protocol validation server. It doesn't check the API secret.
export async function validateEvents(settings: Ga4Settings, payload: Ga4Payload): Promise<ValidationMessage[]> {
  if (!hasCredentials(settings)) {
    throw new Ga4Error('GA4 Measurement ID and API secret are not set in app settings', 400);
  }
  const res = await fetch(collectUrl(settings, true), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Ga4Error(`GA4 validation failed (${res.status})`, res.status || 502);
  }
  return Array.isArray(data.validationMessages) ? data.validationMessages : [];
}

export const money = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;

// Strings are cut to the Measurement Protocol value limit
export function text(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value).slice(0, MAX_VALUE_LENGTH);
}

// Drop empty params so GA4 doesn't record blank values
export function compact<T extends Record<string, unknown>>(params: T): T {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')) as T;
}

export interface Identity {
  client_id: string;
  user_id?: string;
  session_id?: number;
}

// GA4 client and session IDs saved by the storefront in the record metadata
// (ga_client_id, ga_session_id), so server events join the visitor's web session.
// Without them a stable ID per customer keeps the events of one customer together.
export function identity(metadata: any, accountId: string | undefined, recordId: string, settings: Ga4Settings): Identity {
  metadata = metadata ?? {};
  const clientId = typeof metadata.ga_client_id === 'string' && metadata.ga_client_id.trim()
    ? metadata.ga_client_id.trim().slice(0, MAX_VALUE_LENGTH)
    : `swell.${accountId || recordId}`;
  const sessionId = Number(metadata.ga_session_id);
  return compact({
    client_id: clientId,
    user_id: isOn(settings.send_user_id) && accountId ? String(accountId) : undefined,
    session_id: Number.isFinite(sessionId) && sessionId > 0 ? sessionId : undefined,
  });
}

// Event time in microseconds, when GA4 still accepts it (up to 72 hours back)
export function timestampMicros(date: unknown, now = Date.now()): number | undefined {
  const time = new Date(date as any).getTime();
  if (!Number.isFinite(time) || time > now || now - time > MAX_BACKDATE_MS) {
    return undefined;
  }
  return time * 1000;
}

// Params added to every event: the session, engagement and DebugView flag.
// GA4 shows Measurement Protocol events in Realtime and DebugView only with a session_id and a
// positive engagement_time_msec. Without the storefront's session, the event time in seconds
// starts a server-side session.
export function commonParams(id: Identity, settings: Ga4Settings, eventTime: unknown = Date.now()) {
  const time = new Date(eventTime as any).getTime();
  return compact({
    session_id: id.session_id ?? Math.floor((Number.isFinite(time) ? time : Date.now()) / 1000),
    engagement_time_msec: 1,
    debug_mode: settings.debug_mode ? true : undefined,
  });
}

export function payload(id: Identity, events: Ga4Event[], timestamp?: number): Ga4Payload {
  return compact({
    client_id: id.client_id,
    user_id: id.user_id,
    timestamp_micros: timestamp,
    events,
  }) as Ga4Payload;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
