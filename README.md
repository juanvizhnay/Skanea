# Skanea

Asistente de escritorio con IA, migrado desde una extension de Chrome a una aplicacion Electron de escritorio. Integra chat con multiples proveedores de IA, OCR avanzado para extraccion de texto/imagenes, generacion y exportacion de documentos, busqueda web, transcripcion de voz, y conectores con servicios externos como Google Drive.

## Estructura del Proyecto

```
Skanea/
├── app/                    # Frontend (React + Vite)
│   ├── src/
│   │   └── popup/          # Componentes principales (Chat, Settings, etc.)
│   ├── manifest.json
│   └── vite.config.js
├── backend/                # API del servidor (Node.js + Express)
│   ├── server.js           # Servidor principal con deteccion de intenciones
│   ├── routes/             # Rutas de la API
│   ├── controllers/        # Controladores
│   ├── services/           # Servicios (AI, exportacion, imagenes, whisper, etc.)
│   │   ├── ai/             # Router de proveedores de IA
│   │   └── models/         # Gestion de modelos
│   ├── models/             # Modelos de datos (MongoDB/Postgres)
│   ├── middleware/          # Autenticacion, proteccion de signup
│   ├── config/             # Configuracion de MongoDB, Redis
│   └── utils/              # Utilidades (crypto, rate limit, etc.)
├── electron/               # Shell de Electron
│   ├── main.js             # Proceso principal
│   ├── preload.js          # Script de precarga
│   └── server-runner.js    # Runner del servidor backend
├── services/
│   └── extract/            # Servicio de OCR y extraccion (Python/FastAPI)
│       ├── app.py          # API FastAPI
│       ├── ocr.py          # OCR principal con heuristicas multinivel
│       ├── math_ocr.py     # OCR especializado en matematicas
│       ├── fallback_ocr.py # OCR de respaldo con deteccion adaptativa
│       ├── pdf_extract.py  # Extraccion de texto de PDFs
│       └── cache.py        # Cache de resultados OCR
└── package.json            # Dependencias raiz y scripts de Electron
```

## Requisitos Previos

- **Node.js** >= 18
- **Python** >= 3.12 (para el servicio de extraccion/OCR)
- **MongoDB** (local o Atlas)
- **PostgreSQL** (para datos relacionales)
- **Redis** (local o Redis Cloud)
- **Tesseract OCR** instalado en el sistema (requerido por `pytesseract`)

### Dependencias externas opcionales

- **whisper.cpp**: Binarios precompilados para transcripcion de audio. Descargar desde [whisper.cpp releases](https://github.com/ggerganov/whisper.cpp/releases) y colocar en `backend/whisper-binaries/`.
- **PaddleOCR ONNX**: Modelos ONNX para OCR avanzado. Clonar [PaddleOCRv3-ONNX-Sample](https://github.com/nicklgw/PaddleOCRv3-ONNX-Sample) en la raiz del proyecto como `PaddleOCRv3-ONNX-Sample-main/`.

## Instalacion

### 1. Dependencias del proyecto principal (Electron)

```bash
npm install
```

### 2. Dependencias del frontend

```bash
npm run install:frontend
```

### 3. Dependencias del backend

```bash
cd backend
npm install
```

### 4. Servicio de extraccion (Python)

```bash
cd services/extract
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux/macOS
source .venv/bin/activate

pip install -r requirements.txt
```

### 5. Variables de entorno

Copiar el archivo de ejemplo y completar con tus credenciales:

```bash
cp backend/.env.example backend/.env
```

Editar `backend/.env` con tus claves de API (OpenAI, MongoDB, Redis, etc.).

## Desarrollo

Para ejecutar la aplicacion en modo desarrollo:

```bash
npm run dev
```

Esto iniciara:
- El servidor de desarrollo de Vite en `http://localhost:5173`
- La aplicacion Electron conectada al servidor de desarrollo

Para iniciar el servidor backend por separado:

```bash
cd backend
node server.js
```

Para iniciar el servicio de extraccion OCR:

```bash
cd services/extract
uvicorn app:app --host 0.0.0.0 --port 8100
```

## Construccion

Para construir la aplicacion para distribucion:

```bash
npm run build
```

Genera los archivos de produccion en `dist-electron/`.

## Funcionalidades

- Chat con multiples proveedores de IA (OpenAI, modelos locales via Ollama, FAL)
- Deteccion inteligente de intenciones del usuario en mensajes
- OCR multinivel con heuristicas avanzadas (texto, matematicas, formulas)
- Extraccion de texto desde PDFs, DOCX, PPTX, XLSX, CSV
- Generacion y exportacion de documentos (PDF, DOCX, PPTX, XLSX, CSV, TXT)
- Generacion de imagenes con IA
- Transcripcion de audio con Whisper
- Busqueda web integrada (Google Custom Search)
- Conectores con Google Drive (subida/descarga de archivos)
- Historial de conversaciones persistente
- Workspaces para organizar conversaciones
- Autenticacion con JWT y Google OAuth
- Interfaz responsive con tema oscuro
- Reconocimiento de voz para entrada de texto

## Estado del Proyecto

Este proyecto se encuentra en desarrollo activo (~80% de funcionalidades completadas). Algunas caracteristicas pueden estar parcialmente implementadas o en proceso de mejora.
