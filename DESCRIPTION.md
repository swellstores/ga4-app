# Google Analytics 4

Send purchases, refunds and sign-ups from Swell to Google Analytics 4 with the Measurement Protocol, so they are recorded on the server even when ad blockers, consent tools or closed tabs stop browser tracking.

## How it works

1. **Sends events from the server.**

   | Store event                                   | GA4 event   |
   | --------------------------------------------- | ----------- |
   | `order.paid` (or `order.submitted`)           | `purchase`  |
   | each successful refund, `order.canceled`      | `refund`    |
   | `account.created`                             | `sign_up`   |

   Purchases include the order number as `transaction_id`, total, currency, tax, shipping, coupon and items (SKU, name, variant, discounted price, quantity). Each refund of an order is sent once with its own amount, so an order can be refunded several times, and canceled orders can be reported as fully refunded. Refunds never exceed the order total.

2. **Joins the shopper's session.** When the storefront saves the GA4 client and session IDs in the cart metadata, server events are attributed to the same visitor, session and traffic source as their browser events. Otherwise each customer gets a stable ID, and the Swell customer ID is sent as `user_id`.

3. **Sends each event once.** The app records on the order when its purchase and refunds were sent, so retries and repeated events never count an order twice. Orders missed in the last 72 hours can be sent from the order page or list.

## Setup

In GA4 open **Admin → Data streams → your web stream**, copy the Measurement ID and create a Measurement Protocol API secret. Enter both in the app settings, run **Validate setup**, and turn on Enable Integration.
