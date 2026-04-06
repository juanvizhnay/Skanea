from __future__ import annotations

from typing import Any, Dict, List, Tuple

import fitz  # PyMuPDF
from PIL import Image

from .ocr import ocr_image_to_text


def detect_native_pdf(doc: fitz.Document, probe_pages: int = 2, min_chars: int = 50) -> bool:
	pages_to_check = min(probe_pages, len(doc))
	acc = 0
	for i in range(pages_to_check):
		page = doc.load_page(i)
		text = page.get_text("text")
		acc += len(text or "")
		if acc >= min_chars:
			return True
	return acc >= min_chars


def page_to_pil(page: fitz.Page, dpi: int = 300) -> Image.Image:
	scale = dpi / 72.0
	matrix = fitz.Matrix(scale, scale)
	pix = page.get_pixmap(matrix=matrix, alpha=False)
	mode = "RGB"
	img = Image.frombytes(mode, [pix.width, pix.height], pix.samples)
	return img


def extract_pdf_native(doc: fitz.Document) -> Tuple[List[Dict[str, Any]], float]:
	pages: List[Dict[str, Any]] = []
	per_page_conf = []
	for i in range(len(doc)):
		page = doc.load_page(i)
		text = page.get_text("text")
		# Default confidence for native text
		conf = 80.0
		pages.append({"number": i + 1, "text": text or "", "confidence": conf})
		per_page_conf.append(conf)
	avg_conf = sum(per_page_conf) / len(per_page_conf) if per_page_conf else 0.0
	return pages, avg_conf


def extract_pdf_scanned(doc: fitz.Document, dpi: int = 300) -> Tuple[List[Dict[str, Any]], float]:
	pages: List[Dict[str, Any]] = []
	confs: List[float] = []
	for i in range(len(doc)):
		page = doc.load_page(i)
		pil_img = page_to_pil(page, dpi=dpi)
		res = ocr_image_to_text(pil_img)
		text = res.get("text", "")
		conf = float(res.get("confidence", 0.0))
		pages.append({"number": i + 1, "text": text, "confidence": conf})
		confs.append(conf)
	avg_conf = sum(confs) / len(confs) if confs else 0.0
	return pages, avg_conf


