import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildItems,
  buildPurchase,
  buildRefund,
  isPurchaseReady,
  refundTarget,
  sendPurchase,
  sendRefund,
} from "../../functions/lib/orders";
import { makeOrder, mockGa4, mockSwell, savedStatus, sent, settings } from "../helpers/ga4-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("event builders", () => {
  it("maps items with SKU, variant and discounted unit price", () => {
    expect(buildItems(makeOrder())).toEqual([
      { item_id: "ETH-250", item_name: "Ethiopia Natural", item_variant: "250g", price: 18, quantity: 2, index: 0 },
      { item_id: "p2", item_name: "Mug", price: 12.4, quantity: 1, index: 1 },
    ]);
  });

  it("sends at most 200 items", () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ product_id: `p${i}`, price: 1, quantity: 1 }));
    expect(buildItems({ items })).toHaveLength(200);
  });

  it("builds a purchase joined to the storefront session", () => {
    const order = makeOrder();

    expect(buildPurchase(order, { ...settings, debug_mode: true } as any)).toEqual({
      client_id: "123456.7890",
      user_id: "acc_1",
      timestamp_micros: Date.parse(order.date_created) * 1000,
      events: [{
        name: "purchase",
        params: {
          transaction_id: "100001",
          value: 52.5,
          currency: "USD",
          tax: 3.5,
          shipping: 5,
          coupon: "WELCOME10",
          items: buildItems(order),
          session_id: 1727000000,
          engagement_time_msec: 1,
          debug_mode: true,
        },
      }],
    });
  });

  it("does not backdate purchases older than 72 hours", () => {
    const order = makeOrder({ date_created: "2020-01-01T00:00:00Z", coupon_code: null });
    const built = buildPurchase(order, settings as any);
    expect(built.timestamp_micros).toBeUndefined();
    expect(built.events[0].params.coupon).toBeUndefined();
  });

  it("builds a refund with the refunded value", () => {
    expect(buildRefund(makeOrder({ metadata: {} }), 10, settings as any)).toEqual({
      client_id: "swell.acc_1",
      user_id: "acc_1",
      events: [{
        name: "refund",
        params: { transaction_id: "100001", value: 10, currency: "USD", session_id: expect.any(Number), engagement_time_msec: 1 },
      }],
    });
  });
});

describe("rules", () => {
  it("sends purchases of paid orders, or submitted ones when set", () => {
    expect(isPurchaseReady(makeOrder(), settings as any)).toBe(true);
    expect(isPurchaseReady(makeOrder({ paid: false }), settings as any)).toBe(false);
    expect(isPurchaseReady(makeOrder({ paid: false }), { send_purchase_on: "submitted" })).toBe(true);
    expect(isPurchaseReady(makeOrder({ canceled: true }), { send_purchase_on: "submitted" })).toBe(false);
    expect(isPurchaseReady(makeOrder({ draft: true }), settings as any)).toBe(false);
    expect(isPurchaseReady(null, settings as any)).toBe(false);
  });

  it("reports the refund total, or the whole order once canceled", () => {
    expect(refundTarget(makeOrder({ refund_total: 10 }), settings as any)).toBe(10);
    expect(refundTarget(makeOrder({ refund_total: 99 }), settings as any)).toBe(52.5);
    expect(refundTarget(makeOrder({ canceled: true, refund_total: 0 }), settings as any)).toBe(52.5);
    expect(refundTarget(makeOrder({ canceled: true, refund_total: 0 }), { refund_canceled: false })).toBe(0);
  });
});

describe("sendPurchase", () => {
  it("sends the purchase once and stores it on the order without events", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();

    expect(await sendPurchase(swell, settings as any, makeOrder())).toEqual({ sent: true });

    expect(sent(fetchMock)[0].body.events[0].name).toBe("purchase");
    expect(savedStatus(swell)).toEqual([{
      path: "/orders/order_1",
      events: false,
      ga4_purchase_sent_at: expect.any(String),
      ga4_client_id: "123456.7890",
      ga4_error: null,
    }]);
  });

  it("skips orders already sent or not ready", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();

    expect(await sendPurchase(swell, settings as any, makeOrder({ $app: { ga4: { ga4_purchase_sent_at: "x" } } })))
      .toEqual({ sent: false, reason: "already sent" });
    expect(await sendPurchase(swell, settings as any, makeOrder({ paid: false }))).toEqual({ sent: false, reason: "not paid" });
    expect(await sendPurchase(swell, { send_purchase_on: "submitted" }, makeOrder({ draft: true })))
      .toEqual({ sent: false, reason: "draft or canceled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores the error and rethrows", async () => {
    mockGa4({ collect: { status: 500 } });
    const swell = mockSwell();

    await expect(sendPurchase(swell, settings as any, makeOrder())).rejects.toMatchObject({ status: 500 });
    expect(savedStatus(swell)[0].ga4_error).toBe("GA4 collect failed (500)");
  });
});

describe("sendRefund", () => {
  const sentOrder = (overrides = {}, app = {}) =>
    makeOrder({ $app: { ga4: { ga4_purchase_sent_at: "2026-10-05T10:00:00Z", ...app } }, ...overrides });

  it("sends what was refunded since the last refund event", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();

    expect(await sendRefund(swell, settings as any, sentOrder({ refund_total: 30 }, { ga4_refund_value: 10 }))).toEqual({ sent: true });

    expect(sent(fetchMock)[0].body.events[0].params.value).toBe(20);
    expect(savedStatus(swell)[0]).toMatchObject({ ga4_refund_value: 30, ga4_error: null, events: false });
  });

  it("reports the rest of a canceled order", async () => {
    const fetchMock = mockGa4();

    await sendRefund(mockSwell(), settings as any, sentOrder({ canceled: true, refund_total: 0 }, { ga4_refund_value: 2.5 }));

    expect(sent(fetchMock)[0].body.events[0].params.value).toBe(50);
  });

  it("skips orders whose purchase was not sent or with nothing new refunded", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();

    expect(await sendRefund(swell, settings as any, makeOrder({ refund_total: 5 }))).toEqual({ sent: false, reason: "purchase not sent" });
    expect(await sendRefund(swell, settings as any, sentOrder({ refund_total: 5 }, { ga4_refund_value: 5 })))
      .toEqual({ sent: false, reason: "nothing new refunded" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores the error and rethrows", async () => {
    mockGa4({ collect: { status: 503 } });
    const swell = mockSwell();

    await expect(sendRefund(swell, settings as any, sentOrder({ refund_total: 5 }))).rejects.toMatchObject({ status: 503 });
    expect(savedStatus(swell)[0].ga4_error).toBe("GA4 collect failed (503)");
  });
});
