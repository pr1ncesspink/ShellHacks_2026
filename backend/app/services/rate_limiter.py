"""Thread-safe, process-local sliding windows for agent request admission."""

from __future__ import annotations

from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass
from math import ceil
from threading import Lock
import time
from typing import Literal


@dataclass(frozen=True)
class Decision:
    allowed: bool
    scope: Literal["client", "total"] | None = None
    retry_after: int = 0


class SlidingWindow:
    """Request timestamps in the half-open interval (now - window, now]."""

    def __init__(self, limit: int, window_seconds: float = 60.0) -> None:
        if limit < 0 or window_seconds <= 0:
            raise ValueError("limit must be nonnegative and window_seconds positive")
        self.limit = limit
        self.window_seconds = window_seconds
        self.timestamps: deque[float] = deque()

    def prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self.timestamps and self.timestamps[0] <= cutoff:
            self.timestamps.popleft()

    def has_room(self) -> bool:
        return self.limit == 0 or len(self.timestamps) < self.limit

    def retry_after(self, now: float) -> int:
        if self.has_room():
            return 0
        return max(1, ceil(self.timestamps[0] + self.window_seconds - now))

    def add(self, now: float) -> None:
        if self.limit:
            self.timestamps.append(now)


class AgentRateLimiter:
    """Admit into both enabled buckets, or consume neither bucket.

    Client storage is bounded by an LRU cap. Eviction may reset that client's
    history, but never changes the total window. There is no background thread;
    expired client windows are removed lazily during admission checks.
    """

    def __init__(
        self,
        per_client: int,
        total: int,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        max_tracked_clients: int = 10_000,
    ) -> None:
        if per_client < 0 or total < 0 or window_seconds <= 0:
            raise ValueError("limits must be nonnegative and window_seconds positive")
        if max_tracked_clients < 1:
            raise ValueError("max_tracked_clients must be positive")
        self._per_client = per_client
        self._window_seconds = window_seconds
        self._clock = clock
        self._max_tracked_clients = max_tracked_clients
        self._total = SlidingWindow(total, window_seconds) if total else None
        self._clients: OrderedDict[str, SlidingWindow] = OrderedDict()
        self._lock = Lock()

    def try_acquire(self, key: str) -> Decision:
        with self._lock:
            now = self._clock()
            if self._total is not None:
                self._total.prune(now)
                if not self._total.has_room():
                    # A distinct-key flood cannot allocate client buckets, evict
                    # history, or trigger a client-table scan while total is full.
                    return Decision(False, "total", self._total.retry_after(now))

            for client_key, window in tuple(self._clients.items()):
                window.prune(now)
                if not window.timestamps:
                    del self._clients[client_key]

            client = self._clients.get(key) if self._per_client else None
            if client is not None:
                self._clients.move_to_end(key)
                if not client.has_room():
                    return Decision(False, "client", client.retry_after(now))

            if self._per_client:
                if client is None:
                    if len(self._clients) >= self._max_tracked_clients:
                        self._clients.popitem(last=False)
                    client = SlidingWindow(self._per_client, self._window_seconds)
                    self._clients[key] = client
                client.add(now)
            if self._total is not None:
                self._total.add(now)
            return Decision(True)
