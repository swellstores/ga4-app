import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { makeOrder, mockGa4, mockSwell, savedStatus, sent, settings } from "../helpers/ga4-fixtures";
import orderEvents, { config as orderConfig } from "../../functions/order-events";
import accountEvents, { config as accountConfig } from "../../functions/account-events";
import validateEvent, { config as validateConfig } from "../../functions/validate-event";
import sendToGa4, { MAX_SELECTION, config as sendConfig, summaryMessage } from "../../functions/send-to-ga4";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function eventRequest(swell: any, type: string, data: Record<string, any> = {}, changes: Record<string, any> = { id: "order_1" }) {
  return createMockRequest({ swell, data: { id: "order_1", ...data, $event: { type, data: changes } } });
}

function actionRequest(swell: any, $action: Record<string, any>) {
  return createMockRequest({ swell, data: { $action: { id: "send_to_ga4", user_id: "u1", collection: "orders", ...$action } as any } });
}

const sentApp = { $app: { ga4: { ga4_purchase_sent_at: "2026-10-05T10:00:00Z" } } };

describe("function configs", () => {
  it("declare the expected triggers", () => {
    expect(orderConfig.model?.events).toEqual(["order.submitted", "order.paid", "order.refunded", "order.canceled", "order.updated"]);
    expect(accountConfig.model?.events).toEqual(["account.created"]);
    expect(validateConfig.action).toBe(true);
    expect(sendConfig.action).toBe(true);
  });
});

