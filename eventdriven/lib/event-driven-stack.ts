import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

/**
 * Event-driven online store (choreography, parallel fan-out).
 *
 *   Client ──▶ API Gateway ──▶ createOrder ──▶ [DynamoDB] + publish "OrderCreated"
 *                                                     │
 *                                              EventBridge (OrderBus)
 *        ┌──────────────────────────┬───────────────────────────────┐
 *        ▼ (via SQS)                ▼                                 ▼
 *   inventory Lambda          payment Lambda                   analytics Lambda
 *   (reserve stock,           (create Stripe Checkout
 *    publish                   Session, store checkoutUrl)
 *    "InventoryReserved")            │
 *                          customer pays ──▶ Stripe ──▶ webhook Lambda
 *                                                        publish "PaymentSucceeded"
 *                                                              │
 *                                                        EventBridge
 *                                   ┌──────────────────────────┼───────────────┐
 *                                   ▼                          ▼                ▼
 *                            shipment Lambda           notification Lambda   analytics
 *                            (publish                  (publish to SNS ──▶
 *                             "ShipmentCreated")        Email / SMS / Push)
 */
export class EventDrivenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // 1. Single source of truth: the Orders table
    // ---------------------------------------------------------------------
    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo only — deletes data on stack destroy
    });

    // ---------------------------------------------------------------------
    // 2. The event bus that routes business events
    // ---------------------------------------------------------------------
    const bus = new events.EventBus(this, 'OrderBus', { eventBusName: 'OrderBus' });

    // ---------------------------------------------------------------------
    // 3. SNS topic for customer notifications (Email / SMS / Push fan-out)
    // ---------------------------------------------------------------------
    const notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      displayName: 'Order notifications',
    });
    const notificationEmail = process.env.NOTIFICATION_EMAIL;
    if (notificationEmail) {
      new sns.CfnSubscription(this, 'NotificationEmailSubscription', {
        protocol: 'email',
        endpoint: notificationEmail,
        topicArn: notificationTopic.topicArn,
      });
    }

    // ---------------------------------------------------------------------
    // 4. Queue-based load leveling in front of Inventory (+ DLQ for retries)
    // ---------------------------------------------------------------------
    const inventoryDlq = new sqs.Queue(this, 'InventoryDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });
    const inventoryQueue = new sqs.Queue(this, 'InventoryQueue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: inventoryDlq, maxReceiveCount: 3 },
    });

    // ---------------------------------------------------------------------
    // 5. Lambda functions
    // ---------------------------------------------------------------------
    const commonEnv: Record<string, string> = {
      TABLE_NAME: ordersTable.tableName,
      BUS_NAME: bus.eventBusName,
    };

    const stripeEnv: Record<string, string> = {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? '',
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ?? '',
      // FRONTEND_URL is NOT taken from the shell — it's set on paymentFn below,
      // derived from the CloudFront distribution domain (section 8b).
    };

    const fn = (name: string, file: string, env: Record<string, string> = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, `../lambda/${file}`),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_24_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: { ...commonEnv, ...env },
        bundling: {
          // The AWS SDK v3 ships in the Node 20 runtime — don't bundle it.
          externalModules: ['@aws-sdk/*'],
        },
      });

    // API-facing
    const createOrderFn = fn('CreateOrderFn', 'createOrder.js');
    const getOrderFn = fn('GetOrderFn', 'getOrder.js');
    const webhookFn = fn('WebhookFn', 'webhook.js', stripeEnv);

    // Event consumers
    const inventoryFn = fn('InventoryFn', 'inventory.js');
    const paymentFn = fn('PaymentFn', 'payment.js', stripeEnv);
    const shipmentFn = fn('ShipmentFn', 'shipment.js');
    const notificationFn = fn('NotificationFn', 'notification.js', {
      NOTIFICATION_TOPIC_ARN: notificationTopic.topicArn,
    });
    const analyticsFn = fn('AnalyticsFn', 'analytics.js');

    // ---------------------------------------------------------------------
    // 6. Permissions (least privilege)
    // ---------------------------------------------------------------------
    ordersTable.grantWriteData(createOrderFn);
    bus.grantPutEventsTo(createOrderFn);

    ordersTable.grantReadData(getOrderFn);

    ordersTable.grantWriteData(inventoryFn);
    bus.grantPutEventsTo(inventoryFn);

    ordersTable.grantWriteData(paymentFn);
    bus.grantPutEventsTo(paymentFn);

    ordersTable.grantReadData(webhookFn);
    bus.grantPutEventsTo(webhookFn);

    ordersTable.grantWriteData(shipmentFn);
    bus.grantPutEventsTo(shipmentFn);

    notificationTopic.grantPublish(notificationFn);

    // ---------------------------------------------------------------------
    // 7. EventBridge rules (the actual choreography)
    // ---------------------------------------------------------------------
    const SOURCE = 'store.orders';

    // OrderCreated fans out to: Inventory (via SQS), Payment, Analytics
    new events.Rule(this, 'OrderCreatedRule', {
      eventBus: bus,
      eventPattern: { source: [SOURCE], detailType: ['OrderCreated'] },
      targets: [
        new targets.SqsQueue(inventoryQueue),
        new targets.LambdaFunction(paymentFn),
        new targets.LambdaFunction(analyticsFn),
      ],
    });

    // Inventory Lambda is fed by the queue, not directly by EventBridge
    inventoryFn.addEventSource(new SqsEventSource(inventoryQueue, { batchSize: 5 }));

    // InventoryReserved is informational here (parallel model) — Analytics tracks it
    new events.Rule(this, 'InventoryReservedRule', {
      eventBus: bus,
      eventPattern: { source: [SOURCE], detailType: ['InventoryReserved'] },
      targets: [new targets.LambdaFunction(analyticsFn)],
    });

    // PaymentSucceeded fans out to: Shipping, Notification, Analytics
    new events.Rule(this, 'PaymentSucceededRule', {
      eventBus: bus,
      eventPattern: { source: [SOURCE], detailType: ['PaymentSucceeded'] },
      targets: [
        new targets.LambdaFunction(shipmentFn),
        new targets.LambdaFunction(notificationFn),
        new targets.LambdaFunction(analyticsFn),
      ],
    });

    // ---------------------------------------------------------------------
    // 7b. (Optional) Stripe → EventBridge native integration
    //
    // Stripe's partner event source drops "checkout.session.completed" onto a
    // separate PARTNER event bus in this account. We put a rule on that bus that
    // targets a translator Lambda, which re-emits our internal "PaymentSucceeded"
    // onto OrderBus — so the existing consumers work unchanged.
    //
    // Enable it by exporting the partner bus name (from the EventBridge console)
    // before deploy:
    //   export STRIPE_PARTNER_BUS=aws.partner/stripe.com/ed_test_xxx
    // If the variable is not set, this whole block is skipped (webhook-only).
    // ---------------------------------------------------------------------
    const stripePartnerBusName = process.env.STRIPE_PARTNER_BUS;
    if (stripePartnerBusName) {
      const partnerBus = events.EventBus.fromEventBusName(
        this,
        'StripePartnerBus',
        stripePartnerBusName
      );

      const stripeTranslatorFn = fn('StripeTranslatorFn', 'stripeTranslator.js');
      bus.grantPutEventsTo(stripeTranslatorFn);

      new events.Rule(this, 'StripeCheckoutRule', {
        eventBus: partnerBus,
        // Match on the Stripe event's own "type" field inside detail — robust
        // regardless of how the partner sets detail-type.
        eventPattern: { detail: { type: ['checkout.session.completed'] } },
        targets: [new targets.LambdaFunction(stripeTranslatorFn)],
      });
    }

    // ---------------------------------------------------------------------
    // 8. REST API: POST /orders, GET /orders/{id}, POST /webhook
    // ---------------------------------------------------------------------
    const api = new apigw.RestApi(this, 'StoreApi', {
      restApiName: 'store-api',
      deployOptions: { stageName: 'prod' },
    });

    const orders = api.root.addResource('orders');
    orders.addMethod('POST', new apigw.LambdaIntegration(createOrderFn));

    const order = orders.addResource('{id}');
    order.addMethod('GET', new apigw.LambdaIntegration(getOrderFn));

    const webhook = api.root.addResource('webhook');
    webhook.addMethod('POST', new apigw.LambdaIntegration(webhookFn));

    // ---------------------------------------------------------------------
    // 8b. Frontend (S3) + API behind ONE CloudFront distribution.
    //
    // The SPA is served from S3 as the default origin; requests to /orders and
    // /orders/* are routed to the API Gateway origin on the SAME domain. So the
    // browser just calls relative paths ("/orders") — no API URL to configure,
    // and no CORS (same origin).
    // ---------------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // CloudFront reaches it via OAC
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo only
      autoDeleteObjects: true,
    });

    // Shared behavior for API routes: allow POST, never cache, forward everything
    // except the Host header (API Gateway rejects a mismatched Host).
    const apiOrigin = new origins.RestApiOrigin(api); // origin path = /prod (the stage)
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/orders': apiBehavior,
        '/orders/*': apiBehavior,
      },
    });

    // Upload the SPA + assets and invalidate the CDN cache on every deploy.
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../frontend'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // The payment Lambda builds Stripe success/cancel URLs from the CDN domain,
    // so we don't have to hardcode FRONTEND_URL. (payment is not an API target,
    // so this introduces no circular dependency.)
    paymentFn.addEnvironment('FRONTEND_URL', `https://${distribution.distributionDomainName}`);

    // ---------------------------------------------------------------------
    // 9. Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'WebhookUrl', { value: `${api.url}webhook` });
    new cdk.CfnOutput(this, 'OrdersTableName', { value: ordersTable.tableName });
    new cdk.CfnOutput(this, 'EventBusName', { value: bus.eventBusName });
    new cdk.CfnOutput(this, 'NotificationTopicArn', { value: notificationTopic.topicArn });
  }
}
