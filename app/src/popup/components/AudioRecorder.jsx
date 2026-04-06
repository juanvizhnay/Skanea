import React, { useState, useEffect } from 'react';
import './AudioRecorder.css';

const AudioRecorder = ({ 
  isRecording, 
  onStop, 
  onCancel, 
  onSend, 
  onPause,
  isPaused = false,
  transcript = '',
  isProcessing = false,
  isServiceReady = false
}) => {
  const [recordingTime, setRecordingTime] = useState(0);
  const [localPaused, setLocalPaused] = useState(false);

  // Timer para el tiempo de grabación
  useEffect(() => {
    let interval;
    if (isRecording && !localPaused && !isPaused) {
      interval = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording, localPaused, isPaused]);

  // Resetear tiempo cuando empieza nueva grabación
  useEffect(() => {
    if (isRecording) {
      setRecordingTime(0);
      setLocalPaused(false);
    }
  }, [isRecording]);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handlePause = () => {
    const newPausedState = !localPaused;
    setLocalPaused(newPausedState);
    if (onPause) {
      onPause(newPausedState);
    }
  };

  const handleCancel = () => {
    setRecordingTime(0);
    setLocalPaused(false);
    onCancel();
  };

  const handleSend = () => {
    // Si estamos grabando, el botón enviar debe finalizar la grabación
    // y delegar el envío automático al flujo superior
    if (typeof onSend === 'function') {
      onSend();
    }
    setRecordingTime(0);
    setLocalPaused(false);
  };

  // Mostrar error si el servicio no está listo
  if (!isServiceReady && !isRecording) {
    return null;
  }

  if (!isRecording) {
    return null;
  }

  return (
    <div className="audio-recorder">
      <div className="audio-controls">
        {/* Botón de eliminar */}
        <button 
          className="audio-btn delete-btn" 
          onClick={handleCancel}
          title="Eliminar grabación"
        >
          🗑️
        </button>

        {/* Indicador de tiempo y grabación */}
        <div className="recording-info">
          <div className="recording-indicator">
            <div className="recording-dot"></div>
            <span className="recording-time">{formatTime(recordingTime)}</span>
          </div>
        </div>

        {/* Onda de audio simulada */}
        <div className="audio-waveform">
          {[...Array(20)].map((_, i) => (
            <div 
              key={i} 
              className="wave-bar"
              style={{
                height: `${Math.random() * 60 + 20}%`,
                animationDelay: `${i * 0.1}s`
              }}
            ></div>
          ))}
        </div>

        {/* Botón de pausa */}
        <button 
          className="audio-btn pause-btn" 
          onClick={handlePause}
          title={(localPaused || isPaused) ? "Reanudar" : "Pausar"}
        >
          {(localPaused || isPaused) ? '▶️' : '⏸️'}
        </button>

        {/* Botón de enviar (detiene y desencadena autosend) */}
        <button 
          className="audio-btn send-btn" 
          onClick={handleSend}
          disabled={!isRecording && !transcript.trim()}
          title="Detener y enviar"
        >
          ✈️
        </button>
      </div>
    </div>
  );
};

export default AudioRecorder; 