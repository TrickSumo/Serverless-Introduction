// GET /orders/{id}
// The frontend polls this endpoint to watch the order status change and to
// pick up the Stripe checkoutUrl once the payment Lambda has created it.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;

exports.handler = async (event) => {
  const orderId = event.pathParameters && event.pathParameters.id;
  if (!orderId) {
    return respond(400, { error: "orderId is required" });
  }

  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { orderId } }));
  if (!Item) {
    return respond(404, { error: "Order not found" });
  }

  return respond(200, Item);
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}
