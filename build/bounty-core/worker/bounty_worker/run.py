"""Worker entry point.

  DATABASE_URL=... python -m bounty_worker.run --once     # process the queue, then exit
  DATABASE_URL=... python -m bounty_worker.run            # keep polling every few seconds

It runs wherever the operator starts it. Nothing schedules it: Workpeg has no scheduled execution,
and Bounty has no scheduler either.
"""
import argparse
import logging
import os
import time

import psycopg

from .extract import ExtractionError, UnsupportedType, extract_text
from .store import claim, file_info, finish_done, finish_error, requeue_stuck

log = logging.getLogger("bounty_worker")


def process_one(conn, source) -> str | None:
    """Handles one job. Returns 'done', 'queued', 'failed', or None when the queue is empty."""
    row = claim(conn)
    if row is None:
        return None
    job_id, file_id, attempts = row
    info = file_info(conn, file_id)
    if info is None:
        return finish_error(conn, job_id, attempts, "file row no longer exists")
    storage_key, content_type, size = info
    try:
        data = source.fetch(storage_key, size)
        text = extract_text(content_type, data)
    except UnsupportedType:
        return finish_error(conn, job_id, 99, f"unsupported type {content_type}")
    except ExtractionError as exc:
        return finish_error(conn, job_id, 99, str(exc))  # a broken file will not improve on retry
    except Exception as exc:  # network or storage problem: retry up to the limit
        log.warning("job %s failed: %s", job_id, type(exc).__name__)
        return finish_error(conn, job_id, attempts, f"{type(exc).__name__}")
    finish_done(conn, job_id, text)
    return "done"


def run(database_url: str, source, once: bool, poll_seconds: float = 5.0) -> None:
    with psycopg.connect(database_url) as conn:
        requeue_stuck(conn)
        while True:
            outcome = process_one(conn, source)
            if outcome is None:
                if once:
                    return
                time.sleep(poll_seconds)
            else:
                log.info("job outcome: %s", outcome)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="process the queue and exit")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set")
    from .sources import B2Source

    run(url, B2Source.from_env(), once=args.once)


if __name__ == "__main__":
    main()
