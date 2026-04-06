import React from "react";

type Page = { number: number; text: string; confidence: number };
type Data = {
	ok: boolean;
	is_native?: boolean;
	hash: string;
	meta: { pages: number; lang: string; cache_hit?: boolean };
	confidence: number;
	pages: Page[];
	full_text: string;
	warnings: string[];
};

export const ExtractPreview: React.FC<{ data: Data }> = ({ data }) => {
	return (
		<div className="preview">
			<div className="meta">
				<div>
					<strong>Hash:</strong> {data.hash}
				</div>
				<div>
					<strong>Páginas:</strong> {data.meta.pages}
				</div>
				{typeof data.is_native === "boolean" && (
					<div>
						<strong>Nativo:</strong> {data.is_native ? "Sí" : "No"}
					</div>
				)}
				{data.meta.cache_hit && (
					<div className="badge">Cache hit</div>
				)}
				<div>
					<strong>Confianza promedio:</strong> {data.confidence.toFixed(1)}
				</div>
			</div>
			<div className="pages">
				{data.pages.map((p) => (
					<div key={p.number} className="page">
						<h3>Página {p.number} — {p.confidence.toFixed(1)}%</h3>
						<pre>{p.text}</pre>
					</div>
				))}
			</div>
		</div>
	);
};


