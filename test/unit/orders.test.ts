import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildItems,
  buildPurchase,
  buildRefund,
  isPurchaseReady,
  reportedRefunds,
  reportedTotal,
  sendCancelRefund,
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
        params: {
          transaction_id: "100001",
          value: 10,
          currency: "USD",
          order_id: "order_1",
          order_number: "100001",
          session_id: expect.any(Number),
          engagement_time_msec: 1,
        },
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

  it("reads refunds reported by ID, and the total of orders sent before refunds were tracked by ID", () => {
    expect(reportedRefunds(makeOrder())).toEqual({});
    expect(reportedRefunds(makeOrder({ $app: { ga4: { ga4_refunds: { r1: 5, r2: 2.5 } } } }))).toEqual({ r1: 5, r2: 2.5 });
    expect(reportedTotal(makeOrder({ $app: { ga4: { ga4_refunds: { r1: 5, r2: 2.5 } } } }))).toBe(7.5);
    expect(reportedRefunds(makeOrder({ $app: { ga4: { ga4_refund_value: 2 } } }))).toEqual({ previous: 2 });
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

describe("refunds", () => {
  const sentOrder = (overrides = {}, app = {}) =>
    makeOrder({ $app: { ga4: { ga4_purchase_sent_at: "2026-10-05T10:00:00Z", ...app } }, ...overrides });

  it("sends each Swell refund with its own amount and remembers it by ID", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();

    expect(await sendRefund(swell, settings as any, sentOrder(), { id: "r1", amount: 12.5 })).toEqual({ sent: true });

    expect(sent(fetchMock)[0].body.events[0]).toMatchObject({
      name: "refund",
      params: { transaction_id: "r1", value: 12.5, order_id: "order_1", order_number: "100001" },
    });
    expect(savedStatus(swell)[0]).toEqual({
      path: "/orders/order_1",
      events: false,
      ga4_refunds: { r1: 12.5 },
      ga4_refund_value: 12.5,
      ga4_refund_sent_at: expect.any(String),
      ga4_error: null,
    });
  });

  it("sends several refunds of the same order, each once", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();
    const order = sentOrder({}, { ga4_refunds: { r1: 10 } });

    expect(await sendRefund(swell, settings as any, order, { id: "r2", amount: 15 })).toEqual({ sent: true });
    expect(await sendRefund(swell, settings as any, order, { id: "r1", amount: 10 })).toEqual({ sent: false, reason: "already sent" });

    expect(sent(fetchMock)).toHaveLength(1);
    expect(sent(fetchMock)[0].body.events[0].params.value).toBe(15);
    expect(savedStatus(swell)[0]).toMatchObject({ ga4_refunds: { r2: 15 }, ga4_refund_value: 25 });
  });

  it("caps refunds at the part of the order not reported yet", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();

    await sendRefund(swell, settings as any, sentOrder({}, { ga4_refunds: { r1: 50 } }), { id: "r2", amount: 10 });
    expect(sent(fetchMock)[0].body.events[0].params.value).toBe(2.5);

    expect(await sendRefund(swell, settings as any, sentOrder({}, { ga4_refunds: { canceled: 52.5 } }), { id: "r3", amount: 10 }))
      .toEqual({ sent: false, reason: "nothing left to refund" });
  });

  it("keeps the total of orders refunded before refunds were tracked by ID", async () => {
    mockGa4();
    const swell = mockSwell();

    await sendRefund(swell, settings as any, sentOrder({}, { ga4_refund_value: 2 }), { id: "r2", amount: 3 });

    expect(savedStatus(swell)[0]).toMatchObject({ ga4_refunds: { previous: 2, r2: 3 }, ga4_refund_value: 5 });
  });

  it("reports the rest of a canceled order once, when turned on", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();

    expect(await sendCancelRefund(swell, settings as any, sentOrder({ canceled: true }, { ga4_refunds: { r1: 2.5 } }))).toEqual({ sent: true });
    expect(sent(fetchMock)[0].body.events[0].params).toMatchObject({ transaction_id: "100001", value: 50, order_id: "order_1", order_number: "100001" });
    expect(savedStatus(swell)[0]).toMatchObject({ ga4_refunds: { canceled: 50 }, ga4_refund_value: 52.5 });

    expect(await sendCancelRefund(swell, settings as any, sentOrder({ canceled: true }, { ga4_refunds: { canceled: 50 } })))
      .toEqual({ sent: false, reason: "already sent" });
    expect(await sendCancelRefund(swell, { refund_canceled: false }, sentOrder({ canceled: true })))
      .toEqual({ sent: false, reason: "refunds of canceled orders are off" });
  });

  it("skips orders whose purchase was not sent and ignores empty amounts", async () => {
    const fetchMock = mockGa4();
    const swell = mockSwell();

    expect(await sendRefund(swell, settings as any, makeOrder(), { id: "r1", amount: 5 })).toEqual({ sent: false, reason: "purchase not sent" });
    expect(await sendRefund(swell, settings as any, sentOrder(), { id: "r1", amount: null })).toEqual({ sent: false, reason: "nothing left to refund" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores the error and rethrows", async () => {
    mockGa4({ collect: { status: 503 } });
    const swell = mockSwell();

    await expect(sendRefund(swell, settings as any, sentOrder(), { id: "r1", amount: 5 })).rejects.toMatchObject({ status: 503 });
    expect(savedStatus(swell)[0].ga4_error).toBe("GA4 collect failed (503)");
  });
});
