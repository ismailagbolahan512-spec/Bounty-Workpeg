"""Claims and finishes file_jobs rows. Uses FOR UPDATE SKIP LOCKED so several workers can run at once."""

MAX_ATTEMPTS = 3
STUCK_AFTER_MINUTES = 15
ERROR_MAX = 300

CLAIM_SQL = """
WITH next AS (
  SELECT id FROM file_jobs
   WHERE status = 'queued'
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1
)
UPDATE file_jobs j
   SET status = 'running', attempts = j.attempts + 1, updated_at = NOW()
  FROM next
 WHERE j.id = next.id
RETURNING j.id, j.submission_file_id, j.attempts
"""


def requeue_stuck(conn) -> int:
    """Jobs left 'running' by a crashed worker go back to 'queued'. Returns how many."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE file_jobs SET status = 'queued', updated_at = NOW()
                WHERE status = 'running' AND updated_at < NOW() - make_interval(mins => %s)""",
            (STUCK_AFTER_MINUTES,),
        )
        count = cur.rowcount
    conn.commit()
    return count


def claim(conn):
    """Returns (job_id, submission_file_id, attempts) or None when the queue is empty."""
    with conn.cursor() as cur:
        cur.execute(CLAIM_SQL)
        row = cur.fetchone()
    conn.commit()
    return row


def file_info(conn, submission_file_id):
    with conn.cursor() as cur:
        cur.execute("SELECT storage_key, content_type, size_bytes FROM submission_files WHERE id = %s", (submission_file_id,))
        return cur.fetchone()


def finish_done(conn, job_id, text: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE file_jobs SET status = 'done', extracted_text = %s, last_error = NULL, updated_at = NOW() WHERE id = %s",
            (text, job_id),
        )
    conn.commit()


def finish_error(conn, job_id, attempts: int, message: str) -> str:
    """Returns the new status: 'queued' to retry, or 'failed' once MAX_ATTEMPTS is reached."""
    status = "failed" if attempts >= MAX_ATTEMPTS else "queued"
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE file_jobs SET status = %s, last_error = %s, updated_at = NOW() WHERE id = %s",
            (status, message[:ERROR_MAX], job_id),
        )
    conn.commit()
    return status
