try { require('dotenv').config(); } catch (e) { }
const { Client, GatewayIntentBits } = require('discord.js');
const OpenAI = require('openai');
const http = require('http');

http.createServer((req, res) => res.end('EM Agent running')).listen(process.env.PORT || 3000);

// DeepSeek uses OpenAI-compatible API
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com'
});

const ZAPADS_API = 'https://zap-ads-web.vercel.app/api/v1';
const BLINK_API = 'https://api.blink.sv/graphql';

// ==========================================
// BLINK LIGHTNING PAYMENT FUNCTIONS
// ==========================================

async function payLightningInvoice(bolt11Invoice) {
  const query = `
    mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
      lnInvoicePaymentSend(input: $input) {
        status
        errors {
          message
        }
      }
    }
  `;

  const res = await fetch(BLINK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.BLINK_API_KEY
    },
    body: JSON.stringify({
      query,
      variables: {
        input: {
          paymentRequest: bolt11Invoice
        }
      }
    })
  });

  const data = await res.json();
  console.log('BLINK PAYMENT RESPONSE:', JSON.stringify(data, null, 2));

  if (data.errors) {
    throw new Error(data.errors[0].message);
  }

  const result = data.data.lnInvoicePaymentSend;
  if (result.errors && result.errors.length > 0) {
    throw new Error(result.errors[0].message);
  }

  return result;
}

