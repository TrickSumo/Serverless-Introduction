// Shipment consumer — triggered by EventBridge on "PaymentSucceeded".
// Marks the order SHIPPED and publishes "ShipmentCreated".
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eb = new EventBridgeClient({});

const TABLE = process.env.TABLE_NAME;
const BUS = process.env.BUS_NAME;

exports.handler = async (event) => {
  const { orderId, correlationId } = event.detail;
  console.log(`Creating shipment orderId=${orderId} correlationId=${correlationId}`);

  // Pretend to book a carrier / generate a tracking number.
  const trackingNumber = `TRK-${Date.now()}`;

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { orderId },
      UpdateExpression: "SET #s = :status, trackingNumber = :trk, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":status": "SHIPPED",
        ":trk": trackingNumber,
        ":now": new Date().toISOString(),
      },
    })
  );

  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: BUS,
          Source: "store.orders",
          DetailType: "ShipmentCreated",
          Detail: JSON.stringify({ orderId, correlationId, trackingNumber }),
        },
      ],
    })
  );

  console.log(`ShipmentCreated published orderId=${orderId} tracking=${trackingNumber}`);
};
