"""Cloudflare R2 연결. .env의 R2_* 값을 쓴다. R2는 S3 방식으로 대화해서 boto3를 R2 주소에 붙인다.

실행하면 작은 파일을 올리고, 읽고, 지워서 읽기·쓰기 권한을 확인한다: .venv\\Scripts\\python pipeline\\storage.py
"""

import os
from pathlib import Path

import boto3
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
KEYS = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")


def settings() -> dict[str, str]:
    load_dotenv(ROOT / ".env")
    values = {key: os.environ.get(key, "").strip() for key in KEYS}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise SystemExit(f".env에 {', '.join(missing)}를 채워 주세요.")
    return values


def client():
    s = settings()
    return boto3.client(
        "s3",
        endpoint_url=f"https://{s['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=s["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=s["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def bucket() -> str:
    return settings()["R2_BUCKET"]


if __name__ == "__main__":
    r2, name, key = client(), bucket(), "_healthcheck.txt"
    r2.put_object(Bucket=name, Key=key, Body=b"ok")
    body = r2.get_object(Bucket=name, Key=key)["Body"].read()
    r2.delete_object(Bucket=name, Key=key)
    print("연결 성공:", name, "(쓰기·읽기·삭제 확인)" if body == b"ok" else "(읽은 내용이 다름)")
