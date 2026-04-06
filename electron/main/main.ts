import { app, BrowserWindow, shell } from "electron";
import * as path from "path";
import { startServer, stopServer, getServerUrl } from "./server-runner";

const isDev = process.env.NODE_ENV !== "production";
let mainWindow: BrowserWindow | null = null;

async function createWindow() {
	await startServer();
	mainWindow = new BrowserWindow({
		width: 1204,
		height: 800,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (isDev) {
		const devUrl = "http://localhost:5173";
		await mainWindow.loadURL(devUrl);
		mainWindow.webContents.openDevTools({ mode: "bottom" });
	} else {
		const indexPath = path.join(__dirname, "..", "renderer", "index.html");
		await mainWindow.loadFile(indexPath);
	}

	mainWindow.webContents.setWindowOpenHandler((details) => {
		shell.openExternal(details.url);
		return { action: "deny" };
	});
}

app.on("window-all-closed", async () => {
	if (process.platform !== "darwin") {
		await stopServer();
		app.quit();
	}
});

app.on("before-quit", async (e) => {
	e.preventDefault();
	await stopServer();
	app.exit();
});

app.whenReady().then(async () => {
	await createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});


