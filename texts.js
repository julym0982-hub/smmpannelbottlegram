const { Setting } = require('./models');

// Defaults. ${placeholders} get substituted at send time. Admin can override
// any of these permanently with:  /edittext <key> <new text with ${placeholders}>
const DEFAULTS = {
  kpay_number: process.env.KPAY_NUMBER || '09xxxxxxxxx',
  kpay_name: process.env.KPAY_NAME || 'Your Name',
  wave_number: process.env.WAVE_NUMBER || '09xxxxxxxxx',
  wave_name: process.env.WAVE_NAME || 'Your Name',
  welcome: 'မဂ္ဂလာပါ ${name} ရေ ❤️\nlike/views တိုး bot မှ ကြိုဆိုပါတယ်ရှင့် 😊',
  balance_msg: 'မဂ္ဂလာပါ ${name} လက်ကျန်ငွေ (${balance}) ကျန်ရှိပါသေးတယ်ရှင့် ❤️',
  insufficient_balance: '${name} ရေ လက်ကျန်ငွေ မလုံလောက်ဘူးလို့ ငွေထပ်ဖြည့်ပေးပါနော် 🥰',
  choose_platform: 'မိမိတိုးချင်တဲ့ social media တစ်ခုခု ရွေးပါရှင့် ❤️',
  choose_category: 'ဝန်ဆောင်မှု အမျိုးအစား ရွေးပါရှင့် ❤️',
  choose_service: 'အသေးစိတ် ရွေးပါရှင့် ❤️',
  ask_link: 'တိုးမည့် link လေး ပို့ပေးပါရှင့် 🩷\n\nတင်သည့် post က public ဖြစ်ရပါမယ်နော်\nကြာချိန်လေးကတော့ ${duration}',
  ask_quantity: '*တိုးမည့်အရေအတွက်လေး ပို့ပေးပါရှင့်\nEnglish number နဲ့ ရေးပေးနော် ❤️*',
  ask_quantity_number_hint: 'number (123456...) အသုံးပြုပြီး ရေးပေးပါရှင့်',
  order_confirm: 'ကုန်ကျမည့်ငွေ - ${cost} ကျပ် ကျမှာပါရှင့်',
  order_success: '✅ Order တင်ပြီးပါပြီရှင့် (${cost} ကျပ် နှုတ်ယူပြီးပါပြီ)',
  order_complete: '${link} ဝယ်ယူထားတဲ့ ${service} type က complete ဖြစ်သွားပါပြီရှင့်\nဝယ်ယူမှုအတွက် ကျေးဇူးတင်ပါတယ်ရှင့် ❤️',
  order_cancel_success: '✅ Order ကို cancel လုပ်ပြီး cashback ${cost} ကျပ် ပြန်ထည့်ပေးလိုက်ပါပြီရှင့်',
  order_partial_refund: '⚠️ Order က တစ်စိတ်တစ်ပိုင်းသာ ပြီးမြောက်ခဲ့ပါတယ်ရှင့်။ မပြီးမြောက်ခဲ့တဲ့ ${remains} ခုအတွက် cashback ${amount} ကျပ် ပြန်ထည့်ပေးလိုက်ပါပြီ ❤️',
  order_cancel_fail: 'Order ဆောင်ရွက်လျက်ရှိပါတယ်ရှင့်၊ cancel လုပ်၍ မရတော့ပါ',
  topup_min_amount: process.env.TOPUP_MIN_AMOUNT || '1000', // plain number, not a template
  // provider pricing knobs - plain numbers, not templates. Changeable live
  // via /setrate without touching Render's environment variables at all.
  shweboost_usd_to_mmk: process.env.SHWEBOOST_USD_TO_MMK || '4400',
  shweboost_markup: process.env.SHWEBOOST_MARKUP_MULTIPLIER || '2.3',
  secsers_usd_to_mmk: process.env.SECSERS_USD_TO_MMK || '4400',
  secsers_markup: process.env.SECSERS_MARKUP_MULTIPLIER || '1',
  hiroshi_usd_to_mmk: process.env.HIROSHI_USD_TO_MMK || '4400',
  hiroshi_markup: process.env.HIROSHI_MARKUP_MULTIPLIER || '2.3',
  low_balance_threshold: process.env.LOW_BALANCE_THRESHOLD || '5', // provider balance (USD) below which admins get a Telegram warning; 0 = off
  // ---- feature switches / retention (plain values, edited from the panel)
  help_enabled: '1', // 1 = "Order အကူအညီ" button visible to users, 0 = hidden
  history_auto: '1', // 1 = old finished orders are cleaned automatically every day
  history_keep_days: '5', // finished orders older than this many days are removed...
  history_keep_last: '6', // ...except each user's newest N orders, which always stay
  history_last_cleanup: '',
  // ---- Help Order messages
  help_ask_id: '🆘 Order အကူအညီ\n\nအကူအညီလိုတဲ့ Order ID ကို ရိုက်ထည့်ပေးပါရှင့်၊ (သို့) အောက်က နောက်ဆုံး order တွေထဲကနေ ရွေးပါ 👇',
  help_choose: 'ဘာလေးအဆင်မပြေလဲ ရွေးပေးပါရှင့် ⬇️',
  help_refill_ok: '✅ ပြန်ဖြည့်ပေးရန် စတင်နေပါပြီရှင့်။\n♻️ သင့် Order အား 24 နာရီအတွင်း ပြန်ဖြည့်ပေးပါမည် ❤️',
  help_manual: '✅ တောင်းဆိုမှု လက်ခံပြီးပါပြီရှင့်။ Admin က 24 နာရီအတွင်း ဆောင်ရွက်ပေးပါမယ်၊ ခဏစောင့်ပေးပါနော် ❤️',
  help_speed_done: 'အော်ဒါသည် ပြီးဆုံးသွားပြီဖြစ်သောကြောင့် အမြန်နှုန်းမြှင့်တင်ခြင်း ဆောင်ရွက်ပေးလို့ မရပါရှင့်။',
  help_refill_not_done: 'Order မပြီးသေးသောကြောင့် ပြန်ဖြည့်ပေးရန် မလိုသေးပါရှင့်။ ပြီးဆုံးပြီးနောက် ပြန်ကျသွားရင် တောင်းဆိုပေးပါနော်။',
  help_cancelled: 'ဒီ Order ကို ပယ်ဖျက်ပြီးသားဖြစ်လို့ ဆောင်ရွက်လို့ မရပါရှင့်။',
  help_not_found: '❌ ဒီ Order ID မတွေ့ပါရှင့်။ ကိုယ်မှာထားတဲ့ Order ID ကို ပြန်စစ်ပေးပါနော်။',
  help_cooldown: 'ℹ️ ဒီ Order အတွက် တောင်းဆိုမှု လက်ခံထားပြီးသားပါရှင့်၊ ခဏစောင့်ပေးပါနော်။',
  help_disabled: 'ဒီဝန်ဆောင်မှုကို ခေတ္တပိတ်ထားပါသည်ရှင့်။',
  help_done: '✅ သင့် Order #${orderNo} အတွက် တောင်းဆိုမှုကို ဆောင်ရွက်ပြီးပါပြီရှင့် ❤️',
  topup_min: 'အနည်းဆုံး ${min} ကျပ်မှ စဖြည့်ပါရှင့် ❤️',
  topup_below_min: 'အနည်းဆုံး ${min}ကျပ်မှ ငွေစသွင်းပါရှင့်♥️',
  topup_ask_screenshot: 'ဆီသို့ ငွေလွှဲပြီး screenshot ပို့ပေးပါရှင့်',
  topup_ask_amount: 'ငွေထည့်ထားတဲ့ ပမာဏလေး ရေးပေးပါရှင့် ❤️',
  topup_submitted: 'Admin သို့ ငွေလွှဲထားကြောင်း တင်ပြပေးထားပါတယ်ရှင့် 😊\nခေတ္တခဏ စောင့်ပေးပါနော်',
  topup_success: 'ငွေ (${amount} ကျပ်) ထည့်ခြင်း အောင်မြင်ပါသည်ရှင့် ❤️',
  topup_rejected: '❌ သင့်ငွေဖြည့်တောင်းဆိုမှု (${amount} ကျပ်) ကို လက်မခံနိုင်ပါရှင့်။${reason}\nမှားယွင်းနေသည်ဟု ထင်ပါက Admin ကို ဆက်သွယ်ပေးပါနော်။',
  topup_edited: 'သင်ဖြည့်ထားသောငွေပမာဏမှာ ${amount} ဖြစ်သောကြောင့် သင့်အကောင့်ထဲသို့ ${amount} ကျပ် ထည့်ပေးထားပါတယ်ရှင့် ❤️',
  banned: 'သင့်အကောင့်ကို ယာယီ ပိတ်ထားပါသည်ရှင့်။ Admin ကို ဆက်သွယ်ပါ။'
};

function render(str, vars) {
  return str.replace(/\$\{(\w+)\}/g, (_, key) => (vars && vars[key] !== undefined ? vars[key] : ''));
}

const cache = {};

async function preload() {
  const rows = await Setting.find({});
  for (const r of rows) cache[r._id] = r.value;
}

function getRaw(key) {
  return cache[key] || DEFAULTS[key] || '';
}

function t(key, vars) {
  return render(getRaw(key), vars || {});
}

async function setText(key, value) {
  cache[key] = value;
  await Setting.findByIdAndUpdate(key, { _id: key, value }, { upsert: true });
}

// back to the built-in default (removes the saved override from MongoDB)
async function resetText(key) {
  delete cache[key];
  await Setting.findByIdAndDelete(key);
}

function allKeys() {
  return Object.keys(DEFAULTS);
}

module.exports = { t, getRaw, setText, resetText, preload, allKeys, DEFAULTS };
