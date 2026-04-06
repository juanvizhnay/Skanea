import React, { useState, useEffect, useRef, useMemo } from 'react';

// console.log('[TW-MODULE] 🔥 TypewriterText módulo cargado - VERSIÓN CON REACT.MEMO');

// Map global para persist progress across unmount/remount
// Key: text content, Value: { index, displayedText }
const typewriterProgressMap = new Map();

const TypewriterTextComponent = ({ text, speed = 30, onComplete, forceTypewriter = true, interrupt = false, onProgress, batchSize = 3 }) => {
  const mountIdRef = useRef(`mount-${Math.random().toString(36).slice(2,8)}`);

  useEffect(() => {
    // Intentar restaurar progreso previo si existe
    const textKey = String(text || '');
    const savedProgress = typewriterProgressMap.get(textKey);
    if (savedProgress && forceTypewriter) {
      indexRef.current = savedProgress.index;
      setDisplayedText(savedProgress.displayedText);
      if (savedProgress.index >= textKey.length) {
        setIsComplete(true);
      }
    }

    return () => {
      // Guardar progreso antes de desmontar
      if (text && forceTypewriter && indexRef.current > 0) {
        typewriterProgressMap.set(String(text), {
          index: indexRef.current,
          displayedText: displayedText
        });
      }
    };
  }, []);

  // Debug log (commented for production)
  // console.log('[TW-RENDER]', { textLength: String(text || '').length });

  const [displayedText, setDisplayedText] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const timeoutRef = useRef(null);
  const onCompleteRef = useRef(onComplete);
  const indexRef = useRef(0);

  // Precalcular caracteres seguros (maneja pares surrogados y combinaciones)
  const charArray = useMemo(() => Array.from(String(text || '')), [text]);

  // Actualizar la referencia de onComplete
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Interrupción externa: completar inmediatamente
  useEffect(() => {
    if (interrupt && !isComplete) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      // Detener en el punto actual sin completar el texto ni disparar onComplete
      setIsComplete(true);
    }
  }, [interrupt, isComplete, text]);

  // Efecto principal
  useEffect(() => {
    // Debug desactivado en producción
    // console.log('[TW-EFFECT] ⚡ Efecto principal ejecutado. Valores:', {
    //   textLength: String(text || '').length,
    //   textPreview: String(text || '').substring(0, 30),
    //   forceTypewriter,
    //   speed,
    //   currentIndex: indexRef.current,
    //   displayedLength: displayedText.length
    // });

    // Limpiar timeout anterior
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (!text) {
      setDisplayedText('');
      setIsComplete(false);
      if (onCompleteRef.current) onCompleteRef.current();
      return;
    }

    // Si no se debe forzar el typewriter, mostrar el texto completo inmediatamente
    if (!forceTypewriter) {
      setDisplayedText(text);
      setIsComplete(true);
      if (onCompleteRef.current) onCompleteRef.current();
      return;
    }

    // Reset para typewriter
    setDisplayedText('');
    setIsComplete(false);
    indexRef.current = 0;

    const typeNextChar = () => {
      const currentIndex = indexRef.current;
      if (currentIndex >= charArray.length) {
        setIsComplete(true);
        if (onCompleteRef.current) onCompleteRef.current();
        return;
      }

      // Batch processing: procesar múltiples caracteres a la vez para reducir renders
      const nextIndex = Math.min(currentIndex + batchSize, charArray.length);
      const nextText = charArray.slice(0, nextIndex).join('');
      setDisplayedText(nextText);
      if (onProgress) { try { onProgress(nextText); } catch {} }
      indexRef.current = nextIndex;

      timeoutRef.current = setTimeout(typeNextChar, speed);
    };

    // Iniciar typewriter
    timeoutRef.current = setTimeout(typeNextChar, speed);

    // Cleanup
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [charArray, text, forceTypewriter, speed]);

  // Renderer con HTML seguro: bold/italic/inline-code, saltos, y linkify completo
  const renderFormatted = (value) => {
    let text = String(value || '');

    // Insertar saltos por oraciones para textos largos sin saltos
    if (text.length > 220 && !/\n/.test(text)) {
      text = text.replace(/([.!?])\s+(?=[A-ZÁÉÍÓÚÑ])/g, '$1\n\n');
    }
    // Negrita automática del sujeto si no hay ** **
    if (!/\*\*/.test(text)) {
      const m = text.match(/^(.{3,60}?)\ses\s/i);
      if (m && m[1]) {
        const lead = m[1].trim();
        text = `**${lead}**` + text.slice(lead.length);
      }
    }

    // Escapar HTML básico y aplicar formato mínimo + linkify
    const escapeHtml = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    // Procesar tablas Markdown ANTES del escape HTML
    const tableMatches = [];

    // Función para procesar contenido de celdas: escapar HTML pero mantener <br> como saltos
    const processCellContent = (cell) => {
      let content = cell.trim();
      // Primero escapar caracteres peligrosos
      content = escapeHtml(content);
      // Convertir <br> literal en saltos de línea HTML reales
      content = content.replace(/&lt;br&gt;/gi, '<br/>');
      content = content.replace(/&lt;br\/&gt;/gi, '<br/>');
      // Convertir • seguido de espacio en bullet con salto
      content = content.replace(/•\s*/g, '<br/>• ');
      // Si empieza con <br/>, quitarlo
      content = content.replace(/^<br\/>/, '');
      return content;
    };

    let textWithPlaceholders = text.replace(/(\|.+\|(?:\r?\n)\|[-:| ]+\|(?:\r?\n)(?:\|.+\|(?:\r?\n)?)*)/g, (tableMatch, offset) => {
      const lines = tableMatch.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 3) return tableMatch;

      const headers = lines[0].split('|').map(h => h.trim()).filter(Boolean);
      const rows = lines.slice(2).map(row => row.split('|').map(cell => cell.trim()).filter(Boolean));

      let table = '<div class="sk-table-wrapper">';
      table += '<table class="sk-table"><thead><tr>';
      headers.forEach(h => { table += `<th>${escapeHtml(h)}</th>`; });
      table += '</tr></thead><tbody>';
      rows.forEach(row => {
        table += '<tr>';
        row.forEach(cell => { table += `<td>${processCellContent(cell)}</td>`; });
        table += '</tr>';
      });
      table += '</tbody></table>';

      // Agregar botón de copiar tabla con data attributes para identificar
      const tableId = `table-${Math.random().toString(36).substr(2, 9)}`;
      table += `<button class="sk-copy-table-btn" data-table-id="${tableId}" title="Copiar tabla">📋 Copiar tabla</button>`;
      table += '</div>';

      const placeholder = `__TABLE_${tableMatches.length}__`;
      tableMatches.push(table);
      return placeholder;
    });

    let html = escapeHtml(textWithPlaceholders);

    // Restaurar las tablas
    tableMatches.forEach((table, i) => {
      html = html.replace(`__TABLE_${i}__`, table);
    });

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1<em>$2</em>');
    // Encabezados simples (#, ##, ###) SOLO en texto plano
    html = html.replace(/^(#{1,3})\s+(.+)$/gm, (_m, hashes, title) => {
      const level = hashes.length;
      const cls = level === 1 ? 'sk-h1' : level === 2 ? 'sk-h2' : 'sk-h3';
      return `<span class=\"${cls}\">${title}</span>`;
    });

    // Linkify robusto de URLs http(s)
    html = html.replace(/(https?:\/\/[\w.-]+(?:\/[\w\-._~:\/?#\[\]@!$&'()*+,;=%]*)?)/gi, (m) => {
      let url = m;
      let suffix = '';
      while (/[).,!?:;]+$/.test(url)) {
        suffix = url.slice(-1) + suffix;
        url = url.slice(0, -1);
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="sk-link">${url}<\/a>${suffix}`;
    });
    html = html.replace(/\n/g, '<br/>');

    return <span className="typewriter-text" dangerouslySetInnerHTML={{ __html: html }} />;
  };

  return renderFormatted(displayedText);
};

// Comparador personalizado para React.memo
const arePropsEqual = (prevProps, nextProps) => {
  // Solo comparamos las props que realmente importan
  // Ignoramos onComplete, onProgress y batchSize porque usamos refs o son estables
  return (
    prevProps.text === nextProps.text &&
    prevProps.speed === nextProps.speed &&
    prevProps.forceTypewriter === nextProps.forceTypewriter &&
    prevProps.interrupt === nextProps.interrupt
  );
};

// Envolver con React.memo usando el comparador personalizado
const TypewriterText = React.memo(TypewriterTextComponent, arePropsEqual);

TypewriterText.displayName = 'TypewriterText';

export default TypewriterText;
