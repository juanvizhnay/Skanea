const API_BASE = import.meta.env.VITE_EXTRACT_URL || "http://127.0.0.1:8001";

async function uploadWithProgress(url: string, file: File, onProgress?: (p: number) => void) {
	return new Promise<any>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", url);
		xhr.responseType = "json";
		xhr.upload.onprogress = (evt) => {
			if (evt.lengthComputable && onProgress) {
				onProgress((evt.loaded / evt.total) * 100);
			}
		};
		xhr.onerror = () => reject(new Error("Network error"));
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
			else reject(new Error(xhr.response?.error || `HTTP ${xhr.status}`));
		};
		const form = new FormData();
		form.append("file", file);
		xhr.send(form);
	});
}

export async function extractPdf(file: File, onProgress?: (p: number) => void) {
	return uploadWithProgress(`${API_BASE}/extract/pdf`, file, onProgress);
}

export async function extractImage(file: File, onProgress?: (p: number) => void) {
	return uploadWithProgress(`${API_BASE}/extract/image`, file, onProgress);
}

// Hooks utilitarios para enviar a LLM (no implementado)
export function enqueueForLLM(_data: any) {
	// placeholder
	return;
}


