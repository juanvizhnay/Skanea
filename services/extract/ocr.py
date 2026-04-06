#!/usr/bin/env python3
"""
OCR Module - Based on PaddleOCRv3-ONNX-Sample SUCCESS Implementation
ZERO ROTATION - PURE ONNX APPROACH
"""

import cv2
import numpy as np
import os
from typing import List, Dict, Tuple, Optional
from PIL import Image
import time

# Global variables for caching
_paddleocr_instance = None

def _dbg(message: str):
    """Always active debug logging for OCR operations"""
    print(f"[ENSEMBLE OCR] {message}")

def pil_to_cv(pil_image: Image.Image) -> np.ndarray:
    """Convert PIL Image to OpenCV format (BGR)"""
    try:
        # Convert PIL to RGB array first
        rgb_array = np.array(pil_image.convert('RGB'))
        # Convert RGB to BGR for OpenCV
        bgr_array = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR)
        return bgr_array
    except Exception as e:
        _dbg(f"PIL to CV conversion failed: {e}")
        return np.array([])

def advanced_preprocess(image: np.ndarray) -> List[np.ndarray]:
    """Minimal preprocessing + padding to avoid cutting symbols at edges"""
    try:
        if len(image.shape) == 3:
            img_bgr = image
        else:
            img_bgr = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)

        # Add small white border to capture edge symbols like '?' at the end
        padded = cv2.copyMakeBorder(
            img_bgr, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=(255, 255, 255)
        )
        return [padded]
    except Exception as e:
        _dbg(f"Preprocessing failed: {e}")
        return [image]

# --- ONNX OCR (PaddleOCRv3-ONNX-Sample) ---
import sys
ONNX_ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "PaddleOCRv3-ONNX-Sample-main", "ppocr_onnx"
)
if ONNX_ROOT not in sys.path:
    sys.path.insert(0, ONNX_ROOT)

try:
    from tools.infer import utility
    from tools.infer.predict_system import TextSystem
    _ONNX_AVAILABLE = True
except Exception as _e:
    _ONNX_AVAILABLE = False
    _dbg(f"ONNX pipeline not available: {_e}")

_ONNX_SYS = None

def get_onnx_text_system():
    """Initialize and cache ONNX TextSystem from local repo."""
    global _ONNX_SYS
    if not _ONNX_AVAILABLE:
        return None
    if _ONNX_SYS is not None:
        return _ONNX_SYS
    try:
        parser = utility.init_args()
        args = parser.parse_args([])

        # Use ONNX runtime, disable rotation
        args.use_onnx = True
        args.use_gpu = False
        args.use_angle_cls = False

        # Model paths - PREFER CHINESE for better symbol support, fallback to latin/en
        det_ch = os.path.join(ONNX_ROOT, "model", "det_model", "ch_PP-OCRv3_det_infer.onnx")
        det_en = os.path.join(ONNX_ROOT, "model", "det_model", "en_PP-OCRv3_det_infer.onnx")
        rec_ch = os.path.join(ONNX_ROOT, "model", "rec_model", "ch_PP-OCRv3_rec_infer.onnx")
        rec_latin = os.path.join(ONNX_ROOT, "model", "rec_model", "latin_PP-OCRv3_rec_infer.onnx")
        dict_full = os.path.join(ONNX_ROOT, "ppocr", "utils", "dict", "ppocr_keys_v1.txt")
        dict_latin = os.path.join(ONNX_ROOT, "ppocr", "utils", "dict", "latin_dict.txt")

        # Use Chinese models + full dict for better symbol support (?, ¿, !, etc.)
        args.det_model_dir = det_ch if os.path.exists(det_ch) else det_en
        args.rec_model_dir = rec_ch if os.path.exists(rec_ch) else rec_latin
        args.rec_char_dict_path = dict_full if os.path.exists(dict_full) else dict_latin

        args.det_box_type = "quad"
        args.det_limit_side_len = 1280
        args.det_db_thresh = 0.13
        args.det_db_box_thresh = 0.25
        args.det_db_unclip_ratio = 2.0
        args.use_dilation = False
        args.drop_score = 0.1
        args.show_log = True
        args.det_limit_side_len = 1600
        args.det_db_score_mode = "slow" # New for better symbol detection

        _dbg(f"ONNX models: det='{args.det_model_dir}', rec='{args.rec_model_dir}'")
        _dbg(f"ONNX dict: '{args.rec_char_dict_path}', drop_score={args.drop_score}")
        _dbg(f"ONNX det params: limit={args.det_limit_side_len}, "
             f"db_thresh={args.det_db_thresh}, db_box={args.det_db_box_thresh}, "
             f"unclip={args.det_db_unclip_ratio}, dilation={args.use_dilation}")

        _dbg("ONNX TextSystem init...")
        _ONNX_SYS = TextSystem(args)
        _dbg("ONNX TextSystem ready")
        return _ONNX_SYS
    except Exception as e:
        _dbg(f"ONNX TextSystem init failed: {e}")
        return None

