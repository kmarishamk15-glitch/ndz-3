const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/*" }));
app.use(express.raw({ type: "*/*" }));

const PORT = process.env.PORT || 3000;

const rawDomain = process.env.AMO_DOMAIN || "";
const AMO_DOMAIN = rawDomain.endsWith(".amocrm.ru")
  ? rawDomain
  : `${rawDomain}.amocrm.ru`;

const ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN;

const TYPE_REQUEST_FIELD_ID = 466253;
const REJECT_REASON_FIELD_ID = 573457;
const TYPE_TECHNICAL_ENUM_ID = 978137;
const NDZ_GT_3_ENUM_ID = 976779;

const processedLeads = new Set();

function parseBody(req) {
  if (typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)) {
    if (Object.keys(req.body).length > 0) {
      return req.body;
    }
  }

  const raw =
    typeof req.body === "string"
      ? req.body
      : Buffer.isBuffer(req.body)
      ? req.body.toString("utf-8")
      : "";

  if (raw && raw.trim().startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error("JSON parse error:", e.message);
    }
  }

  if (typeof req.body === "object") {
    if (typeof req.body.data === "string") {
      try {
        return JSON.parse(req.body.data);
      } catch (e) {
        console.error("JSON parse from data error:", e.message);
      }
    }
    if (Object.keys(req.body).length > 0) {
      return req.body;
    }
  }

  return null;
}

// Извлекаем сделки из вебхука (поддержка разных форматов)
function extractLeads(body) {
  if (!body) return [];

  // Прямой массив сделок
  const leadsArr =
    body?.leads?.status ||
    body?.leads?.update ||
    body?.leads?.add;

  if (Array.isArray(leadsArr) && leadsArr.length > 0) {
    return leadsArr.map(lead => ({ ...lead, entityType: 'lead' }));
  }

  if (typeof leadsArr === "object" && leadsArr !== null) {
    return Object.values(leadsArr).map(lead => ({ ...lead, entityType: 'lead' }));
  }

  return [];
}

// Извлекаем сущности из вебхука примечаний
function extractEntitiesFromNotes(body) {
  const entities = [];

  // Примечания в сделках
  if (body?.leads?.notes) {
    const leadsNotes = Array.isArray(body.leads.notes)
      ? body.leads.notes
      : Object.values(body.leads.notes);
    entities.push(...leadsNotes.map(note => ({ ...note, entityType: 'lead' })));
  }

  // Примечания в контактах
  if (body?.contacts?.notes) {
    const contactsNotes = Array.isArray(body.contacts.notes)
      ? body.contacts.notes
      : Object.values(body.contacts.notes);
    entities.push(...contactsNotes.map(note => ({ ...note, entityType: 'contact' })));
  }

  // Примечания в компаниях
  if (body?.companies?.notes) {
    const companiesNotes = Array.isArray(body.companies.notes)
      ? body.companies.notes
      : Object.values(body.companies.notes);
    entities.push(...companiesNotes.map(note => ({ ...note, entityType: 'company' })));
  }

  // Примечания в покупателях (это тоже leads)
  if (body?.customers?.notes) {
    const customersNotes = Array.isArray(body.customers.notes)
      ? body.customers.notes
      : Object.values(body.customers.notes);
    entities.push(...customersNotes.map(note => ({ ...note, entityType: 'lead' })));
  }

  return entities;
}

// Получить связь контакта/компании со сделкой
async function getLinkedLead(entityType, entityId) {
  try {
    if (entityType === 'contact') {
      const res = await axios.get(
        `https://${AMO_DOMAIN}/api/v4/contacts/${entityId}`,
        {
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
          params: { with: 'links' }
        }
      );
      const links = res.data?._embedded?.links || [];
      const leadLink = links.find(l => l.to_entity_type === 'leads');
      return leadLink ? leadLink.to_entity_id : null;
    }

    if (entityType === 'company') {
      const res = await axios.get(
        `https://${AMO_DOMAIN}/api/v4/companies/${entityId}`,
        {
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
          params: { with: 'links' }
        }
      );
      const links = res.data?._embedded?.links || [];
      const leadLink = links.find(l => l.to_entity_type === 'leads');
      return leadLink ? leadLink.to_entity_id : null;
    }
  } catch (e) {
    console.error(`Error getting linked lead for ${entityType} #${entityId}:`, e.message);
  }

  return null;
}

