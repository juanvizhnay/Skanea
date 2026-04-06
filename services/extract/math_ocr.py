"""
Math OCR Module - Third fallback for mathematical content recognition
Uses pix2text for LaTeX and mathematical formula recognition
"""

from typing import Dict, Any, Optional
from PIL import Image
import time

_pix2text_instance = None

def _log(message: str):
    """Simple logging function"""
    print(f"[MATH OCR] {message}")

def get_pix2text():
    """Initialize and return pix2text instance (singleton pattern)"""
    global _pix2text_instance
    if _pix2text_instance is None:
        try:
            t0 = time.time()
            _log("Initializing pix2text...")
            from pix2text import Pix2Text
            t1 = time.time()
            _log(f"TIME: pix2text import took {t1-t0:.2f}s")
            
            _pix2text_instance = Pix2Text.from_config()
            t2 = time.time()
            _log(f"TIME: pix2text.from_config() took {t2-t1:.2f}s")
            _log(f"TIME: Total initialization took {t2-t0:.2f}s")
            _log("pix2text initialized successfully")
        except Exception as e:
            _log(f"Error initializing pix2text: {e}")
            raise
    return _pix2text_instance

def extract_math_from_image(image_path: str) -> Dict[str, Any]:
    """
    Extract mathematical content from image using pix2text
    
    Args:
        image_path: Path to the image file
        
    Returns:
        Dict with extracted text and metadata
    """
    try:
        t_start = time.time()
        _log(f"Processing image: {image_path}")
        
        # Load image
        t0 = time.time()
        img = Image.open(image_path)
        t1 = time.time()
        _log(f"Image loaded: {img.size}")
        _log(f"TIME: Image loading took {t1-t0:.2f}s")
        
        # Get pix2text instance
        t2 = time.time()
        p2t = get_pix2text()
        t3 = time.time()
        _log(f"TIME: get_pix2text() took {t3-t2:.2f}s")
        
        # Run recognition with resizing for better accuracy
        _log("Running pix2text recognition...")
        t4 = time.time()
        result = p2t.recognize(img, resized_shape=768)
        t5 = time.time()
        _log(f"TIME: p2t.recognize() took {t5-t4:.2f}s")
        
        # Extract text from result
        t6 = time.time()
        extracted_text = ""
        if isinstance(result, dict):
            extracted_text = result.get('text', str(result))
        elif isinstance(result, list):
            extracted_text = ' '.join([str(item) for item in result])
        else:
            extracted_text = str(result)
        
        t7 = time.time()
        _log(f"TIME: Text extraction took {t7-t6:.2f}s")
        _log(f"TIME: TOTAL extract_math_from_image took {t7-t_start:.2f}s")
        _log(f"Text extracted: {extracted_text[:100]}...")
        
        return {
            "success": True,
            "text": extracted_text,
            "method": "pix2text",
            "confidence": 0.85
        }
        
    except Exception as e:
        _log(f"Error in extract_math_from_image: {e}")
        return {
            "success": False,
            "error": str(e),
            "method": "pix2text"
        }

def math_ocr_extract(image_path: str, previous_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Entry point for math OCR extraction (called from ocr.py)
    
    Args:
        image_path: Path to the image file
        previous_result: Result from previous OCR attempt (optional)
        
    Returns:
        Dict with extracted text and metadata
    """
    try:
        t_total_start = time.time()
        _log("Math OCR activated as third fallback")
        result = extract_math_from_image(image_path)
        t_total_end = time.time()
        _log(f"TIME: TOTAL math_ocr_extract took {t_total_end-t_total_start:.2f}s")
        return result
    except Exception as e:
        _log(f"Error in math_ocr_extract: {e}")
        return {
            "success": False,
            "error": str(e),
            "method": "pix2text"
        }
