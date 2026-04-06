import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  content: {
    type: String,
    required: [true, 'El contenido del mensaje es requerido'],
    trim: true
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: [true, 'La conversación es requerida'],
    index: true
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false // Ahora es opcional
  },
  sender: {
    type: String, // email del usuario que envía
    required: [true, 'El remitente es requerido'],
    index: true
  },
  role: {
    type: String,
    enum: ['user', 'assistant', 'system'],
    default: 'user'
  },
  type: {
    type: String,
    enum: ['text', 'image', 'file', 'code', 'markdown'],
    default: 'text'
  },
  // Rastro de adjuntos enviados con el mensaje (miniatura o chip)
  attachments: [{
    filename: { type: String },
    size: { type: Number },
    type: { type: String }, // MIME
    kind: { type: String, enum: ['image', 'pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'file'], default: 'file' },
    thumbDataUrl: { type: String }, // miniatura pequeña (solo imágenes)
    extractHash: { type: String }, // hash del servicio de extracción (si aplica)
    extractMeta: { type: Object }, // { pages, confidence, is_native, paragraphs, sheets, rows, columns, lines, encoding, ... }
    extractResult: { type: Object } // Resultado completo de extracción (full_text, etc.)
  }],
  metadata: {
    tokens: {
      type: Number,
      default: 0
    },
    model: {
      type: String,
      default: 'gpt-3.5-turbo'
    },
    temperature: {
      type: Number,
      default: 0.7
    },
    responseTime: {
      type: Number, // en milisegundos
      default: 0
    },
    attachments: [{
      filename: String,
      size: Number,
      type: String,
      url: String
    }]
  },
  // Campo para archivos generados automáticamente
  generatedFile: {
    nombre: String,
    downloadName: String,
    formato: String,
    url: String,
    mensaje: String,
    filePath: String,
    localPath: String,  // Ruta local del archivo (para auto-save)
    fileId: String,     // ID único para tracking interno
    fileBuffer: Buffer, // Contenido binario del archivo (solo si auto-save está desactivado)
    preview: String, // Para images: preview blur en base64 (data:image/...)
    width: Number,   // Dimensiones de la imagen
    height: Number,
    size: Number,    // Tamaño del archivo en bytes
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  status: {
    type: String,
    enum: ['sent', 'delivered', 'read', 'error'],
    default: 'sent'
  },
  reactions: [{
    user: String, // email del usuario
    emoji: String,
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  parentMessageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null
  },
  isEdited: {
    type: Boolean,
    default: false
  },
  editHistory: [{
    content: String,
    editedAt: {
      type: Date,
      default: Date.now
    },
    editedBy: String
  }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices para optimizar consultas
messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ workspaceId: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ role: 1 });
messageSchema.index({ 'metadata.tokens': 1 });
messageSchema.index({ parentMessageId: 1 });

// Virtual para obtener la conversación
messageSchema.virtual('conversation', {
  ref: 'Conversation',
  localField: 'conversationId',
  foreignField: '_id',
  justOne: true
});

// Virtual para obtener el workspace
messageSchema.virtual('workspace', {
  ref: 'Workspace',
  localField: 'workspaceId',
  foreignField: '_id',
  justOne: true
});

// Virtual para obtener mensajes hijos (respuestas)
messageSchema.virtual('replies', {
  ref: 'Message',
  localField: '_id',
  foreignField: 'parentMessageId'
});

// Método para editar mensaje
messageSchema.methods.edit = function(newContent, editedBy) {
  // Guardar versión anterior en historial
  this.editHistory.push({
    content: this.content,
    editedAt: new Date(),
    editedBy: editedBy
  });

  this.content = newContent;
  this.isEdited = true;

  return this.save();
};

// Método para agregar reacción
messageSchema.methods.addReaction = function(userEmail, emoji) {
  const existingIndex = this.reactions.findIndex(
    r => r.user === userEmail && r.emoji === emoji
  );

  if (existingIndex >= 0) {
    // Remover reacción si ya existe
    this.reactions.splice(existingIndex, 1);
  } else {
    // Agregar nueva reacción
    this.reactions.push({
      user: userEmail,
      emoji: emoji
    });
  }

  return this.save();
};

// Método para marcar como leído
messageSchema.methods.markAsRead = function() {
  this.status = 'read';
  return this.save();
};

// Método para obtener mensajes de una conversación con paginación
messageSchema.statics.getConversationMessages = async function(
  conversationId,
  page = 1,
  limit = 50,
  beforeDate = null
) {
  const skip = (page - 1) * limit;

  let query = { conversationId };
  if (beforeDate) {
    query.createdAt = { $lt: beforeDate };
  }

  const messages = await this.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('sender', 'email nombre')
    .lean();

  const total = await this.countDocuments({ conversationId });

  return {
    messages: messages.reverse(), // Ordenar cronológicamente
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: skip + limit < total,
      hasPrev: page > 1
    }
  };
};

// Método para buscar mensajes
messageSchema.statics.searchMessages = async function(
  workspaceId,
  query,
  userId = null,
  limit = 20
) {
  let searchQuery = {
    workspaceId,
    content: { $regex: query, $options: 'i' }
  };

  // Si se especifica usuario, buscar solo sus mensajes
  if (userId) {
    searchQuery.sender = userId;
  }

  const messages = await this.find(searchQuery)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('conversationId', 'title')
    .populate('sender', 'email nombre')
    .lean();

  return messages;
};

// Método para obtener estadísticas de mensajes
messageSchema.statics.getMessageStats = async function(workspaceId, userId) {
  const stats = await this.aggregate([
    {
      $match: {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        sender: userId
      }
    },
    {
      $group: {
        _id: null,
        totalMessages: { $sum: 1 },
        totalTokens: { $sum: '$metadata.tokens' },
        avgResponseTime: { $avg: '$metadata.responseTime' }
      }
    }
  ]);

  return stats[0] || {
    totalMessages: 0,
    totalTokens: 0,
    avgResponseTime: 0
  };
};

// Pre-save middleware para validar
messageSchema.pre('save', function(next) {
  if (this.content.length > 10000) {
    next(new Error('El mensaje no puede exceder 10,000 caracteres'));
  }

  if (this.reactions.length > 20) {
    next(new Error('Un mensaje no puede tener más de 20 reacciones'));
  }

  next();
});

const Message = mongoose.model('Message', messageSchema);

export default Message;
