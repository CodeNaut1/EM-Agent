require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const OpenAI = require('openai');

// DeepSeek uses OpenAI-compatible API
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com'
});

const ZAPADS_API = 'https://zap-ads-web.vercel.app/api/v1';

// --- Zap Ads Functions ---

async function discoverServices(query = '') {
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
}

async function getServiceDetails(serviceId) {
  const res = await fetch(`${ZAPADS_API}/services/${serviceId}`);
  return await res.json();
}

async function registerAgent() {
  const res = await fetch(`${ZAPADS_API}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pubkey: 'em-agent-001',
      display_name: 'EM Agent'
    })
  });
  const data = await res.json();
  return data;
}

// --- Brain ---

const SYSTEM_PROMPT = `You are EM Agent, a helpful AI assistant for EM from African Bitcoiners.
You have access to ZapAds, a Lightning-powered marketplace for AI services.

When the user asks you to find or discover services, use the search results provided to give a clear summary.
When asked about yourself, explain you are EM's personal agent connected to the ZapAds marketplace.

Format service listings in a clean table when possible.
Be concise and friendly. Use plain language.`;

async function askBrain(userMessage, context = '') {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  if (context) {
    messages.push({
      role: 'system',
      content: `Here is relevant data from ZapAds:\n${context}`
    });
  }

  messages.push({ role: 'user', content: userMessage });

  const response = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages,
    max_tokens: 1000
  });

  return response.choices[0].message.content;
}

// --- Discord Bot ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const BOT_PREFIX = '!em';

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(BOT_PREFIX)) return;

  const userMessage = message.content.slice(BOT_PREFIX.length).trim();
  if (!userMessage) return;

  try {
    await message.channel.sendTyping();

    let context = '';

    // Check if user wants to discover/find/list services
    const searchWords = ['services', 'find', 'discover', 'list', 'search', 'what', 'show', 'available'];
    const isSearching = searchWords.some(w =>
      userMessage.toLowerCase().includes(w)
    );

    if (isSearching) {
      const services = await discoverServices();
      context = JSON.stringify(services, null, 2);
    }

    const reply = await askBrain(userMessage, context);

    // Discord has 2000 char limit
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
  console.log(`EM Agent is online as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);