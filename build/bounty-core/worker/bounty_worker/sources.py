"""Where the worker reads file bytes from. The Backblaze B2 source uses the S3-compatible API.

The B2 credentials belong to the worker's environment only. They are never sent to the Node backend,
never placed in a page, and never logged.
"""
import os

MAX_BYTES = 104_857_600  # matches submission_files.size_bytes CHECK (100 MB)


class FileTooLarge(ValueError):
    pass


class B2Source:
    def __init__(self, client, bucket: str):
        self._client = client
        self._bucket = bucket

    @classmethod
    def from_env(cls):
        import boto3

        required = ["B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "B2_ENDPOINT"]
        missing = [name for name in required if not os.environ.get(name)]
        if missing:
            raise RuntimeError(f"worker is missing environment variables: {', '.join(missing)}")
        client = boto3.client(
            "s3",
            endpoint_url=os.environ["B2_ENDPOINT"],
            aws_access_key_id=os.environ["B2_KEY_ID"],
            aws_secret_access_key=os.environ["B2_APPLICATION_KEY"],
        )
        return cls(client, os.environ["B2_BUCKET"])

    def fetch(self, key: str, expected_size: int) -> bytes:
        if expected_size > MAX_BYTES:
            raise FileTooLarge(f"{expected_size} bytes")
        obj = self._client.get_object(Bucket=self._bucket, Key=key)
        body = obj["Body"].read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise FileTooLarge("stored object is larger than the limit")
        return body
