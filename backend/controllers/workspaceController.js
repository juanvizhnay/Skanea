import Workspace from '../models/workspace.js';
import Conversation from '../models/conversation.js';
import Message from '../models/message.js';

// Crear un nuevo workspace
export const createWorkspace = async (req, res) => {
  try {
    const { name, description, tags, settings } = req.body;
    const userEmail = req.user.email;

    // Validar que el usuario esté autenticado
    if (!userEmail) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    // Crear el workspace
    const workspace = new Workspace({
      name,
      description: description || '',
      owner: userEmail,
      tags: tags || [],
      settings: settings || {}
    });

    await workspace.save();

    res.status(201).json({
      message: 'Workspace creado exitosamente',
      workspace
    });
  } catch (error) {
    console.error('Error creando workspace:', error);
    res.status(500).json({ 
      message: 'Error al crear el workspace',
      error: error.message 
    });
  }
};

// Obtener todos los workspaces del usuario
export const getWorkspaces = async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { archived, search } = req.query;

    let query = {
      $or: [
        { owner: userEmail },
        { 'collaborators.email': userEmail }
      ]
    };

    // Filtrar por estado archivado
    if (archived !== undefined) {
      query.isArchived = archived === 'true';
    }

    // Búsqueda por nombre o descripción
    if (search) {
      query.$and = [{
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ]
      }];
    }

    const workspaces = await Workspace.find(query)
      .sort({ updatedAt: -1 })
      .populate('conversations', 'title stats.lastMessageAt')
      .lean();

    res.json({
      success: true,
      data: workspaces,
      total: workspaces.length
    });
  } catch (error) {
    // Si es un problema de selección de servidor/timeout, devolver 503 temporal
    const isNet = /Mongo(ServerSelection|Network)Error|ECONNREFUSED|ETIMEDOUT/i.test(String(error?.name || '') + ' ' + String(error?.message || ''));
    if (isNet) {
      return res.status(503).json({ message: 'Servicio de base de datos no disponible. Intenta nuevamente en unos segundos.' });
    }
    return res.status(500).json({ message: 'Error al obtener los workspaces' });
  }
};

// Obtener un workspace específico
export const getWorkspace = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email;

    const workspace = await Workspace.findById(id)
      .populate('conversations', 'title description stats settings')
      .lean();

    if (!workspace) {
      return res.status(404).json({ message: 'Workspace no encontrado' });
    }

    // Verificar permisos
    if (!workspace.hasPermission(userEmail, 'viewer')) {
      return res.status(403).json({ message: 'No tienes permisos para ver este workspace' });
    }

    res.json({
      message: 'Workspace obtenido exitosamente',
      workspace
    });
  } catch (error) {
    console.error('Error obteniendo workspace:', error);
    res.status(500).json({ 
      message: 'Error al obtener el workspace',
      error: error.message 
    });
  }
};

// Actualizar un workspace
export const updateWorkspace = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, tags, settings } = req.body;
    const userEmail = req.user.email;

    const workspace = await Workspace.findById(id);

    if (!workspace) {
      return res.status(404).json({ message: 'Workspace no encontrado' });
    }

    // Verificar permisos (solo owner o admin puede editar)
    if (!workspace.hasPermission(userEmail, 'admin')) {
      return res.status(403).json({ message: 'No tienes permisos para editar este workspace' });
    }

    // Actualizar campos
    if (name !== undefined) workspace.name = name;
    if (description !== undefined) workspace.description = description;
    if (tags !== undefined) workspace.tags = tags;
    if (settings !== undefined) workspace.settings = { ...workspace.settings, ...settings };

    await workspace.save();

    res.json({
      message: 'Workspace actualizado exitosamente',
      workspace
    });
  } catch (error) {
    console.error('Error actualizando workspace:', error);
    res.status(500).json({ 
      message: 'Error al actualizar el workspace',
      error: error.message 
    });
  }
};

// Eliminar un workspace
export const deleteWorkspace = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email;

    const workspace = await Workspace.findById(id);

    if (!workspace) {
      return res.status(404).json({ message: 'Workspace no encontrado' });
    }

    // Solo el owner puede eliminar
    if (workspace.owner !== userEmail) {
      return res.status(403).json({ message: 'Solo el propietario puede eliminar el workspace' });
    }

    // Eliminar conversaciones y mensajes asociados
    await Conversation.deleteMany({ workspaceId: id });
    await Message.deleteMany({ workspaceId: id });

    // Eliminar el workspace
    await workspace.deleteOne();

    res.json({ message: 'Workspace eliminado exitosamente' });
  } catch (error) {
    console.error('Error eliminando workspace:', error);
    res.status(500).json({ 
      message: 'Error al eliminar el workspace',
      error: error.message 
    });
  }
};

