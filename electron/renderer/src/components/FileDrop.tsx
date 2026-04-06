import React, { useCallback, useRef, useState } from "react";

type Props = {
	onFilesSelected: (files: File[]) => void;
};

export const FileDrop: React.FC<Props> = ({ onFilesSelected }) => {
	const [isDragging, setDragging] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const onClick = useCallback(() => {
		inputRef.current?.click();
	}, []);

	const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		setDragging(false);
		const files = Array.from(e.dataTransfer.files);
		if (files.length) onFilesSelected(files);
	}, [onFilesSelected]);

	const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files ? Array.from(e.target.files) : [];
		if (files.length) onFilesSelected(files);
	}, [onFilesSelected]);

	return (
		<div
			className={`dropzone ${isDragging ? "dragging" : ""}`}
			onDragOver={(e) => {
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
			onClick={onClick}
		>
			<input ref={inputRef} type="file" accept=".pdf,image/png,image/jpeg" onChange={onChange} style={{ display: "none" }} />
			<p>Arrastra y suelta un PDF o imagen, o haz clic para elegir</p>
		</div>
	);
};


