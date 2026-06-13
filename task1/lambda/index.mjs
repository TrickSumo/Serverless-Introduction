import { getSignedCookies } from "@aws-sdk/cloudfront-signer";

const privateKeyRaw = process.env.privateKey;
const privateKey = privateKeyRaw?.replace(/\\n/g, '\n');

const cloudfrontDistributionDomain = process.env.cloudfrontDistributionDomain; // https://<ID>.cloudfront.net
const keyPairId = process.env.keyPairId; // K33...........
const authToken = process.env.authToken; // A simple token to authenticate the request, can be any string, e.g., "mysecrettoken"
const intervalToAddInMilliseconds = 86400 * 1000; // 24 hours in milliseconds


export const handler = async (event) => {

  if (!privateKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'privateKey not set in environment variables' }),
    };
  }

  // Frontend (/auth/index.html) calls /api/signedCookies?pass=<token>
  const pass = event?.queryStringParameters?.pass;

  if (!pass) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/plain" },
      body: "Auth token missing",
    };
  }

  if (pass !== authToken) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "text/plain" },
      body: "Invalid auth token",
    };
  }


  const s3ObjectKey = "*";
  const url = `${cloudfrontDistributionDomain}/${s3ObjectKey}`;
  const dateLessThan = Math.floor((Date.now() + intervalToAddInMilliseconds) / 1000);


  const policy = {
    Statement: [
      {
        "Resource": url,
        Condition: {
          DateLessThan: {
            "AWS:EpochTime": dateLessThan,
          },
        },
      },
    ],
  };
  const policyString = JSON.stringify(policy);


  const cookies = getSignedCookies({
    keyPairId,
    privateKey,
    policy: policyString,
  });

  const expires = new Date(dateLessThan * 1000).toUTCString();

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    cookies: [
      `CloudFront-Key-Pair-Id=${cookies['CloudFront-Key-Pair-Id']}; Expires=${expires}; Path=/; Secure; HttpOnly; SameSite=None;`,
      `CloudFront-Signature=${cookies['CloudFront-Signature']}; Expires=${expires}; Path=/; Secure; HttpOnly; SameSite=None`,
      `CloudFront-Policy=${cookies['CloudFront-Policy']}; Expires=${expires}; Path=/; Secure; HttpOnly; SameSite=None;`,
    ],
    body: JSON.stringify(cookies),
  };

};