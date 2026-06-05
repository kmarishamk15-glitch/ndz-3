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

const TYPE_TECHNICAL_ENUM_ID = 978137; // Нецелевой/техника
const TYPE_SERVICE_ENUM_ID = 938315;   // Нецелевой/услуги

const NDZ_GT_3_ENUM_ID = 976779;

const SERVICE_MANAGERS = [
  9437934, // Максим Лосев
  8323069  // Никита Золотов
];

const processedLeads = new Set();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseBody(req) {
  console.log(`  [parseBody] type: ${typeof req.body}, isBuffer: ${Buffer.isBuffer(req.body)}`);
  
  if (typeof req.body === "object" && req.body !== null && !Buffer.isBuffer(req.body)) {
    console.log(`  [parseBody] keys: ${Object.keys(req.body).length}`);
    if (Object.keys(req.body).length > 0) {
      console.log(`  [parseBody] returning parsed object`);
      return req.body;
    }
  }

  const raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : "";
  console.log(`  [parseBody] raw length: ${raw.length}`);
  
  if (raw && raw.trim().startsWith("{")) {
    try { 
      const parsed = JSON.parse(raw);
      console.log(`  [parseBody] parsed from raw JSON`);
      return parsed;
    } catch (e) { 
      console.error("JSON parse error:", e.message); 
    }
  }

  if (typeof req.body === "object") {
    if (typeof req.body.data === "string") {
      try { 
        const parsed = JSON.parse(req.body.data);
        console.log(`  [parseBody] parsed from data field`);
        return parsed;
      } catch (e) { 
        console.error("JSON parse from data error:", e.message); 
      }
    }
    if (Object.keys(req.body).length > 0) {
      console.log(`  [parseBody] returning body object`);
      return req.body;
    }
  }

  console.log(`  [parseBody] returning null`);
  return null;
}

function extractLeads(body) {
  if (!body) return [];
  const leadsArr = body?.leads?.status || body?.leads?.update || body?.leads?.add;
  if (Array.isArray(leadsArr) && leadsArr.length > 0) return leadsArr.map(lead => ({ ...lead, entityType: 'lead' }));
  if (typeof leadsArr === "object" && leadsArr !== null) return Object.values(leadsArr).map(lead => ({ ...lead, entityType: 'lead' }));
  return [];
}

function extractEntitiesFromNotes(body) {
  const entities = [];

  // webhook amoCRM: leads.note
  if (body?.leads?.note) {
    const notes = Array.isArray(body.leads.note)
      ? body.leads.note
      : Object.values(body.leads.note);

    console.log(`Found ${notes.length} lead notes`);

    entities.push(
      ...notes.map(item => ({
        id: Number(item.note.element_id),
        entityType: "lead"
      }))
    );
  }

  // старые варианты
  if (body?.leads?.notes) {
    const notes = Array.isArray(body.leads.notes)
      ? body.leads.notes
      : Object.values(body.leads.notes);

    entities.push(
      ...notes.map(note => ({
        ...note,
        entityType: "lead"
      }))
    );
  }

  if (body?.contacts?.notes) {
    const notes = Array.isArray(body.contacts.notes)
      ? body.contacts.notes
      : Object.values(body.contacts.notes);

    entities.push(
      ...notes.map(note => ({
        ...note,
        entityType: "contact"
      }))
    );
  }

  if (body?.companies?.notes) {
    const notes = Array.isArray(body.companies.notes)
      ? body.companies.notes
      : Object.values(body.companies.notes);

    entities.push(
      ...notes.map(note => ({
        ...note,
        entityType: "company"
      }))
    );
  }

  return entities;
}

async function getLinkedLead(entityType, entityId) {
  try {
    const endpoint = entityType === 'contact' ? 'contacts' : 'companies';
    const res = await axios.get(`https://${AMO_DOMAIN}/api/v4/${endpoint}/${entityId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      params: { with: 'links' }
    });
    const links = res.data?._embedded?.links || [];
    const leadLink = links.find(l => l.to_entity_type === 'leads');
    return leadLink ? leadLink.to_entity_id : null;
  } catch (e) {
    console.error(`Error getting linked lead:`, e.message);
  }
  return null;
}

async function getAllCallOutNotes(entityType, entityId) {
  const allNotes = [];
  let page = 1;
  let hasMore = true;

  const endpoint = entityType === 'lead' ? 'leads' : entityType === 'contact' ? 'contacts' : 'companies';

  while (hasMore) {
    const notesRes = await axios.get(`https://${AMO_DOMAIN}/api/v4/${endpoint}/${entityId}/notes`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      params: { limit: 250, page }
    });

    const notes = notesRes.data?._embedded?.notes || [];
    const callNotes = notes.filter(n => n.note_type === 'call_out');
    allNotes.push(...callNotes);

    const lastHref = notesRes.data?._links?.pages?.last?.href;
    if (lastHref) {
      try {
        const lastPage = parseInt(new URL(lastHref).searchParams.get("page") || "1", 10);
        hasMore = page < lastPage;
      } catch (e) { hasMore = false; }
    } else {
      hasMore = false;
    }
    page++;
  }

  return allNotes;
}

