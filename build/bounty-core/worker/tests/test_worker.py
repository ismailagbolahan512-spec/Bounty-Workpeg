"""Database tests for the worker. Need a LOCAL DATABASE_URL (see conftest.py)."""
import uuid

import psycopg
import pytest  # noqa: F401

from bounty_worker.extract import DOCX
from bounty_worker.run import process_one
from bounty_worker.store import MAX_ATTEMPTS, requeue_stuck

from test_extract import make_docx


class FakeSource:
    def __init__(self, data=None, error=None):
        self.data = data
        self.error = error
        self.calls = []

    def fetch(self, key, size):
        self.calls.append(key)
        if self.error:
            raise self.error
        return self.data


def drain(conn):
    """Finish every queued job left by earlier runs, so each test sees only its own job."""
    good = FakeSource(data=make_docx(["drained"]))
    while process_one(conn, good) is not None:
        pass


def make_job(conn, content_type=DOCX):
    drain(conn)
    tag = uuid.uuid4().hex[:10]
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash, role, name) VALUES (%s, 'x', 'business', 'Biz') RETURNING id",
            (f"biz-{tag}@example.test",),
        )
        business = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO users (email, password_hash, role, name) VALUES (%s, 'x', 'worker', 'Wk') RETURNING id",
            (f"wk-{tag}@example.test",),
        )
        worker = cur.fetchone()[0]
        cur.execute(
            """INSERT INTO bounties (business_id, title, description, category, difficulty, reward_amount, deadline, submission_type)
               VALUES (%s, 'T', 'D', 'Writing', 'easy', 10, NOW() + INTERVAL '1 day', 'file') RETURNING id""",
            (business,),
        )
        bounty = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO submissions (bounty_id, worker_id, title, description) VALUES (%s, %s, 'S', 'D') RETURNING id",
            (bounty, worker),
        )
        submission = cur.fetchone()[0]
        cur.execute(
            """INSERT INTO submission_files (submission_id, uploader_id, storage_key, original_name, content_type, size_bytes, sha256)
               VALUES (%s, %s, %s, 'f.docx', %s, 100, %s) RETURNING id""",
            (submission, worker, f"test/{tag}", content_type, "a" * 64),
        )
        file_id = cur.fetchone()[0]
        cur.execute("INSERT INTO file_jobs (submission_file_id) VALUES (%s) RETURNING id", (file_id,))
        job = cur.fetchone()[0]
    conn.commit()
    return job


def job_row(conn, job):
    with conn.cursor() as cur:
        cur.execute("SELECT status, attempts, extracted_text, last_error FROM file_jobs WHERE id = %s", (job,))
        return cur.fetchone()


def test_a_docx_job_is_extracted_and_marked_done(db_url):
    with psycopg.connect(db_url) as conn:
        job = make_job(conn)
        source = FakeSource(data=make_docx(["Extracted sentence."]))
        assert process_one(conn, source) == "done"
        status, attempts, text, error = job_row(conn, job)
        assert status == "done" and attempts == 1 and error is None
        assert "Extracted sentence." in text


def test_an_unsupported_type_fails_at_once_without_retry(db_url):
    with psycopg.connect(db_url) as conn:
        job = make_job(conn, content_type="image/png")
        assert process_one(conn, FakeSource(data=b"x")) == "failed"
        status, _, _, error = job_row(conn, job)
        assert status == "failed" and "unsupported" in error


def test_a_storage_error_retries_then_fails(db_url):
    with psycopg.connect(db_url) as conn:
        job = make_job(conn)
        outcomes = [process_one(conn, FakeSource(error=OSError("network down"))) for _ in range(MAX_ATTEMPTS)]
        assert outcomes == ["queued"] * (MAX_ATTEMPTS - 1) + ["failed"]
        status, attempts, _, error = job_row(conn, job)
        assert status == "failed" and attempts == MAX_ATTEMPTS
        assert error == "OSError"  # the error class only; no message, no keys


def test_an_empty_queue_returns_none(db_url):
    with psycopg.connect(db_url) as conn:
        while process_one(conn, FakeSource(data=b"")) is not None:
            pass
        assert process_one(conn, FakeSource(data=b"")) is None


def test_requeue_stuck_returns_old_running_jobs_to_the_queue(db_url):
    with psycopg.connect(db_url) as conn:
        job = make_job(conn)
        with conn.cursor() as cur:
            cur.execute("UPDATE file_jobs SET status = 'running', updated_at = NOW() - INTERVAL '1 hour' WHERE id = %s", (job,))
        conn.commit()
        assert requeue_stuck(conn) >= 1
        assert job_row(conn, job)[0] == "queued"
