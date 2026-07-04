#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventDrivenStack } from '../lib/event-driven-stack';

const app = new cdk.App();
new EventDrivenStack(app, 'EventDrivenStack', {
  /* Uncomment to specialize the stack for the account/region from your CLI. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Stripe credentials are read from your shell at synth/deploy time.
   * Export them before `cdk deploy`:
   *   export STRIPE_SECRET_KEY=sk_test_...
   *   export STRIPE_WEBHOOK_SECRET=whsec_...      (set after creating the Stripe webhook)
   *   export STRIPE_PARTNER_BUS=aws.partner/...   (optional, enables native EventBridge path)
   *
   * FRONTEND_URL is derived automatically from the CloudFront domain — no export needed.
   */
});
