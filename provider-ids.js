// Single source of truth for the supplier ids the bot knows about.
// (Kept in its own tiny file so models.js can use it without a circular
// require: providers.js -> texts.js -> models.js.)
//
// To add another Perfect-Panel-style supplier later:
//   1. add its id here
//   2. add a block in providers.js CONFIG
//   3. add <id>_usd_to_mmk / <id>_markup defaults in texts.js
// Everything else (models, /addbutton, /setrate, admin panel, balance alerts)
// reads this list.
module.exports = ['shweboost', 'secsers', 'hiroshi', 'morethanpanel'];