// Agregar colaborador
export const addCollaborator = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role } = req.body;
    const userEmail = req.user.email;

    const workspace = await Workspace.findById(id);

    if (!workspace) {
      return res.status(404).json({ message: 'Workspace no encontrado' });
    }

    // Solo el owner puede agregar colaboradores
    if (workspace.owner !== userEmail) {
      return res.status(403).json({ message: 'Solo el propietario puede agregar colaboradores' });
    }

    // No agregar al owner como colaborador
    if (email === workspace.owner) {
      return res.status(400).json({ message: 'El propietario ya es miembro del workspace' });
    }

    await workspace.addCollaborator(email, role || 'viewer');

    res.json({
      message: 'Colaborador agregado exitosamente',
      workspace
    });
  } catch (error) {
    console.error('Error agregando colaborador:', error);
    res.status(500).json({ 
      message: 'Error al agregar colaborador',
      error: error.message 
    });
  }
};

// Remover colaborador
export const removeCollaborator = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    const userEmail = req.user.email;

    const workspace = await Workspace.findById(id);

    if (!workspace) {
      return res.status(404).json({ message: 'Workspace no encontrado' });
    }

    // Solo el owner puede remover colaboradores
    if (workspace.owner !== userEmail) {
      return res.status(403).json({ message: 'Solo el propietario puede remover colaboradores' });
    }

    await workspace.removeCollaborator(email);

    res.json({
      message: 'Colaborador removido exitosamente',
      workspace
    });
  } catch (error) {
    console.error('Error removiendo colaborador:', error);
    res.status(500).json({ 
      message: 'Error al remover colaborador',
      error: error.message 
    });
  }
};

// Obtener estadísticas del workspace
export const getWorkspaceStats = async (req, res) => {
  try {
    const { id } = req.params;
    const userEmail = req.user.email;

    const workspace = await Workspace.findById(id);

    if (!workspace) {
      return res.status(404).json({ message: 'Workspace no encontrado' });
    }

    // Verificar permisos
    if (!workspace.hasPermission(userEmail, 'viewer')) {
      return res.status(403).json({ message: 'No tienes permisos para ver este workspace' });
    }

    // Actualizar estadísticas
    await workspace.updateStats();

    // Obtener estadísticas adicionales
    const conversationStats = await Conversation.aggregate([
      { $match: { workspaceId: workspace._id } },
      {
        $group: {
          _id: null,
          totalConversations: { $sum: 1 },
          activeConversations: { $sum: { $cond: [{ $eq: ['$settings.isArchived', false] }, 1, 0] } },
          pinnedConversations: { $sum: { $cond: [{ $eq: ['$settings.isPinned', true] }, 1, 0] } }
        }
      }
    ]);

    const messageStats = await Message.aggregate([
      { $match: { workspaceId: workspace._id } },
      {
        $group: {
          _id: null,
          totalMessages: { $sum: 1 },
          totalTokens: { $sum: '$metadata.tokens' },
          avgResponseTime: { $avg: '$metadata.responseTime' }
        }
      }
    ]);

    const stats = {
      workspace: workspace.stats,
      conversations: conversationStats[0] || {
        totalConversations: 0,
        activeConversations: 0,
        pinnedConversations: 0
      },
      messages: messageStats[0] || {
        totalMessages: 0,
        totalTokens: 0,
        avgResponseTime: 0
      }
    };

    res.json({
      message: 'Estadísticas obtenidas exitosamente',
      stats
    });
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ 
      message: 'Error al obtener estadísticas',
      error: error.message 
    });
  }
};

// Buscar workspaces
export const searchWorkspaces = async (req, res) => {
  try {
    const { q } = req.query;
    const userEmail = req.user.email;

    if (!q) {
      return res.status(400).json({ message: 'Query de búsqueda requerida' });
    }

    const query = {
      $or: [
        { owner: userEmail },
        { 'collaborators.email': userEmail }
      ],
      $and: [{
        $or: [
          { name: { $regex: q, $options: 'i' } },
          { description: { $regex: q, $options: 'i' } },
          { tags: { $in: [new RegExp(q, 'i')] } }
        ]
      }]
    };

    const workspaces = await Workspace.find(query)
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();

    res.json({
      message: 'Búsqueda completada',
      workspaces,
      total: workspaces.length
    });
  } catch (error) {
    console.error('Error buscando workspaces:', error);
    res.status(500).json({ 
      message: 'Error en la búsqueda',
      error: error.message 
    });
  }
}; 