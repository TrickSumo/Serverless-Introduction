with open('private_key.pem', 'r') as file:
    key = file.read().strip()
    key_inline = key.replace('\n', '\\n')
    print(key_inline)