app.post("/webhook/amo", async (req, res) => {
  console.log("=== WEBHOOK RECEIVED ===");
  console.log(`  Content-Type: ${req.headers['content-type']}`);
  console.log(`  Body length: ${req.headers['content-length']}`);

  try {
    const body = parseBody(req);
    console.log("========== BODY ==========");
    console.log(JSON.stringify(body, null, 2));
    console.log("==========================");
    console.log(`  [main] body is null: ${body === null}`);
    
    if (body === null) {
      console.log(`  [main] body is null, returning 200`);
      return res.sendStatus(200);
    }

    let entitiesToProcess = [];

    const hasNotes =
      body?.leads?.note ||
      body?.leads?.notes ||
      body?.contacts?.notes ||
      body?.companies?.notes ||
      body?.customers?.notes;
    console.log(`  [main] hasNotes: ${!!hasNotes}`);

    if (hasNotes) {
      entitiesToProcess = extractEntitiesFromNotes(body);
      console.log(`  [main] extracted ${entitiesToProcess.length} note entities`);
    } else {
      const leads = extractLeads(body);
      console.log(`  [main] extracted ${leads.length} leads`);
      entitiesToProcess = leads;
    }

    if (!entitiesToProcess.length) {
      console.log(`  [main] no entities, returning 200`);
      return res.sendStatus(200);
    }

    for (const entity of entitiesToProcess) {
      let leadId = null;
      const entityType = entity.entityType || 'lead';
      const entityId = Number(entity.id || entity.entity_id);

      console.log(`Lead ID from webhook: ${entityId}`);

      if (entityType === 'lead') {
        leadId = entityId;
      } else if (entityType === 'contact' || entityType === 'company') {
        leadId = await getLinkedLead(entityType, entityId);
        if (!leadId) {
          console.log(`No linked lead found, skipping`);
          continue;
        }
      }

      if (!leadId || isNaN(leadId)) continue;
      if (processedLeads.has(leadId)) {
        console.log(`Lead #${leadId} already processed, skipping`);
        continue;
      }

      console.log('Waiting 3 seconds for note to be saved...');
      await sleep(3000);

      let allNotes = [];
      try {
        allNotes = await getAllCallOutNotes('lead', leadId);
      } catch (notesErr) {
        console.error(`Error fetching notes:`, notesErr.response?.data || notesErr.message);
        continue;
      }

      console.log(`Total OUTGOING call notes for lead #${leadId}: ${allNotes.length}`);

      let shortCalls = 0;
      let hasLongCall = false;
      
      console.log("");
      console.log(`========== LEAD ${leadId} ==========`);
      
      for (const note of allNotes) {
        const duration = Number(
          note.params?.duration ||
          note.params?.call_duration ||
          0
        );
      
        const callDate = note.created_at
          ? new Date(note.created_at * 1000).toISOString()
          : "unknown";
      
        console.log(
          `Call #${note.id} | Duration: ${duration}s | Date: ${callDate}`
        );
      
        if (duration <= 30) {
          shortCalls++;
          console.log("  -> SHORT CALL");
        } else {
          hasLongCall = true;
          console.log("  -> LONG CALL (>30s)");
        }
      }
      
      console.log("--------------------------------");
      console.log(`Lead ID: ${leadId}`);
      console.log(`Total outgoing calls: ${allNotes.length}`);
      console.log(`Short calls (<=30s): ${shortCalls}`);
      console.log(`Has long call (>30s): ${hasLongCall}`);
      console.log("--------------------------------");
      
      if (hasLongCall) {
        console.log(
          `SKIP LEAD ${leadId}: found at least one outgoing call longer than 30 seconds`
        );
        continue;
      }
    
    if (shortCalls < 3) {
      console.log(
        `SKIP LEAD ${leadId}: only ${shortCalls} short calls found`
      );
      continue;
    }
    
    console.log(
      `UPDATE LEAD ${leadId}: setting NDZ > 3`
    );
      const leadRes = await axios.get(
        `https://${AMO_DOMAIN}/api/v4/leads/${leadId}`,
        {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`
          }
        }
      );
      
      const responsibleUserId = leadRes.data.responsible_user_id;
      
      console.log(
        `Lead ${leadId} responsible_user_id: ${responsibleUserId}`
      );
      
      let typeRequestEnumId = TYPE_TECHNICAL_ENUM_ID;
      
      if (SERVICE_MANAGERS.includes(responsibleUserId)) {
        typeRequestEnumId = TYPE_SERVICE_ENUM_ID;
      
        console.log(
          `Lead ${leadId}: SERVICE manager`
        );
      } else {
        console.log(
          `Lead ${leadId}: TECHNICAL manager`
        );
      }

      if (shortCalls >= 3) {
        console.log(`>>> Setting fields for lead #${leadId}`);
        try {
          const patchRes = await axios.patch(`https://${AMO_DOMAIN}/api/v4/leads/${leadId}`, {
            custom_fields_values: [
              {
                field_id: TYPE_REQUEST_FIELD_ID,
                values: [
                  {
                    enum_id: typeRequestEnumId
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
          }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
          
          console.log(`PATCH success: ${patchRes.status}`);
          processedLeads.add(leadId);
        } catch (patchErr) {
          console.error(`PATCH error:`, patchErr.response?.data || patchErr.message);
        }
      } else {
        console.log(`Not enough short outgoing calls, skipping`);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK ERROR:", e.response?.data || e.message);
    return res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.send("amoCRM NDZ automation running"));

app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
