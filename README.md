# Skanea

AI desktop assistant migrated from a Chrome extension to an Electron desktop application. It integrates chat with multiple AI providers, advanced OCR for text and image extraction, document generation and export, web search, voice transcription, and connectors for external services such as Google Drive.

## Project Structure

```text
Skanea/
|-- app/                    # Frontend (React + Vite)
|   |-- src/
|   |   `-- popup/          # Main components (Chat, Settings, etc.)
|   |-- manifest.json
|   `-- vite.config.js
|-- backend/                # Server API (Node.js + Express)
|   |-- server.js           # Main server with intent detection
|   |-- routes/             # API routes
|   |-- controllers/        # Controllers
|   |-- services/           # Services (AI, export, images, Whisper, etc.)
|   |   |-- ai/             # AI provider router
|   |   `-- models/         # Model management
|   |-- models/             # Data models (MongoDB/Postgres)
|   |-- middleware/         # Authentication, signup protection
|   |-- config/             # MongoDB and Redis configuration
|   `-- utils/              # Utilities (crypto, rate limiting, etc.)
|-- electron/               # Electron shell
|   |-- main.js             # Main process
|   |-- preload.js          # Preload script
|   `-- server-runner.js    # Backend server runner
|-- services/
|   `-- extract/            # OCR and extraction service (Python/FastAPI)
|       |-- app.py          # FastAPI API
|       |-- ocr.py          # Main OCR with multi-level heuristics
|       |-- math_ocr.py     # OCR specialized for mathematics
|       |-- fallback_ocr.py # Fallback OCR with adaptive detection
|       |-- pdf_extract.py  # PDF text extraction
|       `-- cache.py        # OCR results cache
`-- package.json            # Root dependencies and Electron scripts
```

## Prerequisites

- **Node.js** >= 18
- **Python** >= 3.12 (for the extraction/OCR service)
- **MongoDB** (local or Atlas)
- **PostgreSQL** (for relational data)
- **Redis** (local or Redis Cloud)
- **Tesseract OCR** installed on the system (required by `pytesseract`)

### Optional External Dependencies

- **whisper.cpp**: Precompiled binaries for audio transcription. Download them from [whisper.cpp releases](https://github.com/ggerganov/whisper.cpp/releases) and place them in `backend/whisper-binaries/`.
- **PaddleOCR ONNX**: ONNX models for advanced OCR. Clone [PaddleOCRv3-ONNX-Sample](https://github.com/nicklgw/PaddleOCRv3-ONNX-Sample) into the project root as `PaddleOCRv3-ONNX-Sample-main/`.

## Installation

### 1. Main Project Dependencies (Electron)

```bash
npm install
```

### 2. Frontend Dependencies

```bash
npm run install:frontend
```

### 3. Backend Dependencies

```bash
cd backend
npm install
```

### 4. Extraction Service (Python)

```bash
cd services/extract
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux/macOS
source .venv/bin/activate

pip install -r requirements.txt
```

### 5. Environment Variables

Copy the example file and fill it in with your credentials:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your API keys and service credentials (OpenAI, MongoDB, Redis, etc.).

## Development

To run the application in development mode:

```bash
npm run dev
```

This will start:

- The Vite development server at `http://localhost:5173`
- The Electron application connected to the development server

To start the backend server separately:

```bash
cd backend
node server.js
```

To start the OCR extraction service:

```bash
cd services/extract
uvicorn app:app --host 0.0.0.0 --port 8100
```

## Build

To build the application for distribution:

```bash
npm run build
```

This generates the production files in `dist-electron/`.

## Features

- Chat with multiple AI providers (OpenAI, local models via Ollama, FAL)
- Intelligent user intent detection in messages
- Multi-level OCR with advanced heuristics (text, mathematics, formulas)
- Text extraction from PDFs, DOCX, PPTX, XLSX, and CSV files
- Document generation and export (PDF, DOCX, PPTX, XLSX, CSV, TXT)
- AI image generation
- Audio transcription with Whisper
- Integrated web search (Google Custom Search)
- Google Drive connectors (file upload/download)
- Persistent conversation history
- Workspaces for organizing conversations
- Authentication with JWT and Google OAuth
- Responsive interface with dark theme
- Voice recognition for text input

## Project Status

This project is in active development (~80% of features completed). Some features may be partially implemented or still being improved.
