const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  _id: { type: String }, // telegram id as string
  username: String,
  firstName: String,
  balance: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  banned: { type: Boolean, default: false },
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
  platform: { type: String, required: true }, // e.g. "telegram", "tiktok", "facebook"
  label: { type: String, required: true },    // button text shown to users
  createdAt: { type: Date, default: Date.now }
});

// A service lives inside a category. If a category has only ONE service,
// the user skips straight to the link/quantity flow when they tap the
// category button. If it has MORE than one, the user sees another row of
// buttons (e.g. all the reaction emojis) to pick the exact service.
const ServiceSchema = new mongoose.Schema({
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  label: { type: String, required: true },       // button text, e.g. "♥️" or "👍♥️🔥😁🎉 +Views"
  provider: { type: String, enum: ['shweboost', 'secsers'], required: true },
  providerServiceId: { type: String, required: true },
  // cached from the provider's "services" API endpoint so we don't have to
  // call it on every single order (refreshed by /syncservices)
  providerName: String,
  rate: Number,     // provider's cost per 1000, in the provider's own currency
  min: Number,
  max: Number,
  avgTime: String,
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
  userId: { type: String, required: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
  platform: String,
  categoryLabel: String,
  serviceLabel: String,
  provider: String,
  providerOrderId: String,
  link: String,
  quantity: Number,
  cost: Number, // MMK charged to the user's balance
  status: { type: String, default: 'pending' }, // pending/in progress/completed/cancelled/partial/error
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
  createdAt: { type: Date, default: Date.now }
});

// simple editable-text store so admin can change any bot message without
// touching code - value may contain ${placeholders} that get filled in at
// send-time (see texts.js)
const SettingSchema = new mongoose.Schema({
  _id: { type: String }, // the text key, e.g. "welcome"
  value: String
});

module.exports = {
  MenuButton: mongoose.model('MenuButton', MenuButtonSchema),
  Platform: mongoose.model('Platform', PlatformSchema),
  User: mongoose.model('User', UserSchema),
  Category: mongoose.model('Category', CategorySchema),
  Service: mongoose.model('Service', ServiceSchema),
  Order: mongoose.model('Order', OrderSchema),
  Coupon: mongoose.model('Coupon', CouponSchema),
  Setting: mongoose.model('Setting', SettingSchema)
};
