const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  _id: { type: String }, // telegram id as string
  username: String,
  firstName: String,
  balance: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  banned: { type: Boolean, default: false },
  discount: { type: Number, default: 0, min: 0, max: 100 }, // personal reseller discount in % (set from the admin panel)
  note: String, // private admin note, never shown to the user
  createdAt: { type: Date, default: Date.now }
});

// One platform (Telegram, Tiktok, Facebook...) has many categories.
// A category is one of the buttons shown after picking a platform,
// e.g. "Reaction တိုးရန်❤️" or "Views တိုးရန်👀" or "Tiktok like👍".
// A "home button" - the very first row of buttons shown after tapping
// ❤️ရရှိနိုင်သောservice များ❤️ (e.g. "Telegram Service", "Tiktok Service").
// Kept as its own collection (not just derived from Category) so an admin
// can create the home button BEFORE any category/service exists under it.
const PlatformSchema = new mongoose.Schema({
  _id: { type: String }, // short key used internally, e.g. "telegram"
  label: { type: String, required: true }, // what the button actually says
  createdAt: { type: Date, default: Date.now }
});

const CategorySchema = new mongoose.Schema({
  platform: { type: String, required: true, index: true }, // e.g. "telegram", "tiktok", "facebook"
  label: { type: String, required: true },    // button text shown to users
  createdAt: { type: Date, default: Date.now }
});
CategorySchema.index({ platform: 1, label: 1 });

// A service lives inside a category. If a category has only ONE service,
// the user skips straight to the link/quantity flow when they tap the
// category button. If it has MORE than one, the user sees another row of
// buttons (e.g. all the reaction emojis) to pick the exact service.
const ServiceSchema = new mongoose.Schema({
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
  label: { type: String, required: true },       // button text, e.g. "♥️" or "👍♥️🔥😁🎉 +Views"
  provider: { type: String, enum: ['shweboost', 'secsers', 'hiroshi'], required: true },
  providerServiceId: { type: String, required: true },
  // cached from the provider's "services" API endpoint so we don't have to
  // call it on every single order (refreshed by /syncservices)
  providerName: String,
  rate: Number,     // provider's cost per 1000, in the provider's own currency
  min: Number,
  max: Number,
  avgTime: String,
  active: { type: Boolean, default: true }, // admin panel can hide a service without deleting it
  manualDuration: String, // admin-set override, e.g. "18 မိနစ်" - used when the provider API gives no duration at all (ShweBoost never does)
  lastSynced: Date,
  createdAt: { type: Date, default: Date.now }
});

// Extra custom buttons admin can add to the bottom of the main menu
// (e.g. "Contact Admin" that opens a link to the admin's Telegram chat).
const MenuButtonSchema = new mongoose.Schema({
  _id: { type: String }, // the label itself, e.g. "☎️ Contact Admin"
  url: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const OrderSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
  platform: String,
  categoryLabel: String,
  serviceLabel: String,
  provider: String,
  providerOrderId: String,
  link: String,
  quantity: Number,
  cost: Number, // MMK charged to the user's balance
  baseCost: Number, // MMK the provider charges us (before markup) - used for profit stats
  refundAmount: { type: Number, default: 0 }, // MMK returned to the user (cancel / partial)
  status: { type: String, default: 'pending', index: true }, // pending/in progress/completed/cancelled/partial/error
  refunded: { type: Boolean, default: false }, // guards against double refund on cancel
  startCount: Number,
  remains: Number,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const CouponSchema = new mongoose.Schema({
  _id: { type: String }, // the code itself
  amount: Number,
  remaining: Number,
  usedBy: { type: [String], default: [] }, // telegram user ids that already redeemed this code - each person can only use a given code ONCE
  createdAt: { type: Date, default: Date.now }
});

// simple editable-text store so admin can change any bot message without
// touching code - value may contain ${placeholders} that get filled in at
// send-time (see texts.js)
const SettingSchema = new mongoose.Schema({
  _id: { type: String }, // the text key, e.g. "welcome"
  value: String
});

// Every top-up request is stored so it can be accepted / rejected / edited
// from BOTH the Telegram admin notification and the web admin panel. The
// atomic pending -> approved/rejected transition is what prevents a
// double credit when both places are clicked.
const DepositSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  method: String, // KPay / Wave
  amount: { type: Number, required: true }, // amount the user claims (or the admin edited it to)
  requestedAmount: Number, // original amount typed by the user
  screenshotFileId: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  handledBy: String, // "panel" or "bot:<adminTelegramId>"
  note: String, // reject reason
  adminMessages: { type: [{ chatId: String, messageId: Number }], default: [] }, // Telegram notifications to refresh once handled
  createdAt: { type: Date, default: Date.now, index: true },
  handledAt: Date
});

const AdminLogSchema = new mongoose.Schema({
  admin: String,
  action: String,
  detail: String,
  createdAt: { type: Date, default: Date.now, index: true }
});

module.exports = {
  Deposit: mongoose.model('Deposit', DepositSchema),
  AdminLog: mongoose.model('AdminLog', AdminLogSchema),
  MenuButton: mongoose.model('MenuButton', MenuButtonSchema),
  Platform: mongoose.model('Platform', PlatformSchema),
  User: mongoose.model('User', UserSchema),
  Category: mongoose.model('Category', CategorySchema),
  Service: mongoose.model('Service', ServiceSchema),
  Order: mongoose.model('Order', OrderSchema),
  Coupon: mongoose.model('Coupon', CouponSchema),
  Setting: mongoose.model('Setting', SettingSchema)
};
