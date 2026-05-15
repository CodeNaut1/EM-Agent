require('dotenv').config();
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
        pubkey: 'em-agent-' + Date.now(),
        display_name: 'EM Agent (Z)'
      })
    });
    const data = await res.json();
    console.log('FULL REGISTRATION RESPONSE:', JSON.stringify(data, null, 2));
    return data;
  }

// --- Brain ---

const SYSTEM_PROMPT = `You are EM Agent, the personal AI assistant for EM — a Software Developer at African Bitcoiners (bitcoiners.africa).

You are EM's turbo button — a confident, sharp assistant for everything: work, coding challenges, research, writing, brainstorming, planning, and building.

About EM's work:
- EM is a Software Engineer at African Bitcoiners, a Bitcoin education platform for Africa and she is the tech lead there
- Tech stack: WordPress, React, Next.js, Node.js, Prisma, PostgreSQL
- EM works with teammates including Sarah, Satoshee, Megasley, Lys, and others

You also have a skill to search ZapAds (zapads.ai), a Lightning-powered marketplace for AI services. But ONLY mention or use ZapAds when EM specifically asks about it. Otherwise, you are a general-purpose assistant.

Personality:
- Confident but humble — you know your stuff but you don't show off
- Concise, practical, action-oriented
- Casual and friendly — light humour is fine
- Never over-explain unless asked
- When introducing yourself, keep it short and sharp — no need to list every capability`;



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

    let userMessage = '';
    const isMentioned = message.mentions.has(client.user);
    const isReply = message.reference && message.reference.messageId;
    const hasPrefix = message.content.startsWith('!em');
    
    if (hasPrefix) {
      userMessage = message.content.slice(3).trim();
    } else if (isMentioned) {
      userMessage = message.content.replace(/<@!?\d+>/g, '').trim();
    } else if (isReply) {
      // Check if replying to the bot's message
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedMsg.author.id !== client.user.id) return;
      userMessage = message.content.trim();
    } else {
      return;
    }
    
    if (!userMessage) return;

  try {
    await message.channel.sendTyping();

    // Handle ZapAds registration command
    if (userMessage.toLowerCase().includes('register on zapads')) {
        if (process.env.ZAPADS_AGENT_KEY && process.env.ZAPADS_AGENT_KEY.length > 5) {
          await message.reply('Already registered on ZapAds ✅ Agent key is loaded.');
          return;
        }
        try {
          const reg = await registerAgent();
          const response = JSON.stringify(reg, null, 2);
          await message.reply(
            `Registered on ZapAds! 🎉\n\nFull response:\n\`\`\`json\n${response}\n\`\`\`\n\n⚠️ **Copy the api_key NOW — shown only once!**\nAdd it as \`ZAPADS_AGENT_KEY\` in your env variables, then restart me.`
          );
        } catch (err) {
          await message.reply(`Registration failed: ${err.message}`);
        }
        return;
      }

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