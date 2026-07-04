// POST /orders
// Creates an order, stores it, and publishes an "OrderCreated" event.
// Returns the orderId immediately — the rest of the flow happens asynchronously.
const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eb = new EventBridgeClient({});

const TABLE = process.env.TABLE_NAME;
const BUS = process.env.BUS_NAME;

exports.handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "Invalid JSON body" });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    return respond(400, { error: "items[] is required" });
  }

  const orderId = randomUUID();
  const correlationId = randomUUID();
  const currency = (body.currency || "usd").toLowerCase();
  // amount is in the smallest currency unit (cents) — sum of price * qty
  const amount = items.reduce((sum, i) => sum + Number(i.price) * Number(i.qty || 1), 0);
  const now = new Date().toISOString();

  const order = {
    orderId,
    correlationId,
    status: "CREATED",
    items,
    amount,
    currency,
    customerEmail: body.customerEmail || null,
    checkoutUrl: null,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: order }));

  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: BUS,
          Source: "store.orders",
          DetailType: "OrderCreated",
          Detail: JSON.stringify({ orderId, correlationId, items, amount, currency, customerEmail: order.customerEmail }),
        },
      ],
    })
  );

  console.log(`OrderCreated published orderId=${orderId} correlationId=${correlationId}`);
  return respond(201, { orderId, status: "CREATED" });
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}
