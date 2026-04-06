import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import micIcon from '../assets/mic.png';
import attachIcon from '../assets/attach.png';
import sendIcon from '../assets/send.png';
import fileIcon from '../assets/file.png';
import playIcon from '../assets/play.png';
import pauseIcon from '../assets/pause.png';
import eliminateIcon from '../assets/eliminate.png';
// Usamos un SVG inline para el botón stop para evitar problemas de asset
import TypewriterText from './TypewriterText';
import useVoiceRecognition from './hooks/useVoiceRecognition';
import { useWorkspace } from './WorkspaceContext';

const API_URL = 'http://localhost:10000/preguntar';

// Contador global de mounts para debug
const globalMountCountRef = { current: new Map() };

function Chat({ currentConversationId, onConversationCreated }) {
  // console.log('[CHAT-RENDER] Chat componente renderizado');

  // Hook del contexto de workspaces para recargar conversaciones
  const {
    selectedWorkspace,
    forceReloadWorkspaceConversations,
    reloadGeneralConversationsSilently
  } = useWorkspace();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState(currentConversationId);
  const [justCreatedConversation, setJustCreatedConversation] = useState(false);
  const [attachments, setAttachments] = useState([]); // { id, file, name, type, progress, status, result }
  // Estado persistente para rastrear mensajes ya mostrados con efecto typewriter
  // Se guarda en localStorage para mantener la información entre sesiones
  const [shownMessages, setShownMessages] = useState(new Set());
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingContent, setEditingContent] = useState('');
  const inputRef = useRef(null);
  const formRef = useRef(null);
  const fileInputRef = useRef(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [toasts, setToasts] = useState([]); // {id, text, variant}
  const [isGenerating, setIsGenerating] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const aiAbortRef = useRef(null);
  const [isTypewriting, setIsTypewriting] = useState(false);
  const [typingMessageId, setTypingMessageId] = useState(null);
  const typingProgressRef = useRef({});
  const [recordingTime, setRecordingTime] = useState(0); // Tiempo de grabación en segundos
  const [waveformBarsCount, setWaveformBarsCount] = useState(12); // Número de barras según el ancho
  const waveformRef = useRef(null);
  const pendingAssistantSaveRef = useRef(new Map()); // id -> { convId, archivo }
  const isTypewritingRef = useRef(false);
  const typingMessageIdRef = useRef(null);
  const renderAsCodeDecisionRef = useRef(new Map()); // messageId -> boolean (decisión inicial)

  // Callbacks estables para TypewriterText (no cambian entre renders)
  const handleTypewriterProgress = useCallback((messageId, partial) => {
    if (typingMessageIdRef.current === messageId) {
      typingProgressRef.current[messageId] = partial;
    }
    // Solo pegar al fondo si el usuario ya está cerca del fondo
    stickToBottomRef.current = isNearBottom();
    scrollIfNearBottom();
  }, []);

  const handleTypewriterComplete = useCallback((messageId) => {
    try { if (debugTypewriterRef.current) console.log('[TW] complete TypewriterText', { messageId }); } catch {}
    markMessageAsShown(messageId);
    setMessages(prev => prev.map(mm => (getMessageId(mm) === messageId ? { ...mm, _typedDone: true, isNew: false } : mm)));
    if (typingMessageIdRef.current === messageId) {
      const msg = messages.find(m => getMessageId(m) === messageId);
      if (msg) {
        const finalText = balanceCodeFences(msg.content);
        const pending = pendingAssistantSaveRef.current.get(messageId);
        if (pending && pending.shouldSave !== false) {
          saveMessage(finalText, 'assistant', pending.convId, null, pending.archivo);
        }
        if (pending) {
          pendingAssistantSaveRef.current.delete(messageId);
        }
      }
      try { delete typingProgressRef.current[messageId]; } catch {}
      setIsTypewriting(false);
      setTypingMessageId(null);
      setIsGenerating(false);
    }
    // Solo auto-scroll si el usuario estaba al fondo
    stickToBottomRef.current = isNearBottom();
    scrollToBottom(true);
  }, [messages]);
  const [thumbHeight, setThumbHeight] = useState(30);

  // Toast helper (reutiliza el existente más abajo si ya está definido)

  // Captura con recorte usando herramienta de Windows (clipboard)
  const snipInProgressRef = useRef(false);
  const sendingLockRef = useRef(false);
  // Evitar dobles envíos instantáneos (por atajos/submit duplicado)
  const lastUserSendKeyRef = useRef({ key: null, ts: 0 });
  // Ref para conversationId actualizado (evita stale closures)
  const conversationIdRef = useRef(conversationId);

  // Actualizar conversationIdRef cuando cambia el estado
  // Siempre mantener el ref sincronizado con el estado
  useEffect(() => {
    conversationIdRef.current = conversationId;
    // console.log('🔄 [CONVERSATION-ID-REF] Actualizado a:', conversationId);
  }, [conversationId]);

  // Refs para mantener valores actualizados en el handler de hotkeys
  const inputRef_hotkey = useRef(input);
  const attachmentsRef_hotkey = useRef(attachments);
  const isListeningRef_hotkey = useRef(false);
  const messagesRef_hotkey = useRef(messages);
  const handleSubmitRef = useRef(null);
  const handleAudioSendRef = useRef(null);
  const handleCopyClickRef = useRef(null);

  // Actualizar messagesRef_hotkey cuando cambia el estado
  useEffect(() => {
    messagesRef_hotkey.current = messages;
    // console.log('🔄 [MESSAGES-REF] Actualizado, cantidad:', messages.length);
  }, [messages]);
  const triggerSnippingToolCapture = useCallback(async () => {
    if (snipInProgressRef.current) return;
    snipInProgressRef.current = true;
    try {
      if (!(navigator.clipboard && navigator.clipboard.read)) {
        showToast('Tu entorno no permite leer imágenes del portapapeles.', 'warning');
        return;
      }
      try {
        if (window.electronAPI && window.electronAPI.openExternal) {
          await window.electronAPI.openExternal('ms-screenclip:');
        } else {
          window.open('ms-screenclip:');
        }
      } catch {}

      const start = Date.now();
      const timeoutMs = 45000; // hasta 45s para que el usuario termine el recorte
      const pollEveryMs = 350;
      let attached = false;
      // Esperar hasta que el recorte copie una imagen al portapapeles
      while (Date.now() - start < timeoutMs && !attached) {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            for (const type of item.types) {
              if (type.startsWith('image/')) {
                const blob = await item.getType(type);
                const file = new File([blob], `captura-${Date.now()}.png`, { type: 'image/png' });
                const id = Math.random().toString(36).slice(2);
                const itemObj = { id, file, name: file.name, type: 'image/png', kind: 'image', status: 'pending', progress: 0, result: null };
                setAttachments(prev => [...prev, itemObj]);
                // Procesar con el extractor para obtener OCR/contexto
                try { processAttachment && processAttachment(itemObj); } catch {}
                attached = true;
                break;
              }
            }
            if (attached) break;
          }
        } catch {}
        if (!attached) await new Promise(r => setTimeout(r, pollEveryMs));
      }
      if (!attached) {
        showToast('No se detectó una captura. Intenta de nuevo.', 'warning');
      }
    } catch (e) {
      showToast('No se pudo obtener la captura del portapapeles.', 'error');
    } finally {
      snipInProgressRef.current = false;
    }
  }, []);

  // Actualizar refs para hotkeys cada vez que cambien los valores
  useEffect(() => {
    inputRef_hotkey.current = input;
  }, [input]);

  useEffect(() => {
    attachmentsRef_hotkey.current = attachments;
  }, [attachments]);

  useEffect(() => {
    messagesRef_hotkey.current = messages;
  }, [messages]);

  // Hotkeys provenientes de Electron (suscribir una sola vez)
  useEffect(() => {
    try {
      if (!window.electronAPI || !window.electronAPI.onHotkey) return;
      if (window.__sk_hotkey_subscribed) return;
      window.__sk_hotkey_subscribed = true;
      const handler = async ({ action }) => {
        if (action === 'send') {
          try {
            if (isListeningRef_hotkey.current) {
              if (handleAudioSendRef.current) {
                handleAudioSendRef.current();
              }
            } else if ((inputRef_hotkey.current || '').trim().length > 0) {
              if (handleSubmitRef.current) {
                handleSubmitRef.current({ preventDefault: () => {} });
              }
            } else if ((attachmentsRef_hotkey.current || []).some(a => a.status === 'done')) {
              if (handleSubmitRef.current) {
                handleSubmitRef.current({ preventDefault: () => {} });
              }
            }
          } catch (err) {
            console.error('[HOTKEY SEND ERROR]', err);
          }
        } else if (action === 'mic') {
          try { handleMicClick(); } catch {}
        } else if (action === 'copy') {
          try {
            const currentMessages = messagesRef_hotkey.current || [];
            const lastBot = [...currentMessages].reverse().find(m => m.role === 'assistant');

            if (lastBot && lastBot.content && handleCopyClickRef.current) {
              const messageId = lastBot._id || lastBot.id || lastBot._tempId || null;
              await handleCopyClickRef.current({ preventDefault: () => {}, stopPropagation: () => {} }, lastBot.content, messageId);
            } else {
              showToast('No hay respuestas para copiar', 'warning');
            }
          } catch (err) {
            console.error('[HOTKEY] Error al copiar:', err);
          }
        } else if (action === 'screenshot') {
          triggerSnippingToolCapture();
        }
      };
      window.electronAPI.onHotkey(handler);
    } catch {}
  }, []);

  function buildRealtimeMeta(intent, data) {
    if (!intent) return null;
    if (intent === 'price.crypto') {
      return { kind: 'price', asset: data?.data?.asset, vs: data?.data?.vs, value: data?.data?.price, fuente: data?.fuente, ts: data?.ts };
    }
    if (intent === 'price.fiat') {
      return { kind: 'fx', base: data?.data?.base, vs: data?.data?.vs, value: data?.data?.rate, fuente: data?.fuente, ts: data?.ts };
    }
    if (intent === 'news') {
      return { kind: 'news', query: data?.data?.query, results: data?.data?.results || data?.results, fuente: data?.fuente || 'Google News RSS', ts: data?.ts };
    }
    if (intent === 'websearch.simple') {
      const results = data?.data?.results || [];
      return { kind: 'links', results };
    }
    return null;
  }

  function formatUtc(ts) {
    try {
      const d = new Date(ts);
      const hh = String(d.getUTCHours()).padStart(2,'0');
      const mm = String(d.getUTCMinutes()).padStart(2,'0');
      return `${hh}:${mm} UTC`;
    } catch { return 'UTC'; }
  }

  function relativeTimeFrom(dateStr) {
    try {
      const d = new Date(dateStr);
      const ms = Date.now() - d.getTime();
      const m = Math.floor(ms / 60000);
      if (m < 1) return 'hace unos segundos';
      if (m < 60) return `hace ${m} min`;
      const h = Math.floor(m / 60);
      if (h < 24) return `hace ${h} h`;
      const days = Math.floor(h / 24);
      return `hace ${days} d`;
    } catch { return ''; }
  }
  const trackRef = useRef(null);
  const messagesRef = useRef(null);
  // Mantener el scroll pegado al fondo durante la generación/tipeo
  const stickToBottomRef = useRef(false);
  const observerRef = useRef(null);
  const suspendObserverRef = useRef(false); // Para suspender el MutationObserver temporalmente
  const activeConversationIdRef = useRef(currentConversationId || null);
  const messagesFetchAbortRef = useRef(null);
  const optimisticByConvRef = useRef(new Map());
  const lastUserPromptRef = useRef('');
  const continuedMessageIdsRef = useRef(new Set());

  // Debug flags y utilidades de logging (debe declararse ANTES de usarlas)
  const debugTypewriterRef = useRef(false);
  const debugLatencyRef = useRef(false);
  const debugScrollRef = useRef(false);
  const twLog = useCallback((...args) => { try { if (debugTypewriterRef.current) console.log('[TW]', ...args); } catch {} }, []);
  const latLog = useCallback((label, data) => { try { if (debugLatencyRef.current) console.log('[LAT]', label, data || ''); } catch {} }, []);
  const scLog = useCallback((label, data) => { try { if (debugScrollRef.current) console.log('[SCROLL]', label, data || ''); } catch {} }, []);

  const isNearBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return false;
    try {
      const threshold = 120;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      return distance <= threshold;
    } catch { return false; }
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = messagesRef.current;
    if (!el) return;
    try {
      const threshold = 120;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const shouldScroll = stickToBottomRef.current || distance <= threshold || smooth;
      if (!shouldScroll) { scLog('scrollToBottom skipped', { distance, threshold, smooth }); return; }
      if (smooth && el.scrollTo) {
        scLog('scrollToBottom smooth', { top: el.scrollHeight });
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      } else {
        scLog('scrollToBottom instant', { top: el.scrollHeight });
        el.scrollTop = el.scrollHeight;
      }
    } catch {}
  }, [scLog]);

  const lastScrollIfNearBottomRef = useRef(0);
  const scrollIfNearBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    // Throttle: solo ejecutar cada 100ms para evitar scroll excesivo
    const now = Date.now();
    if (now - lastScrollIfNearBottomRef.current < 100) return;
    lastScrollIfNearBottomRef.current = now;

    const threshold = 120;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= threshold) {
      scLog('stick at bottom', { distance, threshold });
      el.scrollTop = el.scrollHeight;
    }
  }, [scLog]);

  // Observa cambios en el DOM del contenedor de mensajes para mantenerlo pegado al fondo
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const ensureBottom = () => {
      if (suspendObserverRef.current) {
        scLog('ensureBottom suspended by flag');
        return;
      }
      if (stickToBottomRef.current) {
        try {
          scLog('ensureBottom executing', { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight });
          el.scrollTop = el.scrollHeight;
        } catch {}
      }
    };
    // Mutations (nuevos nodos, KaTeX render, etc.)
    const obs = new MutationObserver(() => ensureBottom());
    obs.observe(el, { childList: true, subtree: true });
    observerRef.current = obs;
    // Sincronizar también en resize/layout
    const onResize = () => ensureBottom();
    window.addEventListener('resize', onResize);
    return () => {
      try { obs.disconnect(); } catch {}
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // Si el usuario se aleja manualmente del fondo, desactivar stick temporalmente
  const lastScrollTopRef = useRef(0);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      const threshold = 160;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const scrollDelta = Math.abs(el.scrollTop - lastScrollTopRef.current);

      // Ignorar scrolls muy pequeños (< 15px) causados por ajustes de layout del navegador
      // Esto evita que el abrir el historial active stickToBottom por un scroll de 7px
      if (scrollDelta < 15) {
        scLog('onScroll ignored (delta < 15px)', { scrollDelta, scrollTop: el.scrollTop });
        return;
      }

      lastScrollTopRef.current = el.scrollTop;
      const prevStick = stickToBottomRef.current;
      stickToBottomRef.current = distance <= threshold;
      if (prevStick !== stickToBottomRef.current) {
        scLog('stickToBottom changed by scroll', { from: prevStick, to: stickToBottomRef.current, distance, scrollTop: el.scrollTop, scrollDelta });
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scLog]);
  // Estado para feedback de copiado por mensaje
  const [copiedMessageIds, setCopiedMessageIds] = useState(new Set());

  useEffect(() => { isTypewritingRef.current = isTypewriting; }, [isTypewriting]);
  useEffect(() => { typingMessageIdRef.current = typingMessageId; }, [typingMessageId]);

  // Inicializar flags de logging desde localStorage
  // Logs desactivados en producción
  useEffect(() => {
    debugTypewriterRef.current = false;
    debugLatencyRef.current = false;
    debugScrollRef.current = false;
  }, []);

  // Event listener para botones de copiar tabla
  useEffect(() => {
    const handleCopyTableClick = async (e) => {
      const btn = e.target.closest('.sk-copy-table-btn');
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      // Encontrar la tabla asociada (hermano anterior del botón)
      const tableWrapper = btn.closest('.sk-table-wrapper');
      const table = tableWrapper?.querySelector('.sk-table');
      if (!table) return;

      try {
        // Extraer datos de la tabla
        const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
        const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr =>
          Array.from(tr.querySelectorAll('td')).map(td => {
            // Limpiar el contenido de la celda (remover <br> y convertir a saltos de línea)
            return td.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
          })
        );

        // Crear versión de texto tabulado
        let textTable = headers.join('\t') + '\n';
        rows.forEach(row => {
          textTable += row.join('\t') + '\n';
        });

        // Crear versión HTML para Word
        let htmlTable = '<table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse;">';
        htmlTable += '<thead><tr>';
        headers.forEach(h => { htmlTable += `<th style="background: #4CAF50; color: white; font-weight: bold; padding: 8px;">${h}</th>`; });
        htmlTable += '</tr></thead><tbody>';
        rows.forEach(row => {
          htmlTable += '<tr>';
          row.forEach(cell => { htmlTable += `<td style="padding: 8px; border: 1px solid #ddd;">${cell.replace(/\n/g, '<br/>')}</td>`; });
          htmlTable += '</tr>';
        });
        htmlTable += '</tbody></table>';

        // Copiar al portapapeles
        if (navigator.clipboard && navigator.clipboard.write) {
          const blob = new Blob([htmlTable], { type: 'text/html' });
          const blobText = new Blob([textTable], { type: 'text/plain' });

          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': blob,
              'text/plain': blobText
            })
          ]);
        } else {
          // Fallback
          await navigator.clipboard.writeText(textTable);
        }

        // Feedback visual
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);

      } catch (error) {
        console.error('Error copiando tabla:', error);
      }
    };

    const messagesContainer = document.querySelector('.messages');
    if (messagesContainer) {
      messagesContainer.addEventListener('click', handleCopyTableClick);
      return () => messagesContainer.removeEventListener('click', handleCopyTableClick);
    }
  }, []);

  // Pre-cargar KaTeX para evitar parpadeo/espera en la primera fórmula
  useEffect(() => {
    try {
      if (!window.katex) {
        const head = document.head || document.getElementsByTagName('head')[0];
        if (!document.querySelector('link[data-katex]')) {
          const link = document.createElement('link');
          link.setAttribute('data-katex', '1');
          link.rel = 'stylesheet';
          link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
          head.appendChild(link);
        }
        if (!document.querySelector('script[data-katex]')) {
          const script = document.createElement('script');
          script.setAttribute('data-katex', '1');
          script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js';
          script.defer = true;
          script.onload = () => { /* marcar como cargado para evitar re-inserciones */ window.katexReady = true; };
          head.appendChild(script);
        }
      }
    } catch {}
  }, []);

  const StopIconSvg = () => (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#1a1a1a"/>
      <rect x="7.5" y="7.5" width="9" height="9" rx="2" ry="2" fill="#34e335"/>
    </svg>
  );

  // Punto base del servicio de extracción. Preferimos 127.0.0.1 y caemos a localhost si falla.
  const EXTRACT_API = 'http://127.0.0.1:8001';
  const MAX_ATTACHMENTS = 6;

  const showToast = useCallback((text, variant = 'info', durationMs = 2600) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, text, variant }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, durationMs);
  }, []);

  // (placeholder) — la lógica de DnD global se registra más abajo tras definir addFiles

  // Callback cuando la transcripción está lista
  const handleTranscriptionReady = useCallback((result) => {
    // Manejar tanto string (legacy) como objeto {text, language, languageConfidence}
    const transcriptionText = typeof result === 'string' ? result : result?.text;
    const detectedLanguage = typeof result === 'object' ? result?.language : 'unknown';
    const languageConfidence = typeof result === 'object' ? result?.languageConfidence : 0;

    if (transcriptionText && transcriptionText.trim()) {
      const userText = transcriptionText.trim();
      const userMessage = {
        role: 'user',
        content: userText,
        createdAt: new Date(),
        isNew: true,
        // Guardar idioma detectado por Whisper (mas preciso que heuristica)
        whisperLanguage: detectedLanguage,
        whisperConfidence: languageConfidence
      };
      setMessages(prevMessages => {
        const withoutProcessing = prevMessages.filter(m => !m.isProcessing);
        return [...withoutProcessing, userMessage];
      });
      setLoading(true);
      const userMessageId = getMessageId(userMessage);
      setShownMessages(prev => { const ns = new Set([...prev, userMessageId]); localStorage.setItem('shownMessages', JSON.stringify(Array.from(ns))); return ns; });
      sendMessageToBackend(userText, userMessage);
    }
  }, []); // Sin dependencias: usa refs

  // Hook para reconocimiento de voz
  const {
    isListening,
    error: voiceError,
    isPaused,
    isProcessing,
    isServiceReady,
    startListening,
    stopListening,
    pauseListening,
    clearTranscript,
    cancelProcessing
  } = useVoiceRecognition(handleTranscriptionReady);

  // Actualizar ref de isListening para hotkeys (después de declararlo)
  useEffect(() => {
    isListeningRef_hotkey.current = isListening;
  }, [isListening]);

  // Timer para el tiempo de grabación
  const wasListeningRef = useRef(false);
  useEffect(() => {
    let interval;
    if (isListening && !isPaused) {
      // Solo resetear si es una nueva grabación (no si es reanudar desde pausa)
      if (!wasListeningRef.current) {
        setRecordingTime(0);
      }
      interval = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      wasListeningRef.current = true;
    } else if (!isListening) {
      setRecordingTime(0); // Reset al detener completamente
      wasListeningRef.current = false;
    }
    return () => clearInterval(interval);
  }, [isListening, isPaused]);

  // Formatear tiempo de grabación
  const formatRecordingTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Ajustar número de barras según el ancho del contenedor (dinámico durante resize)
  useEffect(() => {
    if (!waveformRef.current) return;

    const calculateBars = () => {
      if (waveformRef.current) {
        const width = waveformRef.current.offsetWidth;
        // Cada barra ocupa ~8px (5px de ancho + 3px de gap)
        // Calcular cuántas barras caben, con un mínimo de 9 y máximo de 25
        // Dividir por 12 para dar más espacio y evitar saturación en ventanas pequeñas
        const bars = Math.min(25, Math.max(9, Math.floor(width / 12) + 3));
        setWaveformBarsCount(bars);
      }
    };

    // Calcular inicialmente
    calculateBars();

    // Usar ResizeObserver para detectar cambios en el contenedor en tiempo real
    const resizeObserver = new ResizeObserver(calculateBars);
    resizeObserver.observe(waveformRef.current);

    // Fallback para resize de ventana
    window.addEventListener('resize', calculateBars);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', calculateBars);
    };
  }, [isListening]); // Solo necesitamos recalcular cuando aparece/desaparece el waveform

  // Obtener token de autenticación
  const getAuthToken = () => {
    return localStorage.getItem('token');
  };

  // Generar ID único para un mensaje
  // Usa el _id de la base de datos si está disponible, o genera uno basado en contenido y timestamp
  const getMessageId = (message) => {
    if (message._id) return message._id;
    if (message.id) return message.id;
    if (message._tempId) return message._tempId;
    const timestamp = message.createdAt?.getTime() || message.createdAt || Date.now();
    // Para mensajes vacíos, incluir info de adjuntos para evitar IDs duplicados
    const attachInfo = (message.attachments || []).length > 0 ? `-att${(message.attachments || []).length}` : '';
    const contentKey = String(message.content || '').trim() || 'empty';
    return `${contentKey}${attachInfo}-${timestamp}`;
  };

  // Cargar mensajes mostrados desde localStorage
  const loadShownMessages = useCallback(() => {
    try {
      const stored = localStorage.getItem('shownMessages');
      if (stored) {
        const parsed = JSON.parse(stored);
        return new Set(parsed.filter(Boolean));
      }
    } catch (error) {
      console.error('Error cargando mensajes mostrados:', error);
    }
    return new Set();
  }, []);

  // Guardar mensajes mostrados en localStorage
  const saveShownMessages = useCallback((messagesSet) => {
    try {
      const array = Array.from(messagesSet).filter(Boolean);
      localStorage.setItem('shownMessages', JSON.stringify(array));
    } catch (error) {
      console.error('Error guardando mensajes mostrados:', error);
    }
  }, []);

  // Función para limpiar el estado de mensajes mostrados (útil para logout o reset)
  const clearShownMessages = useCallback(() => {
    setShownMessages(new Set());
    localStorage.removeItem('shownMessages');
  }, []);

  // Función para resetear el estado de mensajes mostrados (útil para testing o reset manual)
  const resetShownMessages = useCallback(() => {
    clearShownMessages();
  }, [clearShownMessages]);

  // Función para iniciar la edición de un mensaje
  const startEditing = useCallback((messageId, currentContent) => {
    try {
      // Guardar scroll actual
      const el = document.querySelector('.messages');
      if (el) el.dataset.prevScroll = String(el.scrollTop);
    } catch {}
    setEditingMessageId(messageId);
    setEditingContent(currentContent);
    // Restaurar scroll en el próximo frame para evitar salto
    requestAnimationFrame(() => {
      try {
        const el = document.querySelector('.messages');
        const prev = el && el.dataset.prevScroll ? parseInt(el.dataset.prevScroll, 10) : null;
        if (el && prev !== null) el.scrollTop = prev;
      } catch {}
    });
  }, []);

  // Función para cancelar la edición
  const cancelEditing = useCallback(() => {
    setEditingMessageId(null);
    setEditingContent('');
  }, []);

  // Función para limpiar markdown y convertir tablas a formato Word-compatible
  const cleanMarkdownForCopy = useCallback((content) => {
    let text = String(content || '');

    // 1. Procesar tablas Markdown primero (convertir a formato tabulado simple)
    const tables = [];
    text = text.replace(/(\|.+\|(?:\r?\n)\|[-:| ]+\|(?:\r?\n)(?:\|.+\|(?:\r?\n)?)*)/g, (tableMatch) => {
      const lines = tableMatch.split(/\r?\n/).filter(l => l.trim() && l.includes('|'));
      if (lines.length < 3) return tableMatch;

      // Limpiar markdown dentro de las celdas ANTES de extraer los datos
      const cleanCell = (cell) => {
        let cleaned = cell.trim();
        cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1'); // Negritas
        cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1'); // Cursivas
        cleaned = cleaned.replace(/`([^`]+)`/g, '$1'); // Código inline
        cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // Links
        return cleaned;
      };

      // Convertir tabla Markdown a formato tabulado con tabs
      const headers = lines[0].split('|').map(h => cleanCell(h)).filter(Boolean);
      const rows = lines.slice(2).map(row =>
        row.split('|').map(cell => cleanCell(cell)).filter(Boolean)
      );

      let tableText = headers.join('\t') + '\n';
      rows.forEach(row => {
        tableText += row.join('\t') + '\n';
      });

      const placeholder = `__TABLE_${tables.length}__`;
      tables.push(tableText);
      return '\n' + placeholder + '\n'; // Agregar saltos de línea para separar del texto
    });

    // 2. Limpiar markdown de formato en el resto del texto
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1'); // Negritas
    text = text.replace(/\*([^*]+)\*/g, '$1'); // Cursivas
    text = text.replace(/`([^`]+)`/g, '$1'); // Código inline
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1'); // Encabezados
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // Links

    // 3. Restaurar tablas
    tables.forEach((table, i) => {
      text = text.replace(`__TABLE_${i}__`, '\n' + table);
    });

    return text.trim();
  }, []);

  // Función para copiar mensaje al portapapeles (con soporte para tablas HTML)
  const copyMessage = useCallback(async (content) => {
    try {
      const cleanText = cleanMarkdownForCopy(content);

      // Detectar si hay tablas (formato tabulado con tabs)
      const hasTable = /\t/.test(cleanText) && cleanText.split('\n').filter(line => line.includes('\t')).length > 1;

      if (hasTable && navigator.clipboard && navigator.clipboard.write) {
        // Construir HTML mezclando texto normal y tablas
        let htmlContent = '';
        const lines = cleanText.split('\n');

        let i = 0;
        while (i < lines.length) {
          const line = lines[i];

          // Si la línea tiene tabs, es parte de una tabla
          if (line.includes('\t')) {
            // Recoger todas las líneas consecutivas con tabs (la tabla completa)
            const tableLines = [];
            while (i < lines.length && lines[i].includes('\t')) {
              tableLines.push(lines[i]);
              i++;
            }

            // Generar HTML de la tabla
            const headers = tableLines[0].split('\t');
            const rows = tableLines.slice(1).map(l => l.split('\t'));

            htmlContent += '<table border="1" cellpadding="5" cellspacing="0" style="border-collapse: collapse; margin: 10px 0;">';
            htmlContent += '<thead><tr>';
            headers.forEach(h => {
              htmlContent += `<th style="background: #4CAF50; color: white; font-weight: bold; padding: 8px; text-align: left;">${h || ''}</th>`;
            });
            htmlContent += '</tr></thead><tbody>';
            rows.forEach(row => {
              htmlContent += '<tr>';
              row.forEach(cell => {
                htmlContent += `<td style="padding: 8px; border: 1px solid #ddd;">${cell || ''}</td>`;
              });
              htmlContent += '</tr>';
            });
            htmlContent += '</tbody></table>';
          } else {
            // Es texto normal, agregarlo como párrafo
            if (line.trim()) {
              htmlContent += `<p style="margin: 5px 0;">${line}</p>`;
            } else {
              htmlContent += '<br/>';
            }
            i++;
          }
        }

        // Copiar tanto HTML (para Word) como texto plano (para editores de texto)
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const blobText = new Blob([cleanText], { type: 'text/plain' });

        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': blob,
            'text/plain': blobText
          })
        ]);

        scLog('copied with table HTML');
      } else {
        // Copia simple de texto plano
        await navigator.clipboard.writeText(cleanText);
        scLog('copied');
      }
    } catch (error) {
      console.error('Error copiando al portapapeles:', error);
      // Fallback simple
      try {
        const cleanText = cleanMarkdownForCopy(content);
        const textArea = document.createElement('textarea');
        textArea.value = cleanText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      } catch (fallbackError) {
        console.error('Error en fallback de copia:', fallbackError);
      }
    }
  }, [scLog, cleanMarkdownForCopy]);

  // Animación/feedback de copia para botones de mensajes normales
  const handleCopyClick = useCallback(async (e, content, id) => {
    // Evitar que el botón dispare submit o burbujee a otros handlers
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    // Preservar scroll del contenedor mientras copiamos
    let prevScroll = null; let container = null;
    try {
      container = document.querySelector('.messages');
      prevScroll = container ? container.scrollTop : null;
      // Suspender pegado al fondo Y el observer para evitar auto-scroll en copiar
      stickToBottomRef.current = false;
      suspendObserverRef.current = true;
      scLog('copy: observer suspended');
    } catch {}
    scLog('copy:before', { prevScroll });
    await copyMessage(content);
    if (id) {
      setCopiedMessageIds(prev => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setTimeout(() => {
        setCopiedMessageIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 1200);
    }
    // Restaurar scroll si cambió para evitar saltos inesperados
    try {
      if (container != null && prevScroll != null) {
        container.scrollTop = prevScroll;
        scLog('copy:restore', { prevScroll, current: container.scrollTop });
        // NO reactivar stickToBottom aquí - dejar que el evento scroll lo maneje
        // Esto evita que el observer haga scroll cuando se reactive
        scLog('copy: stickToBottom remains false until user scrolls');
      }
    } catch {}
    // Reactivar observer después de un delay más largo para evitar saltos de los re-renders
    setTimeout(() => {
      suspendObserverRef.current = false;
      scLog('copy: observer reactivated');
    }, 1000); // Aumentado a 1 segundo para dar tiempo a todos los re-renders
  }, [copyMessage, scLog]);

  // Actualizar ref de handleCopyClick para hotkeys (después de definirla)
  useEffect(() => {
    handleCopyClickRef.current = handleCopyClick;
  }, [handleCopyClick]);

  // Función para guardar la edición
  const saveEdit = useCallback(async (messageId) => {
    if (!editingContent.trim()) return;

    try {
      const token = getAuthToken();

      const response = await fetch(`http://localhost:10000/api/messages/${messageId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: editingContent.trim()
        })
      });

              if (response.ok) {
          let messagesToDelete = [];

          const currentMessages = messages;
          const editedMessageIndex = currentMessages.findIndex(msg => getMessageId(msg) === messageId);

          if (editedMessageIndex !== -1) {
            for (let i = editedMessageIndex + 1; i < currentMessages.length; i++) {
              const message = currentMessages[i];
              messagesToDelete.push(message);
            }
          }

          setMessages(prevMessages => {
            const updatedMessages = prevMessages.map(msg =>
              getMessageId(msg) === messageId
                ? { ...msg, content: editingContent.trim(), isEdited: true }
                : msg
            );

            // Eliminar todos los mensajes posteriores del frontend
            if (messagesToDelete.length > 0 && editedMessageIndex !== -1) {
              updatedMessages.splice(editedMessageIndex + 1, messagesToDelete.length);
            }

            return updatedMessages;
          });

          try {
            const deleteResponse = await fetch(`http://localhost:10000/api/messages/conversation/${conversationId}/after/${messageId}`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            });

            if (!deleteResponse.ok) {
              console.error('[EDIT] Error eliminando mensajes posteriores de la BD');
            }
          } catch (error) {
            console.error('[EDIT] Error eliminando mensajes posteriores de la BD:', error);
          }

          // Recargar conversaciones para actualizar el orden en el historial
          try {
            if (selectedWorkspace && selectedWorkspace._id) {
              // Si hay workspace seleccionado, recargar sus conversaciones
              await forceReloadWorkspaceConversations(selectedWorkspace._id);
            } else {
              // Si es conversación general, recargar conversaciones generales
              await reloadGeneralConversationsSilently();
            }
          } catch (error) {
            console.error('Error recargando conversaciones:', error);
          }

        cancelEditing();

        setLoading(true);

        try {
          // Obtener respuesta de OpenAI con el mensaje editado
          const token = getAuthToken();
          const xModelEdit = localStorage.getItem('skanea_model_override');

          let historialParaDeteccion = [];

          try {
            const token = getAuthToken();

            const historialResponse = await fetch(`http://localhost:10000/api/messages/conversation/${conversationId}`, {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            });

            if (historialResponse.ok) {
              const historialData = await historialResponse.json();
              const todosLosMensajes = historialData.data || [];

              const mensajesOrdenados = todosLosMensajes.sort((a, b) =>
                new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
              );

              const mensajeEditado = mensajesOrdenados.find(m => m._id === messageId);
              const indiceEditado = mensajesOrdenados.findIndex(m => m._id === messageId);

              if (mensajeEditado && indiceEditado !== -1) {
                const mensajesAnteriores = mensajesOrdenados
                  .slice(0, indiceEditado)
                  .map(m => ({ role: m.role, content: m.content }));

                const mensajesUsuarioAnteriores = mensajesAnteriores.filter(m => m.role === 'user');
                const esElPrimerMensajeUsuario = mensajesUsuarioAnteriores.length === 0;

                if (!esElPrimerMensajeUsuario && mensajesAnteriores.length > 0) {
                  historialParaDeteccion = mensajesAnteriores;
                }
              }
            } else {
              console.warn('[EDIT] No se pudo obtener historial, usando estado local');
              const editedMessageIndex = messages.findIndex(msg => getMessageId(msg) === messageId);
              historialParaDeteccion = editedMessageIndex > 0
                ? messages.slice(0, editedMessageIndex).map(m => ({ role: m.role, content: m.content }))
                : [];
            }
          } catch (error) {
            console.error('[EDIT] Error obteniendo historial:', error);
            const editedMessageIndex = messages.findIndex(msg => getMessageId(msg) === messageId);
            historialParaDeteccion = editedMessageIndex > 0
              ? messages.slice(0, editedMessageIndex).map(m => ({ role: m.role, content: m.content }))
              : [];
          }

          const autoSaveFilesEdit = localStorage.getItem('skanea_auto_save_files') === 'true';
          const aiResponse = await fetch(API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(xModelEdit ? { 'x-model-override': xModelEdit } : {}),
              ...(localStorage.getItem('debugUI') === '1' ? { 'x-debug-markdown': '1' } : {}),
              ...(autoSaveFilesEdit ? { 'x-auto-save-files': 'true' } : {})
            },
            body: JSON.stringify({
              pregunta: editingContent.trim(),
              historial: historialParaDeteccion, // Incluir contexto previo para detección correcta
              conversationId: conversationId // Enviar conversationId para archivos
            })
          });

          if (aiResponse.ok) {
            const data = await aiResponse.json();
            try {
              const p = data.provider || aiResponse.headers.get('x-ai-provider');
              const m = data.model || aiResponse.headers.get('x-ai-model');
              if (p || m) console.log('[Skanea][AI] provider=', p, 'model=', m);
            } catch {}

            // Agregar la nueva respuesta del bot
            const botMessage = {
              role: 'assistant',
              content: data.respuesta,
              createdAt: new Date(),
              isNew: true,
              file: data.archivo || null
            };

            setMessages(prevMessages => [...prevMessages, botMessage]);

                         // Guardar la nueva respuesta del bot con el conversationId correcto
             await saveMessage(data.respuesta, 'assistant', conversationId, [], data.archivo);

          } else {
            console.error('Error obteniendo nueva respuesta del bot');
          }
        } catch (error) {
          console.error('Error regenerando respuesta:', error);
        } finally {
          setLoading(false);
        }

      } else {
        console.error('Error actualizando mensaje');
        alert('Error al actualizar el mensaje');
      }
    } catch (error) {
      console.error('Error actualizando mensaje:', error);
      alert('Error al actualizar el mensaje');
    }
  }, [editingContent, cancelEditing, conversationId]);

  // Función para manejar el clic en el botón de micrófono
  const handleMicClick = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  // Botón enviar del AudioRecorder: detener para disparar transcripción+autoenvío
  const handleAudioSend = useCallback(() => {
    // Agregar mensaje temporal con indicador de procesamiento
    const processingMessage = {
      role: 'user',
      content: '',
      createdAt: new Date(),
      isProcessing: true
    };
    setMessages(prevMessages => [...prevMessages, processingMessage]);
    stopListening();
  }, [stopListening]);

  // Actualizar refs de funciones para hotkeys (después de definirlas)
  useEffect(() => {
    handleAudioSendRef.current = handleAudioSend;
  }, [handleAudioSend]);

  // Utilidad: cerrar cercas de código si quedaron abiertas
  const balanceCodeFences = useCallback((text) => {
    try {
      const s = String(text || '');
      const count = (s.match(/```/g) || []).length;
      if (count % 2 === 1) return s + '\n```';
      return s;
    } catch { return text; }
  }, []);

  // Función para enviar mensaje al backend
  const sendMessageToBackend = async (userText, userMessage) => {
    lastUserPromptRef.current = userText;
    const t0 = performance.now();

    // Guardar mensaje del usuario y obtener conversationId si es nuevo
    // Usar conversationIdRef para evitar closures obsoletos
    const currentConvId = conversationIdRef.current;
    let newConvId = currentConvId;
    if (!currentConvId) {
      newConvId = await createNewConversation(userText);
      if (!newConvId) {
        setLoading(false);
        return;
      }
      setConversationId(newConvId);
      activeConversationIdRef.current = newConvId;
      conversationIdRef.current = newConvId;
      // Persistir primero el mensaje del usuario para evitar sobrescrituras de carga
      await saveMessage(userText, 'user', newConvId);
      // Notificar después de persistir
      // onConversationCreated ya fue llamado dentro de createNewConversation()
      // Una vez que guardamos y el backend lo tenga, ya no necesitamos el optimista duplicado
      // Mantenerlo hasta que loadMessages lo reemplace para evitar parpadeo
    } else {
      await saveMessage(userText, 'user', currentConvId);
    }

    try {
      // Obtener respuesta de OpenAI
      const token = getAuthToken();
      // Pasar modelo forzado desde localStorage (si Ajustes lo guardó)
      const xModel = localStorage.getItem('skanea_model_override');
      // Obtener preferencia de guardado automático
      const autoSaveFiles = localStorage.getItem('skanea_auto_save_files') === 'true';
      latLog('request:start', { endpoint: 'API_URL/ask', model: xModel || 'default' });
      const headers = {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(xModel ? { 'x-model-override': xModel } : {}),
          // Activar logs de markdown en backend (solo cuando debugUI=1)
        ...(localStorage.getItem('debugUI') === '1' ? { 'x-debug-markdown': '1' } : {}),
        // Indicar si se debe guardar automáticamente los archivos generados
        ...(autoSaveFiles ? { 'x-auto-save-files': 'true' } : {})
      };
      const currentMessages = messagesRef_hotkey.current || [];
      const historyForApi = [...currentMessages, userMessage].map(m => ({ role: m.role, content: m.content }));

      // 🌐 DETECCIÓN INTELIGENTE DE IDIOMA
      // Prioridad 1: Si el mensaje viene de Whisper con alta confianza (>0.7), usar ese idioma
      // Prioridad 2: Detección heurística del texto
      const detectLanguage = (text, whisperLang, whisperConf) => {
        // Si Whisper detectó idioma con alta confianza, confiar en eso
        if (whisperConf && whisperConf > 0.7 && whisperLang && whisperLang !== 'unknown') {
          if (whisperLang === 'pt' && whisperConf < 0.85) {
            // Whisper detected Portuguese with medium confidence, verify with heuristics
          } else {
            return whisperLang;
          }
        }

        const lowerText = text.toLowerCase();

        // Palabras muy comunes en inglés
        const englishIndicators = /\b(what|where|when|who|why|how|the|is|are|was|were|have|has|had|do|does|did|can|could|will|would|should|may|might|must|this|that|these|those|there|here|very|much|many|some|any|all|every|each|both|either|neither|other|another|such|same|different|new|old|good|bad|big|small|long|short|high|low|first|last|next|previous|same|best|worst|better|worse|more|less|most|least)\b/g;

        // Palabras muy comunes en español
        const spanishIndicators = /\b(que|cual|cuales|como|donde|cuando|quien|quienes|por que|porque|para|con|sin|sobre|entre|hasta|desde|hacia|segun|mediante|durante|el|la|los|las|un|una|unos|unas|de|del|al|es|son|esta|estan|fue|fueron|ha|han|habia|habian|ser|estar|haber|tener|hacer|decir|poder|deber|querer|saber|ver|dar|venir|ir|salir|llegar|pasar|quedar|poner|traer|sacar|llevar|dejar|seguir|encontrar|llamar|hablar|trabajar|sentir|vivir|conocer|parecer)\b/g;

        const englishMatches = (lowerText.match(englishIndicators) || []).length;
        const spanishMatches = (lowerText.match(spanishIndicators) || []).length;

        // Si tiene mas palabras en ingles, es ingles (ahora con umbral de 1)
        if (englishMatches > spanishMatches && englishMatches >= 1) {
          return 'en';
        }
        // Por defecto español
        return 'es';
      };

      const userLanguage = detectLanguage(userText, userMessage.whisperLanguage, userMessage.whisperConfidence);

      // Instrucciones de formato según idioma detectado
      const formatInstructions = {
        es: 'Formatea tus respuestas en Markdown ligero. Usa **negritas** para conceptos clave y separa ideas con saltos de línea. Si la respuesta es TEXTO PLANO (sin bloques de código ni matemáticas), COMIENZA con un encabezado H2 usando Markdown (## Título breve de 3–7 palabras) y, si aporta claridad, emplea subtítulos H3 (### ...). TABLAS: Solo usa tablas Markdown (| col1 | col2 |\n|------|------|\n| dato | dato |) cuando sean realmente necesarias para comparar datos estructurados (ej: comparaciones, horarios, listas de características). NO abuses de las tablas para texto simple. No uses encabezados dentro de código o matemáticas. Evita HTML. Sé conciso.',
        en: 'Format your responses in lightweight Markdown. Use **bold** for key concepts and separate ideas with line breaks. If the response is PLAIN TEXT (without code blocks or math), START with an H2 header using Markdown (## Brief title of 3–7 words) and, if it adds clarity, use H3 subheadings (### ...). TABLES: Only use Markdown tables (| col1 | col2 |\n|------|------|\n| data | data |) when truly necessary for comparing structured data (e.g., comparisons, schedules, feature lists). DON\'T abuse tables for simple text. No headers inside code or math. Avoid HTML. Be concise.'
      };

      // Agregar mensaje de sistema con instrucciones en el idioma correcto
      historyForApi.unshift({
        role: 'system',
        content: formatInstructions[userLanguage] || formatInstructions.es
      });

      const tReq = performance.now();
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          pregunta: userText,
          historial: historyForApi,
          conversationId: newConvId // Enviar conversationId para que el backend pueda nombrar archivos con él
        }),
      });
      latLog('request:end', { ms: Math.round(performance.now() - t0), sentHeaders: (localStorage.getItem('debugUI')==='1') ? { 'x-debug-markdown': '1' } : undefined });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (localStorage.getItem('debugUI') === '1') {
        try {
          console.log('[MD] headers', {
            x_md_pre_len: response.headers.get('x-md-pre-len'),
            x_md_post_len: response.headers.get('x-md-post-len'),
            x_md_pre_fences: response.headers.get('x-md-pre-fences'),
            x_md_post_fences: response.headers.get('x-md-post-fences'),
            x_md_hint_links: response.headers.get('x-md-hint-links'),
          });
        } catch {}
      }
      latLog('response:received', { chars: (data.response || data.respuesta || '').length, headers: (localStorage.getItem('debugUI')==='1') ? {
        x_md_pre_len: response.headers.get('x-md-pre-len'),
        x_md_post_len: response.headers.get('x-md-post-len'),
        x_md_pre_fences: response.headers.get('x-md-pre-fences'),
        x_md_post_fences: response.headers.get('x-md-post-fences'),
        x_md_hint_links: response.headers.get('x-md-hint-links'),
      } : undefined });
      try {
        const p = data.provider || response.headers.get('x-ai-provider');
        const m = data.model || response.headers.get('x-ai-model');
        const l = response.headers.get('x-ai-latency-ms');
        if (p || m) {
          console.log('[Skanea][AI] provider=', p, 'model=', m, 'latencyMs=', l);
        }
      } catch {}

      if (!data.respuesta && !data.response) {
        throw new Error('No se recibió respuesta del bot');
      }

      // Verificar si es una respuesta simple (para sugerencias de formato)
      const responseText = data.response || data.respuesta;
      if (localStorage.getItem('debugUI') === '1') {
        try {
          console.log('[MD] preview text', (responseText || '').slice(0, 200));
        } catch {}
      }
      latLog('response:received', { chars: (responseText || '').length });
      const intent = data.intent || null;
      const realtime = buildRealtimeMeta(intent, data);

      // Asignar un id temporal y activar typewriter también en este flujo
      const botId = `bot-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const botMessage = {
        role: 'assistant',
        content: responseText,
        createdAt: new Date(),
        isNew: true,
        _tempId: botId,
        _id: data._id || undefined, // Usar el _id devuelto por el backend si existe
        realtime,
        file: data.archivo || undefined
      };

      setTypingMessageId(botId);
      setIsTypewriting(true);
      setMessages(prevMessages => [...prevMessages, botMessage]);
      // Si ya tenemos _id, NO guardar de nuevo en MongoDB (evitar duplicación)
      const shouldSave = !data._id;
      pendingAssistantSaveRef.current.set(botId, {
        convId: newConvId || conversationId,
        archivo: data.archivo || undefined,
        shouldSave: shouldSave // Flag para indicar si debe guardarse
      });
      setIsGenerating(true);
      setTimeout(() => {
        try {
          const el = messagesRef.current;
          if (!el) return;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          // Solo auto-scroll si ya estaba cerca del fondo
          if (distance <= 120) {
            // Solo marcar pegado si ya estábamos cerca
            stickToBottomRef.current = true;
            scrollToBottom(true);
          } else {
            scLog('auto-scroll suppressed (user away from bottom)', { distance });
          }
        } catch {}
      }, 0);
    } catch (err) {
      console.error('Error en sendMessageToBackend:', err);
      const errorMessage = { role: 'assistant', content: `Error al obtener respuesta: ${err.message}`, createdAt: new Date(), isNew: true };
      setMessages(prevMessages => [...prevMessages, errorMessage]);
      await saveMessage(`Error al obtener respuesta: ${err.message}`, 'assistant', newConvId || conversationId);
    } finally {
      setLoading(false);
    }
  };

  // ---------- Adjuntos: manejo de archivos y extracción ----------
  const addFiles = useCallback((files) => {
    const list = Array.from(files || []);
    if (!list.length) return;

    // Validar formatos permitidos
    const allowed = [];
    const rejected = [];
    list.forEach((f) => {
      const lower = (f.name || '').toLowerCase();
      if (!/\.(pdf|docx|pptx|xlsx|csv|txt|png|jpe?g|gif|bmp|webp)$/.test(lower)) {
        rejected.push(f.name || 'archivo');
      } else {
        allowed.push(f);
      }
    });
    if (rejected.length) {
      showToast(`Formato no compatible: ${rejected.join(', ')}. Permitidos: PDF, DOCX, PPTX, XLSX, CSV, TXT e imágenes.`, 'error');
    }

    // Respetar el límite máximo
    const remaining = Math.max(0, MAX_ATTACHMENTS - (attachments?.length || 0));
    if (remaining <= 0) {
      showToast(`Límite de adjuntos alcanzado (${MAX_ATTACHMENTS}).`, 'warning');
      return;
    }
    const capped = allowed.slice(0, remaining);
    const overLimitCount = Math.max(0, allowed.length - capped.length);
    if (overLimitCount > 0) {
      showToast(`Solo se permiten ${MAX_ATTACHMENTS} adjuntos. Se ignoraron ${overLimitCount}.`, 'warning');
    }

    const items = capped.map((f) => {
      const fileName = f.name.toLowerCase();
      let detectedType = f.type;

      // Detectar tipo basado en extensión si no está disponible
      if (!detectedType || detectedType === 'application/octet-stream') {
        if (fileName.endsWith('.pdf')) detectedType = 'application/pdf';
        else if (fileName.endsWith('.docx')) detectedType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        else if (fileName.endsWith('.pptx')) detectedType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        else if (fileName.endsWith('.xlsx')) detectedType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        else if (fileName.endsWith('.csv')) detectedType = 'text/csv';
        else if (fileName.endsWith('.txt')) detectedType = 'text/plain';
        else if (fileName.match(/\.(png|jpe?g|gif|bmp|webp)$/)) detectedType = `image/${fileName.split('.').pop()}`;
        else detectedType = 'application/octet-stream';
      }

      // Determinar el 'kind' basado en la extensión para mostrar el chip correcto desde el inicio
      let kind = 'file'; // default
      if (fileName.endsWith('.pdf')) kind = 'pdf';
      else if (fileName.endsWith('.docx')) kind = 'docx';
      else if (fileName.endsWith('.pptx')) kind = 'pptx';
      else if (fileName.endsWith('.xlsx')) kind = 'xlsx';
      else if (fileName.endsWith('.csv')) kind = 'csv';
      else if (fileName.endsWith('.txt')) kind = 'txt';
      else if (fileName.match(/\.(png|jpe?g|gif|bmp|webp)$/)) kind = 'image';

      return {
        id: `${f.name}-${f.size}-${Date.now()}`,
        file: f,
        name: f.name,
        type: detectedType,
        kind: kind, // ⭐ Establecer el kind desde el inicio
        progress: 0,
        status: 'pending', // pending | uploading | done | error
        result: null,
        error: null,
      };
    });
    setAttachments((prev) => [...prev, ...items]);
    // lanzar extracción para cada uno
    items.forEach(processAttachment);
  }, [attachments]);

  const processAttachment = useCallback(async (item) => {
    // Determinar el endpoint basado en el tipo de archivo
    let endpoint;
    const fileName = item.name.toLowerCase();
    const fileType = item.type;

    if (fileType === 'application/pdf' || fileName.endsWith('.pdf')) {
      endpoint = `${EXTRACT_API}/extract/pdf`;
    } else if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
      endpoint = `${EXTRACT_API}/extract/docx`;
    } else if (fileType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || fileName.endsWith('.pptx')) {
      endpoint = `${EXTRACT_API}/extract/pptx`;
    } else if (fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || fileName.endsWith('.xlsx')) {
      endpoint = `${EXTRACT_API}/extract/xlsx`;
    } else if (fileType === 'text/csv' || fileName.endsWith('.csv')) {
      endpoint = `${EXTRACT_API}/extract/csv`;
    } else if (fileType === 'text/plain' || fileName.endsWith('.txt')) {
      endpoint = `${EXTRACT_API}/extract/txt`;
    } else if (fileType && fileType.startsWith('image/')) {
      endpoint = `${EXTRACT_API}/ocr/mixed`;
    } else {
      // Default fallback basado en extensión
      if (fileName.endsWith('.pdf')) endpoint = `${EXTRACT_API}/extract/pdf`;
      else if (fileName.endsWith('.docx')) endpoint = `${EXTRACT_API}/extract/docx`;
      else if (fileName.endsWith('.pptx')) endpoint = `${EXTRACT_API}/extract/pptx`;
      else if (fileName.endsWith('.xlsx')) endpoint = `${EXTRACT_API}/extract/xlsx`;
      else if (fileName.endsWith('.csv')) endpoint = `${EXTRACT_API}/extract/csv`;
      else if (fileName.endsWith('.txt')) endpoint = `${EXTRACT_API}/extract/txt`;
      else endpoint = `${EXTRACT_API}/ocr/mixed`; // fallback para imágenes
    }

    // Hacer un ping rápido al servicio para evitar errores por arranque
    try {
      await fetch(`${EXTRACT_API}/health`, { method: 'GET', cache: 'no-store' });
    } catch {}

    setAttachments((prev) => prev.map(a => a.id === item.id ? { ...a, status: 'uploading', progress: 1 } : a));
    try {
      const res = await uploadWithProgress(endpoint, item.file, (p) => {
        setAttachments((prev) => prev.map(a => a.id === item.id ? { ...a, progress: p } : a));
      });
      setAttachments((prev) => prev.map(a => a.id === item.id ? { ...a, status: 'done', progress: 100, result: res } : a));
    } catch (e) {
      setAttachments((prev) => prev.map(a => a.id === item.id ? { ...a, status: 'error', error: e?.message || 'Error' } : a));
    }
  }, []);

  function uploadWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const tryOnce = (tryUrl, retriesLeft) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', tryUrl);
        xhr.responseType = 'json';
        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable && onProgress) onProgress((evt.loaded / evt.total) * 100);
        };
        xhr.onerror = () => {
          if (retriesLeft > 0) {
            const alt = tryUrl.replace('127.0.0.1', 'localhost');
            if (alt !== tryUrl) return tryOnce(alt, retriesLeft - 1);
          }
          reject(new Error('Network error'));
        };
        xhr.onload = () => {
          const ok = xhr.status >= 200 && xhr.status < 300;
          if (!ok) {
            if (xhr.status === 0 && retriesLeft > 0) {
              const alt = tryUrl.replace('127.0.0.1', 'localhost');
              if (alt !== tryUrl) return tryOnce(alt, retriesLeft - 1);
            }
            return reject(new Error(xhr.response?.error || `HTTP ${xhr.status}`));
          }
          resolve(xhr.response);
        };
        const form = new FormData();
        form.append('file', file);
        xhr.send(form);
      };
      tryOnce(url, 1);
    });
  }

  const onAttachClick = useCallback(() => {
    if (fileInputRef.current) fileInputRef.current.click();
  }, []);

  const onFileInputChange = useCallback((e) => {
    addFiles(e.target.files);
    e.target.value = '';
  }, [addFiles]);

  const onDropArea = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const removeAttachment = useCallback((id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Arrastre y suelta global: prevenir navegación y adjuntar en toda la ventana
  useEffect(() => {
    const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    let dragCounter = 0;
    const onDragEnter = (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      setIsDraggingOver(true);
    };
    const onDragOver = (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingOver(true);
    };
    const onDragLeave = (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) setIsDraggingOver(false);
    };
    const onDrop = (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingOver(false);
      dragCounter = 0;
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    };
    const onDragEnd = () => { setIsDraggingOver(false); dragCounter = 0; };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onDragEnd);
    };
  }, [addFiles]);

  // No acciones sobre el textfield a partir de archivos: solo mostramos chips y procesamos en background

  // Función para cancelar la grabación
  const handleAudioCancel = useCallback(() => {
    clearTranscript();
  }, [clearTranscript]);

  // Función para cancelar el procesamiento de audio
  const handleCancelProcessing = useCallback(() => {
    setMessages(prevMessages => prevMessages.filter(m => !m.isProcessing));
    // Detener completamente el proceso de transcripción
    cancelProcessing();
    // Resetear estados
    setLoading(false);
  }, [cancelProcessing]);

  // Estado y refs para scrollbar personalizada controlada por React
  const [showCustomScrollbar, setShowCustomScrollbar] = useState(false);
  const wrapperRef = useRef(null);
  const [thumbTop, setThumbTop] = useState(0);

  const updateScrollbarMetrics = useCallback(() => {
    const textarea = inputRef.current;
    const track = trackRef.current;
    const wrapper = wrapperRef.current;
    if (!textarea || !track || !wrapper) return;

    // Ubicar el track alineado con el rectángulo visible del textarea,
    // aunque el textarea esté anclado al fondo y crezca hacia arriba
    const cs = window.getComputedStyle(textarea);
    const bottomOffset = parseFloat(cs.bottom) || 0;
    const textareaHeight = Math.max(0, textarea.clientHeight);
    const wrapperHeight = Math.max(0, wrapper.clientHeight);
    const topInWrapper = (wrapperHeight - textareaHeight - bottomOffset);

    // Colocar el track a la misma altura y tamaño del textarea
    track.style.top = `${topInWrapper}px`;
    track.style.bottom = 'auto';
    const visibleHeight = Math.max(24, textareaHeight - 4);
    track.style.height = `${visibleHeight}px`;

    // Tamaño del thumb proporcional al contenido visible vs total
    const canScroll = textarea.scrollHeight > textarea.clientHeight + 1;
    const ratio = textarea.clientHeight / Math.max(1, textarea.scrollHeight);
    const thumbH = canScroll ? Math.max(30, Math.floor(ratio * visibleHeight)) : visibleHeight;
    const maxThumbTop = Math.max(0, visibleHeight - thumbH);
    const scrollRange = Math.max(1, textarea.scrollHeight - textarea.clientHeight);
    const scrollRatio = canScroll ? (textarea.scrollTop / scrollRange) : 0;
    setThumbHeight(thumbH);
    setThumbTop(Math.max(0, Math.min(maxThumbTop, Math.round(scrollRatio * maxThumbTop))));
  }, []);

  const handleTextareaScroll = useCallback(() => {
    updateScrollbarMetrics();
  }, [updateScrollbarMetrics]);

  const handleThumbMouseDown = useCallback((e) => {
    e.preventDefault();
    const textarea = inputRef.current;
    const track = trackRef.current;
    if (!textarea || !track) return;
    const startY = e.clientY;
    const startScrollTop = textarea.scrollTop;
    const onMove = (ev) => {
      const deltaY = ev.clientY - startY;
      const maxThumbTop = Math.max(1, track.clientHeight - thumbHeight);
      const scrollDelta = (deltaY / maxThumbTop) * (textarea.scrollHeight - textarea.clientHeight);
      textarea.scrollTop = startScrollTop + scrollDelta;
      updateScrollbarMetrics();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [thumbHeight, updateScrollbarMetrics]);

  // Permitir arrastrar clicando en el track directamente
  useEffect(() => {
    const track = trackRef.current;
    const textarea = inputRef.current;
    if (!track || !textarea) return;
    const onTrackMouseDown = (e) => {
      const rect = track.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const clamped = Math.max(0, Math.min(rect.height - thumbHeight, clickY - thumbHeight / 2));
      const ratio = clamped / Math.max(1, rect.height - thumbHeight);
      textarea.scrollTop = ratio * (textarea.scrollHeight - textarea.clientHeight);
      updateScrollbarMetrics();
    };
    track.addEventListener('mousedown', onTrackMouseDown);
    return () => track.removeEventListener('mousedown', onTrackMouseDown);
  }, [thumbHeight, updateScrollbarMetrics]);

  // ---- Autosize del textarea con tope de 7 líneas y actualización de altura de barra ----
  const autosizeTextarea = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const style = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const borderBottom = parseFloat(style.borderBottomWidth) || 0;
    const maxHeight = (lineHeight * 7) + paddingTop + paddingBottom + borderTop + borderBottom;
    const baseHeight = (lineHeight * 1) + paddingTop + paddingBottom + borderTop + borderBottom;
    textarea.style.height = 'auto';
    const desired = Math.max(baseHeight, Math.min(textarea.scrollHeight, maxHeight)) - 2; // bajar 2px
    textarea.style.height = desired + 'px';
    // Asegurar que no haya posicionamiento superior: anclado por bottom en CSS
    textarea.style.top = '';

    // Mostrar/ocultar scrollbar personalizada
    const needs = textarea.scrollHeight > maxHeight;
    textarea.style.overflowY = 'auto';
    setShowCustomScrollbar(needs);
    // Añadir o quitar clase para aplicar compresión de texto solo cuando hay scroll
    if (needs) {
      textarea.classList.add('has-scroll');
      if (wrapperRef.current) wrapperRef.current.classList.add('has-scroll');
      if (formRef.current) formRef.current.classList.add('input-has-scroll');
    } else {
      textarea.classList.remove('has-scroll');
      if (wrapperRef.current) wrapperRef.current.classList.remove('has-scroll');
      if (formRef.current) formRef.current.classList.remove('input-has-scroll');
    }
    // Actualizar métricas en el próximo frame para asegurar layout correcto
    if (needs) {
      // Actualizar inmediatamente y en el próximo frame para evitar pulgar pequeño
      updateScrollbarMetrics();
      requestAnimationFrame(updateScrollbarMetrics);
    }

    // Ya no actualizamos la altura del contenedor; queda fija por CSS
  }, [updateScrollbarMetrics]);

  useEffect(() => {
    autosizeTextarea();
  }, [input, autosizeTextarea]);

  useEffect(() => {
    // Inicializar altura correcta al montar y al redimensionar ventana
    const onResize = () => autosizeTextarea();
    setTimeout(() => autosizeTextarea(), 0);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [autosizeTextarea]);

  // ---------- Respuestas locales (p.ej., ejemplos de código) ----------
  const maybeLocalCodeAnswer = useCallback((userText) => {
    const text = (userText || '').toLowerCase();
    const asksJavaFib = (text.includes('fibonacci') || text.includes('sucesion de fibonacci') || text.includes('sucesión de fibonacci')) && text.includes('java');
    if (asksJavaFib) {
      const answer = [
        'Aquí tienes dos implementaciones de Fibonacci en Java (recursiva e iterativa):',
        '',
        '```java',
        'public class Fibonacci {',
        '    // Versión recursiva (simple)',
        '    public static long fibRec(int n) {',
        '        if (n <= 1) return n;\n        return fibRec(n - 1) + fibRec(n - 2);',
        '    }',
        '',
        '    // Versión iterativa (eficiente)',
        '    public static long fibIt(int n) {',
        '        if (n <= 1) return n;\n        long a = 0, b = 1;\n        for (int i = 2; i <= n; i++) {\n            long c = a + b;\n            a = b;\n            b = c;\n        }\n        return b;',
        '    }',
        '',
        '    public static void main(String[] args) {',
        '        int limite = 10;\n        for (int i = 0; i < limite; i++) {\n            System.out.print(fibIt(i) + " ");\n        }',
        '    }',
        '}',
        '```'
      ].join('\n');
      return answer;
    }
    return null;
  }, []);

  // Detección y render de bloques de código ```
  const hasCodeBlock = useCallback((content) => /```[\s\S]*?```/m.test(content || ''), []);
  const hasMathInlineOrBlock = useCallback((content) => /\\\[|\\\(|\$\$|(^|[^\\])\$/m.test(String(content || '').replace(/\\\\/g, '\\')), []);

  // Resaltado simple: convierte código en elementos con spans de tokens
  const highlightCodeToElements = useCallback((rawCode, langHint) => {
    const code = String(rawCode ?? '');
    const nodes = [];
    let index = 0;
    const master = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b)/g;

    const pushTextWithKeywords = (text) => {
      if (!text) return;
      const lang = (langHint || '').toLowerCase();
      const keywordSets = {
        javascript: 'const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|new|this|try|catch|finally|throw|import|from|export|extends|super|async|await|typeof|instanceof|in|of|void|delete|null|undefined|true|false',
        typescript: 'const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|new|this|try|catch|finally|throw|import|from|export|extends|super|async|await|typeof|instanceof|in|of|void|delete|null|undefined|true|false|interface|type',
        java: 'public|private|protected|class|interface|static|final|void|int|long|double|float|boolean|char|new|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|throws|extends|implements|null|true|false|String',
        python: 'def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|lambda|pass|break|continue|True|False|None|and|or|not|in|is|global|nonlocal',
        bash: 'if|then|fi|elif|else|for|in|do|done|case|esac|function|select|until|while|return|local|export',
      };
      const base = keywordSets[lang] || keywordSets.javascript;
      const kw = new RegExp(`\\b(${base})\\b`, 'g');

      const defPatterns = [];
      if (lang === 'python') defPatterns.push({ re: /(def)\s+([A-Za-z_]\w*)/g, types: ['keyword', 'function'] });
      if (lang === 'javascript' || lang === 'typescript') defPatterns.push({ re: /(function)\s+([A-Za-z_]\w*)/g, types: ['keyword', 'function'] });
      if (lang === 'java' || lang === 'javascript' || lang === 'typescript' || lang === 'python') defPatterns.push({ re: /(class)\s+([A-Za-z_]\w*)/g, types: ['keyword', 'class-name'] });

      const applyDefs = (segment) => {
        if (!defPatterns.length) return [segment];
        let parts = [segment];
        defPatterns.forEach(({ re, types }) => {
          const newParts = [];
          parts.forEach((p) => {
            if (typeof p !== 'string') { newParts.push(p); return; }
            let last = 0; let m;
            while ((m = re.exec(p)) !== null) {
              if (m.index > last) newParts.push(p.slice(last, m.index));
              newParts.push(<span key={`kw-${index++}`} className={`token ${types[0]}`}>{m[1]}</span>);
              newParts.push(' ');
              newParts.push(<span key={`fn-${index++}`} className={`token ${types[1]}`}>{m[2]}</span>);
              last = re.lastIndex;
            }
            if (last < p.length) newParts.push(p.slice(last));
          });
          parts = newParts;
        });
        return parts;
      };

      const defApplied = applyDefs(text);
      defApplied.forEach((seg) => {
        if (typeof seg !== 'string') { nodes.push(seg); return; }
        let last = 0; let m;
        while ((m = kw.exec(seg)) !== null) {
          if (m.index > last) nodes.push(seg.slice(last, m.index));
          nodes.push(<span key={`kwd-${index++}`} className="token keyword">{m[1]}</span>);
          last = kw.lastIndex;
        }
        if (last < seg.length) nodes.push(seg.slice(last));
      });
    };

    let m;
    while ((m = master.exec(code)) !== null) {
      const before = code.slice(index, m.index);
      pushTextWithKeywords(before);
      const token = m[0];
      const cls = token.startsWith('/*') || token.startsWith('//') || token.startsWith('#') || token.startsWith('"""') || token.startsWith("'''") ? 'comment'
        : (/^\d/.test(token) ? 'number' : 'string');
      nodes.push(<span key={`tok-${index++}`} className={`token ${cls}`}>{token}</span>);
      index = master.lastIndex;
    }
    if (index < code.length) pushTextWithKeywords(code.slice(index));
    return nodes;
  }, []);

  // Tarjeta visual de código con botón Copiar y feedback sutil
  const CodeCardBlock = useCallback(({ code, lang }) => {
    const [copied, setCopied] = useState(false);
    const onCopy = async () => {
      try {
        await navigator.clipboard?.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      } catch {}
    };
    return (
      <div className="code-card">
        <div className="code-card__header">
          <span className="code-card__lang">{(lang || 'código').toLowerCase()}</span>
          <button
            type="button"
            className={`code-card__copy ${copied ? 'copied' : ''}`}
            onClick={onCopy}
            title={copied ? 'Copiado' : 'Copiar código'}
          >
            {copied ? '✓' : 'Copiar'}
          </button>
        </div>
        <pre className="code-block"><code className={`language-${lang}`}>{highlightCodeToElements(code, lang)}</code></pre>
      </div>
    );
  }, [highlightCodeToElements]);

  // Render simple para fórmulas LaTeX; si KaTeX no está cargado, lo carga y luego renderiza
  const MathOrText = ({ text }) => {
    const containerRef = useRef(null);
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const source = String(text ?? '').replace(/\\\\/g, '\\');
      const hasMath = /\\\[|\\\(|\$\$|(^|[^\\])\$/.test(source);

      const renderNow = () => {
        const toMinimalMarkdown = (s) => {
          // Markdown mínimo: **negrita**, *cursiva**, `inline`, saltos de línea, tablas
          const escapeHtml = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
          const text = String(s);

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

          let textWithPlaceholders = text.replace(/(\|.+\|(?:\r?\n)\|[-:| ]+\|(?:\r?\n)(?:\|.+\|(?:\r?\n)?)*)/g, (tableMatch) => {
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
          // Permitir negritas abarcando saltos de línea
          html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
          html = html.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1<em>$2</em>');
          // Encabezados simples (#, ##, ###) SOLO en texto plano (este renderer no procesa código ni LaTeX)
          html = html.replace(/^(#{1,3})\s+(.+)$/gm, (_m, hashes, title) => {
            const level = hashes.length;
            const cls = level === 1 ? 'sk-h1' : level === 2 ? 'sk-h2' : 'sk-h3';
            return `<span class="${cls}">${title}</span>`;
          });
          // Linkificar URLs http(s) en texto normal (cubre toda la URL y recorta puntuación suelta al final)
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
          return html;
        };
        if (!hasMath || !window.katex) {
          el.innerHTML = toMinimalMarkdown(source);
          return;
        }
        const re = /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|(^|[^\\])\$([^$\n]+?)\$/g;
        let last = 0; let m; el.innerHTML = '';
        while ((m = re.exec(source)) !== null) {
          if (m.index > last) {
            const t = source.slice(last, m.index);
            const span = document.createElement('span');
            span.innerHTML = toMinimalMarkdown(t);
            el.appendChild(span);
          }
          const formula = m[1] || m[2] || m[3] || m[5] || '';
          const display = Boolean(m[1] || m[3]);
          const mathEl = document.createElement('span');
          window.katex.render(formula, mathEl, { displayMode: display, throwOnError: false });
          el.appendChild(mathEl);
          last = re.lastIndex;
        }
        if (last < source.length) {
          const span = document.createElement('span');
          span.innerHTML = toMinimalMarkdown(source.slice(last));
          el.appendChild(span);
        }
      };

      if (hasMath && !window.katex) {
        // Carga diferida de KaTeX si no existe
        const head = document.head || document.getElementsByTagName('head')[0];
        if (!document.querySelector('link[data-katex]')) {
          const link = document.createElement('link');
          link.setAttribute('data-katex', '1');
          link.rel = 'stylesheet';
          link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
          head.appendChild(link);
        }
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js';
        script.defer = true;
        script.onload = renderNow;
        script.onerror = () => { el.textContent = source; };
        head.appendChild(script);
      } else {
        renderNow();
      }
    }, [text]);
    return <span ref={containerRef} style={{ whiteSpace: 'pre-wrap' }} />;
  };

  const renderWithCodeBlocks = useCallback((content) => {
    const input = String(content || '');
    const regex = /```([^\n`]*)?\r?\n([\s\S]*?)```/g;
    const elements = [];
    let lastIndex = 0;
    let match;
    let key = 0;
    while ((match = regex.exec(input)) !== null) {
      const textBefore = input.slice(lastIndex, match.index);
      if (textBefore) {
        elements.push(<MathOrText key={`t-${key++}`} text={textBefore} />);
      }
      const lang = (match[1] || '').trim();
      const code = match[2] || '';
      const isMathLang = ['math', 'latex', 'tex'].includes(lang.toLowerCase());
      const looksMath = isMathLang || /\\\[|\\\(|\\begin\{(align\*?|equation\*?|gather\*?|cases)\}/.test(code.replace(/\\\\/g, '\\'));
      if (looksMath) {
        elements.push(<div key={`mb-${key++}`} className="math-flow"><MathOrText text={code} /></div>);
      } else {
        elements.push(<CodeCardBlock key={`cb-${key++}`} code={code} lang={lang} />);
      }
      lastIndex = regex.lastIndex;
    }
    const tail = input.slice(lastIndex);
    if (tail) {
      // La cola puede tener expresiones LaTeX \[ ... \] o \( ... \)
      elements.push(<MathOrText key={`t-${key++}`} text={tail} />);
    }
    return elements;
  }, []);

  // Función memoizada para marcar mensaje como mostrado
  const markMessageAsShown = useCallback((messageId) => {
    setShownMessages(prev => {
      const newSet = new Set([...prev, messageId]);
      saveShownMessages(newSet);
      return newSet;
    });
  }, [saveShownMessages]);

  const CodeMessage = useCallback(({ id, content }) => {
    useEffect(() => {
      markMessageAsShown(id);
    }, [id, markMessageAsShown]);
    return (
      <>
        {renderWithCodeBlocks(content)}
      </>
    );
  }, [renderWithCodeBlocks, markMessageAsShown]);

  const MathMessage = useCallback(({ id, content }) => {
    useEffect(() => {
      markMessageAsShown(id);
    }, [id, markMessageAsShown]);
    return <MathOrText text={content} />;
  }, [markMessageAsShown]);

  // Map global para persistir progreso de CodeAndTextTypewriter
  const codeTypewriterProgressMapRef = useRef(new Map());

  // Typewriter segmentado: texto normal y bloques de código se animan con formato.
  const CodeAndTextTypewriterComponent = ({ content, speed = 20, interrupt = false, forceTypewriter = true, onProgress, onComplete, id }) => {
    const count = (globalMountCountRef.current.get(id) || 0) + 1;
    globalMountCountRef.current.set(id, count);
    try { if (debugTypewriterRef.current) console.log(`[TW][code] mount #${count}`, { id, speed, forceTypewriter, contentLen: String(content||'').length }); } catch {}
    const [segIndex, setSegIndex] = useState(0);
    const [charIndex, setCharIndex] = useState(0);
    const [done, setDone] = useState(false);
    const timeoutRef = useRef(null);
    const segIdxRef = useRef(0);
    const charIdxRef = useRef(0);
    const onProgressRef = useRef(onProgress);
    const onCompleteRef = useRef(onComplete);
    const tickRef = useRef(null);
    const lastAdvanceRef = useRef(Date.now());
    const stallCountRef = useRef(0);
    const lastProgressCallRef = useRef(0); // Para throttle
    const mountIdRef = useRef(`mount-${Math.random().toString(36).slice(2,8)}`);

    useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);
    useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

    // Restaurar progreso al montar, guardar al desmontar
    useEffect(() => {
      if (id && forceTypewriter) {
        const saved = codeTypewriterProgressMapRef.current.get(id);
        if (saved) {
          segIdxRef.current = saved.segIndex;
          charIdxRef.current = saved.charIndex;
          setSegIndex(saved.segIndex);
          setCharIndex(saved.charIndex);
          if (saved.done) setDone(true);
          try { if (debugTypewriterRef.current) console.log('[TW][code] restore progress', { id, saved }); } catch {}
        }
      }

      return () => {
        if (id && forceTypewriter) {
          codeTypewriterProgressMapRef.current.set(id, {
            segIndex: segIdxRef.current,
            charIndex: charIdxRef.current,
            done
          });
          try { if (debugTypewriterRef.current) console.log('[TW][code] save progress', { id, segIndex: segIdxRef.current, charIndex: charIdxRef.current, done }); } catch {}
        }
      };
    }, [id, forceTypewriter, done]);

     // Utilidades para detectar contenido matemático (LaTeX)
    const isMathLanguage = (lang) => ['math', 'latex', 'tex', 'katex'].includes(String(lang || '').toLowerCase());
    const looksLikeMath = (lang, code) => {
      const src = String(code || '').replace(/\\\\/g, '\\');
      return isMathLanguage(lang) || /\\\[|\\\(|\\begin\{(align\*?|equation\*?|gather\*?|cases)\}|\$\$|(^|[^\\])\$/m.test(src);
    };

    // Preparar segmentos (texto o código) marcando si el bloque de código es matemático
    const segments = React.useMemo(() => {
      const input = String(content || '');
      const regex = /```([^\n`]*)?\r?\n([\s\S]*?)```/g;
      const segs = [];
      let last = 0; let m;
      while ((m = regex.exec(input)) !== null) {
        if (m.index > last) segs.push({ kind: 'text', text: input.slice(last, m.index) });
        const lang = (m[1] || '').trim();
        const code = m[2] || '';
        segs.push({ kind: 'code', lang, code, isMath: looksLikeMath(lang, code) });
        last = regex.lastIndex;
      }
      const tail = input.slice(last);
      if (tail) segs.push({ kind: 'text', text: tail });
      try { twLog('segments prepared', { id, total: segs.length, segs }); } catch {}
      return segs;
    }, [content, id]);

    // Dividir texto en partes de texto plano y bloques LaTeX para no mostrar fórmulas incompletas
    const splitTextForMath = useCallback((src) => {
      const text = String(src || '');
      const parts = [];
      let i = 0; let last = 0;
      const pushText = (from, to) => { if (to > from) parts.push({ kind: 'text', start: from, end: to, text: text.slice(from, to) }); };
      const isUnescapedDollar = (idx) => {
        if (text[idx] !== '$') return false;
        let backslashes = 0; let k = idx - 1;
        while (k >= 0 && text[k] === '\\') { backslashes++; k--; }
        return (backslashes % 2) === 0;
      };
      while (i < text.length) {
        if (text[i] === '$' && text[i + 1] === '$') {
          const end = text.indexOf('$$', i + 2);
          if (end !== -1) {
            pushText(last, i);
            const j = end + 2;
            parts.push({ kind: 'math', start: i, end: j, text: text.slice(i, j) });
            i = j; last = j; continue;
          }
        }
        if (text.startsWith('\\[', i)) {
          const end = text.indexOf('\\]', i + 2);
          if (end !== -1) {
            pushText(last, i);
            const j = end + 2;
            parts.push({ kind: 'math', start: i, end: j, text: text.slice(i, j) });
            i = j; last = j; continue;
          }
        }
        if (text.startsWith('\\(', i)) {
          const end = text.indexOf('\\)', i + 2);
          if (end !== -1) {
            pushText(last, i);
            const j = end + 2;
            parts.push({ kind: 'math', start: i, end: j, text: text.slice(i, j) });
            i = j; last = j; continue;
          }
        }
        if (isUnescapedDollar(i)) {
          let j = i + 1;
          while (j < text.length && text[j] !== '\n') {
            if (isUnescapedDollar(j)) break;
            j++;
          }
          if (j < text.length && text[j] === '$' && isUnescapedDollar(j)) {
            pushText(last, i);
            const end = j + 1;
            parts.push({ kind: 'math', start: i, end, text: text.slice(i, end) });
            i = end; last = end; continue;
          }
        }
        i++;
      }
      if (last < text.length) pushText(last, text.length);
      // silencioso
      return parts;
    }, []);

    useEffect(() => {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      // Si no queremos typewriter, saltar al final inmediatamente y no iniciar tick
      if (!forceTypewriter) {
        segIdxRef.current = segments.length;
        charIdxRef.current = 0;
        setSegIndex(segments.length);
        setCharIndex(0);
        setDone(true);
        try { twLog('static render: forceTypewriter=false. segments', segments.length); } catch {}
        return () => { if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; } };
      }

      // Si hay progreso guardado, NO resetear al 0
      const hasSavedProgress = (segIdxRef.current > 0 || charIdxRef.current > 0);
      if (!hasSavedProgress) {
        setSegIndex(0); setCharIndex(0); setDone(false);
        segIdxRef.current = 0; charIdxRef.current = 0;
      } else {
        try { if (debugTypewriterRef.current) console.log('[TW][code] continue from saved', { id, segIndex: segIdxRef.current, charIndex: charIdxRef.current }); } catch {}
        setDone(false);
      }
      if (!content) { onComplete && onComplete(); return; }

      const tick = () => {
        if (interrupt) return;
        const si = segIdxRef.current;
        const ci = charIdxRef.current;
        const seg = segments[si];
        if (!seg) {
          setDone(true);
          if (typeof onCompleteRef.current === 'function') onCompleteRef.current();
          // silencioso
          return;
        }
        const isText = seg.kind === 'text';
        const totalLen = isText ? seg.text.length : seg.code.length;
        if (ci >= totalLen) {
          segIdxRef.current = si + 1;
          charIdxRef.current = 0;
          setSegIndex(segIdxRef.current);
          setCharIndex(0);
          timeoutRef.current = setTimeout(tick, speed);
          // silencioso
          return;
        }
        // Avance: texto normal de a un carácter; si estamos dentro de una región LaTeX, saltar hasta el final de esa región en un paso.
        let nextIndex = ci + 1;
        if (isText) {
          const parts = splitTextForMath(seg.text);
          for (let k = 0; k < parts.length; k++) {
            const p = parts[k];
            if (ci >= p.start && ci < p.end) {
              if (p.kind === 'math') {
                nextIndex = p.end; // saltar fórmula completa
              }
              break;
            }
          }
          // Aumentar paso para textos largos (sin fórmulas)
          if (nextIndex === ci + 1) {
            const segLen = seg.text.length;
            const extra = segLen > 2000 ? 3 : segLen > 800 ? 1 : 0;
            nextIndex = Math.min(ci + 1 + extra, totalLen);
          }
        } else {
          // Si es bloque de código matemático, no mostrar parcial: saltar al final de inmediato
          if (seg.isMath) {
            nextIndex = totalLen;
          } else {
            // Para bloques de código normales, escribir de a 2 caracteres (más fluido)
            nextIndex = Math.min(ci + 2, totalLen);
          }
        }
        charIdxRef.current = nextIndex;
        setCharIndex(nextIndex);
        lastAdvanceRef.current = Date.now();

        // Progreso acumulado como string para onProgress (con throttle para evitar scroll excesivo)
        try {
          if (typeof onProgressRef.current === 'function') {
            const now = Date.now();
            // Throttle: solo llamar cada 50ms o al completar segmento
            if (now - lastProgressCallRef.current > 50 || charIdxRef.current === totalLen) {
              let typed = '';
              for (let i = 0; i < segments.length; i++) {
                const s = segments[i];
                if (i < segIdxRef.current) {
                  if (s.kind === 'text') typed += s.text; else typed += (`\n\n\`\`\`${s.lang}\n${s.code}\`\`\``);
                } else if (i === segIdxRef.current) {
                  if (s.kind === 'text') {
                    const parts = splitTextForMath(s.text);
                    const upto = charIdxRef.current;
                    parts.forEach((p) => {
                      if (p.kind === 'text') {
                        const end = Math.min(p.end, upto);
                        if (end > p.start) typed += p.text.slice(0, end - p.start);
                      } else if (p.kind === 'math') {
                        if (p.end <= upto) typed += p.text;
                      }
                    });
                  } else {
                    if (!s.isMath) typed += `\n\n\`\`\`${s.lang}\n${s.code.slice(0, charIdxRef.current)}`;
                  }
                }
              }
              try { onProgressRef.current(typed); } catch (e) { try { console.warn('[TW][code] onProgress error', e); } catch {} }
              lastProgressCallRef.current = now;
            }
          }
        } catch {}

        // Pausa más larga al inicio de bloques matemáticos para evitar "flash"
        const isMathBlockStart = (!isText && seg.isMath && ci === 0);
        const delay = isMathBlockStart ? Math.max(speed * 4, 200) : speed;
        timeoutRef.current = setTimeout(tick, delay);
      };

      tickRef.current = tick;
      timeoutRef.current = setTimeout(tick, speed);
      // Watchdog anti-bloqueos: si no avanzamos por >4s, reintentar (no fuerza finalizar)
      const watchdog = setInterval(() => {
        if (interrupt || !forceTypewriter || done) return;
        const delta = Date.now() - lastAdvanceRef.current;
        if (delta > 4000) {
          stallCountRef.current += 1;
          // Reintentar el tick para "desatascar" el avance
          if (typeof tickRef.current === 'function') tickRef.current();
        } else {
          stallCountRef.current = 0;
        }
      }, 600);

      return () => {
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        try { clearInterval(watchdog); } catch {}
      };
    }, [content, segments, speed, interrupt, forceTypewriter]);

    // Render: segmentos completados en formato; en el actual, ocultar LaTeX incompleto
    const rendered = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (i < segIndex) {
        if (s.kind === 'text') rendered.push(<MathOrText key={`t-full-${i}`} text={s.text} />);
        else if (s.isMath) rendered.push(<div key={`mb-full-${i}`} className="math-flow"><MathOrText text={s.code} /></div>);
        else rendered.push(<CodeCardBlock key={`c-full-${i}`} code={s.code} lang={s.lang} />);
      } else if (i === segIndex) {
        if (s.kind === 'text') {
          const parts = splitTextForMath(s.text);
          const upto = charIndex;
          const nodes = [];
          let keyIdx = 0;
          parts.forEach((p) => {
            if (p.kind === 'text') {
              const end = Math.min(p.end, upto);
              if (end > p.start) nodes.push(<MathOrText key={`pt-${i}-${keyIdx++}`} text={p.text.slice(0, end - p.start)} />);
            } else if (p.kind === 'math') {
              if (p.end <= upto) nodes.push(<MathOrText key={`pm-${i}-${keyIdx++}`} text={p.text} />);
            }
          });
          if (nodes.length === 0) nodes.push(<span key={`ph-${i}`} style={{ visibility: 'hidden' }}>.</span>);
          rendered.push(<React.Fragment key={`t-part-${i}`}>{nodes}</React.Fragment>);
        } else {
          // Bloque de código matemático: evitar parpadeo mostrando un placeholder visible
          if (s.isMath) {
            rendered.push(<span key={`c-ph-${i}`} style={{ opacity: 0.6 }}>[bloque matemático]</span>);
          } else {
            rendered.push(<CodeCardBlock key={`c-part-${i}`} code={s.code.slice(0, Math.max(0, charIndex))} lang={s.lang} />);
          }
        }
      }
    }

    // En modo estático (sin typewriter) o cuando ya se terminó, devolvemos render completo y estable
    if (!forceTypewriter || done) {
      // silencioso
      // Renderizar una única vez de forma estable sin depender de estado interno
      return renderWithCodeBlocks(content);
    }
    // Typewriter en curso
    if (rendered.length === 0) {
      return <span style={{ visibility: 'hidden' }}>.</span>;
    }
    return <>{rendered}</>;
  };

  // Memoizar CodeAndTextTypewriter para evitar re-renders innecesarios
  // IMPORTANTE: Usar useMemo para que la definición del componente sea estable entre renders
  const CodeAndTextTypewriter = useMemo(() => {
    return React.memo(CodeAndTextTypewriterComponent, (prevProps, nextProps) => {
      // Solo re-renderizar si cambian props críticas (ignorando callbacks)
      return (
        prevProps.id === nextProps.id &&
        prevProps.content === nextProps.content &&
        prevProps.speed === nextProps.speed &&
        prevProps.forceTypewriter === nextProps.forceTypewriter &&
        prevProps.interrupt === nextProps.interrupt
        // onProgress y onComplete se ignoran en la comparación
      );
    });
  }, []); // Array vacío = solo crear una vez


  // Inicializar shownMessages desde localStorage
  useEffect(() => {
    const storedShownMessages = loadShownMessages();
    setShownMessages(storedShownMessages);
  }, [loadShownMessages]);

  // Cargar mensajes de una conversación
  const loadMessages = async (convId) => {
    if (!convId) return;

    try {
      // Cancelar cualquier fetch anterior para evitar mezclar resultados
      if (messagesFetchAbortRef.current) {
        try { messagesFetchAbortRef.current.abort(); } catch {}
      }
      const fetchAbort = new AbortController();
      messagesFetchAbortRef.current = fetchAbort;
      const token = getAuthToken();
      const response = await fetch(`http://localhost:10000/api/messages/conversation/${convId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        signal: fetchAbort.signal
      });

      if (response.ok) {
        const data = await response.json();
        const loadedMessages = data.data || [];

        // Marcar mensajes cargados como mostrados para evitar typewriter en futuras visitas
        const messageIds = loadedMessages.map(msg => {
          // Para mensajes de usuario vacíos con adjuntos, usar clave estable para no duplicar
          const base = `${msg.role}|${String(msg.content || '').trim()}`;
          const att = (Array.isArray(msg.attachments)?msg.attachments:[]).map(a=>a.filename||a.name||'').join(',');
          return msg._id || msg.id || `${base}|${att}`;
        });

        // Actualizar shownMessages con los mensajes cargados
        setShownMessages(prev => {
          const newSet = new Set([...prev, ...messageIds]);
          saveShownMessages(newSet);
          return newSet;
        });

        // Marcar mensajes como no nuevos para evitar typewriter y mapear archivo generado
        const messagesWithFlags = loadedMessages.map(msg => {
          // 🔧 LIMPIAR DATOS CORRUPTOS: Solo usar generatedFile si es un mensaje de assistant Y tiene contenido de archivo real
          let shouldShowFile = false;
          if (msg.role === 'assistant' && msg.generatedFile) {
            // Verificar que el generatedFile tenga campos válidos (no solo null/undefined)
            const gf = msg.generatedFile;
            shouldShowFile = gf.nombre && gf.formato && gf.url && gf.mensaje;
          }

          return {
            ...msg,
            isNew: false, // Los mensajes cargados no son nuevos
            // Solo mapear generatedFile a file si es válido
            file: shouldShowFile ? {
              ...msg.generatedFile,
              isImage: msg.generatedFile.formato === 'IMAGE' || msg.generatedFile.formato === 'image'
            } : null,
            // Asegurar que los attachments se muestren correctamente
          attachments: msg.attachments ? msg.attachments.map(att => {
            const fileName = att.filename || att.name || '';
            let kind = att.kind;

            // Si el kind no está definido o es 'file', determinarlo por extensión
            if (!kind || kind === 'file') {
              const lowerName = fileName.toLowerCase();
              if (lowerName.endsWith('.pdf')) kind = 'pdf';
              else if (lowerName.endsWith('.docx')) kind = 'docx';
              else if (lowerName.endsWith('.pptx')) kind = 'pptx';
              else if (lowerName.endsWith('.xlsx')) kind = 'xlsx';
              else if (lowerName.endsWith('.csv')) kind = 'csv';
              else if (lowerName.endsWith('.txt')) kind = 'txt';
              else if (lowerName.match(/\.(png|jpe?g|gif|bmp|webp)$/)) kind = 'image';
              else kind = 'file';
            }

            const mappedAtt = {
              ...att,
              name: fileName,
              kind: kind,
              isImage: kind === 'image',
              isDocument: ['pdf', 'docx', 'xlsx', 'csv', 'txt'].includes(kind),
              result: att.extractResult
            };

            return mappedAtt;
          }) : []
          };
        });
        // Proteger contra resultados tardíos de una conversación que ya no es la activa
        if (activeConversationIdRef.current !== convId) {
          return;
        }
        // Combinar con mensajes optimistas de esta conversación (si existen), evitando duplicar
        const pending = optimisticByConvRef.current.get(convId) || [];
        const contentKey = (m) => {
          const base = `${m.role}|${String(m.content || '').trim()}`;
          const att = (Array.isArray(m.attachments)?m.attachments:[]).map(a=>a.filename||a.name||'').join(',');
          return `${base}|${att}`;
        };
        const normalizeKey = (m) => {
          const role = m.role;
          const contentTrim = String(m.content || '').trim();
          // Normalizar contenido vacío: "" y "(mensaje vacío)" son equivalentes
          const normalizedContent = (contentTrim === '' || contentTrim === '(mensaje vacío)') ? 'EMPTY' : contentTrim;
          const atts = Array.isArray(m.attachments) ? m.attachments : [];
          const numImgs = atts.filter(x => x?.isImage || x?.kind === 'image' || (x?.type && x.type.startsWith('image/'))).length;
          const numDocs = Math.max(0, atts.length - numImgs);
          return `${role}|${normalizedContent}|i:${numImgs}|d:${numDocs}`;
        };
        const serverContentKeys = new Set(messagesWithFlags.map(contentKey));
        const serverIds = new Set(messagesWithFlags.map(m => m._id).filter(Boolean));
        const serverNormKeys = new Set(messagesWithFlags.map(normalizeKey));

        const onlyPending = pending
          // Solo mantener mensajes de usuario en el buffer (las respuestas del bot no deben estar en optimista)
          .filter(m => m.role === 'user')
          // Si ya está en servidor por _id, eliminar
          .filter(m => !(m._id && serverIds.has(m._id)))
          // Si coincide por key exacta (incluye nombres) también eliminar
          .filter(m => !serverContentKeys.has(contentKey(m)))
          // Fallback robusto: si coincide por normalización (vacíos con adjuntos) también eliminar
          .filter(m => !serverNormKeys.has(normalizeKey(m)));
        const merged = [...messagesWithFlags, ...onlyPending].sort((a,b)=>{
          const ta = new Date(a.createdAt || 0).getTime();
          const tb = new Date(b.createdAt || 0).getTime();
          return ta - tb;
        });

        setMessages(merged);
        // Si ya hay mensajes del servidor, podemos limpiar el buffer optimista para este convId
        if ((messagesWithFlags?.length || 0) > 0) {
          optimisticByConvRef.current.delete(convId);
        }
      }
    } catch (error) {
      // Ignorar AbortError - es normal cuando se cambia de conversación rápidamente
      if (error.name === 'AbortError') {
          return;
      }
      console.error('Error cargando mensajes:', error);
    }
  };

  // Crear nueva conversación
  const createNewConversation = async (firstMessage, attachmentsForTitle = []) => {
    try {
      const token = getAuthToken();
      const currentWorkspaceId = localStorage.getItem('currentWorkspaceId');

      // Generar título inteligente basado en contenido o adjuntos
      let title = firstMessage || 'Nueva conversación';

      // Si no hay texto pero hay adjuntos, generar título basado en el contenido de los adjuntos
      if ((!firstMessage || firstMessage.trim() === '') && attachmentsForTitle && attachmentsForTitle.length > 0) {
        // Heurística de calidad para evitar usar OCR ruidoso como título
        const scoreQuality = (s) => {
          if (!s) return 0;
          const t = String(s).trim();
          if (!t) return 0;
          const len = t.length;
          const spaces = (t.match(/\s/g) || []).length;
          const longTokens = t.split(/\s+/).filter(w => w.length >= 18).length;
          const repeats = /([A-ZÁÉÍÓÚÜÑ])\1{3,}/.test(t);
          const underscores = (t.match(/_/g) || []).length;
          const ratioSpaces = spaces / Math.max(1, len);
          // Puntuación simple: más espacios (palabras), menos tokens larguísimos, menos repeticiones
          let score = (ratioSpaces * 2.5) + (len > 40 ? 0.5 : 0.0) - (longTokens * 1.0) - (repeats ? 1.5 : 0) - (underscores * 0.1);
          // Bonus si contiene palabras comunes en español
          if (/\b(la|el|de|es|cuanto|cuánto|raiz|raíz|cuadrada|numero|número)\b/i.test(t)) score += 1.0;
          return score;
        };

        const extractedTexts = attachmentsForTitle
          .filter(att => (att.result?.full_text || att.result?.text))
          .map(att => att.result.full_text || att.result.text)
          .filter(text => text && text.trim().length > 0 && scoreQuality(text) >= 0.8);

        if (extractedTexts.length > 0) {
          // Tomar las primeras palabras del texto extraído para generar un título descriptivo
          const combinedText = extractedTexts.join(' ').trim();
          // Limpiar el texto: remover caracteres extraños y normalizar espacios
          let cleanedText = combinedText
            .replace(/[^\w\s¿¡.,?!áéíóúüñÁÉÍÓÚÜÑ]/g, ' ') // Solo letras, números, espacios y puntuación básica
            .replace(/\s+/g, ' ') // Normalizar espacios múltiples
            .trim();

          // Si el texto parece malformado (palabras muy largas sin espacios), intentar separar
          if (cleanedText.includes('f') && cleanedText.length > 20) {
            // Intentar separar palabras que fueron unidas incorrectamente
            cleanedText = cleanedText
              .replace(/f/g, ' ') // Las 'f' parecen ser espacios mal interpretados
              .replace(/\s+/g, ' ')
              .trim();
          }

          const words = cleanedText.split(/\s+/).filter(word => word.length > 1 && word.length < 20).slice(0, 6); // Palabras válidas (ni muy cortas ni muy largas)
          title = words.join(' ');

          // Si el título sigue siendo muy raro, usar un título genérico descriptivo
          if (title.length < 5 || title.includes('undefined') || /^[a-zA-Z]{20,}/.test(title)) {
            // Si detectamos números, marcarlo como consulta matemática
            const anyDigits = (attachmentsForTitle || []).some(att => Array.isArray(att?.result?.digits) && att.result.digits.length > 0);
            title = anyDigits ? `Consulta matemática (imagen)` : `Consulta desde imagen`;
          }

          // Si es muy corto, agregar contexto del tipo de archivo
          if (title.length < 10) {
            const fileTypes = attachmentsForTitle.map(att => {
              if (att.kind === 'image') return 'imagen';
              if (att.kind === 'pdf') return 'PDF';
              if (att.kind === 'docx') return 'documento';
              return 'archivo';
            });
            const uniqueTypes = [...new Set(fileTypes)];
            title = `${title} (${uniqueTypes.join(', ')})`;
          }
        } else {
          // Si no hay texto extraído, usar nombres de archivos
          const fileNames = attachmentsForTitle
            .map(att => att.name || att.filename || 'archivo')
            .slice(0, 2); // Máximo 2 nombres
          title = fileNames.join(', ');
        }
      }

      // Limitar el título a 200 caracteres
      const body = {
        title: title.slice(0, 200),
      };
      if (currentWorkspaceId) {
        body.workspaceId = currentWorkspaceId;
      }

      const response = await fetch('http://localhost:10000/api/conversations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        const data = await response.json();

        const newConversationId = data.data._id;

        setJustCreatedConversation(true);
        setConversationId(newConversationId);
        activeConversationIdRef.current = newConversationId;
        conversationIdRef.current = newConversationId;
        if (onConversationCreated) {
          onConversationCreated(newConversationId);
        }
        return newConversationId;
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error('[createNewConversation] Error del servidor:', errorData);
      }
    } catch (error) {
      console.error('[createNewConversation] Error creando conversación:', error);
    }
    return null;
  };

  // Guardar mensaje en la base de datos
  const saveMessage = async (content, role = 'user', forceConvId = null, attPayloadOverride = null, generatedFile = null, tempId = null) => {
    let convId = forceConvId || conversationId;
    let isNewConversation = false;
    // Solo crear conversación si es el primer mensaje del usuario
    if (!convId && role === 'user') {
      convId = await createNewConversation(content);
      if (!convId) return;
      setConversationId(convId);
      isNewConversation = true;
    }
    // Si es el bot y no hay convId, no guardar nada
    if (!convId) return;
    try {
      const token = getAuthToken();
      const attPayload = attPayloadOverride !== null ? attPayloadOverride : [];

      const requestBody = {
        conversationId: convId,
        role: role,
        content: content,
        attachments: attPayload
      };

      // Agregar información del archivo generado si existe
      if (generatedFile && generatedFile !== null && generatedFile !== undefined) {
        requestBody.generatedFile = generatedFile;
      }

      const response = await fetch('http://localhost:10000/api/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) {
        console.error('Error guardando mensaje');
      } else {
        if (isNewConversation && onConversationCreated) {
          onConversationCreated(convId);
        }

        // Recargar conversaciones para actualizar el orden en el historial
        try {
          if (selectedWorkspace && selectedWorkspace._id) {
            // Si hay workspace seleccionado, recargar sus conversaciones
            await forceReloadWorkspaceConversations(selectedWorkspace._id);
          } else {
            // Si es conversación general, recargar conversaciones generales
            await reloadGeneralConversationsSilently();
          }
        } catch (error) {
          console.error('Error recargando conversaciones:', error);
        }
      }

      // Mapear _id devuelto al mensaje temporal en UI
      try {
        const data = await response.json();
        const saved = data?.data;
        if (saved && saved._id && tempId) {
          setMessages(prev => prev.map(m => {
            if (m._tempId === tempId) {
              return { ...m, _id: saved._id, _tempId: undefined };
            }
            return m;
          }));
          try {
            const key = convId;
            const list = optimisticByConvRef.current.get(key);
            if (list && list.length) {
              const updated = list.map(m => m._tempId === tempId ? { ...m, _id: saved._id, _tempId: undefined } : m);
              optimisticByConvRef.current.set(key, updated);
            }
          } catch {}
        }
      } catch {}
    } catch (error) {
      console.error('Error guardando mensaje:', error);
    }
  };

  // Cargar mensajes cuando cambie la conversación
  useEffect(() => {
    if (currentConversationId) {
      // Si había tipeo en curso, persistir parcial antes de cambiar
      if (isTypewriting && typingMessageId) {
        const partial = typingProgressRef.current[typingMessageId] || '';
        const pending = pendingAssistantSaveRef.current.get(typingMessageId);
        if (pending && pending.shouldSave !== false) {
          saveMessage(partial, 'assistant', pending.convId, null, pending.archivo);
        }
        if (pending) {
          pendingAssistantSaveRef.current.delete(typingMessageId);
        }
      }
      // Reset de estado de generación/stop al cambiar de chat
      setIsGenerating(false);
      setIsTypewriting(false);
      setTypingMessageId(null);
      setIsGenerating(false);
      setStopRequested(false);
      aiAbortRef.current?.abort();
      typingProgressRef.current = {};
      setConversationId(currentConversationId);
      activeConversationIdRef.current = currentConversationId;
      // Limpiar UI inmediatamente pero preservar mensajes optimistas de esta conversación
      const pending = optimisticByConvRef.current.get(currentConversationId) || [];
      // console.log('🔄 [CONVERSATION-SWITCH] Cambiando a conversación:', currentConversationId);
      // console.log('🔄 [CONVERSATION-SWITCH] Messages actuales:', messages.length);
      // console.log('🔄 [CONVERSATION-SWITCH] Pending messages:', pending.length);
      // console.log('🔄 [CONVERSATION-SWITCH] justCreatedConversation:', justCreatedConversation);
      // console.log('🔄 [CONVERSATION-SWITCH] conversationId actual:', conversationId);

      // Si el conversationId cambió (no es el mismo que acabamos de crear), resetear el flag
      if (conversationId !== currentConversationId) {
        // console.log('🔄 [CONVERSATION-SWITCH] ConversationId cambió, resetear justCreatedConversation');
        setJustCreatedConversation(false);
      }

      // Solo preservar mensajes si son de LA MISMA conversación
      // Si el conversationId cambió, siempre resetear (aunque haya mensajes)
      const isSameConversation = conversationId === currentConversationId;
      // console.log('🔄 [CONVERSATION-SWITCH] Es la misma conversación?', isSameConversation, 'conversationId anterior:', conversationId);

      if (!isSameConversation || messages.length === 0 || pending.length > 0) {
        // console.log('🔄 [CONVERSATION-SWITCH] Reseteando messages a pending');
      setMessages(pending.slice());
      } else {
        // console.log('🔄 [CONVERSATION-SWITCH] Preservando messages actuales (misma conversación)');
      }

      // Solo cargar mensajes de la BD si NO acabamos de crear esta conversación
      // (si acabamos de crearla, ya tenemos los mensajes en el estado local)
      if (justCreatedConversation && messages.length > 0) {
        // console.log('🔄 [CONVERSATION-SWITCH] Conversación recién creada con mensajes locales, NO cargar de BD');
        // Resetear el flag después de 2 segundos para que en la siguiente carga sí se consulte la BD
        setTimeout(() => {
          // console.log('🔄 [CONVERSATION-SWITCH] Reseteando justCreatedConversation flag');
          setJustCreatedConversation(false);
        }, 2000);
      } else {
        // console.log('🔄 [CONVERSATION-SWITCH] Cargando mensajes de BD');
      loadMessages(currentConversationId);
      }
    } else {
      // Solo resetear si realmente NO hay conversación (nuevo chat)
      // No resetear si simplemente currentConversationId es null por navegación
      if (currentConversationId === null && conversationId !== null) {
      setConversationId(null);
        conversationIdRef.current = null;
      setMessages([]);
      setInput('');
      setIsGenerating(false);
      setIsTypewriting(false);
      setTypingMessageId(null);
      setStopRequested(false);
      aiAbortRef.current?.abort();
      typingProgressRef.current = {};
      } else {
        // console.log('🔄 [NAVIGATION] currentConversationId es null pero conversationId ya es null, no hacer nada');
      }
      // No limpiar shownMessages para mantener persistencia entre conversaciones
    }
  }, [currentConversationId, conversationId]);



  const handleSubmit = async (e) => {
    e.preventDefault();
    // Anti-doble disparo: si el mismo submit llega 2 veces en <250ms, ignorar el segundo
    const now = Date.now();
    const key = `${(input || '').trim()}|${(attachments || []).map(a=>a.id).join(',')}`;
    const last = lastUserSendKeyRef.current;
    if (last && last.key === key && (now - last.ts) < 250) {
      return;
    }
    lastUserSendKeyRef.current = { key, ts: now };
    if (sendingLockRef.current) return;
    sendingLockRef.current = true;
    // Si hay una grabación activa, este botón debe comportarse como enviar audio
    if (isListening) { try { handleAudioSend(); } catch {} return; }

    const hasReadyAttachments = (attachments || []).some(a => a.status === 'done');
    const rawText = input || '';
    const hasText = rawText.trim().length > 0;

    if (!hasText && !hasReadyAttachments) {
      sendingLockRef.current = false;
      return;
    }

    // Mostrar al usuario exactamente lo que escribió; si está vacío, no inyectar símbolos
    const userText = hasText ? rawText.trim() : '';
    // Asegurar que los adjuntos estén procesados para incluir su texto extraído
    const hasPending = attachments.some(a => a.status !== 'done');

    if (hasPending) {
      showToast('Procesando adjuntos... espera unos segundos y vuelve a enviar.', 'warning');
      sendingLockRef.current = false;
      return;
    }
    const readyAttachments = attachments.filter(a => a.status === 'done');
    async function generateThumb(file) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          const maxDim = 400; // Balance entre calidad y tamaño
          const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
          const w = Math.max(1, Math.round(img.width * ratio));
          const h = Math.max(1, Math.round(img.height * ratio));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const data = canvas.toDataURL('image/webp', 0.90);
          URL.revokeObjectURL(url);
          resolve(data);
        };
        img.onerror = () => { try { URL.revokeObjectURL(url); } catch {} resolve(undefined); };
        img.src = url;
      });
    }
    const attPayload = await Promise.all(readyAttachments.map(async (a) => {
      const isImg = (a.type && a.type.startsWith('image/')) || /\.(png|jpe?g|gif|bmp|webp)$/i.test(a.name);
      const thumb = isImg && a.file ? await generateThumb(a.file) : undefined;

      // Usar el kind que ya fue establecido en addFiles, o determinarlo como fallback
      let kind = a.kind || 'file'; // ⭐ USAR EL KIND EXISTENTE PRIMERO

      // Solo redeterminar si no existe (fallback)
      if (!kind || kind === 'file') {
        if (isImg) kind = 'image';
        else if (a.name.toLowerCase().endsWith('.pdf')) kind = 'pdf';
        else if (a.name.toLowerCase().endsWith('.docx')) kind = 'docx';
        else if (a.name.toLowerCase().endsWith('.pptx')) kind = 'pptx';
        else if (a.name.toLowerCase().endsWith('.xlsx')) kind = 'xlsx';
        else if (a.name.toLowerCase().endsWith('.csv')) kind = 'csv';
        else if (a.name.toLowerCase().endsWith('.txt')) kind = 'txt';
        else kind = 'file';
      }

      const payload = {
        filename: isImg ? undefined : a.name,
        size: isImg ? undefined : (a.file?.size || 0),
        type: a.type,
        kind: kind,
        thumbDataUrl: thumb,
        extractHash: a.result?.hash,
        extractMeta: a.result ? {
          pages: a.result?.meta?.pages,
          confidence: a.result?.confidence,
          is_native: a.result?.is_native,
          // Incluir metadatos específicos de cada formato
          paragraphs: a.result?.meta?.paragraphs,
          sheets: a.result?.meta?.sheets,
          rows: a.result?.meta?.rows,
          columns: a.result?.meta?.columns,
          lines: a.result?.meta?.lines,
          encoding: a.result?.meta?.encoding
        } : undefined,
        extractResult: a.result // Guardar el resultado completo de extracción
      };
      if (a.result?.ui?.selected_option) {
        payload.ui = a.result.ui;
      }
      return payload;
    }));

    const userTempId = `user-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const userMessage = {
      role: 'user',
      content: userText,
      createdAt: new Date(),
      isNew: true,
      _tempId: userTempId,
      attachments: readyAttachments.map(a => {
        const fileName = a.name.toLowerCase();
        const isImage = (a.type && a.type.startsWith('image/')) || /\.(png|jpe?g|gif|bmp|webp)$/i.test(fileName);

        return {
          name: a.name,
          type: a.type,
          isImage: isImage,
          isDocument: fileName.endsWith('.pdf') || fileName.endsWith('.docx') || fileName.endsWith('.pptx') || fileName.endsWith('.xlsx') || fileName.endsWith('.csv') || fileName.endsWith('.txt'),
          previewUrl: isImage ? URL.createObjectURL(a.file) : null,
          kind: a.kind || (isImage ? 'image' : 'file'),
          result: a.result || a.extractResult || null
        };
      })
    };

    // Preparar UI inmediata
    setInput('');
    setLoading(true);
    setAttachments([]);

    // Marcar mensaje del usuario como mostrado inmediatamente usando una clave estable
    const shownKey = `user|${String(userMessage.content || '').trim()}|${(userMessage.attachments||[]).map(a=>a.name||a.filename||'').join(',')}`;
    setShownMessages(prev => {
      const newSet = new Set(prev);
      newSet.add(shownKey);
      saveShownMessages(newSet);
      return newSet;
    });

    // Guardar mensaje del usuario y obtener conversationId si es nuevo
    let newConvId = conversationId;
    if (!conversationId) {
      newConvId = await createNewConversation(userText, readyAttachments);
      if (!newConvId) {
        showToast('No se pudo crear la conversación. Intenta de nuevo.', 'error');
        setLoading(false);
        return;
      }
      setConversationId(newConvId);
      // Insertar mensaje del usuario evitando duplicados por dobles submits cercanos
      setMessages(prev => {
        const sig = (m) => `${m.role}|${String(m.content || '').trim()}|${(Array.isArray(m.attachments)?m.attachments:[]).map(a=>`${a.name||a.filename||''}|${a.kind||''}|${a.type||''}`).join(',')}`;
        const exists = prev.some(m => sig(m) === sig(userMessage));
        return exists ? prev : [...prev, userMessage];
      });
      // Buffer optimista solo de usuario (también sin duplicar)
      const prevBuf = optimisticByConvRef.current.get(newConvId) || [];
      const sig = (m) => `${m.role}|${String(m.content || '').trim()}|${(Array.isArray(m.attachments)?m.attachments:[]).map(a=>`${a.name||a.filename||''}|${a.kind||''}|${a.type||''}`).join(',')}`;
      const bufExists = prevBuf.some(m => sig(m) === sig(userMessage));
      optimisticByConvRef.current.set(newConvId, bufExists ? prevBuf : [...prevBuf, userMessage]);
      // Persistir y notificar
      await saveMessage(userText, 'user', newConvId, attPayload, undefined, userTempId);
      if (onConversationCreated) onConversationCreated(newConvId);
      // Bajar al fondo
      setTimeout(() => {
        try {
          const el = messagesRef.current;
          if (!el) return;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (distance <= 120) {
            stickToBottomRef.current = true;
            scrollToBottom(true);
          } else {
            scLog('auto-scroll suppressed (user away from bottom)', { distance });
          }
        } catch {}
      }, 0);
    } else {
      // Conversación existente: UI inmediata + buffer y persistencia (sin duplicar)
      setMessages(prev => {
        const sig = (m) => `${m.role}|${String(m.content || '').trim()}|${(Array.isArray(m.attachments)?m.attachments:[]).map(a=>`${a.name||a.filename||''}|${a.kind||''}|${a.type||''}`).join(',')}`;
        const exists = prev.some(m => sig(m) === sig(userMessage));
        return exists ? prev : [...prev, userMessage];
      });
      const buf = optimisticByConvRef.current.get(conversationId) || [];
      const sig2 = (m) => `${m.role}|${String(m.content || '').trim()}|${(Array.isArray(m.attachments)?m.attachments:[]).map(a=>`${a.name||a.filename||''}|${a.kind||''}|${a.type||''}`).join(',')}`;
      const bufExists2 = buf.some(m => sig2(m) === sig2(userMessage));
      optimisticByConvRef.current.set(conversationId, bufExists2 ? buf : [...buf, userMessage]);
      setTimeout(() => {
        try {
          const el = messagesRef.current;
          if (!el) return;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (distance <= 120) {
            stickToBottomRef.current = true;
            scrollToBottom(true);
          } else {
            scLog('placeholder:auto-scroll suppressed (user away from bottom)', { distance });
          }
        } catch {}
      }, 0);
      await saveMessage(userText, 'user', undefined, attPayload, undefined, userTempId);
    }

    try {
      setIsGenerating(true);
      // Obtener respuesta de OpenAI con contexto de adjuntos integrado
      let userMessageWithContext = { ...userMessage };

      let userTextForApi = hasText ? userText : ' ';
      if (readyAttachments && readyAttachments.length > 0) {
        const attachmentContext = readyAttachments
          .filter(a => a.result?.full_text) // Solo incluir archivos con texto extraído
          .map(a => `\n\n[ARCHIVO ADJUNTO: ${a.name}]\n${a.result.full_text}`)
          .join('\n\n---\n\n');

        if (attachmentContext) {
          userMessageWithContext.content = `${userText}${attachmentContext}`;
          // Mantener detecciones solo en backend: no agregamos instrucciones explícitas aquí
          userTextForApi = hasText ? userText : ' ';
        }
      }
      // No aplicar heurísticas de intención en el frontend; el backend decide.

      // Construir historial incluyendo texto extraído de adjuntos de mensajes pasados
      // IMPORTANTE: Si hay una conversación existente pero el estado local está vacío,
      // cargar mensajes desde BD para asegurar contexto completo (evita pérdida de contexto después de varios días)
      let messagesForHistory = messages;

      if (conversationId && messages.length === 0) {
        // Si hay conversationId pero el estado está vacío, cargar desde BD
        try {
          const token = getAuthToken();
          const historyResponse = await fetch(`http://localhost:10000/api/messages/conversation/${conversationId}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          });

          if (historyResponse.ok) {
            const historyData = await historyResponse.json();
            const loadedMessages = historyData.data || [];
            // Ordenar por fecha para asegurar orden cronológico
            const sortedMessages = loadedMessages.sort((a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            );
            messagesForHistory = sortedMessages;
          } else {
            console.warn('[SEND] No se pudo cargar mensajes desde BD, usando estado local');
          }
        } catch (error) {
          console.error('[SEND] Error cargando mensajes desde BD:', error);
        }
      }

      const historialWithContext = [...messagesForHistory, userMessageWithContext];

      const historyForApi = historialWithContext.map((m, idx) => {
        let content = String(m.content || '');
        try {
          const atts = Array.isArray(m.attachments) ? m.attachments : [];

          // Filtro mejorado de calidad OCR
          const isGoodOcr = (r) => {
            const t = String(r?.full_text || r?.text || '').trim();
            if (!t) return false;

            const len = t.length;

            // 1. Rechazar textos muy cortos (probablemente ruido)
            if (len < 10) return false;

            // 2. Rechazar textos con solo símbolos o números
            const hasLetters = /[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]/.test(t);
            if (!hasLetters) return false;

            // 3. Detectar repeticiones excesivas (AAAAAAA)
            const hasExcessiveRepeats = /([A-ZÁÉÍÓÚÜÑ])\1{4,}/.test(t);
            if (hasExcessiveRepeats) return false;

            // 4. Rechazar si tiene demasiados caracteres especiales raros
            const specialChars = (t.match(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9\s.,;:?!¿¡()\-+=/\\|<>]/g) || []).length;
            const specialRatio = specialChars / len;
            if (specialRatio > 0.3) return false; // Más del 30% caracteres raros

            // 5. Debe tener al menos algunas palabras reconocibles (español/inglés común)
            const commonWords = /\b(la|el|de|es|en|y|a|un|una|los|las|del|al|por|para|con|su|que|se|como|más|pero|o|fue|son|está|han|hay|si|no|ya|solo|muy|cuando|donde|quien|cual|este|esta|ese|esa|aquel|aquella|cuanto|cuánto|raiz|raíz|cuadrada|numero|número|hola|pregunta|respuesta|paciente|mujer|hombre|años|diagnostico|tratamiento|sintomas|the|is|are|was|were|have|has|had|do|does|did|can|could|will|would|should|may|might|must)\b/i;
            const hasCommonWords = commonWords.test(t);

            // 6. Calcular score basado en espacios y palabras
            const spaces = (t.match(/\s/g) || []).length;
            const words = t.split(/\s+/).filter(w => w.length > 0);
            const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / Math.max(1, words.length);

            // Tokens muy largos pueden indicar OCR malo (texto pegado sin espacios)
            const veryLongTokens = words.filter(w => w.length > 30).length;

            // Score final
            let score = 0;

            // Bonificaciones
            if (hasCommonWords) score += 3;
            if (len > 50) score += 1; // Textos más largos suelen ser más útiles
            if (avgWordLength >= 3 && avgWordLength <= 12) score += 2; // Longitud de palabra normal
            if (spaces > 5) score += 1; // Tiene varios espacios

            // Penalizaciones
            if (veryLongTokens > 2) score -= 2; // Demasiadas palabras pegadas
            if (avgWordLength > 20) score -= 3; // Palabras demasiado largas (texto pegado)

            // Aceptar si score >= 2 (más tolerante que antes)
            return score >= 2;
          };

          const extra = atts
            .map((a) => {
              // Intentar obtener el resultado de extracción de múltiples fuentes
              const extractData = a?.result || a?.extractResult;

              // Si extractData es un objeto con full_text/text, usarlo directamente
              if (extractData && (extractData.full_text || extractData.text)) {
                return extractData;
              }

              // Si el attachment tiene propiedades directas de extracción (estructura plana)
              if (a?.full_text || a?.text) {
                return { full_text: a.full_text, text: a.text };
              }

              return null;
            })
            .filter((r) => {
              if (!r || !(r.full_text || r.text)) return false;

              const isGood = isGoodOcr(r);

              return isGood;
            })
            .map((r, idx) => `\n\n[ARCHIVO ADJUNTO ${idx + 1}]\n${r.full_text || r.text}`)
            .join('');
          if (extra) content += extra;
        } catch {}
        return { role: m.role, content };
      });

      // 🌐 DETECCION INTELIGENTE DE IDIOMA
      // Usar heuristica simple: detectar palabras comunes en ingles vs espanol
      const detectLanguage = (text) => {
        const lowerText = text.toLowerCase();

        // Palabras muy comunes en ingles
        const englishIndicators = /\b(what|where|when|who|why|how|the|is|are|was|were|have|has|had|do|does|did|can|could|will|would|should|may|might|must|this|that|these|those|there|here|very|much|many|some|any|all|every|each|both|either|neither|other|another|such|same|different|new|old|good|bad|big|small|long|short|high|low|first|last|next|previous|same|best|worst|better|worse|more|less|most|least)\b/g;

        // Palabras muy comunes en espanol
        const spanishIndicators = /\b(que|cual|cuales|como|donde|cuando|quien|quienes|por que|porque|para|con|sin|sobre|entre|hasta|desde|hacia|segun|mediante|durante|el|la|los|las|un|una|unos|unas|de|del|al|es|son|esta|estan|fue|fueron|ha|han|habia|habian|ser|estar|haber|tener|hacer|decir|poder|deber|querer|saber|ver|dar|venir|ir|salir|llegar|pasar|quedar|poner|traer|sacar|llevar|dejar|seguir|encontrar|llamar|hablar|trabajar|sentir|vivir|conocer|parecer)\b/g;

        const englishMatches = (lowerText.match(englishIndicators) || []).length;
        const spanishMatches = (lowerText.match(spanishIndicators) || []).length;

        // Si tiene mas palabras en ingles, es ingles (ahora con umbral de 1)
        if (englishMatches > spanishMatches && englishMatches >= 1) {
          return 'en';
        }
        // Por defecto espanol (la mayoria de usuarios)
        return 'es';
      };

      const userLanguage = detectLanguage(userTextForApi);

      // Instrucciones de formato segun idioma detectado
      const formatInstructions = {
        es: 'Formatea tus respuestas en Markdown ligero. Usa **negritas** para conceptos clave y separa ideas con saltos de linea. Si la respuesta es TEXTO PLANO (sin bloques de codigo ni matematicas), COMIENZA con un encabezado H2 usando Markdown (## Titulo breve de 3-7 palabras) y, si aporta claridad, emplea subtitulos H3 (### ...). TABLAS: Solo usa tablas Markdown (| col1 | col2 |\n|------|------|\n| dato | dato |) cuando sean realmente necesarias para comparar datos estructurados (ej: comparaciones, horarios, listas de caracteristicas). NO abuses de las tablas para texto simple. No uses encabezados dentro de codigo o matematicas. Evita HTML. Se conciso.',
        en: 'Format your responses in lightweight Markdown. Use **bold** for key concepts and separate ideas with line breaks. If the response is PLAIN TEXT (without code blocks or math), START with an H2 header using Markdown (## Brief title of 3-7 words) and, if it adds clarity, use H3 subheadings (### ...). TABLES: Only use Markdown tables (| col1 | col2 |\n|------|------|\n| data | data |) when truly necessary for comparing structured data (e.g., comparisons, schedules, feature lists). DON\'T abuse tables for simple text. No headers inside code or math. Avoid HTML. Be concise.'
      };

      const ocrInstructions = {
        es: 'Usa el texto extraido de adjuntos como representacion del contenido visual cuando sea legible. Si el texto parece ruidoso o ambiguo, NO lo interpretes: pide una confirmacion breve al usuario antes de asumir significados (especialmente en matematicas).',
        en: 'Use the extracted text from attachments as a representation of visual content when it\'s legible. If the text seems noisy or ambiguous, DON\'T interpret it: ask the user for brief confirmation before assuming meanings (especially in mathematics).'
      };

      // Instrucción de formato general (adaptada al idioma)
      historyForApi.unshift({
        role: 'system',
        content: formatInstructions[userLanguage] || formatInstructions.es
      });

      // Si hay OCR en el mensaje actual o en adjuntos recientes usados, añadir instrucción OCR
      const hasOcrInCurrent = (readyAttachments || []).some(a => a?.result?.full_text);
      if (hasOcrInCurrent || /\[ARCHIVO RECIENTE/.test(userTextForApi)) {
        historyForApi.unshift({
          role: 'system',
          content: ocrInstructions[userLanguage] || ocrInstructions.es
        });
      }

      // Preparar abort controller
      const abortController = new AbortController();
      aiAbortRef.current = abortController;

      const token2 = getAuthToken();
      const xModel2 = localStorage.getItem('skanea_model_override');
      const autoSaveFiles2 = localStorage.getItem('skanea_auto_save_files') === 'true';
      const tStart = performance.now();
      latLog('request2:start', { endpoint: 'API_URL/ask', model: xModel2 || 'default' });

      const tReq = performance.now();
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token2 ? { Authorization: `Bearer ${token2}` } : {}),
          ...(xModel2 ? { 'x-model-override': xModel2 } : {}),
          ...(autoSaveFiles2 ? { 'x-auto-save-files': 'true' } : {})
        },
        body: JSON.stringify({
          pregunta: userTextForApi,
          historial: historyForApi,
          conversationId: newConvId || conversationIdRef.current
        }),
        signal: abortController.signal,
      });
      latLog('request2:end', { ms: Math.round(performance.now() - tStart) });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Responder visualmente de inmediato con un placeholder para reducir la sensación de latencia
      // Si el server tarda, ya tenemos el typewriter listo escribiendo puntos suspensivos
      const instantId = `bot-${Date.now()}-${Math.random().toString(36).slice(2,8)}-ph`;
      const placeholderMessage = { role: 'assistant', content: '…', createdAt: new Date(), isNew: true, _tempId: instantId, realtime: null };
      setTypingMessageId(instantId);
      setIsTypewriting(true);
      setMessages(prev => [...prev, placeholderMessage]);
      setIsGenerating(true);
      setTimeout(() => {
        try {
          const el = messagesRef.current;
          if (!el) return;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (distance <= 120) {
            stickToBottomRef.current = true;
            scrollToBottom(true);
          } else {
            scLog('typewriter:start suppressed (user away from bottom)', { distance });
          }
        } catch {}
      }, 0);
      latLog('placeholder:inserted', {});

      const jsonStart = performance.now();
      const data = await response.json();
      latLog('json:parsed', { ms: Math.round(performance.now() - jsonStart) });
      try {
        const p = data.provider || response.headers.get('x-ai-provider');
        const m = data.model || response.headers.get('x-ai-model');
        if (p || m) console.log('[Skanea][AI] provider=', p, 'model=', m);
      } catch {}

      if (!data.respuesta && !data.response) {
        throw new Error('No se recibió respuesta del bot');
      }

      // Verificar si es una respuesta simple (para sugerencias de formato) o respuesta normal
      const responseText = data.response || data.respuesta;
      const intent = data.intent || null;
      const fuente = data.fuente || data.source || null;
      const ts = data.ts || null;
      const realtime = buildRealtimeMeta(intent, data);
      // Fallback: envolver como código solo si el usuario lo pidió explícitamente
      // y NO es una intención de búsqueda de enlaces/URLs.
      const isWebIntent = (intent && String(intent).toLowerCase().startsWith('websearch'));
      const userWantsLinks = /\b(enlaces?|links?|urls?|documentaci[oó]n|fuentes?)\b/i.test(userText);
      const userAskedCode = /\b(código|codigo|snippet|programa|programación|programacion|script|bloque\s+de\s+c[oó]digo)\b/i.test(userText);
      const mentionsLanguage = /\b(java|javascript|typescript|python|c\+\+|c#|\bc\b|go|rust|ruby|php|kotlin|swift|sql|bash|powershell)\b/i.test(userText);
      const wantsCode = /```/.test(responseText) || (!isWebIntent && !userWantsLinks && (userAskedCode || mentionsLanguage));
      const hasBlock = hasCodeBlock(responseText);
      let finalContent = responseText;
      if (wantsCode && !hasBlock) {
        // Inferir lenguaje simple por palabras clave del prompt
        const lang = (userText.match(/java|javascript|typescript|python|c\+\+|c#|\bc\b|go|rust|ruby|php|kotlin|swift|sql|bash|powershell/i) || [''])[0].toLowerCase() || '';
        const langMap = { javascript:'js', typescript:'ts', 'c++':'cpp', 'c#':'csharp', bash:'bash', powershell:'powershell' };
        const fenceLang = langMap[lang] || lang;
        finalContent = '```' + fenceLang + "\n" + (responseText || '').replace(/```/g, '\\`\\`\\`').trim() + "\n```";
      }
      const botId = `bot-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const botMessage = {
        role: 'assistant',
        content: balanceCodeFences(finalContent),
        createdAt: new Date(),
        isNew: true,
        _tempId: botId,
        _id: data._id || undefined, // Usar el _id devuelto por el backend si existe
        realtime,
        // Agregar información del archivo si existe
        file: data.archivo || undefined
      };

      // Reemplazar placeholder si existe, manteniendo la posición y evitando remount
      setMessages(prev => {
        const idx = prev.findIndex(m => m._tempId === instantId);
        if (idx !== -1) {
          const next = prev.slice();
          next[idx] = botMessage;
          return next;
        }
        return [...prev, botMessage];
      });
      setTypingMessageId(botId);
      setIsTypewriting(true);
      // Si ya tenemos _id, NO guardar de nuevo en MongoDB (evitar duplicación)
      const shouldSave = !data._id;
      pendingAssistantSaveRef.current.set(botId, {
        convId: newConvId || conversationId,
        archivo: data.archivo || undefined,
        shouldSave: shouldSave // Flag para indicar si debe guardarse
      });
      // Mostrar botón Stop durante el typewriter aunque ya no haya request
      setIsGenerating(true);
      // Al insertar la respuesta, bajar al fondo inmediatamente
      setTimeout(() => scrollToBottom(true), 0);
      latLog('typewriter:start', { chars: finalContent.length });

      // Si el modelo devolvió menos de lo que parece por el prompt, pedir continuación automática
      if (finalContent && lastUserPromptRef.current && !continuedMessageIdsRef.current.has(botId)) {
        const openFences = (finalContent.match(/```/g) || []).length % 2 === 1;
        const looksAbrupt = /\w$/.test(finalContent.slice(-1)) && !/[\.\!\?]$/.test(finalContent.slice(-1));
        if (openFences || looksAbrupt) {
          try {
            const cPrompt = `${lastUserPromptRef.current}\n\n[CONTINUA] Continúa EXACTAMENTE donde te quedaste, sin repetir nada. Si estabas en un bloque de código, continúa el mismo bloque y ciérralo con tres acentos graves al final (\`\`\`).`;
            const token = getAuthToken();
            const xModel2 = localStorage.getItem('skanea_model_override');
            const autoSaveFiles3 = localStorage.getItem('skanea_auto_save_files') === 'true';
            const r2 = await fetch(API_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(xModel2 ? { 'x-model-override': xModel2 } : {}),
                ...(autoSaveFiles3 ? { 'x-auto-save-files': 'true' } : {})
              },
              body: JSON.stringify({
                pregunta: cPrompt,
                historial: [],
                conversationId: conversationIdRef.current
              })
            });
            if (r2.ok) {
              const j2 = await r2.json();
              const more = j2.response || j2.respuesta || '';
              if (more) {
                // Adjuntar continuación al mensaje actual sin crear otro
                setMessages(prev => prev.map(m => (m._tempId === botId ? { ...m, content: balanceCodeFences((m.content || '') + '\n' + more) } : m)));
                latLog('auto-continue:attached', { extraChars: more.length });
                continuedMessageIdsRef.current.add(botId);
              }
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        console.warn('Solicitud de respuesta abortada por el usuario');
        return;
      }
      console.error('Error en handleSubmit:', err);
      const errorMessage = { role: 'assistant', content: `Error al obtener respuesta: ${err.message}`, createdAt: new Date(), isNew: true };
      setMessages(prevMessages => [...prevMessages, errorMessage]);
      await saveMessage(`Error al obtener respuesta: ${err.message}`, 'assistant', newConvId || conversationId);
    } finally {
      setLoading(false);
      setIsGenerating(false);
      aiAbortRef.current = null;
      setTimeout(() => { sendingLockRef.current = false; }, 200);
    }
  };

  // Actualizar ref de handleSubmit para hotkeys (después de definirla)
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  const handleStopGenerating = useCallback(() => {
    setStopRequested(true);
    setTimeout(() => setStopRequested(false), 200);
    try {
      aiAbortRef.current?.abort();
    } catch {}
    // Si estamos en typewriter, truncar al progreso actual y guardar
    const currentTypingId = typingMessageIdRef.current;
    if (isTypewritingRef.current && currentTypingId) {
      const partial = typingProgressRef.current[currentTypingId] || '';
      if (partial) {
        setMessages((prev) => prev.map((m) => (getMessageId(m) === currentTypingId ? { ...m, content: partial } : m)));
      }
      const pending = pendingAssistantSaveRef.current.get(currentTypingId);
      if (pending && pending.shouldSave !== false) {
        saveMessage(partial || '', 'assistant', pending.convId, null, pending.archivo);
      }
      if (pending) {
        pendingAssistantSaveRef.current.delete(currentTypingId);
      }
      // Evitar retype: marcar como mostrado para desactivar el typewriter
      setShownMessages(prev => {
        const newSet = new Set([...prev, currentTypingId]);
        saveShownMessages(newSet);
        return newSet;
      });
      setIsTypewriting(false);
      setTypingMessageId(null);
    }
    setIsGenerating(false);
  }, [saveShownMessages]);

  return (
    <div className="chat-container">
      <div ref={messagesRef} className={`messages ${attachments.length > 0 ? 'with-attachments' : ''}`}>
        {messages.length === 0 && !currentConversationId && (
          <div className="welcome-message">
            <h3>¡Bienvenido a Skanea!</h3>
            <p>Selecciona una conversación del historial o escribe un mensaje para comenzar una nueva.</p>
          </div>
        )}
        {messages.reduce((uniqueMessages, m, index) => {
          const messageId = getMessageId(m);
          // Debug logs (commented for production)
          // if (m.role === 'assistant' && index === messages.length - 1) {
          //   console.log('[DEBUG-KEY] MessageId:', messageId, 'contentLength:', String(m.content||'').length);
          // }

          // BLOQUEO DEFINITIVO: Evitar duplicados por ID del servidor o por contenido + adjuntos para mensajes de usuario
          if (m.role === 'user') {
            // Primero verificar por ID del servidor (más confiable)
            if (m._id || m.id) {
              const serverId = m._id || m.id;
              const alreadyExistsByServerId = uniqueMessages.some(existing =>
                (existing._id && existing._id === serverId) || (existing.id && existing.id === serverId)
              );
              if (alreadyExistsByServerId) {
                return uniqueMessages;
              }
            }

            // Luego verificar por contenido normalizado (tratando "" y "(mensaje vacío)" como iguales)
            const normalizeContent = (content) => {
              const trimmed = String(content || '').trim();
              return (trimmed === '' || trimmed === '(mensaje vacío)') ? 'EMPTY' : trimmed;
            };

            const signature = `${m.role}|${normalizeContent(m.content)}|${(m.attachments || []).map(a => a.name || a.filename || '').sort().join(',')}`;
            const alreadyExists = uniqueMessages.some(existing => {
              const existingSignature = `${existing.role}|${normalizeContent(existing.content)}|${(existing.attachments || []).map(a => a.name || a.filename || '').sort().join(',')}`;
              return existingSignature === signature;
            });

            if (alreadyExists) {
              return uniqueMessages;
            }
          }

          // Usar typewriter solo si el mensaje no fue mostrado antes
          const shouldUseTypewriter = m.role === 'assistant' && m.isNew && !shownMessages.has(messageId);
          const isCurrentTyping = typingMessageIdRef.current === messageId;
          const renderAsCode = isCurrentTyping || hasCodeBlock(m.content) || hasMathInlineOrBlock(m.content);
          // Log desactivado para producción (demasiado verbose)
          // try { if (debugTypewriterRef.current) console.log('[TW] render message', { messageId, hasBlock: hasCodeBlock(m.content), hasMath: hasMathInlineOrBlock(m.content), isCurrentTyping, renderAsCode, shouldUseTypewriter }); } catch {}

          const images = Array.isArray(m.attachments) ? m.attachments.filter(att => (att.isImage || att?.kind === 'image' || (att?.type && att.type.startsWith('image/')))) : [];
          const docs = Array.isArray(m.attachments) ? m.attachments.filter(att => !(att.isImage || att?.kind === 'image' || (att?.type && att.type.startsWith('image/')))) : [];

          uniqueMessages.push(m);
          return uniqueMessages;
        }, []).map((m, index) => {
          const messageId = getMessageId(m);
          const shouldUseTypewriter = m.role === 'assistant' && m.isNew && !shownMessages.has(messageId);
          const isCurrentTyping = typingMessageIdRef.current === messageId;

          // Decisión renderAsCode ESTABLE: una vez decidida, no cambia (evita unmount/remount)
          let renderAsCode;
          if (renderAsCodeDecisionRef.current.has(messageId)) {
            // Usar decisión previa
            renderAsCode = renderAsCodeDecisionRef.current.get(messageId);
          } else {
            // Primera vez: decidir basado en contenido
            const hasComplexContent = hasCodeBlock(m.content) || hasMathInlineOrBlock(m.content);
            renderAsCode = hasComplexContent;
            // Guardar decisión para futuros renders
            renderAsCodeDecisionRef.current.set(messageId, renderAsCode);
          }

          const images = Array.isArray(m.attachments) ? m.attachments.filter(att => (att.isImage || att?.kind === 'image' || (att?.type && att.type.startsWith('image/')))) : [];
          const docs = Array.isArray(m.attachments) ? m.attachments.filter(att => !(att.isImage || att?.kind === 'image' || (att?.type && att.type.startsWith('image/')))) : [];
          if (m.role === 'assistant') {
            return (
              <div key={messageId} className={`message ${m.role}`}>
                {renderAsCode ? (
                  <CodeAndTextTypewriter
                    id={messageId}
                    content={m.content}
                    speed={25}
                    interrupt={stopRequested}
                    forceTypewriter={shouldUseTypewriter}
                    onProgress={(partial) => {
                      if (typingMessageIdRef.current === messageId) {
                        typingProgressRef.current[messageId] = partial;
                      }
                      stickToBottomRef.current = isNearBottom();
                      scrollIfNearBottom();
                    }}
                    onComplete={() => {
                      try { if (debugTypewriterRef.current) console.log('[TW] complete CodeAndTextTypewriter', { messageId }); } catch {}
                      markMessageAsShown(messageId);
                      setMessages(prev => prev.map(mm => (getMessageId(mm) === messageId ? { ...mm, _typedDone: true, isNew: false } : mm)));
                      if (typingMessageIdRef.current === messageId) {
                        const finalText = balanceCodeFences(m.content);
                        const pending = pendingAssistantSaveRef.current.get(messageId);
                        if (pending && pending.shouldSave !== false) {
                          saveMessage(finalText, 'assistant', pending.convId, null, pending.archivo);
                        }
                        if (pending) {
                          pendingAssistantSaveRef.current.delete(messageId);
                        }
                        setMessages(prev => prev.map(mm => (getMessageId(mm) === messageId ? { ...mm, _typedDone: true, isNew: false, content: finalText } : mm)));
                        try { delete typingProgressRef.current[messageId]; } catch {}
                        setIsTypewriting(false);
                        setTypingMessageId(null);
                        setIsGenerating(false);
                      }
                      stickToBottomRef.current = isNearBottom();
                      scrollToBottom(true);
                    }}
                  />
                ) : (
                  <TypewriterText
                    text={m.content}
                    speed={44}
                    batchSize={2}
                    forceTypewriter={shouldUseTypewriter}
                    interrupt={stopRequested}
                    onProgress={(partial) => {
                      if (typingMessageIdRef.current === messageId) {
                        typingProgressRef.current[messageId] = partial;
                      }
                      stickToBottomRef.current = true;
                      scrollIfNearBottom();
                    }}
                    onComplete={() => {
                      try { if (debugTypewriterRef.current) console.log('[TW] complete TypewriterText', { messageId }); } catch {}
                      markMessageAsShown(messageId);
                      // Marcar el mensaje como tipeado definitivamente
                      setMessages(prev => prev.map(mm => (getMessageId(mm) === messageId ? { ...mm, _typedDone: true, isNew: false } : mm)));
                      if (typingMessageIdRef.current === messageId) {
                        const finalText = balanceCodeFences(m.content);
                        const pending = pendingAssistantSaveRef.current.get(messageId);
                        if (pending && pending.shouldSave !== false) {
                          saveMessage(finalText, 'assistant', pending.convId, null, pending.archivo);
                        }
                        if (pending) {
                          pendingAssistantSaveRef.current.delete(messageId);
                        }
                        try { delete typingProgressRef.current[messageId]; } catch {}
                        setIsTypewriting(false);
                        setTypingMessageId(null);
                        setIsGenerating(false);
                      }
                      stickToBottomRef.current = true;
                      scrollToBottom(true);
                    }}
                  />
                )}
                {/* Footer de fuente/ts si viene desde realtime */}
                {m.realtime && (m.realtime.fuente || m.realtime.ts) && (
                  <div className="meta" style={{ marginTop: 6, opacity: 0.8, fontSize: 12 }}>
                    {m.realtime.fuente ? `Fuente: ${m.realtime.fuente}` : null}
                    {m.realtime.ts ? `${m.realtime.fuente ? ', ' : ''}${new Date(m.realtime.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} UTC` : ''}
                  </div>
                )}
                {/* Mostrar archivo generado si existe */}
                {m.file && (
                  <div className="file-attachment">
                    {(m.file.isImage || m.file.formato === 'IMAGE' || m.file.formato === 'image') ? (
                      // Mostrar preview de imagen con blur
                      (() => {
                        const autoSave = localStorage.getItem('skanea_auto_save_files') === 'true';
                        const fileCreatedAt = m.file.createdAt || m.createdAt;
                        const now = new Date();
                        const fileTime = fileCreatedAt ? new Date(fileCreatedAt) : now;
                        const minutesSinceCreation = (now - fileTime) / 1000 / 60;
                        // Si auto-save está activado y tiene localPath, NUNCA está expirado
                        const isExpired = (autoSave && m.file.localPath) ? false : minutesSinceCreation > 4;

                        if (isExpired) {
                          return (
                            <div className="image-attachment" style={{ opacity: 0.5 }}>
                              <div className="image-preview">
                                <img
                                  src={m.file.preview}
                                  alt="Vista previa de imagen expirada"
                                  className="blurred-image"
                                  style={{ filter: 'blur(10px) grayscale(1)' }}
                                />
                                <div className="image-overlay">
                                  <div className="image-info">
                                    <div className="image-name">{m.file.nombre}</div>
                                    <div className="image-details" style={{ color: '#ff6b6b' }}>
                                      Imagen expirada (no guardada)
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        }

                        return (
                      <div className="image-attachment">
                        <div className="image-preview">
                          <img
                            src={m.file.preview}
                            alt="Vista previa de imagen generada"
                            className="blurred-image"
                          />
                          <div className="image-overlay">
                            <div className="image-info">
                              <div className="image-name">{m.file.nombre}</div>
                              <div className="image-details">
                                {m.file.width} × {m.file.height} • {Math.round(m.file.size / 1024)}KB
                              </div>
                                  {!autoSave && (
                                    <div className="image-warning" style={{
                                      fontSize: '0.7rem',
                                      color: '#ffa500',
                                      marginTop: '4px'
                                    }}>
                                      ⚠️ Disponible solo 4 minutos
                                    </div>
                                  )}
                            </div>
                          </div>
                        </div>
                        <button
                          className="download-btn image-download"
                          onClick={async () => {
                            try {
                                  if (autoSave && m.file.localPath) {
                                    if (window.electronAPI && window.electronAPI.openFile) {
                                      const result = await window.electronAPI.openFile(m.file.localPath);
                                      if (!result.success) {
                                        showToast(result.error || 'No se pudo abrir el archivo', 'error');
                                      }
                                    } else {
                                      showToast('Función de apertura no disponible', 'error');
                                    }
                                  } else {
                              const token = getAuthToken();

                              const response = await fetch(m.file.url, {
                                method: 'GET',
                                headers: {
                                  'Authorization': `Bearer ${token}`,
                                  'Content-Type': 'application/json'
                                }
                              });

                              if (!response.ok) {
                                throw new Error(`HTTP error! status: ${response.status}`);
                              }

                              const blob = await response.blob();

                                    const downloadFileName = m.file.downloadName || m.file.nombre;

                                    if (window.electronAPI && window.electronAPI.saveFile) {
                                      const arrayBuffer = await blob.arrayBuffer();
                                      const buffer = Array.from(new Uint8Array(arrayBuffer));
                                      const result = await window.electronAPI.saveFile(downloadFileName, buffer);
                                      if (result.success) {
                                        showToast(`Imagen guardada en: ${result.path}`, 'success');
                                      }
                                      // Si el usuario cancela, no mostrar nada (es normal)
                                    } else {
                                      const url = window.URL.createObjectURL(blob);
                                      const link = document.createElement('a');
                                      link.href = url;
                                      link.download = downloadFileName;
                                      document.body.appendChild(link);
                                      link.click();
                                      document.body.removeChild(link);
                                      window.URL.revokeObjectURL(url);
                                      showToast('Imagen descargada', 'success');
                                    }
                                  }
                            } catch (error) {
                              console.error('[DOWNLOAD-IMAGE] Error descargando imagen:', error);
                              showToast('Error al descargar la imagen: ' + error.message, 'error');
                            }
                          }}
                        >
                              {autoSave && m.file.localPath ? '📂 Abrir Imagen' : '📥 Descargar Imagen Completa'}
                        </button>
                      </div>
                        );
                      })()
                    ) : (
                      // Mostrar archivo normal (documentos)
                      (() => {
                        const autoSave = localStorage.getItem('skanea_auto_save_files') === 'true';
                        const fileCreatedAt = m.file.createdAt || m.createdAt;
                        const now = new Date();
                        const fileTime = fileCreatedAt ? new Date(fileCreatedAt) : now;
                        const minutesSinceCreation = (now - fileTime) / 1000 / 60;
                        // Si auto-save está activado y tiene localPath, NUNCA está expirado
                        const isExpired = (autoSave && m.file.localPath) ? false : minutesSinceCreation > 4;

                        if (isExpired) {
                          return (
                            <>
                              <div className="file-icon" style={{ opacity: 0.5 }}>
                                <img src={fileIcon} alt="File" style={{ width: '45px', height: '45px' }} />
                              </div>
                              <div className="file-info">
                                <div className="file-name" style={{ opacity: 0.5 }}>
                                  {m.file.nombre}
                                </div>
                                <div className="file-description" style={{ color: '#ff6b6b' }}>
                                  Archivo expirado (no guardado)
                                </div>
                              </div>
                            </>
                          );
                        }

                        return (
                      <>
                        <div className="file-icon">
                          <img src={fileIcon} alt="File" style={{ width: '45px', height: '45px' }} />
                        </div>
                        <div className="file-info">
                          <div className="file-name">
                            {m.file.nombre}
                          </div>
                          <div className="file-description">
                            Archivo {m.file.formato} • {m.file.mensaje}
                          </div>
                              {!autoSave && (
                                <div className="file-warning" style={{
                                  fontSize: '0.75rem',
                                  color: '#ffa500',
                                  marginTop: '4px',
                                  lineHeight: '1.3'
                                }}>
                                  ⚠️ Los archivos no guardados estarán disponibles máximo 4 minutos, luego serán borrados y no se podrán recuperar
                                </div>
                              )}
                        </div>
                        <button
                          className="download-btn"
                          onClick={async () => {
                            try {
                                  if (autoSave && m.file.localPath) {
                                    if (window.electronAPI && window.electronAPI.openFile) {
                                      const result = await window.electronAPI.openFile(m.file.localPath);
                                      if (!result.success) {
                                        showToast(result.error || 'No se pudo abrir el archivo', 'error');
                                      }
                                    } else {
                                      showToast('Función de apertura no disponible', 'error');
                                    }
                                  } else {
                              const token = getAuthToken();

                              const response = await fetch(m.file.url, {
                                method: 'GET',
                                headers: {
                                  'Authorization': `Bearer ${token}`,
                                  'Content-Type': 'application/json'
                                }
                              });

                              if (!response.ok) {
                                throw new Error(`HTTP error! status: ${response.status}`);
                              }

                              const blob = await response.blob();

                                    const downloadFileName = m.file.downloadName || m.file.nombre;

                                    if (window.electronAPI && window.electronAPI.saveFile) {
                                      const arrayBuffer = await blob.arrayBuffer();
                                      const buffer = Array.from(new Uint8Array(arrayBuffer));
                                      const result = await window.electronAPI.saveFile(downloadFileName, buffer);
                                      if (result.success) {
                                        showToast(`Archivo guardado en: ${result.path}`, 'success');
                                      }
                                      // Si el usuario cancela, no mostrar nada (es normal)
                                    } else {
                                      const url = window.URL.createObjectURL(blob);
                                      const link = document.createElement('a');
                                      link.href = url;
                                      link.download = downloadFileName;
                                      document.body.appendChild(link);
                                      link.click();
                                      document.body.removeChild(link);
                                      window.URL.revokeObjectURL(url);
                                      showToast('Archivo descargado', 'success');
                                    }
                                  }
                            } catch (error) {
                              console.error('[DOWNLOAD] Error en descarga:', error);
                              showToast('Error al descargar el archivo: ' + error.message, 'error');
                            }
                          }}
                        >
                              {autoSave && m.file.localPath ? 'Abrir' : 'Descargar'}
                        </button>
                      </>
                        );
                      })()
                    )}
                  </div>
                )}
                {/* Botón de copiar para mensajes del bot */}
                <div className="message-actions bot-actions">
                  <button
                    type="button"
                    className={`copy-message-btn ${copiedMessageIds.has(messageId) ? 'copied' : ''}`}
                    onClick={(e) => handleCopyClick(e, m.content, messageId)}
                    title="Copiar respuesta"
                  >
                    {copiedMessageIds.has(messageId) ? '✓' : 'Copiar respuesta'}
                  </button>
                </div>
              </div>
            );
          }
          return (
            <React.Fragment key={messageId}>
              {images.map((att, i) => {
                const src = att.previewUrl || att.thumbDataUrl || '';
                if (!src) return null;
                return (
                  <img
                    key={`${messageId}-img-${i}`}
                    className="inline-image user"
                    src={src}
                    alt="imagen adjunta"
                  />
                );
              })}
              <div className={`message ${m.role}`}>
                {docs.length > 0 && (
                  <div className="message-attachments">
                    {docs.map((att, i) => {
                      const displayName = att.name || att.filename || '';
                      const inferredKind = (() => {
                        const lower = displayName.toLowerCase();
                        if (lower.endsWith('.pdf')) return 'pdf';
                        if (lower.endsWith('.docx')) return 'docx';
                        if (lower.endsWith('.pptx')) return 'pptx';
                        if (lower.endsWith('.xlsx')) return 'xlsx';
                        if (lower.endsWith('.csv')) return 'csv';
                        if (lower.endsWith('.txt')) return 'txt';
                        return null;
                      })();
                      const fileKind = att.kind || inferredKind || 'file';
                      let iconText = 'FILE';

                      // Determinar el icono basado en el tipo
                      switch (fileKind) {
                        case 'pdf': iconText = 'PDF'; break;
                        case 'docx': iconText = 'DOCX'; break;
                        case 'pptx': iconText = 'PPTX'; break;
                        case 'xlsx': iconText = 'XLSX'; break;
                        case 'csv': iconText = 'CSV'; break;
                        case 'txt': iconText = 'TXT'; break;
                        default: iconText = 'FILE';
                      }

                      return (
                        <div key={`${messageId}-doc-${i}`} className="attachment-card doc">
                          <div className="doc-icon">{iconText}</div>
                          <div className="meta">
                            <div className="fname" title={displayName}>{displayName}</div>
                            <div className="ftype">{iconText}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Contenido del mensaje o input de edición */}
                {editingMessageId === messageId ? (
                  <div className="message-edit-container">
                    <textarea
                      className="message-edit-input"
                      value={editingContent}
                      onChange={(e) => setEditingContent(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          saveEdit(messageId);
                        }
                        if (e.key === 'Escape') {
                          cancelEditing();
                        }
                      }}
                      autoFocus
                      onFocus={(e) => {
                        try {
                          // Evitar que el foco desplace el contenedor
                          e.target.scrollIntoView({ block: 'nearest' });
                        } catch {}
                        try {
                          const el = document.querySelector('.messages');
                          const prev = el && el.dataset.prevScroll ? parseInt(el.dataset.prevScroll, 10) : null;
                          if (el && prev !== null) el.scrollTop = prev;
                        } catch {}
                      }}
                    />
                    <div className="message-edit-actions">
                      <button
                        className="edit-save-btn"
                        onClick={() => saveEdit(messageId)}
                        disabled={!editingContent.trim()}
                      >
                        Enviar
                      </button>
                      <button
                        className="edit-cancel-btn"
                        onClick={cancelEditing}
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="message-content">
                      {m.isProcessing ? (
                        // Mostrar solo los 3 puntos animados cuando está procesando
                        <div className="loading-dots">
                          <div className="dot"></div>
                          <div className="dot"></div>
                          <div className="dot"></div>
                        </div>
                      ) : (!m.content || m.content.trim().length === 0 || m.content === '(mensaje vacío)') ? (
                        <span className="empty-placeholder">(mensaje vacío)</span>
                      ) : (
                        m.content
                      )}
                      {m.isEdited && <span className="edited-indicator">(editado)</span>}
                    </div>
                    {/* Botones de acción para mensajes del usuario (ocultar si está procesando) */}
                    {m.role === 'user' && !m.isProcessing && (
                      <div className="message-actions">
                        <button
                          className="edit-message-btn"
                          onClick={() => startEditing(messageId, m.content)}
                          title="Editar mensaje"
                        >
                          Editar
                        </button>
                        {/* Botón de copiar para mensajes del USUARIO - NO TOCAR */}
                        <button
                          type="button"
                          className={`copy-message-btn ${copiedMessageIds.has(messageId) ? 'copied' : ''}`}
                          onClick={(e) => handleCopyClick(e, m.content, messageId)}
                          title="Copiar mensaje"
                        >
                          {copiedMessageIds.has(messageId) ? '✓' : 'Copiar'}
                        </button>
                      </div>
                    )}

                  </>
                )}
              </div>
            </React.Fragment>
          );
        })}
        {loading && (
          <div className="message bot">
            <div className="loading-dots">
              <div className="dot"></div>
              <div className="dot"></div>
              <div className="dot"></div>
            </div>
          </div>
        )}
      </div>


      {/* Barra de adjuntos justo encima del input */}
      {attachments.length > 0 && (
        <div className="attachments-bar">
          {attachments.map((a) => (
            <div key={a.id} className="attachment-chip">
              <span className="name" title={a.name}>{a.name}</span>
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                {a.status === 'uploading' ? `${Math.max(5, Math.min(100, Math.floor(a.progress)))}%` : a.status === 'done' ? 'Listo' : a.status === 'error' ? 'Error' : 'Pendiente'}
              </span>
              <button
                type="button"
                className="remove-attachment"
                title="Quitar adjunto"
                onClick={() => removeAttachment(a.id)}
                aria-label={`Quitar ${a.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form ref={formRef} className="input-container fancy-input-bar" onSubmit={handleSubmit} onDrop={onDropArea} onDragOver={(e)=>{e.preventDefault();}}>
        <button
          type="button"
          className="icon-btn attach-btn"
          tabIndex={-1}
          onClick={onAttachClick}
          style={{
            display: isListening ? 'none' : 'flex',
            filter: isProcessing ? 'grayscale(100%) opacity(0.5)' : 'none',
            pointerEvents: isProcessing ? 'none' : 'auto'
          }}
        >
          <img src={attachIcon} alt="adjuntar" />
        </button>
        <input type="file" ref={fileInputRef} onChange={onFileInputChange} accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,image/*" multiple style={{ display: 'none' }} />

        {/* Interfaz integrada del micrófono - solo cuando está activo */}
        {isListening ? (
          <div className="message-input-wrapper mic-recording-wrapper" ref={wrapperRef}>
            {/* Mostrar controles de grabación */}
              <div className="mic-recording-controls">
                <button
                  type="button"
                  className="audio-control-btn delete-btn"
                  onClick={handleAudioCancel}
                  title="Cancelar grabación"
                >
                  <img src={eliminateIcon} alt="Eliminar" />
                </button>
                <div className="recording-info">
                  <div className="recording-indicator">
                    <div className="recording-dot"></div>
                    <span className="recording-time">{formatRecordingTime(recordingTime)}</span>
                  </div>
                </div>
                <div className={`audio-waveform ${isPaused ? 'paused' : ''}`} ref={waveformRef}>
                  {[...Array(waveformBarsCount)].map((_, i) => (
                    <div
                      key={i}
                      className="wave-bar"
                      style={{
                        height: `${Math.random() * 60 + 20}%`,
                        animationDelay: `${i * 0.08}s`
                      }}
                    ></div>
                  ))}
                </div>
                <button
                  type="button"
                  className="audio-control-btn pause-btn"
                  onClick={pauseListening}
                  title={isPaused ? "Reanudar" : "Pausar"}
                >
                  <img src={isPaused ? playIcon : pauseIcon} alt={isPaused ? "Reanudar" : "Pausar"} />
                </button>
              </div>
          </div>
        ) : (
          // Textarea normal cuando no está grabando
        <div className="message-input-wrapper" ref={wrapperRef}>
          <textarea
            ref={inputRef}
            className="message-input"
            placeholder="Escribe tu pregunta..."
            rows={1}
            value={input}
            onScroll={handleTextareaScroll}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="none"
              disabled={isProcessing}
              style={{
                filter: isProcessing ? 'grayscale(100%) opacity(0.5)' : 'none',
                pointerEvents: isProcessing ? 'none' : 'auto'
              }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                try {
                  handleSubmit({ preventDefault: () => {} });
                } catch {}
              }
            }}
          />
          {showCustomScrollbar && (
            <div className="custom-scrollbar-track" ref={trackRef} aria-hidden>
              <div
                className="custom-scrollbar-thumb"
                style={{ top: thumbTop, height: thumbHeight }}
                onMouseDown={handleThumbMouseDown}
              />
            </div>
          )}
        </div>
        )}

        <button
          type="button"
          className={`icon-btn mic-btn ${isListening ? 'recording' : ''}`}
          onClick={handleMicClick}
          title={isListening ? 'Detener grabación' : 'Iniciar grabación de voz'}
          style={{
            display: isListening ? 'none' : 'flex',
            filter: isProcessing ? 'grayscale(100%) opacity(0.5)' : 'none',
            pointerEvents: isProcessing ? 'none' : 'auto'
          }}
        >
          <img src={micIcon} alt="micrófono" />
        </button>

        {/* Botón de enviar/detener - cambia según el estado */}
        {isListening && !isProcessing ? (
          // Cuando está grabando, mostrar botón de detener (que envía)
          <button
            type="button"
            className="icon-btn send-btn"
            onClick={handleAudioSend}
            title="Detener y enviar"
          >
            <img src={sendIcon} alt="enviar" />
          </button>
        ) : isProcessing ? (
          // Cuando está procesando audio, mostrar botón de stop para cancelar
          <button
            type="button"
            className="icon-btn send-btn stop-btn"
            onClick={handleCancelProcessing}
            title="Cancelar procesamiento"
          >
            <StopIconSvg />
          </button>
        ) : isGenerating || isTypewriting ? (
          <button type="button" className="icon-btn send-btn stop-btn" onClick={handleStopGenerating} title="Detener respuesta">
            <StopIconSvg />
          </button>
        ) : (
          <button
            type="submit"
            className={`icon-btn send-btn ${(() => {
              const hasText = input?.trim();
              const hasPendingAttachments = attachments && attachments.some(a => a.status !== 'done');
              const hasReadyAttachments = attachments && attachments.some(a => a.status === 'done');

              // Mostrar como bloqueado si hay adjuntos pendientes O si no hay texto ni adjuntos listos
              return (hasPendingAttachments || (!hasText && !hasReadyAttachments)) ? 'disabled-visual' : '';
            })()}`}
            disabled={loading}
            title="Enviar"
          >
            <img src={sendIcon} alt="enviar" />
          </button>
        )}
      </form>

      {isDraggingOver && (
        <div className="global-drop-overlay">Suelta archivos para adjuntarlos</div>
      )}

      {/* Toasts */}
      {toasts.length > 0 && (
        <div className="toast-container" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.variant || 'info'}`}>{t.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Chat;
