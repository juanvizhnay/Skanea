import Conversation from '../models/conversation.js';
import Message from '../models/message.js';
import Workspace from '../models/workspace.js';

// Crear una nueva conversación
export const createConversation = async (req, res) => {
  try {
    const { title, workspaceId, settings, tags } = req.body;
    const userEmail = req.user.email;

    let conversation;
    if (workspaceId) {
      // Verificar que el workspace existe y pertenece al usuario
      const workspace = await Workspace.findOne({ 
        _id: workspaceId, 
        $or: [
          { owner: userEmail },
          { 'collaborators.email': userEmail }
        ]
      });
      if (!workspace) {
        return res.status(404).json({
          success: false,
          message: 'Workspace no encontrado'
        });
      }
      conversation = new Conversation({
        title: title || 'Nueva conversación',
        createdBy: userEmail,
        workspaceId,
        settings,
        tags,
        stats: { lastMessageAt: new Date() } // Inicializa la fecha
      });
    } else {
      // Conversación general (sin workspace)
      conversation = new Conversation({
        title: title || 'Nueva conversación',
        createdBy: userEmail,
        settings,
        tags,
        stats: { lastMessageAt: new Date() } // Inicializa la fecha
      });
    }

    await conversation.save();

    res.status(201).json({
      success: true,
      data: conversation,
      message: 'Conversación creada exitosamente'
    });
  } catch (error) {
    console.error('Error creando conversación:', error);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Obtener conversaciones del usuario
export const getConversations = async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { 
      workspaceId, 
      status = 'active', 
      page = 1, 
      limit = 20,
      sortBy = 'lastActivity',
      sortOrder = 'desc'
    } = req.query;

    const filter = { 
      $or: [
        { createdBy: userEmail },
        { 'stats.participants.email': userEmail }
      ]
    };
    if (workspaceId) {
      filter.workspaceId = workspaceId;
    }

    const sortOptions = {};
    if (sortBy === 'lastActivity') {
      sortOptions['stats.lastMessageAt'] = sortOrder === 'desc' ? -1 : 1;
    } else if (sortBy === 'createdAt') {
      sortOptions.createdAt = sortOrder === 'desc' ? -1 : 1;
    } else if (sortBy === 'title') {
      sortOptions.title = sortOrder === 'desc' ? -1 : 1;
    }

    const skip = (page - 1) * limit;

    const conversations = await Conversation.find(filter)
      .select('title workspaceId stats.lastMessageAt createdAt settings.isPinned settings.isArchived tags')
      .populate('workspaceId', 'name color')
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await Conversation.countDocuments(filter);

    res.json({
      success: true,
      data: conversations,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Obtener conversaciones agrupadas por fecha
export const getConversationsByDate = async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { workspaceId, days = 30 } = req.query;

    const filter = { 
      $or: [
        { createdBy: userEmail },
        { 'stats.participants.email': userEmail }
      ]
    };
    if (workspaceId) {
      filter.workspaceId = workspaceId;
    }

    // Obtener conversaciones de los últimos N días
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    filter['stats.lastMessageAt'] = { $gte: startDate };

    const conversations = await Conversation.find(filter)
      .select('title workspaceId stats.lastMessageAt createdAt')
      .populate('workspaceId', 'name color')
      .sort({ 'stats.lastMessageAt': -1 })
      .lean();

    // Agrupar por fecha (usa createdAt si no hay lastMessageAt)
    const groupedConversations = conversations.reduce((groups, conversation) => {
      const dateObj = conversation.stats?.lastMessageAt || conversation.createdAt || new Date();
      const date = dateObj.toDateString();
      if (!groups[date]) {
        groups[date] = [];
      }
      groups[date].push(conversation);
      return groups;
    }, {});

    // Convertir a array ordenado
    const result = Object.entries(groupedConversations)
      .map(([date, conversations]) => ({
        date,
        conversations
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    const isNet = /Mongo(ServerSelection|Network)Error|ECONNREFUSED|ETIMEDOUT/i.test(String(error?.name || '') + ' ' + String(error?.message || ''));
    if (isNet) {
      return res.status(503).json({ success: false, message: 'Servicio de base de datos no disponible. Inténtalo de nuevo en unos segundos.' });
    }
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
};

// Obtener una conversación específica
export const getConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email;

    const conversation = await Conversation.findOne({ 
      _id: id, 
      $or: [
        { createdBy: userEmail },
        { 'stats.participants.email': userEmail }
      ]
    })
      .populate('workspaceId', 'name color');

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversación no encontrada'
      });
    }

    res.json({
      success: true,
      data: conversation
    });
  } catch (error) {
    console.error('Error obteniendo conversación:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Actualizar una conversación
export const updateConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, tags, settings } = req.body;
    const userEmail = req.user.email;

    const conversation = await Conversation.findOne({ 
      _id: id, 
      $or: [
        { createdBy: userEmail },
        { 'stats.participants.email': userEmail }
      ]
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversación no encontrada'
      });
    }

    // Actualizar campos
    if (title !== undefined) conversation.title = title;
    if (description !== undefined) conversation.description = description;
    if (tags !== undefined) conversation.tags = tags;
    if (settings !== undefined) conversation.settings = settings;

    await conversation.save();

    res.json({
      success: true,
      data: conversation,
      message: 'Conversación actualizada exitosamente'
    });
  } catch (error) {
    console.error('Error actualizando conversación:', error);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Mover conversación a otro workspace
export const moveConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId } = req.body;
    const userEmail = req.user.email;

    // Verificar que la conversación existe
    const conversation = await Conversation.findOne({ 
      _id: id, 
      $or: [
        { createdBy: userEmail },
        { 'stats.participants.email': userEmail }
      ]
    });
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversación no encontrada'
      });
    }

    // Verificar que el workspace destino existe
    const workspace = await Workspace.findOne({ 
      _id: workspaceId, 
      $or: [
        { owner: userEmail },
        { 'collaborators.email': userEmail }
      ]
    });
    if (!workspace) {
      return res.status(404).json({
        success: false,
        message: 'Workspace destino no encontrado'
      });
    }

    conversation.workspaceId = workspaceId;
    await conversation.save();

    res.json({
      success: true,
      data: conversation,
      message: 'Conversación movida exitosamente'
    });
  } catch (error) {
    console.error('Error moviendo conversación:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Eliminar una conversación (hard delete)
export const deleteConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email;

    const conversation = await Conversation.findOne({ 
      _id: id, 
      $or: [
        { createdBy: userEmail },
        { 'stats.participants.email': userEmail }
      ]
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversación no encontrada'
      });
    }

    // Eliminar todos los mensajes asociados
    await Message.deleteMany({ conversationId: id });

    // Eliminar la conversación
    await conversation.deleteOne();

    res.json({
      success: true,
      message: 'Conversación y mensajes eliminados exitosamente'
    });
  } catch (error) {
    console.error('Error eliminando conversación:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Buscar conversaciones
export const searchConversations = async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { q, workspaceId, tags, page = 1, limit = 20 } = req.query;

    const filter = { 
      $or: [
        { createdBy: userEmail },
        { 'stats.participants.email': userEmail }
      ]
    };
    
    if (workspaceId) {
      filter.workspaceId = workspaceId;
    }

    if (q) {
      filter.$and = [{
        $or: [
          { title: { $regex: q, $options: 'i' } },
          { description: { $regex: q, $options: 'i' } },
          { tags: { $in: [new RegExp(q, 'i')] } }
        ]
      }];
    }

    if (tags) {
      const tagArray = tags.split(',').map(tag => tag.trim());
      filter.tags = { $in: tagArray };
    }

    const skip = (page - 1) * limit;

    const conversations = await Conversation.find(filter)
      .populate('workspaceId', 'name color')
      .sort({ 'stats.lastMessageAt': -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Conversation.countDocuments(filter);

    res.json({
      success: true,
      data: conversations,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error buscando conversaciones:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
}; 