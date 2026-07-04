// Payment consumer — triggered directly by EventBridge on "OrderCreated"
// (parallel fan-out, alongside Inventory & Analytics).
// Creates a real Stripe Checkout Session and stores the checkoutUrl on the
// order so the frontend (polling GET /orders/{id}) can redirect the customer.
const Stripe = require("stripe");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const TABLE = process.env.TABLE_NAME;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

exports.handler = async (event) => {
  const detail = event.detail; // direct EventBridge target → event.detail
  const { orderId, items, currency, correlationId } = detail;

  console.log(`Creating Stripe session orderId=${orderId} correlationId=${correlationId}`);

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: items.map((i) => ({
        price_data: {
          currency: currency || "usd",
          product_data: { name: i.name || "Item" },
          unit_amount: Number(i.price), // cents
        },
        quantity: Number(i.qty || 1),
      })),
      // Redirect back to the SPA, which polls the order until it ships.
      success_url: `${FRONTEND_URL}/?orderId=${orderId}&paid=1`,
      cancel_url: `${FRONTEND_URL}/?orderId=${orderId}&canceled=1`,
      // Carry the correlationId across the external Stripe hop so the webhook
      // can put it back on the PaymentSucceeded event.
      metadata: { orderId, correlationId },
    },
    // Idempotency key: Stripe won't create a duplicate session if this event is
    // redelivered.
    { idempotencyKey: `checkout-${orderId}` }
  );

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { orderId },
      UpdateExpression:
        "SET checkoutUrl = :url, stripeSessionId = :sid, #s = :status, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":url": session.url,
        ":sid": session.id,
        ":status": "AWAITING_PAYMENT",
        ":now": new Date().toISOString(),
      },
    })
  );

  console.log(`Checkout session created orderId=${orderId} sessionId=${session.id}`);
};
