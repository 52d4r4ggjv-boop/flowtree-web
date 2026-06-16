(function initializeFlowTreeCloud() {
  const config = window.FLOWTREE_CONFIG || {};
  let client = null;

  function isConfigured() {
    return Boolean(config.supabaseUrl && config.supabaseAnonKey);
  }

  function getClient() {
    if (!isConfigured()) return null;
    if (!window.supabase?.createClient) {
      throw new Error("Supabase client library did not load.");
    }
    if (!client) {
      client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    }
    return client;
  }

  window.FlowTreeCloud = {
    config,
    isConfigured,
    getClient,
  };
})();
