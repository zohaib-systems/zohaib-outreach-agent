# 🤖 Autonomous Outreach Agent (Human-in-the-Loop)

An enterprise-grade, event-driven outreach automation worker built with **Node.js**, **Discord.js**, **Google Sheets & Gmail APIs**, and **OpenRouter LLMs**. Deployed 24/7 on **AWS EC2** with a real-time web monitoring operations dashboard.

---

## 🏗️ Architecture & Operations Dashboard

The system polls for new leads, dynamically crafts personalized pitches using LLMs, routes drafts to Discord for human approval, dispatches emails via Gmail OAuth2, and tracks 24-hour reply statuses and 48-hour follow-up triggers.
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────┐
│  Google Sheets  │────>│ OpenRouter LLM  │────>│  Discord Approval   │
│  (Lead Polling) │     │(Personalization)│     │ (Human-in-the-Loop) │
└─────────────────┘     └─────────────────┘     └─────────────────────┘
│
┌─────────────────┐     ┌─────────────────┐                │
│ Thread Monitor  │<────│    Gmail API    │<───────────────┘
│ (48h Follow-up) │     │ (Email Dispatch)│
└─────────────────┘     └─────────────────┘

---

## ✨ Features

* **Autonomous Lead Polling**: Scheduled background cron jobs inspect incoming Google Sheet entries every 2 minutes.
* **Resilient LLM Integration**: Multi-model fallback logic across OpenRouter endpoints with automatic exponential backoff rate-limit handling (`429`).
* **Human-in-the-Loop Safety**: Interactive Discord action buttons (`Approve & Send`, `Reject`) prevent unsupervised dispatches.
* **Email Thread Tracking**: Captures and persists Gmail `ThreadID` references to manage 24-hour reply detection and automated 48-hour follow-up generation.
* **Live Operations Dashboard**: Integrated Web UI running on Express and Socket.io with real-time active workflow node highlights and terminal console streams.

---

## 🛠️ Tech Stack

* **Runtime**: Node.js (v20+)
* **Cloud Infrastructure**: AWS EC2 (Ubuntu 24.04 LTS), PM2 Process Manager
* **APIs & Integrations**: Google Sheets API v4, Gmail API v1, Discord.js v14, OpenRouter API
* **Web Dashboard**: Express.js, Socket.io, HTML5/CSS3

---

## 🚀 Getting Started

### 1. Prerequisites

* Node.js v18+ installed locally.
* Google Cloud Platform project with **Google Sheets API** and **Gmail API** enabled.
* OAuth 2.0 Client Credentials (`CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`).
* Discord Bot Token & Channel ID with application command permissions.
* OpenRouter API key.

### 2. Environment Setup

Create a `.env` file in the root directory:

```env
PORT=3000
SPREADSHEET_ID=your_google_sheet_id
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REFRESH_TOKEN=your_google_refresh_token
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_ID=your_discord_channel_id
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free
OPENROUTER_FALLBACK_MODEL=minimax/minimax-m3:free

3. Installation & Local Run
# Clone the repository
git clone [https://github.com/YOUR_USERNAME/zohaib-outreach-agent.git](https://github.com/YOUR_USERNAME/zohaib-outreach-agent.git)
cd zohaib-outreach-agent

# Install dependencies
npm install

# Start the agent locally
node agent.js

☁️ Deployment (AWS EC2 & PM2)
To keep the agent running continuously on AWS EC2:

Bash
# SSH into EC2 instance
ssh -i key.pem ubuntu@YOUR_EC2_PUBLIC_IP

# Clone repository & set up env
git clone [https://github.com/YOUR_USERNAME/zohaib-outreach-agent.git](https://github.com/YOUR_USERNAME/zohaib-outreach-agent.git)
cd zohaib-outreach-agent
npm install

# Start process with PM2
pm2 start agent.js --name "outreach-agent"
pm2 save
pm2 startup
📊 Live Monitoring
Access the live dashboard at:
http://YOUR_EC2_PUBLIC_IP:3000

📄 License
MIT License. Developed for AI fluency and Backend AI Engineering Capstone.