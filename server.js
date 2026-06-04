const express = require("express");
const axios = require("axios");

const app = express();

// ВАЖНО: принимаем и JSON, и raw body (amoCRM может слать с разным Content-Type)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/*" }));
app.use(express.raw({ type: "*/*" }));

const PORT = process.env.PORT || 3000;

const AMO_DOMAIN = process.env.AMO_DOMAIN;
const ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN;

const TYPE_REQUEST_FIELD_ID = 466253;
const REJECT_REASON_FIELD_ID = 573457;

const TYPE_TECHNICAL_ENUM_ID = 978137;
const NDZ_GT_3_ENUM_ID = 976779;

// В продакшене лучше использовать Redis/БД, а не Set в памяти
const processedLeads = new Set();

// Универсальный парсер тела запроса
function parseBody(req) {
  // Если уже распарсилось как JSON
  if (typeof req.body === "object" && req.body !== null && Object.keys(req.body).length > 0) {
    return req.body;
  }
  // Если пришёл raw Buffer или строка
  const raw = typeof req.body === "string" ? req.body : req.body?.toString("utf-8");
  if (raw && raw.trim().startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error("JSON parse error:", e.message);
    }
  }
  return null;
}

// Извлекаем массив сделок из разных форматов вебхука amoCRM
function extractLeads(body) {
  if (!body) return [];

  // Формат 1: массив (новый API / JSON)
  // {"leads": {"add": [{...}, {...}]}}
  const leadsArr =
    body?.leads?.status ||
    body?.leads?.update ||
    body?.leads?.add;

  if (Array.isArray(leadsArr) && leadsArr.length > 0) {
    return leadsArr;
  }

  // Формат 2: объект с числовыми ключами (x-www-form-urlencoded)
  // {"leads": {"add": {"0": {...}, "1": {...}}}}
  if (typeof leadsArr === "object" && leadsArr !== null) {
    return Object.values(leadsArr);
  }

  return [];
}

app.post("/webhook/amo", async (req, res) => {
  // ВАЖНО: логируем каждый входящий запрос
  console.log("=== WEBHOOK RECEIVED ===");
  console.log("Headers:", JSON.stringify(req.headers));
  console.log("Raw body type:", typeof req.body);

  try {
    const body = parseBody(req);
    console.log("Parsed body:", JSON.stringify(body, null, 2));

    const leads = extractLeads(body);
    console.log(`Extracted ${leads.length} leads`);

    if (!leads.length) {
      console.log("No leads found in webhook, returning 200");
      return res.sendStatus(200);
    }

    for (const lead of leads) {
      const leadId = lead.id || lead?.lead_id;
      console.log(`\n--- Processing lead #${leadId} ---`);

      if (!leadId) {
        console.log("No lead ID, skipping");
        continue;
      }
      if (processedLeads.has(leadId)) {
        console.log(`Lead #${leadId} already processed, skipping`);
        continue;
      }

      // Получаем ВСЕ примечания с пагинацией
      let allNotes = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const notesRes = await axios.get(
          `https://${AMO_DOMAIN}/api/v4/leads/${leadId}/notes`,
          {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
            params: {
              limit: 250,
              page,
              "filter[note_type]": "call_out" // сразу фильтруем только исходящие звонки
            }
          }
        );

        const notes = notesRes.data?._embedded?.notes || [];
        console.log(`Page ${page}: got ${notes.length} call_out notes`);

        allNotes = allNotes.concat(notes);

        // Проверяем, есть ли ещё страницы
        const totalPages = notesRes.data?._links?.pages?.last?.href
          ? parseInt(new URL(notesRes.data._links.pages.last.href).searchParams.get("page"))
          : page;
        hasMore = page < totalPages;
        page++;
      }

      console.log(`Total call_out notes for lead #${leadId}: ${allNotes.length}`);

      // Считаем короткие звонки (0-30 сек)
      let shortCalls = 0;
      for (const note of allNotes) {
        const duration = Number(note.params?.duration || 0);
        console.log(`  Note #${note.id}: duration=${duration}s`);
        if (duration <= 30) {
          shortCalls++;
        }
      }

      console.log(`Short calls (<=30s): ${shortCalls}`);

      if (shortCalls >= 3) {
        console.log(`>>> Setting fields for lead #${leadId}`);
        try {
          const patchRes = await axios.patch(
            `https://${AMO_DOMAIN}/api/v4/leads/${leadId}`,
            {
              custom_fields_values: [
                {
                  field_id: TYPE_REQUEST_FIELD_ID,
                  values: [{ enum_id: TYPE_TECHNICAL_ENUM_ID }]
                },
                {
                  field_id: REJECT_REASON_FIELD_ID,
                  values: [{ enum_id: NDZ_GT_3_ENUM_ID }]
                }
              ]
            },
            {
              headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
            }
          );
          console.log(`PATCH response status: ${patchRes.status}`);
          processedLeads.add(leadId);
        } catch (patchErr) {
          console.error(`PATCH error for lead #${leadId}:`, patchErr.response?.data || patchErr.message);
        }
      } else {
        console.log(`Not enough short calls for lead #${leadId}, skipping`);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK ERROR:", e.response?.data || e.message);
    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("amoCRM NDZ automation running");
});

app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
