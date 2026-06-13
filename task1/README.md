# Genreate Key-pair for Cloudfront Distribution

## Windows

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


## Linux/Mac
```
openssl genrsa -out private_key.pem 2048; openssl rsa -pubout -in private_key.pem -out public_key.pem;
```
