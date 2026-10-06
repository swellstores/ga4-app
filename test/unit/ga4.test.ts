import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Ga4Error,
  commonParams,
  compact,
  getSettings,
  hasCredentials,
  identity,
  isOn,
  isValidMeasurementId,
  money,
  payload,
  sendEvents,
  text,
  timestampMicros,
  validateEvents,
} from "../../functions/lib/ga4";
import { mockGa4, sent, settings } from "../helpers/ga4-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

const event = payload({ client_id: "c1" }, [{ name: "sign_up", params: { method: "email" } }]);

describe("settings helpers", () => {
  it("reads the ga4 settings section", () => {
    expect(getSettings({ ga4: { enabled: true } })).toEqual({ enabled: true });
    expect(getSettings(null)).toEqual({});
  });

  it("checks the Measurement ID format and the API secret", () => {
    expect(isValidMeasurementId("G-ABC123XYZ")).toBe(true);
    expect(isValidMeasurementId(" g-abc123 ")).toBe(true);
    expect(isValidMeasurementId("UA-12345-1")).toBe(false);
    expect(isValidMeasurementId(undefined)).toBe(false);
    expect(hasCredentials(settings as any)).toBe(true);
    expect(hasCredentials({ ...settings, api_secret: " " } as any)).toBe(false);
  });

  it("treats unset toggles as on", () => {
    expect(isOn(undefined)).toBe(true);
    expect(isOn(true)).toBe(true);
    expect(isOn(false)).toBe(false);
  });
});

describe("value helpers", () => {
  it("rounds money to cents", () => {
    expect(money("10.005")).toBe(10.01);
    expect(money(undefined)).toBe(0);
  });

  it("cuts strings to 100 characters and drops empty values", () => {
    expect(text("x".repeat(150))).toHaveLength(100);
    expect(text("")).toBeUndefined();
    expect(text(5)).toBe("5");
    expect(compact({ a: 1, b: undefined, c: null, d: "", e: 0, f: false })).toEqual({ a: 1, e: 0, f: false });
  });

  it("backdates events up to 72 hours only", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    expect(timestampMicros("2026-10-05T11:00:00Z", now)).toBe(Date.parse("2026-10-05T11:00:00Z") * 1000);
    expect(timestampMicros("2026-10-01T11:00:00Z", now)).toBeUndefined();
    expect(timestampMicros("2026-10-06T11:00:00Z", now)).toBeUndefined();
    expect(timestampMicros("not a date", now)).toBeUndefined();
  });
});

describe("identity", () => {
  it("uses the client and session IDs the storefront saved", () => {
    expect(identity({ ga_client_id: " 123.456 ", ga_session_id: "1727000000" }, "acc_1", "order_1", settings as any)).toEqual({
      client_id: "123.456",
      user_id: "acc_1",
      session_id: 1727000000,
    });
  });

  it("falls back to a stable ID per customer, or per record for guests", () => {
    expect(identity(undefined, "acc_1", "order_1", settings as any).client_id).toBe("swell.acc_1");
    expect(identity({ ga_session_id: "x" }, undefined, "order_1", settings as any)).toEqual({ client_id: "swell.order_1" });
  });

  it("omits user_id when turned off", () => {
    expect(identity({}, "acc_1", "o", { send_user_id: false }).user_id).toBeUndefined();
  });

  it("adds the storefront session, engagement and debug params", () => {
    expect(commonParams({ client_id: "c", session_id: 5 }, { debug_mode: true })).toEqual({
      session_id: 5,
      engagement_time_msec: 1,
      debug_mode: true,
    });
  });

  it("starts a session from the event time without a storefront session, so events show in Realtime and DebugView", () => {
    expect(commonParams({ client_id: "c" }, {}, "2026-10-06T07:48:08.584Z")).toEqual({
      session_id: Math.floor(Date.parse("2026-10-06T07:48:08.584Z") / 1000),
      engagement_time_msec: 1,
    });
    const now = Math.floor(Date.now() / 1000);
    expect(commonParams({ client_id: "c" }, {}, "not a date").session_id).toBeGreaterThanOrEqual(now);
    expect(commonParams({ client_id: "c" }, {}).session_id).toBeGreaterThanOrEqual(now);
  });
});

describe("sendEvents", () => {
  it("posts to the global collect endpoint with the Measurement ID and API secret", async () => {
    const fetchMock = mockGa4();

    await sendEvents(settings as any, event);

    expect(sent(fetchMock)).toEqual([{
      host: "www.google-analytics.com",
      path: "/mp/collect",
      query: { measurement_id: "G-TEST1234", api_secret: "secret_1" },
      body: { client_id: "c1", events: [{ name: "sign_up", params: { method: "email" } }] },
    }]);
  });

  it("uses the EU endpoint", async () => {
    const fetchMock = mockGa4();

    await sendEvents({ ...settings, region: "eu" } as any, event);

    expect(sent(fetchMock)[0].host).toBe("region1.google-analytics.com");
  });

  it("reports HTTP failures with their status", async () => {
    mockGa4({ collect: { status: 403, body: "forbidden" } });

    const err = await sendEvents(settings as any, event).catch((e) => e);

    expect(err).toBeInstanceOf(Ga4Error);
    expect(err.message).toBe("GA4 collect failed (403): forbidden");
    expect(err.status).toBe(403);
  });

  it("requires credentials", async () => {
    await expect(sendEvents({}, event)).rejects.toThrow("GA4 Measurement ID and API secret are not set in app settings");
  });
});

describe("validateEvents", () => {
  it("returns the validation server messages", async () => {
    const messages = [{ fieldPath: "events[0].name", description: "bad", validationCode: "NAME_INVALID" }];
    const fetchMock = mockGa4({ validationMessages: messages });

    expect(await validateEvents(settings as any, event)).toEqual(messages);
    expect(sent(fetchMock)[0].path).toBe("/debug/mp/collect");
  });

  it("fails on errors from the validation server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 500 }));

    await expect(validateEvents(settings as any, event)).rejects.toMatchObject({ status: 500 });
  });
});
