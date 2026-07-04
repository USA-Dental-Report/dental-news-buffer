export const config = {
  matcher: "/((?!favicon.ico).*)",
};

export default function middleware(req) {
  const auth = req.headers.get("authorization");

  if (auth?.startsWith("Basic ")) {
    const [user, pass] = atob(auth.slice(6)).split(":");
    if (user === process.env.BASIC_AUTH_USER && pass === process.env.BASIC_AUTH_PASSWORD) {
      return;
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="USA Dental Report"' },
  });
}