async function getAllCallOutNotes(entityType, entityId) {
  const allNotes = [];
  let page = 1;
  let hasMore = true;

  const endpoint = entityType === 'lead' ? 'leads'
    : entityType === 'contact' ? 'contacts'
    : entityType === 'company' ? 'companies'
    : 'leads';

  while (hasMore) {
    const notesRes = await axios.get(
      `https://${AMO_DOMAIN}/api/v4/${endpoint}/${entityId}/notes`,
      {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        params: {
          limit: 250,
          page,
          "filter[note_type]": "call_out"
        }
      }
    );

    const notes = notesRes.data?._embedded?.notes || [];
    console.log(`  Page ${page}: got ${notes.length} call_out notes`);

    allNotes.push(...notes);

    const lastHref = notesRes.data?._links?.pages?.last?.href;
    if (lastHref) {
      try {
        const lastPage = parseInt(
          new URL(lastHref).searchParams.get("page") || "1",
          10
        );
        hasMore = page < lastPage;
      } catch (e) {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }

    page++;
  }

  return allNotes;
}

app.post("/webhook/amo", async (req, res) => {
  console.log("=== WEBHOOK RECEIVED ===");
  console.log("Headers:", JSON.stringify(req.headers));
  console.log("Raw body type:", typeof req.body);

  try {
    const body = parseBody(req);
    console.log("Parsed body:", JSON.stringify(body, null, 2));

    let entitiesToProcess = [];

    // Проверяем, это webhook о примечаниях или о сделках
    if (body?.leads?.notes || body?.contacts?.notes || body?.companies?.notes || body?.customers?.notes) {
      // Вебхук о примечаниях
      entitiesToProcess = extractEntitiesFromNotes(body);
      console.log(`Extracted ${entitiesToProcess.length} note entities`);
    } else {
      // Вебхук о сделках
      const leads = extractLeads(body);
      console.log(`Extracted ${leads.length} leads`);
      entitiesToProcess = leads;
    }

    if (!entitiesToProcess.length) {
      console.log("No entities found in webhook, returning 200");
      return res.sendStatus(200);
    }

    for (const entity of entitiesToProcess) {
      let leadId = null;
      let entityType = entity.entityType || 'lead';
      const entityId = Number(entity.id || entity.entity_id);

      console.log(`\n--- Processing ${entityType} #${entityId} ---`);

      // Определяем, к какой сделке относится сущность
      if (entityType === 'lead') {
        leadId = entityId;
      } else if (entityType === 'contact' || entityType === 'company') {
        leadId = await getLinkedLead(entityType, entityId);
        if (!leadId) {
          console.log(`No linked lead found for ${entityType} #${entityId}, skipping`);
          continue;
        }
        console.log(`Linked to lead #${leadId}`);
      }

      if (!leadId || isNaN(leadId)) {
        console.log("No valid lead ID, skipping");
        continue;
      }

      if (processedLeads.has(leadId)) {
        console.log(`Lead #${leadId} already processed, skipping`);
        continue;
      }

      // Получаем все исходящие звонки из сделки
      let allNotes = [];
      try {
        allNotes = await getAllCallOutNotes('lead', leadId);
      } catch (notesErr) {
        console.error(
          `Error fetching notes for lead #${leadId}:`,
          notesErr.response?.data || notesErr.message
        );
        continue;
      }

      console.log(`Total call_out notes for lead #${leadId}: ${allNotes.length}`);

      let shortCalls = 0;
      for (const note of allNotes) {
        const duration = Number(
          note.params?.duration || note.params?.call_duration || 0
        );
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
          console.error(
            `PATCH error for lead #${leadId}:`,
            patchErr.response?.data || patchErr.message
          );
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
  console.log("Using AMO_DOMAIN:", AMO_DOMAIN);
  console.log("ACCESS_TOKEN is set:", !!ACCESS_TOKEN);
});
