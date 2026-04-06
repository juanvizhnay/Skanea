import mongoose from 'mongoose';

const workspaceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'El nombre del workspace es requerido'],
    trim: true,
    maxlength: [100, 'El nombre no puede exceder 100 caracteres']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'La descripción no puede exceder 500 caracteres'],
    default: ''
  },
  owner: {
    type: String, // email del usuario propietario
    required: [true, 'El propietario es requerido'],
    index: true
  },
  collaborators: [{
    email: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ['admin', 'editor', 'viewer'],
      default: 'viewer'
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  settings: {
    isPublic: {
      type: Boolean,
      default: false
    },
    allowComments: {
      type: Boolean,
      default: true
    },
    autoSave: {
      type: Boolean,
      default: true
    }
  },
  stats: {
    totalConversations: {
      type: Number,
      default: 0
    },
    totalMessages: {
      type: Number,
      default: 0
    },
    lastActivity: {
      type: Date,
      default: Date.now
    }
  },
  tags: [{
    type: String,
    trim: true,
    maxlength: 20
  }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices para optimizar consultas
workspaceSchema.index({ owner: 1, createdAt: -1 });
workspaceSchema.index({ 'collaborators.email': 1 });
workspaceSchema.index({ tags: 1 });

// Virtual para obtener conversaciones del workspace
workspaceSchema.virtual('conversations', {
  ref: 'Conversation',
  localField: '_id',
  foreignField: 'workspaceId'
});

// Método para actualizar estadísticas
workspaceSchema.methods.updateStats = async function() {
  const Conversation = mongoose.model('Conversation');
  const Message = mongoose.model('Message');
  
  const totalConversations = await Conversation.countDocuments({ workspaceId: this._id });
  const totalMessages = await Message.countDocuments({ workspaceId: this._id });
  
  this.stats.totalConversations = totalConversations;
  this.stats.totalMessages = totalMessages;
  this.stats.lastActivity = new Date();
  
  return this.save();
};

// Método para agregar colaborador
workspaceSchema.methods.addCollaborator = function(email, role = 'viewer') {
  const existingIndex = this.collaborators.findIndex(c => c.email === email);
  
  if (existingIndex >= 0) {
    this.collaborators[existingIndex].role = role;
  } else {
    this.collaborators.push({ email, role });
  }
  
  return this.save();
};

// Método para remover colaborador
workspaceSchema.methods.removeCollaborator = function(email) {
  this.collaborators = this.collaborators.filter(c => c.email !== email);
  return this.save();
};

// Método para verificar permisos
workspaceSchema.methods.hasPermission = function(userEmail, requiredRole = 'viewer') {
  if (this.owner === userEmail) return true;
  
  const collaborator = this.collaborators.find(c => c.email === userEmail);
  if (!collaborator) return false;
  
  const roleHierarchy = { admin: 3, editor: 2, viewer: 1 };
  const requiredLevel = roleHierarchy[requiredRole];
  const userLevel = roleHierarchy[collaborator.role];
  
  return userLevel >= requiredLevel;
};

// Pre-save middleware para validar
workspaceSchema.pre('save', function(next) {
  if (this.collaborators.length > 10) {
    next(new Error('Un workspace no puede tener más de 10 colaboradores'));
  }
  next();
});

const Workspace = mongoose.model('Workspace', workspaceSchema);

export default Workspace; 