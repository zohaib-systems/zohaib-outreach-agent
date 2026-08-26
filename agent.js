
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Store recent log lines in memory
const logHistory = [];

// Intercept standard console output to stream to frontend
const originalLog = console.log;
const originalError = console.error;

function captureLog(type, args) {
  const message = `[${new Date().toLocaleTimeString()}] [${type.toUpperCase()}] ` + 
    args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
  
  logHistory.push(message);
  if (logHistory.length > 100) logHistory.shift(); // Keep last 100 lines
  
  io.emit('new-log', message);
}

console.log = (...args) => { originalLog.apply(console, args); captureLog('info', args); };
console.error = (...args) => { originalError.apply(console, args); captureLog('error', args); };

// Web UI Route
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Outreach Agent Live Logs</title>
      <script src="/socket.io/socket.io.js"></script>
      <style>
        body { background: #0d1117; color: #58a6ff; font-family: monospace; padding: 20px; }
        h2 { color: #f0f6fc; margin-bottom: 10px; }
        #logs { background: #161b22; border: 1px solid #30363d; padding: 15px; border-radius: 6px; height: 70vh; overflow-y: auto; white-space: pre-wrap; }
        .log-entry { margin-bottom: 4px; border-bottom: 1px solid #21262d; padding-bottom: 2px; }
      </style>
    </head>
    <body>
      <h2>🤖 Zohaib Outreach Agent — Live Terminal Stream</h2>
      <div id="logs"></div>
      <script>
        const socket = io();
        const logsDiv = document.getElementById('logs');
        
        socket.on('connect', () => { logsDiv.innerHTML += '<div class="log-entry" style="color:#7ee787;">[CONNECTED TO AGENT STREAM]</div>'; });
        socket.on('new-log', (msg) => {
          const entry = document.createElement('div');
          entry.className = 'log-entry';
          entry.textContent = msg;
          logsDiv.appendChild(entry);
          logsDiv.scrollTop = logsDiv.scrollHeight;
        });
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Log Web UI running on port ${PORT}`));


require('dotenv').config();
const { google } = require('googleapis');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');

// Initialize Discord Client
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Initialize Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// OpenRouter LLM Request Helper
async function generateLLMResponse(prompt) {
  const models = [...new Set([
    process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    process.env.OPENROUTER_FALLBACK_MODEL || 'minimax/minimax-m3:free'
  ])];
  let lastError;

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model,
            messages: [{ role: 'user', content: prompt }]
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );
        return response.data.choices[0].message.content.trim();
      } catch (err) {
        lastError = err;
        if (err.response?.status !== 429) throw err;

        const retryAfter = Number(err.response.headers?.['retry-after']);
        const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * (attempt + 1);
        console.warn(`[LLM] ${model} rate-limited; retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    console.warn(`[LLM] Switching from ${model} after repeated rate limits.`);
  }

  console.error('[LLM Error]:', lastError.response ? lastError.response.data : lastError.message);
  throw lastError;
}

// Strict Sheet Row Parser (Columns A to J)
async function getSheetRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet1!A1:J100',
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  return rows.slice(1).map((row, index) => ({
    rowIndex: index + 2,
    Name: row[0] || '',
    Website: row[1] || '',
    Email: row[2] || '',
    Specialization: row[3] || '',
    Notes: row[4] || '',
    Status: row[5] || 'New',
    DraftContent: row[6] || '',
    SentAt: row[7] || '',
    LastCheckedAt: row[8] || '',
    ThreadID: row[9] || ''
  }));
}

// Strict Cell Update Helper
async function updateCell(rowIndex, colLetter, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `Sheet1!${colLetter}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });
}

// Gmail Sending Helper
async function sendGmail({ to, subject, body, threadId = null }) {
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${utf8Subject}`,
    '',
    body
  ];

  if (threadId) {
    messageParts.splice(1, 0, `In-Reply-To: ${threadId}`, `References: ${threadId}`);
  }

  const message = messageParts.join('\n');
  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const payload = { userId: 'me', requestBody: { raw: encodedMessage } };
  if (threadId) payload.requestBody.threadId = threadId;

  const res = await gmail.users.messages.send(payload);
  return res.data;
}

// --- CORE WORKFLOW PROCEDURES ---

// 1. Process New Rows & Send Discord Approval Request
async function processNewLeads() {
  try {
    const rows = await getSheetRows();
    const newLeads = rows.filter(r => r.Status === 'New' || r.Status === 'Pending Draft' || !r.Status);

    for (const row of newLeads) {
      if (!row.Email) continue;
      console.log(`[Agent] Generating pitch draft for: ${row.Name || row.Email}...`);

      const prompt = `You are an expert AI & web solutions engineer crafting a personalized, concise cold pitch email to a potential client.
Client Name: ${row.Name}
Website: ${row.Website}
Specialization: ${row.Specialization}
Notes/Background Details: ${row.Notes}

Write a direct, professional, genuinely personalized cold outreach email (under 120 words). Avoid hype, exaggerated claims, spammy phrases, excessive punctuation, emojis, and unnecessary links. Make it clear why the message is relevant to this specific client. Provide ONLY the body text of the email. Do not add a subject line or conversational preamble. End the email with the signature "Zohaib Ali".`;

      const draft = await generateLLMResponse(prompt);

      await updateCell(row.rowIndex, 'G', draft);
      await updateCell(row.rowIndex, 'F', 'Pending Approval');

      const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);

      const approveBtn = new ButtonBuilder()
        .setCustomId(`approve_${row.rowIndex}`)
        .setLabel('Approve & Send')
        .setStyle(ButtonStyle.Success);

      const rejectBtn = new ButtonBuilder()
        .setCustomId(`reject_${row.rowIndex}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger);

      const actionRow = new ActionRowBuilder().addComponents(approveBtn, rejectBtn);

      await channel.send({
        content: `🎯 **New Client Outreach Draft Ready**\n**Name:** ${row.Name || 'N/A'}\n**Email:** ${row.Email}\n**Website:** ${row.Website || 'N/A'}\n\n**Proposed Pitch Draft:**\n\`\`\`\n${draft}\n\`\`\``,
        components: [actionRow]
      });
    }
  } catch (err) {
    console.error('[Error in processNewLeads]:', err.message);
  }
}

