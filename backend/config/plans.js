export const plans = [
  {
    name: "Explora",
    key: "free",
    price: 0,
    api: "openrouter",
    limits: {
      dailyResponses: 20,
      histories: 1,
      advancedSettings: false,
    }
  },
  {
    name: "Estudiante Pro",
    key: "pro",
    price: 3.99,
    api: "openai",
    limits: {
      monthlyResponses: 150,
      histories: 10,
      advancedSettings: true,
      darkMode: true,
    }
  },
  {
    name: "Investigador",
    key: "advanced",
    price: 7.99,
    api: "openai-gpt4-turbo",
    limits: {
      monthlyResponses: 500,
      histories: 30,
      advancedSettings: true,
      pdf: true,
      resumen: true,
      traduccion: true,
      explicacion: true,
    }
  },
  {
    name: "Ilimitado",
    key: "premium",
    price: 14.99,
    api: "openai-gpt4-multi",
    limits: {
      unlimited: true,
      histories: 'all',
      advancedSettings: true,
      multiDevice: true,
      prioritySupport: true,
      productivityTools: true,
    }
  }
]; 