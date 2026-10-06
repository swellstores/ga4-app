import { vi } from "vitest";

export const settings = {
  measurement_id: "G-TEST1234",
  api_secret: "secret_1",
  enabled: true,
  region: "global",
  send_purchase_on: "paid",
  send_refunds: true,
  refund_canceled: true,
  send_sign_up: true,
  send_user_id: true,
  debug_mode: false,
};

// Mocks fetch for the Measurement Protocol: collect answers 204 (or `collect`),
// the validation server answers `validationMessages`.
export function mockGa4({ collect = { status: 204 } as { status: number; body?: string }, validationMessages = [] as unknown[] } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname === "/debug/mp/collect") {
      return Response.json({ validationMessages });
    }
    return new Response(collect.body ?? null, { status: collect.status });
  });
}

// Requests sent to GA4: host, path, query and parsed body
export function sent(fetchMock: ReturnType<typeof mockGa4>) {
  return fetchMock.mock.calls.map(([input, init]: any[]) => {
    const url = new URL(String(input));
    return {
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: JSON.parse(init.body),
    };
  });
}

// Swell client mock: `get` resolves by path (first arg), put resolves to {}
export function mockSwell(getByPath: Record<string, any | ((query: any) => any)> = {}, ga4: any = settings) {
  return {
    get: vi.fn(async (path: string, query?: any) => {
      const value = getByPath[path];
      return typeof value === "function" ? value(query) : value;
    }),
    put: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    settings: vi.fn(async () => ({ ga4 })),
  } as any;
}

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: "order_1",
    number: "100001",
    account_id: "acc_1",
    date_created: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    currency: "USD",
    paid: true,
    grand_total: 52.5,
    tax_total: 3.5,
    shipment_total: 5,
    refund_total: 0,
    coupon_code: "WELCOME10",
    metadata: { ga_client_id: "123456.7890", ga_session_id: "1727000000" },
    items: [
      { product_id: "p1", product: { name: "Ethiopia Natural", sku: "ETH" }, variant: { name: "250g", sku: "ETH-250" }, price: 20, discount_each: 2, quantity: 2 },
      { product_id: "p2", product: { name: "Mug" }, price: 12.4, quantity: 1 },
    ],
    ...overrides,
  };
}

// $app.ga4 values written to the order
export function savedStatus(swell: any) {
  return swell.put.mock.calls.map(([path, body]: any[]) => ({ path, events: body.$events, ...body.$app.ga4 }));
}
