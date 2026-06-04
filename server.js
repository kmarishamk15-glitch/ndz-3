
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const AMO_DOMAIN = process.env.AMO_DOMAIN;
const ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN;

// Поля amoCRM
const TYPE_REQUEST_FIELD_ID = 466253;   // Тип запроса
const REJECT_REASON_FIELD_ID = 573457;  // Причина отказа

// Значения списков
const TYPE_TECHNICAL_ENUM_ID = 978137;  // Нецелевой/техника
const NDZ_GT_3_ENUM_ID = 976779;        // Нецелевой ндз>3

// защита от повторного проставления
const processedLeads = new Set();

app.post("/webhook/amo", async (req, res) => {
  try {
    const body = req.body;

    // amoCRM шлёт массив событий
    const leads = body?.leads?.status || body?.leads?.update || body?.leads?.add;

    if (!leads || !leads.length) {
      return res.sendStatus(200);
    }

    for (const lead of leads) {
      const leadId = lead.id;

      if (!leadId) continue;
      if (processedLeads.has(leadId)) continue;

      // получаем звонки сделки
      const notesRes = await axios.get(
        `https://${AMO_DOMAIN}/api/v4/leads/${leadId}/notes`,
        {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`
          }
        }
      );

      const notes = notesRes.data._embedded?.notes || [];

      // считаем короткие исходящие звонки
      let shortCalls = 0;

      for (const note of notes) {
        if (note.note_type !== "call_out") continue;

        const duration =
          Number(note.params?.duration || note.params?.call_duration || 0);

        if (duration <= 30) {
          shortCalls++;
        }
      }

      if (shortCalls >= 3) {
        await axios.patch(
          `https://${AMO_DOMAIN}/api/v4/leads/${leadId}`,
          {
            custom_fields_values: [
              {
                field_id: TYPE_REQUEST_FIELD_ID,
                values: [
                  {
                    enum_id: TYPE_TECHNICAL_ENUM_ID
                  }
                ]
              },
              {
                field_id: REJECT_REASON_FIELD_ID,
                values: [
                  {
                    enum_id: NDZ_GT_3_ENUM_ID
                  }
                ]
              }
            ]
          },
          {
            headers: {
              Authorization: `Bearer ${ACCESS_TOKEN}`
            }
          }
        );

        processedLeads.add(leadId);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error(e.response?.data || e.message);
    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("amoCRM NDZ automation running");
});

app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});

