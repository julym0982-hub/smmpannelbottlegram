# SMM Panel Telegram Bot (MongoDB + ShweBoost/Secsers/Hiroshi)

## ⚠️ Admin ID သတိပေးချက်
သင်ပေးထားခဲ့တဲ့ `-8476333051` က အနှုတ်ကိန်း ဖြစ်နေပါတယ် — Telegram user account id က အမြဲ အပေါင်းကိန်းသာ ဖြစ်ရပါတယ်။ `@userinfobot` ကို message ပို့ပြီး မှန်ကန်တဲ့ ID ကို ပြန်ယူပြီး `.env` ရဲ့ `ADMIN_IDS` ထဲ ထည့်ပါ (comma ခြားပြီး admin တစ်ယောက်ထက်ပို ထည့်လို့ရပါတယ်)။

## ဒီဗားရှင်းမှာ အသစ်ထပ်ပါလာသည်များ

- **MongoDB** သုံးထားပြီ (JSON file မဟုတ်တော့ပါ) — user, order, category, service, coupon, editable-text အားလုံး database ထဲ
- **Platform → Category → Service** အဆင့်ဆင့် menu — ဥပမာ Telegram → "Reaction တိုးရန်❤️" → ❤️/👍/👎/🔥/... (emoji buttons scroll လုပ်လို့ရအောင် bottom keyboard နဲ့ ပြထားသည်), "Views တိုးရန်👀" ကဲ့သို့ category တစ်ခုမှာ service တစ်ခုတည်း ရှိရင် တန်းပြီး link မေးမည်
- **Provider သုံးခု (ShweBoost + Secsers + Hiroshi)** — service တစ်ခုချင်းစီအတွက် ဘယ် provider ကို သုံးမလဲ admin ရွေးထားနိုင်ပြီး rate/min/max ကို provider API ကနေ **အလိုအလျောက် fetch** လုပ်ပေးပါတယ် (manual ရိုက်စရာ မလိုပါ)
- **ကျသင့်ငွေတွက်နည်း**: provider သုံးခုစလုံး (ShweBoost + Secsers + Hiroshi) ရဲ့ API က rate/balance ကို **USD** ဖြင့် ပြသည် — ဒါကြောင့် အားလုံး `rate(USD) × USD→MMK rate × markup` ဖြင့် တွက်သည်။ Rate/markup ကို bot ထဲကနေ `/setrate <provider> <rate> <markup>` ဖြင့် redeploy မလိုဘဲ ချက်ချင်း ပြောင်းနိုင်သည် (ဥပမာ `/setrate shweboost 2100 2.3`)
- **ကြာချိန် (average time)**: ShweBoost API မှာ ဒီ field လုံးဝ မပါလာပါ (သူတို့ documentation အရ services list မှာ service/name/type/category/rate/min/max/refill/cancel ပဲ ပါသည်) — ဒါကြောင့် admin က `/setduration <serviceMongoId> <text>` ဖြင့် manual ထည့်ပေးရမည် (ဥပမာ `/setduration 66a2... 18 မိနစ်`)
- Order တင်ပြီးရင် **Order History** ထဲမှာ link/quantity/before-count/remaining/status ကို **provider API ကနေ တိုက်ရိုက်** ပြပေးမည်၊ **Cancel Order** button ကလည်း provider API ကို ခေါ်ပြီး cancel အောင်မြင်ရင် cashback ပြန်ပေး၊ မအောင်မြင်ရင် "ဆောင်ရွက်လျက်ရှိပါတယ်" ပြမည်
- Order **complete** ဖြစ်တာနဲ့ background job (၅ မိနစ်တိုင်း, batch 40 ခုစီ, delay ခံ) က user ကို အလိုအလျောက် message ပို့ပေးမည် — order အများကြီးရှိလည်း bot crash မဖြစ်အောင် batch/delay လုပ်ထားသည်
- **Balance မလုံလောက်ရင်** "ငွေထပ်ဖြည့်ပေးပါနော်🥰" ဆိုပြီး ငွေဖြည့်ရန် button ချက်ချင်း ပြမည်
- **Admin commands အသစ်များ**: `/users [page]` (10/page, balance/spent/profile link ပါ), `/userinfo <id>`, `/providerbalance`, `/syncservices`, `/texts` + `/edittext <key> <value>` (bot ပို့တဲ့ message အားလုံးကို code မထိဘဲ ပြင်လို့ရသည်)
- `/start` ကို admin က နှိပ်တိုင်း command list အပြည့်အစုံ ပြန်ပြပေးသည်

