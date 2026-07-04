// Notification consumer — triggered by EventBridge on "PaymentSucceeded".
// Broadcasts a message to SNS, which fans out to Email / SMS / Push
// subscribers. This is the "EventBridge for business events, SNS for
// notifications" split from the plan.
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

const sns = new SNSClient({});
const TOPIC_ARN = process.env.NOTIFICATION_TOPIC_ARN;

exports.handler = async (event) => {
  const { orderId, correlationId } = event.detail;
  console.log(`Notifying customer orderId=${orderId} correlationId=${correlationId}`);

  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: "Your order is confirmed",
      Message: `Payment received for order ${orderId}. Your order is being prepared for shipment.`,
      MessageAttributes: {
        eventType: { DataType: "String", StringValue: "PaymentSucceeded" },
        orderId: { DataType: "String", StringValue: String(orderId) },
      },
    })
  );

  console.log(`Notification published to SNS orderId=${orderId}`);
};
