const DEFAULT_SHEET_ID = "1Oalb_TLXZmI6jJXGhiBGngUOP-ubzg7OHrOtHFrRyCk";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ env }) {
  if (!env.GOOGLE_API_KEY) {
    return json({ error: "Google Sheets is not configured." }, 503);
  }

  const sheetId = env.GOOGLE_SHEET_ID || DEFAULT_SHEET_ID;
  const range = encodeURIComponent("roster!A1:G50");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${env.GOOGLE_API_KEY}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || !Array.isArray(data.values) || data.values.length < 2) {
      return json({ error: "The roster could not be read." }, 502);
    }

    const [headingRow, ...rows] = data.values;
    const headings = headingRow.map((heading) => String(heading).trim().toLowerCase());
    const column = {
      name: headings.findIndex((heading) => heading.includes("agent") || heading.includes("name")),
      slackId: headings.findIndex((heading) => heading.includes("slack") || heading.includes("member")),
      status: headings.findIndex((heading) => heading === "status"),
      start: headings.findIndex((heading) => heading.includes("shift start") || heading === "start"),
      end: headings.findIndex((heading) => heading.includes("shift end") || heading === "end"),
    };

    if (column.name < 0 || column.slackId < 0) {
      return json({ error: "The roster is missing its agent or Slack ID column." }, 422);
    }

    const agents = rows
      .filter((row) => /^U[A-Z0-9]+$/.test(String(row[column.slackId] || "")))
      .map((row) => ({
        name: String(row[column.name] || "").trim(),
        slackId: String(row[column.slackId] || "").trim(),
        status: String(row[column.status] || "Active").trim(),
        shiftStart: String(row[column.start] || "09:00").trim(),
        shiftEnd: String(row[column.end] || "18:00").trim(),
      }));

    return json(agents);
  } catch {
    return json({ error: "Google Sheets is temporarily unavailable." }, 502);
  }
}
