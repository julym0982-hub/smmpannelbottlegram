# SMM Panel Telegram Bot

## Providers
`shweboost`, `secsers`, `hiroshi`, `morethanpanel` (list lives in `provider-ids.js`).

| Provider | .env keys |
|---|---|
| ShweBoost | `SHWEBOOST_API_URL`, `SHWEBOOST_API_KEY` |
| Secsers | `SECSERS_API_URL`, `SECSERS_API_KEY` |
| Hiroshi | `HIROSHI_API_URL`, `HIROSHI_API_KEY` |
| MoreThanPanel | `MORETHANPANEL_API_KEY` (URL defaults to `https://morethanpanel.com/api/v2`) |

Optional per provider: `<NAME>_USD_TO_MMK`, `<NAME>_MARKUP_MULTIPLIER` (or `/setrate morethanpanel 4400 2.3`).

Customers never see provider names. If a provider fails (e.g. "Not enough funds on balance"),
the customer gets the editable text `order_error_contact_admin`, their money is refunded,
and the admins get a Telegram alert naming the provider and reason.

## Telegram Account shop
Shop: **📱 Telegram Account** → *Account Instock* + **Buy Account** (or *Out Of Stock*) → name / balance / price of the next account + **ဝယ်မည်** → phone number + 2step psw + **Get Otp** (reads the code sent in the last 5 min; Copy 2step psw button).
History: **📜 History** → *Orders History ကိုရွေးချယ်ပါ* → **Account ဝယ်ယူမှုမှတ်တမ်း** (5 per page, hidden after 10 days - the account itself is not removed) / **Boost မှတ်တမ်း**. A number opens **Profile ကိုကြည့်ရန် / Code ယူရန် / Remove From History**; *Code ယူရန်* offers **5min code** and **old lastest code** (Copy Code / Copy 2Step buttons).

Setup
1. `npm install` (adds the `telegram` package).
2. Set `TG_API_ID` and `TG_API_HASH` (https://my.telegram.org -> API development tools).
3. For each account you own run `node tools/make-session.js` on your computer and copy the printed session string.
4. Admin Panel -> **TG Accounts**: add phone (with country code, any country), the account's own price, optional 2step password, and the session string. **စစ်** tests a session; **ဈေး** edits the price of an unsold account.

Notes: sessions and 2step passwords are stored AES-256-GCM encrypted (key from `AI_KEY_SECRET`, else `BOT_TOKEN` - changing it makes stored values unreadable). Only the Telegram service chat (777000) is read. Code requests have an 8 s cooldown and a per-account cap (`TGACC_MAX_CODE_REQUESTS`, default 40). Buying claims the account atomically, then takes its price; if the balance is too low the account is released again.

New-device notice: after Get Otp / 5min code the bot keeps a connection to that account for 5 minutes (max `30` accounts at once) and forwards Telegram's "New login ... from a new device" message, with the account's phone number, to the buyer.

Admin Panel -> TG Accounts also lets you: create a **new session** without any script (phone -> Telegram code -> 2step password if the account has one -> price -> saved straight into the shop; the session string never reaches the browser), check an account's codes with **Code** (*5min code* / *နောက်ဆုံး code*), open its **Profile** (name, username, id, 2step psw, profile link), and change an unsold account's price (**ဈေး**).

## Moving from the old bot (smmpannelbottlegram) to this version
This version = the redesigned bot (Shop / History / Deposit / Support inline menus + Telegram Account shop) **plus the old bot's Maintenance mode** (Panel > Settings > Maintenance, unchanged).

* Point it at the **same MongoDB** (`MONGODB_URI`, and `MONGODB_URI_AI` if you use it) with the same env vars as the old bot. Users, balances, orders, deposits, coupons, platforms/categories/services (with their provider + provider service id), panel settings, edited bot messages and Help requests all live in MongoDB and are read as-is - nothing has to be re-selected from the providers. The only schema change is one NEW collection (`tgaccounts`); no existing collection or field is changed, renamed or migrated.
* Keep `AI_KEY_SECRET` (or `BOT_TOKEN`) the same, otherwise API keys saved from the panel cannot be decrypted.
* New optional env vars: `TG_API_ID`, `TG_API_HASH` (Telegram Account shop), `TGACC_MAX_CODE_REQUESTS`, `SUPPORT_ADMIN_URL`. Run `npm install` (adds `telegram`).
* If the old bot was left in Maintenance mode, that flag is in the database, so this version also starts in Maintenance mode: customers get the notice, admins can use everything. Test as admin, then switch it off in Panel > Settings > Maintenance.
* Customers with the old bottom keyboard can keep tapping it until their next /start - the old labels are mapped to the new screens. Extra "Menu buttons" you made in the old bot now show inside Support.
* Order history clean-up (Settings > Help & Data: `history_auto`) is the same as in the old bot - it is not new, and you can switch it off there.
