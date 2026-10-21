// База данных на встроенном в Node.js модуле node:sqlite (Node 22.13+).
// Ничего не нужно компилировать — работает одинаково на Windows, macOS и Linux.
// Обёртка повторяет нужную нам часть API better-sqlite3: prepare/get/all/run, exec, transaction.

// Убираем предупреждение «SQLite is an experimental feature» — модуль стабилен для наших задач
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return originalEmitWarning.call(process, warning, ...args);
};

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error(`\nДля Brand Store нужен Node.js 22.13 или новее (сейчас ${process.version}).`);
  console.error('Скачайте версию LTS с https://nodejs.org, установите и запустите сайт снова.\n');
  process.exit(1);
}

// Имена именованных параметров (@name, :name, $name) без учёта строк в кавычках
function namedParams(sql) {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
  const names = new Set();
  for (const m of stripped.matchAll(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  return [...names];
}

function fix(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);
}

class Statement {
  constructor(raw, sql) {
    this.raw = raw;
    this.names = namedParams(sql);
  }

  bind(args) {
    if (args.length === 1 && isPlainObject(args[0])) {
      if (!this.names.length) return [];
      const src = args[0];
      const out = {};
      for (const n of this.names) out[n] = fix(src[n]);
      return [out];
    }
    return args.map(fix);
  }

  get(...args) { return this.raw.get(...this.bind(args)); }
  all(...args) { return this.raw.all(...this.bind(args)); }
  run(...args) {
    const r = this.raw.run(...this.bind(args));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
}

class Database {
  constructor(file) {
    this.raw = new DatabaseSync(file);
    this.cache = new Map();
    this.depth = 0;
  }

  prepare(sql) {
    let st = this.cache.get(sql);
    if (!st) {
      st = new Statement(this.raw.prepare(sql), sql);
      if (this.cache.size < 500) this.cache.set(sql, st);
    }
    return st;
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  // Как в better-sqlite3: db.transaction(fn) возвращает функцию, которая выполняет fn в транзакции
  transaction(fn) {
    return (...args) => {
      const sp = `sp${this.depth}`;
      this.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth += 1;
      try {
        const result = fn(...args);
        this.depth -= 1;
        this.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (e) {
        this.depth -= 1;
        this.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
    };
  }

  close() {
    this.raw.close();
  }
}

module.exports = Database;
