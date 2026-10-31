"""PDF text extraction behind extract_pages(file) -> list[PageText] seam for V1 OCR."""
from dataclasses import dataclass


@dataclass
class PageText:
    page_number: int
    text: str
    has_text: bool
    meta: dict

