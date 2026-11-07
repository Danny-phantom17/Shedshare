module.exports = function handler(_request, response) {
  const productionApiOrigin = process.env.VERCEL_ENV === "production"
    ? "https://shedshare-production.up.railway.app"
    : "";
  const apiBaseUrl = String(process.env.SHEDSHARE_API_BASE_URL || productionApiOrigin).trim().replace(/\/+$/, "");
  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (apiBaseUrl && !/^https:\/\//i.test(apiBaseUrl)) {
    response.statusCode = 500;
    response.end('window.SHEDSHARE_CONFIG = Object.freeze({ apiBaseUrl: "" });');
    return;
  }
  response.statusCode = 200;
  response.end(`window.SHEDSHARE_CONFIG = Object.freeze({ apiBaseUrl: ${JSON.stringify(apiBaseUrl)} });`);
};
