import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME || "resume";
const RESUME_ID = "resume123";

export const handler = async () => {

  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { resumeId: RESUME_ID },
    UpdateExpression: "ADD #views :inc",
    ExpressionAttributeNames: { "#views": "views" },
    ExpressionAttributeValues: { ":inc": 1 },
  }));

  const { Item } = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { resumeId: RESUME_ID },
  }));

  return {
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ views: Item?.views ?? 0 }),
  };
};
