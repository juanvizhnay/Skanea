import subscriptionModel from '../models/subscription.js';

export const getMySubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    const subscription = await subscriptionModel.getSubscriptionByUserId(userId);
    if (!subscription) {
      return res.status(404).json({ message: 'No tienes suscripción activa.' });
    }
    res.json({ subscription });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener la suscripción.', error: err.message });
  }
};

export const createOrUpdateMySubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan, status, stripe_subscription_id, start_date, end_date } = req.body;
    if (!plan || !status) {
      return res.status(400).json({ message: 'Plan y status son requeridos.' });
    }
    const subscription = await subscriptionModel.createOrUpdateSubscription(
      userId,
      plan,
      status,
      stripe_subscription_id || null,
      start_date || new Date(),
      end_date || null
    );
    res.json({ message: 'Suscripción actualizada.', subscription });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar la suscripción.', error: err.message });
  }
}; 