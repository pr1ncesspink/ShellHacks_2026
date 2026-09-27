"""SQL REST API for Cortex; the official connector is used only for file transfer."""

from __future__ import annotations

import json
from pathlib import Path
import re
import time
from uuid import uuid4

import httpx

from .config import SnowflakeSettings


class SnowflakeError(RuntimeError):
    """A transport, statement, or file-transfer failure safe to report to a caller."""


def json_object(value, operation: str) -> dict:
    try:
        result = json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        raise SnowflakeError(f"{operation} returned malformed JSON") from None
    if not isinstance(result, dict):
        raise SnowflakeError(f"{operation} did not return a JSON object")
    return result


class SnowflakeClient:
    def __init__(self, settings: SnowflakeSettings, *, http=None, connect=None, sleep=time.sleep):
        self.settings = settings
        self._owns_http = http is None
        self.http = http or httpx.Client(timeout=30, follow_redirects=False)
        self._connect = connect
        self._sleep = sleep

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self._owns_http:
            self.http.close()

    def _request(self, method, path, *, params=None, body=None):
        # Construct URLs ourselves: never send credentials to a returned status URL.
        headers = {"Authorization": f"Bearer {self.settings.token}",
                   "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN"}
        params = dict(params or {})
        for attempt in range(3):
            try:
                response = self.http.request(method, self.settings.base_url + path,
                                             headers=headers, params=params, json=body)
            except httpx.TransportError:
                if attempt == 2:
                    raise SnowflakeError("Snowflake connection failed after 3 attempts") from None
            else:
                if response.status_code == 429 and method == "GET":
                    try:
                        pending = response.json()
                    except ValueError:
                        pending = None
                    if isinstance(pending, dict) and pending.get("statementHandle"):
                        return 202, pending
                if response.status_code not in (429, 500, 502, 503, 504):
                    if response.status_code not in (200, 202):
                        raise SnowflakeError(f"Snowflake SQL API returned HTTP {response.status_code}")
                    try:
                        payload = json_object(response.json(), "SQL API")
                    except ValueError:
                        raise SnowflakeError("Snowflake SQL API returned invalid JSON") from None
                    return response.status_code, payload
                if attempt == 2:
                    raise SnowflakeError(f"Snowflake SQL API returned HTTP {response.status_code} after 3 attempts")
            if method == "POST" and "requestId" in params:
                params["retry"] = "true"  # Same request ID prevents a second execution.
            self._sleep(min(2 ** attempt, 4))
        raise AssertionError("unreachable")

    def execute(self, statement: str, values=(), *, context=True) -> dict:
        body = {"statement": statement, "timeout": self.settings.statement_timeout,
                "warehouse": self.settings.warehouse.upper(),
                "parameters": {"AUTOCOMMIT": "true"}}
        if context:
            body.update(database=self.settings.database.upper(), schema=self.settings.schema.upper())
        if self.settings.role:
            body["role"] = self.settings.role.upper()
        if values:
            body["bindings"] = {str(i): {"type": "TEXT", "value": str(value)}
                                for i, value in enumerate(values, 1)}
        deadline = time.monotonic() + self.settings.statement_timeout
        status, payload = self._request("POST", "/api/v2/statements",
                                        params={"requestId": str(uuid4()), "async": "true"}, body=body)
        handle = payload.get("statementHandle", "")
        while status == 202:
            if not re.fullmatch(r"[A-Za-z0-9-]+", handle):
                raise SnowflakeError("Snowflake returned an invalid statement handle")
            if time.monotonic() >= deadline:
                try:
                    self._request("POST", f"/api/v2/statements/{handle}/cancel")
                except SnowflakeError:
                    pass
                raise SnowflakeError(f"Snowflake statement timed out: {handle}")
            self._sleep(1)
            status, payload = self._request("GET", f"/api/v2/statements/{handle}")
        if payload.get("code") not in (None, "000000", "090001"):
            raise SnowflakeError(f"Snowflake statement failed (code {payload.get('code')})")
        return payload

    def scalar_json(self, statement: str, values=()) -> dict:
        result = self.execute(statement, values)
        data = result.get("data")
        if (not isinstance(data, list) or len(data) != 1
                or not isinstance(data[0], list) or len(data[0]) != 1):
            raise SnowflakeError("Expected exactly one JSON value from Snowflake")
        return json_object(data[0][0], "Cortex")

    def query_rows(self, statement: str, values=(), *, context=True) -> list:
        """Read every SQL API result partition, including large project payloads."""
        result = self.execute(statement, values, context=context)
        rows = result.get("data", [])
        if not isinstance(rows, list):
            raise SnowflakeError("SQL API returned invalid rows")
        rows = list(rows)
        metadata = result.get("resultSetMetaData", {})
        partitions = metadata.get("partitionInfo", [])
        handle = result.get("statementHandle", "")
        if len(partitions) > 1 and not re.fullmatch(r"[A-Za-z0-9-]+", handle):
            raise SnowflakeError("Snowflake returned an invalid result handle")
        for partition in range(1, len(partitions)):
            status, page = self._request("GET", f"/api/v2/statements/{handle}", params={"partition": partition})
            if status != 200 or not isinstance(page.get("data"), list):
                raise SnowflakeError("Snowflake result partition was not available")
            rows.extend(page["data"])
        if "numRows" in metadata and len(rows) != int(metadata["numRows"]):
            raise SnowflakeError("Snowflake returned an incomplete result set")
        return rows

    def setup(self):
        """Create only this pipeline's namespace and stage; no destructive replacement."""
        s = self.settings
        for statement in (
            f"CREATE DATABASE IF NOT EXISTS {s.database.upper()}",
            f"CREATE SCHEMA IF NOT EXISTS {s.database.upper()}.{s.schema.upper()}",
            f"CREATE STAGE IF NOT EXISTS {s.stage_ref[1:]} ENCRYPTION=(TYPE='SNOWFLAKE_SSE')",
        ):
            self.execute(statement, context=False)

    def upload(self, path: Path, sha256: str) -> str:
        if not re.fullmatch(r"[a-f0-9]{64}", sha256):
            raise ValueError("Invalid document hash")
        # Caller passes a snapshot named source.<extension>; staged paths never use user filenames.
        if not re.fullmatch(r"source\.[a-z0-9]+", path.name):
            raise ValueError("Upload must use the validated document snapshot")
        connect = self._connect
        if connect is None:
            try:
                from snowflake.connector import connect
            except ImportError:
                raise SnowflakeError("Install backend/requirements-documentparsing.txt to enable uploads") from None
        s = self.settings
        kwargs = dict(account=s.account, user=s.user, password=s.token,
                      warehouse=s.warehouse.upper(), database=s.database.upper(), schema=s.schema.upper(),
                      login_timeout=30, network_timeout=60)
        if s.role:
            kwargs["role"] = s.role.upper()
        # Path.as_uri percent-encodes spaces; PUT expects the literal filesystem URI.
        uri = ("file://" + path.resolve().as_posix()).replace("'", "''")
        try:
            with connect(**kwargs) as connection:
                with connection.cursor() as cursor:
                    cursor.execute(f"PUT '{uri}' {s.stage_ref}/{sha256}/ AUTO_COMPRESS=FALSE OVERWRITE=FALSE")
                    columns = [column[0].lower() for column in cursor.description]
                    transfers = [dict(zip(columns, row)) for row in cursor.fetchall()]
                    if len(transfers) != 1 or transfers[0].get("status") not in ("UPLOADED", "SKIPPED"):
                        raise SnowflakeError("Snowflake did not confirm the staged file upload")
        except SnowflakeError:
            raise
        except Exception:
            # Driver exceptions may include connection details; don't expose credentials or SQL.
            raise SnowflakeError("Snowflake upload failed; check stage permissions and connection settings") from None
        return f"{sha256}/{path.name}"

    def parse(self, staged_path: str, *, page_split: bool) -> dict:
        options = {"mode": "LAYOUT"}
        if page_split:
            options["page_split"] = True
        return self.scalar_json(
            "SELECT AI_PARSE_DOCUMENT(TO_FILE(?, ?), PARSE_JSON(?), TRUE)",
            (self.settings.stage_ref, staged_path, json.dumps(options)),
        )

    def extract(self, text: str, response_format: dict) -> dict:
        return self.scalar_json("SELECT AI_EXTRACT(text => ?, responseFormat => PARSE_JSON(?))",
                                (text, json.dumps(response_format)))