def run_onnx_engine(image: np.ndarray) -> Dict:
    """Run OCR using the ONNX TextSystem pipeline from the repo."""
    try:
        ts = get_onnx_text_system()
        if ts is None:
            return {"text": "", "confidence": 0.0, "source": "onnx", "success": False}

        img = image if len(image.shape) == 3 else cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)

        boxes, rec_res, _ = ts(img, cls=False)
        _dbg(f"ONNX det boxes: {0 if boxes is None else len(boxes)}")
        if not boxes or not rec_res:
            _dbg("ONNX OCR: no results")
            return {"text": "", "confidence": 0.0, "source": "onnx", "success": False}

        _dbg(f"ONNX raw rec count: {len(rec_res)}")
        items = []
        for box, (txt, score) in zip(boxes, rec_res):
            # Safe Unicode printing - encode problematic characters as ASCII-safe repr
            try:
                safe_txt = txt.encode('ascii', errors='backslashreplace').decode('ascii')
                _dbg(f"  RAW TOKEN: '{safe_txt}' (score {score:.3f}) - contains '?': {'?' in txt}")
            except Exception:
                _dbg(f"  RAW TOKEN: <non-ASCII text, {len(txt)} chars> (score {score:.3f})")

            if not txt:
                continue
            box = np.array(box)
            x_center = float(np.mean(box[:, 0]))
            y_center = float(np.mean(box[:, 1]))
            txt_clean = txt.strip()
            items.append((x_center, y_center, txt_clean, float(score)))

            try:
                safe_txt_clean = txt_clean.encode('ascii', errors='backslashreplace').decode('ascii')
                if ("?" in txt_clean) or ("¿" in txt_clean):
                    _dbg(f"  punctuation token detected: '{safe_txt_clean}' (score {float(score):.2f}) at y:{y_center:.1f}, x:{x_center:.1f}")
                else:
                    _dbg(f"  raw rec: '{safe_txt_clean}' (score {float(score):.2f}) at y:{y_center:.1f}, x:{x_center:.1f}")
            except Exception:
                _dbg(f"  raw rec: <non-ASCII, {len(txt_clean)} chars> (score {float(score):.2f}) at y:{y_center:.1f}, x:{x_center:.1f}")

        if not items:
            return {"text": "", "confidence": 0.0, "source": "onnx", "success": False}

        items.sort(key=lambda x: (x[1], x[0]))

        lines = []
        current = []
        last_y = None
        tol = 15
        for x, y, txt, sc in items:
            if last_y is None or abs(y - last_y) <= tol:
                current.append((x, y, txt, sc))
            else:
                if current:
                    current.sort(key=lambda t: t[0])
                    lines.append(current)
                current = [(x, y, txt, sc)]
            last_y = y
        if current:
            current.sort(key=lambda t: t[0])
            lines.append(current)

        parts = []
        confs = []
        for line in lines:
            words = []
            for i, (x, y, txt, sc) in enumerate(line):
                words.append(((" " if i > 0 and x - line[i - 1][0] > 35 else "") + txt))
                confs.append(sc)
            parts.append("".join(words).strip())

        final_text = " ".join([p for p in parts if p])
        avg_conf = float(np.mean(confs)) if confs else 0.0

        # Debug del texto sin causar errores de codificación
        try:
            # Solo para debug - usar representación ASCII segura
            safe_preview = repr(final_text[:100])
            _dbg(f"ONNX final text: {safe_preview}...")
        except UnicodeEncodeError as ue:
            # Error de codificación en el log, pero ONNX funcionó correctamente
            _dbg(f"ONNX text encoding issue (not a failure): {ue}")
        except:
            _dbg(f"ONNX final text: <{len(final_text)} caracteres>")

        return {"text": final_text, "confidence": avg_conf, "source": "onnx", "success": True}
    except Exception as e:
        _dbg(f"ONNX engine failed: {e}")
        return {"text": "", "confidence": 0.0, "source": "onnx", "success": False}

