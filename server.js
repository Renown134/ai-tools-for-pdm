// «Кто выгуливает Бориса» — этап 3: серверное поведение (запись в слоты, кормление).
// Страница интерфейса — этап 4.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// --- SQLite (схема дословно из spec.md) ---

const DB_FILE = path.join(__dirname, 'boris.db');
const db = new DatabaseSync(DB_FILE);

db.exec(`
CREATE TABLE IF NOT EXISTS walk_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  walk_date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  booked_by TEXT,
  booked_at TEXT,
  UNIQUE (walk_date, slot_time),
  CHECK (
    (booked_by IS NULL AND booked_at IS NULL)
    OR
    (booked_by IS NOT NULL AND booked_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS feedings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_name TEXT NOT NULL,
  fed_at TEXT NOT NULL
);
`);

// Пять фиксированных слотов из spec.md
const SLOT_TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00'];

// Локальная дата сервера в формате YYYY-MM-DD
function localDateISO() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Создать пять записей на текущую дату, если их ещё нет; все слоты свободны.
// Идемпотентна, вызывается на каждом запросе (устойчивость к переходу через полночь).
const insertSlot = db.prepare(
  'INSERT OR IGNORE INTO walk_slots (walk_date, slot_time) VALUES (?, ?)'
);
function ensureTodaySlots(walkDate) {
  for (const slotTime of SLOT_TIMES) {
    insertSlot.run(walkDate, slotTime);
  }
}

// --- Подготовленные запросы ---

const selectSlots = db.prepare(
  'SELECT slot_time, booked_by FROM walk_slots WHERE walk_date = ? ORDER BY slot_time'
);
const selectSlot = db.prepare(
  'SELECT slot_time, booked_by FROM walk_slots WHERE walk_date = ? AND slot_time = ?'
);

// Атомарная запись: UPDATE меняет только свободный слот.
// Решение принимает сам UPDATE по условию booked_by IS NULL — отдельное
// «прочитать, свободен ли слот, и потом записать» не используется.
const bookSlot = db.prepare(`
  UPDATE walk_slots
  SET booked_by = ?, booked_at = ?
  WHERE walk_date = ? AND slot_time = ? AND booked_by IS NULL
`);

const insertFeeding = db.prepare(
  'INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)'
);
const selectLatestFeeding = db.prepare(
  'SELECT employee_name, fed_at FROM feedings ORDER BY id DESC LIMIT 1'
);

// --- HTTP-хелперы ---

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBodyJSON(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Некорректный JSON в теле запроса'));
      }
    });
    req.on('error', reject);
  });
}

// ФИО непустое после удаления лишних пробелов (spec.md)
function normalizedName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// --- Маршруты ---

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /api/slots') {
      const walkDate = localDateISO();
      ensureTodaySlots(walkDate);
      return sendJSON(res, 200, { walk_date: walkDate, slots: selectSlots.all(walkDate) });
    }

    if (route === 'POST /api/slots/book') {
      const walkDate = localDateISO();
      ensureTodaySlots(walkDate);

      const body = await readBodyJSON(req);
      const name = normalizedName(body.name);
      const slotTime = typeof body.slot_time === 'string' ? body.slot_time : '';

      if (!name) {
        return sendJSON(res, 400, { error: 'Укажите ФИО: значение не должно быть пустым' });
      }
      if (!SLOT_TIMES.includes(slotTime)) {
        return sendJSON(res, 404, { error: `Неизвестное время слота: ${slotTime || '(пусто)'}` });
      }

      const result = bookSlot.run(name, new Date().toISOString(), walkDate, slotTime);
      if (result.changes === 1) {
        return sendJSON(res, 200, { ok: true, slot: selectSlot.get(walkDate, slotTime) });
      }

      // UPDATE ничего не изменил — слот уже занят.
      // SELECT нужен только для понятного сообщения, решение приняла атомарная операция.
      const occupied = selectSlot.get(walkDate, slotTime);
      return sendJSON(res, 409, {
        error: `Слот ${slotTime} уже занят (${occupied.booked_by}). Выберите другой слот.`,
        slot: occupied,
      });
    }

    if (route === 'POST /api/feedings') {
      const body = await readBodyJSON(req);
      const name = normalizedName(body.name);
      if (!name) {
        return sendJSON(res, 400, { error: 'Укажите ФИО: значение не должно быть пустым' });
      }
      const fedAt = new Date().toISOString();
      insertFeeding.run(name, fedAt);
      return sendJSON(res, 200, { ok: true, feeding: { employee_name: name, fed_at: fedAt } });
    }

    if (route === 'GET /api/feedings/latest') {
      return sendJSON(res, 200, { feeding: selectLatestFeeding.get() || null });
    }

    if (route === 'GET /') {
      // Страница интерфейса
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    return sendJSON(res, 404, { error: 'Не найдено' });
  } catch (err) {
    return sendJSON(res, 400, { error: err.message || 'Некорректный запрос' });
  }
});

server.listen(PORT, () => {
  console.log(`Приложение запущено: http://localhost:${PORT}`);
  console.log(`База данных: ${DB_FILE}`);
});
