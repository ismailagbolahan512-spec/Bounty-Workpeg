import io

import docx
import pytest

from bounty_worker.extract import DOCX, MAX_CHARS, PDF, ExtractionError, UnsupportedType, extract_text


def make_docx(paragraphs, table_rows=()):
    d = docx.Document()
    for p in paragraphs:
        d.add_paragraph(p)
    if table_rows:
        table = d.add_table(rows=len(table_rows), cols=len(table_rows[0]))
        for r, row in enumerate(table_rows):
            for c, value in enumerate(row):
                table.cell(r, c).text = value
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def make_pdf(text):
    """A minimal one-page PDF with a text stream and a correct cross-reference table."""
    stream = f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def test_docx_paragraphs_and_tables_are_extracted():
    data = make_docx(["Scope of work", "Deliver the report."], table_rows=[["Item", "Owner"], ["Draft", "Ada"]])
    text = extract_text(DOCX, data)
    for expected in ["Scope of work", "Deliver the report.", "Item", "Ada"]:
        assert expected in text


def test_pdf_text_is_extracted():
    text = extract_text(PDF, make_pdf("Hello extraction"))
    assert "Hello extraction" in text


def test_control_characters_are_removed_and_output_is_capped(monkeypatch):
    import bounty_worker.extract as ex

    monkeypatch.setattr(ex, "_docx_text", lambda data: "A\x01B" + "x" * (MAX_CHARS + 50))
    text = extract_text(DOCX, b"ignored")
    assert "\x01" not in text
    assert text.startswith("A B")
    assert len(text) <= MAX_CHARS


def test_unsupported_type_is_refused():
    with pytest.raises(UnsupportedType):
        extract_text("image/png", b"\x89PNG")


def test_unreadable_pdf_is_an_extraction_error():
    with pytest.raises(ExtractionError):
        extract_text(PDF, b"not a pdf at all")


def test_unreadable_docx_is_an_extraction_error():
    with pytest.raises(ExtractionError):
        extract_text(DOCX, b"not a zip")
