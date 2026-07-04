// POST /webhook  (Stripe → API Gateway → this Lambda)
// Verifies the Stripe signature, and on "checkout.session.completed" publishes
// a "PaymentSucceeded" business event onto EventBridge.
const Stripe = require("stripe");
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const eb = new EventBridgeClient({});

const BUS = process.env.BUS_NAME;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

exports.handler = async (event) => {
  const signature = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  // Stripe signature verification needs the exact raw body bytes.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;
    const orderId = session.metadata && session.metadata.orderId;
    // Recover the correlationId we stashed in the Checkout Session metadata, so
    // it survives the external Stripe hop and continues down the chain.
    const correlationId = session.metadata && session.metadata.correlationId;

    console.log(
      `PaymentSucceeded incoming orderId=${orderId} correlationId=${correlationId} sessionId=${session.id}`
    );

    await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: BUS,
            Source: "store.orders",
            DetailType: "PaymentSucceeded",
            Detail: JSON.stringify({
              orderId,
              correlationId,
              stripeSessionId: session.id,
              amount: session.amount_total,
              currency: session.currency,
            }),
          },
        ],
      })
    );
    console.log(`PaymentSucceeded published orderId=${orderId} correlationId=${correlationId}`);
  } else {
    console.log(`Ignoring Stripe event type=${stripeEvent.type}`);
  }

  // Always 200 so Stripe stops retrying once we've accepted the event.
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