async function getPaymentPreimage(paymentHash) {
  const query = `
    query GetTransactions($first: Int) {
      me {
        defaultAccount {
          transactions(first: $first) {
            edges {
              node {
                initiationVia {
                  ... on InitiationViaLn {
                    paymentHash
                  }
                }
                settlementVia {
                  ... on SettlementViaLn {
                    preImage
                  }
                  ... on SettlementViaIntraLedger {
                    preImage
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch(BLINK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.BLINK_API_KEY
    },
    body: JSON.stringify({
      query,
      variables: { first: 5 }
    })
  });

  const data = await res.json();
  const transactions = data.data.me.defaultAccount.transactions.edges;

  for (const edge of transactions) {
    const node = edge.node;
    if (node.initiationVia.paymentHash === paymentHash) {
      return node.settlementVia.preImage;
    }
  }

  return null;
}

async function getWalletBalance() {
  const query = `
    query Me {
      me {
        defaultAccount {
          wallets {
            walletCurrency
            balance
          }
        }
      }
    }
  `;

  const res = await fetch(BLINK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.BLINK_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const data = await res.json();
  return data.data.me.defaultAccount.wallets;
}

// ==========================================
// ZAP ADS TOOL FUNCTIONS
// ==========================================

const zapadsTools = {
  async discoverServices(query = '') {
    const url = query
      ? `${ZAPADS_API}/services?q=${encodeURIComponent(query)}`
      : `${ZAPADS_API}/services`;
    const res = await fetch(url, {
      headers: process.env.ZAPADS_AGENT_KEY
        ? { Authorization: `Bearer ${process.env.ZAPADS_AGENT_KEY}` }
        : {}
    });
    const data = await res.json();
    return data.data || [];
  },

  async getServiceDetails(serviceId) {
    const res = await fetch(`${ZAPADS_API}/services/${serviceId}`);
    return await res.json();
  },

  async getCategories() {
    const res = await fetch(`${ZAPADS_API}/categories`);
    return await res.json();
  },

  async registerAgent(displayName) {
    const res = await fetch(`${ZAPADS_API}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubkey: 'em-agent-' + Date.now(),
        display_name: displayName || 'EM Agent (Z)'
      })
    });
    return await res.json();
  },

  async registerProvider(displayName, lightningAddress) {
    const res = await fetch(`${ZAPADS_API}/providers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubkey: 'em-provider-' + Date.now(),
        display_name: displayName,
        lightning_address: lightningAddress
      })
    });
    return await res.json();
  },

  async listService(serviceData) {
    const res = await fetch(`${ZAPADS_API}/services`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ZAPADS_PROVIDER_KEY}`
      },
      body: JSON.stringify(serviceData)
    });
    return await res.json();
  },

  async getProviderProfile() {
    const res = await fetch(`${ZAPADS_API}/providers/me`, {
      headers: { 'Authorization': `Bearer ${process.env.ZAPADS_PROVIDER_KEY}` }
    });
    return await res.json();
  },

  async updateProviderProfile(displayName) {
    const res = await fetch(`${ZAPADS_API}/providers/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ZAPADS_PROVIDER_KEY}`
      },
      body: JSON.stringify({ display_name: displayName })
    });
    return await res.json();
  },

  async getMyServices() {
    const res = await fetch(`${ZAPADS_API}/services/me`, {
      headers: { 'Authorization': `Bearer ${process.env.ZAPADS_PROVIDER_KEY}` }
    });
    return await res.json();
  },

  async verifyLightningAddress(address) {
    const res = await fetch(`${ZAPADS_API}/providers/me/lightning-address`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ZAPADS_PROVIDER_KEY}`
      },
      body: JSON.stringify({ lightning_address: address })
    });
    return await res.json();
  },

  async callService(proxyUrl) {
    if (!process.env.BLINK_API_KEY) {
      return { error: 'No Blink API key configured. Add BLINK_API_KEY to env variables.' };
    }

    console.log(`Calling service: ${proxyUrl}`);
    const firstTry = await fetch(proxyUrl);

    if (firstTry.status === 402) {
      const authHeader = firstTry.headers.get('www-authenticate');
      if (!authHeader) {
        return { error: 'Got 402 but no WWW-Authenticate header', status: 402 };
      }

      console.log('L402 Challenge:', authHeader);

      const macaroonMatch = authHeader.match(/macaroon="([^"]+)"/);
      const invoiceMatch = authHeader.match(/invoice="([^"]+)"/);

      if (!macaroonMatch || !invoiceMatch) {
        return { error: 'Could not parse L402 challenge', raw_header: authHeader.substring(0, 300) };
      }

      const macaroon = macaroonMatch[1];
      const invoice = invoiceMatch[1];

      try {
        console.log('Paying invoice via Blink...');
        const payment = await payLightningInvoice(invoice);
        console.log('Payment status:', payment.status);

        if (payment.status !== 'SUCCESS' && payment.status !== 'ALREADY_PAID') {
          return { error: `Payment status: ${payment.status}`, details: payment };
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        const { decode } = require('light-bolt11-decoder');
        const decoded = decode(invoice);
        const paymentHashSection = decoded.sections.find(s => s.name === 'payment_hash');
        const paymentHash = paymentHashSection ? paymentHashSection.value : null;

        let preimage = null;
        if (paymentHash) {
          preimage = await getPaymentPreimage(paymentHash);
        }

        if (!preimage) {
          return {
            success: false,
            error: 'Payment sent but could not retrieve preimage yet.',
            payment_status: payment.status
          };
        }

        console.log('Retrying with L402 auth...');
        const secondTry = await fetch(proxyUrl, {
          headers: { 'Authorization': `L402 ${macaroon}:${preimage}` }
        });

        if (secondTry.ok) {
          const contentType = secondTry.headers.get('content-type');
          let result;
          if (contentType && contentType.includes('application/json')) {
            result = await secondTry.json();
          } else {
            result = await secondTry.text();
          }
          return { success: true, data: result, payment_status: 'paid' };
        } else {
          return { error: `Retry failed with status ${secondTry.status}`, payment_status: 'paid_but_retry_failed' };
        }
      } catch (payErr) {
        return { error: `Payment failed: ${payErr.message}` };
      }

    } else if (firstTry.ok) {
      const contentType = firstTry.headers.get('content-type');
      let result;
      if (contentType && contentType.includes('application/json')) {
        result = await firstTry.json();
      } else {
        result = await firstTry.text();
      }
      return { success: true, data: result, payment_status: 'free' };

    } else {
      const body = await firstTry.text();
      return { error: `Unexpected status: ${firstTry.status}`, body: body.substring(0, 200) };
    }
  },

  async checkBalance() {
    const wallets = await getWalletBalance();
    return wallets.map(w => ({
      currency: w.walletCurrency,
      balance: w.balance
    }));
  }
};

// ==========================================
// TOOL DEFINITIONS FOR THE AI BRAIN
// ==========================================

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'discover_services',
      description: 'Search and discover services listed on the ZapAds marketplace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional search query to filter services' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'register_agent',
      description: 'Register a new agent on ZapAds.',
      parameters: {
        type: 'object',
        properties: {
          display_name: { type: 'string', description: 'Display name for the agent' }
        },
        required: ['display_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'register_provider',
      description: 'Register as a service provider on ZapAds. Requires a display name and Lightning address.',
      parameters: {
        type: 'object',
        properties: {
          display_name: { type: 'string', description: 'Display name for the provider' },
          lightning_address: { type: 'string', description: 'Lightning address for receiving payments' }
        },
        required: ['display_name', 'lightning_address']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_service',
      description: 'List a new service on ZapAds marketplace. Ask the user for all required fields if not provided.',
      parameters: {
        type: 'object',
        properties: {
          service_id: { type: 'string', description: 'Unique slug identifier' },
          name: { type: 'string', description: 'Display name of the service' },
          description: { type: 'string', description: 'What the service does' },
          endpoint: { type: 'string', description: 'The URL of the actual API endpoint' },
          price_sats: { type: 'number', description: 'Price per call in satoshis (minimum 10)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for discoverability' },
          category: { type: 'string', description: 'Service category' }
        },
        required: ['service_id', 'name', 'description', 'endpoint', 'price_sats', 'category']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_provider_profile',
      description: 'Get the current provider profile, balance, and stats from ZapAds.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_provider_profile',
      description: 'Update the provider profile on ZapAds (e.g. change display name).',
      parameters: {
        type: 'object',
        properties: {
          display_name: { type: 'string', description: 'New display name for the provider' }
        },
        required: ['display_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_my_services',
      description: 'List all services owned by the current provider.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'verify_lightning_address',
      description: 'Verify a Lightning address for the provider account.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Lightning address to verify' }
        },
        required: ['address']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'call_service',
      description: 'Call/use/buy/test a service from ZapAds. Handles the full L402 payment flow — makes the request, pays the Lightning invoice via Blink wallet, and returns the result. Use when the user wants to USE, BUY, TEST, or PURCHASE a service.',
      parameters: {
        type: 'object',
        properties: {
          proxy_url: { type: 'string', description: 'The endpoint URL of the service to call' }
        },
        required: ['proxy_url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_balance',
      description: 'Check the current Lightning wallet balance (Blink). Use when user asks about wallet balance, how many sats they have, or before making a purchase.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// ==========================================
// TOOL EXECUTOR
// ==========================================

async function executeTool(name, args) {
  switch (name) {
    case 'discover_services':
      return await zapadsTools.discoverServices(args.query || '');
    case 'register_agent':
      return await zapadsTools.registerAgent(args.display_name);
    case 'register_provider':
      return await zapadsTools.registerProvider(args.display_name, args.lightning_address);
    case 'update_provider_profile':
      return await zapadsTools.updateProviderProfile(args.display_name);
    case 'list_service':
      return await zapadsTools.listService({
        service_id: args.service_id,
        name: args.name,
        description: args.description,
        endpoint: args.endpoint,
        price_sats: args.price_sats,
        tags: args.tags || [],
        category: args.category
      });
    case 'get_provider_profile':
      return await zapadsTools.getProviderProfile();
    case 'get_my_services':
      return await zapadsTools.getMyServices();
    case 'verify_lightning_address':
      return await zapadsTools.verifyLightningAddress(args.address);
    case 'call_service':
      return await zapadsTools.callService(args.proxy_url);
    case 'check_balance':
      return await zapadsTools.checkBalance();
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ==========================================
// BRAIN (with tool use)
// ==========================================

const SYSTEM_PROMPT = `You are Z, the personal AI assistant for EM — a Software Engineer and tech lead at African Bitcoiners (bitcoiners.africa).

You are EM's turbo button — a confident, sharp assistant for everything: work, coding challenges, research, writing, brainstorming, planning, and building.

About EM's work:
- EM is a Software Engineer at African Bitcoiners, a Bitcoin education platform for Africa
- She is the tech lead handling website and infrastructure
- Tech stack: WordPress, React, Next.js, Node.js, Prisma, PostgreSQL
- EM works with teammates including Sarah, Satoshee, Megasley, Lys, and others
- The team recently launched ZapAds (zapads.ai), an agentic marketplace powered by Lightning

You have tools to interact with the ZapAds marketplace — discovering services, registering as agent/provider, listing services, checking your profile and balance, and CALLING/BUYING services using Lightning payments via Blink wallet.

When the user wants to buy/use/test a service:
1. First discover available services if they haven't specified one
2. Show them the options with prices
3. When they choose, use the call_service tool with the service's endpoint URL
4. Report the result back clearly

You can also check the wallet balance before making purchases.

Use these tools when relevant, but ONLY when the conversation is about ZapAds. Otherwise you are a general-purpose assistant.

When listing a service, if the user doesn't provide all required fields, ASK them interactively — don't make up values.

When showing tool results, format them nicely for Discord. Use tables or clean lists.

Personality:
- Confident but humble — you know your stuff but you don't show off
- Concise, practical, action-oriented
- Casual and friendly — light humour when appropriate
- Never over-explain unless asked
- When introducing yourself, keep it short and sharp`;

async function askBrain(userMessage, conversationHistory = []) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: 'user', content: userMessage }
  ];

  let response = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages,
    tools: TOOLS,
    max_tokens: 1500
  });

  let assistantMessage = response.choices[0].message;

  if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);

      console.log(`Tool called: ${toolName}`, toolArgs);

      let toolResult;
      try {
        toolResult = await executeTool(toolName, toolArgs);
      } catch (err) {
        toolResult = { error: err.message };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult, null, 2)
      });
    }

    response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages,
      max_tokens: 1500
    });

    assistantMessage = response.choices[0].message;
  }

  return assistantMessage.content;
}

// ==========================================
// DISCORD BOT
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const channelHistory = new Map();
const MAX_HISTORY = 10;

function getHistory(channelId) {
  return channelHistory.get(channelId) || [];
}

function addToHistory(channelId, role, content) {
  const history = getHistory(channelId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY * 2) {
    history.splice(0, 2);
  }
  channelHistory.set(channelId, history);
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  let userMessage = '';
  const isMentioned = message.mentions.has(client.user);
  const isReply = message.reference && message.reference.messageId;
  const hasPrefix = message.content.startsWith('!em');

  if (hasPrefix) {
    userMessage = message.content.slice(3).trim();
  } else if (isMentioned) {
    userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
  } else if (isReply) {
    const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
    if (repliedMsg.author.id !== client.user.id) return;
    userMessage = message.content.trim();
  } else {
    return;
  }

  if (!userMessage) return;

  try {
    await message.channel.sendTyping();

    const history = getHistory(message.channelId);
    const reply = await askBrain(userMessage, history);

    addToHistory(message.channelId, 'user', userMessage);
    addToHistory(message.channelId, 'assistant', reply);

    if (reply.length > 2000) {
      const chunks = reply.match(/[\s\S]{1,2000}/g);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(reply);
    }

  } catch (error) {
    console.error('FULL ERROR:', error);
    console.error('ERROR MESSAGE:', error.message);
    await message.reply(`Error: ${error.message}`);
  }
});

client.once('ready', () => {
  console.log(`Z is online as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);