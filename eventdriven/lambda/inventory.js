// Inventory consumer — fed by SQS (queue-based load leveling).
// EventBridge delivers "OrderCreated" to the InventoryQueue; each SQS record's
// body is the full EventBridge event. We "reserve" stock, then publish
// "InventoryReserved".
//
// Idempotency: DynamoDB conditional update ensures reserving twice is a no-op.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eb = new EventBridgeClient({});

const TABLE = process.env.TABLE_NAME;
const BUS = process.env.BUS_NAME;

exports.handler = async (sqsEvent) => {
  for (const record of sqsEvent.Records) {
    const envelope = JSON.parse(record.body); // EventBridge event
    const detail = envelope.detail;
    const { orderId, correlationId } = detail;

    console.log(`Reserving inventory orderId=${orderId} correlationId=${correlationId}`);

    // Pretend to check/decrement stock here. In a real system this would hit
    // an inventory table and could publish "InventoryOutOfStock" instead.
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { orderId },
          UpdateExpression: "SET #s = :reserved, updatedAt = :now",
          // Only move forward from CREATED — makes redelivery idempotent.
          ConditionExpression: "#s = :created",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":reserved": "INVENTORY_RESERVED",
            ":created": "CREATED",
            ":now": new Date().toISOString(),
          },
        })
      );
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        console.log(`Inventory already reserved (or order gone) orderId=${orderId} — skipping`);
        continue;
      }
      throw err; // let it retry / hit the DLQ
    }

    await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: BUS,
            Source: "store.orders",
            DetailType: "InventoryReserved",
            Detail: JSON.stringify({ orderId, correlationId }),
          },
        ],
      })
    );
    console.log(`InventoryReserved published orderId=${orderId}`);
  }
};