class PureOCRConfig:
    """Configuration class EXACTLY like successful ONNX examples"""

    def __init__(self):
        # CRITICAL: Configuration from successful repo
        self.use_angle_cls = False  # NO rotation - EXACTLY like examples
        self.use_gpu = False

        # Detection parameters - EXACT from successful repo
        self.det_algorithm = 'DB'
        self.det_limit_side_len = 960
        self.det_limit_type = 'max'
        self.det_box_type = 'quad'

        # DB parameters - EXACT from successful repo
        self.det_db_thresh = 0.3
        self.det_db_box_thresh = 0.6
        self.det_db_unclip_ratio = 1.5
        self.max_batch_size = 10
        self.use_dilation = False
        self.det_db_score_mode = 'fast'

        # Recognition parameters - EXACT from successful repo
        self.rec_algorithm = 'SVTR_LCNet'
        self.rec_image_shape = '3, 48, 320'
        self.rec_batch_num = 6
        self.use_space_char = True
        self.drop_score = 0.38  # HIGHER threshold like successful repo

        # Classification parameters (DISABLED like successful repo)
        self.cls_image_shape = '3, 48, 192'
        self.label_list = ['0', '180']
        self.cls_batch_num = 6
        self.cls_thresh = 0.9

        self.save_crop_res = False

def get_pure_paddleocr():
    """Create PaddleOCR instance EXACTLY like successful ONNX examples"""
    global _paddleocr_instance
    if _paddleocr_instance is None:
        try:
            # Clean import - EXACTLY like successful examples
            import sys
            for module_name in list(sys.modules.keys()):
                if 'paddlex' in module_name.lower():
                    del sys.modules[module_name]

            from paddleocr import PaddleOCR

            # Create instance with VALID parameters only
            _paddleocr_instance = PaddleOCR(
                use_angle_cls=False,        # CRITICAL: NO rotation
                lang="es",                  # Spanish language
                det_db_thresh=0.3,         # Detection threshold
                det_db_box_thresh=0.6,     # Box threshold
                det_db_unclip_ratio=1.5,   # Unclip ratio
                use_space_char=True,       # Use space character
            )

            _dbg("PaddleOCR PURE instance created - ONNX STYLE CONFIG")

        except Exception as e:
            _dbg(f"Failed to create PURE PaddleOCR: {e}")
            return None
    return _paddleocr_instance

def sort_boxes_intelligent(dt_boxes: List) -> List:
    """
    Sort text boxes intelligently from top to bottom, left to right
    EXACTLY like successful ONNX example sorting algorithm
    """
    if not dt_boxes:
        return []

    # Convert to numpy array if needed
    if isinstance(dt_boxes[0], list):
        dt_boxes = [np.array(box) for box in dt_boxes]

    # Sort by Y coordinate first, then X - EXACT from successful repo
    sorted_boxes = sorted(dt_boxes, key=lambda x: (x[0][1], x[0][0]))
    _boxes = list(sorted_boxes)

    # Fine-tune sorting for boxes on the same line - EXACT from successful repo
    num_boxes = len(_boxes)
    for i in range(num_boxes - 1):
        for j in range(i, -1, -1):
            if abs(_boxes[j + 1][0][1] - _boxes[j][0][1]) < 10 and \
                    (_boxes[j + 1][0][0] < _boxes[j][0][0]):
                tmp = _boxes[j]
                _boxes[j] = _boxes[j + 1]
                _boxes[j + 1] = tmp
            else:
                break
    return _boxes

