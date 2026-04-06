import mongoose from 'mongoose';

const conversationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    maxlength: 200
  },
  createdBy: {
    type: String, // email del usuario creador
    required: true
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false // Ahora es opcional
  },
  description: {
    type: String,
    trim: true,
    maxlength: [1000, 'La descripción no puede exceder 1000 caracteres'],
    default: ''
  },
  settings: {
    isArchived: {
      type: Boolean,
      default: false
    },
    isPinned: {
      type: Boolean,
      default: false
    },
    allowEditing: {
      type: Boolean,
      default: true
    },
    autoSave: {
      type: Boolean,
      default: true
    }
  },
  stats: {
    totalMessages: {
      type: Number,
      default: 0
    },
    lastMessageAt: {
      type: Date,
      default: Date.now
    },
    participants: [{
      email: String,
      lastSeen: {
        type: Date,
        default: Date.now
      },
      messageCount: {
        type: Number,
        default: 0
      }
    }]
  },
  tags: [{
    type: String,
    trim: true,
    maxlength: 20
  }],
  metadata: {
    model: {
      type: String,
      default: 'gpt-3.5-turbo'
    },
    temperature: {
      type: Number,
      default: 0.7,
      min: 0,
      max: 2
    },
    maxTokens: {
      type: Number,
      default: 1000
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices para optimizar consultas
conversationSchema.index({ workspaceId: 1, createdAt: -1 });
conversationSchema.index({ createdBy: 1, createdAt: -1 });
conversationSchema.index({ 'settings.isArchived': 1 });
conversationSchema.index({ 'settings.isPinned': 1 });
conversationSchema.index({ 'stats.lastMessageAt': -1 });

// Virtual para obtener mensajes de la conversación
conversationSchema.virtual('messages', {
  ref: 'Message',
  localField: '_id',
  foreignField: 'conversationId'
});

// Virtual para obtener el workspace
conversationSchema.virtual('workspace', {
  ref: 'Workspace',
  localField: 'workspaceId',
  foreignField: '_id',
  justOne: true
});

// Método para actualizar estadísticas
conversationSchema.methods.updateStats = async function() {
  const Message = mongoose.model('Message');
  
  const totalMessages = await Message.countDocuments({ conversationId: this._id });
  const lastMessage = await Message.findOne({ conversationId: this._id })
    .sort({ createdAt: -1 })
    .select('createdAt');
  
  this.stats.totalMessages = totalMessages;
  if (lastMessage) {
    this.stats.lastMessageAt = lastMessage.createdAt;
  }
  
  return this.save();
};

// Método para agregar participante
conversationSchema.methods.addParticipant = function(email) {
  const existingIndex = this.stats.participants.findIndex(p => p.email === email);
  
  if (existingIndex >= 0) {
    this.stats.participants[existingIndex].lastSeen = new Date();
  } else {
    this.stats.participants.push({
      email,
      lastSeen: new Date(),
      messageCount: 0
    });
  }
  
  return this.save();
};

// Método para actualizar último mensaje de participante
conversationSchema.methods.updateParticipantMessageCount = function(email) {
  const participant = this.stats.participants.find(p => p.email === email);
  if (participant) {
    participant.messageCount += 1;
    participant.lastSeen = new Date();
  }
  return this.save();
};

// Método para archivar/desarchivar
conversationSchema.methods.toggleArchive = function() {
  this.settings.isArchived = !this.settings.isArchived;
  return this.save();
};

// Método para pin/unpin
conversationSchema.methods.togglePin = function() {
  this.settings.isPinned = !this.settings.isPinned;
  return this.save();
};

// Método para obtener conversaciones agrupadas por fecha
conversationSchema.statics.getGroupedByDate = async function(workspaceId, userId) {
  const conversations = await this.find({
    workspaceId,
    $or: [
      { createdBy: userId },
      { 'stats.participants.email': userId }
    ]
  })
  .sort({ 'stats.lastMessageAt': -1 })
  .populate('workspace', 'name')
  .lean();
  
  const grouped = {};
  conversations.forEach(conv => {
    const date = conv.stats.lastMessageAt.toDateString();
    if (!grouped[date]) {
      grouped[date] = [];
    }
    grouped[date].push(conv);
  });
  
  return grouped;
};

// Pre-save middleware para validar
conversationSchema.pre('save', function(next) {
  if (this.stats.participants.length > 50) {
    next(new Error('Una conversación no puede tener más de 50 participantes'));
  }
  next();
});

const Conversation = mongoose.model('Conversation', conversationSchema);

export default Conversation; 