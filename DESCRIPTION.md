Send your store's purchases, refunds and sign-ups to Google Analytics 4 from the server. Events go to GA4 with the Measurement Protocol, so they're recorded even when an ad blocker or a closed tab stops browser tracking, and your GA4 revenue matches what you sold.

Connect your GA4 web stream with its Measurement ID and a Measurement Protocol API secret, choose the events to send and turn on the integration. From then on, each order, refund and new customer account is sent to GA4 as it happens.

- **Purchases with full detail.** Each order is sent once, when it's paid or when it's submitted, with the order number as the transaction ID, the total, tax, shipping and coupon, and the items with their SKU, name, variant, price and quantity.
- **Refunds that match your revenue.** Every full or partial refund is sent with its amount, and canceled orders can be reported as refunded. Refunds never add up to more than the order total.
- **Sign-ups.** A sign_up event is sent when a customer creates an account, including at checkout.
- **Joined to the shopper's session.** If your storefront saves the shopper's GA4 client and session IDs on the cart, server events count toward the same visitor, session and traffic source as their browser events. The Swell customer ID can be sent as the user ID.
- **Counted once.** The order records when its purchase and refunds were sent, so a retried or repeated event never counts twice. Orders from the last 72 hours that were missed, for example before setup, can be sent from the order page or the order list.
- **Check your setup.** Test connection sends a sample purchase to GA4's validation server, and debug mode shows events in GA4's DebugView.

Setup takes a few minutes. In GA4, open Admin → Data streams → your web stream, copy the Measurement ID and create a Measurement Protocol API secret. Paste both in the app settings, run Test connection and turn on Enable Integration. Then place a test order with Debug mode on and watch the purchase arrive in DebugView. If your storefront already sends purchases with gtag.js, turn that off so GA4 doesn't count them twice.
