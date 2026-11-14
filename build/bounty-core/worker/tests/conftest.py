import os
from urllib.parse import urlparse

import pytest

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def local_test_url():
    """Returns DATABASE_URL only when it points at a local throwaway database. Otherwise None.

    The database tests insert rows that the append-only evidence triggers forbid deleting, so they
    must never run against Neon or any shared database.
    """
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        return None
    host = urlparse(url).hostname or ""
    return url if host in LOCAL_HOSTS else None


@pytest.fixture
def db_url():
    url = local_test_url()
    if url is None:
        pytest.skip("set DATABASE_URL to a LOCAL test database (127.0.0.1) to run database tests")
    return url
