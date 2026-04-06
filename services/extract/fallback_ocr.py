"""
OCR de Fallback usando Tesseract
Este módulo se activa cuando el OCR principal (ONNX) falla
Incluye detección de opciones marcadas en formularios
"""

import os
import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
import pytesseract
import logging
from typing import Dict, List, Tuple, Optional, Any
import json
import re

# Configurar logging más detallado
logging.basicConfig(
    level=logging.DEBUG,
    format='[%(asctime)s] %(levelname)s - %(name)s - %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

def _debug_log(message: str):
    """Debug logging específico para fallback OCR"""
    try:
        # Limpiar mensaje para evitar problemas de codificación
        safe_message = message.encode('ascii', 'ignore').decode('ascii')
        print(f"[FALLBACK OCR DEBUG] {safe_message}")
        logger.debug(safe_message)
    except Exception:
        print(f"[FALLBACK OCR DEBUG] <mensaje con caracteres especiales>")
        logger.debug("<mensaje con caracteres especiales>")

class FallbackOCR:
    def __init__(self):
        """Inicializar el OCR de fallback"""
        self.setup_tesseract()
        
    def setup_tesseract(self):
        """Configurar la ruta de Tesseract"""
        _debug_log("Iniciando configuración de Tesseract...")
        
        # Rutas comunes donde puede estar instalado Tesseract en Windows
        possible_paths = [
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            r"C:\Users\{}\AppData\Local\Tesseract-OCR\tesseract.exe".format(os.getenv('USERNAME')),
            r"C:\tesseract\tesseract.exe"
        ]
        
        tesseract_path = None
        for path in possible_paths:
            _debug_log(f"Verificando ruta: {path}")
            if os.path.exists(path):
                tesseract_path = path
                _debug_log(f"¡Tesseract encontrado en: {path}!")
                break
            else:
                _debug_log(f"No encontrado en: {path}")
        
        if tesseract_path:
            pytesseract.pytesseract.tesseract_cmd = tesseract_path
            _debug_log(f"Tesseract configurado correctamente: {tesseract_path}")
            
            # Probar que funcione
            try:
                test_result = pytesseract.image_to_string(Image.new('RGB', (100, 30), color='white'))
                _debug_log(f"Test de Tesseract exitoso: configuración OK")
            except Exception as e:
                _debug_log(f"ERROR en test de Tesseract: {e}")
                
        else:
            _debug_log("Tesseract no encontrado en rutas predefinidas, intentando usar PATH...")
            # Intentar usar tesseract del PATH
            try:
                test_result = pytesseract.image_to_string(Image.new('RGB', (100, 30), color='white'))
                _debug_log("Tesseract disponible en PATH - configuración OK")
            except Exception as e:
                _debug_log(f"ERROR: Tesseract no disponible: {e}")
                logger.error(f"Tesseract no disponible: {e}")
    
    def preprocess_image_for_ocr(self, image_path: str) -> List[np.ndarray]:
        """Preprocesar imagen para mejorar OCR - OPTIMIZADO PARA DATOS MÉDICOS"""
        try:
            # Cargar imagen
            image = cv2.imread(image_path)
            if image is None:
                raise ValueError(f"No se puede cargar la imagen: {image_path}")
            
            processed_images = []
            
            # Imagen original (más importante)
            processed_images.append(image)
            
            # Convertir a escala de grises
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            
            # Técnicas optimizadas para números y datos médicos
            
            # Técnica 1: Mejora de contraste agresiva (mejor para números pequeños)
            enhanced = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8,8)).apply(gray)
            _, enhanced_binary = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            processed_images.append(enhanced_binary)
            
            # Técnica 2: Binarización adaptativa (mejor para formularios)
            adaptive = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
                                           cv2.THRESH_BINARY, 11, 2)
            processed_images.append(adaptive)
            
            # Técnica 3: Enfoque específico para texto médico (reduce ruido)
            denoised = cv2.medianBlur(gray, 3)
            _, clean_binary = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            processed_images.append(clean_binary)
            
            _debug_log(f"Preprocesamiento completado: {len(processed_images)} variantes generadas")
            return processed_images
            
        except Exception as e:
            _debug_log(f"Error preprocesando imagen: {e}")
            return []
    
    def extract_text_tesseract(self, image: np.ndarray, config: str = '') -> str:
        """Extraer texto usando Tesseract"""
        try:
            # Convertir de BGR a RGB si es necesario
            if len(image.shape) == 3:
                image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            else:
                image_rgb = image
            
            # Convertir a PIL Image
            pil_image = Image.fromarray(image_rgb)
            
            # Extraer texto con configuración estándar (sin whitelist que causa problemas)
            text = pytesseract.image_to_string(pil_image, config=config, lang='spa+eng')
            
            # Limpiar caracteres problemáticos y normalizar texto
            if text:
                # Reemplazar caracteres Unicode problemáticos
                text = text.replace('\u2713', '✓')  # Check mark
                text = text.replace('\u2717', '✗')  # X mark
                text = text.replace('\u5341', '+')  # Chinese character
                
                # Limpiar otros caracteres problemáticos
                import unicodedata
                text = unicodedata.normalize('NFKD', text)
                
                # Mantener solo caracteres imprimibles ASCII y algunos Unicode básicos
                cleaned_text = ''
                for char in text:
                    if ord(char) < 128 or char in 'áéíóúüñÁÉÍÓÚÜÑ¿¡':
                        cleaned_text += char
                    elif char in '✓✗':
                        cleaned_text += char
                    else:
                        cleaned_text += ' '  # Reemplazar con espacio
                
                return cleaned_text.strip()
            
            return ""
            
        except Exception as e:
            error_msg = str(e).encode('ascii', 'ignore').decode('ascii')
            logger.error(f"Error extrayendo texto con Tesseract: {error_msg}")
            return ""
    
    def detect_checkboxes_and_radiobuttons(self, image_path: str) -> Dict[str, Any]:
        """Detectar checkboxes y radio buttons marcados - VERSIÓN OPTIMIZADA"""
        try:
            _debug_log("Iniciando detección OPTIMIZADA de elementos marcados...")
            
            image = cv2.imread(image_path)
            if image is None:
                return {"error": "No se puede cargar la imagen"}
            
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            
            # OPTIMIZACIÓN: Reducir resolución para procesamiento más rápido
            height, width = gray.shape
            if width > 800:  # Si la imagen es muy grande, reducirla
                scale = 800.0 / width
                new_width = int(width * scale)
                new_height = int(height * scale)
                gray = cv2.resize(gray, (new_width, new_height))
                _debug_log(f"Imagen redimensionada de {width}x{height} a {new_width}x{new_height}")
            
            detected_elements = []
            
            # 1. DETECTAR CÍRCULOS (radio buttons) - PARÁMETROS MÁS RESTRICTIVOS
            _debug_log("Detectando círculos (radio buttons)...")
            circles = cv2.HoughCircles(
                gray, cv2.HOUGH_GRADIENT, 1, 30,  # Aumentar distancia mínima entre círculos
                param1=100, param2=50,  # Parámetros más restrictivos
                minRadius=8, maxRadius=20  # Rango más específico
            )
            
            circle_count = 0
            if circles is not None:
                circles = np.round(circles[0, :]).astype("int")
                _debug_log(f"Círculos detectados: {len(circles)}")
                
                # LIMITAR a máximo 20 círculos para evitar exceso
                circles = circles[:20] if len(circles) > 20 else circles
                
                for (x, y, r) in circles:
                    # Ajustar coordenadas si redimensionamos
                    if width > 800:
                        x = int(x / scale)
                        y = int(y / scale)
                        r = int(r / scale)
                    
                    # Extraer región del círculo más pequeña
                    roi = gray[max(0, y-r//2):min(gray.shape[0], y+r//2), 
                              max(0, x-r//2):min(gray.shape[1], x+r//2)]
                    
                    if roi.size > 0:
                        # Verificar si está marcado de forma más simple
                        is_filled = np.mean(roi) < 180  # Umbral más permisivo
                        
                        detected_elements.append({
                            "type": "radio_button",
                            "position": (int(x), int(y)),
                            "radius": int(r),
                            "is_marked": is_filled,
                            "confidence": 0.7 if is_filled else 0.3
                        })
                        circle_count += 1
            
            _debug_log(f"Círculos procesados: {circle_count}")
            
            # 2. DETECTAR RECTÁNGULOS (checkboxes) - MÁS SIMPLE Y RÁPIDO
            _debug_log("Detectando rectángulos (checkboxes)...")
            
            # Usar detección de contornos más simple
            edges = cv2.Canny(gray, 100, 200)  # Parámetros más restrictivos
            contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            # LIMITAR contornos para evitar exceso
            contours = contours[:100] if len(contours) > 100 else contours
            _debug_log(f"Contornos a procesar: {len(contours)}")
            
            checkbox_count = 0
            for i, contour in enumerate(contours):
                area = cv2.contourArea(contour)
                
                # Filtros más restrictivos
                if 100 < area < 1000:  # Área más específica
                    x, y, w, h = cv2.boundingRect(contour)
                    aspect_ratio = float(w) / h
                    
                    # Solo cuadrados casi perfectos
                    if 0.7 <= aspect_ratio <= 1.3 and 10 <= w <= 50 and 10 <= h <= 50:
                        # Ajustar coordenadas si redimensionamos
                        if width > 800:
                            x, y, w, h = int(x/scale), int(y/scale), int(w/scale), int(h/scale)
                        
                        # Verificación rápida de si está marcado
                        roi = gray[y:y+h, x:x+w] if width <= 800 else cv2.imread(image_path, 0)[y:y+h, x:x+w]
                        
                        if roi.size > 0:
                            is_filled = np.mean(roi) < 180
                            
                            detected_elements.append({
                                "type": "checkbox",
                                "position": (int(x + w//2), int(y + h//2)),
                                "size": (int(w), int(h)),
                                "is_marked": is_filled,
                                "confidence": 0.6 if is_filled else 0.3
                            })
                            checkbox_count += 1
                            
                            # LIMITAR a máximo 30 checkboxes
                            if checkbox_count >= 30:
                                break
            
            _debug_log(f"Checkboxes procesados: {checkbox_count}")
            
            total_elements = len(detected_elements)
            marked_count = sum(1 for elem in detected_elements if elem["is_marked"])
            
            _debug_log(f"RESUMEN: {total_elements} elementos totales, {marked_count} marcados")
            
            return {
                "elements": detected_elements,
                "total_found": total_elements,
                "marked_count": marked_count
            }
            
        except Exception as e:
            error_msg = str(e).encode('ascii', 'ignore').decode('ascii')
            _debug_log(f"Error detectando elementos marcados: {error_msg}")
            return {"error": error_msg}
    
    def extract_text_near_elements(self, image_path: str, elements: List[Dict]) -> Dict[str, Any]:
        """Extraer texto asociado a elementos marcados con técnicas optimizadas para texto médico"""
        try:
            _debug_log(f"Extrayendo texto para {len(elements)} elementos...")
            
            image = cv2.imread(image_path)
            if image is None:
                return {"error": "No se puede cargar la imagen"}
            
            results = []
            
            # OPTIMIZACIÓN: Solo procesar elementos marcados
            marked_elements = [elem for elem in elements if elem.get("is_marked", False)]
            _debug_log(f"Procesando solo {len(marked_elements)} elementos marcados")
            
            # LIMITAR a máximo 10 elementos para evitar bucle infinito
            marked_elements = marked_elements[:10]
            
            for i, element in enumerate(marked_elements):
                _debug_log(f"Procesando elemento marcado {i+1}/{len(marked_elements)}")
                
                x, y = element["position"]
                
                # REGIONES OPTIMIZADAS para capturar opciones médicas
                best_text = ""
                
                # 1. Región horizontal más amplia para capturar toda la opción
                line_height = 35  # Altura optimizada
                line_y_start = max(0, y - line_height//2)
                line_y_end = min(image.shape[0], y + line_height//2)
                
                # 2. Capturar desde después del checkbox hasta el final de la línea
                text_x_start = min(image.shape[1] - 100, x + 40)  # Más espacio después del checkbox
                line_region = image[line_y_start:line_y_end, text_x_start:image.shape[1]]
                
                if line_region.size > 0:
                    # PREPROCESAMIENTO BALANCEADO para texto médico
                    # 1. Convertir a escala de grises
                    if len(line_region.shape) == 3:
                        gray_region = cv2.cvtColor(line_region, cv2.COLOR_BGR2GRAY)
                    else:
                        gray_region = line_region
                    
                    # 2. Mejorar contraste moderadamente (menos agresivo)
                    enhanced_region = cv2.convertScaleAbs(gray_region, alpha=1.2, beta=5)
                    
                    # 3. Threshold adaptativo más suave
                    thresh_region = cv2.adaptiveThreshold(
                        enhanced_region, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 15, 3
                    )
                    
                    # 4. Morphological closing muy sutil para conectar caracteres sin distorsionar
                    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 1))
                    final_region = cv2.morphologyEx(thresh_region, cv2.MORPH_CLOSE, kernel)
                    
                    # ENFOQUE SIMPLE Y DIRECTO: Solo las mejores técnicas probadas
                    
                    # 1. Primero intentar con imagen original + configuración médica
                    try:
                        text = self.extract_text_tesseract(gray_region, '--psm 7')
                        if text and len(text.strip()) > 8:
                            # Validar que parece texto médico real
                            clean_text = ' '.join(text.split())
                            if any(word in clean_text.lower() for word in ['nefritis', 'lupica', 'sindrome', 'glomerulo', 'pielonefritis']):
                                best_text = clean_text
                                _debug_log(f"    ✓ Texto médico encontrado (directo): '{clean_text[:50]}...'")
                    except:
                        pass
                    
                    # 2. Si no encontramos nada específico, usar extracción mejorada pero conservadora
                    if not best_text:
                        try:
                            # Configuración balanceada para términos médicos
                            text = pytesseract.image_to_string(
                                enhanced_region,
                                config='-l spa+eng --psm 8 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzáéíóúñüÁÉÍÓÚÑÜ0123456789 .'
                            ).strip()
                            
                            if text:
                                clean_text = ' '.join(text.split())
                                if len(clean_text) >= 5 and any(c.isalpha() for c in clean_text):
                                    best_text = clean_text
                                    _debug_log(f"    ✓ Texto médico encontrado (mejorado): '{clean_text[:50]}...'")
                        except:
                            pass
                    
                    # 3. Como último recurso, usar método básico sin filtros
                    if not best_text:
                        try:
                            text = pytesseract.image_to_string(gray_region, config='-l spa+eng --psm 6').strip()
                            if text and len(text) >= 3:
                                clean_text = ' '.join(text.split())
                                if any(c.isalpha() for c in clean_text):
                                    best_text = clean_text
                                    _debug_log(f"    ✓ Texto básico encontrado: '{clean_text[:50]}...'")
                        except:
                            pass
                
                if best_text.strip():
                    # Limpiar el texto encontrado
                    clean_text = best_text.replace('\n', ' ').replace('\r', '').strip()
                    clean_text = ' '.join(clean_text.split())  # Normalizar espacios
                    
                    # Filtrar texto que obviamente no es una opción médica
                    if len(clean_text) >= 5 and any(c.isalpha() for c in clean_text):
                        results.append({
                            "element": element,
                            "associated_text": clean_text,
                            "text_region_size": line_region.shape if line_region.size > 0 else (0, 0)
                        })
                        _debug_log(f"  ✓ Texto médico final: '{clean_text[:80]}...'")
                    else:
                        _debug_log(f"  ✗ Texto filtrado por calidad: '{clean_text}'")
                else:
                    _debug_log(f"  ✗ No se encontró texto médico legible")
            
            _debug_log(f"Asociaciones de texto completadas: {len(results)}")
            return {"text_associations": results}
            
        except Exception as e:
            error_msg = str(e).encode('ascii', 'ignore').decode('ascii')
            _debug_log(f"Error extrayendo texto cerca de elementos: {error_msg}")
            return {"error": error_msg}
    
    def process_form_image(self, image_path: str) -> Dict[str, Any]:
        """Procesar imagen de formulario completa"""
        import time
        start_time = time.time()
        TIMEOUT_SECONDS = 30  # Máximo 30 segundos para evitar bucles infinitos
        
        try:
            _debug_log(f"=== INICIANDO FALLBACK OCR ===")
            _debug_log(f"Imagen a procesar: {image_path}")
            _debug_log(f"¿Existe la imagen?: {os.path.exists(image_path)}")
            
            if not os.path.exists(image_path):
                _debug_log(f"ERROR: La imagen no existe: {image_path}")
                return {"success": False, "error": "Imagen no encontrada"}
            
            # 1. Extraer todo el texto con múltiples técnicas
            _debug_log("Paso 1: Preprocesando imagen...")
            processed_images = self.preprocess_image_for_ocr(image_path)
            _debug_log(f"Se generaron {len(processed_images)} variantes de imagen")
            all_text_results = []
            
            # OPTIMIZACIÓN: Usar solo las mejores variantes
            best_variants = processed_images[:2]  # Solo 2 variantes como funcionaba bien
            
            for i, proc_img in enumerate(best_variants):
                _debug_log(f"Procesando variante {i+1}/{len(best_variants)}")
                
                # Solo las configuraciones que funcionaron bien
                configs = [
                    '--psm 6',   # Uniform block of text
                    '--psm 4',   # Single column of text
                ]
                
                for j, config in enumerate(configs):
                    _debug_log(f"  Probando configuración: {config}")
                    try:
                        text = self.extract_text_tesseract(proc_img, config)
                        if text and len(text) > 50:  # Solo textos significativos
                            _debug_log(f"  ✓ Texto extraído ({len(text)} chars): '{text[:100]}...'")
                            all_text_results.append({
                                "preprocessing": f"technique_{i}",
                                "config": config,
                                "text": text,
                                "length": len(text)
                            })
                            
                            # BREAK EARLY: Si encontramos texto bueno
                            if len(text) > 600:  # Umbral más realista
                                _debug_log(f"  ✓ Texto suficientemente bueno encontrado, terminando búsqueda")
                                break
                        else:
                            _debug_log(f"  ✗ Texto insuficiente con {config}")
                    except Exception as e:
                        _debug_log(f"  ✗ Error con {config}: {str(e)[:100]}")
                
                # Verificar timeout
                if time.time() - start_time > TIMEOUT_SECONDS:
                    _debug_log(f"⚠️ TIMEOUT alcanzado ({TIMEOUT_SECONDS}s), terminando procesamiento")
                    break
                
                # Si ya tenemos resultados buenos, no procesar más variantes
                if all_text_results and max(all_text_results, key=lambda x: x["length"])["length"] > 600:
                    _debug_log("✓ Resultado suficientemente bueno encontrado, terminando procesamiento")
                    break
            
            # 2. Detectar elementos marcados (VERSIÓN OPTIMIZADA)
            _debug_log("Paso 2: Detectando elementos marcados (versión optimizada)...")
            marked_elements = {"elements": [], "total_found": 0, "marked_count": 0}
            text_associations = {}
            
            # Solo detectar elementos si tenemos tiempo y el texto principal ya fue extraído
            if time.time() - start_time < TIMEOUT_SECONDS - 15 and all_text_results:  # Reservar 15s
                try:
                    marked_elements = self.detect_checkboxes_and_radiobuttons(image_path)
                    _debug_log(f"Elementos detectados: {marked_elements.get('total_found', 0)}")
                    _debug_log(f"Elementos marcados: {marked_elements.get('marked_count', 0)}")
                    
                    # 3. Extraer texto asociado solo si hay pocos elementos marcados
                    if (time.time() - start_time < TIMEOUT_SECONDS - 10 and 
                        marked_elements.get('marked_count', 0) <= 10):  # Máximo 10 elementos marcados
                        
                        if "elements" in marked_elements and marked_elements["elements"]:
                            _debug_log("Extrayendo texto asociado a elementos marcados...")
                            text_associations = self.extract_text_near_elements(image_path, marked_elements["elements"])
                            _debug_log(f"Asociaciones completadas: {len(text_associations.get('text_associations', []))}")
                    else:
                        _debug_log("Omitiendo extracción de texto asociado (demasiados elementos o poco tiempo)")
                        
                except Exception as e:
                    _debug_log(f"Error en detección de elementos (continuando): {str(e)[:100]}")
                    marked_elements = {"elements": [], "total_found": 0, "marked_count": 0}
            else:
                _debug_log("Omitiendo detección de elementos marcados (poco tiempo restante o sin texto principal)")
            
            # 4. Compilar resultado final
            _debug_log("Paso 4: Compilando resultado final...")
            best_text = max(all_text_results, key=lambda x: x["length"])["text"] if all_text_results else ""
            _debug_log(f"Mejor texto encontrado: '{best_text[:150]}...' ({len(best_text)} caracteres)")
            
            result = {
                "success": True,
                "extraction_method": "tesseract_fallback",
                "full_text_attempts": len(all_text_results),
                "best_text": best_text,
                "all_text_results": all_text_results,
                "marked_elements": marked_elements,
                "text_associations": text_associations,
                "metadata": {
                    "image_path": image_path,
                    "processing_techniques": len(processed_images),
                    "total_elements_found": marked_elements.get("total_found", 0),
                    "marked_elements_count": marked_elements.get("marked_count", 0)
                }
            }
            
            _debug_log(f"=== FALLBACK OCR COMPLETADO EXITOSAMENTE ===")
            _debug_log(f"Caracteres extraídos: {len(result['best_text'])}")
            _debug_log(f"Intentos de texto: {result['full_text_attempts']}")
            _debug_log(f"Elementos marcados: {result['metadata']['marked_elements_count']}")
            return result
            
        except Exception as e:
            _debug_log(f"=== ERROR EN FALLBACK OCR ===")
            _debug_log(f"Error: {str(e)}")
            _debug_log(f"Tipo de error: {type(e).__name__}")
            import traceback
            _debug_log(f"Traceback: {traceback.format_exc()}")
            logger.error(f"Error en fallback OCR: {e}")
            return {
                "success": False,
                "error": str(e),
                "extraction_method": "tesseract_fallback"
            }
    
    def format_quiz_response(self, ocr_result: Dict[str, Any]) -> Dict[str, Any]:
        """Formatear respuesta específicamente para quizzes/exámenes"""
        try:
            formatted_result = {
                "text": ocr_result.get("best_text", ""),
                "success": ocr_result.get("success", False),
                "method": "tesseract_fallback"
            }
            
            # Analizar elementos marcados para identificar respuestas
            if "marked_elements" in ocr_result and "elements" in ocr_result["marked_elements"]:
                marked_options = []
                for element in ocr_result["marked_elements"]["elements"]:
                    if element.get("is_marked", False):
                        marked_options.append({
                            "position": element["position"],
                            "type": element["type"],
                            "confidence": element.get("confidence", 0)
                        })
                
                formatted_result["marked_options"] = marked_options
                formatted_result["selected_answers_count"] = len(marked_options)
            
            # Agregar texto asociado a opciones marcadas
            if "text_associations" in ocr_result and "text_associations" in ocr_result["text_associations"]:
                option_texts = []
                for assoc in ocr_result["text_associations"]["text_associations"]:
                    if assoc["element"].get("is_marked", False):
                        option_texts.append(assoc["associated_text"])
                
                if option_texts:
                    formatted_result["selected_option_texts"] = option_texts
            
            return formatted_result
            
        except Exception as e:
            logger.error(f"Error formateando respuesta de quiz: {e}")
            return {
                "text": "",
                "success": False,
                "error": str(e),
                "method": "tesseract_fallback"
            }

# Función principal para ser llamada desde el exterior
def fallback_ocr_extract(image_path: str) -> Dict[str, Any]:
    """
    Función principal para extraer texto usando OCR de fallback
    """
    try:
        fallback = FallbackOCR()
        result = fallback.process_form_image(image_path)
        return fallback.format_quiz_response(result)
    except Exception as e:
        logger.error(f"Error en fallback OCR extract: {e}")
        return {
            "text": "",
            "success": False,
            "error": str(e),
            "method": "tesseract_fallback"
        }

if __name__ == "__main__":
    # Prueba del sistema
    test_image = "test_image.jpg"  # Reemplazar con ruta real
    if os.path.exists(test_image):
        result = fallback_ocr_extract(test_image)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print("Imagen de prueba no encontrada")