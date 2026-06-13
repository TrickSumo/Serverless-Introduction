# Task1 Hint

## 1. Generate RSA key-pair for Cloudfront Distribution. Then restrict access to S3 bucket and API using signed cookies.

### Windows

*Generate private key*
openssl genrsa -out private_key.pem 2048

*Extract public key*
openssl rsa -in private_key.pem -pubout -out public_key.pem

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

## 2. Take file from s3 folder and putt in s3 bucket in auth folder

## 3. Create signedCookieCreator lambda function and add code to generate signed cookie for cloudfront distribution (lambda folder)

## 4. Add API Route to API Gateway and integrate with lambda function

## 5. IMPORTANT: Make sure Cloudfront behaviuor for api route allow query strings. Set Origin request policy to AllViewerExceptHostHeader.