function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async () => {
  const supabaseUrl = typeof process.env.SUPABASE_URL === "string" ? process.env.SUPABASE_URL.trim() : "";
  const supabaseAnonKey = typeof process.env.SUPABASE_ANON_KEY === "string" ? process.env.SUPABASE_ANON_KEY.trim() : "";
  const supabasePublishableKey = typeof process.env.SUPABASE_PUBLISHABLE_KEY === "string" ? process.env.SUPABASE_PUBLISHABLE_KEY.trim() : "";
  const supabaseKey = supabasePublishableKey || supabaseAnonKey;

  if (!supabaseUrl || !supabaseKey) {
    return json(200, { enabled: false });
  }

  return json(200, {
    enabled: true,
    supabaseUrl,
    supabaseAnonKey: supabaseKey
  });
};
