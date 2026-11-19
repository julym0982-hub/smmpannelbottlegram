// Run on YOUR computer once per account:  node tools/make-session.js
// Logs into an account you own and prints the session string to paste into
// Admin Panel > TG Accounts. Keep that string private - it is the login.
require('dotenv').config();
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));
(async () => {
  const apiId = parseInt(process.env.TG_API_ID || await ask('API ID: '), 10);
  const apiHash = process.env.TG_API_HASH || await ask('API HASH: ');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
  await client.start({
    phoneNumber: () => ask('Phone (+959...): '),
    password: () => ask('2FA password (if any): '),
    phoneCode: () => ask('Code from Telegram: '),
    onError: (e) => console.error(e.message)
  });
  console.log('\nSESSION STRING (paste into the panel):\n\n' + client.session.save() + '\n');
  await client.disconnect(); rl.close(); process.exit(0);
})();