describe("order-events", () => {
  it("does nothing when disabled or without credentials", async () => {
    const fetchMock = mockGa4();
    for (const ga4 of [{ ...settings, enabled: false }, { ...settings, measurement_id: "UA-1" }, null]) {
      const swell = mockSwell({}, ga4);
      await orderEvents(eventRequest(swell, "order.paid"));
      expect(swell.get).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the purchase when the order is paid", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell({ "/orders/order_1": makeOrder() });

    await orderEvents(eventRequest(swell, "order.paid"));

    expect(swell.get).toHaveBeenCalledWith("/orders/order_1", { expand: ["items.product", "items.variant"] });
    expect(sent(fetchMock)[0].body.events[0].name).toBe("purchase");
  });

  it("sends the purchase on submit when set to", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell({ "/orders/order_1": makeOrder({ paid: false }) }, { ...settings, send_purchase_on: "submitted" });

    await orderEvents(eventRequest(swell, "order.paid"));
    expect(fetchMock).not.toHaveBeenCalled();

    await orderEvents(eventRequest(swell, "order.submitted"));
    expect(sent(fetchMock)).toHaveLength(1);
  });

  it.each([
    ["order.refunded", { refund_total: 52.5 }, {}],
    ["order.canceled", { canceled: true }, {}],
    ["order.updated", { refund_total: 10 }, { id: "order_1", refund_total: 10 }],
  ])("sends a refund on %s", async (type, overrides, changes) => {
    const fetchMock = mockGa4();
    const swell = mockSwell({ "/orders/order_1": makeOrder({ ...overrides, ...sentApp }) });

    await orderEvents(eventRequest(swell, type, {}, changes));

    expect(sent(fetchMock)[0].body.events[0].name).toBe("refund");
  });

  it("ignores other updates and refunds when turned off", async () => {
    const fetchMock = mockGa4();

    const swell = mockSwell({ "/orders/order_1": makeOrder({ refund_total: 10, ...sentApp }) });
    await orderEvents(eventRequest(swell, "order.updated", {}, { id: "order_1", $app: { ga4: {} } }));
    expect(swell.get).not.toHaveBeenCalled();

    const off = mockSwell({ "/orders/order_1": makeOrder({ refund_total: 10, ...sentApp }) }, { ...settings, send_refunds: false });
    await orderEvents(eventRequest(off, "order.refunded"));
    expect(off.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry client errors and throws server errors for a retry", async () => {
    mockGa4({ collect: { status: 400 } });
    await expect(orderEvents(eventRequest(mockSwell({ "/orders/order_1": makeOrder() }), "order.paid"))).resolves.toBeUndefined();

    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGa4({ collect: { status: 502 } });
    await expect(orderEvents(eventRequest(mockSwell({ "/orders/order_1": makeOrder() }), "order.paid"))).rejects.toMatchObject({ status: 502 });
  });

  it("does nothing for a missing order", async () => {
    const fetchMock = mockGa4();
    await orderEvents(eventRequest(mockSwell(), "order.paid"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("account-events", () => {
  const account = { id: "acc_9", date_created: new Date().toISOString(), metadata: { ga_client_id: "99.11" } };

  it("sends sign_up with the account's client and user ID", async () => {
    const fetchMock = mockGa4();

    await accountEvents(createMockRequest({ swell: mockSwell(), data: { ...account, $event: { type: "account.created" } } }));

    expect(sent(fetchMock)[0].body).toEqual({
      client_id: "99.11",
      user_id: "acc_9",
      timestamp_micros: Date.parse(account.date_created) * 1000,
      events: [{
        name: "sign_up",
        params: { method: "email", session_id: Math.floor(Date.parse(account.date_created) / 1000), engagement_time_msec: 1 },
      }],
    });
  });

  it("does nothing when sign-ups are turned off or the app is disabled", async () => {
    const fetchMock = mockGa4();
    for (const ga4 of [{ ...settings, send_sign_up: false }, { ...settings, enabled: false }]) {
      await accountEvents(createMockRequest({ swell: mockSwell({}, ga4), data: { ...account } }));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws server errors for a retry", async () => {
    mockGa4({ collect: { status: 500 } });
    await expect(accountEvents(createMockRequest({ swell: mockSwell(), data: { ...account } }))).rejects.toMatchObject({ status: 500 });
  });
});

describe("validate-event", () => {
  it("asks for a valid Measurement ID and API secret first", async () => {
    await expect(validateEvent(createMockRequest({ swell: mockSwell({}, { measurement_id: "UA-1" }) })))
      .rejects.toThrow("Enter a Measurement ID like G-XXXXXXXXXX, save, then validate again.");
    await expect(validateEvent(createMockRequest({ swell: mockSwell({}, { measurement_id: "G-ABCD1234" }) })))
      .rejects.toThrow("Enter the Measurement Protocol API secret, save, then validate again.");
  });

  it("validates a sample purchase without recording it", async () => {
    const fetchMock = mockGa4();

    const result = await validateEvent(createMockRequest({ swell: mockSwell() }));

    expect(result.message).toContain("GA4 accepted a sample purchase");
    expect(sent(fetchMock)).toHaveLength(1);
    expect(sent(fetchMock)[0].path).toBe("/debug/mp/collect");
    expect(sent(fetchMock)[0].body.events[0]).toMatchObject({ name: "purchase", params: { transaction_id: "TEST-1001" } });
  });

  it("reports validation messages", async () => {
    mockGa4({ validationMessages: [{ fieldPath: "events[0].params.currency", description: "Invalid currency", validationCode: "VALUE_INVALID" }] });

    await expect(validateEvent(createMockRequest({ swell: mockSwell() })))
      .rejects.toThrow("GA4 rejected the sample purchase: events[0].params.currency: Invalid currency");
  });

  it("reports validation server failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 500 }));

    await expect(validateEvent(createMockRequest({ swell: mockSwell() }))).rejects.toThrow("GA4 validation failed");
  });
});

describe("send-to-ga4", () => {
  it("sends the purchase of a recent order from its page", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell({ "/orders": { results: [makeOrder()] } });

    const result = await sendToGa4(actionRequest(swell, { source: "record", record_id: "0123456789abcdef01234567" }));

    expect(result).toEqual({ message: "Sent 1 purchase to GA4." });
    expect(swell.get).toHaveBeenCalledWith("/orders", expect.objectContaining({ id: "0123456789abcdef01234567", limit: MAX_SELECTION + 1 }));
    expect(sent(fetchMock)).toHaveLength(1);
    expect(savedStatus(swell)[0].ga4_purchase_sent_at).toEqual(expect.any(String));
  });

  it("skips old, already sent and unpaid orders of a selection", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell({
      "/orders": {
        results: [
          makeOrder(),
          makeOrder({ id: "o2", number: "100002", date_created: "2020-01-01T00:00:00Z" }),
          makeOrder({ id: "o3", number: "100003", ...sentApp }),
          makeOrder({ id: "o4", number: "100004", paid: false }),
        ],
      },
    });

    const result = await sendToGa4(actionRequest(swell, { source: "bulk", selection: { all: true, count: 4, query: { status: "x" } } }));

    expect(result.message).toBe("Sent 1 purchase to GA4. Skipped: 100002: older than 72 hours · 100003: already sent · 100004: not paid");
    expect(sent(fetchMock)).toHaveLength(1);
  });

  it.each([
    [{ source: "record", collection: "products", record_id: "0123456789abcdef01234567" }, "Run this action from orders"],
    [{ source: "record", record_id: "../x" }, "Invalid record"],
    [{ source: "bulk" }, "Select orders to send"],
  ])("rejects invalid actions: %j", async (action, message) => {
    await expect(sendToGa4(actionRequest(mockSwell(), action))).rejects.toThrow(message);
  });

  it("requires settings and a selection of up to 25 orders", async () => {
    const record = { source: "record", record_id: "0123456789abcdef01234567" };
    await expect(sendToGa4(actionRequest(mockSwell({}, {}), record))).rejects.toThrow("GA4 Measurement ID and API secret are not set");
    await expect(sendToGa4(actionRequest(mockSwell({}, { ...settings, enabled: false }), record))).rejects.toThrow("GA4 integration is disabled");
    await expect(sendToGa4(actionRequest(mockSwell({ "/orders": { results: [] } }), record))).rejects.toThrow("No orders found");
    const many = Array.from({ length: 26 }, () => makeOrder());
    await expect(sendToGa4(actionRequest(mockSwell({ "/orders": { results: many } }), record))).rejects.toThrow("Select up to 25 orders");
  });

  it("reports GA4 failures", async () => {
    mockGa4({ collect: { status: 500 } });
    const swell = mockSwell({ "/orders": { results: [makeOrder()] } });

    await expect(sendToGa4(actionRequest(swell, { source: "record", record_id: "0123456789abcdef01234567" })))
      .rejects.toMatchObject({ message: "GA4: GA4 collect failed (500)", status: 502 });
  });

  it("summarizes results", () => {
    expect(summaryMessage(0, [])).toBe("No purchases sent to GA4.");
    expect(summaryMessage(2, ["1", "2", "3", "4", "5", "6", "7"])).toBe("Sent 2 purchases to GA4. Skipped: 1 · 2 · 3 · 4 · 5 and 2 more");
  });
});
