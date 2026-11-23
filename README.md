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

## Third database (optional) + clean-up
* `MONGODB_URI_STORE` = a third MongoDB. When set, the **Telegram accounts (sessions, sale history)** and the **admin Activity Log** live there, so the main database (users, balances, orders, services) stays small. When it is NOT set, they stay in the main database as before. Switching it on does not move old data: Activity-Log rows already in the main DB just age out; Telegram accounts you already added must be re-added (or tell me and I'll write a one-time copy script). If the store DB is down the bot says so politely and the rest of the bot keeps working.
* Sold Telegram accounts are deleted `tgacc_keep_days` days after the sale (default 30, never earlier than 11; 0 = keep) - Panel > Settings > Help & Data. Unsold stock is never touched. Buyers only see their History for 10 days.
* Panel > Deposits: 🗑 on every approved/rejected record, and a bulk clean-up box (status + older-than-N-days, with preview). Pending requests cannot be deleted and balances are never changed.
* Speed: Shop button price cached 10 s, new indexes (TG accounts; Orders by user/date and status/date).
* Profile link opens the account's **profile page** (`t.me/<username>?profile`). An account with no username falls back to `tg://user?id=…`, which only opens if your Telegram already knows that user.

## 💎 Mobile Legends TopUp (Shop -> Mobile Legends TopUp, paid from the customer's MMK balance, bought on Smile One with Smile Coins)
Files: `ml.js` (menu, flow, prices, admin helpers), `ml-smile.js` (Smile One client), Panel page **ML TopUp**, model `MlOrder` (store database).

* **Customer flow:** package -> Game ID -> Server ID -> bot shows the player name -> **ဟုတ်ပါတယ်** buys / **မဟုတ်ပါ** cancels.
* **Visibility (Panel > ML TopUp):** *button ပေါ်မည်* off = button gone for everybody; *Admin only* on = only admins see it (default **on**).
* **တကယ်ဝယ်မည်** is OFF by default = dry run: the whole flow works, nothing is charged, nothing is bought. Turn it on only after *Session စစ်* works and the prices look right.
* **Prices:** cost = Smile Coins x (MMK paid / Smile Coins received); price = cost x (1 + markup %), rounded to the "round to" step. Edit each package's % (a live preview shows the new price and profit), or move all of them at once with the +/- % box. Smile Coins per package are read from Smile One when the session is checked (otherwise the last measured values are used). Only packages whose Smile One zone type is not 1/2 are sold (type 3 = the rule that was tested); other zones are refused instead of guessing the price.
* **Smile One session:** run `python tools/save_session_smile.py` on your laptop -> upload `smileone_session.json` in the panel, paste it, or send the file to the bot as an admin (the bot saves it encrypted and deletes your message). Only smile.one cookies are kept; Google cookies are dropped. Then press *Session စစ်*.
* **Safety:** one Smile One call at a time; the price shown to the customer is what they pay; if Smile One's price rose more than 3% the order is refused; a failed order refunds at once; an unclear result (timeout / no success page) is NOT refunded or retried - it shows as 🟠 စစ်ရန် in the panel for you to check on Smile One's /customer/order and press *ပြီးပြီ* or *ငွေပြန်ထည့်*. "💎1,130" is bought as 2 x the 565 tier.

* **Session ကုန်ရင် (one click):** laptop မှာ `tools\get_session.bat` ကို double-click -> ပွင့်လာတဲ့ Chrome မှာ smile.one login ဝင် -> Enter -> JSON ကို clipboard ထဲ copy ပေးထားတယ် -> Panel > ML TopUp မှာ paste -> သိမ်းမည် -> Session စစ်။ Bot က ၃ နာရီတစ်ခါ session ကို စစ်ပြီး ကုန်သွားရင် Admin ကို အလိုအလျောက် သတိပေးပါမယ်။
* **History:** customer ရဲ့ History > *Mlbb ဝယ်ယူမှု မှတ်တမ်း* မှာ ကိုယ့် order တွေကို စာရင်းနဲ့ (Status, User ID, Server ID, ကျသင့်ငွေ, Order time) ကြည့်လို့ရပါတယ်။
* `tools/probe_orders.py` = Smile One order list ကို ဖတ်ရုံသာ စစ်တဲ့ probe (order status စစ်တာ ရေးဖို့)။
* **Smile One status စစ်ခြင်း:** order တစ်ခုချင်းစီကို Smile One ရဲ့ order list (`/customer/activationcode/codelist`) နဲ့ user id + server id + package + အချိန်နဲ့ ကိုက်ရှာပါတယ်။ Customer က History > order > "🔄 Status စစ်မည်" နှိပ်ရင် Smile One status (✅ အောင်မြင်၊ ⏳ စောင့်ဆိုင်း၊ ↩️ ငွေပြန်အမ်း ... မြန်မာလို) ပြပါတယ်။ Admin Panel မှာ "Smile စစ်" button ရှိပါတယ်။ "စစ်ရန်" order ကို Smile One မှာ အောင်မြင်တယ်ဆိုရင် အလိုအလျောက် "ပြီး" ပြောင်းပါတယ်။ ၂ နာရီတစ်ခါ နောက်ဆုံး ၃ ရက် order တွေကို ပြန်စစ်ပြီး Smile One က ငွေပြန်အမ်း/ငြင်းထားရင် Admin ကို သတိပေးပါတယ်။ တကယ်ဖြတ်တဲ့ Smile Coins (BRL x 10) ကိုလည်း order မှာ မှတ်ထားပါတယ်။
* **History (customer):** History > *MlbbTopup ဝယ်ယူမှုမှတ်တမ်း* - 5 orders per page, newest first, at most 5 pages (the newest 25 are shown; older ones stay in the database for the admin's profit report but are not listed to the customer). Customer-facing text never mentions where the diamonds are bought.
* **Game ID input:** `824412642` (then Server ID is asked) or `824412642(12267)` in one message.
* **Panel > ML TopUp** has 4 tabs: Settings | Orders (filter, search, every detail per order, Smile status check, refund) | Profit (today / yesterday / 7d / 30d / all, per package, per day, top customers - kept out of the dashboard) | Check (read-only health check of session, login, balance, price table, order list, player-name lookup).
* Laptop session tool: the separate `smile-session-tool.zip` (get_session.bat).
