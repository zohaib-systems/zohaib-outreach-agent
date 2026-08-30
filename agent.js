const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const { google } = require('googleapis');
const { 
  Client, 
  GatewayIntentBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle 
} = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');

// --- EXPRESS & SOCKET.IO SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const logHistory = [];
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

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Autonomous Outreach Agent — Operations Dashboard</title>
      <script src="/socket.io/socket.io.js"></script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0d1117; color: #c9d1d9; font-family: system-ui, sans-serif; padding: 24px; }
        h2 { color: #f0f6fc; margin-bottom: 6px; }
        .subtitle { color: #8b949e; margin-bottom: 24px; font-size: 0.9rem; }
        .terminal-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
        .terminal-header { background: #21262d; padding: 10px 16px; font-family: monospace; font-size: 0.8rem; color: #8b949e; display: flex; justify-content: space-between; }
        #logs { padding: 16px; height: 60vh; overflow-y: auto; font-family: monospace; font-size: 0.85rem; line-height: 1.5; white-space: pre-wrap; }
        .log-entry { margin-bottom: 4px; border-bottom: 1px solid #1f242c; color: #58a6ff; }
        .log-error { color: #f85149; }
        .log-success { color: #3fb950; }
      </style>
    </head>
    <body>
      <h2>🤖 Zohaib Outreach Agent</h2>
      <p class="subtitle">Autonomous Human-in-the-Loop Pipeline — Interactive Discord Feedback Loop</p>
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
        socket.on('new-log', (msg) => {
          const entry = document.createElement('div');
          entry.className = 'log-entry';
          if (msg.includes('ERROR')) entry.className += ' log-error';
          if (msg.includes('Sent') || msg.includes('logged')) entry.className += ' log-success';
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

// --- OPENROUTER LLM HELPER ---
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
  }
  console.error('[LLM Error]:', lastError.response ? lastError.response.data : lastError.message);
  throw lastError;
}

// Strict Sheet Row Parser (Phase 1: Columns A to L)
async function getSheetRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet1!A1:L100',
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

async function updateCell(rowIndex, colLetter, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `Sheet1!${colLetter}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });
}

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

// Helper to build Discord Action Buttons
function createApprovalActionRow(rowIndex) {
  const approveBtn = new ButtonBuilder()
    .setCustomId(`approve_${rowIndex}`)
    .setLabel('Approve & Send')
    .setStyle(ButtonStyle.Success);

  const editBtn = new ButtonBuilder()
    .setCustomId(`edit_${rowIndex}`)
    .setLabel('✏️ Edit / Revise')
    .setStyle(ButtonStyle.Primary);

  const rejectBtn = new ButtonBuilder()
    .setCustomId(`reject_${rowIndex}`)
    .setLabel('Reject')
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(approveBtn, editBtn, rejectBtn);
}

// --- CORE WORKFLOW PROCEDURES ---
async function processNewLeads() {
  try {
    const rows = await getSheetRows();
    const newLeads = rows.filter(r => r.Status.toLowerCase() === 'new' || r.Status === 'Pending Draft' || !r.Status);

    for (const row of newLeads) {
      if (!row.Email) continue;
      console.log(`[Agent] Generating diagnosis pitch draft for: ${row.Name || row.Email}...`);

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

      await updateCell(row.rowIndex, 'J', draft);
      await updateCell(row.rowIndex, 'I', 'Pending Approval');

      const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
      const actionRow = createApprovalActionRow(row.rowIndex);

      await channel.send({
        content: `🎯 **New Healthcare Outreach Draft Ready**\n**Name:** ${row.Name || 'N/A'}\n**Email:** ${row.Email}\n**Key Observation:** ${row.keyObservation || 'N/A'}\n\n**Proposed Draft:**\n\`\`\`\n${draft}\n\`\`\``,
        components: [actionRow]
      });
    }
  } catch (err) {
    console.error('[Error in processNewLeads]:', err.message);
  }
}

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
        const actionRow = createApprovalActionRow(row.rowIndex);

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

// --- DISCORD INTERACTION HANDLERS (BUTTONS & MODAL FEEDBACK) ---
discordClient.on('interactionCreate', async (interaction) => {
  // 1. Handle Button Clicks
  if (interaction.isButton()) {
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
    } else if (action === 'edit') {
      // Open modal to capture revision feedback from user
      const modal = new ModalBuilder()
        .setCustomId(`modal_edit_${rowIndex}`)
        .setTitle(`Revise Draft for Row ${rowIndex}`);

      const feedbackInput = new TextInputBuilder()
        .setCustomId('feedback_input')
        .setLabel('Instructions for LLM revision:')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('e.g., Make it shorter, focus more on automated intake forms, make tone softer...')
        .setRequired(true);

      const actionRow = new ActionRowBuilder().addComponents(feedbackInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } else if (action === 'reject') {
      await updateCell(rowIndex, 'I', 'Rejected');
      await interaction.update({
        content: `❌ **Outreach Cancelled for Row ${rowIndex}**`,
        components: []
      });
    }
  }

  // 2. Handle Modal Form Submissions (LLM Feedback Revision Loop)
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_edit_')) {
      const rowIndex = parseInt(interaction.customId.split('_')[2]);
      const feedback = interaction.fields.getTextInputValue('feedback_input');

      await interaction.deferUpdate();

      const rows = await getSheetRows();
      const row = rows.find(r => r.rowIndex === rowIndex);

      if (row) {
        console.log(`[Agent] Regenerating draft for Row ${rowIndex} with user feedback: "${feedback}"...`);

        const revisionPrompt = `You are revising an outreach email draft for a healthcare client based on direct human feedback.

Previous Draft:
"${row.DraftContent}"

Client Details:
- Name: ${row.Name}
- Specialization: ${row.Specialization}
- Key Observation: ${row.keyObservation}

Human Revision Feedback:
"${feedback}"

Instructions:
- Rewrite the email incorporate the feedback while keeping it professional and under 150 words.
- Sign as "Zohaib Ali, AI Systems Company".
- Provide ONLY the body text. Do not add subject lines or conversation preamble.`;

        const revisedDraft = await generateLLMResponse(revisionPrompt);

        // Update draft in Column J
        await updateCell(rowIndex, 'J', revisedDraft);

        const actionRow = createApprovalActionRow(rowIndex);

        await interaction.editReply({
          content: `🔄 **Revised Draft Ready (Row ${rowIndex})**\n**User Feedback Applied:** *"${feedback}"*\n**Name:** ${row.Name}\n**Email:** ${row.Email}\n\n**New Proposed Draft:**\n\`\`\`\n${revisedDraft}\n\`\`\``,
          components: [actionRow]
        });
      }
    }
  }
});

// --- DISCORD READY & CRON JOBS ---
discordClient.once('clientReady', () => {
  console.log(`🤖 Zohaib Outreach Agent logged into Discord as ${discordClient.user.tag}`);

  cron.schedule('*/2 * * * *', () => {
    console.log('[Cron] Checking for new rows...');
    processNewLeads();
  });

  cron.schedule('0 * * * *', () => {
    console.log('[Cron] Checking replies and 48h follow-ups...');
    checkFollowUpsAndReplies();
  });
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);