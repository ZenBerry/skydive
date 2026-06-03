const crypto = require("crypto");

const uploadFolder = (process.env.CLOUDINARY_UPLOAD_FOLDER || "skydive/files").trim();

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function getCredentials() {
  return {
    cloudName: (process.env.CLOUDINARY_CLOUD_NAME || "").trim(),
    apiKey: (process.env.CLOUDINARY_API_KEY || "").trim(),
    apiSecret: (process.env.CLOUDINARY_API_SECRET || "").trim()
  };
}

function signParams(params, apiSecret) {
  const serialized = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto
    .createHash("sha1")
    .update(`${serialized}${apiSecret}`)
    .digest("hex");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  const { cloudName, apiKey, apiSecret } = getCredentials();
  if (!cloudName || !apiKey || !apiSecret) {
    return json(503, { error: "Cloudinary credentials are not configured." });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const uploadParams = {
    folder: uploadFolder,
    timestamp,
    unique_filename: "true",
    use_filename: "true"
  };

  return json(200, {
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/auto/upload`,
    params: {
      ...uploadParams,
      api_key: apiKey,
      signature: signParams(uploadParams, apiSecret)
    }
  });
};
