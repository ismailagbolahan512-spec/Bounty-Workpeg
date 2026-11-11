"""Turns PDF and Word bytes into plain text. Pure functions, no database, no network."""
import io
import re

import docx
from pypdf import PdfReader

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
SUPPORTED = {PDF, DOCX}
MAX_CHARS = 200_000

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class UnsupportedType(ValueError):
    pass


class ExtractionError(ValueError):
    pass


def _pdf_text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        # Only owner-password-only PDFs can be read with an empty password. Anything else is refused.
        try:
            reader.decrypt("")
        except Exception as exc:  # pypdf raises several types for a locked file
            raise ExtractionError("encrypted PDF") from exc
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def _docx_text(data: bytes) -> str:
    document = docx.Document(io.BytesIO(data))
    parts = [p.text for p in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            parts.extend(cell.text for cell in row.cells)
    return "\n".join(parts)


def extract_text(content_type: str, data: bytes) -> str:
    if content_type not in SUPPORTED:
        raise UnsupportedType(content_type)
    try:
        raw = _pdf_text(data) if content_type == PDF else _docx_text(data)
    except ExtractionError:
        raise
    except Exception as exc:
        raise ExtractionError(f"could not read {content_type}") from exc
    cleaned = _CONTROL.sub(" ", raw).strip()
    return cleaned[:MAX_CHARS]