## Service ထည့်နည်း — Home button → Category → Button (3 layers)

**Layer 1: Home button** (ဥပမာ "Telegram Service", "Tiktok Service", "Facebook Service") — ❤️ရရှိနိုင်သောservice များ❤️ နှိပ်ပြီး အရင်ဆုံးမြင်ရမည့် ခလုတ်များ
```
/addhomebutton telegram Telegram Service
/addhomebutton tiktok Tiktok Service
/addhomebutton facebook Facebook Service
```
ဖျက်ရန်: `/removehomebutton telegram` (or `/decreasehomebutton telegram`) — category/service အားလုံးပါ ပါ ဖျက်သွားမည်ကို သတိပြုပါ။

**Layer 2 + 3: Category (Reaction တိုးရန်❤️, Views တိုးရန်👀...) + Button (♥️, 👍...)** — တစ်ကြောင်းတည်းနဲ့ ချက်ချင်း ထည့်နိုင်သည့် command:
```
/addbutton <platform_key>|<category_label>|<button_label>|<provider>|<provider_service_id>
```
ဥပမာများ:
```
/addbutton telegram|Reaction တိုးရန်❤️|♥️|shweboost|1234
/addbutton telegram|Reaction တိုးရန်❤️|👍|shweboost|1235
/addbutton telegram|Reaction တိုးရန်❤️|🔥|shweboost|1236
/addbutton telegram|Views တိုးရန်👀|-|shweboost|5678
/addbutton tiktok|Tiktok like👍|-|secsers|9001
/addbutton tiktok|Tiktok views👀|-|secsers|9002
```
- `platform_key` က home button ရဲ့ key (telegram/tiktok/facebook) — မရှိသေးရင် အလိုအလျောက် home button ဖန်တီးပေးမည်
- `category_label` တူညီအောင် ထပ်ခါထပ်ခါ ရေးရင် category တစ်ခုထဲကို service အများကြီး ပေါင်းထည့်သွားမည် (ဥပမာ "Reaction တိုးရန်❤️" ထဲ ♥️,👍,🔥 အကုန် ပေါင်းရောက်)
- Category တစ်ခုမှာ service **တစ်ခုတည်း** ရှိရင် (ဥပမာ "Views တိုးရန်👀") user က category ကို နှိပ်တာနဲ့ sub-menu မပြဘဲ တန်းပြီး link တောင်းသွားမည်
- `button_label` နေရာမှာ `-` ရေးရင် provider ကနေ fetch ရလာတဲ့ service name ကိုပဲ button label အဖြစ် သုံးမည်
- `rate/min/max/average time` ကို command ထဲ ရေးစရာ မလိုပါ — provider API ကနေ အလိုအလျောက် ဆွဲပေးမည်

`/addbutton` ရေးနည်း မကျွမ်းကျင်သေးရင် အဆင့်ဆင့် မေးမြန်းပေးမည့် wizard (`/addid`) ကိုလည်း သုံးနိုင်ပါတယ်:
```
/addid
> telegram          (Platform key)
> Reaction တိုးရန်❤️  (Category label)
> shweboost         (Provider)
> 1234              (Provider service id)
> ♥️                (Button label, "-" ရေးရင် provider name သုံးမည်)
```

