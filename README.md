# Firestore Monitor Server

A lightweight Node.js server that listens to **all Firestore collections** for real-time changes (create, update, delete), and forwards those events to an external `n8n` webhook.

> ✅ No Firebase Blaze plan required  
> ✅ Real-time listening  
> ✅ Dynamic collection discovery  
> ✅ Webhook support for automation tools like `n8n`

---

## 🔧 Features

- Auto-discovers Firestore collections
- Listens to changes using `onSnapshot`
- Sends dynamic event payloads to a webhook (e.g., `n8n`)
- Handles reconnects and new collections dynamically
- Logs changes and errors

---

## 📦 Requirements

- Node.js 18+
- Firebase project (can use free tier)
- [n8n](https://n8n.io/) instance with webhook enabled

---

## 🛠️ Installation

```bash
git clone https://github.com/your-username/listner-server.git
cd listner-server
npm install
