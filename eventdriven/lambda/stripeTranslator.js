// Translator: Stripe (native EventBridge partner) → our domain event.
//
// Stripe delivers "checkout.session.completed" onto the PARTNER event bus with
// its own shape (source = aws.partner/stripe.com/..., detail = the Stripe Event
// object). We translate it into our internal "PaymentSucceeded" on OrderBus, so
// the same shipment / notification / analytics consumers run regardless of
// whether the payment arrived via the webhook Lambda OR native EventBridge.
//
// This keeps our internal event vocabulary independent of any vendor's payload.
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");

const eb = new EventBridgeClient({});
const BUS = process.env.BUS_NAME;

exports.handler = async (event) => {
  const stripeEvent = event.detail;        // the Stripe Event object
  const session = stripeEvent.data.object; // the Checkout Session
  const orderId = session.metadata && session.metadata.orderId;
  const correlationId = session.metadata && session.metadata.correlationId;

  console.log(
    `[stripe→eventbridge] ${stripeEvent.type} orderId=${orderId} correlationId=${correlationId}`
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
            via: "eventbridge", // which path delivered it (vs "webhook")
          }),
        },
      ],
    })
  );

  console.log(`PaymentSucceeded published (via EventBridge) orderId=${orderId}`);
};
