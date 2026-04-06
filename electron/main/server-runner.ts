import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as http from "http";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { app as electronApp } from "electron";

let serverProcess: ChildProcessWithoutNullStreams | null = null;
const PORT = process.env.SKANEA_EXTRACT_PORT || "8001";
const HOST = process.env.SKANEA_EXTRACT_HOST || "127.0.0.1";

export function getServerUrl(): string {
	return `http://${HOST}:${PORT}`;
}

export async function startServer(): Promise<void> {
	if (serverProcess) return;
	const isPackaged = !!electronApp?.isPackaged;
	// Project root: from dist/main → up three levels to electron/ → up one more to repo root
	const projectRoot = path.join(__dirname, "..", "..", "..");
	// Use python -m uvicorn services.extract.app:app --host HOST --port PORT
	const venvPython = os.platform() === "win32"
		? path.join(projectRoot, "services", "extract", ".venv312_extract", "Scripts", "python.exe")
        : path.join(projectRoot, "services", "extract", ".venv312_extract", "bin", "python");
    const hasVenvPython = fs.existsSync(venvPython);
	const rootVenvPython = os.platform() === "win32"
		? path.join(projectRoot, ".venv312_extract", "Scripts", "python.exe")
		: path.join(projectRoot, ".venv312_extract", "bin", "python");
	const hasRootVenvPython = fs.existsSync(rootVenvPython);
	if (isPackaged) {
		const binName = os.platform() === "win32" ? "skanea-extract.exe" : "skanea-extract";
		const binPath = path.join(process.resourcesPath, "server", binName);
		if (fs.existsSync(binPath)) {
			serverProcess = spawn(binPath, [], {
				cwd: process.resourcesPath,
				env: { ...process.env },
			});
		} else {
			// Fallback to dev-style spawn if binary not found
			const pythonExecutable = process.env.SKANEA_PYTHON || (hasRootVenvPython ? rootVenvPython : (hasVenvPython ? venvPython : (os.platform() === "win32" ? "python" : "python3")));
			console.log(`[extract] launching uvicorn (packaged-fallback) with ${pythonExecutable} at http://${HOST}:${PORT}`);
			serverProcess = spawn(pythonExecutable, [
				"-m",
				"uvicorn",
				"services.extract.app:app",
				"--host",
				HOST,
				"--port",
				PORT,
				"--log-level",
				"error",
			], {
				cwd: projectRoot,
				env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: "2", NO_ALBUMENTATIONS_UPDATE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTHONWARNINGS: "ignore", SK_EXTRACT_DEBUG: process.env.SK_EXTRACT_DEBUG || "0" },
			});
		}
	} else {
		const pythonExecutable = process.env.SKANEA_PYTHON || (hasRootVenvPython ? rootVenvPython : (hasVenvPython ? venvPython : (os.platform() === "win32" ? "python" : "python3")));
		console.log(`[extract] launching uvicorn (dev) with ${pythonExecutable} at http://${HOST}:${PORT}`);
		serverProcess = spawn(pythonExecutable, [
			"-m",
			"uvicorn",
			"services.extract.app:app",
			"--host",
			HOST,
			"--port",
			PORT,
			"--log-level",
			"error",
		], {
			cwd: projectRoot,
			env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: "2", NO_ALBUMENTATIONS_UPDATE: "1", HF_HUB_DISABLE_TELEMETRY: "1", PYTHONWARNINGS: "ignore", SK_EXTRACT_DEBUG: process.env.SK_EXTRACT_DEBUG || "0" },
		});
	}

	serverProcess.stdout.on("data", (data) => {
		console.log(`[uvicorn] ${data}`);
	});
	serverProcess.stderr.on("data", (data) => {
		console.error(`[uvicorn] ${data}`);
	});
	serverProcess.on("close", (code) => {
		console.log(`uvicorn exited with code ${code}`);
		serverProcess = null;
	});

	// Poll /health to ensure readiness (up to 30s)
	const baseUrl = `http://${HOST}:${PORT}`;
	const deadline = Date.now() + 30000;
	await new Promise<void>((resolve) => {
		const ping = () => {
			http.get(`${baseUrl}/health`, (res) => {
				if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
					res.resume();
					return resolve();
				}
				res.resume();
				if (Date.now() > deadline) return resolve();
				setTimeout(ping, 500);
			}).on("error", () => {
				if (Date.now() > deadline) return resolve();
				setTimeout(ping, 500);
			});
		};
		ping();
	});
}

export async function stopServer(): Promise<void> {
	if (!serverProcess) return;
	return new Promise((resolve) => {
		serverProcess?.once("exit", () => resolve());
		serverProcess?.kill();
		serverProcess = null;
	});
}


