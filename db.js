const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

function defaultData() {
  return {
    users: {},     // telegramId -> { id, username, firstName, balance, banned, createdAt }
    orders: [],    // { orderId, userId, service, amount, status, createdAt }
    coupons: {},   // code -> { amount, remaining, createdAt }
    services: {},  // platform -> [ { id, name, price, min, max } ]  (added later via /+id)
    nextOrderId: 1
};
}

let cache = null;
let writeQueue = Promise.resolve();

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch (e) {
    cache = defaultData();
  }
  // fill in missing fields for older data files
  const d = defaultData();
  for (const k of Object.keys(d)) {
    if (!(k in cache)) cache[k] = d[k];
  }
  return cache;
}

function save() {
  // serialize writes so concurrent calls don't corrupt the file
  writeQueue = writeQueue.then(() => {
    return new Promise((resolve) => {
      fs.writeFile(DATA_FILE, JSON.stringify(cache, null, 2), (err) => {
        if (err) console.error('DB write error:', err);
        resolve();
      });
    });
  });
  return writeQueue;
}

function getUser(id, username, firstName) {
  const data = load();
  const key = String(id);
  if (!data.users[key]) {
    data.users[key] = {
      id: key,
      username: username || '',
      firstName: firstName || '',
      balance: 0,
      banned: false,
      createdAt: new Date().toISOString()
    };
    save();
  } else {
    // keep username/firstName fresh
    if (username && data.users[key].username !== username) data.users[key].username = username;
    if (firstName && data.users[key].firstName !== firstName) data.users[key].firstName = firstName;
  }
  return data.users[key];
}

function allUsers() {
  return Object.values(load().users);
}

function setBalance(id, amount) {
  const data = load();
  const key = String(id);
  if (!data.users[key]) return null;
  data.users[key].balance = amount;
  save();
  return data.users[key];
}

function addBalance(id, delta) {
  const data = load();
  const key = String(id);
  if (!data.users[key]) return null;
  data.users[key].balance = Math.round((data.users[key].balance + delta) * 100) / 100;
  save();
  return data.users[key];
}

function setBanned(id, banned) {
  const data = load();
  const key = String(id);
  if (!data.users[key]) return null;
  data.users[key].banned = banned;
  save();
  return data.users[key];
}

function addOrder(order) {
  const data = load();
  const id = data.nextOrderId++;
  const record = Object.assign({ orderId: id, createdAt: new Date().toISOString() }, order);
  data.orders.push(record);
  save();
  return record;
}

function removeOrder(orderId) {
  const data = load();
  const before = data.orders.length;
  data.orders = data.orders.filter(o => String(o.orderId) !== String(orderId));
  save();
  return data.orders.length !== before;
}

function allOrders() {
  return load().orders;
}

function ordersForUser(id) {
  return load().orders.filter(o => String(o.userId) === String(id));
}

function addCoupon(code, amount, maxUses) {
  const data = load();
  data.coupons[code] = { amount, remaining: maxUses, createdAt: new Date().toISOString() };
  save();
  return data.coupons[code];
}

function getCoupon(code) {
  return load().coupons[code];
}

function useCoupon(code) {
  const data = load();
  const c = data.coupons[code];
  if (!c || c.remaining <= 0) return null;
  c.remaining -= 1;
  save();
  return c;
}

function getServices(platform) {
  const data = load();
  return data.services[platform] || [];
}

function addService(platform, service) {
  const data = load();
  if (!data.services[platform]) data.services[platform] = [];
  data.services[platform].push(service);
  save();
  return service;
}

function removeService(platform, serviceId) {
  const data = load();
  if (!data.services[platform]) return false;
  const before = data.services[platform].length;
  data.services[platform] = data.services[platform].filter(s => String(s.id) !== String(serviceId));
  save();
  return data.services[platform].length !== before;
}

module.exports = {
  load, save, getUser, allUsers, setBalance, addBalance, setBanned,
  addOrder, removeOrder, allOrders, ordersForUser,
  addCoupon, getCoupon, useCoupon,
  getServices, addService, removeService
};
