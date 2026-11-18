// db.js: one small layer so the rest of the server doesn't care where the data lives.
//
//   On your Mac:  the SQLite built into Node, saved in a file called splitter.db.
//   Online:       Turso, a hosted SQLite database. Used when the
//                 TURSO_DATABASE_URL and TURSO_AUTH_TOKEN settings exist.
//
// Both give the same four things, and every one of them is async:
//   all(sql, args)  -> list of rows
//   get(sql, args)  -> first row, or undefined
//   run(sql, args)  -> { changes, lastId }
//   transaction(async function (tx) { ... })  -> everything inside happens fully or not at all

const path = require("node:path");

function openDatabase() {
  if (process.env.TURSO_DATABASE_URL) {
    return openTurso(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN);
  }
  const file = process.env.DB_FILE || path.join(__dirname, "splitter.db");
  return openLocal(file);
}

// ---------- On your Mac: built-in SQLite ----------
function openLocal(file) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);

  const runner = {
    async all(sql, args) {
      return db.prepare(sql).all(...(args || []));
    },
    async get(sql, args) {
      return db.prepare(sql).get(...(args || []));
    },
    async run(sql, args) {
      const result = db.prepare(sql).run(...(args || []));
      return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
    },
  };

  return {
    kind: "SQLite file " + path.basename(file),
    all: runner.all,
    get: runner.get,
    run: runner.run,
    async exec(sql) {
      db.exec(sql);
    },
    async transaction(work) {
      db.exec("BEGIN");
      try {
        const result = await work(runner);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

// ---------- Online: Turso ----------
function openTurso(url, authToken) {
  const { createClient } = require("@libsql/client");
  const client = createClient({ url: url, authToken: authToken });

  // Turso gives rows as lists; turn each into { column: value }
  function toObjects(resultSet) {
    return resultSet.rows.map(function (row) {
      const object = {};
      resultSet.columns.forEach(function (column, index) {
        object[column] = row[index];
      });
      return object;
    });
  }

  function wrap(target) {
    return {
      async all(sql, args) {
        return toObjects(await target.execute({ sql: sql, args: args || [] }));
      },
      async get(sql, args) {
        return toObjects(await target.execute({ sql: sql, args: args || [] }))[0];
      },
      async run(sql, args) {
        const result = await target.execute({ sql: sql, args: args || [] });
        return {
          changes: result.rowsAffected,
          lastId: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
        };
      },
    };
  }

  const runner = wrap(client);

  return {
    kind: "Turso",
    all: runner.all,
    get: runner.get,
    run: runner.run,
    async exec(sql) {
      await client.executeMultiple(sql);
    },
    async transaction(work) {
      const tx = await client.transaction("write");
      try {
        const result = await work(wrap(tx));
        await tx.commit();
        return result;
      } catch (error) {
        try {
          await tx.rollback();
        } catch (ignored) {
          // Already closed
        }
        throw error;
      } finally {
        tx.close();
      }
    },
  };
}

module.exports = { openDatabase };
