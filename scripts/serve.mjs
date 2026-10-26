import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.join(process.cwd(), "dist");
const port = Number(process.env.PORT || 4173);

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".json", "application/json; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) file = path.join(root, "404.html");
  const type = TYPES.get(path.extname(file)) || "application/octet-stream";
  response.writeHead(fs.existsSync(file) ? 200 : 404, { "content-type": type });
  fs.createReadStream(file).pipe(response);
});

server.listen(port, () => {
  console.log(`Serving ${root} on http://127.0.0.1:${port}/`);
});