def run_pure_paddleocr_engine(image: np.ndarray) -> Dict:
    """
    Run PaddleOCR with PURE implementation - EXACTLY like successful ONNX examples
    """
    try:
        ocr = get_pure_paddleocr()
        if not ocr:
            _dbg("PaddleOCR not available")
            return {
                "text": "",
                "confidence": 0.0,
                "source": "paddleocr_pure",
                "success": False,
            }

        # Convert image format if needed
        if len(image.shape) == 3:
            processed_image = image.copy()
        else:
            processed_image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)

        # Call OCR - SIMPLE like successful examples
        results = ocr.ocr(processed_image)

        if not results or not results[0]:
            _dbg("PaddleOCR returned empty results")
            return {
                "text": "",
                "confidence": 0.0,
                "source": "paddleocr_pure",
                "success": False,
            }

        # Process results - CHECK if it's OCRResult or simple list
        result_data = results[0]

        # Handle different result formats
        if hasattr(result_data, 'keys') and 'rec_texts' in result_data:
            # PaddleX OCRResult format - extract data
            rec_texts = result_data['rec_texts']
            rec_scores = result_data['rec_scores']
            rec_polys = result_data['rec_polys']

            _dbg(f"OCRResult format detected: {len(rec_texts)} texts")

            # Convert to standard format
            processed_results = []
            for i in range(len(rec_texts)):
                if i < len(rec_polys) and i < len(rec_scores):
                    processed_results.append([rec_polys[i], [rec_texts[i], rec_scores[i]]])

            result_data = processed_results

        # Process standard format results
        text_items = []

        _dbg(f"PaddleOCR raw results: {len(result_data)} items detected")

        for item in result_data:
            if len(item) >= 2:
                bbox = item[0]  # Bounding box coordinates
                text_info = item[1]  # (text, confidence)

                if len(text_info) >= 2:
                    text = text_info[0].strip()
                    confidence = float(text_info[1])

                    # Use HIGHER confidence threshold like successful repo
                    if text and confidence > 0.5:  # EXACTLY like successful repo drop_score
                        # Calculate center position
                        if hasattr(bbox, 'shape') and bbox.size > 0:
                            # Handle numpy array
                            if bbox.ndim == 2 and bbox.shape[0] >= 4:
                                x_center = np.mean(bbox[:, 0])
                                y_center = np.mean(bbox[:, 1])
                            else:
                                x_center = sum(point[0] for point in bbox) / len(bbox)
                                y_center = sum(point[1] for point in bbox) / len(bbox)
                        else:
                            # Handle list format
                            x_center = sum(point[0] for point in bbox) / len(bbox)
                            y_center = sum(point[1] for point in bbox) / len(bbox)

                        text_items.append((x_center, text, confidence, y_center))
                        _dbg(f"  '{text}' at center y:{y_center:.0f}, x:{x_center:.0f} (conf: {confidence:.2f})")

        if not text_items:
            _dbg("No valid text items found")
            return {
                "text": "",
                "confidence": 0.0,
                "source": "paddleocr_pure",
                "success": False,
            }

        # Sort text items using EXACT algorithm from successful repo
        text_items.sort(key=lambda x: (x[3], x[0]))  # Sort by Y, then X

        _dbg(f"PaddleOCR text items after sorting: {[(item[1], f'y:{item[3]:.0f}, x:{item[0]:.0f}') for item in text_items]}")

        # Group into lines with adaptive tolerance - LIKE successful repo
        lines = []
        current_line = []
        last_y = None
        line_tolerance = 15  # pixels - REASONABLE tolerance

        for x_pos, text, conf, y_pos in text_items:
            if last_y is None or abs(y_pos - last_y) <= line_tolerance:
                current_line.append((x_pos, text, conf, y_pos))
                _dbg(f"  Added '{text}' to current line (y:{y_pos:.0f})")
            else:
                if current_line:
                    # Sort current line by X position only - LIKE successful repo
                    current_line.sort(key=lambda x: x[0])
                    line_text = [item[1] for item in current_line]
                    _dbg(f"  Final line: {line_text}")
                    lines.append(current_line)
                current_line = [(x_pos, text, conf, y_pos)]
                _dbg(f"  Started new line with '{text}' (y:{y_pos:.0f})")
            last_y = y_pos

        if current_line:
            current_line.sort(key=lambda x: x[0])
            line_text = [item[1] for item in current_line]
            _dbg(f"  Final line: {line_text}")
            lines.append(current_line)

        # Build final text with intelligent spacing - LIKE successful repo
        text_parts = []
        confidences = []
        for line in lines:
            line_words = []
            for i, (x_pos, word, conf, y_pos) in enumerate(line):
                if i > 0:
                    prev_x = line[i - 1][0]
                    # Add space if words are far apart - REASONABLE spacing
                    if x_pos - prev_x > 35:
                        line_words.append(" " + word)
                    else:
                        line_words.append(word)
                else:
                    line_words.append(word)
                confidences.append(conf)

            line_text = "".join(line_words).strip()
            if line_text:
                text_parts.append(line_text)

        final_text = " ".join(text_parts)
        avg_confidence = np.mean(confidences) if confidences else 0.0

        _dbg(f"PaddleOCR PURE final ordered text: '{final_text}'")

        return {
            "text": final_text,
            "confidence": avg_confidence,
            "source": "paddleocr_pure",
            "success": True,
        }

    except Exception as e:
        _dbg(f"PaddleOCR PURE processing failed: {e}")
        return {
            "text": "",
            "confidence": 0.0,
            "source": "paddleocr_pure",
            "success": False,
        }

