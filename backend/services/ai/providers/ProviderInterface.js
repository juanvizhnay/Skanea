export default class ProviderInterface {
  // messages: [{ role: 'system'|'user'|'assistant', content: string }]
  // options: { userId?: string|null, model?: string|null, temperature?: number }
  // must return: { content: string }
  async sendChat(messages, options = {}) {
    throw new Error('sendChat not implemented');
  }
}


