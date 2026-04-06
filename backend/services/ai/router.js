import CloudProvider from './providers/CloudProvider.js';
import LocalProvider from './providers/LocalProvider.js';
import { getUserSelectedLocalModel, resolveUserPlan, hasLicenseForLocalModel } from '../models/userModelPrefs.js';

const cloud = new CloudProvider({});
const local = new LocalProvider({});

export async function sendChatRouted({ userId, messages, options = {} }) {
  const override = (options && options.overrideModel) ? String(options.overrideModel) : '';
  if (override) {
    if (override.toLowerCase().startsWith('cloud:')) {
      const cloudModel = override.split(':').slice(1).join(':') || undefined;
      return cloud.sendChat(messages, { ...options, model: cloudModel });
    } else {
      try {
        return await local.sendChat(messages, { ...options, model: override });
      } catch (e) {
        // Si el local falla, intentar cloud si hay API key
        if (process.env.OPENAI_API_KEY) {
          return cloud.sendChat(messages, options);
        }
        throw e;
      }
    }
  }
  // Decide provider based on plan and user selection
  const plan = await resolveUserPlan(userId); // 'free' | 'pro' | ...
  const userLocalModel = await getUserSelectedLocalModel(userId);
  if (userLocalModel === '__cloud__') {
    // Forzar cloud
    if (process.env.OPENAI_API_KEY) {
      return cloud.sendChat(messages, options);
      return cloud.sendChat(messages, options);
    }
  }
  const prefersLocal = plan === 'free' || (!!userLocalModel && userLocalModel !== '__cloud__');

  const model = userLocalModel || (plan === 'free' ? 'llm-mini' : null);

  if (prefersLocal) {
    try {
      if (model && (model === 'llm-mini' || await hasLicenseForLocalModel(userId, model))) {
        const result = await local.sendChat(messages, { ...options, model });
        if (result && result.content) return result;
      }
    } catch (e) {
      // Fall back below
    }
  }

  // Fallback to cloud cuando haya API key disponible, incluso en free (desarrollo/admin/override)
  if (process.env.OPENAI_API_KEY) {
    const result = await cloud.sendChat(messages, options);
    return result;
  }

  const err = new Error('No hay proveedor de IA disponible');
  err.code = 'NO_PROVIDER';
  throw err;
}


