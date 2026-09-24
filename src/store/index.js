'use strict';

const { SupabaseStore } = require('./supabase');
const { MemoryStore } = require('./memory');

function createStore(config, logger = console) {
  if (config.storeKind === 'supabase') {
    if (!config.supabaseUrl || !config.supabaseKey) {
      throw new Error('STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
    return new SupabaseStore({ url: config.supabaseUrl, key: config.supabaseKey });
  }
  logger.warn('[tra5x] Using the in-memory store: data is lost on restart. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to persist history.');
  return new MemoryStore();
}

module.exports = { createStore };
