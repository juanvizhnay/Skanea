import os
import uvicorn
from services.extract.app import app


if __name__ == "__main__":
	host = os.getenv("SKANEA_EXTRACT_HOST", "127.0.0.1")
	port = int(os.getenv("SKANEA_EXTRACT_PORT", "8001"))
	uvicorn.run(app, host=host, port=port, log_level="warning")