**စစ်ဆေးရန်**: `/services` ကို ပို့ရင် home button/category/service အားလုံးကို id များနှင့်တကွ ပြပေးမည် — ဘာမှ မမြင်ရရင် ဒီ command သုံးပြီး ဘယ်အဆင့်မှာ ပျောက်နေလဲ စစ်နိုင်ပါတယ်။

Service ဖျက်ရန်: `/removeid <serviceMongoId>` (`/services` output ထဲက id ကို ကူးသုံးပါ)
Category တစ်ခုလုံး ဖျက်ရန်: `/removecategory <categoryMongoId>`

## Setup (Local)

```bash
npm install
cp .env.example .env
# BOT_TOKEN, ADMIN_IDS, MONGODB_URI, KPAY/WAVE, SHWEBOOST_*, SECSERS_* ဖြည့်ပါ
npm start
```

## MongoDB (Atlas လွယ်ကူသော free option)

1. https://www.mongodb.com/cloud/atlas → free account ဖွင့်ပါ → Free (M0) cluster ဆောက်ပါ
2. Database Access ထဲမှာ user/password ဆောက်ပါ
3. Network Access ထဲမှာ `0.0.0.0/0` ကို allow လုပ်ပါ (Render ကနေ ဝင်လို့ရအောင်)
4. "Connect" → "Drivers" ကနေ connection string ကို copy ကူးပြီး `.env` ရဲ့ `MONGODB_URI` ထဲ ထည့်ပါ

**Storage limit (Free M0 = 512MB) စောင့်ကြည့်ရန်**: Atlas dashboard ထဲက cluster ကို ကြည့်ရင် "Storage Used" ကို မြင်ရပါမယ်။ User/order အရေအတွက် တိုးလာတာနှင့်အမျှ space ကို လေးလေးနက်နက် စောင့်ကြည့်ပါ (Order collection က အများဆုံး ကြီးလာမည့် collection ဖြစ်ပါလိမ့်မယ်)။ ပြည့်တော့မယ်ဆိုရင်:
- `/checkorders` output ကို ကြည့်ပြီး `completed`/`cancelled` ဖြစ်ပြီးတာကြာနေတဲ့ order (ဥပမာ ၃ လကျော်) အဟောင်းများကို `/removeorder <id>` ဖြင့် archive/ဖျက်နိုင်ပါတယ်
- သို့မဟုတ် cluster အသစ် (Atlas M0 ထပ်ဆောက်) တစ်ခုကို `MONGODB_URI` ပြောင်းသုံးပြီး data အသစ်များကို ဒီထဲ ထည့်နိုင်ပါတယ် (data ဟောင်းရော အသစ်ရော ခွဲသိမ်းလိုရင် code ထဲမှာ connection ၂ ခု ခွဲထားရန် ထပ်ပြင်ပေးနိုင်ပါတယ် - အခုတော့ တစ်ခုတည်းနဲ့ ရိုးရိုးထားထားပါတယ်)

## Deploy on Render

1. GitHub repo အသစ်ဆောက်ပြီး ဒီ folder ကို push လုပ်ပါ
2. Render → New → **Web Service** → repo ချိတ်ပါ
3. Build Command: `npm install` / Start Command: `npm start`
4. Environment tab ထဲမှာ `.env.example` ထဲက variable အားလုံး ထည့်ပါ (PORT ကို Render auto ထည့်ပေးမည်)
5. Deploy လုပ်ပါ — bot က long-polling နဲ့ run နေမည် (webhook မလိုပါ)

## Bot ရပ်သွားခြင်း / Render free tier "sleep" ပြဿနာ

Render ရဲ့ **Free** Web Service plan ဟာ ~၁၅ မိနစ် inbound HTTP traffic မရှိရင် instance ကို "sleep" ဖြစ်စေပါတယ် — Telegram bot ကတော့ user message စောင့်နေတဲ့ long-polling process မို့ ဒီလို sleep ဖြစ်သွားရင် bot ရပ်သွားပါတယ်။