// 2. Check 24-Hour Replies & 48-Hour Follow-Up Triggers
async function checkFollowUpsAndReplies() {
  try {
    const rows = await getSheetRows();
    const now = new Date();

    for (const row of rows) {
      if (row.Status !== 'Sent' || !row.SentAt) continue;

      const sentDate = new Date(row.SentAt);
      const hoursElapsed = (now - sentDate) / (1000 * 60 * 60);

      if (hoursElapsed >= 24 && row.ThreadID) {
        console.log(`[Agent] Checking reply status for ${row.Email}...`);
        try {
          const thread = await gmail.users.threads.get({ userId: 'me', id: row.ThreadID });
          const messages = thread.data.messages || [];

          const clientReplied = messages.some(msg => {
            const fromHeader = msg.payload.headers.find(h => h.name.toLowerCase() === 'from');
            return fromHeader && fromHeader.value.includes(row.Email);
          });

          if (clientReplied) {
            console.log(`[Agent] Client ${row.Email} replied! Halting automation.`);
            await updateCell(row.rowIndex, 'F', 'Replied');
            
            const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
            await channel.send(`🎉 **Client Replied!**\n**Client:** ${row.Name}\n**Email:** ${row.Email} has responded to your email thread.`);
            continue;
          } else {
            await updateCell(row.rowIndex, 'I', now.toISOString());
          }
        } catch (e) {
          console.error(`[Agent] Error checking Thread ID ${row.ThreadID}:`, e.message);
        }
      }

      if (hoursElapsed >= 48) {
        console.log(`[Agent] Generating 48h follow-up draft for ${row.Email}...`);

        const prompt = `Write a brief, polite 2-sentence follow-up email checking in on a previous pitch sent to ${row.Name}. Keep it natural, friendly, and low-pressure. Avoid hype, spammy phrases, excessive punctuation, emojis, and unnecessary links. Provide ONLY the email body text. End the email with the signature "Zohaib Ali".`;

        const followUpDraft = await generateLLMResponse(prompt);

        await updateCell(row.rowIndex, 'G', followUpDraft);
        await updateCell(row.rowIndex, 'F', 'Follow-up Pending Approval');

        const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);

        const approveBtn = new ButtonBuilder()
          .setCustomId(`approve_${row.rowIndex}`)
          .setLabel('Approve Follow-up')
          .setStyle(ButtonStyle.Success);

        const rejectBtn = new ButtonBuilder()
          .setCustomId(`reject_${row.rowIndex}`)
          .setLabel('Skip Follow-up')
          .setStyle(ButtonStyle.Danger);

        const actionRow = new ActionRowBuilder().addComponents(approveBtn, rejectBtn);

        await channel.send({
          content: `⏰ **48h Follow-up Draft Ready**\n**Client:** ${row.Name}\n**Email:** ${row.Email}\n\n**Follow-up Draft:**\n\`\`\`\n${followUpDraft}\n\`\`\``,
          components: [actionRow]
        });
      }
    }
  } catch (err) {
    console.error('[Error in checkFollowUpsAndReplies]:', err.message);
  }
}

// --- DISCORD BUTTON HANDLERS ---
discordClient.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, rowIndexStr] = interaction.customId.split('_');
  const rowIndex = parseInt(rowIndexStr);
  const rows = await getSheetRows();
  const row = rows.find(r => r.rowIndex === rowIndex);

  if (action === 'approve') {
    if (row && row.Email && row.DraftContent) {
      await interaction.deferUpdate();

      try {
        const subject = `Web Systems & Optimization - ${row.Name || 'Partnership'}`;
        const emailRes = await sendGmail({
          to: row.Email,
          subject,
          body: row.DraftContent,
          threadId: row.ThreadID || null
        });

        const nowIso = new Date().toISOString();

        await updateCell(rowIndex, 'F', 'Sent');
        await updateCell(rowIndex, 'H', nowIso);
        await updateCell(rowIndex, 'J', emailRes.threadId);

        await interaction.editReply({
          content: `✅ **Email Sent Successfully!**\n**To:** ${row.Email}\n**Thread ID:** \`${emailRes.threadId}\``,
          components: []
        });
      } catch (err) {
        console.error('Failed to send email:', err);
        await interaction.followUp({ content: `❌ Failed to send email to ${row.Email}: ${err.message}`, ephemeral: true });
      }
    }
  } else if (action === 'reject') {
    await updateCell(rowIndex, 'F', 'Rejected');
    await interaction.update({
      content: `❌ **Outreach Cancelled for Row ${rowIndex}**`,
      components: []
    });
  }
});

// --- DISCORD READY & CRON JOBS ---
discordClient.once('clientReady', () => {
  console.log(`🤖 Zohaib Outreach Agent logged into Discord as ${discordClient.user.tag}`);

  // Poll for new leads every 2 minutes
  cron.schedule('*/2 * * * *', () => {
    console.log('[Cron] Checking for new rows...');
    processNewLeads();
  });

  // Check for 24h replies and 48h follow-ups every hour
  cron.schedule('0 * * * *', () => {
    console.log('[Cron] Checking replies and 48h follow-ups...');
    checkFollowUpsAndReplies();
  });
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);