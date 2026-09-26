"""Explicit, server-side configuration for Snowflake document processing."""

from __future__ import annotations

from dataclasses import dataclass, field
import os
import re


@dataclass(frozen=True)
class SnowflakeSettings:
    account: str
    user: str
    token: str = field(repr=False)
    warehouse: str
    database: str = "CONSTRUCTION_COLLAB"
    schema: str = "APP"
    stage: str = "DOCUMENTS_STAGE"
    role: str = ""
    statement_timeout: int = 300

    def __post_init__(self):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", self.account):
            raise ValueError("SNOWFLAKE_ACCOUNT must be an account identifier, not a URL")
        if not self.user.strip() or not self.token.strip():
            raise ValueError("SNOWFLAKE_USER and SNOWFLAKE_TOKEN are required")
        for name in ("warehouse", "database", "schema", "stage", "role"):
            value = getattr(self, name)
            if name == "role" and not value:
                continue
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", value):
                raise ValueError(f"SNOWFLAKE_{name.upper()} must be an unquoted SQL identifier")
        if not 1 <= self.statement_timeout <= 3600:
            raise ValueError("SNOWFLAKE_STATEMENT_TIMEOUT must be between 1 and 3600 seconds")

    @property
    def base_url(self):
        return f"https://{self.account}.snowflakecomputing.com"

    @property
    def stage_ref(self):
        return f"@{self.database.upper()}.{self.schema.upper()}.{self.stage.upper()}"

    @classmethod
    def from_env(cls):
        required = ("ACCOUNT", "USER", "TOKEN", "WAREHOUSE")
        missing = [f"SNOWFLAKE_{key}" for key in required if not os.getenv(f"SNOWFLAKE_{key}")]
        if missing:
            raise ValueError("Missing Snowflake settings: " + ", ".join(missing))
        return cls(
            account=os.environ["SNOWFLAKE_ACCOUNT"], user=os.environ["SNOWFLAKE_USER"],
            token=os.environ["SNOWFLAKE_TOKEN"], warehouse=os.environ["SNOWFLAKE_WAREHOUSE"],
            database=os.getenv("SNOWFLAKE_DATABASE", "CONSTRUCTION_COLLAB"),
            schema=os.getenv("SNOWFLAKE_SCHEMA", "APP"),
            stage=os.getenv("SNOWFLAKE_STAGE", "DOCUMENTS_STAGE"),
            role=os.getenv("SNOWFLAKE_ROLE", ""),
            statement_timeout=int(os.getenv("SNOWFLAKE_STATEMENT_TIMEOUT", "300")),
        )
