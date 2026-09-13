// This is just to have a connection pool so that we don't have to create a new connection every time we query the DB

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

module.exports = {
  // we just export two functions: query for simple queries, getClient for transactions
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  end: () => pool.end(),
};
