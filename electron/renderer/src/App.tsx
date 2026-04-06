import React, { useState } from "react";
import { FileDrop } from "./components/FileDrop";
import { ExtractPreview } from "./components/ExtractPreview";
import { extractPdf, extractImage } from "./lib/api";

export const App: React.FC = () => {
	const [loading, setLoading] = useState(false);
	const [progress, setProgress] = useState(0);
	const [result, setResult] = useState<any | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function onFilesSelected(files: File[]) {
		setError(null);
		setResult(null);
		setLoading(true);
		setProgress(0);
		try {
			const file = files[0];
			const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
			const onProgress = (p: number) => setProgress(p);
			const res = isPdf ? await extractPdf(file, onProgress) : await extractImage(file, onProgress);
			setResult(res);
		} catch (e: any) {
			setError(e?.message || "Error desconocido");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="container">
			<h1>Skanea Extract</h1>
			<FileDrop onFilesSelected={onFilesSelected} />
			{loading && (
				<div className="progress">
					<div className="bar" style={{ width: `${Math.floor(progress)}%` }} />
					<div className="label">{Math.floor(progress)}%</div>
				</div>
			)}
			{error && <div className="error">{error}</div>}
			{result && <ExtractPreview data={result} />}
		</div>
	);
};


