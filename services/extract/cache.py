import hashlib
import json
import os
from typing import Any, Optional


CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")


def ensure_cache_dir() -> None:
	if not os.path.isdir(CACHE_DIR):
		os.makedirs(CACHE_DIR, exist_ok=True)


def compute_sha256(data: bytes) -> str:
	sha = hashlib.sha256()
	sha.update(data)
	return sha.hexdigest()


def get_cache_path(sha256_hex: str) -> str:
	return os.path.join(CACHE_DIR, f"{sha256_hex}.json")


def load_cache(sha256_hex: str) -> Optional[dict[str, Any]]:
	ensure_cache_dir()
	path = get_cache_path(sha256_hex)
	if not os.path.isfile(path):
		return None
	try:
		with open(path, "r", encoding="utf-8") as f:
			return json.load(f)
	except Exception:
		return None


def write_cache(sha256_hex: str, payload: dict[str, Any]) -> None:
	ensure_cache_dir()
	path = get_cache_path(sha256_hex)
	with open(path, "w", encoding="utf-8") as f:
		json.dump(payload, f, ensure_ascii=False, indent=2)


