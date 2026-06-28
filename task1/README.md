# Task1 Hint - Secure The Resume

Lock the resume (and its assets) behind **CloudFront signed cookies**. A
shareable link `/auth/index.html?pass=<token>` mints the cookies; without them
CloudFront returns 403.

## Architecture

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/3a71c897-f951-4cd0-b133-68fe538a16f5" />


```
Browser  ──▶  /auth/index.html?pass=<token>      (S3 origin, public)
                 │ fetch /api/signedCookies?pass=<token>  (credentials: include)
                 ▼
CloudFront  ──▶  /api/*  ──▶  API Gateway (HTTP API)  ──▶  signedCookieCreator lambda
                 │                                            getSignedCookies()
                 │ Set-Cookie: CloudFront-Policy / -Signature / -Key-Pair-Id
                 ▼
Browser stores cookies (Path=/, Secure, HttpOnly, SameSite=None) ──▶ redirect to /
                 │ request / and /images/* now carry the signed cookies
                 ▼
CloudFront validates cookies against the trusted key group ──▶ serves S3 content
```

## 1. Generate RSA key-pair for the CloudFront distribution

### Windows
*Generate private key*
```
openssl genrsa -out private_key.pem 2048
```
*Extract public key*
```
openssl rsa -in private_key.pem -pubout -out public_key.pem
```
*To Store Key As Secret (Use output of python script below to store as secret in AWS Secret Manager or lambda environment variable)*

```
with open('private_key.pem', 'r') as file:
    key = file.read().strip()
    key_inline = key.replace('\n', '\\n')
    print(key_inline)
```

### Linux/Mac
```
openssl genrsa -out private_key.pem 2048; openssl rsa -pubout -in private_key.pem -out public_key.pem;
```


## 2. Register the key with CloudFront (this is the "trust", not IAM)

1. CloudFront → Key management → **Public keys** → upload `public_key.pem`.
   Note its **ID** (e.g. `K33S4GM30D7WUO`) → this is your `keyPairId`.
2. CloudFront → Key management → **Key groups** → create a group containing that
   public key.
3. On the **protected behavior** (default `/`, plus `/images/*`):
   Restrict viewer access = **Yes**, Trusted authorization type =
   **Trusted key groups**, add the group from step 2.

## 3. Put the auth page in S3

Upload `s3/index.html` to the bucket under the `auth/` prefix so it serves at
`/auth/index.html`. It reads `?pass=`, calls `/api/signedCookies?pass=...` with
`credentials: "include"`, and redirects to `/` on success (else shows the error).

## 4. signedCookieCreator lambda (`lambda/index.mjs`)

Validates `pass` then generates the signed cookies with
`@aws-sdk/cloudfront-signer`.

- **Env vars:**
  - `privateKey` - flattened key from step 1 (literal `\n`)
  - `keyPairId` - CloudFront public key ID from step 2
  - `cloudfrontDistributionDomain` - **MUST include the scheme**, e.g.
    `https://d1qqhtq137n7i0.cloudfront.net` (no trailing slash). The signed
    policy `Resource` is `${domain}/*`; CloudFront matches it against the full
    request URL **including `https://`**, so omitting the scheme → valid
    signature but 403 (policy doesn't cover the URL).
  - `authToken` - the shared `?pass=` value
- **IAM role:** basic execution only (CloudWatch Logs). Signing is offline
  crypto - no S3/CloudFront/Secrets permissions needed. See `lambda/role.txt`.

## 5. API Gateway route

- Route `GET /api/signedCookies` → integrate with the lambda.

## 6. CloudFront behavior for `/api/*` (the part that trips everyone up)

- **Origin request policy:** `AllViewerExceptHostHeader` - forwards the query
  string (so `?pass=` reaches the lambda) and *excludes* the Host header (so API
  Gateway sees its own hostname and routes correctly). Plain `AllViewer` → 403
  from API Gateway.
- **Cache policy:** `CachingDisabled` - never cache the cookie response.
- Keep these tight on the **static** behaviors (cacheable, no cookie/header
  forwarding).

## Gotchas checklist

- `cloudfrontDistributionDomain` includes `https://` (see step 4).
- `/api/*` forwards query strings (step 6) - verify `rawQueryString` is
  non-empty in the lambda logs.
- `keyPairId` matches a public key that is in the behavior's trusted key group.
- The signed cookies and the protected content are served from the **same**
  CloudFront domain (cookies have no `Domain`, so they only travel same-origin).
