# Task2 Hint — Live View Count over WebSocket

Show a resume's view count and update it **live** in every open tab whenever
the count changes.

## Architecture

```
Browser (s3/index.html)
   │  wss://{apiId}.execute-api.{region}.amazonaws.com/{stage}
   ▼
WebSocket API Gateway
   ├── $connect    ──▶ connect lambda    ──▶ PutItem   task2 { connectionId }
   └── $disconnect ──▶ connect lambda    ──▶ DeleteItem task2 { connectionId }

resume table (views incremented elsewhere)
   │  DynamoDB Stream (NEW_IMAGE)
   ▼
broadcast views lambda
   ├── Scan task2 for connectionIds
   └── postToConnection ──▶ every browser  { type:"views", resumeId, views }
```

Two DynamoDB tables:

| Table    | PK             | Holds                                  |
|----------|----------------|----------------------------------------|
| `resume` | `resumeId`     | resume item incl. `views` (stream src) |
| `task2`  | `connectionId` | one item per live WebSocket connection |

## 1. Create the `task2` connections table

- Partition key: `connectionId` (String). No sort key.

## 2. Enable a stream on the `resume` table

- DynamoDB → `resume` table → Exports and streams → enable **DynamoDB stream**
  with view type **New image**.

## 3. Create the WebSocket API (API Gateway)

- Routes: `$connect`, `$disconnect` → integrate both with the **connect** lambda
  (it branches on `event.requestContext.routeKey`).
- Deploy to a stage (e.g. `production`). Note the two URLs:
  - WebSocket URL  `wss://{apiId}.execute-api.{region}.amazonaws.com/{stage}`  → frontend
  - @connections   `https://{apiId}.execute-api.{region}.amazonaws.com/{stage}` → broadcast lambda

## 4. connect lambda (`lambda/connect`)

Stores / removes the connection id in `task2`.

- Env: `TABLE_NAME=task2`
- IAM: basic logs + `dynamodb:PutItem`, `dynamodb:DeleteItem` on `task2`.

## 5. broadcast views lambda (`lambda/broadcast views`)

Triggered by the `resume` stream; pushes the new `views` to all connections.

- Trigger: DynamoDB stream of the **`resume`** table.
- Env:
  - `TABLE_NAME=task2` (the table it scans for connections)
  - `WEBSOCKET_ENDPOINT=https://{apiId}.execute-api.{region}.amazonaws.com/{stage}`
    (the `@connections` base **without** the `/@connections` suffix — the SDK adds it)
- IAM:
  - `AWSLambdaDynamoDBExecutionRole` (logs + stream read) — or scope the stream
    actions to `arn:.../table/resume/stream/*`
  - `dynamodb:Scan`, `dynamodb:DeleteItem` on `task2`
  - `execute-api:ManageConnections` on `arn:aws:execute-api:{region}:{acct}:{apiId}/{stage}/POST/@connections/*`

Stale connections (HTTP 410 `GoneException` on postToConnection) are deleted
from `task2` automatically.

## 6. Frontend (`s3/index.html`)

- Set `WS_URL` to the `wss://` WebSocket URL from step 3.
- On load it fetches `/api/views` for the initial value, then opens the
  WebSocket and updates the count on each `{ type:"views" }` message.
- Auto-reconnects with backoff (API Gateway drops idle WS connections after
  ~10 min).

## Flow

page load → initial count via `/api/views` → WS `$connect` stores connectionId
→ view increment writes `views` on the `resume` item → stream fires → broadcast
lambda fans out the new value → every open tab updates in place.
