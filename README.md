# Google Analytics 4 integration

A Swell app that sends purchases, refunds and sign-ups to [Google Analytics 4](https://marketingplatform.google.com/about/analytics/)
from the server with the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4).
Server events are recorded even when ad blockers, consent tools or a closed tab stop browser tracking, and they can
be joined to the shopper's browser session.

## Features

Events are posted to `https://www.google-analytics.com/mp/collect` (or `https://region1.google-analytics.com/mp/collect`
for the EU endpoint) with the Measurement ID and API secret. Amounts are sent in the order currency, rounded to cents.

### Events

| Swell event                                         | GA4 event  | Function                      |
| --------------------------------------------------- | ---------- | ----------------------------- |
| `order.paid` (or `order.submitted`, see settings)   | `purchase` | `functions/order-events.ts`   |
| `payment.refund.succeeded` (every refund)           | `refund`   | `functions/refund-events.ts`  |
| `order.canceled`                                    | `refund`   | `functions/order-events.ts`   |
| `account.created`                                   | `sign_up`  | `functions/account-events.ts` |

Events are sent only when **Enable Integration** is on and a valid Measurement ID (`G-…`) and API secret are set.

**purchase** – sent once per order, when the order is paid (default) or submitted, unless it is a draft or canceled:

| Param            | Value                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `transaction_id` | Order number                                                           |
| `value`          | Order grand total                                                      |
| `currency`       | Order currency                                                         |
| `tax`            | Tax total                                                              |
| `shipping`       | Shipping total                                                         |
| `coupon`         | Coupon code, if any                                                    |
| `items`          | Up to 200 items: `item_id` (variant SKU, product SKU or product ID), `item_name`, `item_variant`, `price` (unit price after item discounts), `quantity`, `index` |

The event is dated with the order creation time when it is less than 72 hours old (`timestamp_micros`), which is
as far back as GA4 accepts.

**refund** – sent once for every successful Swell refund (`payment.refund.succeeded`), so an order refunded several
times sends several refund events, each with that refund's amount, the order number and currency. 
Refunds of payments without an order (e.g. subscription invoices) are skipped.

- **Each refund once** – reported refunds are kept on the order by Swell refund ID (`ga4_refunds`), so retries and
  repeated events never send a refund twice, and refunds processed at the same time don't overwrite each other.
- **Never more than the order** – a refund is capped at the part of the order total not reported yet.
- **Canceled orders** – with **Refund canceled orders** on, `order.canceled` reports the rest of the order total as
  one more refund (key `canceled`). Later refunds of that order are capped, so the order is never refunded twice.
- Refunds are sent only for orders whose purchase was sent, and without items, which GA4 treats as a refund of the
  given value. `ga4_refund_value` on the order shows the total reported.

**sign_up** – sent with `method: email` when a customer account is created, including accounts created at checkout.

### Visitor and session

GA4 links events through `client_id`. To join server events to the shopper's browser session, traffic source and
campaign, the storefront saves the GA4 client and session IDs in the cart metadata, which Swell copies to the order:

```js
// storefront, after gtag.js is loaded and the cart exists
const MEASUREMENT_ID = 'G-XXXXXXXXXX';
gtag('get', MEASUREMENT_ID, 'client_id', (clientId) => {
  gtag('get', MEASUREMENT_ID, 'session_id', (sessionId) => {
    swell.cart.update({ metadata: { ga_client_id: clientId, ga_session_id: sessionId } });
  });
});
```

For sign-ups, save the same values in the account metadata (`swell.account.update({ metadata: { … } })`).

| Request field | Value                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| `client_id`   | `metadata.ga_client_id`, or `swell.<customer ID>` (`swell.<order ID>` for guest orders) |
| `user_id`     | Swell customer ID, when **Send user ID** is on                                            |
| `session_id`  | `metadata.ga_session_id`, or the event time in seconds when the storefront saved none. Sent as an event param with `engagement_time_msec: 1`; GA4 shows Measurement Protocol events in Realtime and DebugView only with both |
| `debug_mode`  | `true` when **Debug mode** is on, so events show in **Admin → DebugView**                |

Without the storefront snippet, each event starts its own server-side session: events still count in reports and show
in Realtime and DebugView, but they are attributed to `(direct)` / `(not set)` traffic.

### Dashboard

- **Google Analytics tab** on orders: when the purchase was sent, the client ID used, the refunded total reported,
  the last refund time and the last error. The order list has a **GA4** column with the purchase time.
- **Send purchase to GA4** in an order's Actions menu, and **Send to GA4** as a bulk action on up to 25 selected
  orders, send purchases that were missed (for example before the app was set up). Orders older than 72 hours,
  already sent, or not paid are skipped and listed in the result.
- **Validate setup** in the app's Actions menu sends a sample purchase to the
  [validation server](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events)
  and shows its messages. Nothing is recorded in GA4.

## Settings

Configured in the app settings (`settings/ga4.json`), under **Apps → Google Analytics 4 → Settings**. Credentials are
never stored in code.