def ocr_image_to_text(pil_image: Image.Image) -> Dict:
    """
    Main OCR function - NOW using ONNX pipeline from local repo with Tesseract fallback
    """
    try:
        t_ocr_start = time.time()
        _dbg("Starting OCR via ONNX pipeline...")
        _dbg(f"TIME: OCR started at {t_ocr_start:.2f}")

        # Convert PIL to OpenCV
        t0 = time.time()
        cv_image = pil_to_cv(pil_image)
        t1 = time.time()
        _dbg(f"TIME: PIL to CV conversion took {t1-t0:.3f}s")
        if cv_image.size == 0:
            return {"text": "", "confidence": 0.0, "provider": "none"}

        # Minimal preprocessing
        t2 = time.time()
        variants = advanced_preprocess(cv_image)
        t3 = time.time()
        _dbg(f"Generated {len(variants)} image variants")
        _dbg(f"TIME: Preprocessing took {t3-t2:.3f}s")

        best_result = None
        start_time = time.time()
        for i, variant in enumerate(variants):
            _dbg(f"Variant {i+1}/{len(variants)}")
            t_variant_start = time.time()
            result = run_onnx_engine(variant)
            t_variant_end = time.time()
            _dbg(f"TIME: Variant {i+1} ONNX processing took {t_variant_end-t_variant_start:.3f}s")
            if result.get("success") and result.get("text", "").strip():
                if best_result is None or result["confidence"] > best_result["confidence"]:
                    best_result = result
        elapsed = time.time() - start_time
        _dbg(f"ONNX OCR completed in {elapsed:.2f}s")
        _dbg(f"TIME: Total ONNX phase took {elapsed:.2f}s")

        # Detectar si necesitamos Tesseract (fotografías complejas) o pix2text (matemáticas)
        needs_tesseract = False
        needs_math_ocr = False
        reason = ""

        if best_result and best_result.get("text", "").strip():
            text = best_result["text"]
            token_count = best_result.get("token_count", 0)
            avg_confidence = best_result.get("confidence", 1.0)

            # 1. Detectar contenido matemático → ir directo a pix2text
            math_indicators = [
                # Operadores diferenciales
                'dx', 'dy', 'dt', 'du', 'dv',
                # Potencias/índices
                'x4', 'x3', 'x2', 'x^',
                # Comparaciones múltiples (funciones por partes)
                '<<', '>>',  # ONNX confunde < < con <<
                # Símbolos matemáticos mal leídos
                'J-', '+-', 'x+', 'x-',
                # Funciones
                'f(x)', 'f(', 'g(x)', 'g(',
                # Igualdades múltiples (ecuaciones)
                '==', '=2L=', '=L=',
                # Indicadores de funciones por partes
                'sil<<', 'si<<', 'si0<<', 'sil<',  # "si -1 < x < 0" mal leído
            ]
            if any(indicator in text for indicator in math_indicators):
                needs_math_ocr = True
                reason = "mathematical content detected"
                try:
                    safe_text = text[:80].encode('ascii', errors='backslashreplace').decode('ascii')
                    _dbg(f"Math content detected in ONNX result: '{safe_text}...'")
                except Exception:
                    _dbg(f"Math content detected in ONNX result ({len(text)} chars)")
                _dbg("-> Skipping Tesseract, going directly to pix2text for math...")

            # 2. Fotografías complejas/muchos tokens → usar Tesseract
            elif token_count > 40:
                needs_tesseract = True
                reason = f"complex document ({token_count} tokens)"
                _dbg(f"Complex document detected: {token_count} tokens")
                _dbg("-> Using Tesseract for better accuracy on photos/complex documents...")

            # 3. Baja confianza → usar Tesseract
            elif avg_confidence < 0.75:
                needs_tesseract = True
                reason = f"low confidence ({avg_confidence:.2f})"
                _dbg(f"Low confidence detected: {avg_confidence:.2f}")
                _dbg("-> Using Tesseract for difficult text...")

            # 4. Texto muy largo → usar Tesseract
            elif len(text) > 800:
                needs_tesseract = True
                reason = f"long text ({len(text)} chars)"
                _dbg(f"Long text detected: {len(text)} chars")
                _dbg("-> Using Tesseract for complex document...")

        # Si ONNX es suficiente (caso simple), devolverlo
        if best_result and not needs_tesseract and not needs_math_ocr:
            try:
                safe_text = best_result['text'].encode('ascii', errors='backslashreplace').decode('ascii')
                _dbg(f"ONNX result is good for simple case: '{safe_text[:100]}...'")
            except Exception:
                _dbg(f"ONNX result is good ({len(best_result['text'])} chars)")
            return {"text": best_result["text"], "confidence": best_result["confidence"], "provider": best_result["source"]}

        # Si detectamos matemáticas, saltar Tesseract e ir directo a pix2text
        if needs_math_ocr:
            _dbg("Skipping Tesseract fallback, activating Math OCR directly...")
            # Crear archivo temporal para Math OCR
            import tempfile
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as temp_file:
                temp_path = temp_file.name
                pil_image.save(temp_path, 'PNG')
            # Saltar a la sección de Math OCR (línea ~605)
            try:
                from .math_ocr import math_ocr_extract
                math_result = math_ocr_extract(temp_path, previous_result=None)
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                if math_result.get("success", False) and math_result.get("text", "").strip():
                    _dbg(f"Math OCR succeeded: '{math_result['text'][:50]}...'")
                    return {
                        "text": math_result["text"],
                        "confidence": math_result.get("confidence", 0.8),
                        "provider": "pix2text_math",
                        "is_mathematical": True
                    }
            except Exception as e:
                _dbg(f"Math OCR failed: {e}")
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
            # Si Math OCR falla, continuar con Tesseract como último recurso
            _dbg("Math OCR failed, trying Tesseract as last resort...")

        # Activar Tesseract (para casos complejos o si ONNX falló)
        if needs_tesseract:
            _dbg(f"Activating Tesseract for: {reason}")
        else:
            _dbg("ONNX failed - activating Tesseract fallback...")
        t_tesseract_start = time.time()
        try:
            # Save PIL image as temporary file for fallback OCR
            import tempfile
            t_save_start = time.time()
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as temp_file:
                temp_path = temp_file.name
                pil_image.save(temp_path, 'PNG')
                _dbg(f"Imagen temporal guardada en: {temp_path}")
            t_save_end = time.time()
            _dbg(f"TIME: Saving temp image took {t_save_end-t_save_start:.3f}s")

            # Import and use fallback OCR
            _dbg("Importando fallback OCR...")
            t_import_start = time.time()
            from .fallback_ocr import fallback_ocr_extract
            t_import_end = time.time()
            _dbg(f"TIME: Importing fallback_ocr took {t_import_end-t_import_start:.3f}s")

            _dbg("Ejecutando fallback OCR...")
            t_fallback_exec_start = time.time()
            fallback_result = fallback_ocr_extract(temp_path)
            t_fallback_exec_end = time.time()
            _dbg(f"TIME: Tesseract execution took {t_fallback_exec_end-t_fallback_exec_start:.3f}s")
            _dbg(f"Resultado de fallback OCR: success={fallback_result.get('success', False)}")

            # NO eliminar temp file aqui - Math OCR lo necesita
            # os.unlink(temp_path)
            # _dbg("Archivo temporal eliminado")

            if fallback_result.get("success", False) and fallback_result.get("text", "").strip():
                _dbg(f"Fallback OCR succeeded: '{fallback_result['text'][:50]}...' (method: {fallback_result.get('method', 'tesseract')})")

                # Clean up temp file before returning
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                    _dbg("Archivo temporal eliminado (tesseract success)")

                # Include additional information from fallback if available
                result_dict = {
                    "text": fallback_result["text"],
                    "confidence": 0.7,  # Default confidence for fallback
                    "provider": fallback_result.get("method", "tesseract_fallback")
                }

                # Add marked options info if available
                if "marked_options" in fallback_result:
                    result_dict["marked_options"] = fallback_result["marked_options"]
                if "selected_option_texts" in fallback_result:
                    result_dict["selected_option_texts"] = fallback_result["selected_option_texts"]

                return result_dict
            else:
                _dbg("Fallback OCR also failed - trying Math OCR as third fallback...")

        except Exception as fallback_error:
            _dbg(f"Fallback OCR error: {fallback_error}")

        # TERCER FALLBACK: Math OCR (pix2text) para contenido matemático
        _dbg("Activating Math OCR (third fallback)...")
        t_math_start = time.time()
        try:
            t_import_math_start = time.time()
            from .math_ocr import math_ocr_extract
            t_import_math_end = time.time()
            _dbg(f"TIME: Importing math_ocr took {t_import_math_end-t_import_math_start:.3f}s")

            t_math_exec_start = time.time()
            math_result = math_ocr_extract(temp_path, previous_result=fallback_result if 'fallback_result' in locals() else None)
            t_math_exec_end = time.time()
            _dbg(f"TIME: Math OCR execution took {t_math_exec_end-t_math_exec_start:.3f}s")

            # Clean up temp file if still exists
            if os.path.exists(temp_path):
                os.unlink(temp_path)
                _dbg("Archivo temporal eliminado (math ocr)")

            if math_result.get("success", False) and math_result.get("text", "").strip():
                t_total_end = time.time()
                _dbg(f"TIME: TOTAL OCR (from start) took {t_total_end-t_ocr_start:.2f}s")
                _dbg(f"Math OCR succeeded: '{math_result['text'][:50]}...'")
                return {
                    "text": math_result["text"],
                    "confidence": math_result.get("confidence", 0.8),
                    "provider": "pix2text_math",
                    "is_mathematical": math_result.get("is_mathematical", False),
                    "processing_time": math_result.get("processing_time", 0)
                }
            else:
                _dbg("Math OCR also failed or was skipped")
        except Exception as math_error:
            _dbg(f"Math OCR error: {math_error}")
            # Clean up temp file in case of error
            if 'temp_path' in locals() and os.path.exists(temp_path):
                os.unlink(temp_path)
                _dbg("Archivo temporal eliminado (math ocr error)")

        # Final cleanup if file still exists
        if 'temp_path' in locals() and os.path.exists(temp_path):
            os.unlink(temp_path)
            _dbg("Archivo temporal eliminado (final cleanup)")

        t_total_end = time.time()
        _dbg(f"TIME: TOTAL OCR (from start) took {t_total_end-t_ocr_start:.2f}s")
        _dbg("All OCR methods failed (ONNX → Tesseract → Math)")
        return {"text": "", "confidence": 0.0, "provider": "none"}

    except Exception as e:
        if 't_ocr_start' in locals():
            t_error_end = time.time()
            _dbg(f"TIME: OCR failed after {t_error_end-t_ocr_start:.2f}s")
        _dbg(f"OCR processing failed: {e}")
        return {"text": "", "confidence": 0.0, "provider": "error"}

def diagnose_ocr_setup() -> Dict:
    """Diagnose OCR setup and capabilities (ONNX)"""
    diagnosis = {}

    try:
        ts = get_onnx_text_system()
        diagnosis["onnx_pipeline"] = ts is not None
    except Exception as e:
        diagnosis["onnx_pipeline_error"] = str(e)

    return diagnosis

# Export main functions
__all__ = ['ocr_image_to_text', 'diagnose_ocr_setup']
