export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  // Inject org ID server-side — never exposed to the browser
  const finalQuery = query.replace("$ORG_PLACEHOLDER", process.env.BUFFER_ORG_ID);

  try {
    const response = await fetch("https://api.buffer.com", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.BUFFER_API_KEY}`,
      },
      body: JSON.stringify({ query: finalQuery }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
