// Broadcast live view count over WebSocket.
// Triggered by the DynamoDB Stream on table `resume` (view type: New image).
// When the view-count item changes, push the new `views` value to every
// open WebSocket connection.
//
// Table `resume`: partition key `resumeId` (String).
//   Resume item:     { resumeId, views, ... }                -> the resume data
//
// Table `task2`: partition key `connectionId` (String).
//   Connection item:  { connectionId }                       -> a live viewer
//


import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

const TABLE_NAME = process.env.TABLE_NAME || "task2";

// The WebSocket endpoint to send messages to, e.g. https://ID.execute-api.ap-south-1.amazonaws.com/production
// This is the management/callback endpoint the lambda uses to postToConnection
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT || "https://WSS_APIGW_ID.execute-api.ap-south-1.amazonaws.com/production";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const apigw = new ApiGatewayManagementApiClient({ endpoint: WEBSOCKET_ENDPOINT });

export const handler = async (event) => {
  if (!WEBSOCKET_ENDPOINT) {
    console.error("WEBSOCKET_ENDPOINT not set");
    return;
  }

  // Pull the latest view-count change out of the stream batch.
  let latest = null;
  for (const record of event.Records) {
    if (record.eventName === "REMOVE" || !record.dynamodb?.NewImage) continue;
    const img = unmarshall(record.dynamodb.NewImage);
    if (img.views === undefined || img.resumeId === undefined) continue; // not the counter item
    latest = { resumeId: img.resumeId, views: Number(img.views) };
  }

  if (!latest) return; // nothing relevant in this batch (e.g. only connection inserts)

  const message = JSON.stringify({ type: "views", ...latest });
  const connections = await getConnections();

  await Promise.all(
    connections.map((connectionId) => send(connectionId, message))
  );
};

async function send(connectionId, message) {
  try {
    await apigw.send(
      new PostToConnectionCommand({ ConnectionId: connectionId, Data: message })
    );
  } catch (err) {
    if (err.name === "GoneException" || err.$metadata?.httpStatusCode === 410) {
      // Stale connection — clean it up.
      await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { connectionId } }));
    } else {
      console.error(`postToConnection failed for ${connectionId}`, err);
    }
  }
}

async function getConnections() {
  const ids = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: "connectionId, #v",
        ExpressionAttributeNames: { "#v": "views" },
        ExclusiveStartKey,
      })
    );
    for (const item of res.Items ?? []) {
      if (item.views === undefined) ids.push(item.connectionId); // skip the counter item
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return ids;
}
