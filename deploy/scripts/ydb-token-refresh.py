#!/usr/bin/env python3
# Обмен authorized-ключа (RSA/PS256) сервисного аккаунта webnestdev-sa на свежий IAM-токен.
# ВАЖНО: PS256 в JWT = RSA-PSS (salt = размер дайджеста), НЕ PKCS#1 v1.5.
import base64, json, subprocess, sys, time, urllib.request, urllib.error
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

SA_ID  = "aje5490vr9d8q0uj2u12"          # webnestdev-sa
KEY_ID = "ajej68no5h0734a6olma"          # authorized key (RSA_2048)
PEM    = "/home/Misha/keys/webnestdev-sa-authorized.pem"

now = int(time.time())
b = lambda x: base64.urlsafe_b64encode(x).decode().rstrip("=")
hh = b(json.dumps({"alg": "PS256", "typ": "JWT", "kid": KEY_ID}).encode())
pp = b(json.dumps({"aud": "https://iam.api.cloud.yandex.net/iam/v1/tokens",
                   "iss": SA_ID, "iat": now, "exp": now + 3600}).encode())
with open(PEM, "rb") as f:
    key = serialization.load_pem_private_key(f.read(), password=None)
sig = key.sign(f"{hh}.{pp}".encode(),
               padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                          salt_length=padding.PSS.DIGEST_LENGTH),
               hashes.SHA256())
jwt = f"{hh}.{pp}.{b(sig)}"
req = urllib.request.Request("https://iam.api.cloud.yandex.net/iam/v1/tokens",
                             json.dumps({"jwt": jwt}).encode(),
                             {"Content-Type": "application/json"})
try:
    print(json.load(urllib.request.urlopen(req, timeout=30))["iamToken"])
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:300], file=sys.stderr)
    sys.exit(1)
