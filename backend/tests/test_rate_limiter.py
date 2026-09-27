from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from backend.app.core.config import get_settings
from backend.app.services.rate_limiter import AgentRateLimiter, SlidingWindow


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_client_window_slides_and_rounds_retry_up():
    clock = FakeClock()
    limiter = AgentRateLimiter(per_client=2, total=0, clock=clock)
    assert limiter.try_acquire("a").allowed
    clock.now = 10.0
    assert limiter.try_acquire("a").allowed
    clock.now = 10.25
    denied = limiter.try_acquire("a")
    assert (denied.allowed, denied.scope, denied.retry_after) == (False, "client", 50)
    assert limiter.try_acquire("b").allowed
    clock.now = 59.75
    assert limiter.try_acquire("a").retry_after == 1
    clock.now = 60.0
    assert limiter.try_acquire("a").allowed
    assert limiter.try_acquire("a").retry_after == 10
    clock.now = 70.01
    assert limiter.try_acquire("a").allowed


def test_total_window_counts_distinct_clients_without_tracking_them():
    clock = FakeClock()
    limiter = AgentRateLimiter(per_client=0, total=3, clock=clock)
    for key in ("a", "b", "c"):
        assert limiter.try_acquire(key).allowed
    denied = limiter.try_acquire("d")
    assert (denied.scope, denied.retry_after) == ("total", 60)
    assert not limiter._clients
    clock.now = 60.0
    assert limiter.try_acquire("d").allowed


def test_client_denial_consumes_neither_window():
    clock = FakeClock()
    limiter = AgentRateLimiter(per_client=1, total=2, clock=clock)
    assert limiter.try_acquire("a").allowed
    clock.now = 10.0
    assert limiter.try_acquire("a").scope == "client"
    assert limiter.try_acquire("b").allowed
    clock.now = 60.0
    # The rejected a@10 must not occupy either bucket after a@0 expires.
    assert limiter.try_acquire("a").allowed
    assert limiter.try_acquire("c").scope == "total"


def test_total_denial_consumes_neither_window_and_takes_precedence():
    clock = FakeClock()
    limiter = AgentRateLimiter(per_client=1, total=1, clock=clock)
    assert limiter.try_acquire("a").allowed
    clock.now = 10.0
    assert limiter.try_acquire("a").scope == "total"
    assert limiter.try_acquire("b").scope == "total"
    assert list(limiter._clients) == ["a"]
    clock.now = 60.0
    assert limiter.try_acquire("b").allowed


@pytest.mark.parametrize("same_client", [False, True])
def test_fifty_threads_cannot_over_admit(same_client):
    barrier = Barrier(50)
    limiter = AgentRateLimiter(per_client=7, total=11, clock=lambda: 0.0)

    def acquire(index):
        barrier.wait(timeout=10)
        return limiter.try_acquire("same" if same_client else str(index))

    with ThreadPoolExecutor(max_workers=50) as executor:
        decisions = list(executor.map(acquire, range(50)))
    assert sum(decision.allowed for decision in decisions) == (7 if same_client else 11)


@pytest.mark.parametrize("total, admitted", [(0, 1000), (150, 150)])
def test_distinct_key_flood_has_bounded_memory_and_cannot_bypass_total(total, admitted):
    limiter = AgentRateLimiter(per_client=1, total=total, clock=lambda: 0.0, max_tracked_clients=100)
    decisions = [limiter.try_acquire(str(index)) for index in range(1000)]
    assert sum(decision.allowed for decision in decisions) == admitted
    assert len(limiter._clients) == 100
    if total:
        assert all(decision.scope == "total" for decision in decisions[admitted:])


def test_idle_windows_are_pruned_and_eviction_is_lru():
    clock = FakeClock()
    limiter = AgentRateLimiter(per_client=2, total=0, clock=clock, max_tracked_clients=2)
    assert limiter.try_acquire("a").allowed
    clock.now = 10.0
    assert limiter.try_acquire("b").allowed
    clock.now = 20.0
    assert limiter.try_acquire("a").allowed
    assert limiter.try_acquire("c").allowed
    assert list(limiter._clients) == ["a", "c"]
    assert limiter.try_acquire("a").scope == "client"
    assert limiter.try_acquire("b").allowed
    assert list(limiter._clients) == ["a", "b"]
    clock.now = 80.0
    assert limiter.try_acquire("fresh").allowed
    assert list(limiter._clients) == ["fresh"]


def test_both_limits_disabled_store_no_requests():
    limiter = AgentRateLimiter(per_client=0, total=0)
    assert all(limiter.try_acquire(str(index)).allowed for index in range(100))
    assert limiter._total is None
    assert not limiter._clients
    window = SlidingWindow(0)
    window.add(0.0)
    assert window.has_room() and window.retry_after(0.0) == 0
    assert not window.timestamps


RATE_ENV = {
    "AGENT_RATE_LIMIT_PER_CLIENT": "agent_rate_limit_per_client",
    "AGENT_RATE_LIMIT_TOTAL": "agent_rate_limit_total",
    "RATE_LIMIT_TRUSTED_PROXY_HOPS": "rate_limit_trusted_proxy_hops",
}


def test_config_defaults_and_stripped_header_name(monkeypatch):
    for name in (*RATE_ENV, "RATE_LIMIT_USER_HEADER"):
        monkeypatch.delenv(name, raising=False)
    settings = get_settings()
    assert settings.agent_rate_limit_per_client == 45
    assert settings.agent_rate_limit_total == 25
    assert settings.rate_limit_trusted_proxy_hops == 1
    assert settings.rate_limit_user_header == ""
    monkeypatch.setenv("RATE_LIMIT_USER_HEADER", "  X-Authenticated-User  ")
    assert get_settings().rate_limit_user_header == "X-Authenticated-User"


@pytest.mark.parametrize("name, field", RATE_ENV.items())
def test_config_accepts_zero(monkeypatch, name, field):
    monkeypatch.setenv(name, "0")
    assert getattr(get_settings(), field) == 0


@pytest.mark.parametrize("name", RATE_ENV)
@pytest.mark.parametrize("value", ["-1", "abc", "1.5", ""])
def test_config_rejects_invalid_integers(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        get_settings()
