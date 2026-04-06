import Message from '../models/message.js';
import Conversation from '../models/conversation.js';

// Crear un nuevo mensaje
export const createMessage = async (req, res) => {
  try {
    const { conversationId, role, content, attachments, toolCalls, metadata, generatedFile } = req.body;
    const userEmail = req.user.email;

    // Verificar que la conversación existe y pertenece al usuario
    const conversation = await Conversation.findOne({
      _id: conversationId,
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

    const messageData = {
      conversationId,
      workspaceId: conversation.workspaceId,
      sender: userEmail,
      role,
      content: (typeof content === 'string' && content.trim().length > 0) ? content : '(mensaje vacío)',
      attachments,
      toolCalls,
      metadata
    };

    // Agregar información del archivo generado si existe
    if (generatedFile) {
      messageData.generatedFile = generatedFile;
    }

    const message = new Message(messageData);

    await message.save();

    // Actualizar metadatos de la conversación
    await conversation.updateStats();

    res.status(201).json({
      success: true,
      data: message,
      message: 'Mensaje creado exitosamente'
    });
  } catch (error) {
    console.error('Error creando mensaje:', error);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Obtener mensajes de una conversación
export const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { page = 1, limit = 50, before, after } = req.query;
    const userEmail = req.user.email;

    // Verificar que la conversación existe y pertenece al usuario
    const conversation = await Conversation.findOne({
      _id: conversationId,
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

    const filter = {
      conversationId,
      status: { $ne: 'deleted' }
    };

    // Filtros de fecha para paginación temporal
    if (before) {
      filter.createdAt = { ...filter.createdAt, $lt: new Date(before) };
    }
    if (after) {
      filter.createdAt = { ...filter.createdAt, $gt: new Date(after) };
    }

    const skip = (page - 1) * limit;

    const messages = await Message.find(filter)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Message.countDocuments({
      conversationId,
      status: { $ne: 'deleted' }
    });

    res.json({
      success: true,
      data: messages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error obteniendo mensajes:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Obtener un mensaje específico
export const getMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email;

    const message = await Message.findById(id)
      .populate({
        path: 'conversationId',
        match: {
          $or: [
            { createdBy: userEmail },
            { 'stats.participants.email': userEmail }
          ]
        }
      });

    if (!message || !message.conversationId) {
      return res.status(404).json({
        success: false,
        message: 'Mensaje no encontrado'
      });
    }

    res.json({
      success: true,
      data: message
    });
  } catch (error) {
    console.error('Error obteniendo mensaje:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Actualizar un mensaje
export const updateMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, attachments, toolResults, status } = req.body;
    const userEmail = req.user.email;

    const message = await Message.findById(id)
      .populate({
        path: 'conversationId',
        match: {
          $or: [
            { createdBy: userEmail },
            { 'stats.participants.email': userEmail }
          ]
        }
      });

    if (!message || !message.conversationId) {
      return res.status(404).json({
        success: false,
        message: 'Mensaje no encontrado'
      });
    }

    // Solo permitir actualizar ciertos campos
    if (content !== undefined) {
      // Usar el método edit del modelo para mantener historial
      await message.edit(content, userEmail);

      // Actualizar stats de la conversación para reflejar la edición en el historial
      const conversation = await Conversation.findById(message.conversationId);
      if (conversation) {
        await conversation.updateStats();
      }
    } else {
      if (attachments !== undefined) message.attachments = attachments;
      if (toolResults !== undefined) message.toolResults = toolResults;
      if (status !== undefined) message.status = status;
      await message.save();
    }

    res.json({
      success: true,
      data: message,
      message: 'Mensaje actualizado exitosamente'
    });
  } catch (error) {
    console.error('Error actualizando mensaje:', error);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Eliminar un mensaje (soft delete)
export const deleteMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email;

    const message = await Message.findById(id)
      .populate({
        path: 'conversationId',
        match: {
          $or: [
            { createdBy: userEmail },
            { 'stats.participants.email': userEmail }
          ]
        }
      });

    if (!message || !message.conversationId) {
      return res.status(404).json({
        success: false,
        message: 'Mensaje no encontrado'
      });
    }

    message.status = 'deleted';
    await message.save();

    // Actualizar metadatos de la conversación
    await message.conversationId.updateStats();

    res.json({
      success: true,
      message: 'Mensaje eliminado exitosamente'
    });
  } catch (error) {
    console.error('Error eliminando mensaje:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Marcar mensaje como leído
export const markMessageAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email;

    const message = await Message.findById(id)
      .populate({
        path: 'conversationId',
        match: {
          $or: [
            { createdBy: userEmail },
            { 'stats.participants.email': userEmail }
          ]
        }
      });

    if (!message || !message.conversationId) {
      return res.status(404).json({
        success: false,
        message: 'Mensaje no encontrado'
      });
    }

    await message.markAsRead();

    res.json({
      success: true,
      data: message,
      message: 'Mensaje marcado como leído'
    });
  } catch (error) {
    console.error('Error marcando mensaje como leído:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Buscar mensajes
export const searchMessages = async (req, res) => {
  try {
    const { q, conversationId, role, page = 1, limit = 20 } = req.query;
    const userId = req.user.id;

    const filter = { status: { $ne: 'deleted' } };

    if (conversationId) {
      // Verificar que la conversación pertenece al usuario
      const conversation = await Conversation.findOne({ _id: conversationId, userId });
      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: 'Conversación no encontrada'
        });
      }
      filter.conversationId = conversationId;
    } else {
      // Si no se especifica conversación, buscar en todas las conversaciones del usuario
      const userConversations = await Conversation.find({ userId }).distinct('_id');
      filter.conversationId = { $in: userConversations };
    }

    if (q) {
      filter.content = { $regex: q, $options: 'i' };
    }

    if (role) {
      filter.role = role;
    }

    const skip = (page - 1) * limit;

    const messages = await Message.find(filter)
      .populate('conversationId', 'title workspaceId')
      .populate('workspaceId', 'name color')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Message.countDocuments(filter);

    res.json({
      success: true,
      data: messages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error buscando mensajes:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Obtener estadísticas de mensajes
export const getMessageStats = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    // Verificar que la conversación existe y pertenece al usuario
    const conversation = await Conversation.findOne({ _id: conversationId, userId });
    if (!conversation) {
      return res.status(404).json({
        success: false,
        message: 'Conversación no encontrada'
      });
    }

    const stats = await Message.aggregate([
      {
        $match: {
          conversationId: conversation._id,
          status: { $ne: 'deleted' }
        }
      },
      {
        $group: {
          _id: null,
          totalMessages: { $sum: 1 },
          totalTokens: { $sum: '$metadata.tokens' },
          avgProcessingTime: { $avg: '$metadata.processingTime' },
          userMessages: {
            $sum: { $cond: [{ $eq: ['$role', 'user'] }, 1, 0] }
          },
          assistantMessages: {
            $sum: { $cond: [{ $eq: ['$role', 'assistant'] }, 1, 0] }
          }
        }
      }
    ]);

    const result = stats[0] || {
      totalMessages: 0,
      totalTokens: 0,
      avgProcessingTime: 0,
      userMessages: 0,
      assistantMessages: 0
    };

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas de mensajes:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

// Eliminar todos los mensajes posteriores a un mensaje específico (bot Y usuario)
export const deleteMessagesAfter = async (req, res) => {
  try {
    const { conversationId, messageId } = req.params;
    const userEmail = req.user.email;

    // Verificar que la conversación pertenece al usuario
    const conversation = await Conversation.findOne({
      _id: conversationId,
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

    // Obtener el mensaje de referencia para obtener su timestamp
    const referenceMessage = await Message.findById(messageId);
    if (!referenceMessage) {
      return res.status(404).json({
        success: false,
        message: 'Mensaje de referencia no encontrado'
      });
    }

    // Eliminar TODOS los mensajes posteriores al mensaje de referencia (bot Y usuario)
    const result = await Message.deleteMany({
      conversationId: conversationId,
      createdAt: { $gt: referenceMessage.createdAt }
    });

    res.json({
      success: true,
      message: 'Mensajes posteriores eliminados correctamente',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error eliminando mensajes posteriores:', error);
    res.status(500).json({
      success: false,
      message: 'Error del servidor'
    });
  }
};
