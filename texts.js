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
  topup_min: 'အနည်းဆုံး ${min} ကျပ်မှ စဖြည့်ပါရှင့် ❤️',
  topup_below_min: 'အနည်းဆုံး ${min}ကျပ်မှ ငွေစသွင်းပါရှင့်♥️',
  topup_ask_screenshot: 'ဆီသို့ ငွေလွှဲပြီး screenshot ပို့ပေးပါရှင့်',
  topup_ask_amount: 'ငွေထည့်ထားတဲ့ ပမာဏလေး ရေးပေးပါရှင့် ❤️',
  topup_submitted: 'Admin သို့ ငွေလွှဲထားကြောင်း တင်ပြပေးထားပါတယ်ရှင့် 😊\nခေတ္တခဏ စောင့်ပေးပါနော်',
  topup_success: 'ငွေ (${amount} ကျပ်) ထည့်ခြင်း အောင်မြင်ပါသည်ရှင့် ❤️',
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

function allKeys() {
  return Object.keys(DEFAULTS);
}

module.exports = { t, setText, preload, allKeys, DEFAULTS };