| Setting            | Type   | Required | Default  | Description                                                                 |
| ------------------ | ------ | -------- | -------- | --------------------------------------------------------------------------- |
| `measurement_id`   | text   | yes      |          | Measurement ID of the GA4 web stream, `G-XXXXXXXXXX`.                        |
| `api_secret`       | secret | yes      |          | Measurement Protocol API secret of the same stream. Masked in the dashboard, with Reveal and Copy buttons. |
| `enabled`          | toggle | no       | off      | Sends events and allows the Send to GA4 actions.                            |
| `send_purchase_on` | select | no       | `paid`   | Send `purchase` when the order is `paid` or `submitted`.                    |
| `send_refunds`     | toggle | no       | on       | Send a `refund` for every successful refund, full or partial.              |
| `refund_canceled`  | toggle | no       | on       | Report the rest of a canceled order as refunded.                            |
| `send_sign_up`     | toggle | no       | on       | Send `sign_up` when an account is created.                                  |
| `region`           | select | no       | `global` | `global` or `eu` (`region1.google-analytics.com`) collection endpoint.     |
| `send_user_id`     | toggle | no       | on       | Send the Swell customer ID as `user_id`.                                    |
| `debug_mode`       | toggle | no       | off      | Add `debug_mode` to events to see them in DebugView.                        |

## Setup

1. In GA4 open **Admin → Data streams**, select your web stream, copy the **Measurement ID**, and under
   **Measurement Protocol API secrets** create a secret.
2. Install the Swell CLI and log in:

   ```bash
   npm install -g @swell/cli
   swell login
   ```

3. Install dependencies and push the app to your store's test environment:

   ```bash
   cd /path/to/ga4-integration
   npm install
   swell app push
   ```

4. In the Swell dashboard open **Apps → Google Analytics 4 → Settings**, enter the Measurement ID and API secret,
   save, and run **Actions → Validate setup**.
5. Turn on **Debug mode** and **Enable Integration**, place a test order, and check **Admin → DebugView** in GA4.
   Turn Debug mode off when done.
6. Add the storefront snippet above so server events join the shopper's session.
7. If the storefront also sends `purchase` with gtag.js, stop it, or GA4 may count purchases twice.
8. To install in the live environment, create a version and install it:

   ```bash
   swell app version minor
   swell app install
   ```

## Limits and known behavior

- **No error reporting from GA4** – the collect endpoint accepts any well-formed request with a 2xx response, so
  invalid events are dropped silently. Use **Validate setup** and DebugView to check events. The validation server
  does not check the API secret.
- **72 hours** – GA4 accepts events dated up to 72 hours back, so there is no import of older orders. Purchases sent
  later are recorded at the time they are sent.
- **Duplicate purchases** if the storefront also sends `purchase` with gtag.js. GA4 deduplicates purchases with the
  same `transaction_id` only in some cases.
- **Attribution needs the storefront snippet** – without `ga_client_id` and `ga_session_id`, server events start
  their own sessions, are attributed to `(direct)` / `(not set)` traffic and are not joined to the shopper's
  browser session.
- **Reports lag** – Realtime and DebugView show events within a minute; standard reports (Monetization,
  Explore) take 24–48 hours.
- **Consent** – the app does not send consent signals (`consent.ad_user_data`, `ad_personalization`). If your site
  uses Consent Mode, make sure server-side collection matches your consent policy before enabling the app.
- **Refunds without items** – refunds report a value, not which items were returned.
- **No retries for setting errors** – events that fail with a 4xx (for example a wrong Measurement ID) are logged
  and dropped. Server errors are retried by Swell.

## Development

### Project layout

```
functions/
  order-events.ts     # order.paid / submitted → purchase; order.canceled → refund of the rest
  refund-events.ts    # payment.refund.succeeded → one refund per Swell refund
  account-events.ts   # account.created → sign_up
  send-to-ga4.ts      # dashboard action: send purchases of selected recent orders
  validate-event.ts   # settings action: validate a sample purchase
  lib/
    ga4.ts            # Measurement Protocol client, identity, limits, helpers
    orders.ts         # purchase and refund builders, send-once bookkeeping
models/orders.json    # GA4 status fields on orders
content/orders.json   # Google Analytics tab, list column and actions
settings/ga4.json
assets/icon.png       # app icon (Google Analytics mark)
assets/image.png      # social card (1200×630)
assets/images/        # App Store listing images, listed in swell.json "images"
test/unit/            # vitest unit tests (GA4 endpoints mocked)
test/integration/     # vitest tests against the store using CLI auth
```

### Commands

```bash
npm run typecheck   # TypeScript check for functions and tests
npm test            # run all vitest tests
swell app dev       # run functions locally, triggered by the test environment
swell app push      # deploy to the test environment
swell logs -f --app ga4           # follow function logs
swell inspect functions --app=.   # check deployed functions and failures
```

Tests run in the Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers` and use your `swell login` session
(or `SWELL_STORE_ID` / `SWELL_SESSION_ID` in CI). Unit tests mock `fetch`, so no events reach GA4.

## Contributing

Contributions are welcome! Visit the [Swell Discord](https://discord.gg/VakSbyjDGZ) or [GitHub discussions](https://github.com/orgs/swellstores/discussions/) to get help and share ideas.

## License

This project is licensed under the MIT License - see [LICENSE](LICENSE) file for details.
