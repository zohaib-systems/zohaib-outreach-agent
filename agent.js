const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const { google } = require('googleapis');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');

// --- EXPRESS & SOCKET.IO SETUP ---
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
  if (logHistory.length > 100) logHistory.shift();
  
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
      <title>Autonomous Outreach Agent — Live Operations Dashboard</title>
      <script src="/socket.io/socket.io.js"></script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; }
        h2 { color: #f0f6fc; font-size: 1.5rem; margin-bottom: 6px; }
        p.subtitle { color: #8b949e; margin-bottom: 24px; font-size: 0.9rem; }
        
        .flow-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
        .flow-title { color: #58a6ff; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px; }
        .flow-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; align-items: center; position: relative; }
        .node { background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 14px; text-align: center; position: relative; transition: all 0.3s ease; }
        .node.active { border-color: #3fb950; box-shadow: 0 0 12px rgba(63, 185, 80, 0.3); background: #1c2d24; }
        .node-icon { font-size: 1.4rem; margin-bottom: 6px; }
        .node-label { font-size: 0.85rem; font-weight: 600; color: #f0f6fc; }
        .node-sub { font-size: 0.72rem; color: #8b949e; margin-top: 4px; }

        .terminal-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
        .terminal-header { background: #21262d; padding: 10px 16px; border-bottom: 1px solid #30363d; font-family: monospace; font-size: 0.8rem; color: #8b949e; display: flex; justify-content: space-between; }
        #logs { padding: 16px; height: 50vh; overflow-y: auto; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 0.85rem; line-height: 1.5; white-space: pre-wrap; }
        .log-entry { margin-bottom: 4px; border-bottom: 1px solid #1f242c; padding-bottom: 2px; color: #58a6ff; }
        .log-error { color: #f85149; }
        .log-success { color: #3fb950; }
      </style>
    </head>
    <body>
      <h2>🤖 Zohaib Outreach Agent</h2>
      <p class="subtitle">Autonomous Human-in-the-Loop Pipeline — Healthcare Phase 1 Operations Stream</p>

      <div class="flow-container">
        <div class="flow-title">Agent System Workflow</div>
        <div class="flow-grid">
          <div class="node" id="node-sheets">
            <div class="node-icon">📊</div>
            <div class="node-label">Google Sheets</div>
            <div class="node-sub">Lead Polling Cron</div>
          </div>
          <div class="node" id="node-llm">
            <div class="node-icon">🧠</div>
            <div class="node-label">OpenRouter LLM</div>
            <div class="node-sub">Diagnosis Drafting</div>
          </div>
          <div class="node" id="node-discord">
            <div class="node-icon">💬</div>
            <div class="node-label">Discord Approval</div>
            <div class="node-sub">Human-in-the-Loop</div>
          </div>
          <div class="node" id="node-gmail">
            <div class="node-icon">✉️</div>
            <div class="node-label">Gmail API</div>
            <div class="node-sub">Email Dispatcher</div>
          </div>
          <div class="node" id="node-tracker">
            <div class="node-icon">🔄</div>
            <div class="node-label">Thread Monitor</div>
            <div class="node-sub">48h Auto Follow-up</div>
          </div>
        </div>
      </div>

      <div class="terminal-container">
        <div class="terminal-header">
          <span>LIVE CONSOLE STREAM</span>
          <span id="status" style="color:#7ee787;">● CONNECTED</span>
        </div>
        <div id="logs"></div>
      </div>

      <script>
        const socket = io();
        const logsDiv = document.getElementById('logs');

        socket.on('connect', () => {
          document.getElementById('status').textContent = '● LIVE';
        });

        socket.on('new-log', (msg) => {
          const entry = document.createElement('div');
          entry.className = 'log-entry';

          if (msg.includes('ERROR') || msg.includes('TokenInvalid')) entry.className += ' log-error';
          if (msg.includes('logged into Discord') || msg.includes('Sent')) entry.className += ' log-success';

          entry.textContent = msg;
          logsDiv.appendChild(entry);
          logsDiv.scrollTop = logsDiv.scrollHeight;

          if (msg.includes('Checking for new rows')) highlightNode('node-sheets');
          if (msg.includes('Generating diagnosis')) highlightNode('node-llm');
          if (msg.includes('Discord') || msg.includes('approval')) highlightNode('node-discord');
          if (msg.includes('Gmail') || msg.includes('dispatch')) highlightNode('node-gmail');
        });

        function highlightNode(id) {
          document.querySelectorAll('.node').forEach(n => n.classList.remove('active'));
          const el = document.getElementById(id);
          if (el) el.classList.add('active');
        }
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Log Web UI running on port ${PORT}`));

// --- DISCORD & GOOGLE SETUP ---
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// OpenRouter LLM Helper
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

// Strict Sheet Row Parser (Phase 1: Columns A to L)
async function getSheetRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet1!A1:L100', // Expanded range for Phase 1 columns
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  return rows.slice(1).map((row, index) => ({
    rowIndex: index + 2,
    Name: row[0] || '',
    Website: row[1] || '',
    Email: row[2] || '',
    Specialization: row[3] || '',
    keyObservation: row[4] || '',    // Col E
    problemIdentified: row[5] || '', // Col F
    pitchAngle: row[6] || '',        // Col G
    leadScore: row[7] || '',         // Col H
    Status: row[8] || 'new',         // Col I
    DraftContent: row[9] || '',      // Col J
    SentAt: row[10] || '',           // Col K
    ThreadID: row[11] || ''          // Col L
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

// 1. Process New Rows & Send Discord Approval Request (Phase 1 Prompt)
async function processNewLeads() {
  try {
    const rows = await getSheetRows();
    const newLeads = rows.filter(r => r.Status.toLowerCase() === 'new' || r.Status === 'Pending Draft' || !r.Status);

    for (const row of newLeads) {
      if (!row.Email) continue;
      console.log(`[Agent] Generating diagnosis-backed pitch draft for: ${row.Name || row.Email}...`);

      const prompt = `You are drafting a personalized outreach email for a healthcare professional.

Input:
- Name: ${row.Name}
- Email: ${row.Email}
- Specialization: ${row.Specialization}
- Key Observation: ${row.keyObservation}
- Problem Identified: ${row.problemIdentified}
- Pitch Angle: ${row.pitchAngle}

Email structure:
1. Personalized opener (reference key observation)
2. Diagnosis (why this matters for their business)
3. Solution (what you can help with)
4. Low-friction CTA ("quick call", "no pressure")

Rules:
- Never be generic
- Reference the specific observation
- Do NOT pitch multiple services
- Keep under 150 words
- Sign: "Zohaib Ali, AI Systems Company"

Generate draft email only. Do not send. Do not include subject lines or conversational preambles.`;

      const draft = await generateLLMResponse(prompt);

      // Write draft to Column J & Status to Column I
      await updateCell(row.rowIndex, 'J', draft);
      await updateCell(row.rowIndex, 'I', 'Pending Approval');

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
        content: `🎯 **New Healthcare Outreach Draft Ready**\n**Name:** ${row.Name || 'N/A'}\n**Email:** ${row.Email}\n**Key Observation:** ${row.keyObservation || 'N/A'}\n**Pitch Angle:** ${row.pitchAngle || 'N/A'}\n\n**Proposed Draft:**\n\`\`\`\n${draft}\n\`\`\``,
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
      if (row.Status.toLowerCase() !== 'sent' || !row.SentAt) continue;

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
            await updateCell(row.rowIndex, 'I', 'Replied');
            
            const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
            await channel.send(`🎉 **Client Replied!**\n**Client:** ${row.Name}\n**Email:** ${row.Email} has responded to your email thread.`);
            continue;
          }
        } catch (e) {
          console.error(`[Agent] Error checking Thread ID ${row.ThreadID}:`, e.message);
        }
      }

      if (hoursElapsed >= 48) {
        console.log(`[Agent] Generating 48h follow-up draft for ${row.Email}...`);

        const prompt = `Write a light, low-pressure 2-sentence follow-up email checking in on a previous pitch sent to ${row.Name}. Reference checking in on their booking system optimization. Keep under 60 words. Sign: "Zohaib Ali, AI Systems Company". Provide ONLY body text.`;

        const followUpDraft = await generateLLMResponse(prompt);

        await updateCell(row.rowIndex, 'J', followUpDraft);
        await updateCell(row.rowIndex, 'I', 'Follow-up Pending Approval');

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
        const subject = `Healthcare Systems & Optimization - ${row.Name || 'Partnership'}`;
        const emailRes = await sendGmail({
          to: row.Email,
          subject,
          body: row.DraftContent,
          threadId: row.ThreadID || null
        });

        const nowIso = new Date().toISOString();

        // Update Col I (Status), Col K (Sent At), Col L (Thread ID)
        await updateCell(rowIndex, 'I', 'sent');
        await updateCell(rowIndex, 'K', nowIso);
        await updateCell(rowIndex, 'L', emailRes.threadId);

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
    await updateCell(rowIndex, 'I', 'Rejected');
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