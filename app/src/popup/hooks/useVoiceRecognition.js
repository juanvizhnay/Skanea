import { useState, useEffect, useCallback, useRef } from 'react';

const useVoiceRecognition = (onTranscriptionReady) => {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isServiceReady, setIsServiceReady] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const isManualStopRef = useRef(false);
  const isCancelledRef = useRef(false);

  // Verificar estado del servicio de transcripción
  const checkServiceStatus = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setError('No hay token de autenticación');
        return false;
      }

      const response = await fetch('http://localhost:10000/api/transcription/status', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setIsServiceReady(data.ready);
        return data.ready;
      } else {
        setError('Error verificando estado del servicio');
        return false;
      }
    } catch (error) {
      console.error('Error verificando servicio:', error);
      setError('Error de conexión con el servidor');
      return false;
    }
  }, []);

  useEffect(() => { checkServiceStatus(); }, [checkServiceStatus]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const startListening = useCallback(async () => {
    try {
      if (!isServiceReady) {
        const ready = await checkServiceStatus();
        if (!ready) return;
      }

      isManualStopRef.current = false;
      isCancelledRef.current = false;

      // Solicitar permisos de micrófono con configuración de alta calidad
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,        // Mayor calidad (48kHz en lugar de 16kHz)
          channelCount: 1,          // Mono (suficiente para voz, reduce tamaño)
          sampleSize: 16,           // 16-bit audio
          latency: 0,               // Baja latencia
          volume: 1.0               // Volumen máximo
        }
      });
      streamRef.current = stream;

      // MediaRecorder con mayor bitrate para mejor calidad
      const mediaRecorder = new MediaRecorder(streamRef.current, { 
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 128000  // 128kbps (mejor calidad sin impactar mucho el tamaño)
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        if (isCancelledRef.current) {
          return;
        }
        setIsProcessing(true);
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

          if (isCancelledRef.current) {
            return;
          }

          const result = await transcribeAudio(audioBlob);
          
          if (isCancelledRef.current) {
            return;
          }

          if (result?.text && typeof onTranscriptionReady === 'function') {
            onTranscriptionReady({
              text: result.text,
              language: result.language || 'unknown',
              languageConfidence: result.languageConfidence || 0
            });
          }
        } catch (err) {
          console.error('[AUDIO] Error en transcripción:', err);
          setError('Error al transcribir el audio. Intenta de nuevo.');
        } finally {
          setIsProcessing(false);
          audioChunksRef.current = [];
        }
      };

      mediaRecorder.start();
      setIsListening(true);
      setIsPaused(false);
      setError(null);
    } catch (err) {
      console.error('Error al iniciar grabación:', err);
      setError('Error al iniciar la grabación. Intenta de nuevo.');
    }
  }, [isServiceReady, checkServiceStatus, onTranscriptionReady]);

  const stopListening = useCallback(() => {
    isManualStopRef.current = true;
    isCancelledRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsListening(false);
    setIsPaused(false);
  }, []);

  const pauseListening = useCallback(() => {
    if (mediaRecorderRef.current) {
      if (isPaused) mediaRecorderRef.current.resume(); else mediaRecorderRef.current.pause();
      setIsPaused(!isPaused);
    }
  }, [isPaused]);

  const clearTranscript = useCallback(() => {
    isCancelledRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop();
    if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
    setIsListening(false);
    setIsPaused(false);
  }, []);

  // Nueva función para cancelar el procesamiento de transcripción
  const cancelProcessing = useCallback(() => {
    isCancelledRef.current = true;
    
    setIsProcessing(false);
    
    setIsListening(false);
    setIsPaused(false);
    
    audioChunksRef.current = [];
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }, [isListening, isPaused, isProcessing]);

  const transcribeAudio = async (audioBlob) => {
    const requestStartTime = performance.now();
    const token = localStorage.getItem('token');
    if (!token) throw new Error('No hay token de autenticación');

    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    const response = await fetch('http://localhost:10000/api/transcription/transcribe', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
      credentials: 'include'
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[AUDIO] Error en respuesta:', errorData);
      throw new Error(errorData.error || 'Error en el servidor');
    }

    const data = await response.json();

    if (data.success) {
      return {
        text: data.transcription || data.text,
        language: data.language || 'unknown',
        languageConfidence: data.languageConfidence || 0
      };
    }
    throw new Error(data.error || 'Error en transcripción');
  };

  return { isListening, error, isPaused, isProcessing, isServiceReady, startListening, stopListening, pauseListening, clearTranscript, cancelProcessing };
};

export default useVoiceRecognition;
