# Event-Driven Online Store (AWS CDK)
```
flowchart TD
    Client([Client]) -->|POST /orders| CreateOrder[createOrder]
    CreateOrder --> DDB[(Orders Table)]
    CreateOrder -->|OrderCreated| Bus1{{EventBridge}}

    Bus1 -->|OrderCreated| Inventory[inventory]
    Bus1 -->|OrderCreated| Payment[payment]

    Payment --> Stripe([Stripe])

    %% two parallel ways Stripe reports the payment
    Stripe -->|customer pays · webhook| Webhook[webhook]
    Webhook -->|PaymentSucceeded| Bus2{{EventBridge}}

    Stripe -->|native EventBridge| Partner{{Partner Bus}}
    Partner --> Translator[stripeTranslator]
    Translator -->|PaymentSucceeded| Bus2

    Bus2 -->|PaymentSucceeded| Shipment[shipment]
    Bus2 -->|PaymentSucceeded| Notification[notification]
    Notification --> SNS[(SNS: Email/SMS/Push)]

    Client -.->|GET /orders/id poll| DDB

```

## Architecture

```
Client ──▶ API Gateway ──▶ createOrder ──▶ DynamoDB + publish "OrderCreated"
                                                  │
                                           EventBridge (OrderBus)
     ┌───────────────────────┬────────────────────────────────┐
     ▼ (via SQS + DLQ)        ▼                                 ▼
 inventory Lambda        payment Lambda                   analytics Lambda
 reserve stock,          create Stripe Checkout Session,
 publish                 store checkoutUrl on the order
 "InventoryReserved"           │
                        customer pays ─▶ Stripe ─▶ POST /webhook (signed)
                                                    publish "PaymentSucceeded"
                                                          │
                                                   EventBridge
                            ┌──────────────────────────┼──────────────────┐
                            ▼                          ▼                    ▼
                     shipment Lambda           notification Lambda      analytics
                     mark SHIPPED,             publish to SNS ─▶
                     publish "ShipmentCreated"  Email / SMS / Push
```

**Order lifecycle (status field in DynamoDB):**
`CREATED → INVENTORY_RESERVED` (parallel) / `AWAITING_PAYMENT → PAID(implied) → SHIPPED`

## Project layout

| Path | Purpose |
|------|---------|
| [bin/event-driven.ts](bin/event-driven.ts) | CDK app entry point |
| [lib/event-driven-stack.ts](lib/event-driven-stack.ts) | All infrastructure (table, bus, queue, topic, API, Lambdas, rules) |
| [lambda/createOrder.js](lambda/createOrder.js) | `POST /orders` — store + publish `OrderCreated` |
| [lambda/getOrder.js](lambda/getOrder.js) | `GET /orders/{id}` — frontend polls this for status + checkoutUrl |
| [lambda/inventory.js](lambda/inventory.js) | SQS consumer — reserve stock, publish `InventoryReserved` |
| [lambda/payment.js](lambda/payment.js) | `OrderCreated` consumer — create Stripe Checkout Session |
| [lambda/webhook.js](lambda/webhook.js) | `POST /webhook` — verify Stripe signature, publish `PaymentSucceeded` |
| [lambda/shipment.js](lambda/shipment.js) | `PaymentSucceeded` consumer — mark SHIPPED |
| [lambda/notification.js](lambda/notification.js) | `PaymentSucceeded` consumer — publish to SNS |
| [lambda/analytics.js](lambda/analytics.js) | Multi-event consumer — demonstrates fan-out |
| [lambda/stripeTranslator.js](lambda/stripeTranslator.js) | (Optional) partner-bus consumer — maps Stripe's native event to `PaymentSucceeded` |
| [scripts/smoke-test.ps1](scripts/smoke-test.ps1) | End-to-end test — creates an order, prints the pay link, waits for `SHIPPED` |

## Deploy

### 1. Set Stripe credentials (read from your shell at deploy time)

```bash
export STRIPE_SECRET_KEY=sk_test_...
# STRIPE_WEBHOOK_SECRET is set in step 3, after the webhook exists
```

> `FRONTEND_URL` is **not** set by hand — the payment Lambda derives its Stripe
> success/cancel URLs from the CloudFront distribution domain automatically, so
> the redirect always points back at the deployed site.

> ⚠️ For a real deployment, move these into **AWS Secrets Manager** and read them at
> runtime instead of baking them into the Lambda environment.

### 2. Bootstrap (first time only) and deploy

```bash
npm install
npx cdk bootstrap          # one-time per account/region
npx cdk deploy
```

Note the outputs: `ApiUrl`, `WebhookUrl`, `OrdersTableName`, `EventBusName`, `NotificationTopicArn`.

### 3. Register the Stripe webhook

In the Stripe Dashboard → Developers → Webhooks → Add endpoint:

- **Endpoint URL:** the `WebhookUrl` output (e.g. `https://xxxx.execute-api.<region>.amazonaws.com/prod/webhook`)
- **Event to send:** `checkout.session.completed`

Copy the signing secret (`whsec_...`), then redeploy so the webhook Lambda can verify signatures:

```bash
export STRIPE_WEBHOOK_SECRET=whsec_...
npx cdk deploy
```

### 4. (Optional) Subscribe to notifications

```bash
aws sns subscribe --topic-arn <NotificationTopicArn> --protocol email --notification-endpoint you@example.com
# then confirm the email
```

## Try it

```bash
# Create an order (prices are in cents)
curl -X POST "<ApiUrl>orders" \
  -H "content-type: application/json" \
  -d '{"currency":"usd","customerEmail":"you@example.com","items":[{"name":"T-Shirt","price":2500,"qty":2}]}'
# → { "orderId": "...", "status": "CREATED" }

# Poll until checkoutUrl appears, then open it to pay
curl "<ApiUrl>orders/<orderId>"
```

Pay with Stripe's test card `4242 4242 4242 4242` (any future expiry / CVC). Stripe fires
the webhook → `PaymentSucceeded` → shipment + notification. Poll `GET /orders/{id}` again
and the status becomes `SHIPPED` with a `trackingNumber`.

### Local webhook testing (no public URL needed for the demo)

```bash
stripe listen --forward-to <WebhookUrl>
stripe trigger checkout.session.completed
```

## Event-driven best practices applied

- **Facts, not commands** — `OrderCreated`, `InventoryReserved`, `PaymentSucceeded` (past tense).
- **Idempotent consumers** — inventory uses a DynamoDB conditional update; payment uses a Stripe idempotency key.
- **Correlation IDs** — threaded through every event for tracing.
- **Queue-based load leveling** — SQS + DLQ buffer inventory traffic.
- **Right tool per job** — EventBridge for business routing, SNS for customer broadcast.

## Useful commands

* `npm run build`   compile TypeScript to JS
* `npx cdk synth`   emit the synthesized CloudFormation template
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk deploy`  deploy this stack
* `npx cdk destroy` tear everything down

---

## Stripe → EventBridge (native integration, optional)

There are **two ways** Stripe can tell us a payment succeeded. This project supports
both, and you can run either one or **both at the same time**.

| | **Webhook** (default) | **Native EventBridge** |
|---|---|---|
| Path | Stripe → API Gateway `POST /webhook` → `webhook` Lambda | Stripe → **partner event bus** → `stripeTranslator` Lambda |
| Trust | Verify the `whsec_` **signature** (the endpoint is public) | **IAM + account-scoped** partner channel — *no secret needed* |
| Local testing | Easy (`stripe listen`) | Needs a real AWS account |
| Best for | Portable pattern, teaching signature verification | AWS-native, fewer moving parts, no secret to rotate |

Both paths converge on the **same internal event** — `PaymentSucceeded` on `OrderBus` —
so the `shipment`, `notification`, and `analytics` consumers work unchanged regardless
of which path delivered the payment. That is the point of the translator: **keep our own
event vocabulary independent of any vendor's payload.**

```
                         Stripe payment succeeded
                          │                     │
       (webhook)          │                     │        (native EventBridge)
 API GW POST /webhook ────┤                     ├──── partner event bus
      webhook Lambda      │                     │       stripeTranslator Lambda
      verify whsec        │                     │       (no signature needed)
                          ▼                     ▼
                    PaymentSucceeded  ──▶  OrderBus  ──▶  shipment · notification · analytics
```

### Enable the native path

1. **Create the destination in Stripe** — Dashboard → *Event destinations* → **Amazon EventBridge**.
   Enter your **AWS account ID** and the **region you deploy to** (these can't be changed later),
   and listen to `checkout.session.completed`.

2. **Associate the partner source in AWS** — EventBridge console → *Partner event sources* →
   select the `aws.partner/stripe.com/ed_...` source → **Associate with event bus**. This creates
   a partner event bus of the same name in your account. (Do this within 7 days.)

3. **Deploy with the partner bus name** — the integration is toggled by the
   `STRIPE_PARTNER_BUS` environment variable. Set it and the translator Lambda + rule are
   created; leave it unset and the stack is **webhook-only**:

   ```bash
   export STRIPE_PARTNER_BUS=aws.partner/stripe.com/ed_test_xxxxxxxxxxxxxxxx
   npx cdk deploy
   ```

   ```powershell
   # PowerShell
   $env:STRIPE_PARTNER_BUS = "aws.partner/stripe.com/ed_test_xxxxxxxxxxxxxxxx"
   npx cdk deploy
   ```

> **Why no signing secret?** The webhook endpoint is a public URL, so the `whsec_`
> signature is the only proof an event really came from Stripe. The partner integration
> isn't a public endpoint — the event source is bound to **your AWS account ID**, and only
> you (via IAM) can associate it and attach rules. AWS establishes authenticity, so there
> is nothing to verify in code.

> ⚠️ **Running both paths** means every payment is delivered **twice** → `PaymentSucceeded`
> fires twice → `shipment` and `notification` run twice (double shipment / double email).
> That is fine for a demo. For production, make those consumers **idempotent** (e.g. a
> conditional "ship only if not already shipped" write, or dedupe on the Stripe event id).
