export async function POST(req) {
  const formData = await req.formData();
  const allData = {};
  for (const [k, v] of formData.entries()) {
    allData[k] = typeof v === 'string' ? v : await v.text?.() ?? v;
  }

  // Step 1: parse rawRequest JSON
  let raw = {};
  try {
    raw = JSON.parse(allData.rawRequest || '{}');
  } catch {
    raw = {};
  }

  const formId = raw.formID || allData.formID; // fallback to top-level
  const answers = raw;

  // Step 2: fetch form questions dynamically
  const jotformApiKey = process.env.JOTFORM_API_KEY;
  let questionMap = {};
  if (formId && jotformApiKey) {
    const res = await fetch(
      `https://api.jotform.com/form/${formId}/questions?apiKey=${jotformApiKey}`
    );
    if (res.ok) {
      const { content } = await res.json();
      // content is an object keyed by question ID
      for (const [qid, qdata] of Object.entries(content)) {
        // qdata.text holds the label
        questionMap[`q${qdata.order}_${qdata.name}`] = qdata.text;
        // also map "q<id>" alone if needed
        questionMap[`q${qdata.qid}`] = qdata.text;
      }
    }
  }

  // Step 3: Build question-answer array dynamically
  const qAndA = [];
  for (const [key, val] of Object.entries(answers)) {
    if (!key.startsWith('q')) continue; // only question fields
    const label = questionMap[key] || key;
    let value;
    if (typeof val === 'object' && val.first && val.last) {
      value = `${val.first} ${val.last}`;
    } else {
      value = String(val);
    }
    qAndA.push({ key: label, value });
  }

  // Step 4: Append any URLs found (reuse your URL extraction logic)
  const urls = extractUrlsFromPayload(raw);
  urls.forEach((u, idx) => {
    qAndA.push({ key: `Attachment ${idx + 1}`, value: u });
  });

  // Step 5: Build Slack message
  const formTitle = allData.formTitle || allData.FormTitle || 'Form Submission';
  const textLines = [`*${formTitle}*`, ...qAndA.map(p => `• *${p.key}*: ${p.value}`)];

  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: textLines.join('\n') }),
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// helper for URL extraction (same logic you already had)
function extractUrlsFromPayload(obj) {
  const urls = new Set();
  const traverse = val => {
    if (val == null) return;
    if (typeof val === 'string') {
      const matches = val.match(/https?:\\?\/\\?\/[^\s"']+/g);
      if (matches) {
        for (let m of matches) {
          // unescape Jotform slashes
          m = m.replace(/\\\//g, '/');
          // rewrite upload URL if needed
          if (m.includes('jotform.com/uploads/')) {
            const parts = m.split('/uploads/');
            m = `https://files.jotform.com/jufs/${parts[1]}`;
          }
          urls.add(m);
        }
      }
    } else if (typeof val === 'object') {
      Object.values(val).forEach(traverse);
    } else if (Array.isArray(val)) {
      val.forEach(traverse);
    }
  };
  traverse(obj);
  return Array.from(urls);
}