ဒါကို ကာကွယ်ဖို့ bot ထဲမှာ **self-ping** ကို built-in ထည့်ထားပါပြီ — `RENDER_EXTERNAL_URL` ဆိုတဲ့ environment variable ကို Render က auto ထည့်ပေးထားမှာမို့ (setup ဘာမှ မလိုပါ) bot က ကိုယ့်ဟာကိုယ် ၄ မိနစ်တိုင်း ping ပေးပြီး Render ကို "traffic ရှိနေတယ်" လို့ မြင်စေမှာပါ။

**နောက်ထပ် အာမခံချက် (recommended)**: [UptimeRobot](https://uptimerobot.com) (free) ကို အသုံးပြုပြီး bot ရဲ့ public URL (ဥပမာ `https://your-bot.onrender.com`) ကို ၅ မိနစ်တိုင်း monitor/ping လုပ်ထားရင် ပိုစိတ်ချရပါတယ် — self-ping တစ်ခုတည်း အလွတ်ချန်မထားပဲ backup ရှိသင့်ပါတယ်။

Bot code ထဲမှာလည်း crash မဖြစ်အောင် (uncaught error/rejection catch, MongoDB disconnect logging) safety net များ ထည့်ထားပါပြီ — ဒါပေမယ့် Render free tier ရဲ့ sleep behavior ကိုတော့ code ထဲကနေ ၁၀၀% မတားနိုင်ပါ (self-ping/UptimeRobot ရှိမှ အာမခံရပါမယ်)။ အမြဲတမ်း ၂၄/၇ အာမခံလိုရင် Render ရဲ့ **paid** plan (sleep မလုပ်တော့ပါ) ကို စဉ်းစားနိုင်ပါတယ်။

## Facebook services

Facebook အတွက် category/service တွေကို ခုနောက်ပိုင်း (နောက်ထပ် message) ထဲမှာ ဆက်ရေးပေးပါမည် လို့ ပြောထားတာကြောင့် အခုအတွက် Telegram/Tiktok ကို ဦးစားပေး ထားပါတယ်။ Facebook အတွက်လည်း အတူတူပဲ `/addid` သုံးပြီး ထည့်လို့ရပါတယ် (platform: `facebook`)။

## Main menu ထဲ button အသစ် ထည့်ခြင်း (ဥပမာ Contact Admin)

```
/addmenubutton ☎️ Contact Admin|https://t.me/YourAdminUsername
```
ဒါက main menu (❤️ရရှိနိုင်သောservice များ❤️,💰လက်ကျန်ငွေ💰...) ရဲ့ အောက်ဆုံးမှာ button အသစ် ထပ်ထည့်ပေးမည်။ User က နှိပ်တာနဲ့ ပေးထားတဲ့ URL ကို ဖွင့်ရန် inline button ကို ပြပေးမည် (Telegram profile link, Facebook page, ဘာ link မဆို ထည့်လို့ရသည်)။ ဖျက်ရန်: `/removemenubutton ☎️ Contact Admin` (label အတိအကျ ကူးရေးပါ)။

## သတိပြုစရာ

- Provider API endpoint URL (`/api/v2` စသည်) က provider dashboard ထဲက "API" page မှာ တိတိကျကျ ပြထားပါလိမ့်မည် — မှန်ကန်မှန်း စစ်ပြီးမှ `.env` ထဲ ထည့်ပါ
- Provider နှစ်ခုစလုံး request/response ပုံစံ standard "Perfect Panel API" အတိုင်း ယူထားပါတယ်။ တကယ်တမ်း ခြားနားနေရင် `providers.js` ထဲက function တွေထဲမှာ ပြင်ရပါမယ်
- MongoDB Atlas free tier က persistent ဖြစ်လို့ Render restart/redeploy တိုင်း data ပျက်စရာ မလိုပါ
