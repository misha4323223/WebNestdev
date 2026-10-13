const EMAIL = "demo@webnestdev.local";
const PASSWORD = "demo1234";

async function post(path, body) {
  const r = await fetch(`http://localhost:8787${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

// 1) регистрация (409 — если уже существует, это ОК)
const reg = await post("/api/auth/register", { email: EMAIL, password: PASSWORD });
console.log("register:", reg.status, reg.body);

// 2) логин — доказательство, что аккаунт живой
const login = await post("/api/auth/login", { email: EMAIL, password: PASSWORD });
console.log("login:", login.status, login.body);

// 3) me с cookie из логина
const setCookie = (await (async () => {
  const r = await fetch("http://localhost:8787/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  return r.headers.get("set-cookie");
})()) ?? "";
const me = await (await fetch("http://localhost:8787/api/auth/me", {
  headers: { Cookie: setCookie.split(";")[0] },
})).json();
console.log("me:", me);
